/**
 * CSDN image upload.
 *
 * Binary uploads are a **two-step handshake** against two different hosts:
 *
 *   1. ask CSDN for a signed upload credential
 *      (`POST /resource-api/v1/image/direct/upload/signature`), and
 *   2. POST the multipart form to the third-party object store (Huawei OBS or
 *      Aliyun OSS) that the credential points at.
 *
 * The single-step endpoint v0 used (`imgservice.csdn.net/direct/v1.0/image/upload`)
 * is dead — every variant of it answers 404 — so it must not be reintroduced; the
 * signature handshake is the only path that works.
 *
 * Two details in here were each worth an incident:
 *
 *   - the signature request's `Content-Type` is folded into the `X-Ca-Signature`,
 *     so the exact string matters (no space after the semicolon), and
 *   - the store is a third party: it must receive neither the CSDN cookie nor the
 *     `X-Ca-*` headers, hence `signed: false, requireAuth: false` on step 2.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { CsdnConfig } from '../core/config.js'
import { CsdnError, isCsdnError } from '../core/errors.js'
import type { CsdnHttpClient } from '../core/http.js'
import { createLogger, type Logger } from '../core/logger.js'
import type { ImageKind, UploadImageInput, UploadedImage } from './types.js'

/**
 * Extension → MIME type. Only formats CSDN's image host accepts are listed:
 * anything else is rejected locally, before an upload credential is requested.
 */
const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
})

const SUPPORTED_EXTENSIONS: readonly string[] = Object.keys(MIME_TYPES)

/**
 * Resolve a file's MIME type from its name.
 *
 * Case-insensitive, and a trailing query string is tolerated because callers
 * sometimes pass a URL straight out of a browser address bar. An unsupported
 * extension is `INVALID_ARGUMENT` and names the formats we can handle.
 */
export function resolveMimeType(fileName: string): string {
  const clean = fileName.replace(/[?#].*$/, '')
  // `lastIndexOf` returns -1 for an extensionless name; slicing from 0 then
  // yields the whole name, which simply fails the lookup below.
  const extension = clean.slice(clean.lastIndexOf('.') + 1).toLowerCase()
  const mimeType = MIME_TYPES[extension]
  if (mimeType === undefined) {
    throw new CsdnError(
      'INVALID_ARGUMENT',
      `不支持的图片格式 .${extension}，仅支持：${SUPPORTED_EXTENSIONS.join(', ')}`
    )
  }
  return mimeType
}

/**
 * The two upload channels. They are **not** interchangeable: an image sent
 * through the body channel does not appear as the article cover, and a cover
 * uploaded through the body channel is not used as the cover either.
 */
const UPLOAD_CHANNELS: Readonly<Record<ImageKind, { appName: string; imageTemplate: string }>> =
  Object.freeze({
    body: { appName: 'direct_blog', imageTemplate: 'standard' },
    cover: { appName: 'direct_blog_coverimage', imageTemplate: '' }
  })

const SIGNATURE_PATH = '/resource-api/v1/image/direct/upload/signature'

/**
 * Exactly what CSDN's own editor sends, and exactly what gets signed. A space
 * after the semicolon changes the HMAC input and the gateway answers 401.
 */
const SIGNATURE_CONTENT_TYPE = 'application/json;charset=UTF-8'

/** Upload credential returned by step 1. */
interface UploadSignatureData {
  provider: string
  accessId: string
  policy: string
  signature: string
  callbackBody: string
  callbackBodyType: string
  callbackUrl: string
  filePath: string
  host: string
  customParam?: Record<string, string>
}

/** Raw credential response: CSDN may omit any of these fields. */
type SignatureResponse = Partial<UploadSignatureData>

/**
 * Fields the multipart form cannot be built without. All nine are validated up
 * front so a half-formed credential fails with one clear message instead of an
 * opaque 400 from the object store.
 */
const REQUIRED_SIGNATURE_FIELDS = [
  'provider',
  'host',
  'accessId',
  'policy',
  'signature',
  'callbackUrl',
  'callbackBody',
  'callbackBodyType',
  'filePath'
] as const satisfies readonly (keyof UploadSignatureData)[]

/**
 * The store answers the *callback* rather than the upload, so its body can be
 * either `{ code: 200, data: { imageUrl } }` or a bare `{ imageUrl }` — some
 * store configurations return the callback parameters at the top level.
 */
interface StoreCallbackEnvelope {
  code?: number
  msg?: string
  data?: { imageUrl?: unknown } | null
  imageUrl?: unknown
}

/** A field is unusable when it is missing, not a string, or blank. */
function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === ''
}

/** Validate the credential and return it narrowed to a complete object. */
function assertSignature(data: SignatureResponse): UploadSignatureData {
  const missing = REQUIRED_SIGNATURE_FIELDS.filter(field => isBlank(data[field]))
  if (missing.length > 0) {
    throw new CsdnError('MALFORMED_RESPONSE', `上传签名响应缺少必需字段：${missing.join(', ')}`, {
      detail: `missing=${missing.join(',')}`
    })
  }
  // Every required field is present and non-blank, which is precisely the
  // condition under which the cast holds.
  return data as UploadSignatureData
}

/** Pull the public image URL out of either callback shape; there is no third. */
function extractImageUrl(envelope: StoreCallbackEnvelope): string {
  const nested = envelope.data?.imageUrl
  if (typeof nested === 'string' && nested.length > 0) return nested
  if (typeof envelope.imageUrl === 'string' && envelope.imageUrl.length > 0) return envelope.imageUrl
  throw new CsdnError('MALFORMED_RESPONSE', '对象存储回调未返回 imageUrl，无法确认图片已上传成功', {
    detail: JSON.stringify(envelope)
  })
}

/**
 * File extension without the dot — the value CSDN puts in the storage key. A
 * query string is stripped and the case is lowered to match what the editor
 * sends (`a.PNG` and `a.png` must produce the same key suffix).
 */
function imageSuffix(fileName: string): string {
  const clean = fileName.replace(/[?#].*$/, '')
  return clean.slice(clean.lastIndexOf('.') + 1).toLowerCase()
}

export interface MediaClientDeps {
  http: CsdnHttpClient
  config: CsdnConfig
  logger?: Logger
}

export class MediaClient {
  private readonly http: CsdnHttpClient
  private readonly logger: Logger

  constructor(deps: MediaClientDeps) {
    this.http = deps.http
    // Fallback logger honours the configured level, exactly like
    // `CsdnHttpClient`, so a directly constructed client never writes to stdout
    // (that stream belongs to the MCP transport).
    this.logger = deps.logger ?? createLogger({ level: deps.config.logLevel })
  }

  /**
   * Upload a local file.
   *
   * A missing path or a directory is reported as `INVALID_ARGUMENT`: a raw
   * `ENOENT` stack trace tells an agent nothing about which argument was wrong.
   */
  async upload(input: UploadImageInput): Promise<UploadedImage> {
    const data = await this.readImageFile(input.path)
    return await this.uploadBuffer(data, input.kind, basename(input.path))
  }

  /** Upload an in-memory buffer. The extension of `fileName` picks the format. */
  async uploadBuffer(data: Buffer, kind: ImageKind, fileName: string): Promise<UploadedImage> {
    const mimeType = resolveMimeType(fileName)
    const signature = await this.requestSignature(kind, imageSuffix(fileName))
    const blob = new Blob([data], { type: mimeType })
    const url = await this.postToStore(signature, blob, fileName)
    this.logger.debug('image uploaded', { kind, key: signature.filePath, size: data.byteLength })
    return { url, key: signature.filePath, size: data.byteLength, mimeType }
  }

  private async readImageFile(path: string): Promise<Buffer> {
    try {
      const stats = await stat(path)
      if (!stats.isFile()) {
        throw new CsdnError('INVALID_ARGUMENT', `不是普通文件：${path}`)
      }
      return await readFile(path)
    } catch (error) {
      // Re-throw our own error untouched; everything else (ENOENT, EACCES,
      // EISDIR) becomes a caller-facing argument error.
      if (isCsdnError(error)) throw error
      throw new CsdnError('INVALID_ARGUMENT', `无法读取图片文件：${path}`, { cause: error })
    }
  }

  /** Step 1: obtain the signed upload credential for the channel. */
  private async requestSignature(kind: ImageKind, suffix: string): Promise<UploadSignatureData> {
    const channel = UPLOAD_CHANNELS[kind]
    const response = await this.http.requestData<SignatureResponse | undefined>({
      method: 'POST',
      path: SIGNATURE_PATH,
      contentType: SIGNATURE_CONTENT_TYPE,
      body: {
        appName: channel.appName,
        imageTemplate: channel.imageTemplate,
        imageSuffix: suffix
      }
    })
    // A 200 with no data at all is still a broken credential, not an upload.
    return assertSignature(response ?? {})
  }

  /** Step 2: post the multipart form to the object store named by `host`. */
  private async postToStore(data: UploadSignatureData, blob: Blob, fileName: string): Promise<string> {
    const form = new FormData()
    form.append('key', data.filePath)
    form.append('policy', data.policy)
    form.append('signature', data.signature)
    form.append('callbackBody', data.callbackBody)
    form.append('callbackBodyType', data.callbackBodyType)
    if (data.provider === 'obs') {
      // Huawei OBS names these two fields differently from Aliyun OSS. Sending
      // the OSS pair to OBS produces an empty 400 body with no explanation.
      form.append('AccessKeyId', data.accessId)
      form.append('callbackUrl', data.callbackUrl)
    } else {
      form.append('OSSAccessKeyId', data.accessId)
      form.append('callback', data.callbackUrl)
    }
    for (const [key, value] of Object.entries(data.customParam ?? {})) {
      // CSDN reassembles its callback parameters from `x:`-prefixed fields.
      form.append(`x:${key}`, value)
    }
    form.append('file', blob, fileName)

    const envelope = await this.http.request<StoreCallbackEnvelope>({
      method: 'POST',
      // `host` is an absolute URL on the storage provider, not a CSDN path.
      path: data.host,
      formData: form,
      signed: false,
      requireAuth: false
    })
    return extractImageUrl(envelope)
  }
}
