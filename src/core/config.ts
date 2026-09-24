/**
 * Configuration: one immutable object assembled from the environment.
 *
 * Nothing in this codebase reads `process.env` outside of `loadConfig`, so tests
 * never have to mutate global state to change behavior.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug']

export interface CsdnConfig {
  /** bizapi gateway app key (public constant, overridable for testing). */
  appKey: string
  /** bizapi gateway app secret. */
  appSecret: string
  /** Origin used for every signed `bizapi` call. */
  apiBase: string
  /** Origin of the public blog pages, used for post-write verification. */
  blogBase: string
  /** Origin of the public community API (no cookie required). */
  communityBase: string
  /** Full `Cookie` header value. Empty string when unauthenticated. */
  cookie: string
  /** Account name, read from the cookie or the `CSDN_USERNAME` env var. */
  userName: string
  userAgent: string
  /** Per-attempt request timeout. */
  timeoutMs: number
  /** Extra attempts after the first one for retryable failures. */
  maxRetries: number
  /** Minimum spacing between two ordinary signed requests. */
  minRequestIntervalMs: number
  /**
   * Minimum spacing between two writes (`saveArticle` / `del`). CSDN throttles
   * saves that land closer together than ~10s with "文章频繁发布，请稍后再试".
   */
  saveIntervalMs: number
  logLevel: LogLevel
}

export const DEFAULT_APP_KEY = '203803574'
export const DEFAULT_APP_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba'

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const DEFAULT_CONFIG: Readonly<CsdnConfig> = Object.freeze({
  appKey: DEFAULT_APP_KEY,
  appSecret: DEFAULT_APP_SECRET,
  apiBase: 'https://bizapi.csdn.net',
  blogBase: 'https://blog.csdn.net',
  communityBase: 'https://blog.csdn.net',
  cookie: '',
  userName: '',
  userAgent: DEFAULT_USER_AGENT,
  timeoutMs: 20_000,
  maxRetries: 2,
  minRequestIntervalMs: 250,
  saveIntervalMs: 11_000,
  logLevel: 'warn'
})

/** Parse a `Cookie` header into a map. Tolerates whitespace and empty segments. */
export function parseCookie(cookie: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of cookie.split(';')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

/** Read one cookie value. Returns `undefined` when absent — never throws. */
export function getCookieValue(cookie: string, name: string): string | undefined {
  return parseCookie(cookie)[name]
}

export interface CookieValidation {
  valid: boolean
  userName: string
  /** Human-readable explanation when `valid` is false. */
  reason?: string
}

/**
 * Structural validation of a cookie string, done without any network call.
 *
 * `UserToken` is HTTP-only, so a cookie copied from `document.cookie` never
 * satisfies this. That mistake is common enough that the tool layer reports it
 * as its own case instead of a generic "invalid cookie".
 */
export function validateCookie(cookie: string): CookieValidation {
  if (cookie.trim() === '') {
    return { valid: false, userName: '', reason: '未配置 Cookie（环境变量 CSDN_COOKIE 为空）' }
  }
  const userName = getCookieValue(cookie, 'UserName') ?? ''
  if (!cookie.includes('UserToken=')) {
    return {
      valid: false,
      userName,
      reason:
        'Cookie 缺少 UserToken。UserToken 是 HTTP-only cookie，document.cookie 取不到；' +
        '请从 F12 → Network → 任意 csdn.net 请求 → Request Headers → Cookie 里整段复制。'
    }
  }
  if (userName === '') {
    return { valid: false, userName, reason: 'Cookie 中未找到 UserName，可能复制不完整' }
  }
  return { valid: true, userName }
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function envLogLevel(env: NodeJS.ProcessEnv, fallback: LogLevel): LogLevel {
  const raw = (env['CSDN_LOG_LEVEL'] ?? '').trim().toLowerCase()
  return (LOG_LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : fallback
}

function envString(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key]
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim()
}

/** Merge `overrides` over `DEFAULT_CONFIG` over nothing else. */
export function buildConfig(overrides: Partial<CsdnConfig> = {}): CsdnConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}

/**
 * Build the runtime configuration from `env` (defaults to `process.env`).
 * Pure with respect to its argument, which is what makes it unit-testable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CsdnConfig {
  const cookie = env['CSDN_COOKIE']?.trim() ?? ''
  return {
    appKey: envString(env, 'CSDN_APP_KEY', DEFAULT_APP_KEY),
    appSecret: envString(env, 'CSDN_APP_SECRET', DEFAULT_APP_SECRET),
    apiBase: envString(env, 'CSDN_API_BASE', DEFAULT_CONFIG.apiBase).replace(/\/+$/, ''),
    blogBase: envString(env, 'CSDN_BLOG_BASE', DEFAULT_CONFIG.blogBase).replace(/\/+$/, ''),
    communityBase: envString(env, 'CSDN_COMMUNITY_BASE', DEFAULT_CONFIG.communityBase).replace(/\/+$/, ''),
    cookie,
    userName: getCookieValue(cookie, 'UserName') ?? envString(env, 'CSDN_USERNAME', ''),
    userAgent: envString(env, 'CSDN_USER_AGENT', DEFAULT_USER_AGENT),
    timeoutMs: envInt(env, 'CSDN_TIMEOUT_MS', DEFAULT_CONFIG.timeoutMs),
    maxRetries: envInt(env, 'CSDN_MAX_RETRIES', DEFAULT_CONFIG.maxRetries),
    minRequestIntervalMs: envInt(env, 'CSDN_MIN_INTERVAL_MS', DEFAULT_CONFIG.minRequestIntervalMs),
    saveIntervalMs: envInt(env, 'CSDN_SAVE_INTERVAL_MS', DEFAULT_CONFIG.saveIntervalMs),
    logLevel: envLogLevel(env, DEFAULT_CONFIG.logLevel)
  }
}
