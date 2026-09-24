/**
 * `ArticleClient` / `buildSaveArticleBody` unit tests.
 *
 * Every test asserts a CSDN behaviour that was learned the hard way — the
 * status code that publishes instead of saving, the capital `D` in
 * `Description`, the two success shapes of `saveArticle`. The name states the
 * behaviour; the body pins the reason.
 */

import { describe, expect, it, vi } from 'vitest'

import { buildConfig, type CsdnConfig } from '../../../src/core/config.js'
import { CsdnError } from '../../../src/core/errors.js'
import { CsdnHttpClient } from '../../../src/core/http.js'
import { createLogger, type Logger } from '../../../src/core/logger.js'
import { ArticleClient, buildSaveArticleBody } from '../../../src/csdn/article.js'
import { ARTICLE_STATE_BY_CODE, type SaveArticleInput } from '../../../src/csdn/types.js'
import {
  apiErrorEnvelope,
  createFakeFetch,
  createMemorySink,
  okEnvelope,
  openresty404,
  type ResponseScript
} from '../../helpers/fake-fetch.js'

const COOKIE = 'uuid_tt_dd=abc; UserToken=secret-token-value; UserName=alice'

/**
 * `maxRetries: 0` keeps every test to exactly the calls it scripts — retry and
 * backoff policy belongs to the transport layer and is covered by its own
 * tests. `sleep` is a no-op so the 11s write throttle never makes the suite
 * wait.
 */
function testConfig(overrides: Partial<CsdnConfig> = {}): CsdnConfig {
  return buildConfig({ cookie: COOKIE, userName: 'alice', maxRetries: 0, logLevel: 'silent', ...overrides })
}

interface Harness {
  client: ArticleClient
  http: CsdnHttpClient
  fake: ReturnType<typeof createFakeFetch>
  config: CsdnConfig
}

function setup(
  script: ResponseScript[] = [],
  options: { config?: Partial<CsdnConfig>; logger?: Logger } = {}
): Harness {
  const config = testConfig(options.config)
  const fake = createFakeFetch(...script)
  const http = new CsdnHttpClient({ config, fetchImpl: fake.fetch, sleep: () => Promise.resolve() })
  const client = new ArticleClient({ http, config, logger: options.logger })
  return { client, http, fake, config }
}

function articleInput(overrides: Partial<SaveArticleInput> = {}): SaveArticleInput {
  return {
    title: '用 MCP 发布 CSDN 文章',
    content: '<h1>用 MCP 发布 CSDN 文章</h1>',
    markdownContent: '# 用 MCP 发布 CSDN 文章',
    description: '一句话摘要',
    tags: ['MCP', 'CSDN'],
    categories: '后端',
    mode: 'draft',
    ...overrides
  }
}

/** Header lookup that is immune to the casing CSDN's client happens to use. */
function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
}

describe('buildSaveArticleBody', () => {
  it('sends status 2 and pubStatus draft for a draft', () => {
    const body = buildSaveArticleBody(articleInput({ mode: 'draft' }))
    expect(body['status']).toBe(2)
    expect(body['pubStatus']).toBe('draft')
  })

  it('sends status 1 and pubStatus publish for a publish request', () => {
    const body = buildSaveArticleBody(articleInput({ mode: 'publish' }))
    expect(body['status']).toBe(1)
    expect(body['pubStatus']).toBe('publish')
  })

  it('can never produce status 0, which CSDN now treats as an immediate publish', () => {
    const statuses = (['draft', 'publish'] as const).map(
      mode => buildSaveArticleBody(articleInput({ mode }))['status']
    )
    expect(statuses).toEqual([2, 1])
    expect(statuses).not.toContain(0)
  })

  it('capitalises Description because CSDN silently drops a lowercase description', () => {
    const body = buildSaveArticleBody(articleInput({ description: '摘要内容' }))
    expect(body['Description']).toBe('摘要内容')
    expect(body).not.toHaveProperty('description')
  })

  it('keeps a 256-character description intact because that is CSDN limit', () => {
    const description = 'x'.repeat(256)
    expect(buildSaveArticleBody(articleInput({ description }))['Description']).toBe(description)
  })

  it('truncates a 257-character description to 256 rather than failing the publish', () => {
    const description = 'x'.repeat(257)
    const clamped = buildSaveArticleBody(articleInput({ description }))['Description']
    expect(clamped).toHaveLength(256)
    expect(clamped).toBe(description.slice(0, 256))
  })

  it('joins tags into one comma-separated string and marks the article as an original Markdown post', () => {
    const body = buildSaveArticleBody(articleInput({ tags: ['MCP', 'CSDN', 'TypeScript'] }))
    expect(body).toMatchObject({
      tags: 'MCP,CSDN,TypeScript',
      type: 'original',
      authorized_status: 0,
      source: 'pc_mdeditor',
      markdowncontent: '# 用 MCP 发布 CSDN 文章',
      content: '<h1>用 MCP 发布 CSDN 文章</h1>',
      categories: '后端',
      title: '用 MCP 发布 CSDN 文章'
    })
  })

  it('sends an empty id when creating because CSDN decides create vs update from the id', () => {
    expect(buildSaveArticleBody(articleInput())['id']).toBe('')
  })

  it('sends the existing id when updating an article', () => {
    expect(buildSaveArticleBody(articleInput({ id: '123' }))['id']).toBe('123')
  })

  it('adds cover_images and cover_type 1 only when a cover exists', () => {
    const body = buildSaveArticleBody(articleInput({ coverImages: ['https://img/x.png'] }))
    expect(body['cover_images']).toEqual(['https://img/x.png'])
    expect(body['cover_type']).toBe(1)
  })

  it('omits the cover fields entirely when there is no cover', () => {
    const body = buildSaveArticleBody(articleInput())
    expect(body).not.toHaveProperty('cover_images')
    expect(body).not.toHaveProperty('cover_type')
  })

  it('ignores an empty cover entry so a cleared cover does not become cover_type 1', () => {
    const body = buildSaveArticleBody(articleInput({ coverImages: [''] }))
    expect(body).not.toHaveProperty('cover_images')
    expect(body).not.toHaveProperty('cover_type')
  })
})

describe('ArticleClient.save', () => {
  it('posts the draft to saveArticle and returns the id and URL CSDN created', async () => {
    const { client, fake, config } = setup([
      okEnvelope({
        id: '1042',
        url: 'https://blog.csdn.net/alice/article/details/1042',
        qrcode: 'https://csdn.net/q.png'
      })
    ])

    const result = await client.save(articleInput())

    const request = fake.last()
    expect(request.method).toBe('POST')
    expect(request.url).toBe(`${config.apiBase}/blog-console-api/v3/mdeditor/saveArticle`)
    expect(request.json).toMatchObject({ id: '', status: 2, pubStatus: 'draft', Description: '一句话摘要' })
    expect(result).toEqual({
      id: '1042',
      url: 'https://blog.csdn.net/alice/article/details/1042',
      raw: {
        id: '1042',
        url: 'https://blog.csdn.net/alice/article/details/1042',
        qrcode: 'https://csdn.net/q.png'
      }
    })
  })

  it('normalises a numeric id and rebuilds the URL when CSDN omits it from the create response', async () => {
    const { client } = setup([okEnvelope({ id: 1042 })])

    const result = await client.save(articleInput())

    expect(result.id).toBe('1042')
    expect(result.url).toBe('https://blog.csdn.net/alice/article/details/1042')
  })

  it('falls back to the id we sent and a rebuilt URL when an update answers with 成功', async () => {
    const { client } = setup([okEnvelope('成功')])

    const result = await client.save(articleInput({ id: '123' }))

    expect(result).toEqual({
      id: '123',
      url: 'https://blog.csdn.net/alice/article/details/123',
      raw: { data: '成功' }
    })
  })

  it('uses the configured blog base when rebuilding a URL, so a mirror origin is honoured', async () => {
    const { client } = setup([okEnvelope('成功')], { config: { blogBase: 'https://mirror.example' } })

    const result = await client.save(articleInput({ id: '123' }))

    expect(result.url).toBe('https://mirror.example/alice/article/details/123')
  })

  it('refuses to report success when a create answers 成功 without any id', async () => {
    const { client } = setup([okEnvelope('成功')])

    await expect(client.save(articleInput())).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('refuses to report success when the envelope carries no data at all', async () => {
    const { client } = setup([{ status: 200, body: { code: 200 } }])

    await expect(client.save(articleInput())).rejects.toBeInstanceOf(CsdnError)
    await expect(client.save(articleInput())).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('throttles saves on the saveArticle key with the configured interval because CSDN rejects rapid saves', async () => {
    const { client, http, config } = setup([
      okEnvelope({ id: '1042', url: 'https://blog.csdn.net/alice/article/details/1042' })
    ])
    const spy = vi.spyOn(http, 'request')

    await client.save(articleInput())

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      rateLimitKey: 'saveArticle',
      minIntervalMs: config.saveIntervalMs
    })
  })

  it('surfaces a publish-frequency rejection as RATE_LIMITED because HTTP 200 can still be a failure', async () => {
    const { client } = setup([apiErrorEnvelope(1, '文章频繁发布，请稍后再试')])

    await expect(client.save(articleInput())).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  })

  it('surfaces an HTTP 401 as AUTH_INVALID because the cookie has expired', async () => {
    const { client } = setup([{ status: 401, body: 'Unauthorized' }])

    await expect(client.save(articleInput())).rejects.toMatchObject({ code: 'AUTH_INVALID', status: 401 })
  })

  it('surfaces the openresty 404 page as MALFORMED_RESPONSE because a dead endpoint answers 200 with HTML', async () => {
    const { client } = setup([openresty404()])

    await expect(client.save(articleInput())).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('logs the save intent without leaking the cookie', async () => {
    const { lines, sink } = createMemorySink()
    const logger = createLogger({ level: 'debug', sink })
    const { client } = setup([okEnvelope({ id: '1042' })], { logger })

    await client.save(articleInput({ mode: 'publish' }))

    expect(lines.some(line => line.includes('saving article') && line.includes('mode=publish'))).toBe(true)
    expect(lines.join('\n')).not.toContain('secret-token-value')
  })
})

describe('ArticleClient.get', () => {
  it('requests getArticle with the id as a query parameter', async () => {
    const { client, fake, config } = setup([okEnvelope({ article_id: '1042', title: '标题' })])

    await client.get('1042')

    const request = fake.last()
    expect(request.method).toBe('GET')
    expect(request.url).toBe(`${config.apiBase}/blog-console-api/v1/editor/getArticle?id=1042`)
  })

  it('maps the full console record, including the capitalised Description and the comma-joined tags', async () => {
    const { client } = setup([
      okEnvelope({
        article_id: '1042',
        title: '用 MCP 发布 CSDN 文章',
        markdowncontent: '# 用 MCP 发布 CSDN 文章',
        content: '<h1>用 MCP 发布 CSDN 文章</h1>',
        Description: '摘要',
        tags: 'MCP, CSDN,,',
        categories: '后端',
        status: 2,
        reason: '',
        // A stray non-string and a cleared entry must not reach the caller.
        cover_images: ['https://img/cover.png', '', 42],
        postTime: '2026-09-24 08:00:00',
        viewCount: 42,
        readCount: 7
      })
    ])

    const detail = await client.get('1042')

    expect(detail).toMatchObject({
      id: '1042',
      title: '用 MCP 发布 CSDN 文章',
      state: 'draft',
      statusCode: 2,
      reason: '',
      description: '摘要',
      tags: ['MCP', 'CSDN'],
      categories: '后端',
      markdownContent: '# 用 MCP 发布 CSDN 文章',
      htmlContent: '<h1>用 MCP 发布 CSDN 文章</h1>',
      coverImages: ['https://img/cover.png'],
      url: 'https://blog.csdn.net/alice/article/details/1042',
      postTime: '2026-09-24 08:00:00',
      viewCount: 42
    })
  })

  it('maps every status code in ARTICLE_STATE_BY_CODE', async () => {
    for (const [code, state] of Object.entries(ARTICLE_STATE_BY_CODE)) {
      const { client } = setup([okEnvelope({ article_id: '1042', status: Number(code) })])
      await expect(client.get('1042')).resolves.toMatchObject({ state, statusCode: Number(code) })
    }
  })

  it('maps an unmapped status code to unknown instead of guessing published', async () => {
    const { client } = setup([okEnvelope({ article_id: '1042', status: 99 })])

    await expect(client.get('1042')).resolves.toMatchObject({ state: 'unknown', statusCode: 99 })
  })

  it('parses a quoted status code because some console responses stringify it', async () => {
    const { client } = setup([okEnvelope({ article_id: '1042', status: '2' })])

    await expect(client.get('1042')).resolves.toMatchObject({ state: 'draft', statusCode: 2 })
  })

  it('maps an unparseable status string to unknown with statusCode -1', async () => {
    const { client } = setup([okEnvelope({ article_id: '1042', status: '审核中' })])

    await expect(client.get('1042')).resolves.toMatchObject({ state: 'unknown', statusCode: -1 })
  })

  it('maps a missing status to unknown rather than falling through to published', async () => {
    const { client } = setup([okEnvelope({ article_id: '1042', title: '没有状态' })])

    await expect(client.get('1042')).resolves.toMatchObject({ state: 'unknown', statusCode: -1 })
  })

  it('reads the id from the payload because getArticle names the field article_id', async () => {
    const { client } = setup([okEnvelope({ article_id: '999', title: '另一篇' })])

    await expect(client.get('123')).resolves.toMatchObject({
      id: '999',
      url: 'https://blog.csdn.net/alice/article/details/999'
    })
  })

  it('accepts the bare id field that older responses carry', async () => {
    const { client } = setup([okEnvelope({ id: '777', title: '老响应' })])

    await expect(client.get('123')).resolves.toMatchObject({ id: '777' })
  })

  it('degrades a non-object payload to empty fields while keeping the requested id', async () => {
    const { client } = setup([okEnvelope('')])

    await expect(client.get('123')).resolves.toMatchObject({
      id: '123',
      state: 'unknown',
      statusCode: -1,
      title: '',
      tags: [],
      coverImages: [],
      viewCount: 0,
      url: 'https://blog.csdn.net/alice/article/details/123'
    })
  })

  it('surfaces a non-empty moderation reason verbatim', async () => {
    const { client } = setup([
      okEnvelope({ article_id: '1042', status: 6, reason: '文章含违规推广内容，已下架' })
    ])

    await expect(client.get('1042')).resolves.toMatchObject({
      state: 'rejected',
      reason: '文章含违规推广内容，已下架'
    })
  })

  it('returns an empty reason for a clean article', async () => {
    const { client } = setup([okEnvelope({ article_id: '1042', status: 1 })])

    await expect(client.get('1042')).resolves.toMatchObject({ state: 'published', reason: '' })
  })

  it('returns an empty tag list when the payload has no tags field', async () => {
    const { client } = setup([okEnvelope({ article_id: '1042', status: 1 })])

    await expect(client.get('1042')).resolves.toMatchObject({ tags: [] })
  })

  it('falls back to readCount when a legacy payload has no viewCount', async () => {
    const { client } = setup([okEnvelope({ article_id: '1042', status: 1, readCount: 7 })])

    await expect(client.get('1042')).resolves.toMatchObject({ viewCount: 7 })
  })

  it('keeps a real viewCount of 0 instead of falling back to readCount', async () => {
    const { client } = setup([okEnvelope({ article_id: '1042', status: 1, viewCount: 0, readCount: 7 })])

    await expect(client.get('1042')).resolves.toMatchObject({ viewCount: 0 })
  })

  it('surfaces an article that no longer exists as NOT_FOUND', async () => {
    const { client } = setup([apiErrorEnvelope(4004, '文章不存在')])

    await expect(client.get('1042')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects an empty article id before making any request', async () => {
    const { client, fake } = setup([okEnvelope({ article_id: '1042' })])

    await expect(client.get('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(fake.requests).toHaveLength(0)
  })

  it('rejects a whitespace-only article id before making any request', async () => {
    const { client, fake } = setup([okEnvelope({ article_id: '1042' })])

    await expect(client.get('   ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(fake.requests).toHaveLength(0)
  })
})

describe('ArticleClient.list', () => {
  it('defaults to page 1 and pageSize 20 against the public community API', async () => {
    const { client, fake, config } = setup([
      okEnvelope({
        list: [
          {
            articleId: '1042',
            title: '文章一',
            url: 'https://blog.csdn.net/alice/article/details/1042',
            description: '摘要一',
            tags: 'MCP,CSDN',
            postTime: '2026-09-24 08:00:00',
            viewCount: 120,
            diggCount: 3,
            collectCount: 2,
            commentCount: 1
          }
        ],
        total: 1
      })
    ])

    const page = await client.list()

    const request = fake.last()
    expect(request.method).toBe('GET')
    expect(request.url).toBe(
      `${config.communityBase}/community/home-api/v1/get-business-list` +
        '?page=1&size=20&businessType=blog&username=alice'
    )
    expect(page).toMatchObject({ page: 1, pageSize: 20, total: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      id: '1042',
      title: '文章一',
      url: 'https://blog.csdn.net/alice/article/details/1042',
      description: '摘要一',
      tags: ['MCP', 'CSDN'],
      postTime: '2026-09-24 08:00:00',
      viewCount: 120,
      diggCount: 3,
      collectCount: 2,
      commentCount: 1
    })
  })

  it('sends neither a Cookie nor a signature because the community list is public', async () => {
    const { client, fake } = setup([okEnvelope({ list: [], total: 0 })])

    await client.list()

    const headers = lowerHeaders(fake.last().headers)
    expect(headers).not.toHaveProperty('cookie')
    expect(Object.keys(headers).filter(name => name.startsWith('x-ca-'))).toEqual([])
    expect(headers['user-agent']).toContain('Mozilla')
  })

  it('honours an explicit page and the 100 upper bound for pageSize', async () => {
    const { client, fake } = setup([okEnvelope({ list: [], total: 0 })])

    const page = await client.list({ page: 3, pageSize: 100 })

    expect(fake.last().url).toContain('page=3&size=100')
    expect(page).toMatchObject({ page: 3, pageSize: 100 })
  })

  it('rejects page 0 because CSDN pages are 1-based', async () => {
    const { client, fake } = setup([okEnvelope({ list: [], total: 0 })])

    await expect(client.list({ page: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(fake.requests).toHaveLength(0)
  })

  it('rejects pageSize outside 1..100 because CSDN clamps silently past that range', async () => {
    const { client, fake } = setup([okEnvelope({ list: [], total: 0 })])

    await expect(client.list({ pageSize: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(client.list({ pageSize: 101 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(fake.requests).toHaveLength(0)
  })

  it('returns an empty page when the account has published nothing', async () => {
    const { client } = setup([okEnvelope(null)])

    await expect(client.list()).resolves.toEqual({ items: [], page: 1, pageSize: 20, total: 0 })
  })

  it('surfaces a community API error envelope as API_ERROR', async () => {
    const { client } = setup([apiErrorEnvelope(10002, '系统繁忙')])

    await expect(client.list()).rejects.toMatchObject({ code: 'API_ERROR' })
  })
})

describe('ArticleClient.remove', () => {
  it('moves an article to the recycle bin when permanent is not requested', async () => {
    const { client, fake, config } = setup([okEnvelope(null)])

    const result = await client.remove('1042')

    const request = fake.last()
    expect(request.method).toBe('POST')
    expect(request.url).toBe(`${config.apiBase}/blog/phoenix/console/v1/article/del`)
    expect(request.json).toEqual({ articleId: '1042', deep: false })
    expect(result).toEqual({ articleId: '1042', permanent: false })
  })

  it('sends deep true when permanent is requested', async () => {
    const { client, fake } = setup([okEnvelope(null)])

    const result = await client.remove('1042', true)

    expect(fake.last().json).toEqual({ articleId: '1042', deep: true })
    expect(result).toEqual({ articleId: '1042', permanent: true })
  })

  it('only deletes permanently for an explicit true, so a truthy string cannot destroy an article', async () => {
    const { client, fake } = setup([okEnvelope(null)])

    // An untyped MCP tool argument can arrive as the string 'true'.
    await client.remove('1042', 'true' as unknown as boolean)

    expect(fake.last().json).toEqual({ articleId: '1042', deep: false })
  })

  it('throttles deletes on the saveArticle key because CSDN counts both as writes', async () => {
    const { client, http, config } = setup([okEnvelope(null)])
    const spy = vi.spyOn(http, 'request')

    await client.remove('1042', true)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      rateLimitKey: 'saveArticle',
      minIntervalMs: config.saveIntervalMs
    })
  })

  it('surfaces an already-deleted article as NOT_FOUND instead of reporting success', async () => {
    const { client } = setup([apiErrorEnvelope(4004, '文章不存在')])

    await expect(client.remove('1042')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects an empty article id before making any request', async () => {
    const { client, fake } = setup([okEnvelope(null)])

    await expect(client.remove('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(fake.requests).toHaveLength(0)
  })
})
