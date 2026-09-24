import { describe, expect, it, vi } from 'vitest'
import { buildConfig, type CsdnConfig } from '../../../src/core/config.js'
import { CsdnError } from '../../../src/core/errors.js'
import {
  CsdnHttpClient,
  backoffDelay,
  buildQuery,
  parseJsonBody,
  unwrapEnvelope,
  type CsdnEnvelope,
  type FetchLike,
  type HttpClientOptions,
  type HttpResponse
} from '../../../src/core/http.js'
import { createLogger } from '../../../src/core/logger.js'
import { RateLimiter } from '../../../src/core/ratelimit.js'
import { sign } from '../../../src/core/signer.js'
import {
  apiErrorEnvelope,
  createFakeFetch,
  createMemorySink,
  okEnvelope,
  openresty404,
  type FakeFetch
} from '../../helpers/fake-fetch.js'

const COOKIE = 'UserToken=abcdef123456; UserName=bob'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface TestClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
  sleeps: number[]
}

/** Injected clock: every "wait" is recorded, none is real. */
function makeClock(): TestClock {
  let time = 0
  const sleeps: number[] = []
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      time += ms
    },
    sleeps
  }
}

function makeConfig(overrides: Partial<CsdnConfig> = {}): CsdnConfig {
  // minRequestIntervalMs 0 by default so only the throttling tests produce sleeps.
  return buildConfig({ cookie: COOKIE, minRequestIntervalMs: 0, ...overrides })
}

interface BuiltClient {
  client: CsdnHttpClient
  clock: TestClock
}

function makeClient(
  fake: FakeFetch,
  overrides: Partial<CsdnConfig> = {},
  seams: Partial<Pick<HttpClientOptions, 'logger' | 'rateLimiter'>> = {}
): BuiltClient {
  const clock = makeClock()
  const client = new CsdnHttpClient({
    config: makeConfig(overrides),
    fetchImpl: fake.fetch,
    sleep: clock.sleep,
    now: clock.now,
    ...seams
  })
  return { client, clock }
}

/** Recompute the signature the client was supposed to send. */
function expectedSignature(
  config: CsdnConfig,
  rec: { headers: Record<string, string> },
  signInput: { method: string; uri: string; accept?: string; contentType?: string }
): string {
  return sign({
    method: signInput.method,
    uri: signInput.uri,
    accept: signInput.accept ?? '*/*',
    contentType: signInput.contentType ?? '',
    nonce: rec.headers['X-Ca-Nonce'] ?? '',
    appKey: config.appKey,
    appSecret: config.appSecret
  })
}

describe('buildQuery', () => {
  it('returns an empty string for undefined params, so callers can pass options straight through', () => {
    expect(buildQuery(undefined)).toBe('')
  })

  it('returns an empty string when every param was filtered out', () => {
    expect(buildQuery({})).toBe('')
    expect(buildQuery({ a: undefined })).toBe('')
  })

  it('drops undefined, null and empty-string values so an unset filter cannot reach the server', () => {
    expect(buildQuery({ a: undefined, b: null, c: '', keep: 'x' })).toBe('keep=x')
  })

  it('keeps 0 and false because both are meaningful query values', () => {
    expect(buildQuery({ page: 0, deleted: false })).toBe('page=0&deleted=false')
  })

  it('percent-encodes special characters so a search term cannot break the URL', () => {
    expect(buildQuery({ q: 'a b&c=d', title: '中文' })).toBe('q=a+b%26c%3Dd&title=%E4%B8%AD%E6%96%87')
  })
})

describe('backoffDelay', () => {
  it('doubles from 500ms: 500, 1000, 2000, 4000', () => {
    expect([0, 1, 2, 3].map(backoffDelay)).toEqual([500, 1_000, 2_000, 4_000])
  })

  it('caps the delay at 8s so a long retry chain cannot hang an agent session', () => {
    expect([4, 5, 10].map(backoffDelay)).toEqual([8_000, 8_000, 8_000])
  })
})

describe('CsdnHttpClient.url', () => {
  it('joins the api base with a relative path', () => {
    const { client } = makeClient(createFakeFetch())
    expect(client.url('/blog-console-api/v1/article/save')).toBe(
      'https://bizapi.csdn.net/blog-console-api/v1/article/save'
    )
  })

  it('appends a query string when params survive filtering', () => {
    const { client } = makeClient(createFakeFetch())
    expect(client.url('/v1/x', { id: 7, q: '中文' })).toBe('https://bizapi.csdn.net/v1/x?id=7&q=%E4%B8%AD%E6%96%87')
  })

  it('adds no "?" when there are no params', () => {
    const { client } = makeClient(createFakeFetch())
    expect(client.url('/v1/x', {})).toBe('https://bizapi.csdn.net/v1/x')
  })

  it('passes an absolute https URL through unchanged, so a full URL can be fetched as-is', () => {
    const { client } = makeClient(createFakeFetch())
    expect(client.url('https://bizapi.csdn.net/v1/x')).toBe('https://bizapi.csdn.net/v1/x')
  })

  it('passes an absolute http URL through unchanged and still appends the query', () => {
    const { client } = makeClient(createFakeFetch())
    expect(client.url('http://localhost:8080/v1/x', { a: 1 })).toBe('http://localhost:8080/v1/x?a=1')
  })
})

describe('CsdnHttpClient.request auth', () => {
  it('throws AUTH_MISSING before any fetch when a signed call has no cookie', async () => {
    const fake = createFakeFetch()
    const { client } = makeClient(fake, { cookie: '' })

    await expect(client.request({ path: '/blog-console-api/v1/article/save' })).rejects.toMatchObject({
      code: 'AUTH_MISSING',
      retryable: false
    })
    expect(fake.requests).toHaveLength(0)
  })

  it('treats a whitespace-only cookie as missing, since a blank header authenticates nothing', async () => {
    const fake = createFakeFetch()
    const { client } = makeClient(fake, { cookie: '   ' })

    await expect(client.request({ path: '/v1/x' })).rejects.toMatchObject({ code: 'AUTH_MISSING' })
    expect(fake.requests).toHaveLength(0)
  })

  it('allows a public call without a cookie when requireAuth is false', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake, { cookie: '' })

    await expect(client.requestData({ path: '/v1/public', signed: false, requireAuth: false })).resolves.toEqual({
      ok: true
    })
    expect(fake.last().headers['Cookie']).toBeUndefined()
  })

  it('defaults requireAuth to the signed flag, so an unsigned call needs no cookie', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake, { cookie: '' })

    await expect(client.requestData({ path: '/v1/public', signed: false })).resolves.toEqual({ ok: true })
    expect(fake.requests).toHaveLength(1)
  })

  it('still demands a cookie when requireAuth is explicitly true on an unsigned call', async () => {
    const fake = createFakeFetch()
    const { client } = makeClient(fake, { cookie: '' })

    await expect(client.request({ path: '/v1/x', signed: false, requireAuth: true })).rejects.toMatchObject({
      code: 'AUTH_MISSING'
    })
    expect(fake.requests).toHaveLength(0)
  })

  it('sends the configured cookie verbatim on a signed call', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake)

    await client.request({ path: '/v1/x' })
    expect(fake.last().headers['Cookie']).toBe(COOKIE)
  })

  it('omits the Cookie header on a public call even when a cookie is configured', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake)

    await client.request({ path: '/v1/public', signed: false })
    expect(fake.last().headers['Cookie']).toBeUndefined()
  })
})

describe('CsdnHttpClient.request headers and body', () => {
  it('sends the browser-ish defaults CSDN expects on every bizapi call', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake)

    await client.request({ path: '/v1/x' })
    const headers = fake.last().headers
    expect(headers['User-Agent']).toBe(buildConfig().userAgent)
    expect(headers['Accept']).toBe('*/*')
    expect(headers['Referer']).toBe('https://editor.csdn.net/md/')
    expect(headers['Origin']).toBe('https://editor.csdn.net')
  })

  it('honours an explicit Accept and folds it into the signature', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake)

    await client.request({ path: '/v1/x', method: 'GET', accept: 'application/json' })
    const rec = fake.last()
    expect(rec.headers['Accept']).toBe('application/json')
    expect(rec.headers['X-Ca-Signature']).toBe(
      expectedSignature(client.config, rec, { method: 'GET', uri: '/v1/x', accept: 'application/json' })
    )
  })

  it('sends the X-Ca-* header set on a signed call', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake)

    await client.request({ path: '/v1/x' })
    const headers = fake.last().headers
    expect(headers['X-Ca-Key']).toBe(buildConfig().appKey)
    expect(headers['X-Ca-Nonce']).toMatch(UUID)
    expect(headers['X-Ca-Timestamp']).toMatch(/^\d+$/)
    expect(headers['X-Ca-Signature-Headers']).toBe('x-ca-key,x-ca-nonce')
    expect(headers['X-Ca-Signature']).toMatch(/^[A-Za-z0-9+/]+=$/)
  })

  it('omits every X-Ca-* header on an unsigned call, which is what the public API needs', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake)

    await client.request({ path: '/v1/public', signed: false })
    const caHeaders = Object.keys(fake.last().headers).filter((key) => key.toLowerCase().startsWith('x-ca-'))
    expect(caHeaders).toEqual([])
  })

  it('signs the uri including the query string, which is the difference between 200 and 401', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake)

    await client.request({ path: '/v1/x', method: 'GET', query: { id: 7, q: '中文' } })
    const rec = fake.last()
    expect(rec.url).toBe('https://bizapi.csdn.net/v1/x?id=7&q=%E4%B8%AD%E6%96%87')
    expect(rec.headers['X-Ca-Signature']).toBe(
      expectedSignature(client.config, rec, { method: 'GET', uri: '/v1/x?id=7&q=%E4%B8%AD%E6%96%87' })
    )
  })

  it('signs only the path component of an absolute URL, exactly as for a relative one', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake)

    await client.request({ path: 'https://bizapi.csdn.net/v1/y', method: 'GET', query: { a: '1' } })
    const rec = fake.last()
    expect(rec.url).toBe('https://bizapi.csdn.net/v1/y?a=1')
    expect(rec.headers['X-Ca-Signature']).toBe(
      expectedSignature(client.config, rec, { method: 'GET', uri: '/v1/y?a=1' })
    )
  })

  it('signs a query already embedded in an absolute URL, not just the bare path', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake)

    await client.request({ path: 'https://bizapi.csdn.net/v1/y?a=1', method: 'GET' })
    const rec = fake.last()
    expect(rec.url).toBe('https://bizapi.csdn.net/v1/y?a=1')
    expect(rec.headers['X-Ca-Signature']).toBe(
      expectedSignature(client.config, rec, { method: 'GET', uri: '/v1/y?a=1' })
    )
  })

  it('sends a GET with no Content-Type and no body, so a read cannot look like a write', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake)

    await client.request({ path: '/v1/x', method: 'GET' })
    const rec = fake.last()
    expect(rec.method).toBe('GET')
    expect(rec.headers['Content-Type']).toBeUndefined()
    expect(rec.body).toBeUndefined()
  })

  it('defaults a POST body to the JSON content type and serializes it', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const config = makeConfig()
    const { client } = makeClient(fake, {})

    await client.request({ path: '/v1/save', body: { title: '文章', tags: ['a'] } })
    const rec = fake.last()
    expect(rec.method).toBe('POST')
    expect(rec.headers['Content-Type']).toBe('application/json; charset=UTF-8')
    expect(rec.body).toBe(JSON.stringify({ title: '文章', tags: ['a'] }))
    expect(rec.json).toEqual({ title: '文章', tags: ['a'] })
    expect(rec.headers['X-Ca-Signature']).toBe(
      expectedSignature(config, rec, {
        method: 'POST',
        uri: '/v1/save',
        contentType: 'application/json; charset=UTF-8'
      })
    )
  })

  it('honours an explicit empty contentType and sends no Content-Type header', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake)

    await client.request({ path: '/v1/x', method: 'POST', body: { a: 1 }, contentType: '' })
    const rec = fake.last()
    expect(rec.headers['Content-Type']).toBeUndefined()
    expect(rec.body).toBe(JSON.stringify({ a: 1 }))
  })

  it('honours an explicit contentType and folds that value into the signature', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const config = makeConfig()
    const { client } = makeClient(fake, {})

    await client.request({ path: '/v1/x', method: 'POST', body: 'raw', contentType: 'text/plain' })
    const rec = fake.last()
    expect(rec.headers['Content-Type']).toBe('text/plain')
    expect(rec.headers['X-Ca-Signature']).toBe(
      expectedSignature(config, rec, { method: 'POST', uri: '/v1/x', contentType: 'text/plain' })
    )
  })

  it('passes FormData straight to fetch and drops Content-Type so undici can set the boundary', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake)
    const form = new FormData()
    form.append('file', 'contents')

    await client.request({
      path: '/v1/upload',
      method: 'POST',
      formData: form,
      contentType: 'multipart/form-data'
    })
    const rec = fake.last()
    expect(rec.body).toBe(form)
    expect(rec.headers['Content-Type']).toBeUndefined()
  })
})

describe('parseJsonBody', () => {
  it('parses a valid JSON object', () => {
    expect(parseJsonBody<{ code: number }>('{"code":200}')).toEqual({ code: 200 })
  })

  it('parses a valid JSON array', () => {
    expect(parseJsonBody<number[]>('[1,2]')).toEqual([1, 2])
  })

  it('raises MALFORMED_RESPONSE for an openresty HTML page because that means the endpoint moved', () => {
    let thrown: unknown
    try {
      parseJsonBody('<html><head><title>404 Not Found</title></head><body>openresty</body></html>')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CsdnError)
    expect((thrown as CsdnError).code).toBe('MALFORMED_RESPONSE')
    expect((thrown as CsdnError).detail).toContain('openresty')
    expect((thrown as CsdnError).message).toContain('下线或路径变更')
  })

  it('raises MALFORMED_RESPONSE for truncated JSON, keeping the parse error as the cause', () => {
    let thrown: unknown
    try {
      parseJsonBody('{"code":200,"data":[')
    } catch (error) {
      thrown = error
    }
    const error = thrown as CsdnError
    expect(error.code).toBe('MALFORMED_RESPONSE')
    expect(error.message).toContain('JSON 无法解析')
    expect(error.detail).toBe('{"code":200,"data":[')
    expect(error.cause).toBeInstanceOf(SyntaxError)
  })

  it('truncates a huge non-JSON body to 300 characters plus an ellipsis', () => {
    const body = `<html>${'x'.repeat(400)}</html>`
    let thrown: unknown
    try {
      parseJsonBody(body)
    } catch (error) {
      thrown = error
    }
    const detail = (thrown as CsdnError).detail ?? ''
    expect(detail).toHaveLength(301)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('collapses whitespace in the snippet so an HTML page stays on one log line', () => {
    let thrown: unknown
    try {
      parseJsonBody('<html>\n  <body>\n    <p>openresty</p>\n  </body>\n</html>')
    } catch (error) {
      thrown = error
    }
    expect((thrown as CsdnError).detail).toBe('<html> <body> <p>openresty</p> </body> </html>')
  })

  it('surfaces the same MALFORMED_RESPONSE through request() for a 200 with an HTML body', async () => {
    const fake = createFakeFetch(openresty404(), openresty404(), openresty404())
    const { client } = makeClient(fake)

    await expect(client.requestData({ path: '/v1/dead' })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})

describe('unwrapEnvelope', () => {
  it('returns data when code is 200', () => {
    expect(unwrapEnvelope({ code: 200, data: { id: 1 } })).toEqual({ id: 1 })
  })

  it('treats a missing code as success, because some endpoints omit it entirely', () => {
    expect(unwrapEnvelope({ data: { id: 2 } })).toEqual({ id: 2 })
  })

  it('returns undefined when a success envelope carries no data at all', () => {
    expect(unwrapEnvelope({ code: 200 })).toBeUndefined()
  })

  it('maps 401, 403 and 700 to AUTH_INVALID because all three mean the cookie is no good', () => {
    for (const code of [401, 403, 700]) {
      expect(() => unwrapEnvelope({ code, msg: 'login required' })).toThrowError(
        expect.objectContaining({ code: 'AUTH_INVALID' })
      )
    }
  })

  it('maps 404 and 4004 to NOT_FOUND because CSDN uses both for a missing resource', () => {
    for (const code of [404, 4004]) {
      expect(() => unwrapEnvelope({ code, msg: 'not exist' })).toThrowError(
        expect.objectContaining({ code: 'NOT_FOUND' })
      )
    }
  })

  it('maps the Chinese save-throttle message to RATE_LIMITED so the retry loop backs off', () => {
    expect(() => unwrapEnvelope({ code: 4001, msg: '文章频繁发布，请稍后再试' })).toThrowError(
      expect.objectContaining({ code: 'RATE_LIMITED' })
    )
  })

  it('maps a case-insensitive English throttle hint to RATE_LIMITED too', () => {
    for (const msg of ['TOO MANY REQUESTS', 'Rate Limit exceeded', '请慢一点']) {
      expect(() => unwrapEnvelope({ code: 4001, msg })).toThrowError(
        expect.objectContaining({ code: 'RATE_LIMITED' })
      )
    }
  })

  it('maps any other non-200 code to API_ERROR, keeping the server message', () => {
    expect(() => unwrapEnvelope({ code: 4002, msg: '标题不能为空' })).toThrowError(
      expect.objectContaining({ code: 'API_ERROR', message: '标题不能为空', detail: '标题不能为空' })
    )
  })

  it('falls back to the `message` field when `msg` is absent', () => {
    expect(() => unwrapEnvelope({ code: 4002, message: 'bad request' })).toThrowError(
      expect.objectContaining({ message: 'bad request' })
    )
  })

  it('invents a message from the code when the platform sends neither msg nor message', () => {
    expect(() => unwrapEnvelope({ code: 4002 })).toThrowError(
      expect.objectContaining({ message: '接口返回 code=4002' })
    )
  })

  it('appends the request path so a failure names the call it came from', () => {
    expect(() => unwrapEnvelope({ code: 4004, msg: '文章不存在' }, '/blog-console-api/v1/article/get')).toThrowError(
      expect.objectContaining({ message: '文章不存在（/blog-console-api/v1/article/get）' })
    )
  })

  it('returns data through requestData so callers never see the envelope', async () => {
    const fake = createFakeFetch(okEnvelope({ id: 5 }))
    const { client } = makeClient(fake)

    await expect(client.requestData<{ id: number }>({ path: '/v1/x' })).resolves.toEqual({ id: 5 })
  })

  it('returns the raw envelope from request(), which is why the envelope is checked in requestData', async () => {
    const fake = createFakeFetch(apiErrorEnvelope(4004, '文章不存在'))
    const { client } = makeClient(fake)

    const envelope = await client.request<CsdnEnvelope>({ path: '/v1/x' })
    expect(envelope.code).toBe(4004)
    await expect(client.requestData({ path: '/v1/x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('does not retry an API-level rejection because the envelope is unwrapped after the retry loop', async () => {
    const fake = createFakeFetch(apiErrorEnvelope(4001, '文章频繁发布，请稍后再试'))
    const { client } = makeClient(fake)

    await expect(client.requestData({ path: '/v1/x' })).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(fake.requests).toHaveLength(1)
  })
})

describe('request HTTP status mapping', () => {
  it('maps 401 to AUTH_INVALID with the status and a truncated body snippet', async () => {
    const fake = createFakeFetch({ status: 401, body: `unauthorized ${'x'.repeat(400)}` })
    const { client } = makeClient(fake)

    let thrown: unknown
    try {
      await client.request({ path: '/v1/x' })
    } catch (error) {
      thrown = error
    }
    const error = thrown as CsdnError
    expect(error.code).toBe('AUTH_INVALID')
    expect(error.status).toBe(401)
    expect(error.message).toContain('HTTP 401')
    expect(error.detail).toHaveLength(301)
    expect(error.detail?.endsWith('…')).toBe(true)
  })

  it('maps 403 to AUTH_INVALID because CSDN answers a stale cookie with either status', async () => {
    const fake = createFakeFetch({ status: 403, body: 'forbidden' })
    const { client } = makeClient(fake)

    await expect(client.request({ path: '/v1/x' })).rejects.toMatchObject({
      code: 'AUTH_INVALID',
      status: 403,
      detail: 'forbidden',
      retryable: false
    })
  })

  it('maps 429 to RATE_LIMITED, which the retry loop treats as a wait-and-see', async () => {
    const fake = createFakeFetch({ status: 429, body: 'slow down' })
    const { client } = makeClient(fake, { maxRetries: 0 })

    await expect(client.request({ path: '/v1/x' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryable: true
    })
  })

  it('maps 500 to SERVER_ERROR', async () => {
    const fake = createFakeFetch({ status: 500, body: 'boom' })
    const { client } = makeClient(fake, { maxRetries: 0 })

    await expect(client.request({ path: '/v1/x' })).rejects.toMatchObject({
      code: 'SERVER_ERROR',
      status: 500
    })
  })

  it('maps 418 to HTTP_ERROR, since a 4xx we do not model is still a failure', async () => {
    const fake = createFakeFetch({ status: 418, body: "I'm a teapot" })
    const { client } = makeClient(fake)

    await expect(client.request({ path: '/v1/x' })).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 418,
      detail: "I'm a teapot",
      retryable: false
    })
    expect(fake.requests).toHaveLength(1)
  })

  it('treats an informational 1xx status as HTTP_ERROR, never as success', async () => {
    const fake = createFakeFetch({ status: 199, body: 'continue' })
    const { client } = makeClient(fake)

    await expect(client.request({ path: '/v1/x' })).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 199 })
  })

  it('parses the body of a 200 response', async () => {
    const fake = createFakeFetch({ status: 200, body: { code: 200, data: { ok: true } } })
    const { client } = makeClient(fake)

    await expect(client.request<CsdnEnvelope<{ ok: boolean }>>({ path: '/v1/x' })).resolves.toEqual({
      code: 200,
      data: { ok: true }
    })
  })
})

describe('request retry behaviour', () => {
  it('retries a NETWORK failure up to maxRetries and then throws that error', async () => {
    const fake = createFakeFetch(() => {
      throw new Error('socket hang up')
    })
    const { client, clock } = makeClient(fake, { maxRetries: 2 })

    await expect(client.request({ path: '/v1/x' })).rejects.toMatchObject({
      code: 'NETWORK',
      message: 'socket hang up'
    })
    expect(fake.requests).toHaveLength(3)
    expect(clock.sleeps).toEqual([500, 1_000])
  })

  it('returns the value when a NETWORK failure clears on the second attempt', async () => {
    const fake = createFakeFetch((_request, index) => {
      if (index === 0) throw new Error('ECONNRESET')
      return okEnvelope({ id: 42 })
    })
    const { client } = makeClient(fake, { maxRetries: 2 })

    await expect(client.requestData({ path: '/v1/x' })).resolves.toEqual({ id: 42 })
    expect(fake.requests).toHaveLength(2)
  })

  it('retries a SERVER_ERROR because a 5xx is usually transient', async () => {
    const fake = createFakeFetch({ status: 503, body: 'unavailable' }, okEnvelope({ id: 7 }))
    const { client, clock } = makeClient(fake, { maxRetries: 2 })

    await expect(client.requestData({ path: '/v1/x' })).resolves.toEqual({ id: 7 })
    expect(fake.requests).toHaveLength(2)
    expect(clock.sleeps).toEqual([500])
  })

  it('retries a RATE_LIMITED failure after saveIntervalMs rather than the backoff curve', async () => {
    const fake = createFakeFetch({ status: 429, body: 'too many' }, okEnvelope({ id: 8 }))
    const { client, clock } = makeClient(fake, { maxRetries: 2, saveIntervalMs: 7_777 })

    await expect(client.requestData({ path: '/v1/save' })).resolves.toEqual({ id: 8 })
    expect(clock.sleeps).toEqual([7_777])
  })

  it('does not retry a non-retryable failure, so a bad request costs exactly one call', async () => {
    const fake = createFakeFetch({ status: 400, body: 'bad request' })
    const { client, clock } = makeClient(fake, { maxRetries: 2 })

    await expect(client.request({ path: '/v1/x' })).rejects.toMatchObject({ code: 'HTTP_ERROR' })
    expect(fake.requests).toHaveLength(1)
    expect(clock.sleeps).toEqual([])
  })

  it('does not retry an auth failure, since a new attempt cannot fix a stale cookie', async () => {
    const fake = createFakeFetch({ status: 401, body: 'nope' })
    const { client } = makeClient(fake, { maxRetries: 3 })

    await expect(client.request({ path: '/v1/x' })).rejects.toMatchObject({ code: 'AUTH_INVALID' })
    expect(fake.requests).toHaveLength(1)
  })

  it('honours retries: 0 as "one attempt only", overriding the configured default', async () => {
    const fake = createFakeFetch({ status: 500, body: 'boom' })
    const { client, clock } = makeClient(fake, { maxRetries: 3 })

    await expect(client.request({ path: '/v1/x', retries: 0 })).rejects.toMatchObject({ code: 'SERVER_ERROR' })
    expect(fake.requests).toHaveLength(1)
    expect(clock.sleeps).toEqual([])
  })

  it('records one request per attempt so a caller can see how many tries it cost', async () => {
    const fake = createFakeFetch({ status: 500, body: 'boom' }, { status: 500, body: 'boom' }, okEnvelope({ ok: true }))
    const { client, clock } = makeClient(fake, { maxRetries: 2 })

    await expect(client.requestData({ path: '/v1/x' })).resolves.toEqual({ ok: true })
    expect(fake.requests).toHaveLength(3)
    expect(clock.sleeps).toEqual([500, 1_000])
  })

  it('logs the chosen delay on every retry so the wait is explainable from the log', async () => {
    const { lines, sink } = createMemorySink()
    const fake = createFakeFetch({ status: 500, body: 'boom' }, okEnvelope({ ok: true }))
    const { client } = makeClient(fake, { maxRetries: 2 }, { logger: createLogger({ level: 'debug', sink }) })

    await client.requestData({ path: '/v1/x' })
    expect(lines).toEqual(['[csdn-mcp] DEBUG retrying request path=/v1/x attempt=1 delay=500'])
  })

  it('does not sleep at all when the first attempt succeeds', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client, clock } = makeClient(fake)

    await client.requestData({ path: '/v1/x' })
    expect(fake.requests).toHaveLength(1)
    expect(clock.sleeps).toEqual([])
  })

  it('falls through to the defensive re-throw when a fractional retries count ends the loop', async () => {
    // `1 + 0.5` attempts: the loop runs twice, never satisfies `attempt === attempts - 1`,
    // and leaves the pending error for the guard after the loop.
    const fake = createFakeFetch(() => {
      throw new Error('socket hang up')
    })
    const { client, clock } = makeClient(fake, { maxRetries: 2 })

    await expect(client.request({ path: '/v1/x', retries: 0.5 })).rejects.toMatchObject({
      code: 'NETWORK',
      message: 'socket hang up'
    })
    expect(fake.requests).toHaveLength(2)
    expect(clock.sleeps).toEqual([500])
  })

  it('falls back to a generic NETWORK error when a NaN retry count means the loop never runs', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client } = makeClient(fake)

    await expect(client.request({ path: '/v1/x', retries: Number.NaN })).rejects.toMatchObject({
      code: 'NETWORK',
      message: '请求失败'
    })
    expect(fake.requests).toHaveLength(0)
  })
})

describe('request throttling', () => {
  it('honours minIntervalMs for two requests sharing a rateLimitKey', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client, clock } = makeClient(fake, { minRequestIntervalMs: 1_000 })

    await client.request({ path: '/v1/a', rateLimitKey: 'saves', minIntervalMs: 11_000 })
    await client.request({ path: '/v1/b', rateLimitKey: 'saves', minIntervalMs: 11_000 })

    expect(clock.sleeps).toEqual([11_000])
  })

  it('does not block requests to different paths, which is why the key defaults to path', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client, clock } = makeClient(fake, { minRequestIntervalMs: 1_000 })

    await client.request({ path: '/v1/a' })
    await client.request({ path: '/v1/b' })

    expect(clock.sleeps).toEqual([])
  })

  it('keys by method as well as path, so a read never delays a write to the same endpoint', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client, clock } = makeClient(fake, { minRequestIntervalMs: 1_000 })

    await client.request({ path: '/v1/x', method: 'GET' })
    await client.request({ path: '/v1/x', method: 'POST', body: { a: 1 } })

    expect(clock.sleeps).toEqual([])
  })

  it('throttles two calls to the same path using the configured default interval', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client, clock } = makeClient(fake, { minRequestIntervalMs: 250 })

    await client.request({ path: '/v1/x' })
    await client.request({ path: '/v1/x' })

    expect(clock.sleeps).toEqual([250])
  })

  it('lets a caller opt out of throttling for one request with minIntervalMs: 0', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const { client, clock } = makeClient(fake, { minRequestIntervalMs: 1_000 })

    await client.request({ path: '/v1/x', minIntervalMs: 0 })
    await client.request({ path: '/v1/x', minIntervalMs: 0 })

    expect(clock.sleeps).toEqual([])
  })
})

describe('request timeouts', () => {
  it('maps a fetch AbortError to TIMEOUT, which is what our own timeout produces', async () => {
    const abort = new Error('This operation was aborted')
    abort.name = 'AbortError'
    const fetchImpl: FetchLike = async () => {
      throw abort
    }
    const client = new CsdnHttpClient({ config: makeConfig({ maxRetries: 0 }), fetchImpl, sleep: async () => undefined })

    await expect(client.request({ path: '/v1/x', timeoutMs: 5 })).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'This operation was aborted'
    })
  })

  it('maps an undici TimeoutError to TIMEOUT as well', async () => {
    const timeout = new Error('Headers timeout')
    timeout.name = 'TimeoutError'
    const fetchImpl: FetchLike = async () => {
      throw timeout
    }
    const client = new CsdnHttpClient({ config: makeConfig({ maxRetries: 0 }), fetchImpl })

    await expect(client.request({ path: '/v1/x', timeoutMs: 5 })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('aborts the request signal when the per-attempt timeout expires', async () => {
    let signal: AbortSignal | undefined
    let release: ((response: HttpResponse) => void) | undefined
    const fetchImpl: FetchLike = async (_url, init) => {
      signal = init.signal as AbortSignal
      return new Promise<HttpResponse>((resolve) => {
        release = resolve
      })
    }
    const client = new CsdnHttpClient({ config: makeConfig({ maxRetries: 0 }), fetchImpl })

    vi.useFakeTimers()
    try {
      const pending = client.request({ path: '/v1/x', timeoutMs: 5_000 })
      // Let the throttle/grant microtasks run so the fetch (and its signal) exists.
      await vi.advanceTimersByTimeAsync(0)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(signal?.aborted).toBe(true)
      release?.({ status: 200, headers: { get: () => null }, text: async () => '{"code":200}' })
      await pending
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the abort timer once a response arrives, so a finished request cannot be aborted later', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    let signal: AbortSignal | undefined
    const fetchImpl: FetchLike = async (url, init) => {
      signal = init.signal as AbortSignal
      return fake.fetch(url, init)
    }
    const client = new CsdnHttpClient({ config: makeConfig(), fetchImpl })

    vi.useFakeTimers()
    try {
      await client.request({ path: '/v1/x', timeoutMs: 5_000 })
      vi.advanceTimersByTime(5_000)
      expect(signal?.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('request body-stream failures', () => {
  it('maps a body-stream failure to a CsdnError instead of leaking a raw error', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const fetchImpl: FetchLike = async (url, init) => {
      const response = await fake.fetch(url, init)
      return {
        ...response,
        text: async () => {
          throw new Error('terminated')
        }
      }
    }
    const client = new CsdnHttpClient({ config: makeConfig(), fetchImpl })

    await expect(client.request({ path: '/v1/x', retries: 0 })).rejects.toMatchObject({
      code: 'NETWORK',
      message: 'terminated'
    })
  })
})

describe('CsdnHttpClient.fetchText', () => {
  it('sends the browser-ish headers CSDN checks before serving a public page', async () => {
    const fake = createFakeFetch({ status: 200, body: '<html>live</html>' })
    const { client } = makeClient(fake)

    await client.fetchText('https://blog.csdn.net/bob/article/details/1')
    const headers = fake.last().headers
    expect(headers['User-Agent']).toBe(buildConfig().userAgent)
    expect(headers['Accept']).toBe('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
    expect(headers['Accept-Language']).toBe('zh-CN,zh;q=0.9,en;q=0.8')
    expect(headers['Referer']).toBe('https://blog.csdn.net/')
  })

  it('merges caller headers over the defaults', async () => {
    const fake = createFakeFetch({ status: 200, body: 'ok' })
    const { client } = makeClient(fake)

    await client.fetchText('https://blog.csdn.net/x', { headers: { Referer: 'https://custom/', 'X-Test': '1' } })
    expect(fake.last().headers['Referer']).toBe('https://custom/')
    expect(fake.last().headers['X-Test']).toBe('1')
  })

  it('returns the status, the body text and the requested url', async () => {
    const fake = createFakeFetch({ status: 201, body: '<html>ok</html>' })
    const { client } = makeClient(fake)

    await expect(client.fetchText('https://blog.csdn.net/bob/article/details/1')).resolves.toEqual({
      status: 201,
      text: '<html>ok</html>',
      finalUrl: 'https://blog.csdn.net/bob/article/details/1'
    })
  })

  it('returns a 404 body rather than throwing, because "not live yet" is a valid answer', async () => {
    const fake = createFakeFetch({ status: 404, body: 'not found' })
    const { client } = makeClient(fake)

    await expect(client.fetchText('https://blog.csdn.net/missing')).resolves.toMatchObject({
      status: 404,
      text: 'not found'
    })
  })

  it('propagates a transport failure as a CsdnError', async () => {
    const fake = createFakeFetch(() => {
      throw new Error('ENOTFOUND blog.csdn.net')
    })
    const { client } = makeClient(fake)

    await expect(client.fetchText('https://blog.csdn.net/x')).rejects.toMatchObject({
      code: 'NETWORK',
      message: 'ENOTFOUND blog.csdn.net'
    })
  })

  it('maps an aborted verification fetch to TIMEOUT', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const fake = createFakeFetch(() => {
      throw abort
    })
    const { client } = makeClient(fake)

    await expect(client.fetchText('https://blog.csdn.net/x')).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('clears its abort timer so a verification fetch leaves no pending timer behind', async () => {
    const fake = createFakeFetch({ status: 200, body: 'ok' })
    const { client } = makeClient(fake)

    vi.useFakeTimers()
    try {
      await client.fetchText('https://blog.csdn.net/x', { timeoutMs: 50 })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CsdnHttpClient constructor seams', () => {
  it('uses an injected fetchImpl instead of the global fetch', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const client = new CsdnHttpClient({ config: makeConfig(), fetchImpl: fake.fetch })

    await client.requestData({ path: '/v1/x' })
    expect(fake.requests).toHaveLength(1)
  })

  it('uses an injected rateLimiter instead of building one from sleep/now', async () => {
    const fake = createFakeFetch(okEnvelope({ ok: true }))
    const clock = makeClock()
    const limiter = new RateLimiter({ sleep: clock.sleep, now: clock.now })
    const acquire = vi.spyOn(limiter, 'acquire')
    const client = new CsdnHttpClient({
      config: makeConfig({ minRequestIntervalMs: 250 }),
      fetchImpl: fake.fetch,
      rateLimiter: limiter
    })

    await client.request({ path: '/v1/x' })
    expect(acquire).toHaveBeenCalledWith('POST /v1/x', 250)
  })

  it('uses an injected logger instead of the config-level default', async () => {
    const { lines, sink } = createMemorySink()
    const fake = createFakeFetch({ status: 500, body: 'boom' }, okEnvelope({ ok: true }))
    const client = new CsdnHttpClient({
      config: makeConfig({ logLevel: 'debug' }),
      fetchImpl: fake.fetch,
      sleep: async () => undefined,
      logger: createLogger({ level: 'debug', sink })
    })

    await client.requestData({ path: '/v1/x' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('retrying request')
  })

  it('exposes the config and logger it was built with', () => {
    const config = makeConfig()
    const client = new CsdnHttpClient({ config })

    expect(client.config).toBe(config)
    expect(client.logger.level).toBe(config.logLevel)
  })

  it('builds a default logger from config.logLevel without writing to stdout', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const client = new CsdnHttpClient({ config: makeConfig({ logLevel: 'error' }) })

    client.logger.error('hello')
    expect(stderrWrite).toHaveBeenCalledWith('[csdn-mcp] ERROR hello\n')
    stderrWrite.mockRestore()
  })
})
