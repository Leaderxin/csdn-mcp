/**
 * `publish_article` end to end: the outgoing `saveArticle` body, the verification
 * pass, and the accident that motivated the whole design.
 *
 * The tests read the *recorded requests*, not just the reply, because the reply
 * can be right while the request is wrong — v0's reply said "saved as draft" and
 * the request said `status: 0`, which CSDN publishes.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CsdnConfig } from '../../../src/core/config.js'
import { CsdnHttpClient } from '../../../src/core/http.js'
import { ArticleClient } from '../../../src/csdn/article.js'
import { MediaClient } from '../../../src/csdn/media.js'
import { MetaClient } from '../../../src/csdn/meta.js'
import { createContext, type ServerContext } from '../../../src/context.js'
import { deriveDescription } from '../../../src/csdn/markdown.js'
import { createServer } from '../../../src/server.js'
import { createFakeFetch, type FakeFetch, type ResponseScript } from '../../helpers/fake-fetch.js'

const COOKIE = 'uuid_tt_dd=abc; UserToken=secret-token-value; UserName=alice'
const ARTICLE_ID = '149234567'
const ARTICLE_URL = `https://blog.csdn.net/alice/article/details/${ARTICLE_ID}`

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

/** The create shape `saveArticle` answers with. */
function savedArticle(id: string = ARTICLE_ID): ResponseScript {
  return { status: 200, body: { code: 200, data: { id, url: ARTICLE_URL, qrcode: '' } } }
}

const IMAGE_URL = 'https://i-blog.csdnimg.cn/direct/abc.png'
const SIGNATURE_PATH = '/resource-api/v1/image/direct/upload/signature'

/** Step 1: the signed upload credential (nine fields the multipart form needs). */
function signatureEnvelope(appName: string): ResponseScript {
  return {
    status: 200,
    body: {
      code: 200,
      data: {
        provider: 'obs',
        accessId: 'AKIAEXAMPLE',
        policy: 'eyJleH...oifQ==',
        signature: 'c2lnbmF0dXJl',
        callbackBody: '{"code":200}',
        callbackBodyType: 'application/json',
        callbackUrl: 'https://bizapi.csdn.net/resource-api/v1/image/direct/upload/callback',
        filePath: 'direct/2026/09/abc.png',
        host: 'https://csdn-img.obs.cn-north-4.myhuaweicloud.com',
        customParam: { appName, imageSuffix: 'png' }
      }
    }
  }
}

/** Step 2: the object store answers the callback, which carries the public URL. */
function storeCallback(): ResponseScript {
  return { status: 200, body: { code: 200, data: { imageUrl: IMAGE_URL } } }
}

const MD = '# 标题\n\n正文内容'

interface PublishPayload {
  articleId: string
  url: string
  state: string
  mode: string
  verification?: {
    articleId: string
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

describe('publish_article', () => {
  it('sends status 2 for a draft, never 0, and reports the verification pass next to the write', async () => {
    const h = await harness([savedArticle(), articleRecord({ status: 2 }), publicPage(404)])
    const result = await h.call('publish_article', { title: '标题', markdown: MD })
    expect(result.isError).toBeFalsy()

    const request = h.fake.matching('saveArticle')[0]
    expect(request?.url).toContain('/blog-console-api/v3/mdeditor/saveArticle')
    expect(request?.method).toBe('POST')
    // Authenticated and signed, i.e. it really went through the csdn+core layers.
    expect(request?.headers['Cookie']).toBe(COOKIE)
    expect(request?.headers['X-Ca-Signature']).toBeTruthy()

    const outgoing = saveBody(h)
    expect(outgoing['status']).toBe(2)
    expect(outgoing['pubStatus']).toBe('draft')
    expect(outgoing['status']).not.toBe(0)
    // A new article: `id` must be present and empty, CSDN answers 500 without it.
    expect(outgoing['id']).toBe('')
    // Rendered HTML in `content`, the untouched source in `markdowncontent`.
    expect(outgoing['content']).toContain('<h1>')
    expect(outgoing['markdowncontent']).toBe(MD)
    // Capital D, or CSDN silently invents its own summary.
    expect(outgoing['Description']).toBe(deriveDescription(MD))

    const payload = jsonOf<PublishPayload>(result)
    expect(payload.articleId).toBe(ARTICLE_ID)
    expect(payload.url).toBe(ARTICLE_URL)
    expect(payload.state).toBe('draft')
    expect(payload.mode).toBe('draft')
    expect(payload.verification).toMatchObject({
      articleId: ARTICLE_ID,
      state: 'draft',
      statusCode: 2,
      publicStatusCode: 404,
      consistent: true
    })
    // The verification is its own two calls: the console record and the public page.
    expect(h.fake.requests).toHaveLength(3)
    await h.close()
  })

  it('passes through the metadata fields a caller did supply', async () => {
    const h = await harness([savedArticle(), articleRecord({ status: 2 }), publicPage(404)])
    await h.call('publish_article', {
      title: '标题',
      markdown: MD,
      description: '手写摘要',
      tags: ['MCP', 'CSDN'],
      categories: '后端'
    })
    const outgoing = saveBody(h)
    expect(outgoing['Description']).toBe('手写摘要')
    // Tags travel as one comma-joined string, which is what CSDN reads.
    expect(outgoing['tags']).toBe('MCP,CSDN')
    expect(outgoing['categories']).toBe('后端')
    await h.close()
  })

  it('shouts delete_article when a draft turns out to be publicly visible', async () => {
    // The incident: the request asked for a draft, the console record says the
    // article is published. Nothing in this server can undo that.
    const h = await harness([savedArticle(), articleRecord({ status: 1 }), publicPage(404)])
    const result = await h.call('publish_article', { title: '标题', markdown: MD })
    const text = textOf(result)
    expect(result.isError).toBeFalsy()
    expect(text).toContain('严重')
    expect(text).toContain('立即删除')
    expect(text).toContain('delete_article')
    expect(text).toContain('无法把已发布文章退回草稿')

    const payload = jsonOf<PublishPayload>(result)
    expect(payload.verification?.consistent).toBe(false)
    expect(payload.warnings?.join(' ')).toContain('立即删除')
    await h.close()
  })

  it('treats a draft whose public page answers 200 as publicly visible too', async () => {
    const h = await harness([savedArticle(), articleRecord({ status: 2 }), publicPage(200)])
    const result = await h.call('publish_article', { title: '标题', markdown: MD })
    const payload = jsonOf<PublishPayload>(result)
    expect(payload.verification?.consistent).toBe(false)
    expect(payload.verification?.message).toContain('对外可见')
    expect(textOf(result)).toContain('delete_article')
    await h.close()
  })

  it('skips the verification pass when verify is false and says the state is unknown', async () => {
    const h = await harness([savedArticle()])
    const result = await h.call('publish_article', { title: '标题', markdown: MD, verify: false })
    expect(h.fake.requests).toHaveLength(1)
    const payload = jsonOf<PublishPayload>(result)
    expect(payload.verification).toBeUndefined()
    expect(payload.state).toBe('unknown')
    expect(textOf(result)).toContain('未自检')
    await h.close()
  })

  it('publishes only when mode is publish, and reports the live state it verified', async () => {
    const h = await harness([savedArticle(), articleRecord({ status: 1 }), publicPage(200)])
    const result = await h.call('publish_article', { title: '标题', markdown: MD, mode: 'publish' })
    const outgoing = saveBody(h)
    expect(outgoing['status']).toBe(1)
    expect(outgoing['pubStatus']).toBe('publish')
    const payload = jsonOf<PublishPayload>(result)
    expect(payload.state).toBe('published')
    expect(payload.verification?.consistent).toBe(true)
    expect(textOf(result)).toContain('已发布')
    await h.close()
  })

  it('uploads a local cover_image through the cover channel and sends its url as the cover', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csdn-mcp-tools-'))
    const file = join(dir, 'cover.png')
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const h = await harness([
      signatureEnvelope('direct_blog_coverimage'),
      storeCallback(),
      savedArticle(),
      articleRecord({ status: 2 }),
      publicPage(404)
    ])
    const result = await h.call('publish_article', { title: '标题', markdown: MD, cover_image: file })
    expect(result.isError).toBeFalsy()

    const signature = h.fake.matching(SIGNATURE_PATH)[0]
    // The cover channel, not the body channel: they are not interchangeable.
    expect((signature?.json as Record<string, unknown>)['appName']).toBe('direct_blog_coverimage')
    const outgoing = saveBody(h)
    expect(outgoing['cover_images']).toEqual([IMAGE_URL])
    expect(outgoing['cover_type']).toBe(1)
    await rm(dir, { recursive: true, force: true })
    await h.close()
  })

  it('uses an already-hosted cover_image as it is, without re-uploading it', async () => {
    const cover = 'https://i-blog.csdnimg.cn/direct/hosted.png'
    const h = await harness([savedArticle(), articleRecord({ status: 2 }), publicPage(404)])
    await h.call('publish_article', { title: '标题', markdown: MD, cover_image: cover })
    expect(h.fake.matching(SIGNATURE_PATH)).toHaveLength(0)
    expect(saveBody(h)['cover_images']).toEqual([cover])
    await h.close()
  })

  it('reports a rate limit with the code and the wait advice instead of a raw exception', async () => {
    const h = await harness([
      { status: 200, body: { code: 400, msg: '文章频繁发布，请稍后再试', data: null } }
    ])
    const result = await h.call('publish_article', { title: '标题', markdown: MD })
    const text = textOf(result)
    expect(result.isError).toBe(true)
    expect(text).toContain('RATE_LIMITED')
    expect(text).toContain('10 秒')
    await h.close()
  })
})
