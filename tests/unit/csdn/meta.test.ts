/**
 * MetaClient tests.
 *
 * Every endpoint exercised here was verified against the live API (see
 * docs/reverse-engineering.md); the fake fetch stands in for the transport, not
 * for the request shape — the real `CsdnHttpClient` builds the URL, method,
 * body and `Content-Type`, so a wrong method or a wrong content type fails here.
 */

import { describe, expect, it } from 'vitest'
import { buildConfig, type CsdnConfig } from '../../../src/core/config.js'
import { CsdnHttpClient } from '../../../src/core/http.js'
import { createLogger } from '../../../src/core/logger.js'
import { BUILTIN_CATEGORIES, COMMON_TAGS, MetaClient } from '../../../src/csdn/meta.js'
import {
  apiErrorEnvelope,
  createFakeFetch,
  createMemorySink,
  okEnvelope,
  openresty404,
  type FakeFetch
} from '../../helpers/fake-fetch.js'

const AUTHOR_INFO = '/blog-console-api/v1/editor/getBaseInfo'
const AUTHOR_CRITERIA = '/blog-console-api/v1/article/getQueryCriteriaNew'
const PLATFORM_CATEGORY = '/blog/phoenix/console/v1/category/get-list'
const RECOMMEND_TAGS = '/blog/phoenix/console/v1/tag/get-recommend-tags'

const COOKIE = 'UserToken=abcdef123456; UserName=Leaderxin'

function makeConfig(overrides: Partial<CsdnConfig> = {}): CsdnConfig {
  // minRequestIntervalMs 0: throttling is http.ts's contract, not this module's.
  return buildConfig({ cookie: COOKIE, minRequestIntervalMs: 0, ...overrides })
}

/** A real client over a scripted fetch, so request construction is exercised. */
function makeClient(
  fake: FakeFetch,
  config: Partial<CsdnConfig> = {},
  logger = undefined as undefined | ReturnType<typeof createLogger>
): MetaClient {
  const resolved = makeConfig(config)
  const http = new CsdnHttpClient({
    config: resolved,
    fetchImpl: fake.fetch,
    sleep: async () => undefined,
    now: () => 0
  })
  return new MetaClient({ http, config: resolved, ...(logger === undefined ? {} : { logger }) })
}

describe('MetaClient.listCategories', () => {
  it("returns the author's own columns from editor/getBaseInfo as source api", async () => {
    const fake = createFakeFetch(okEnvelope({ categorys: ['前端', '项目笔记'] }))
    const result = await makeClient(fake).listCategories()

    expect(result).toEqual({ items: ['前端', '项目笔记'], source: 'api' })
    expect(fake.requests).toHaveLength(1)
    expect(fake.last().url).toBe(`https://bizapi.csdn.net${AUTHOR_INFO}`)
    expect(fake.last().method).toBe('GET')
  })

  it('falls through to getQueryCriteriaNew column titles when getBaseInfo is dead', async () => {
    // v0's endpoint rotted exactly like this: HTTP 200 carrying the openresty
    // 404 page, which parses as "not JSON" and must not abort the whole call.
    const fake = createFakeFetch(
      openresty404(),
      okEnvelope({
        column: [
          { id: 1, title: '算法' },
          { id: 2, title: 'Redis缓存' }
        ]
      })
    )
    const result = await makeClient(fake).listCategories()

    expect(result).toEqual({ items: ['算法', 'Redis缓存'], source: 'api' })
    expect(fake.requests.map(request => request.url)).toEqual([
      `https://bizapi.csdn.net${AUTHOR_INFO}`,
      `https://bizapi.csdn.net${AUTHOR_CRITERIA}`
    ])
  })

  it('falls through to the platform taxonomy when both author endpoints answer with an empty list', async () => {
    const fake = createFakeFetch(
      okEnvelope({ categorys: [] }),
      apiErrorEnvelope(400, '参数错误'),
      okEnvelope([
        {
          categoryId: 7000,
          categoryName: '大数据/云计算',
          childList: [{ categoryId: 7012, categoryName: 'Flink' }]
        }
      ])
    )
    const result = await makeClient(fake).listCategories()

    expect(result).toEqual({ items: ['大数据/云计算', 'Flink'], source: 'api' })
    expect(fake.requests.at(-1)?.url).toBe(`https://bizapi.csdn.net${PLATFORM_CATEGORY}`)
  })

  it('flattens platform children and ignores non-object nodes and duplicate names', async () => {
    const fake = createFakeFetch(
      okEnvelope({}),
      okEnvelope({}),
      okEnvelope([
        null,
        'not-a-node',
        [],
        { categoryName: '前端', childList: [{ categoryName: 'Vue' }, { categoryName: 'Vue' }, 'nope', null] },
        { categoryName: '前端', childList: [] },
        { categoryName: '  后端  ', childList: undefined },
        { childList: [{ categoryName: 'Java' }] }
      ])
    )
    const result = await makeClient(fake).listCategories()

    // `null`, a bare string, an array and two duplicate names are all dropped or
    // de-duplicated; a missing `childList` simply contributes nothing.
    expect(result).toEqual({ items: ['前端', 'Vue', '后端', 'Java'], source: 'api' })
  })

  it('returns the builtin list with source builtin when every candidate fails', async () => {
    const fake = createFakeFetch(() => openresty404())
    const result = await makeClient(fake).listCategories()

    expect(result.source).toBe('builtin')
    expect(result.items).toEqual(BUILTIN_CATEGORIES)
    expect(fake.requests).toHaveLength(3)
  })

  it('hands back a copy of the builtin list so a caller cannot mutate the constant', async () => {
    const fake = createFakeFetch(() => openresty404())
    const first = await makeClient(fake).listCategories()
    first.items.push('mutated')

    const second = await makeClient(createFakeFetch(() => openresty404())).listCategories()
    expect(second.items).not.toContain('mutated')
    expect(BUILTIN_CATEGORIES).not.toContain('mutated')
  })

  it('degrades to the builtin list when CSDN rejects the cookie with AUTH_INVALID', async () => {
    const fake = createFakeFetch({ status: 401, body: 'unauthorized' })
    const result = await makeClient(fake).listCategories()

    expect(result.source).toBe('builtin')
    expect(result.items).toEqual(BUILTIN_CATEGORIES)
  })

  it('degrades to the builtin list when the envelope carries an auth code with HTTP 200', async () => {
    const fake = createFakeFetch(apiErrorEnvelope(700, '登录已过期'))
    const result = await makeClient(fake).listCategories()

    expect(result.source).toBe('builtin')
  })

  it('degrades to the builtin list when the payload is malformed rather than throwing', async () => {
    const fake = createFakeFetch(
      okEnvelope(null),
      okEnvelope({ categorys: '前端,后端' }),
      okEnvelope({ items: ['前端'] })
    )
    const result = await makeClient(fake).listCategories()

    expect(result).toEqual({ items: BUILTIN_CATEGORIES, source: 'builtin' })
  })

  it('trims names, drops blanks and non-strings, and keeps the first occurrence order', async () => {
    const fake = createFakeFetch(
      okEnvelope({ categorys: ['  前端  ', '前端', '', '   ', 42, null, ['x'], '后端'] })
    )
    const result = await makeClient(fake).listCategories()

    expect(result.items).toEqual(['前端', '后端'])
    expect(fake.requests).toHaveLength(1)
  })

  it('never throws when the transport fails with a plain Error', async () => {
    const http = {
      requestData: () => Promise.reject(new Error('socket hang up'))
    } as unknown as CsdnHttpClient
    const result = await new MetaClient({ http, config: makeConfig() }).listCategories()

    expect(result.source).toBe('builtin')
  })

  it('never throws when the transport rejects with a non-Error value', async () => {
    const http = {
      // Deliberate: this is what a misbehaving transport produces, and the
      // module must still answer with a list rather than propagating it.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      requestData: () => Promise.reject('boom')
    } as unknown as CsdnHttpClient
    const result = await new MetaClient({ http, config: makeConfig() }).listCategories()

    expect(result.source).toBe('builtin')
  })

  it('logs the failed endpoint at debug level and never logs the cookie', async () => {
    const { lines, sink } = createMemorySink()
    const logger = createLogger({ level: 'debug', sink })
    const fake = createFakeFetch(() => openresty404())

    await makeClient(fake, {}, logger).listCategories()

    expect(lines.some(line => line.includes('metadata endpoint failed') && line.includes(AUTHOR_INFO))).toBe(
      true
    )
    expect(lines.some(line => line.includes('falling back to builtin metadata'))).toBe(true)
    expect(lines.join('\n')).not.toContain('abcdef123456')
  })
})

describe('MetaClient.listTags', () => {
  it('POSTs an empty body to tag/get-recommend-tags with the console content type', async () => {
    const fake = createFakeFetch(okEnvelope({ common: ['Vue3'], list: {} }))
    const result = await makeClient(fake).listTags()

    expect(result).toEqual({ items: ['Vue3'], source: 'api' })
    expect(fake.last().method).toBe('POST')
    expect(fake.last().url).toBe(`https://bizapi.csdn.net${RECOMMEND_TAGS}`)
    // The gateway signs the Content-Type it sees, and CSDN's own console sends
    // this exact value — a charset suffix would change the signed string.
    expect(fake.last().headers['Content-Type']).toBe('application/json;')
    expect(fake.last().json).toEqual({})
  })

  it('returns the personalised common tags first, then the grouped dictionary without duplicates', async () => {
    const fake = createFakeFetch(
      okEnvelope({
        common: ['Vue3', '深色模式', 'Vue3'],
        list: { 推荐: [], 前端: ['vue', 'css'], Python: ['python', 'vue'], 空组: [] },
        images: ['https://i-blog.csdnimg.cn/direct/x.jpg']
      })
    )
    const result = await makeClient(fake).listTags()

    expect(result.items).toEqual(['Vue3', '深色模式', 'vue', 'css', 'python'])
    expect(result.source).toBe('api')
  })

  it('returns only the common tags when the payload has no grouped dictionary', async () => {
    const fake = createFakeFetch(okEnvelope({ common: ['Vue3', '前端工程化'] }))
    const result = await makeClient(fake).listTags()

    expect(result.items).toEqual(['Vue3', '前端工程化'])
  })

  it('falls back to the builtin tags when data is an array instead of the expected object', async () => {
    const fake = createFakeFetch(okEnvelope([]))
    const result = await makeClient(fake).listTags()

    expect(result).toEqual({ items: COMMON_TAGS, source: 'builtin' })
  })

  it('falls back to the builtin tags when the api answers with nothing usable', async () => {
    const fake = createFakeFetch(okEnvelope({ common: [1, 2, '   ', null], list: { 推荐: [], 前端: [] } }))
    const result = await makeClient(fake).listTags()

    expect(result).toEqual({ items: COMMON_TAGS, source: 'builtin' })
  })

  it('falls back to the builtin tags when the endpoint is dead', async () => {
    const fake = createFakeFetch(openresty404())
    const result = await makeClient(fake).listTags()

    expect(result).toEqual({ items: COMMON_TAGS, source: 'builtin' })
    expect(fake.requests).toHaveLength(1)
  })
})
