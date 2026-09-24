/**
 * verifyArticle tests.
 *
 * The point of this module is that an HTTP 200 from `saveArticle` proves nothing,
 * so these tests pin the two-signal verdict: what the console API says AND what
 * the public page says, plus the honest "I could not tell" cases.
 */

import { describe, expect, it, vi } from 'vitest'
import { buildConfig, type CsdnConfig } from '../../../src/core/config.js'
import type { CsdnHttpClient } from '../../../src/core/http.js'
import type { ArticleClient } from '../../../src/csdn/article.js'
import { articleUrl, type ArticleDetail } from '../../../src/csdn/types.js'
import { verifyArticle, type VerifyArticleDeps } from '../../../src/csdn/verify.js'

const USER = 'Leaderxin'
const ARTICLE_ID = '166581085'
const FIXED_NOW = 1_700_000_000_000

function makeConfig(overrides: Partial<CsdnConfig> = {}): CsdnConfig {
  return buildConfig({ userName: USER, ...overrides })
}

function makeDetail(overrides: Partial<ArticleDetail> = {}): ArticleDetail {
  return {
    id: ARTICLE_ID,
    title: '标题',
    state: 'draft',
    statusCode: 2,
    reason: '',
    description: '',
    tags: [],
    categories: '',
    markdownContent: '',
    htmlContent: '',
    coverImages: [],
    url: articleUrl(USER, ARTICLE_ID),
    postTime: '',
    viewCount: 0,
    raw: {},
    ...overrides
  }
}

interface Harness {
  deps: VerifyArticleDeps
  get: ReturnType<typeof vi.fn>
  fetchText: ReturnType<typeof vi.fn>
  sleeps: number[]
  urls: () => string[]
}

interface HarnessOptions {
  detail?: Partial<ArticleDetail>
  /** One entry per public-page attempt; the last one repeats if exhausted. */
  statuses?: number[]
  now?: number
  publicRetries?: number
  retryDelayMs?: number
  /** Build deps with only the three contract fields, exercising the defaults. */
  minimal?: boolean
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const detail = makeDetail(options.detail)
  const statuses = options.statuses ?? [404]
  const sleeps: number[] = []
  let attempt = 0

  const get = vi.fn(async (_articleId: string) => detail)
  const fetchText = vi.fn(async (url: string) => {
    const status = statuses[Math.min(attempt, statuses.length - 1)] ?? 0
    attempt += 1
    return { status, text: '', finalUrl: url }
  })

  const articles = { get } as unknown as ArticleClient
  const http = { fetchText } as unknown as CsdnHttpClient
  const config = makeConfig()

  const deps: VerifyArticleDeps = options.minimal
    ? { articles, http, config }
    : {
        articles,
        http,
        config,
        sleep: async (ms: number) => {
          // No real waiting: the delay is recorded instead.
          sleeps.push(ms)
        },
        now: () => options.now ?? FIXED_NOW,
        ...(options.publicRetries === undefined ? {} : { publicRetries: options.publicRetries }),
        ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs })
      }

  return {
    deps,
    get,
    fetchText,
    sleeps,
    urls: () => fetchText.mock.calls.map(call => String(call[0]))
  }
}

describe('verifyArticle consistency table', () => {
  it('confirms a draft when the API says draft and the public page is 404', async () => {
    const harness = makeHarness({ detail: { state: 'draft', statusCode: 2 }, statuses: [404] })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'draft')

    expect(result).toEqual({
      articleId: ARTICLE_ID,
      state: 'draft',
      statusCode: 2,
      publicStatusCode: 404,
      consistent: true,
      message: '草稿已确认：接口 status=2，公开页 404'
    })
    expect(harness.get).toHaveBeenCalledWith(ARTICLE_ID)
    expect(harness.fetchText).toHaveBeenCalledTimes(1)
  })

  it('flags a draft whose public page is already visible', async () => {
    const harness = makeHarness({ detail: { state: 'draft', statusCode: 2 }, statuses: [200] })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'draft')

    expect(result.consistent).toBe(false)
    expect(result.publicStatusCode).toBe(200)
    expect(result.message).toContain('应为 404')
    expect(result.message).toContain('公开页返回 200')
  })

  it('reports that a draft request was not honoured when the API shows the article is published', async () => {
    const harness = makeHarness({ detail: { state: 'published', statusCode: 0 }, statuses: [200] })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'draft')

    expect(result.consistent).toBe(false)
    expect(result.state).toBe('published')
    expect(result.message).toContain('草稿未被接受')
    expect(result.message).toContain('status=0')
    expect(result.message).toContain('已发布')
  })

  it('names the in-flight state when a draft request came back as reviewing', async () => {
    const harness = makeHarness({ detail: { state: 'reviewing', statusCode: 16 }, statuses: [404] })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'draft')

    expect(result.consistent).toBe(false)
    expect(result.message).toContain('审核中')
  })

  it('confirms a publish when the API says published and the public page is 200', async () => {
    const harness = makeHarness({ detail: { state: 'published', statusCode: 1 }, statuses: [200] })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'publish')

    expect(result).toEqual({
      articleId: ARTICLE_ID,
      state: 'published',
      statusCode: 1,
      publicStatusCode: 200,
      consistent: true,
      message: '发布已确认：接口 status=1，公开页 200'
    })
  })

  it('accepts reviewing as consistent for a publish because the article is in flight', async () => {
    const harness = makeHarness({ detail: { state: 'reviewing', statusCode: 16 }, statuses: [404] })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'publish')

    expect(result.consistent).toBe(true)
    expect(result.message).toContain('已提交审核')
    expect(result.message).toContain('status=16')
    expect(result.message).toContain('公开页 404 属正常')
  })

  it('refuses to confirm a publish that CSDN left as a draft', async () => {
    const harness = makeHarness({ detail: { state: 'draft', statusCode: 2 }, statuses: [404] })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'publish')

    expect(result.consistent).toBe(false)
    expect(result.message).toContain('CSDN 未接受发布')
    expect(result.message).toContain('status=2')
    expect(result.message).toContain('仍为草稿')
  })

  it('refuses to confirm a publish whose public page still answers 404', async () => {
    const harness = makeHarness({ detail: { state: 'published', statusCode: 1 }, statuses: [404] })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'publish')

    expect(result.consistent).toBe(false)
    expect(result.publicStatusCode).toBe(404)
    expect(result.message).toContain('接口显示已发布')
    expect(result.message).toContain('应为 200')
  })

  it('never confirms a rejected article and quotes the moderation reason', async () => {
    const harness = makeHarness({
      detail: { state: 'rejected', statusCode: 6, reason: '内容涉嫌抄袭' },
      statuses: [404]
    })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'publish')

    expect(result.consistent).toBe(false)
    expect(result.state).toBe('rejected')
    expect(result.message).toContain('审核拒绝')
    expect(result.message).toContain('status=6')
    expect(result.message).toContain('内容涉嫌抄袭')
  })

  it('says so when a rejection carries no reason', async () => {
    const harness = makeHarness({
      detail: { state: 'rejected', statusCode: 6, reason: '   ' },
      statuses: [404]
    })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'draft')

    expect(result.consistent).toBe(false)
    expect(result.message).toContain('CSDN 未给出原因')
  })

  it('names the raw status code when the state cannot be mapped', async () => {
    const harness = makeHarness({ detail: { state: 'unknown', statusCode: 99 }, statuses: [404] })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'publish')

    expect(result.consistent).toBe(false)
    expect(result.state).toBe('unknown')
    expect(result.message).toContain('status=99')
    expect(result.message).toContain('无法识别')
  })
})

describe('verifyArticle public-page retry', () => {
  it('retries after a 521 and reports the state it recovered', async () => {
    const harness = makeHarness({ detail: { state: 'published', statusCode: 1 }, statuses: [521, 200] })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'publish')

    expect(harness.fetchText).toHaveBeenCalledTimes(2)
    expect(harness.sleeps).toEqual([3000])
    expect(result.consistent).toBe(true)
    expect(result.publicStatusCode).toBe(200)
  })

  it('gives up after the configured attempts and reports the 521 it actually saw', async () => {
    const harness = makeHarness({ detail: { state: 'published', statusCode: 1 }, statuses: [521] })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'publish')

    expect(harness.fetchText).toHaveBeenCalledTimes(3)
    expect(harness.sleeps).toEqual([3000, 3000])
    expect(result.publicStatusCode).toBe(521)
    expect(result.consistent).toBe(false)
    expect(result.message).toContain('521')
    expect(result.message).toContain('重试 3 次')
    expect(result.message).toContain('公开页结论不可用')
  })

  it('does not retry a definitive public status', async () => {
    const harness = makeHarness({ detail: { state: 'published', statusCode: 1 }, statuses: [403] })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'publish')

    expect(harness.fetchText).toHaveBeenCalledTimes(1)
    expect(harness.sleeps).toEqual([])
    expect(result.publicStatusCode).toBe(403)
  })

  it('stops immediately when retries are disabled', async () => {
    const harness = makeHarness({ statuses: [521], publicRetries: 0 })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'draft')

    expect(harness.fetchText).toHaveBeenCalledTimes(1)
    expect(harness.sleeps).toEqual([])
    expect(result.message).toContain('重试 1 次')
  })

  it('honours a custom retry delay', async () => {
    const harness = makeHarness({ statuses: [521, 404], retryDelayMs: 250 })
    await verifyArticle(harness.deps, ARTICLE_ID, 'draft')

    expect(harness.sleeps).toEqual([250])
  })
})

describe('verifyArticle public URL', () => {
  it('sends a cache-busting spm parameter built from the clock', async () => {
    const harness = makeHarness({ statuses: [404], now: FIXED_NOW })
    await verifyArticle(harness.deps, ARTICLE_ID, 'draft')

    expect(harness.urls()).toEqual([`${articleUrl(USER, ARTICLE_ID)}?spm=cb${FIXED_NOW}`])
  })

  it('renews the cache buster on every attempt so a cached page cannot be reused', async () => {
    const statuses = [521, 200]
    let tick = FIXED_NOW
    const harness = makeHarness({ statuses })
    // Replace the fixed clock with one that advances, as a real one does.
    harness.deps.now = () => tick++

    await verifyArticle(harness.deps, ARTICLE_ID, 'publish')

    const [first, second] = harness.urls()
    expect(first).toBe(`${articleUrl(USER, ARTICLE_ID)}?spm=cb${FIXED_NOW}`)
    expect(second).toBe(`${articleUrl(USER, ARTICLE_ID)}?spm=cb${FIXED_NOW + 1}`)
  })

  it('works with only the three contract fields and derives the rest from defaults', async () => {
    const harness = makeHarness({ minimal: true, statuses: [404] })
    const result = await verifyArticle(harness.deps, ARTICLE_ID, 'draft')

    expect(result.consistent).toBe(true)
    expect(harness.deps.sleep).toBeUndefined()
    expect(harness.deps.now).toBeUndefined()
    expect(harness.urls()[0]).toMatch(
      new RegExp(`^${articleUrl(USER, ARTICLE_ID).replace(/\./g, '\\.')}\\?spm=cb\\d+$`)
    )
  })
})

describe('verifyArticle failure handling', () => {
  it('propagates a console API failure instead of reporting a verdict it cannot support', async () => {
    const harness = makeHarness()
    const failure = new Error('getArticle 失败')
    harness.get.mockRejectedValueOnce(failure)

    await expect(verifyArticle(harness.deps, '404404', 'draft')).rejects.toBe(failure)
    expect(harness.fetchText).not.toHaveBeenCalled()
  })

  it('echoes the article id it was asked about, not one from the API payload', async () => {
    const harness = makeHarness({ detail: { id: 'other-id' }, statuses: [404] })
    const result = await verifyArticle(harness.deps, 'asked-for-id', 'draft')

    expect(result.articleId).toBe('asked-for-id')
    expect(harness.get).toHaveBeenCalledWith('asked-for-id')
  })
})
