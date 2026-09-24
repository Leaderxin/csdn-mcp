/**
 * Error taxonomy.
 *
 * Every failure mode this server can hit is a named code so that callers (an AI
 * agent, a test, a human reading logs) can branch on it instead of string
 * matching. `retryable` is set on the *error type*, not decided ad hoc at each
 * call site — retry policy is a property of the failure, not of the caller.
 */

export type CsdnErrorCode =
  /** No cookie configured at all. */
  | 'AUTH_MISSING'
  /** Cookie present but missing UserToken, or rejected by CSDN (401 / login redirect). */
  | 'AUTH_INVALID'
  /** Transport-level failure: DNS, TCP, TLS, aborted request. */
  | 'NETWORK'
  /** Request exceeded the configured timeout. */
  | 'TIMEOUT'
  /** Non-2xx HTTP status that is not an auth or rate-limit failure. */
  | 'HTTP_ERROR'
  /** 2xx but the body was not the JSON envelope we expect. */
  | 'MALFORMED_RESPONSE'
  /** JSON envelope with `code !== 200`. */
  | 'API_ERROR'
  /** CSDN throttled us ("文章频繁发布，请稍后再试" / HTTP 429). */
  | 'RATE_LIMITED'
  /** Server-side 5xx. */
  | 'SERVER_ERROR'
  /** The requested article / resource does not exist. */
  | 'NOT_FOUND'
  /** Caller-supplied arguments violate a CSDN constraint (tag count,摘要长度…). */
  | 'INVALID_ARGUMENT'
  /** A post-write verification step disagreed with the write's own success claim. */
  | 'VERIFY_FAILED'

/** Subset of codes that are worth retrying without changing the request. */
const RETRYABLE: ReadonlySet<CsdnErrorCode> = new Set<CsdnErrorCode>([
  'NETWORK',
  'TIMEOUT',
  'RATE_LIMITED',
  'SERVER_ERROR'
])

export interface CsdnErrorOptions {
  /** HTTP status, when the failure came from a response. */
  status?: number
  /** Server-supplied message / body snippet, already truncated. */
  detail?: string
  /** The error that caused this one, if any. */
  cause?: unknown
}

export class CsdnError extends Error {
  readonly code: CsdnErrorCode
  readonly status: number | undefined
  readonly detail: string | undefined
  readonly retryable: boolean

  constructor(code: CsdnErrorCode, message: string, options: CsdnErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CsdnError'
    this.code = code
    this.status = options.status
    this.detail = options.detail
    this.retryable = RETRYABLE.has(code)
  }

  /** Stable, log-friendly one-liner. Never contains the cookie. */
  toJSON(): { code: CsdnErrorCode; message: string; status?: number; detail?: string; retryable: boolean } {
    return {
      code: this.code,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      retryable: this.retryable
    }
  }
}

/** Narrowing helper for `catch (e)` blocks. */
export function isCsdnError(value: unknown): value is CsdnError {
  return value instanceof CsdnError
}

/**
 * Convert anything thrown into a CsdnError without losing the original message.
 * Unknown throwables become NETWORK errors, since in this codebase the only
 * code that throws raw values is the transport layer.
 */
export function toCsdnError(value: unknown): CsdnError {
  if (isCsdnError(value)) return value
  if (value instanceof Error) {
    const name = value.name
    if (name === 'AbortError' || name === 'TimeoutError') {
      return new CsdnError('TIMEOUT', value.message, { cause: value })
    }
    return new CsdnError('NETWORK', value.message, { cause: value })
  }
  return new CsdnError('NETWORK', String(value))
}
