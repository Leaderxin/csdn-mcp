/**
 * The read-only tools — the ones whose answer is evidence rather than intent.
 *
 * `list_articles` is asserted to be *anonymous* (no cookie, no signature) because
 * CSDN answers 403 to an authenticated call on the community endpoint, and
 * `get_article`'s `include_content: false` is asserted to remove the body from
 * every key that carries it, including the troubleshooting `raw` record.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'

import type { CsdnConfig } from '../../../src/core/config.js'
import { CsdnHttpClient } from '../../../src/core/http.js'
import { ArticleClient } from '../../../src/csdn/article.js'
import { MediaClient } from '../../../src/csdn/media.js'
import { MetaClient } from '../../../src/csdn/meta.js'
import { createContext, type ServerContext } from '../../../src/context.js'
import { createServer } from '../../../src/server.js'
import { createFakeFetch, type FakeFetch, type ResponseScript } from '../../helpers/fake-fetch.js'

const COOKIE = 'uuid_tt_dd=abc; UserToken=secret-token-value; UserName=alice'
const ARTICLE_ID = '149234567'

interface Harness {
  ctx: ServerContext
  fake: FakeFetch
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>
  close(): Promise<void>
}

/**
 * Drive the really-registered tools: a real McpServer, a real MCP Client and the
 * SDK's in-memory transport pair, so zod validation, the registration in
 * `server.ts` and the tool layer all run for real. Only the socket is faked.
 */
async function harness(
  script: ResponseScript[] = [],
  options: {
    config?: Partial<CsdnConfig>
    boot?: Partial<Pick<ServerContext, 'articles' | 'media' | 'meta'>>
  } = {}
): Promise<Harness> {
  const base = createContext({
    cookie: COOKIE,
    userName: 'alice',
    maxRetries: 0,
    logLevel: 'silent',
    minRequestIntervalMs: 0,
    saveIntervalMs: 0,
    ...options.config
  })
  const fake = createFakeFetch(...script)
  const http = new CsdnHttpClient({
    config: base.config,
    fetchImpl: fake.fetch,
    sleep: () => Promise.resolve(),
    now: () => 1_700_000_000_000
  })
  const ctx: ServerContext = {
    config: base.config,
    logger: base.logger,
    http,
    articles: options.boot?.articles ?? new ArticleClient({ http, config: base.config }),
    media: options.boot?.media ?? new MediaClient({ http, config: base.config }),
    meta: options.boot?.meta ?? new MetaClient({ http, config: base.config }),
    updateCookie: (cookie: string) => base.updateCookie(cookie)
  }
  const { server } = createServer({ context: ctx })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'csdn-mcp-tests', version: '1.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return {
    ctx,
    fake,
    // The SDK types `callTool` as a union that also covers task-augmented
    // execution; this client never requests one, so the narrow result is the
    // true one and the cast keeps every assertion below strongly typed.
    call: (name, args) => client.callTool({ name, arguments: args ?? {} }) as Promise<CallToolResult>,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

/** The minimum shape shared by an MCP result and the tool layer's `ToolResult`. */
interface TextualResult {
  content: Array<{ type: string; text?: string }>
}

function textOf(result: TextualResult): string {
  return result.content.map(block => block.text ?? '').join('\n')
}

/** Parse the fenced JSON block a tool result carries, next to its summary line. */
function jsonOf<T>(result: TextualResult): T {
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result))
  const block = match?.[1]
  if (block === undefined) throw new Error(`result had no json block: ${textOf(result)}`)
  return JSON.parse(block) as T
}

/**
 * `getArticle`'s console record. `status` is CSDN's own code: 2 draft, 1
 * published, 16 reviewing, 6 rejected.
 */
function articleRecord(overrides: Record<string, unknown> = {}): ResponseScript {
  return {
    status: 200,
    body: {
      code: 200,
      data: {
        article_id: ARTICLE_ID,
        title: '老标题',
        status: 2,
        reason: '',
        Description: '老摘要',
        tags: 'A,B',
        categories: '后端',
        markdowncontent: '# 老正文',
        content: '<h1>老正文</h1>',
        cover_images: ['https://img.example/old.png'],
        postTime: '2026-09-24 08:10:00',
        viewCount: 0,
        ...overrides
      }
    }
  }
}

/** The public article page: the only signal a reader (or the verifier) cannot fake. */
function publicPage(status: number): ResponseScript {
  return status === 200 ? { status, body: '<html><h1>老标题</h1></html>' } : { status, body: 'Not Found' }
}

interface DetailPayload {
  id: string
  title: string
  state: string
  statusCode: number
  tags: string[]
  coverImages: string[]
  markdownContent?: string
  htmlContent?: string
  raw?: Record<string, unknown>
}

interface ListPayload {
  items: Array<{
    id: string
    title: string
    url: string
    tags: string[]
    viewCount: number
    state?: string
    statusCode?: number
  }>
  page: number
  pageSize: number
  total: number
  scope: string
  counts?: Record<string, number>
}

interface VerificationPayload {
  articleId: string
  state: string
  statusCode: number
  publicStatusCode: number
  consistent: boolean
  message: string
}

describe('get_article', () => {
  it('returns the whole record, including both bodies, by default', async () => {
    const h = await harness([articleRecord()])
    const result = await h.call('get_article', { article_id: ARTICLE_ID })
    const payload = jsonOf<DetailPayload>(result)
    expect(payload.id).toBe(ARTICLE_ID)
    expect(payload.title).toBe('老标题')
    expect(payload.state).toBe('draft')
    expect(payload.statusCode).toBe(2)
    expect(payload.tags).toEqual(['A', 'B'])
    expect(payload.markdownContent).toBe('# 老正文')
    expect(payload.htmlContent).toBe('<h1>老正文</h1>')
    expect(h.fake.requests).toHaveLength(1)
    await h.close()
  })

  it('omits the bodies — and their copies inside raw — when include_content is false', async () => {
    // An agent that only needs the state must not pay for a 50k-token body, and
    // `raw` is the same record verbatim, so it has to be trimmed too.
    const h = await harness([articleRecord()])
    const result = await h.call('get_article', { article_id: ARTICLE_ID, include_content: false })
    const payload = jsonOf<DetailPayload>(result)
    expect('markdownContent' in payload).toBe(false)
    expect('htmlContent' in payload).toBe(false)
    expect(payload.raw?.['content']).toBeUndefined()
    expect(payload.raw?.['markdowncontent']).toBeUndefined()
    // Everything else survives, which is what the flag is for.
    expect(payload.title).toBe('老标题')
    expect(payload.raw?.['status']).toBe(2)
    expect(textOf(result)).toContain('include_content=false')
    await h.close()
  })

  it('reports a deleted or unknown article as NOT_FOUND with a way forward', async () => {
    const h = await harness([{ status: 200, body: { code: 4004, msg: '文章不存在', data: null } }])
    const result = await h.call('get_article', { article_id: ARTICLE_ID })
    const text = textOf(result)
    expect(result.isError).toBe(true)
    expect(text).toContain('NOT_FOUND')
    expect(text).toContain('article_id')
    await h.close()
  })
})

describe('list_articles', () => {
  const LIST_BODY = {
    status: 200,
    body: {
      code: 200,
      data: {
        total: 42,
        list: [
          {
            articleId: '1',
            title: '已发布的一篇',
            url: 'https://blog.csdn.net/alice/article/details/1',
            description: '摘要',
            tags: 'X,Y',
            postTime: '2026-09-01 10:00:00',
            viewCount: 5,
            diggCount: 1,
            collectCount: 2,
            commentCount: 3
          }
        ]
      }
    }
  }

  it('reads the public list with no cookie and no signature, because CSDN rejects those here', async () => {
    const h = await harness([LIST_BODY])
    const result = await h.call('list_articles', { page: 2, page_size: 5 })
    const request = h.fake.requests[0]
    expect(request?.url).toContain('/community/home-api/v1/get-business-list')
    expect(request?.url).toContain('page=2')
    expect(request?.url).toContain('size=5')
    expect(request?.url).toContain('businessType=blog')
    expect(request?.url).toContain('username=alice')
    expect(request?.headers['Cookie']).toBeUndefined()
    expect(request?.headers['X-Ca-Signature']).toBeUndefined()

    const payload = jsonOf<ListPayload>(result)
    expect(payload.page).toBe(2)
    expect(payload.pageSize).toBe(5)
    expect(payload.total).toBe(42)
    expect(payload.items[0]?.id).toBe('1')
    expect(payload.items[0]?.tags).toEqual(['X', 'Y'])
    expect(textOf(result)).toContain('草稿查不到')
    await h.close()
  })

  it('surfaces a failing list request as a coded error result', async () => {
    const h = await harness([{ status: 500, body: 'gateway exploded' }])
    const result = await h.call('list_articles')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('SERVER_ERROR')
    await h.close()
  })

  it('defaults to page 1 and 20 per page when the caller omits the paging', async () => {
    const h = await harness([LIST_BODY])
    await h.call('list_articles')
    const url = h.fake.requests[0]?.url ?? ''
    expect(url).toContain('page=1')
    expect(url).toContain('size=20')
    await h.close()
  })

  it('defaults to scope published, so an existing caller sees no change', async () => {
    const h = await harness([LIST_BODY])
    const result = await h.call('list_articles')

    expect(h.fake.requests[0]?.url).toContain('/community/home-api/v1/get-business-list')
    expect(jsonOf<ListPayload>(result).scope).toBe('published')
    await h.close()
  })

  it('scope=all reaches the author console and reports drafts, which the public list cannot', async () => {
    const h = await harness([
      {
        status: 200,
        body: {
          code: 200,
          data: {
            total: 26,
            page: 1,
            size: 20,
            count: { all: 26, draft: 2, publish: 26 },
            list: [
              {
                articleId: '103343553',
                title: '草稿一篇',
                postTime: '2020-01-03 15:44:36',
                viewCount: '1',
                status: '2'
              }
            ]
          }
        }
      }
    ])

    const result = await h.call('list_articles', { scope: 'all' })
    const request = h.fake.requests[0]

    expect(request?.url).toContain('/blog/phoenix/console/v1/article/list')
    // The console endpoint is authenticated, unlike the public one.
    expect(request?.headers['Cookie']).toBeDefined()
    expect(request?.headers['X-Ca-Signature']).toBeDefined()

    const payload = jsonOf<ListPayload>(result)
    expect(payload.scope).toBe('all')
    expect(payload.counts).toEqual({ all: 26, draft: 2, publish: 26 })
    expect(payload.items[0]?.state).toBe('draft')

    // The human-readable line must not tell an agent "草稿查不到" when it is
    // looking at a list that contains one.
    const text = textOf(result)
    expect(text).not.toContain('草稿查不到')
    expect(text).toContain('包含草稿')
    expect(text).toContain('draft=2')
    await h.close()
  })

  it('rejects an out-of-range scope through the zod schema without any request', async () => {
    const h = await harness([LIST_BODY])
    const result = await h.call('list_articles', { scope: 'everything' })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('published')
    expect(h.fake.requests).toHaveLength(0)
    await h.close()
  })
})

describe('verify_article', () => {
  it('verifies against the expected state the caller gave, and returns exactly the frozen payload', async () => {
    const h = await harness([articleRecord({ status: 2 }), publicPage(404)])
    const result = await h.call('verify_article', { article_id: ARTICLE_ID, expected: 'draft' })
    const payload = jsonOf<VerificationPayload>(result)
    expect(Object.keys(payload).sort()).toEqual([
      'articleId',
      'consistent',
      'message',
      'publicStatusCode',
      'state',
      'statusCode'
    ])
    expect(payload.consistent).toBe(true)
    expect(payload.publicStatusCode).toBe(404)
    expect(textOf(result)).toContain('expected=draft')
    await h.close()
  })

  it('derives publish as the expectation when the article is already public', async () => {
    const h = await harness([articleRecord({ status: 1 }), articleRecord({ status: 1 }), publicPage(200)])
    const result = await h.call('verify_article', { article_id: ARTICLE_ID })
    const payload = jsonOf<VerificationPayload>(result)
    // One read to derive the expectation, then the verification's own read.
    expect(h.fake.requests).toHaveLength(3)
    expect(payload.state).toBe('published')
    expect(payload.consistent).toBe(true)
    expect(textOf(result)).toContain('expected=publish')
    await h.close()
  })

  it('derives draft as the expectation for anything that is not live', async () => {
    const h = await harness([articleRecord({ status: 2 }), articleRecord({ status: 2 }), publicPage(404)])
    const result = await h.call('verify_article', { article_id: ARTICLE_ID })
    const payload = jsonOf<VerificationPayload>(result)
    expect(payload.state).toBe('draft')
    expect(payload.consistent).toBe(true)
    expect(textOf(result)).toContain('expected=draft')
    await h.close()
  })

  it('flags the case where the interface says draft but the public page serves it', async () => {
    const h = await harness([articleRecord({ status: 2 }), publicPage(200)])
    const result = await h.call('verify_article', { article_id: ARTICLE_ID, expected: 'draft' })
    const payload = jsonOf<VerificationPayload>(result)
    expect(payload.consistent).toBe(false)
    expect(payload.publicStatusCode).toBe(200)
    expect(textOf(result)).toContain('⚠️ 自检不一致')
    await h.close()
  })

  it('propagates a missing article instead of inventing a verdict about it', async () => {
    const h = await harness([{ status: 200, body: { code: 404, msg: '文章不存在', data: null } }])
    const result = await h.call('verify_article', { article_id: ARTICLE_ID, expected: 'draft' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('NOT_FOUND')
    await h.close()
  })
})
