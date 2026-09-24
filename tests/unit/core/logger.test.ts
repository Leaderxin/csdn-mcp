import { describe, expect, it, vi } from 'vitest'
import type { LogLevel } from '../../../src/core/config.js'
import { createLogger, redact } from '../../../src/core/logger.js'
import { createMemorySink } from '../../helpers/fake-fetch.js'

const LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug']

/**
 * What each level must let through. Testing all five levels in both directions
 * (lower levels emitted, higher levels suppressed) is what keeps a level filter
 * from silently becoming "log everything" or "log nothing".
 */
const EMITTED_AT: Record<LogLevel, readonly string[]> = {
  silent: [],
  error: ['ERROR'],
  warn: ['ERROR', 'WARN'],
  info: ['ERROR', 'WARN', 'INFO'],
  debug: ['ERROR', 'WARN', 'INFO', 'DEBUG']
}

const REASONS: Record<LogLevel, string> = {
  silent: 'silent is the only way to keep a stdio server completely quiet',
  error: 'error is the floor: warn/info/debug are below the threshold and must be dropped',
  warn: 'warn keeps errors and warnings but drops info and debug',
  info: 'info keeps errors, warnings and info but drops debug',
  debug: 'debug keeps everything, including debug'
}

describe('createLogger level filtering', () => {
  for (const level of LEVELS) {
    it(`at '${level}' emits ${EMITTED_AT[level].join('/') || 'nothing'} because ${REASONS[level]}`, () => {
      const { lines, sink } = createMemorySink()
      const logger = createLogger({ level, sink })

      logger.error('e')
      logger.warn('w')
      logger.info('i')
      logger.debug('d')

      expect(lines.map(line => line.split(' ')[1])).toEqual(EMITTED_AT[level])
    })
  }

  it('defaults to warn so an unconfigured server is quiet but never silent about failures', () => {
    const { lines, sink } = createMemorySink()
    const logger = createLogger({ sink })

    expect(logger.level).toBe('warn')
    logger.error('e')
    logger.info('i')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('ERROR')
  })
})

describe('createLogger line format', () => {
  it('prefixes every record with [csdn-mcp], the level and the message', () => {
    const { lines, sink } = createMemorySink()
    createLogger({ level: 'debug', sink }).error('boom')

    expect(lines).toEqual(['[csdn-mcp] ERROR boom'])
  })

  it('appends bindings as key=value pairs after the message', () => {
    const { lines, sink } = createMemorySink()
    createLogger({ level: 'warn', sink, bindings: { mod: 'http', attempt: 2 } }).warn('retrying')

    expect(lines).toEqual(['[csdn-mcp] WARN retrying mod=http attempt=2'])
  })

  it('renders call-site fields after the child bindings, and lets them win on a duplicate key', () => {
    const { lines, sink } = createMemorySink()
    createLogger({ level: 'warn', sink, bindings: { a: 'binding', b: 'kept' } }).warn('msg', {
      a: 'field',
      c: 'added'
    })

    expect(lines).toEqual(['[csdn-mcp] WARN msg a=field b=kept c=added'])
  })

  it('redacts the message as well as the fields, so a leaked header in a template string is caught', () => {
    const { lines, sink } = createMemorySink()
    createLogger({ level: 'warn', sink }).warn('failed with UserToken=abcdef123456')

    expect(lines).toEqual(['[csdn-mcp] WARN failed with UserToken=<redacted>'])
  })
})

describe('field serialization (through the public logger surface)', () => {
  it('writes null and undefined by name because JSON.stringify would silently drop them', () => {
    const { lines, sink } = createMemorySink()
    createLogger({ level: 'info', sink }).info('msg', { a: null, b: undefined })

    expect(lines).toEqual(['[csdn-mcp] INFO msg a=null b=undefined'])
  })

  it('writes numbers and booleans without quotes so they stay machine-readable', () => {
    const { lines, sink } = createMemorySink()
    createLogger({ level: 'info', sink }).info('msg', { n: 3, f: false, t: true })

    expect(lines).toEqual(['[csdn-mcp] INFO msg n=3 f=false t=true'])
  })

  it('renders an Error as "name: message" because the stack is not useful in a one-line log', () => {
    const { lines, sink } = createMemorySink()
    createLogger({ level: 'error', sink }).error('msg', { err: new Error('kaput') })

    expect(lines).toEqual(['[csdn-mcp] ERROR msg err=Error: kaput'])
  })

  it('JSON-encodes a plain object', () => {
    const { lines, sink } = createMemorySink()
    createLogger({ level: 'info', sink }).info('msg', { obj: { a: [1, 2], s: 'x' } })

    expect(lines).toEqual(['[csdn-mcp] INFO msg obj={"a":[1,2],"s":"x"}'])
  })

  it('renders a circular object as [unserializable] rather than throwing inside the logger', () => {
    const { lines, sink } = createMemorySink()
    const circular: Record<string, unknown> = { name: 'loop' }
    circular['self'] = circular

    expect(() => createLogger({ level: 'info', sink }).info('msg', { circular })).not.toThrow()
    expect(lines).toEqual(['[csdn-mcp] INFO msg circular=[unserializable]'])
  })

  it('redacts a credential inside a JSON-encoded object field', () => {
    const { lines, sink } = createMemorySink()
    createLogger({ level: 'info', sink }).info('msg', { headers: { Cookie: 'UserToken=abcdef123456' } })

    // JSON.stringifying the object first means the field name arrives quoted as
    // `"Cookie":"..."`, so the redactor has to tolerate quoting on both sides of
    // the delimiter. It used to not, and this exact log line leaked the cookie.
    expect(lines).toEqual(['[csdn-mcp] INFO msg headers={"Cookie":"<redacted>"}'])
  })
})

describe('redact', () => {
  it('replaces a UserToken assignment with <redacted>, keeping the field name', () => {
    expect(redact('UserToken=abcdef123456')).toBe('UserToken=<redacted>')
  })

  it('replaces a Cookie header, keeping the attribute name and the delimiter', () => {
    expect(redact('Cookie: a=b; c=d')).toBe('Cookie: <redacted>; c=d')
  })

  it('replaces a csrfToken assignment', () => {
    expect(redact('csrfToken=xyz123')).toBe('csrfToken=<redacted>')
  })

  it('replaces the value after padding whitespace around the delimiter', () => {
    // The delimiter is re-emitted verbatim so the redacted line still reads as
    // the same syntax it was written in.
    expect(redact('UserToken = abcdef123456')).toBe('UserToken = <redacted>')
  })

  it('keeps a quoted value quoted, so the redacted output is still valid JSON', () => {
    expect(redact('cookie="abcdefg"')).toBe('cookie="<redacted>"')
  })

  it('redacts a credential even when its value contains a comma', () => {
    // The value class must NOT stop at a comma: an HTTP cookie is
    // semicolon-separated, while a JSON value may legitimately contain commas,
    // and truncating there would leak the remainder.
    expect(redact('{"cookie":"a,b,c"}')).toBe('{"cookie":"<redacted>"}')
  })

  it('redacts a quoted delimiter that JSON.stringify produced, which was a real leak', () => {
    // Regression: the quote sitting between the field name and the colon used to
    // defeat the pattern entirely, so these three lines leaked verbatim.
    expect(redact('{"csrfToken":"abc123"}')).toBe('{"csrfToken":"<redacted>"}')
    expect(redact('{"userName": "alice123"}')).toBe('{"userName": "<redacted>"}')
    expect(redact('{"UserToken":"abcdef1234"}')).toBe('{"UserToken":"<redacted>"}')
  })

  it('redacts a multi-line cookie, because a copied header often wraps', () => {
    const wrapped = 'Cookie: UserToken=abcdef123456;\n  UserName=bob; c=d'
    const output = redact(wrapped)

    expect(output).not.toContain('abcdef123456')
    expect(output).not.toContain('bob')
  })

  it('redacts every credential in a JSON-ish blob, keeping the field names', () => {
    // The outer `cookie` value swallows the leading `UserToken=` text as part of
    // what it redacts, so that one field name is lost from the line. Redacting
    // more than necessary is the safe direction for a credential filter.
    const output = redact('{"cookie": "UserToken=abcdefg; UserName=bob"}')

    expect(output).toBe('{"cookie": "<redacted>; UserName=<redacted>"}')
    expect(output).not.toContain('abcdefg')
    expect(output).not.toContain('bob')
  })

  it('returns an ordinary sentence unchanged so normal messages stay readable', () => {
    const sentence = 'retrying request path=/blog-console-api/v1/article/save attempt=1'
    expect(redact(sentence)).toBe(sentence)
  })

  it('redacts short values too, because failing closed beats a leaked credential', () => {
    // A real CSDN token is far longer, but guessing at a minimum length means
    // the floor becomes the leak threshold. Redact everything instead.
    expect(redact('UserToken=ab')).toBe('UserToken=<redacted>')
  })

  it('redacts Set-Cookie as well, since that is how the value arrives in a response log', () => {
    expect(redact('Set-Cookie: UserToken=abcdef123456; Path=/')).toBe('Set-Cookie: <redacted>; Path=/')
  })
})

describe('createLogger child', () => {
  it('merges new bindings over the parent ones and keeps the parent level', () => {
    const { lines, sink } = createMemorySink()
    const child = createLogger({ level: 'debug', sink, bindings: { mod: 'http' } }).child({
      path: '/x',
      mod: 'csdn'
    })

    expect(child.level).toBe('debug')
    child.debug('sent')
    expect(lines).toEqual(['[csdn-mcp] DEBUG sent mod=csdn path=/x'])
  })

  it('keeps writing to the parent sink, so a child cannot escape stderr redirection', () => {
    const { lines, sink } = createMemorySink()
    createLogger({ level: 'error', sink }).child({ a: 'b' }).error('boom')

    expect(lines).toEqual(['[csdn-mcp] ERROR boom a=b'])
  })
})

describe('default sink', () => {
  it('writes to stderr with a trailing newline and never to stdout, which belongs to the MCP transport', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    createLogger({ level: 'error' }).error('hello')

    expect(stderrWrite).toHaveBeenCalledWith('[csdn-mcp] ERROR hello\n')
    expect(stdoutWrite.mock.calls.map(call => String(call[0]))).not.toContain('[csdn-mcp] ERROR hello\n')

    stderrWrite.mockRestore()
    stdoutWrite.mockRestore()
  })
})

/**
 * These pin the two redaction call sites and the cookie attribute families. They
 * exist because all three could be deleted with the whole suite still green: the
 * only no-leak assertions used fixtures whose attribute names happened to be on
 * the name list, so a realistic cookie header leaked while CI stayed green.
 */
describe('credential redaction covers every emission path', () => {
  it('redacts a credential carried in a plain string field', () => {
    const { lines, sink } = createMemorySink()
    const logger = createLogger({ level: 'debug', sink })

    logger.debug('auth parts', { a: 'UserToken=fixture-token-not-a-credential' })

    expect(lines[0]).not.toContain('fixture-token-not-a-credential')
    expect(lines[0]).toContain('a=UserToken=<redacted>')
  })

  it('redacts a credential embedded in an Error field', () => {
    const { lines, sink } = createMemorySink()
    const logger = createLogger({ level: 'debug', sink })

    logger.error('request failed', {
      cause: new Error('boom cookie UserToken=fixture-token-not-a-credential')
    })

    expect(lines[0]).not.toContain('fixture-token-not-a-credential')
    expect(lines[0]).toContain('cause=Error: boom cookie UserToken=<redacted>')
  })

  it('redacts CSDN session attributes that carry a variable suffix', () => {
    const { lines, sink } = createMemorySink()
    const logger = createLogger({ level: 'debug', sink })

    // `c_session_id`, not `c_session`: matching the bare family name left the
    // value in place, which is how a real cookie header survived.
    logger.debug('headers', { Cookie: 'c_session_id=0c1d2e3f4a5b6c7d8e9f; Hm_up_9e2c1b=abcdef123456' })

    expect(lines[0]).not.toContain('0c1d2e3f4a5b6c7d8e9f')
    expect(lines[0]).not.toContain('abcdef123456')
  })

  it('redacts a credential inside a JSON-serialized object field', () => {
    const { lines, sink } = createMemorySink()
    const logger = createLogger({ level: 'debug', sink })

    logger.debug('batch', { fields: { nested: { UserToken: 'fixture-token-not-a-credential' } } })

    expect(lines[0]).not.toContain('fixture-token-not-a-credential')
  })

  it('redacts a Cookie header written with a colon, and visitor-id attributes', () => {
    expect(redact('Cookie: UserToken=fixture-token-not-a-credential')).not.toContain(
      'fixture-token-not-a-credential'
    )
    expect(redact('bt_user_priv_var=real-secret-value-here')).not.toContain('real-secret-value-here')
    // The attribute NAME is deliberately kept so the line stays readable; only
    // the value may disappear.
    expect(redact('log_Id_1234567890abcd=secretvalue123')).not.toContain('secretvalue123')
  })
})
