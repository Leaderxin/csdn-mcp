/**
 * The registry: `tools/list` must expose exactly the frozen surface, and no
 * tool may ever reach the network on arguments it can already see are wrong.
 *
 * Both are asserted through a real `McpServer` + real MCP `Client` joined by the
 * SDK's in-memory transport, so the zod schemas, the registration in `server.ts`
 * and the tool layer are exercised together — only the socket is faked.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'

import type { CsdnConfig } from '../../../src/core/config.js'
import { CsdnHttpClient } from '../../../src/core/http.js'
import { ArticleClient } from '../../../src/csdn/article.js'
import { MediaClient } from '../../../src/csdn/media.js'
import { MetaClient } from '../../../src/csdn/meta.js'
import { createContext, type ServerContext } from '../../../src/context.js'
import { createServer } from '../../../src/server.js'
import { TOOL_NAMES, TOOL_NAMES_BY_DOMAIN, registerTools } from '../../../src/tools/index.js'
import { createFakeFetch, type FakeFetch, type ResponseScript } from '../../helpers/fake-fetch.js'

const COOKIE = 'uuid_tt_dd=abc; UserToken=secret-token-value; UserName=alice'
const ARTICLE_ID = '149234567'

/** A throwable that is not an `Error`: the transport layer is not the only code that can do this. */
const NOT_AN_ERROR = { toString: () => 'not an Error at all' }

interface Harness {
  client: Client
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>
  fake: FakeFetch
  ctx: ServerContext
  close(): Promise<void>
}

/**
 * Build a context on the shared config object and drive the **really registered**
 * tools through a real client/server pair. `sleep` is a no-op and every interval
 * is 0 so no test ever waits on CSDN's write throttle.
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
    client,
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

function textOf(result: CallToolResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
}

describe('tool registry', () => {
  it('exposes exactly the 11 frozen tool names, so a registration cannot go missing silently', async () => {
    const h = await harness()
    const listed = await h.client.listTools()
    expect(listed.tools.map(tool => tool.name).sort()).toEqual([...TOOL_NAMES].sort())
    expect(TOOL_NAMES).toHaveLength(11)
    await h.close()
  })

  it('keeps the per-domain name lists and the frozen list in agreement', () => {
    expect(TOOL_NAMES_BY_DOMAIN.flat().sort()).toEqual([...TOOL_NAMES].sort())
  })

  it('registerTools does not throw when it wires a bare server', async () => {
    const h = await harness()
    const server = new McpServer({ name: 'bare', version: '0.0.0' })
    expect(() => registerTools(server, h.ctx)).not.toThrow()
    await h.close()
  })

  it('documents every tool in Chinese and warns where a mistake is expensive', async () => {
    const h = await harness()
    const listed = await h.client.listTools()
    for (const tool of listed.tools) {
      const description = tool.description ?? ''
      expect(description.length, tool.name).toBeGreaterThan(20)
      expect(/[\u4e00-\u9fff]/.test(description), tool.name).toBe(true)
      expect(tool.inputSchema.type, tool.name).toBe('object')
    }
    const publish = listed.tools.find(tool => tool.name === 'publish_article')
    expect(publish?.description).toContain('无法退回草稿')
    const remove = listed.tools.find(tool => tool.name === 'delete_article')
    expect(remove?.description).toContain('无法恢复')
    await h.close()
  })
})

interface Rejection {
  label: string
  name: string
  args: Record<string, unknown>
  message: string
}

const REJECTIONS: Rejection[] = [
  {
    label: '六个标签',
    name: 'publish_article',
    args: { title: 't', markdown: '# x', tags: ['a', 'b', 'c', 'd', 'e', 'f'] },
    message: 'tags 最多 5 个'
  },
  {
    label: '六个标签',
    name: 'update_article',
    args: { article_id: ARTICLE_ID, tags: ['a', 'b', 'c', 'd', 'e', 'f'] },
    message: 'tags 最多 5 个'
  },
  {
    label: '257 字摘要',
    name: 'publish_article',
    args: { title: 't', markdown: '# x', description: 'x'.repeat(257) },
    message: 'description 最多 256 字'
  },
  {
    label: '257 字摘要',
    name: 'update_article',
    args: { article_id: ARTICLE_ID, description: 'x'.repeat(257) },
    message: 'description 最多 256 字'
  },
  {
    label: '空 markdown',
    name: 'publish_article',
    args: { title: 't', markdown: '' },
    message: 'markdown 不能为空'
  },
  {
    label: '只含空白的 markdown',
    name: 'publish_article',
    args: { title: 't', markdown: '   ' },
    message: 'markdown 不能只包含空白字符'
  },
  {
    label: '空 markdown',
    name: 'update_article',
    args: { article_id: ARTICLE_ID, markdown: '' },
    message: 'markdown 不能为空'
  },
  {
    label: '空标题',
    name: 'publish_article',
    args: { title: '', markdown: '# x' },
    message: 'title 不能为空'
  },
  {
    label: 'kind 不是 cover/body',
    name: 'upload_image',
    args: { path: '/tmp/a.png', kind: 'avatar' },
    message: 'kind 只能是 cover'
  },
  { label: '空 article_id', name: 'get_article', args: { article_id: '' }, message: 'article_id 不能为空' },
  {
    label: '空 article_id',
    name: 'delete_article',
    args: { article_id: '' },
    message: 'article_id 不能为空'
  },
  {
    label: '空 article_id',
    name: 'verify_article',
    args: { article_id: '' },
    message: 'article_id 不能为空'
  },
  {
    label: '空 article_id',
    name: 'update_article',
    args: { article_id: '' },
    message: 'article_id 不能为空'
  },
  { label: '空 cookie', name: 'auth_login', args: { cookie: '' }, message: 'cookie 不能为空' },
  {
    label: 'mode 不是 draft/publish',
    name: 'publish_article',
    args: { title: 't', markdown: '# x', mode: 'save' },
    message: 'mode 只能是 draft'
  },
  {
    label: 'mode 不是 draft/publish',
    name: 'update_article',
    args: { article_id: ARTICLE_ID, mode: 'save' },
    message: 'mode 只能是 draft'
  },
  {
    label: 'expected 不是 draft/publish',
    name: 'verify_article',
    args: { article_id: ARTICLE_ID, expected: 'live' },
    message: 'expected 只能是 draft'
  },
  { label: 'page 为 0', name: 'list_articles', args: { page: 0 }, message: 'page 从 1 开始' },
  {
    label: 'page_size 为 101',
    name: 'list_articles',
    args: { page_size: 101 },
    message: 'page_size 最大 100'
  }
]

describe('argument validation', () => {
  it.each(REJECTIONS)('rejects $label for $name before any network call', async (rejection: Rejection) => {
    const h = await harness()
    const result = await h.call(rejection.name, rejection.args)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(rejection.message)
    // The point of the whole group: CSDN is never contacted with arguments that
    // cannot work, so a rejection can never be misread as a CSDN refusal.
    expect(h.fake.requests).toHaveLength(0)
    await h.close()
  })

  it('reports a CSDN refusal with its code and hint but never with the cookie in it', async () => {
    const h = await harness([
      {
        status: 401,
        // A proxy that echoes the request headers is exactly how a cookie ends
        // up in an error body; the reply must survive that.
        body: `unauthorized Cookie: ${COOKIE}`
      }
    ])
    const result = await h.call('get_article', { article_id: ARTICLE_ID })
    const text = textOf(result)
    expect(result.isError).toBe(true)
    expect(text).toContain('AUTH_INVALID')
    expect(text).toContain('过期')
    expect(text).not.toContain('secret-token-value')
    expect(text).toContain('<redacted>')
    await h.close()
  })

  it('turns an unexpected thrown value into isError instead of letting it escape', async () => {
    const h = await harness([], {
      boot: {
        articles: {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error throwable is the case under test
          get: () => Promise.reject(NOT_AN_ERROR)
        } as unknown as ArticleClient
      }
    })
    const result = await h.call('get_article', { article_id: ARTICLE_ID })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('not an Error at all')
    await h.close()
  })
})
