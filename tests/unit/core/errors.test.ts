import { describe, expect, it } from 'vitest'
import { CsdnError, isCsdnError, toCsdnError, type CsdnErrorCode } from '../../../src/core/errors.js'

/** Every code in the taxonomy — the retryable set must be exhaustive, not sampled. */
const ALL_CODES: readonly CsdnErrorCode[] = [
  'AUTH_MISSING',
  'AUTH_INVALID',
  'NETWORK',
  'TIMEOUT',
  'HTTP_ERROR',
  'MALFORMED_RESPONSE',
  'API_ERROR',
  'RATE_LIMITED',
  'SERVER_ERROR',
  'NOT_FOUND',
  'INVALID_ARGUMENT',
  'VERIFY_FAILED'
]

const RETRYABLE_CODES: ReadonlySet<CsdnErrorCode> = new Set<CsdnErrorCode>([
  'NETWORK',
  'TIMEOUT',
  'RATE_LIMITED',
  'SERVER_ERROR'
])

describe('CsdnError', () => {
  it('marks exactly NETWORK, TIMEOUT, RATE_LIMITED and SERVER_ERROR retryable because everything else needs a human', () => {
    for (const code of ALL_CODES) {
      expect([code, new CsdnError(code, 'x').retryable]).toEqual([code, RETRYABLE_CODES.has(code)])
    }
  })

  it('reports the four transient codes as retryable (guards against an empty RETRYABLE set)', () => {
    expect(ALL_CODES.filter((code) => new CsdnError(code, 'x').retryable)).toEqual([
      'NETWORK',
      'TIMEOUT',
      'RATE_LIMITED',
      'SERVER_ERROR'
    ])
  })

  it('is an Error named CsdnError so `instanceof` and log output both identify it', () => {
    const error = new CsdnError('NETWORK', 'boom')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(CsdnError)
    expect(error.name).toBe('CsdnError')
    expect(error.code).toBe('NETWORK')
    expect(error.message).toBe('boom')
  })

  it('leaves status and detail undefined when the failure had neither', () => {
    const error = new CsdnError('NETWORK', 'boom')
    expect(error.status).toBeUndefined()
    expect(error.detail).toBeUndefined()
    expect(error.cause).toBeUndefined()
  })

  it('carries status, detail and cause through when a response produced them', () => {
    const cause = new Error('socket')
    const error = new CsdnError('SERVER_ERROR', 'boom', { status: 503, detail: 'upstream', cause })
    expect(error.status).toBe(503)
    expect(error.detail).toBe('upstream')
    expect(error.cause).toBe(cause)
  })

  describe('toJSON', () => {
    it('omits status and detail when absent so a log line stays short', () => {
      expect(new CsdnError('NETWORK', 'boom').toJSON()).toEqual({
        code: 'NETWORK',
        message: 'boom',
        retryable: true
      })
    })

    it('includes status and detail when present so a 500 can be diagnosed from the JSON alone', () => {
      expect(new CsdnError('SERVER_ERROR', 'boom', { status: 500, detail: 'oops' }).toJSON()).toEqual({
        code: 'SERVER_ERROR',
        message: 'boom',
        status: 500,
        detail: 'oops',
        retryable: true
      })
    })

    it('includes status alone when there is no detail', () => {
      expect(new CsdnError('HTTP_ERROR', 'boom', { status: 418 }).toJSON()).toEqual({
        code: 'HTTP_ERROR',
        message: 'boom',
        status: 418,
        retryable: false
      })
    })

    it('includes detail alone when the failure had no HTTP status', () => {
      expect(new CsdnError('API_ERROR', 'boom', { detail: 'code=4001' }).toJSON()).toEqual({
        code: 'API_ERROR',
        message: 'boom',
        detail: 'code=4001',
        retryable: false
      })
    })
  })
})

describe('isCsdnError', () => {
  it('narrows a CsdnError so catch blocks can read .code without a cast', () => {
    const value: unknown = new CsdnError('AUTH_INVALID', 'expired')
    let code = ''
    if (isCsdnError(value)) code = value.code
    expect(code).toBe('AUTH_INVALID')
  })

  it('rejects a plain Error and a string, which is the case a catch block actually sees', () => {
    expect(isCsdnError(new Error('boom'))).toBe(false)
    expect(isCsdnError('boom')).toBe(false)
    expect(isCsdnError(undefined)).toBe(false)
  })
})

describe('toCsdnError', () => {
  it('returns a CsdnError unchanged so code and detail are not re-wrapped', () => {
    const original = new CsdnError('NOT_FOUND', 'gone', { status: 404 })
    expect(toCsdnError(original)).toBe(original)
  })

  it('maps an AbortError to TIMEOUT because a client abort is our own timeout firing', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    const converted = toCsdnError(abort)
    expect(converted.code).toBe('TIMEOUT')
    expect(converted.message).toBe('The operation was aborted')
    expect(converted.cause).toBe(abort)
  })

  it('maps an undici TimeoutError to TIMEOUT as well', () => {
    const timeout = new Error('Headers timeout')
    timeout.name = 'TimeoutError'
    expect(toCsdnError(timeout).code).toBe('TIMEOUT')
  })

  it('maps any other Error to NETWORK, preserving the message an operator needs', () => {
    const converted = toCsdnError(new Error('getaddrinfo ENOTFOUND bizapi.csdn.net'))
    expect(converted.code).toBe('NETWORK')
    expect(converted.message).toBe('getaddrinfo ENOTFOUND bizapi.csdn.net')
  })

  it('maps a thrown string to NETWORK so a `throw "boom"` cannot escape the taxonomy', () => {
    const converted = toCsdnError('boom')
    expect(converted.code).toBe('NETWORK')
    expect(converted.message).toBe('boom')
    expect(converted).toBeInstanceOf(CsdnError)
  })

  it('maps a thrown plain object to NETWORK with a printable message', () => {
    const converted = toCsdnError({ code: 'ENOTFOUND' })
    expect(converted.code).toBe('NETWORK')
    expect(converted.message).toBe('[object Object]')
  })

  it('marks the converted transport failures retryable, which is what drives the retry loop', () => {
    expect(toCsdnError(new Error('boom')).retryable).toBe(true)
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(toCsdnError(abort).retryable).toBe(true)
  })
})
