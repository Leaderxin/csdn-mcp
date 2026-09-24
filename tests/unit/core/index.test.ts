/**
 * Barrel contract.
 *
 * `src/core/index.ts` is the only import path upper layers use, and `export *`
 * fails silently: a rename upstream would simply stop the name existing. These
 * tests pin every name and its kind so the barrel cannot lose (or gain) an
 * export without a test change.
 */

import { describe, expect, it } from 'vitest'
import * as core from '../../../src/core/index.js'

const FUNCTION_EXPORTS = [
  'parseCookie',
  'getCookieValue',
  'validateCookie',
  'buildConfig',
  'loadConfig',
  'redact',
  'createLogger',
  'defaultSleep',
  'buildStringToSign',
  'sign',
  'buildSignHeaders',
  'toCsdnError',
  'isCsdnError',
  'buildQuery',
  'backoffDelay',
  'parseJsonBody',
  'unwrapEnvelope'
] as const

const CLASS_EXPORTS = ['CsdnError', 'RateLimiter', 'CsdnHttpClient'] as const

const CONSTANT_EXPORTS: ReadonlyArray<readonly [string, unknown]> = [
  ['CSDN_APP_KEY', '203803574'],
  ['CSDN_APP_SECRET', '9znpamsyl2c7cdrr9sas0le9vbc3r6ba'],
  ['SIGNATURE_HEADERS', 'x-ca-key,x-ca-nonce'],
  ['DEFAULT_APP_KEY', '203803574'],
  ['DEFAULT_APP_SECRET', '9znpamsyl2c7cdrr9sas0le9vbc3r6ba'],
  ['DEFAULT_CONFIG', expect.objectContaining({ apiBase: 'https://bizapi.csdn.net' })],
  ['DEFAULT_USER_AGENT', expect.stringContaining('Mozilla/5.0')]
]

function read(name: string): unknown {
  return (core as unknown as Record<string, unknown>)[name]
}

describe('core barrel', () => {
  it('exposes every helper as a function', () => {
    for (const name of FUNCTION_EXPORTS) {
      expect([name, typeof read(name)]).toEqual([name, 'function'])
    }
  })

  it('exposes the error, limiter and client as classes so instanceof works across layers', () => {
    for (const name of CLASS_EXPORTS) {
      const value = read(name)
      expect([name, typeof value]).toEqual([name, 'function'])
      expect([name, (value as { name: string }).name]).toEqual([name, name])
    }
  })

  it('exposes CsdnError, so an upper layer can throw and catch the same class', () => {
    const error = new core.CsdnError('NETWORK', 'boom')
    expect(error).toBeInstanceOf(core.CsdnError)
    expect(core.isCsdnError(error)).toBe(true)
  })

  it('exposes RateLimiter and CsdnHttpClient as constructible classes', () => {
    const limiter = new core.RateLimiter({ sleep: async () => undefined, now: () => 0 })
    expect(typeof limiter.acquire).toBe('function')
    expect(typeof limiter.reset).toBe('function')

    const client = new core.CsdnHttpClient({
      config: core.DEFAULT_CONFIG,
      fetchImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => '{}' })
    })
    expect(typeof client.request).toBe('function')
  })

  it('exposes the public CSDN constants and the frozen default config', () => {
    for (const [name, expected] of CONSTANT_EXPORTS) {
      expect([name, read(name)]).toEqual([name, expected])
    }
    expect(Object.isFrozen(core.DEFAULT_CONFIG)).toBe(true)
  })

  it('re-exports every runtime name of all six core modules and nothing else', async () => {
    const modules = await Promise.all([
      import('../../../src/core/config.js'),
      import('../../../src/core/errors.js'),
      import('../../../src/core/logger.js'),
      import('../../../src/core/ratelimit.js'),
      import('../../../src/core/signer.js'),
      import('../../../src/core/http.js')
    ])
    const expected = new Set(modules.flatMap(module => Object.keys(module)))

    expect(Object.keys(core).sort()).toEqual([...expected].sort())
  })

  it('never exposes an undefined export, which would betray a broken re-export', () => {
    const undefinedNames = Object.keys(core).filter(name => read(name) === undefined)

    expect(undefinedNames).toEqual([])
  })
})
