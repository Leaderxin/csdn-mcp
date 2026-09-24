/**
 * `upload_image`: the two channels are asserted separately because mixing them up
 * is silent — the upload succeeds and the image simply never shows up.
 *
 * The file-based tests write a real (tiny) file: the tool reads bytes before it
 * can upload anything, so a faked `readFile` would skip the code under test.
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
import { createServer } from '../../../src/server.js'
import { createFakeFetch, type FakeFetch, type ResponseScript } from '../../helpers/fake-fetch.js'

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

interface UploadedPayload {
  url: string
  key: string
  size: number
  mimeType: string
}

const STORE_HOST = 'https://csdn-img.obs.cn-north-4.myhuaweicloud.com'

/** A real file on disk, because the tool reads bytes before it can upload them. */
async function withPng<T>(name: string, run: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'csdn-mcp-tools-'))
  const file = join(dir, name)
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  try {
    return await run(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('upload_image', () => {
  it('returns the public url, the storage key, the byte size and the mime type for a body image', async () => {
    await withPng('shot.png', async file => {
      const h = await harness([signatureEnvelope('direct_blog'), storeCallback()])
      const result = await h.call('upload_image', { path: file, kind: 'body' })
      expect(result.isError).toBeFalsy()
      const payload = jsonOf<UploadedPayload>(result)
      expect(payload).toEqual({
        url: IMAGE_URL,
        key: 'direct/2026/09/abc.png',
        size: 4,
        mimeType: 'image/png'
      })

      const signature = h.fake.matching(SIGNATURE_PATH)[0]
      expect((signature?.json as Record<string, unknown>)['appName']).toBe('direct_blog')
      expect((signature?.json as Record<string, unknown>)['imageTemplate']).toBe('standard')
      // The store is a third party: it must get neither the cookie nor a signature.
      const store = h.fake.matching(STORE_HOST)[0]
      expect(store?.headers['Cookie']).toBeUndefined()
      expect(store?.headers['X-Ca-Signature']).toBeUndefined()
      await h.close()
    })
  })

  it('uses the cover channel — a different appName — when kind is cover', async () => {
    await withPng('cover.png', async file => {
      const h = await harness([signatureEnvelope('direct_blog_coverimage'), storeCallback()])
      const result = await h.call('upload_image', { path: file, kind: 'cover' })
      expect(result.isError).toBeFalsy()
      const signature = h.fake.matching(SIGNATURE_PATH)[0]
      expect((signature?.json as Record<string, unknown>)['appName']).toBe('direct_blog_coverimage')
      expect((signature?.json as Record<string, unknown>)['imageTemplate']).toBe('')
      await h.close()
    })
  })

  it('refuses an unsupported extension before asking CSDN for an upload credential', async () => {
    await withPng('notes.txt', async file => {
      const h = await harness()
      const result = await h.call('upload_image', { path: file, kind: 'body' })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('INVALID_ARGUMENT')
      expect(textOf(result)).toContain('不支持的图片格式')
      expect(h.fake.requests).toHaveLength(0)
      await h.close()
    })
  })

  it('reports a missing file as an argument error instead of a raw ENOENT', async () => {
    const h = await harness()
    const result = await h.call('upload_image', {
      path: join(tmpdir(), 'csdn-mcp-not-here.png'),
      kind: 'body'
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('无法读取图片文件')
    expect(h.fake.requests).toHaveLength(0)
    await h.close()
  })
})
