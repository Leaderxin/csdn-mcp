/**
 * `src/csdn/media.ts`
 *
 * The upload is a two-step handshake across two hosts, and each assertion here
 * guards a detail that broke a real upload: the literal `Content-Type` that gets
 * signed, the per-channel `appName`, the OBS/OSS credential field names, and the
 * absence of CSDN auth on the request that goes to the object store.
 *
 * No test in this file touches the network: `createFakeFetch` records every
 * request, and no real image ever leaves the machine.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildConfig, type CsdnConfig } from '../../../src/core/config.js'
import { CsdnError } from '../../../src/core/errors.js'
import { CsdnHttpClient } from '../../../src/core/http.js'
import { createLogger } from '../../../src/core/logger.js'
import { MediaClient, resolveMimeType } from '../../../src/csdn/media.js'
import {
  createFakeFetch,
  createMemorySink,
  okEnvelope,
  type FakeFetch,
  type RecordedRequest,
  type ResponseScript
} from '../../helpers/fake-fetch.js'

const SIGNATURE_PATH = '/resource-api/v1/image/direct/upload/signature'
const SIGNATURE_URL = `https://bizapi.csdn.net${SIGNATURE_PATH}`
const OBS_HOST = 'https://csdn-img.obs.cn-north-4.myhuaweicloud.com'
const OSS_HOST = 'https://csdn-img.oss-cn-hangzhou.aliyuncs.com'
const CALLBACK_URL = 'https://bizapi.csdn.net/resource-api/v1/image/direct/upload/callback'
const FILE_PATH = 'direct/2026/01/abc.png'
const IMAGE_URL = 'https://i-blog.csdnimg.cn/direct/abc.png'

/** The nine fields step 2 cannot build a form without. */
const REQUIRED_FIELDS = [
  'provider',
  'host',
  'accessId',
  'policy',
  'signature',
  'callbackUrl',
  'callbackBody',
  'callbackBodyType',
  'filePath'
]

/** A complete, well-formed step-1 credential, overridable per test. */
function signature(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'obs',
    accessId: 'AKIAEXAMPLE',
    policy: 'eyJleHBpcmF0aW9uIjoiMjA5OS0wMS0wMVQwMDowMDowMFoifQ==',
    signature: 'c2lnbmF0dXJl',
    callbackBody: '{"code":200}',
    callbackBodyType: 'application/json',
    callbackUrl: CALLBACK_URL,
    filePath: FILE_PATH,
    host: OBS_HOST,
    customParam: { bizId: 'blog' },
    ...overrides
  }
}

/** The normal object-store reply, which is CSDN's callback envelope. */
function storeEnvelope(data: object): ResponseScript {
  return okEnvelope(data)
}

interface Harness {
  client: MediaClient
  fake: FakeFetch
  config: CsdnConfig
}

function createConfig(): CsdnConfig {
  return buildConfig({
    cookie: 'UserToken=test-token-for-tests; UserName=tester',
    // Throttling and retries are exercised by the http layer's own tests; here
    // they would only add real wall-clock time to every case.
    minRequestIntervalMs: 0,
    maxRetries: 0
  })
}

function createHarness(...script: ResponseScript[]): Harness {
  const config = createConfig()
  const fake = createFakeFetch(...script)
  const http = new CsdnHttpClient({ config, fetchImpl: fake.fetch, sleep: async () => {} })
  return { client: new MediaClient({ http, config }), fake, config }
}

/** Assert a recorded request carried multipart data and return that FormData. */
function formOf(request: RecordedRequest | undefined): FormData {
  expect(request?.body).toBeInstanceOf(FormData)
  return request?.body as FormData
}

/** Read a Blob-valued form field, failing loudly when the field is missing. */
function blobField(form: FormData, name: string): Blob {
  const value = form.get(name)
  if (!(value instanceof Blob)) throw new Error(`form field ${name} is not a Blob: ${String(value)}`)
  return value
}

async function captureCsdnError(fn: () => Promise<unknown>): Promise<CsdnError> {
  try {
    await fn()
  } catch (error) {
    if (error instanceof CsdnError) return error
    throw error
  }
  throw new Error('expected a CsdnError, but nothing was thrown')
}

describe('resolveMimeType', () => {
  it.each([
    ['photo.jpg', 'image/jpeg'],
    ['photo.JPEG', 'image/jpeg'],
    ['photo.png', 'image/png'],
    ['photo.PnG?raw=1', 'image/png'],
    ['photo.gif#frag', 'image/gif'],
    ['photo.webp', 'image/webp'],
    ['photo.bmp', 'image/bmp']
  ])('maps %s to %s, case-insensitively and ignoring a query string', (fileName, expected) => {
    expect(resolveMimeType(fileName)).toBe(expected)
  })

  it('rejects an unsupported extension with INVALID_ARGUMENT listing what is supported', () => {
    const error = captureCsdnErrorSync(() => resolveMimeType('scan.tiff'))
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(error.message).toContain('tiff')
    expect(error.message).toContain('png')
  })

  it('rejects an extensionless name, because CSDN cannot infer a format from it', () => {
    expect(captureCsdnErrorSync(() => resolveMimeType('README')).code).toBe('INVALID_ARGUMENT')
  })
})

/** `resolveMimeType` is synchronous, so it needs its own capture helper. */
function captureCsdnErrorSync(fn: () => unknown): CsdnError {
  try {
    fn()
  } catch (error) {
    if (error instanceof CsdnError) return error
    throw error
  }
  throw new Error('expected a CsdnError, but nothing was thrown')
}

describe('MediaClient step 1 — the signature request', () => {
  it('asks the body channel for appName direct_blog / imageTemplate standard, exactly as the editor does', async () => {
    const { client, fake } = createHarness(okEnvelope(signature()), storeEnvelope({ imageUrl: IMAGE_URL }))
    await client.uploadBuffer(Buffer.from('png-bytes'), 'body', 'photo.png')

    const sign = fake.requests[0]
    expect(sign?.url).toBe(SIGNATURE_URL)
    expect(sign?.method).toBe('POST')
    expect(sign?.json).toEqual({ appName: 'direct_blog', imageTemplate: 'standard', imageSuffix: 'png' })
  })

  it('asks the cover channel for appName direct_blog_coverimage and an empty imageTemplate, because the channels are not interchangeable', async () => {
    const { client, fake } = createHarness(okEnvelope(signature()), storeEnvelope({ imageUrl: IMAGE_URL }))
    await client.uploadBuffer(Buffer.from('png-bytes'), 'cover', 'photo.JPEG')

    expect(fake.requests[0]?.json).toEqual({
      appName: 'direct_blog_coverimage',
      imageTemplate: '',
      // No dot, lower-cased: this value becomes the storage key suffix.
      imageSuffix: 'jpeg'
    })
  })

  it('sends Content-Type "application/json;charset=UTF-8" with no space, because that string is signed', async () => {
    const { client, fake } = createHarness(okEnvelope(signature()), storeEnvelope({ imageUrl: IMAGE_URL }))
    await client.uploadBuffer(Buffer.from('x'), 'body', 'a.png')

    expect(fake.requests[0]?.headers['Content-Type']).toBe('application/json;charset=UTF-8')
    // Signed and authenticated, unlike step 2 below.
    expect(fake.requests[0]?.headers['X-Ca-Signature']).toBeDefined()
    expect(fake.requests[0]?.headers['Cookie']).toContain('UserToken=')
  })
})

describe('MediaClient step 2 — the multipart upload', () => {
  it('posts to the absolute host with neither a cookie nor X-Ca-* headers, because the store is a third party', async () => {
    const { client, fake } = createHarness(okEnvelope(signature()), storeEnvelope({ imageUrl: IMAGE_URL }))
    await client.uploadBuffer(Buffer.from('png-bytes'), 'body', 'photo.png')

    const store = fake.requests[1]
    expect(store?.url).toBe(OBS_HOST)
    expect(store?.method).toBe('POST')
    expect(store?.headers['Cookie']).toBeUndefined()
    expect(store?.headers['X-Ca-Signature']).toBeUndefined()
    expect(store?.headers['X-Ca-Key']).toBeUndefined()
    // The multipart boundary is undici's job; setting the header breaks the body.
    expect(store?.headers['Content-Type']).toBeUndefined()
    expect(fake.requests.length).toBe(2)
  })

  it('sends the credential fields plus AccessKeyId and callbackUrl for provider obs', async () => {
    const { client, fake } = createHarness(okEnvelope(signature()), storeEnvelope({ imageUrl: IMAGE_URL }))
    await client.uploadBuffer(Buffer.from('png-bytes'), 'body', 'photo.png')

    const form = formOf(fake.requests[1])
    expect(form.get('key')).toBe(FILE_PATH)
    expect(form.get('policy')).toBe(signature()['policy'])
    expect(form.get('signature')).toBe(signature()['signature'])
    expect(form.get('callbackBody')).toBe('{"code":200}')
    expect(form.get('callbackBodyType')).toBe('application/json')
    expect(form.get('AccessKeyId')).toBe('AKIAEXAMPLE')
    expect(form.get('callbackUrl')).toBe(CALLBACK_URL)
    expect(form.get('OSSAccessKeyId')).toBeNull()
    expect(form.get('callback')).toBeNull()
  })

  it('sends OSSAccessKeyId and callback for a non-obs provider, because Aliyun OSS rejects the OBS names', async () => {
    const { client, fake } = createHarness(
      okEnvelope(signature({ provider: 'oss', host: OSS_HOST })),
      storeEnvelope({ imageUrl: IMAGE_URL })
    )
    await client.uploadBuffer(Buffer.from('png-bytes'), 'body', 'photo.png')

    expect(fake.requests[1]?.url).toBe(OSS_HOST)
    const form = formOf(fake.requests[1])
    expect(form.get('OSSAccessKeyId')).toBe('AKIAEXAMPLE')
    expect(form.get('callback')).toBe(CALLBACK_URL)
    expect(form.get('AccessKeyId')).toBeNull()
    expect(form.get('callbackUrl')).toBeNull()
  })

  it('turns every customParam entry into an x-prefixed field, because CSDN rebuilds its callback from those', async () => {
    const { client, fake } = createHarness(
      okEnvelope(signature({ customParam: { bizId: 'blog', articleId: '42' } })),
      storeEnvelope({ imageUrl: IMAGE_URL })
    )
    await client.uploadBuffer(Buffer.from('png-bytes'), 'body', 'photo.png')

    const form = formOf(fake.requests[1])
    expect(form.get('x:bizId')).toBe('blog')
    expect(form.get('x:articleId')).toBe('42')
    expect(form.get('bizId')).toBeNull()
  })

  it('omits x- fields entirely when the credential has no customParam', async () => {
    const { client, fake } = createHarness(
      okEnvelope(signature({ customParam: undefined })),
      storeEnvelope({ imageUrl: IMAGE_URL })
    )
    await client.uploadBuffer(Buffer.from('png-bytes'), 'body', 'photo.png')

    const form = formOf(fake.requests[1])
    expect([...form.keys()].filter(key => key.startsWith('x:'))).toEqual([])
    expect(form.get('key')).toBe(FILE_PATH)
  })

  it('uploads the real bytes as a file field carrying the resolved MIME type and file name', async () => {
    const { client, fake } = createHarness(okEnvelope(signature()), storeEnvelope({ imageUrl: IMAGE_URL }))
    await client.uploadBuffer(Buffer.from('png-bytes'), 'body', 'photo.png')

    const file = blobField(formOf(fake.requests[1]), 'file')
    expect(file).toBeInstanceOf(File)
    expect((file as File).name).toBe('photo.png')
    expect(file.type).toBe('image/png')
    expect(file.size).toBe(9)
    expect(await file.text()).toBe('png-bytes')
  })
})

describe('MediaClient callback handling', () => {
  it('reads data.imageUrl out of the callback envelope', async () => {
    const { client } = createHarness(okEnvelope(signature()), okEnvelope({ imageUrl: IMAGE_URL }))
    const result = await client.uploadBuffer(Buffer.from('png-bytes'), 'body', 'photo.png')
    expect(result.url).toBe(IMAGE_URL)
  })

  it('also accepts a bare { imageUrl } body, because not every store answer is enveloped', async () => {
    const { client } = createHarness(okEnvelope(signature()), { status: 200, body: { imageUrl: IMAGE_URL } })
    const result = await client.uploadBuffer(Buffer.from('png-bytes'), 'body', 'photo.png')
    expect(result.url).toBe(IMAGE_URL)
  })

  it('throws MALFORMED_RESPONSE for every callback body that carries no usable imageUrl', async () => {
    const shapes: object[] = [
      {},
      { code: 200 },
      { code: 200, data: {} },
      { code: 200, data: { imageUrl: '' } },
      { imageUrl: '' }
    ]
    for (const shape of shapes) {
      const { client, fake } = createHarness(okEnvelope(signature()), { status: 200, body: shape })
      const error = await captureCsdnError(() => client.uploadBuffer(Buffer.from('x'), 'body', 'a.png'))
      expect(error.code, JSON.stringify(shape)).toBe('MALFORMED_RESPONSE')
      // The multipart request did happen; the response is what was unusable.
      expect(fake.requests.length, JSON.stringify(shape)).toBe(2)
    }
  })
})

describe('MediaClient credential validation', () => {
  it('names every missing credential field and never posts the multipart form', async () => {
    for (const field of REQUIRED_FIELDS) {
      const incomplete = signature()
      delete incomplete[field]
      const { client, fake } = createHarness(okEnvelope(incomplete))
      const error = await captureCsdnError(() => client.uploadBuffer(Buffer.from('x'), 'body', 'a.png'))
      expect(error.code, field).toBe('MALFORMED_RESPONSE')
      expect(error.message, field).toContain(field)
      // Failing before step 2 is the whole point: no orphaned upload, no wasted bytes.
      expect(fake.requests.length, field).toBe(1)
    }
  })

  it('treats a blank or non-string credential field as missing', async () => {
    const { client } = createHarness(okEnvelope(signature({ policy: '', signature: null })))
    const error = await captureCsdnError(() => client.uploadBuffer(Buffer.from('x'), 'body', 'a.png'))
    expect(error.code).toBe('MALFORMED_RESPONSE')
    expect(error.message).toContain('policy')
    expect(error.message).toContain('signature')
  })

  it('treats a 200 response with no data object as a malformed credential', async () => {
    const { client } = createHarness({ status: 200, body: { code: 200, msg: 'ok' } })
    const error = await captureCsdnError(() => client.uploadBuffer(Buffer.from('x'), 'body', 'a.png'))
    expect(error.code).toBe('MALFORMED_RESPONSE')
    expect(error.message).toContain('host')
  })
})

describe('MediaClient.upload', () => {
  it('rejects a path that does not exist with INVALID_ARGUMENT instead of leaking an ENOENT', async () => {
    const { client, fake } = createHarness()
    const error = await captureCsdnError(() =>
      client.upload({ path: join(tmpdir(), 'csdn-mcp-definitely-missing.png'), kind: 'body' })
    )
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(fake.requests.length).toBe(0)
  })

  it('rejects a directory with INVALID_ARGUMENT, because it is not a regular file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csdn-mcp-media-'))
    const { client, fake } = createHarness()
    try {
      const error = await captureCsdnError(() => client.upload({ path: dir, kind: 'body' }))
      expect(error.code).toBe('INVALID_ARGUMENT')
      expect(error.message).toContain(dir)
      expect(fake.requests.length).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uploads a real file and reports its byte size, MIME type and object key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csdn-mcp-media-'))
    const file = join(dir, 'shot.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    await writeFile(file, bytes)
    const { client, fake } = createHarness(okEnvelope(signature()), storeEnvelope({ imageUrl: IMAGE_URL }))
    try {
      const result = await client.upload({ path: file, kind: 'cover' })

      expect(result).toEqual({ url: IMAGE_URL, key: FILE_PATH, size: 4, mimeType: 'image/png' })
      expect(fake.requests[0]?.json).toEqual({
        appName: 'direct_blog_coverimage',
        imageTemplate: '',
        imageSuffix: 'png'
      })
      expect((blobField(formOf(fake.requests[1]), 'file') as File).name).toBe('shot.png')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects an unsupported extension before any network call, so nothing is uploaded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csdn-mcp-media-'))
    const file = join(dir, 'scan.tiff')
    await writeFile(file, Buffer.from('tiff-bytes'))
    const { client, fake } = createHarness()
    try {
      const error = await captureCsdnError(() => client.upload({ path: file, kind: 'body' }))
      expect(error.code).toBe('INVALID_ARGUMENT')
      expect(fake.requests.length).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('MediaClient logger', () => {
  it('uses an injected logger instead of creating one, so a host can capture upload logs', async () => {
    const { lines, sink } = createMemorySink()
    const config = createConfig()
    const fake = createFakeFetch(okEnvelope(signature()), storeEnvelope({ imageUrl: IMAGE_URL }))
    const http = new CsdnHttpClient({ config, fetchImpl: fake.fetch, sleep: async () => {} })
    const client = new MediaClient({ http, config, logger: createLogger({ level: 'debug', sink }) })

    await client.uploadBuffer(Buffer.from('png-bytes'), 'body', 'photo.png')

    expect(lines.some(line => line.includes('image uploaded'))).toBe(true)
    expect(lines.some(line => line.includes(FILE_PATH))).toBe(true)
  })
})
