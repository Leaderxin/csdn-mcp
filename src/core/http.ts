/**
 * The single HTTP entry point for every CSDN call.
 *
 * Responsibilities, all of which exist because they were needed at least once in
 * production:
 *   - HMAC signing of bizapi requests (see `signer.ts`)
 *   - timeouts, so a hung socket cannot wedge an agent session
 *   - retry with backoff for the failures that are actually transient
 *   - client-side throttling, so we do not trip CSDN's save-rate limiter
 *   - one error taxonomy (`CsdnError`) instead of "code: -1 and a string"
 *
 * The client is fully injectable: `fetchImpl`, `sleep` and `now` are seams that
 * make every branch above unit-testable without a network.
 */

import type { CsdnConfig } from './config.js'
import { CsdnError, toCsdnError } from './errors.js'
import { buildSignHeaders } from './signer.js'
import { RateLimiter, defaultSleep, type Now, type Sleep } from './ratelimit.js'
import { createLogger, type Logger } from './logger.js'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface HttpResponse {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
  /** Final URL after redirects, when the runtime exposes it. */
  url?: string
}

export type FetchLike = (url: string, init: RequestInit) => Promise<HttpResponse>

/** The shape of nearly every bizapi response body. */
export interface CsdnEnvelope<T = unknown> {
  code?: number
  msg?: string
  message?: string
  data?: T
}

export type QueryValue = string | number | boolean | undefined | null
export type QueryParams = Record<string, QueryValue>

export interface RequestOptions {
  path: string
  method?: HttpMethod
  query?: QueryParams
  body?: unknown
  /**
   * Overrides the `Content-Type` header *and* the value folded into the
   * signature. Pass `''` for bodyless requests. Defaults to
   * `application/json; charset=UTF-8` when a body is present, `''` otherwise.
   */
  contentType?: string
  accept?: string
  /** Sign with the `X-Ca-*` headers. Default `true`. */
  signed?: boolean
  /** Throw `AUTH_MISSING` when no cookie is configured. Default `true` for signed requests. */
  requireAuth?: boolean
  /** Extra attempts after the first. Defaults to `config.maxRetries`. */
  retries?: number
  /**
   * Whether repeating this request is safe when the outcome is unknown.
   * Defaults to `true` for GET and `false` for everything else.
   *
   * This exists because a retry can duplicate a write. `saveArticle` has no
   * idempotency key: if the first POST reached CSDN and only the *response* was
   * lost (a 502, or the client timing out), re-sending it creates a second
   * article. A non-idempotent request is therefore retried only on
   * `RATE_LIMITED` — the one failure where CSDN answered and explicitly refused,
   * so the write provably did not happen.
   */
  idempotent?: boolean
  timeoutMs?: number
  /** Minimum spacing between two calls sharing `rateLimitKey`. */
  minIntervalMs?: number
  /** Defaults to the request path, so saves throttle independently of reads. */
  rateLimitKey?: string
  /** Sent as multipart instead of JSON. Implies `signed: false`. */
  formData?: FormData
}

export interface FetchTextOptions {
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface TextResponse {
  status: number
  text: string
  finalUrl: string
}

export interface HttpClientOptions {
  config: CsdnConfig
  logger?: Logger
  fetchImpl?: FetchLike
  sleep?: Sleep
  now?: Now
  rateLimiter?: RateLimiter
}

/** Serialize query params, dropping empty values, and return `''` when none remain. */
export function buildQuery(params: QueryParams | undefined): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.append(key, String(value))
  }
  const query = search.toString()
  return query
}

const RATE_LIMIT_HINTS = ['频繁', '稍后', 'too many', 'rate limit', '请慢一点']

function looksRateLimited(message: string): boolean {
  const lowered = message.toLowerCase()
  return RATE_LIMIT_HINTS.some(hint => lowered.includes(hint.toLowerCase()))
}

/** Truncate a body snippet so a huge HTML error page cannot flood a log line. */
function snippet(text: string, limit = 300): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`
}

/** Exponential backoff: 500ms, 1s, 2s, 4s… capped at 8s. */
export function backoffDelay(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000)
}

export class CsdnHttpClient {
  readonly config: CsdnConfig
  readonly logger: Logger
  private readonly fetchImpl: FetchLike
  private readonly sleep: Sleep
  private readonly now: Now
  private readonly rateLimiter: RateLimiter

  constructor(options: HttpClientOptions) {
    this.config = options.config
    this.logger = options.logger ?? createLogger({ level: options.config.logLevel })
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? Date.now
    this.rateLimiter = options.rateLimiter ?? new RateLimiter({ sleep: this.sleep, now: this.now })
  }

  /** Absolute URL for a bizapi path (or pass through an absolute URL). */
  url(path: string, query?: QueryParams): string {
    const search = buildQuery(query)
    const base = /^https?:\/\//i.test(path) ? path : `${this.config.apiBase}${path}`
    return `${base}${search === '' ? '' : `?${search}`}`
  }

  /**
   * Perform a request and return the parsed JSON body.
   *
   * Throws `CsdnError` for every failure mode; never returns a partial value.
   */
  async request<T = CsdnEnvelope>(options: RequestOptions): Promise<T> {
    const method: HttpMethod = options.method ?? 'POST'
    // A multipart body is what marks a request as going to the object store
    // rather than to CSDN, so it must never carry the cookie or a signature:
    // `postToStore` is a third-party host. Documented here because the default
    // used to say "implied" while the code said `?? true`.
    const signed = options.signed ?? options.formData === undefined
    const idempotent = options.idempotent ?? method === 'GET'
    const hasBody = options.body !== undefined && options.formData === undefined
    const contentType =
      options.contentType !== undefined
        ? options.contentType
        : hasBody
          ? 'application/json; charset=UTF-8'
          : ''
    const accept = options.accept ?? '*/*'
    const requireAuth = options.requireAuth ?? signed

    if (requireAuth && this.config.cookie.trim() === '') {
      throw new CsdnError('AUTH_MISSING', '未配置 CSDN Cookie，无法调用需要登录的接口')
    }

    const query = buildQuery(options.query)
    const absolute = /^https?:\/\//i.test(options.path)
    const url = this.url(options.path, options.query)

    const headers: Record<string, string> = {
      Accept: accept,
      'User-Agent': this.config.userAgent,
      Referer: 'https://editor.csdn.net/md/',
      Origin: 'https://editor.csdn.net'
    }
    if (contentType !== '') headers['Content-Type'] = contentType
    if (signed) {
      // For absolute URLs only the path component is signed, exactly as a
      // relative path would be.
      const signPath = absolute ? new URL(url).pathname : options.path
      const signQuery = absolute ? new URL(url).search.replace(/^\?/, '') : query
      // `nonce` and `uri` are helper fields of the signer's return value, not
      // wire headers; spreading the whole object onto the request used to send
      // them to CSDN on every signed call.
      const {
        nonce: _nonce,
        uri: _uri,
        ...signHeaders
      } = buildSignHeaders({
        method,
        path: signPath,
        query: signQuery,
        accept,
        contentType,
        appKey: this.config.appKey,
        appSecret: this.config.appSecret
      })
      Object.assign(headers, signHeaders)
    }
    if (requireAuth) headers['Cookie'] = this.config.cookie

    const attempts = 1 + Math.max(0, options.retries ?? this.config.maxRetries)
    let lastError: CsdnError | undefined

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        const delay =
          lastError?.code === 'RATE_LIMITED' ? this.config.saveIntervalMs : backoffDelay(attempt - 1)
        this.logger.debug('retrying request', { path: options.path, attempt, delay })
        await this.sleep(delay)
      }

      // Every attempt passes through the limiter, not just the first. Acquiring
      // once outside the loop spaced only the first try, so two 500s turned one
      // save into three POSTs inside the interval CSDN asked for.
      await this.rateLimiter.acquire(
        options.rateLimitKey ?? `${method} ${options.path}`,
        options.minIntervalMs ?? this.config.minRequestIntervalMs
      )

      try {
        return await this.attempt<T>(url, method, headers, options)
      } catch (error) {
        const csdnError = toCsdnError(error)
        lastError = csdnError
        // A non-idempotent request may only be repeated when CSDN explicitly
        // refused it, because then nothing was written. See `idempotent`.
        const mayRetry = idempotent ? csdnError.retryable : csdnError.code === 'RATE_LIMITED'
        if (!mayRetry || attempt === attempts - 1) throw csdnError
      }
    }

    // Unreachable in practice: the loop either returns or throws.
    throw lastError ?? new CsdnError('NETWORK', '请求失败')
  }

  /** `request` + envelope unwrapping: returns `data`, throws on `code !== 200`. */
  async requestData<T>(options: RequestOptions): Promise<T> {
    const envelope = await this.request<CsdnEnvelope<T>>(options)
    return unwrapEnvelope<T>(envelope, options.path)
  }

  /**
   * Fetch a public (unsigned, cookie-less) URL as text — used to check whether a
   * post is really live, which is the only claim that cannot lie.
   *
   * Shaped so the `try` block completes by FALLING THROUGH into `finally`
   * rather than by returning from inside it. V8 only increments a `finally`
   * block's coverage counter on fall-through, so a `return` inside the `try`
   * leaves the branch permanently at 0% and makes the project's 100% branch
   * gate unpassable. Do not "simplify" this back into a return inside the try.
   */
  async fetchText(url: string, options: FetchTextOptions = {}): Promise<TextResponse> {
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let result: TextResponse
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': this.config.userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Referer: `${this.config.blogBase}/`,
          ...options.headers
        }
      })
      const text = await response.text()
      // `response.url` is the post-redirect URL; `url` is what we asked for.
      // CSDN redirects retired article URLs, and reporting the requested one as
      // "final" would hide that.
      result = { status: response.status, text, finalUrl: response.url ?? url }
    } catch (error) {
      throw toCsdnError(error)
    } finally {
      clearTimeout(timer)
    }
    return result
  }

  /** One send + parse cycle. Separated so `request` owns the retry policy. */
  private async attempt<T>(
    url: string,
    method: HttpMethod,
    headers: Record<string, string>,
    options: RequestOptions
  ): Promise<T> {
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: HttpResponse
    try {
      const init: RequestInit = { method, headers, signal: controller.signal, redirect: 'follow' }
      if (options.formData !== undefined) {
        init.body = options.formData
        // undici must set the multipart boundary itself, so drop our header.
        delete headers['Content-Type']
      } else if (options.body !== undefined) {
        init.body = JSON.stringify(options.body)
      }
      response = await this.fetchImpl(url, init)
    } catch (error) {
      throw toCsdnError(error)
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text().catch((error: unknown) => {
      throw toCsdnError(error)
    })

    if (response.status === 401 || response.status === 403) {
      throw new CsdnError('AUTH_INVALID', `CSDN 拒绝请求（HTTP ${response.status}），Cookie 可能已过期`, {
        status: response.status,
        detail: snippet(text)
      })
    }
    if (response.status === 429) {
      throw new CsdnError('RATE_LIMITED', 'CSDN 限流（HTTP 429）', { status: 429, detail: snippet(text) })
    }
    if (response.status >= 500) {
      throw new CsdnError('SERVER_ERROR', `CSDN 服务端错误（HTTP ${response.status}）`, {
        status: response.status,
        detail: snippet(text)
      })
    }
    if (response.status < 200 || response.status >= 300) {
      throw new CsdnError('HTTP_ERROR', `请求失败（HTTP ${response.status}）`, {
        status: response.status,
        detail: snippet(text)
      })
    }

    const parsed = parseJsonBody<T>(text)
    return parsed
  }
}

/**
 * Parse a response body as JSON.
 *
 * A non-JSON 2xx almost always means the endpoint moved: bizapi answers an
 * unregistered path with the `openresty` 404 page, which is how both
 * `list-categories` and `list-tags` in v0 silently rotted. (Measured: that page
 * arrives with HTTP 404, not HTTP 200 — the giveaway is the body, so the body is
 * what this function checks rather than the status.)
 */
export function parseJsonBody<T>(text: string): T {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new CsdnError('MALFORMED_RESPONSE', '接口返回的不是 JSON，通常意味着该接口已下线或路径变更', {
      detail: snippet(trimmed)
    })
  }
  try {
    return JSON.parse(trimmed) as T
  } catch (error) {
    throw new CsdnError('MALFORMED_RESPONSE', '接口返回的 JSON 无法解析', {
      detail: snippet(trimmed),
      cause: error
    })
  }
}

/**
 * Unwrap a `{code, msg, data}` envelope.
 *
 * `code === 200` is the only success. Note that a rejected request can still
 * arrive with HTTP 200, which is why the envelope is checked separately from the
 * status code.
 */
export function unwrapEnvelope<T>(envelope: CsdnEnvelope<T>, context = ''): T {
  const where = context === '' ? '' : `（${context}）`
  const code = envelope.code
  if (code === undefined) {
    // No `code` at all. A few endpoints answer with a bare payload, so `data` is
    // accepted — but only when the body carries no counter-signal. CSDN's
    // phoenix errors report `status` rather than `code`, so `{status:500,...}`
    // and `{}` used to be read as success, which let a failed delete report
    // itself as done.
    const counterSignals = ['msg', 'message', 'status', 'error'] as const
    const hasCounterSignal = counterSignals.some(
      key => (envelope as Record<string, unknown>)[key] !== undefined
    )
    if (envelope.data !== undefined && envelope.data !== null && !hasCounterSignal) {
      return envelope.data
    }
    throw new CsdnError('MALFORMED_RESPONSE', `接口未返回 code，无法确认请求成功${where}`, {
      detail: JSON.stringify(envelope)
    })
  }
  if (code === 200) {
    if (envelope.data === undefined) {
      // Callers that expect data treat `undefined` as a protocol violation.
      return undefined as T
    }
    return envelope.data
  }
  const message = envelope.msg ?? envelope.message ?? `接口返回 code=${code}`
  if (code === 401 || code === 403 || code === 700) {
    throw new CsdnError('AUTH_INVALID', `${message}${where}`, { detail: message })
  }
  if (code === 404 || code === 4004) {
    throw new CsdnError('NOT_FOUND', `${message}${where}`, { detail: message })
  }
  if (looksRateLimited(message)) {
    throw new CsdnError('RATE_LIMITED', `${message}${where}`, { detail: message })
  }
  throw new CsdnError('API_ERROR', `${message}${where}`, { detail: message })
}
