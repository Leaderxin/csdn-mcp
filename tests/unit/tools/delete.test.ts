/**
 * `delete_article`: the recycle bin is the default and `deep` follows the caller's
 * explicit choice, because deleting is the one thing here a user cannot undo.
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

interface DeletePayload {
  articleId: string
  permanent: boolean
}

const DELETED = { status: 200, body: { code: 200, data: '成功' } }

function deleteBody(h: Harness): Record<string, unknown> {
  const request = h.fake.matching('/blog/phoenix/console/v1/article/del')[0]
  if (request === undefined) throw new Error('no delete request was recorded')
  return request.json as Record<string, unknown>
}

describe('delete_article', () => {
  it('recycles by default and says where the article went and how to recover it', async () => {
    const h = await harness([DELETED])
    const result = await h.call('delete_article', { article_id: ARTICLE_ID })
    expect(result.isError).toBeFalsy()
    // `deep: false` is the recycle bin; `deep: true` is irreversible.
    expect(deleteBody(h)).toEqual({ articleId: ARTICLE_ID, deep: false })
    const payload = jsonOf<DeletePayload>(result)
    expect(payload).toEqual({ articleId: ARTICLE_ID, permanent: false })
    expect(textOf(result)).toContain('回收站')
    expect(textOf(result)).toContain('permanent=true')
    await h.close()
  })

  it('deletes for good only when permanent is explicitly true', async () => {
    const h = await harness([DELETED])
    const result = await h.call('delete_article', { article_id: ARTICLE_ID, permanent: true })
    expect(deleteBody(h)).toEqual({ articleId: ARTICLE_ID, deep: true })
    const payload = jsonOf<DeletePayload>(result)
    expect(payload.permanent).toBe(true)
    expect(textOf(result)).toContain('不可恢复')
    await h.close()
  })

  it('treats an explicit false as the recycle bin too', async () => {
    const h = await harness([DELETED])
    const result = await h.call('delete_article', { article_id: ARTICLE_ID, permanent: false })
    expect(deleteBody(h)['deep']).toBe(false)
    expect(textOf(result)).toContain('回收站')
    await h.close()
  })

  it('does not read an already-gone article as a successful delete', async () => {
    const h = await harness([{ status: 200, body: { code: 4004, msg: '文章不存在', data: null } }])
    const result = await h.call('delete_article', { article_id: ARTICLE_ID })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('NOT_FOUND')
    await h.close()
  })
})
