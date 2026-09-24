/**
 * The server assembly: `createServer` must register the frozen tool surface and
 * be reachable by a real MCP client, and `startStdioServer` must actually connect
 * a transport.
 *
 * `stdlib.js` is mocked at the module boundary and nowhere else, so the real
 * `startStdioServer` code path runs (build → create transport → connect) without
 * wiring a genuine `StdioServerTransport` to this process's stdin/stdout — the
 * runner's reporter owns those, and protocol frames written into them would
 * corrupt the test output rather than fail a test.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'

import type { CsdnConfig } from '../../src/core/config.js'
import { CsdnHttpClient } from '../../src/core/http.js'
import { ArticleClient } from '../../src/csdn/article.js'
import { MediaClient } from '../../src/csdn/media.js'
import { MetaClient } from '../../src/csdn/meta.js'
import { createContext, type ServerContext } from '../../src/context.js'
import {
  SERVER_NAME,
  SERVER_VERSION,
  createServer,
  formatFatalError,
  startStdioServer
} from '../../src/server.js'
import { TOOL_NAMES } from '../../src/tools/index.js'
import { createFakeFetch, okEnvelope } from '../helpers/fake-fetch.js'

const { stdioTransports, FakeStdioTransport } = vi.hoisted(() => {
  class FakeStdioTransport {
    started = false
    closed = false
    onmessage?: (message: unknown) => void
    onerror?: (error: Error) => void
    onclose?: () => void

    constructor() {
      stdioTransports.push(this)
    }

    async start(): Promise<void> {
      this.started = true
    }

    async close(): Promise<void> {
      this.closed = true
    }

    async send(): Promise<void> {
      // Nothing to write: these tests assert on the connection, not the frames.
    }
  }

  const stdioTransports: FakeStdioTransport[] = []
  return { stdioTransports, FakeStdioTransport }
})

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: FakeStdioTransport
}))

const COOKIE = 'uuid_tt_dd=abc; UserToken=secret-token-value; UserName=alice'

const CONFIG_OVERRIDES: Partial<CsdnConfig> = {
  cookie: COOKIE,
  userName: 'alice',
  maxRetries: 0,
  logLevel: 'silent',
  minRequestIntervalMs: 0,
  saveIntervalMs: 0
}

/** A context whose only faked part is the socket. */
function buildContext(script: Parameters<typeof createFakeFetch> = []): {
  ctx: ServerContext
  fake: ReturnType<typeof createFakeFetch>
} {
  const base = createContext(CONFIG_OVERRIDES)
  const fake = createFakeFetch(...script)
  const http = new CsdnHttpClient({
    config: base.config,
    fetchImpl: fake.fetch,
    sleep: () => Promise.resolve(),
    now: () => 1_700_000_000_000
  })
  return {
    fake,
    ctx: {
      config: base.config,
      logger: base.logger,
      http,
      articles: new ArticleClient({ http, config: base.config }),
      media: new MediaClient({ http, config: base.config }),
      meta: new MetaClient({ http, config: base.config }),
      updateCookie: (cookie: string) => base.updateCookie(cookie)
    }
  }
}

function textOf(result: CallToolResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
}

describe('createServer', () => {
  it('announces the frozen name and version to a connecting client', async () => {
    const { ctx } = buildContext()
    const { server } = createServer({ context: ctx })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'probe', version: '1.0.0' })

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

    expect(client.getServerVersion()).toEqual({ name: SERVER_NAME, version: SERVER_VERSION })

    await client.close()
    await server.close()
  })

  it('assembles a context from the environment when none is injected', async () => {
    const { server, context } = createServer()

    expect(context.config).toBeDefined()
    expect(context.http).toBeInstanceOf(CsdnHttpClient)
    expect(context.articles).toBeInstanceOf(ArticleClient)
    expect(typeof context.updateCookie).toBe('function')

    await server.close()
  })

  it('registers exactly the frozen tool surface, reachable over the wire', async () => {
    const { ctx } = buildContext()
    const { server } = createServer({ context: ctx })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'probe', version: '1.0.0' })

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    const { tools } = await client.listTools()

    expect(tools.map(tool => tool.name).sort()).toEqual([...TOOL_NAMES].sort())
    expect(tools).toHaveLength(TOOL_NAMES.length)
    // A host cannot call a tool that has no description, and zod schemas must
    // survive registration — both prove registration did more than push a name.
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(0)
      expect(tool.inputSchema).toBeDefined()
    }

    await client.close()
    await server.close()
  })
})

describe('startStdioServer', () => {
  it('connects a stdio transport by default', async () => {
    const before = stdioTransports.length
    const { ctx } = buildContext()

    const built = await startStdioServer({ context: ctx })

    expect(stdioTransports).toHaveLength(before + 1)
    const transport = stdioTransports.at(-1)
    expect(transport?.started).toBe(true)
    expect(transport?.closed).toBe(false)

    await built.server.close()
    expect(transport?.closed).toBe(true)
  })

  it('connects an injected transport and serves real tool calls through it', async () => {
    const { ctx, fake } = buildContext([
      okEnvelope({
        id: '149234567',
        title: '一篇用于测试的文章',
        markdowncontent: '# 标题',
        content: '<h1>标题</h1>',
        Description: '摘要',
        tags: '前端,vue',
        categories: '前端',
        status: 2,
        reason: '',
        cover_images: [],
        postTime: '2026-09-24 10:00:00'
      })
    ])
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    const built = await startStdioServer({ context: ctx, transport: serverTransport })
    const client = new Client({ name: 'probe', version: '1.0.0' })
    await client.connect(clientTransport)

    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name).sort()).toEqual([...TOOL_NAMES].sort())

    const result = (await client.callTool({
      name: 'get_article',
      arguments: { article_id: '149234567' }
    })) as CallToolResult

    expect(result.isError ?? false).toBe(false)
    expect(textOf(result)).toContain('一篇用于测试的文章')
    // Exactly one request: registration must not make the server chatty, and the
    // fake would record any extra traffic.
    expect(fake.requests).toHaveLength(1)
    expect(fake.last().url).toContain('getArticle')

    expect(built.context).toBe(ctx)
    await client.close()
    await built.server.close()
  })

  it('uses no stdio transport when one is injected', async () => {
    const before = stdioTransports.length
    const { ctx } = buildContext()
    const [, serverTransport] = InMemoryTransport.createLinkedPair()

    const built = await startStdioServer({ context: ctx, transport: serverTransport })

    expect(stdioTransports).toHaveLength(before)

    await built.server.close()
  })
})

describe('formatFatalError', () => {
  it('reports an Error by name and message', () => {
    expect(formatFatalError(new Error('CSDN_COOKIE is not set'))).toBe('Error: CSDN_COOKIE is not set')
    expect(formatFatalError(new TypeError('bad shape'))).toBe('TypeError: bad shape')
  })

  it('stringifies a thrown non-Error', () => {
    // The bootstrap runs before any error handling exists, so it must survive
    // whatever gets thrown — including a string or a bare object.
    expect(formatFatalError('just a string')).toBe('just a string')
    expect(formatFatalError(undefined)).toBe('undefined')
    expect(formatFatalError(42)).toBe('42')
  })
})
