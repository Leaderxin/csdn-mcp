import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_KEY,
  DEFAULT_APP_SECRET,
  DEFAULT_CONFIG,
  DEFAULT_USER_AGENT,
  buildConfig,
  getCookieValue,
  loadConfig,
  parseCookie,
  validateCookie
} from '../../../src/core/config.js'

const COOKIE = 'UserToken=abcdef123456; UserName=bob; uuid_tt_dd=10_1234567890-12345-98765; csrfToken=xyz'

describe('parseCookie', () => {
  it('splits a normal "a=b; c=d" header into one entry per pair', () => {
    expect(parseCookie('a=1; b=2')).toEqual({ a: '1', b: '2' })
  })

  it('tolerates whitespace around names and values because browsers pad pairs with "; "', () => {
    expect(parseCookie('  a = 1 ;\tb=2')).toEqual({ a: '1', b: '2' })
  })

  it('skips empty segments so a trailing "; " cannot produce a phantom key', () => {
    expect(parseCookie('a=1;;  ; b=2;')).toEqual({ a: '1', b: '2' })
  })

  it('skips a segment with no "=" because it cannot be a name/value pair', () => {
    expect(parseCookie('a=1; nonsense; b=2')).toEqual({ a: '1', b: '2' })
  })

  it('skips a segment that starts with "=" so "=value" cannot become an empty-named key', () => {
    expect(parseCookie('a=1; =orphan; b=2')).toEqual({ a: '1', b: '2' })
  })

  it('keeps the whole remainder as the value so "=" inside a JWT-ish token survives', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0=.abc=='
    expect(parseCookie(`UserToken=${token}`)).toEqual({ UserToken: token })
    expect(parseCookie('a=b=c')).toEqual({ a: 'b=c' })
  })

  it('returns an empty map for an empty header rather than throwing', () => {
    expect(parseCookie('')).toEqual({})
  })
})

describe('getCookieValue', () => {
  it('returns the value when the name is present', () => {
    expect(getCookieValue(COOKIE, 'UserName')).toBe('bob')
  })

  it('returns undefined when the name is absent instead of throwing', () => {
    expect(getCookieValue(COOKIE, 'Missing')).toBeUndefined()
  })
})

describe('validateCookie', () => {
  it('rejects an empty cookie and names CSDN_COOKIE because that is what the user must set', () => {
    const result = validateCookie('')
    expect(result.valid).toBe(false)
    expect(result.userName).toBe('')
    expect(result.reason).toContain('CSDN_COOKIE')
  })

  it('rejects a whitespace-only cookie, since a blank header authenticates nothing', () => {
    const result = validateCookie('   ')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('CSDN_COOKIE')
  })

  it('reports a missing UserToken by name because document.cookie cannot see the HTTP-only cookie', () => {
    const result = validateCookie('UserName=bob; csrfToken=xyz')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('UserToken')
    expect(result.reason).toContain('document.cookie')
    expect(result.userName).toBe('bob')
  })

  it('reports a missing UserName when UserToken is present, since a partial copy still fails', () => {
    const result = validateCookie('UserToken=abcdef123456')
    expect(result.valid).toBe(false)
    expect(result.userName).toBe('')
    expect(result.reason).toContain('UserName')
  })

  it('treats "UserName=" as missing because an empty name is as useless as no name', () => {
    const result = validateCookie('UserToken=abcdef123456; UserName=')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('UserName')
  })

  it('accepts a cookie carrying both UserToken and UserName', () => {
    expect(validateCookie(COOKIE)).toEqual({ valid: true, userName: 'bob' })
  })
})

describe('loadConfig', () => {
  it('falls back to every default when the environment is empty', () => {
    expect(loadConfig({})).toEqual(DEFAULT_CONFIG)
  })

  it('honours every CSDN_ override so an operator can retune without a rebuild', () => {
    const env = {
      CSDN_COOKIE: COOKIE,
      CSDN_APP_KEY: 'app-key',
      CSDN_APP_SECRET: 'app-secret',
      CSDN_API_BASE: 'https://api.example.com',
      CSDN_BLOG_BASE: 'https://blog.example.com',
      CSDN_COMMUNITY_BASE: 'https://community.example.com',
      CSDN_USER_AGENT: 'custom-agent/1.0',
      CSDN_TIMEOUT_MS: '1500',
      CSDN_MAX_RETRIES: '7',
      CSDN_MIN_INTERVAL_MS: '25',
      CSDN_SAVE_INTERVAL_MS: '9000',
      CSDN_LOG_LEVEL: 'debug'
    }
    expect(loadConfig(env)).toEqual({
      appKey: 'app-key',
      appSecret: 'app-secret',
      apiBase: 'https://api.example.com',
      blogBase: 'https://blog.example.com',
      communityBase: 'https://community.example.com',
      cookie: COOKIE,
      userName: 'bob',
      userAgent: 'custom-agent/1.0',
      timeoutMs: 1500,
      maxRetries: 7,
      minRequestIntervalMs: 25,
      saveIntervalMs: 9000,
      logLevel: 'debug'
    })
  })

  it('prefers the cookie UserName over CSDN_USERNAME because the cookie is the source of truth', () => {
    const config = loadConfig({ CSDN_COOKIE: COOKIE, CSDN_USERNAME: 'someone-else' })
    expect(config.userName).toBe('bob')
  })

  it('falls back to CSDN_USERNAME when the pasted cookie carries no UserName', () => {
    const config = loadConfig({ CSDN_COOKIE: 'UserToken=abcdef123456', CSDN_USERNAME: 'fallback-user' })
    expect(config.userName).toBe('fallback-user')
  })

  it('leaves userName empty when neither the cookie nor the env var provides one', () => {
    expect(loadConfig({ CSDN_COOKIE: 'UserToken=abcdef123456' }).userName).toBe('')
  })

  it('trims the cookie so a trailing newline pasted from DevTools cannot break the header', () => {
    expect(loadConfig({ CSDN_COOKIE: `  ${COOKIE}\n` }).cookie).toBe(COOKIE)
  })

  it('strips trailing slashes from all three base URLs so paths never double up', () => {
    const config = loadConfig({
      CSDN_API_BASE: 'https://api.example.com///',
      CSDN_BLOG_BASE: 'https://blog.example.com/',
      CSDN_COMMUNITY_BASE: 'https://community.example.com//'
    })
    expect(config.apiBase).toBe('https://api.example.com')
    expect(config.blogBase).toBe('https://blog.example.com')
    expect(config.communityBase).toBe('https://community.example.com')
  })

  it('keeps the default bases unchanged when they carry no trailing slash', () => {
    const config = loadConfig({ CSDN_API_BASE: DEFAULT_CONFIG.apiBase })
    expect(config.apiBase).toBe(DEFAULT_CONFIG.apiBase)
  })

  it('ignores a non-numeric integer override because NaN would disable the timeout', () => {
    expect(loadConfig({ CSDN_TIMEOUT_MS: 'soon' }).timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs)
  })

  it('ignores a negative integer override because a negative retry/timeout is meaningless', () => {
    expect(loadConfig({ CSDN_MAX_RETRIES: '-1' }).maxRetries).toBe(DEFAULT_CONFIG.maxRetries)
    expect(loadConfig({ CSDN_TIMEOUT_MS: '-500' }).timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs)
  })

  it('ignores a blank integer override, which is what `export FOO=` produces', () => {
    expect(loadConfig({ CSDN_MIN_INTERVAL_MS: '   ' }).minRequestIntervalMs).toBe(
      DEFAULT_CONFIG.minRequestIntervalMs
    )
  })

  it('accepts 0 as a real throttle setting rather than treating it as unset', () => {
    expect(loadConfig({ CSDN_MIN_INTERVAL_MS: '0' }).minRequestIntervalMs).toBe(0)
  })

  it('ignores a blank string override so `export CSDN_APP_KEY=` cannot blank the app key', () => {
    const config = loadConfig({ CSDN_APP_KEY: '  ', CSDN_USER_AGENT: '' })
    expect(config.appKey).toBe(DEFAULT_APP_KEY)
    expect(config.userAgent).toBe(DEFAULT_USER_AGENT)
  })

  it('trims a string override, since a paste from a shell often carries padding', () => {
    expect(loadConfig({ CSDN_APP_SECRET: ' secret ' }).appSecret).toBe('secret')
  })

  it('falls back to the default log level for an unknown CSDN_LOG_LEVEL', () => {
    expect(loadConfig({ CSDN_LOG_LEVEL: 'verbose' }).logLevel).toBe(DEFAULT_CONFIG.logLevel)
  })

  it('falls back to the default log level when CSDN_LOG_LEVEL is blank', () => {
    expect(loadConfig({ CSDN_LOG_LEVEL: '  ' }).logLevel).toBe(DEFAULT_CONFIG.logLevel)
  })

  it('accepts a case-insensitive log level so CSDN_LOG_LEVEL=DEBUG works', () => {
    expect(loadConfig({ CSDN_LOG_LEVEL: ' DEBUG ' }).logLevel).toBe('debug')
  })

  it('defaults the app key and secret to the public CSDN constants', () => {
    const config = loadConfig({})
    expect(config.appKey).toBe(DEFAULT_APP_KEY)
    expect(config.appSecret).toBe(DEFAULT_APP_SECRET)
  })
})

describe('buildConfig', () => {
  it('returns the defaults when called with no overrides', () => {
    expect(buildConfig()).toEqual(DEFAULT_CONFIG)
  })

  it('merges overrides over the defaults', () => {
    const config = buildConfig({ cookie: COOKIE, userName: 'bob', timeoutMs: 10 })
    expect(config.cookie).toBe(COOKIE)
    expect(config.userName).toBe('bob')
    expect(config.timeoutMs).toBe(10)
    expect(config.apiBase).toBe(DEFAULT_CONFIG.apiBase)
  })

  it('returns a fresh object that cannot mutate DEFAULT_CONFIG', () => {
    const before = { ...DEFAULT_CONFIG }
    const config = buildConfig({ cookie: COOKIE })
    expect(config).not.toBe(DEFAULT_CONFIG)

    config.timeoutMs = 1
    config.cookie = 'tampered'

    expect({ ...DEFAULT_CONFIG }).toEqual(before)
    expect(DEFAULT_CONFIG.timeoutMs).toBe(20_000)
    expect(DEFAULT_CONFIG.cookie).toBe('')
  })
})
