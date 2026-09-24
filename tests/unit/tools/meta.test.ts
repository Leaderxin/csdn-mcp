/**
 * The two metadata tools: their contract is that they *degrade* rather than fail,
 * and that `source` tells a caller which of the two lists they are looking at.
 *
 * v0 shipped a builtin list behind an API call, so nobody could tell "CSDN told
 * me this" from "we guessed"; the `source` assertions here are what stops that
 * from coming back.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'

import type { CsdnConfig } from '../../../src/core/config.js'
import { CsdnError } from '../../../src/core/errors.js'
import { CsdnHttpClient } from '../../../src/core/http.js'
import { ArticleClient } from '../../../src/csdn/article.js'
import { BUILTIN_CATEGORIES, COMMON_TAGS } from '../../../src/csdn/meta.js'
import { MediaClient } from '../../../src/csdn/media.js'
import { MetaClient } from '../../../src/csdn/meta.js'
import { createContext, type ServerContext } from '../../../src/context.js'
import { createServer } from '../../../src/server.js'
import {
  createFakeFetch,
  openresty404,
  type FakeFetch,
  type ResponseScript
} from '../../helpers/fake-fetch.js'

const COOKIE = 'uuid_tt_dd=abc; UserToken=secret-token-value; UserName=alice'

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

interface MetaPayload {
  items: string[]
  source: 'api' | 'builtin'
}

describe('list_categories', () => {
  it('reads the author categories from the signed console endpoint', async () => {
    const h = await harness([{ status: 200, body: { code: 200, data: { categorys: ['后端', '前端'] } } }])
    const result = await h.call('list_categories')
    expect(result.isError).toBeFalsy()
    const payload = jsonOf<MetaPayload>(result)
    expect(payload).toEqual({ items: ['后端', '前端'], source: 'api' })
    const request = h.fake.requests[0]
    expect(request?.url).toContain('/blog-console-api/v1/editor/getBaseInfo')
    expect(request?.headers['Cookie']).toBe(COOKIE)
    expect(request?.headers['X-Ca-Signature']).toBeTruthy()
    expect(textOf(result)).toContain('CSDN 接口')
    await h.close()
  })

  it('degrades to the builtin list with source builtin instead of failing', async () => {
    // The v0 endpoint is dead and bizapi answers the openresty 404 page with
    // HTTP 200: a status-code check would call that success.
    const h = await harness([openresty404(), openresty404(), openresty404()])
    const result = await h.call('list_categories')
    expect(result.isError).toBeFalsy()
    const payload = jsonOf<MetaPayload>(result)
    expect(payload.source).toBe('builtin')
    expect(payload.items).toEqual(BUILTIN_CATEGORIES)
    expect(h.fake.requests).toHaveLength(3)
    expect(textOf(result)).toContain('内置')
    await h.close()
  })
})

describe('list_tags', () => {
  it('reads the recommended tags with the Content-Type CSDN signs verbatim', async () => {
    const h = await harness([
      { status: 200, body: { code: 200, data: { common: ['MCP', 'TypeScript'], list: { 前端: ['Vue'] } } } }
    ])
    const result = await h.call('list_tags')
    const payload = jsonOf<MetaPayload>(result)
    expect(payload).toEqual({ items: ['MCP', 'TypeScript', 'Vue'], source: 'api' })
    const request = h.fake.requests[0]
    expect(request?.method).toBe('POST')
    expect(request?.url).toContain('/blog/phoenix/console/v1/tag/get-recommend-tags')
    // `application/json;` (no charset) is what the console sends and what the
    // gateway signature expects — a space or a charset breaks the HMAC.
    expect(request?.headers['Content-Type']).toBe('application/json;')
    await h.close()
  })

  it('degrades to the builtin tag list when the endpoint is gone', async () => {
    const h = await harness([openresty404()])
    const result = await h.call('list_tags')
    const payload = jsonOf<MetaPayload>(result)
    expect(payload.source).toBe('builtin')
    expect(payload.items).toEqual(COMMON_TAGS)
    expect(textOf(result)).toContain('内置')
    await h.close()
  })

  it('still answers with an error result when the metadata layer throws unexpectedly', async () => {
    // The client is written never to reject; the tool must survive it anyway,
    // because an uncaught rejection is what an MCP host renders as a stack trace.
    const h = await harness([], {
      boot: {
        meta: {
          listCategories: () => Promise.reject(new CsdnError('API_ERROR', '元数据接口返回 code=500')),
          listTags: () => Promise.reject(new CsdnError('MALFORMED_RESPONSE', '标签接口返回的不是 JSON'))
        } as unknown as MetaClient
      }
    })
    const categories = await h.call('list_categories')
    expect(categories.isError).toBe(true)
    expect(textOf(categories)).toContain('API_ERROR')

    const tags = await h.call('list_tags')
    expect(tags.isError).toBe(true)
    expect(textOf(tags)).toContain('MALFORMED_RESPONSE')
    await h.close()
  })
})
