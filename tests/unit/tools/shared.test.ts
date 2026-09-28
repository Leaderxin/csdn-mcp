/**
 * The reply plumbing every tool shares.
 *
 * The error translation is the part worth testing directly: the code is what a
 * caller branches on, the hint is what a human acts on, and a cookie that leaked
 * through an error message would be the worst bug this server could ship.
 */

import { describe, expect, it } from 'vitest'

import { CsdnError, type CsdnErrorCode } from '../../../src/core/errors.js'
import {
  DESCRIPTION_LIMIT,
  TAG_LIMIT,
  asCallToolResult,
  errorResult,
  jsonResult,
  parseScheduledAt
} from '../../../src/tools/shared.js'

const ALL_CODES: CsdnErrorCode[] = [
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

const COOKIE = 'uuid_tt_dd=abc; UserToken=secret-token-value; UserName=alice'

/** A throwable that is not an `Error`, which the transport layer can produce. */
const NOT_AN_ERROR = { toString: () => 'not an Error at all' }

function textOf(result: { content: Array<{ type: 'text'; text: string }> }): string {
  return result.content.map(block => block.text).join('\n')
}

/** Run `fn`, returning the CsdnError it threw (so tests can assert on `code`). */
function captureCsdnError(fn: () => unknown): CsdnError {
  try {
    fn()
  } catch (error) {
    if (error instanceof CsdnError) return error
    throw error
  }
  throw new Error('expected a CsdnError, but nothing was thrown')
}

describe('jsonResult', () => {
  it('puts a one-line summary above a fenced json block, so a human and a program can both read it', () => {
    const result = jsonResult('已更新文章 1', { articleId: '1', tags: ['MCP'] })
    const text = textOf(result)
    expect(text.startsWith('已更新文章 1\n\n```json\n')).toBe(true)
    expect(text.endsWith('\n```')).toBe(true)
    const block = /```json\n([\s\S]*?)\n```/.exec(text)?.[1]
    expect(JSON.parse(block ?? '')).toEqual({ articleId: '1', tags: ['MCP'] })
    expect(result.isError).toBeUndefined()
  })

  it('keeps the limits CSDN enforces in one place', () => {
    expect(TAG_LIMIT).toBe(5)
    expect(DESCRIPTION_LIMIT).toBe(256)
  })
})

describe('errorResult', () => {
  it.each(ALL_CODES)('answers %s with the code, the reason and an actionable hint', (code: CsdnErrorCode) => {
    const result = errorResult(new CsdnError(code, '接口说了原因'))
    const text = textOf(result)
    expect(result.isError).toBe(true)
    expect(text).toContain(`❌ ${code}`)
    expect(text).toContain('接口说了原因')
    expect(text).toContain('处理建议：')
    expect(text.length).toBeGreaterThan(60)
  })

  it('tells an expired-cookie caller how to refresh it, by name', () => {
    const text = textOf(errorResult(new CsdnError('AUTH_INVALID', 'CSDN 拒绝请求（HTTP 401）')))
    expect(text).toContain('过期')
    expect(text).toContain('auth_login')
    expect(text).toContain('F12')
    expect(text).toContain('UserToken')
  })

  it('names the environment variable when no cookie is configured at all', () => {
    expect(textOf(errorResult(new CsdnError('AUTH_MISSING', '未配置 CSDN Cookie')))).toContain('CSDN_COOKIE')
  })

  it('says how long to wait when CSDN throttles us', () => {
    const text = textOf(errorResult(new CsdnError('RATE_LIMITED', '文章频繁发布，请稍后再试')))
    expect(text).toContain('10 秒')
    expect(text).toContain('重试')
  })

  it('explains that a non-JSON answer means the endpoint moved', () => {
    const text = textOf(errorResult(new CsdnError('MALFORMED_RESPONSE', '接口返回的不是 JSON')))
    expect(text).toContain('下线或改版')
    expect(text).toContain('reverse-engineering')
  })

  it('points a NOT_FOUND caller at the article id instead of suggesting a retry', () => {
    const text = textOf(errorResult(new CsdnError('NOT_FOUND', '文章不存在')))
    expect(text).toContain('article_id')
    expect(text).not.toContain('可重试')
  })

  it('reports the HTTP status and the retryability that the error itself carries', () => {
    const retryable = textOf(errorResult(new CsdnError('SERVER_ERROR', 'CSDN 服务端错误', { status: 503 })))
    expect(retryable).toContain('HTTP 状态：503')
    expect(retryable).toContain('可重试')

    const terminal = textOf(errorResult(new CsdnError('INVALID_ARGUMENT', 'tags 最多 5 个')))
    expect(terminal).not.toContain('HTTP 状态')
    expect(terminal).not.toContain('可重试')
  })

  it('shows the server-supplied detail, but drops it when there is none to show', () => {
    const withDetail = textOf(
      errorResult(new CsdnError('API_ERROR', '失败', { detail: 'code=500 内部错误' }))
    )
    expect(withDetail).toContain('接口返回：code=500 内部错误')

    const emptyDetail = textOf(errorResult(new CsdnError('API_ERROR', '失败', { detail: '   ' })))
    expect(emptyDetail).not.toContain('接口返回')
  })

  it('never leaks a cookie, even when the failure echoes the request headers back', () => {
    const result = errorResult(
      new CsdnError('AUTH_INVALID', 'CSDN 拒绝请求（HTTP 401）', { detail: `Cookie: ${COOKIE}` })
    )
    const text = textOf(result)
    expect(text).not.toContain('secret-token-value')
    expect(text).not.toContain('uuid_tt_dd=abc')
    expect(text).toContain('<redacted>')
  })

  it('reports a non-CsdnError as a server bug with the message alone, never a stack trace', () => {
    const result = errorResult(new Error('boom'))
    const text = textOf(result)
    expect(result.isError).toBe(true)
    expect(text).toContain('UNEXPECTED')
    expect(text).toContain('boom')
    expect(text).not.toContain('at ')
    expect(text).toContain('非预期错误')
  })

  it('stringifies a thrown value that is not an Error at all', () => {
    const text = textOf(errorResult(NOT_AN_ERROR))
    expect(text).toContain('not an Error at all')
  })
})

describe('parseScheduledAt', () => {
  const NOW = Date.parse('2026-09-28T00:00:00Z')

  it('returns seconds, because seconds is the unit CSDN reads a schedule back in', () => {
    const when = '2026-10-01T09:00:00+08:00'
    expect(parseScheduledAt(when, NOW)).toBe(Math.floor(Date.parse(when) / 1000))
  })

  it('refuses a value it cannot parse instead of scheduling something arbitrary', () => {
    for (const value of ['下周三', 'not-a-date', '']) {
      const error = captureCsdnError(() => parseScheduledAt(value, NOW))
      expect(error.code).toBe('INVALID_ARGUMENT')
      expect(error.message).toContain('ISO 8601')
    }
  })

  it('refuses a moment that has passed or is exactly now, because CSDN publishes a past schedule immediately', () => {
    // The failure this guards against: a unit mistake lands in the past, and the
    // accidental publish is exactly what this server exists to prevent.
    expect(captureCsdnError(() => parseScheduledAt('2026-09-27T00:00:00Z', NOW)).message).toContain(
      '必须晚于当前时间'
    )
    expect(captureCsdnError(() => parseScheduledAt(new Date(NOW).toISOString(), NOW)).message).toContain(
      '必须晚于当前时间'
    )
  })
})

describe('asCallToolResult', () => {
  it('keeps the error marker when adapting to the SDK result type', () => {
    expect(asCallToolResult(errorResult(new CsdnError('NETWORK', '断网了'))).isError).toBe(true)
    expect(asCallToolResult(jsonResult('ok', {})).isError).toBeUndefined()
  })
})
