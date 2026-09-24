/**
 * `update_article`: the merge that keeps an omitted field from being wiped, and
 * the honest reporting of a body edit CSDN will not apply.
 *
 * Every assertion about the outgoing `saveArticle` body is the point of the
 * file: the reply can promise anything, the request body is what CSDN reads.
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

/**
 * The update shape: HTTP 200, `code: 200`, and a bare `'成功'` string — no id at
 * all, which is why the client falls back to the id it was given.
 */
function updateAccepted(): ResponseScript {
  return { status: 200, body: { code: 200, data: '成功' } }
}

const SIGNATURE_PATH = '/resource-api/v1/image/direct/upload/signature'

const NEW_MD = '# 新正文\n\n改过的内容'
const NEW_COVER = 'https://i-blog.csdnimg.cn/direct/new.png'

interface UpdatePayload {
  articleId: string
  url: string
  state: string
  mode: string
  verification: {
    state: string
    statusCode: number
    publicStatusCode: number
    consistent: boolean
    message: string
  }
  warnings?: string[]
}

function saveBody(h: Harness): Record<string, unknown> {
  const request = h.fake.matching('saveArticle')[0]
  if (request === undefined) throw new Error('no saveArticle request was recorded')
  return request.json as Record<string, unknown>
}

describe('update_article', () => {
  it('merges the fields it was not given from the current record instead of blanking them', async () => {
    // `saveArticle` replaces the whole record, so an omitted field is a field
    // that gets wiped — this is the test that keeps a body edit from eating the
    // title, the tags, the summary and the cover.
    const h = await harness([
      articleRecord(),
      updateAccepted(),
      articleRecord({ markdowncontent: NEW_MD, content: '<h1>新正文</h1>' }),
      publicPage(404)
    ])
    const result = await h.call('update_article', { article_id: ARTICLE_ID, markdown: NEW_MD })
    expect(result.isError).toBeFalsy()

    const outgoing = saveBody(h)
    expect(outgoing['id']).toBe(ARTICLE_ID)
    expect(outgoing['title']).toBe('老标题')
    expect(outgoing['Description']).toBe('老摘要')
    expect(outgoing['tags']).toBe('A,B')
    expect(outgoing['categories']).toBe('后端')
    expect(outgoing['cover_images']).toEqual(['https://img.example/old.png'])
    expect(outgoing['markdowncontent']).toBe(NEW_MD)
    expect(outgoing['content']).toContain('<h1>新正文')
    // The current record is a draft and no mode was given, so it stays a draft.
    expect(outgoing['status']).toBe(2)

    const payload = jsonOf<UpdatePayload>(result)
    expect(payload.articleId).toBe(ARTICLE_ID)
    expect(payload.state).toBe('draft')
    expect(payload.mode).toBe('draft')
    // current record → save → verify's record → public page
    expect(h.fake.requests).toHaveLength(4)
    await h.close()
  })

  it('warns that the live body of a published article is not updated by the API', async () => {
    const h = await harness([
      articleRecord({ status: 1 }),
      updateAccepted(),
      articleRecord({ status: 1 }),
      publicPage(200)
    ])
    const result = await h.call('update_article', { article_id: ARTICLE_ID, markdown: NEW_MD })
    const text = textOf(result)
    expect(text).toContain('不会更新已公开')
    expect(text).toContain(`https://editor.csdn.net/md/?articleId=${ARTICLE_ID}`)

    const outgoing = saveBody(h)
    // No mode given, article already public: the write must not downgrade it.
    expect(outgoing['status']).toBe(1)
    const payload = jsonOf<UpdatePayload>(result)
    expect(payload.mode).toBe('publish')
    expect(payload.state).toBe('published')
    expect(payload.verification.consistent).toBe(true)
    expect(payload.warnings?.join(' ')).toContain('未指定 mode')
    await h.close()
  })

  it('keeps the body when only metadata changes, and says nothing about the live body', async () => {
    const h = await harness([
      articleRecord({ status: 16 }),
      updateAccepted(),
      articleRecord({ status: 16 }),
      publicPage(404)
    ])
    const result = await h.call('update_article', { article_id: ARTICLE_ID, title: '新标题' })
    const outgoing = saveBody(h)
    expect(outgoing['title']).toBe('新标题')
    expect(outgoing['markdowncontent']).toBe('# 老正文')
    expect(outgoing['content']).toContain('老正文')
    expect(outgoing['tags']).toBe('A,B')
    // A reviewing article is in flight, not a draft: preserve publish.
    expect(outgoing['status']).toBe(1)
    expect(textOf(result)).not.toContain('不会更新已公开')
    const payload = jsonOf<UpdatePayload>(result)
    expect(payload.state).toBe('reviewing')
    expect(payload.verification.consistent).toBe(true)
    await h.close()
  })

  it('rejects a call that changes nothing, before any request', async () => {
    const h = await harness()
    const result = await h.call('update_article', { article_id: ARTICLE_ID })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('至少要提供一个要修改的字段')
    expect(h.fake.requests).toHaveLength(0)
    await h.close()
  })

  it('reports an inconsistent self-check instead of claiming the change landed', async () => {
    const h = await harness([
      articleRecord({ status: 2 }),
      updateAccepted(),
      articleRecord({ status: 2 }),
      publicPage(404)
    ])
    const result = await h.call('update_article', { article_id: ARTICLE_ID, mode: 'publish' })
    const payload = jsonOf<UpdatePayload>(result)
    expect(payload.verification.consistent).toBe(false)
    expect(payload.state).toBe('draft')
    expect(textOf(result)).toContain('自检不一致')
    await h.close()
  })

  it('replaces the cover only when a new cover_image is passed', async () => {
    const h = await harness([articleRecord(), updateAccepted(), articleRecord(), publicPage(404)])
    await h.call('update_article', { article_id: ARTICLE_ID, cover_image: NEW_COVER })
    // An already-hosted URL is used as it is: no upload for it.
    expect(h.fake.matching(SIGNATURE_PATH)).toHaveLength(0)
    const outgoing = saveBody(h)
    expect(outgoing['cover_images']).toEqual([NEW_COVER])
    expect(outgoing['title']).toBe('老标题')
    await h.close()
  })

  it('reports a missing article as NOT_FOUND rather than writing blind', async () => {
    const h = await harness([{ status: 200, body: { code: 4004, msg: '文章不存在', data: null } }])
    const result = await h.call('update_article', { article_id: ARTICLE_ID, title: '新标题' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('NOT_FOUND')
    expect(h.fake.requests).toHaveLength(1)
    await h.close()
  })
})
