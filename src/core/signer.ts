/**
 * HMAC request signing for bizapi.csdn.net.
 *
 * CSDN's `bizapi` gateway (an Alibaba Cloud API Gateway deployment) rejects any
 * request that is missing a valid `X-Ca-Signature`. The exact string-to-sign
 * format is not documented anywhere public — it was reverse engineered from the
 * editor bundle (`app.chunk.*.js`). Two details cost real debugging time and are
 * therefore pinned by tests:
 *
 *   1. The canonical string includes the `x-ca-key` and `x-ca-nonce` lines.
 *   2. The request must also carry `X-Ca-Signature-Headers: x-ca-key,x-ca-nonce`,
 *      which tells the gateway which headers were folded into the signature.
 *
 * Dropping either yields `401 HMAC signature does not match`.
 */

import { createHmac, randomUUID } from 'node:crypto'

/** Public constants — hardcoded in CSDN's own front-end bundle, not secrets. */
export const CSDN_APP_KEY = '203803574'
export const CSDN_APP_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba'

export const SIGNATURE_HEADERS = 'x-ca-key,x-ca-nonce'

export interface SignInput {
  /** Upper-case HTTP verb, e.g. `POST`. */
  method: string
  /** Path plus optional query string, e.g. `/blog-console-api/v1/x?id=1`. No origin. */
  uri: string
  /** Value of the `Accept` request header. Defaults to `*\/*`. */
  accept?: string
  /** Value of the `Content-Type` request header. Empty string when absent. */
  contentType?: string
  /** Nonce that was sent as `X-Ca-Nonce`. Must match the header value. */
  nonce: string
  appKey: string
  /** Value of an optional `Date` header. Empty string in every request we make. */
  date?: string
}

/**
 * Build the canonical string that gets signed.
 *
 * Layout (CRLF-free, LF only):
 * ```
 * {method}\n{accept}\n\n{contentType}\n{date}\nx-ca-key:{key}\nx-ca-nonce:{nonce}\n{uri}
 * ```
 */
export function buildStringToSign(input: SignInput): string {
  const accept = input.accept ?? '*/*'
  const contentType = input.contentType ?? ''
  const date = input.date ?? ''
  return [
    input.method,
    accept,
    '',
    contentType,
    date,
    `x-ca-key:${input.appKey}`,
    `x-ca-nonce:${input.nonce}`,
    input.uri
  ].join('\n')
}

export interface SignatureInput extends SignInput {
  appSecret: string
}

/** base64(HMAC-SHA256(appSecret, stringToSign)) */
export function sign(input: SignatureInput): string {
  return createHmac('sha256', input.appSecret).update(buildStringToSign(input)).digest('base64')
}

export interface SignedRequestInput {
  method: string
  /** Path only — the query string is appended by the caller into `query`. */
  path: string
  query?: string
  accept?: string
  contentType?: string
  appKey: string
  appSecret: string
  /** Injectable for deterministic tests. */
  nonce?: string
  /** Injectable for deterministic tests. */
  timestamp?: number
}

export interface SignedRequestHeaders {
  'X-Ca-Key': string
  'X-Ca-Nonce': string
  'X-Ca-Timestamp': string
  'X-Ca-Signature': string
  'X-Ca-Signature-Headers': string
  nonce: string
  uri: string
}

/**
 * Produce the full `X-Ca-*` header set for one request.
 *
 * Note that `uri` — the value folded into the signature — includes the query
 * string when present. Signing the bare path while sending a query yields 401.
 */
export function buildSignHeaders(input: SignedRequestInput): SignedRequestHeaders {
  const nonce = input.nonce ?? randomUUID()
  const timestamp = (input.timestamp ?? Date.now()).toString()
  const uri = input.query ? `${input.path}?${input.query}` : input.path
  const signature = sign({
    method: input.method,
    uri,
    accept: input.accept ?? '*/*',
    contentType: input.contentType ?? '',
    nonce,
    appKey: input.appKey,
    appSecret: input.appSecret
  })
  return {
    'X-Ca-Key': input.appKey,
    'X-Ca-Nonce': nonce,
    'X-Ca-Timestamp': timestamp,
    'X-Ca-Signature': signature,
    'X-Ca-Signature-Headers': SIGNATURE_HEADERS,
    nonce,
    uri
  }
}
