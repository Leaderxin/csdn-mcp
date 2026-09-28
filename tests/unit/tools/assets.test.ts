/**
 * `uploadLocalImages` / `describeUploadedImages`.
 *
 * The upload itself is `src/csdn/media.ts`'s two-step handshake; what is decided
 * here is which references count as local, and what a caller is told when one of
 * them fails halfway. A partial upload has already spent bytes, so the failure
 * has to name the file that failed *and* the ones that already made it.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CsdnError } from '../../../src/core/errors.js'
import { CsdnHttpClient } from '../../../src/core/http.js'
import { MediaClient } from '../../../src/csdn/media.js'
import { createContext, type ServerContext } from '../../../src/context.js'
import { describeUploadedImages, uploadLocalImages } from '../../../src/tools/assets.js'
import { createFakeFetch, type FakeFetch, type ResponseScript } from '../../helpers/fake-fetch.js'

const COOKIE = 'uuid_tt_dd=abc; UserToken=secret-token-value; UserName=alice'
const SIGNATURE_PATH = '/resource-api/v1/image/direct/upload/signature'
/** A real (tiny) file: the media client reads bytes before it can upload them. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

interface Harness {
  ctx: ServerContext
  fake: FakeFetch
}

/** The real `MediaClient` over the shared fake socket. */
function harness(script: ResponseScript[] = []): Harness {
  const base = createContext({
    cookie: COOKIE,
    userName: 'alice',
    maxRetries: 0,
    logLevel: 'silent',
    minRequestIntervalMs: 0,
    saveIntervalMs: 0
  })
  const fake = createFakeFetch(...script)
  const http = new CsdnHttpClient({
    config: base.config,
    fetchImpl: fake.fetch,
    sleep: () => Promise.resolve(),
    now: () => 1_700_000_000_000
  })
  return { ctx: { ...base, http, media: new MediaClient({ http, config: base.config }) }, fake }
}

/** Step 1: the signed credential. `direct_blog` is the body channel. */
function signatureEnvelope(appName = 'direct_blog'): ResponseScript {
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
function storeCallback(imageUrl: string): ResponseScript {
  return { status: 200, body: { code: 200, data: { imageUrl } } }
}

/** Two real files in a temp directory, removed again however the test ends. */
async function withTwoPngs<T>(run: (first: string, second: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'csdn-mcp-assets-'))
  const first = join(dir, 'first.png')
  const second = join(dir, 'second.png')
  await writeFile(first, PNG)
  await writeFile(second, PNG)
  try {
    return await run(first, second)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** One real file, for the single-reference and first-upload-fails cases. */
async function withOnePng<T>(run: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'csdn-mcp-assets-'))
  const file = join(dir, 'only.png')
  await writeFile(file, PNG)
  try {
    return await run(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Run `run`, returning the CsdnError it threw so tests can assert on `code`. */
async function captureCsdnError(run: () => Promise<unknown>): Promise<CsdnError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof CsdnError) return error
    throw error
  }
  throw new Error('expected a CsdnError, but nothing was thrown')
}

describe('uploadLocalImages', () => {
  it('returns the document untouched and uploads nothing when no reference is local', async () => {
    const { ctx, fake } = harness()
    const markdown = '# 标题\n\n![图](https://i-blog.csdnimg.cn/direct/x.png)\n\n正文'

    await expect(uploadLocalImages(ctx, markdown)).resolves.toEqual({ markdown, uploaded: {} })
    expect(fake.requests).toHaveLength(0)
  })

  it('uploads each local image once, in first-appearance order, through the body channel', async () => {
    await withTwoPngs(async (first, second) => {
      const firstUrl = 'https://i-blog.csdnimg.cn/direct/a.png'
      const secondUrl = 'https://i-blog.csdnimg.cn/direct/b.png'
      const { ctx, fake } = harness([
        signatureEnvelope(),
        storeCallback(firstUrl),
        signatureEnvelope(),
        storeCallback(secondUrl)
      ])
      // Both reference forms, one file used twice, and one already-hosted image
      // that must not be uploaded again.
      const markdown = [
        `![a](${first})`,
        '',
        '<img src="https://i-blog.csdnimg.cn/direct/hosted.png">',
        '',
        `<img src="${second}">`,
        '',
        `![a again](${first})`
      ].join('\n')

      const result = await uploadLocalImages(ctx, markdown)

      expect(result.uploaded).toEqual({ [first]: firstUrl, [second]: secondUrl })
      // Two signature requests for two files, not three for three references.
      const signatures = fake.matching(SIGNATURE_PATH)
      expect(signatures).toHaveLength(2)
      for (const request of signatures) {
        expect((request.json as Record<string, unknown>)['appName']).toBe('direct_blog')
      }
      expect(result.markdown).toBe(
        `![a](${firstUrl})\n\n<img src="https://i-blog.csdnimg.cn/direct/hosted.png">\n\n<img src="${secondUrl}">\n\n![a again](${firstUrl})`
      )
    })
  })

  it('names the failed path and everything already uploaded, and keeps the original error code', async () => {
    await withTwoPngs(async (first, second) => {
      const { ctx } = harness([
        signatureEnvelope(),
        storeCallback('https://i-blog.csdnimg.cn/direct/a.png'),
        { status: 401, body: 'Unauthorized' }
      ])

      const error = await captureCsdnError(() => uploadLocalImages(ctx, `![a](${first})\n\n![b](${second})`))

      // The real failure is an expired cookie, so the caller must not be told
      // "invalid argument" and go looking for a typo in the path.
      expect(error.code).toBe('AUTH_INVALID')
      expect(error.message).toContain('正文图片上传失败')
      expect(error.message).toContain(second)
      expect(error.detail).toBe(`failed=${second}; already_uploaded=${first}`)
    })
  })

  it('says already_uploaded=none when the first upload is the one that fails', async () => {
    await withOnePng(async first => {
      const { ctx } = harness([{ status: 401, body: 'Unauthorized' }])

      const error = await captureCsdnError(() => uploadLocalImages(ctx, `![a](${first})`))

      expect(error.detail).toBe(`failed=${first}; already_uploaded=none`)
    })
  })

  it('reports a thrown non-Error as INVALID_ARGUMENT instead of an [object Object] message', async () => {
    const ctx = {
      media: {
        upload: () =>
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error throwable is the case under test
          Promise.reject('boom')
      }
    } as unknown as ServerContext

    const error = await captureCsdnError(() => uploadLocalImages(ctx, '![a](./x.png)'))

    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(error.message).toContain('boom')
    expect(error.detail).toBe('failed=./x.png; already_uploaded=none')
  })
})

describe('describeUploadedImages', () => {
  it('says nothing when nothing was uploaded, so a caller without local paths sees no change', () => {
    expect(describeUploadedImages({})).toBeUndefined()
  })

  it('returns one line naming every path and the CDN url it became', () => {
    const line = describeUploadedImages({
      './a.png': 'https://i-blog.csdnimg.cn/direct/a.png',
      './b.png': 'https://i-blog.csdnimg.cn/direct/b.png'
    })

    expect(line).toContain('正文图片已自动上传 2 张（body 通道）')
    expect(line).toContain('./a.png → https://i-blog.csdnimg.cn/direct/a.png')
    expect(line).toContain('./b.png → https://i-blog.csdnimg.cn/direct/b.png')
  })
})
