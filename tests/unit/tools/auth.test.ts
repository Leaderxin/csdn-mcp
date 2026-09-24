/**
 * The cookie lifecycle, asserted on the wire rather than in the abstract: the
 * test that matters checks the `Cookie` header of the request that comes *after*
 * `auth_login`, because `updateCookie` mutating the shared config in place is the
 * whole reason the tool exists.
 *
 * A structurally invalid cookie must be refused with zero requests — that is the
 * difference between "your cookie is not a cookie" and "CSDN said no".
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'

import type { CsdnConfig } from '../../../src/core/config.js'
import { authLogin, authStatus } from '../../../src/tools/auth.js'
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

const NEW_COOKIE = 'uuid_tt_dd=zzz; UserToken=brand-new-token; UserName=bob'

interface StatusPayload {
  configured: boolean
  valid: boolean
  username: string
  reason?: string
  howToConfigure?: string
}

interface LoginPayload {
  userName: string
  valid: boolean
  liveCheck: {
    endpoint: string
    authenticated: boolean
    ok: boolean
    total?: number
    error?: { code: string; message: string }
  }
}

const LIVE_LIST = { status: 200, body: { code: 200, data: { list: [], total: 3 } } }

describe('auth_status', () => {
  it('explains how to set CSDN_COOKIE when there is none, and makes no request at all', async () => {
    const h = await harness([], { config: { cookie: '', userName: '' } })
    const result = await h.call('auth_status')
    const payload = jsonOf<StatusPayload>(result)
    expect(result.isError).toBeFalsy()
    expect(payload.configured).toBe(false)
    expect(payload.valid).toBe(false)
    expect(payload.username).toBe('')
    expect(payload.howToConfigure).toContain('CSDN_COOKIE')
    expect(textOf(result)).toContain('CSDN_COOKIE')
    expect(h.fake.requests).toHaveLength(0)
    await h.close()
  })

  it('reports a valid structure and the account name, without claiming CSDN accepted it', async () => {
    const h = await harness()
    const result = await h.call('auth_status')
    const payload = jsonOf<StatusPayload>(result)
    expect(payload).toMatchObject({ configured: true, valid: true, username: 'alice' })
    expect(textOf(result)).toContain('需要登录的调用')
    // The cookie itself is never echoed back into the reply.
    expect(textOf(result)).not.toContain('secret-token-value')
    expect(h.fake.requests).toHaveLength(0)
    await h.close()
  })

  it('falls back to the UserName inside the cookie when config carries none', async () => {
    const h = await harness([], { config: { userName: '' } })
    const payload = jsonOf<StatusPayload>(await h.call('auth_status'))
    expect(payload.username).toBe('alice')
    await h.close()
  })

  it('names the real problem when the cookie is missing UserToken', async () => {
    const h = await harness([], { config: { cookie: 'uuid_tt_dd=abc; UserName=alice' } })
    const result = await h.call('auth_status')
    const payload = jsonOf<StatusPayload>(result)
    expect(payload.configured).toBe(true)
    expect(payload.valid).toBe(false)
    expect(payload.reason).toContain('UserToken')
    expect(textOf(result)).toContain('UserToken')
    await h.close()
  })
})

describe('auth tools with a broken context', () => {
  it('answers with an error result instead of throwing when the configuration cannot be read', async () => {
    // Defensive: with a well-formed ServerContext this cannot happen, but an
    // exception escaping a handler is what an MCP host shows as a stack trace.
    const h = await harness()
    const unreadableConfig = { ...h.ctx, config: undefined } as unknown as ServerContext
    expect(authStatus(unreadableConfig).isError).toBe(true)

    const brokenInstall = {
      ...h.ctx,
      updateCookie: () => {
        throw new TypeError('updateCookie 崩了')
      }
    } as unknown as ServerContext
    const login = await authLogin(brokenInstall, { cookie: COOKIE })
    expect(login.isError).toBe(true)
    expect(textOf(login)).toContain('UNEXPECTED')
    await h.close()
  })
})

describe('auth_login', () => {
  it('rejects a cookie without UserToken verbatim, without making a single request', async () => {
    const h = await harness()
    const result = await h.call('auth_login', { cookie: 'uuid_tt_dd=abc; UserName=alice' })
    const text = textOf(result)
    expect(result.isError).toBe(true)
    expect(text).toContain('INVALID_ARGUMENT')
    // The reason comes straight from validateCookie, so the HTTP-only trap is named.
    expect(text).toContain('Cookie 缺少 UserToken')
    expect(h.fake.requests).toHaveLength(0)
    // A rejected login must not half-apply itself.
    expect(h.ctx.config.cookie).toBe(COOKIE)
    await h.close()
  })

  it('installs a valid cookie so the very next authenticated request carries it', async () => {
    const h = await harness([LIVE_LIST, articleRecord()])
    const result = await h.call('auth_login', { cookie: NEW_COOKIE })
    const payload = jsonOf<LoginPayload>(result)
    expect(result.isError).toBeFalsy()
    expect(payload.userName).toBe('bob')
    expect(payload.liveCheck).toMatchObject({ endpoint: 'list_articles', ok: true, total: 3 })
    // The live check is the anonymous community list: said out loud, not hidden.
    expect(payload.liveCheck.authenticated).toBe(false)
    expect(textOf(result)).not.toContain('brand-new-token')

    const next = await h.call('get_article', { article_id: ARTICLE_ID })
    expect(next.isError).toBeFalsy()
    expect(h.fake.matching('getArticle')[0]?.headers['Cookie']).toBe(NEW_COOKIE)
    await h.close()
  })

  it('keeps the new cookie even when the live check fails, and reports the failure loudly', async () => {
    const h = await harness([{ status: 500, body: 'upstream exploded' }])
    const result = await h.call('auth_login', { cookie: NEW_COOKIE })
    const payload = jsonOf<LoginPayload>(result)
    expect(result.isError).toBeFalsy()
    expect(payload.liveCheck.ok).toBe(false)
    expect(payload.liveCheck.error?.code).toBe('SERVER_ERROR')
    expect(textOf(result)).toContain('联网自检失败')
    expect(h.ctx.config.cookie).toBe(NEW_COOKIE)
    await h.close()
  })
})
