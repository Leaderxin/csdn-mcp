import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CSDN_APP_KEY,
  CSDN_APP_SECRET,
  SIGNATURE_HEADERS,
  buildSignHeaders,
  buildStringToSign,
  sign,
  type SignInput
} from '../../../src/core/signer.js'

const NONCE = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const SAVE_PATH = '/blog-console-api/v1/article/save'
const CATEGORY_PATH = '/blog-console-api/v1/category/getCategoryList'
const JSON_CONTENT_TYPE = 'application/json; charset=UTF-8'

/**
 * Signatures below are hardcoded on purpose. Recomputing them in the test from
 * `buildStringToSign` would keep passing if the recipe changed; a literal only
 * passes while the exact canonical string is still being signed.
 */
const SIG_POST_SAVE = 'pMghNWvwPbaBQRR2YJa/jCk5LNFCvIFzAgV5oQ7mXRM='
const SIG_GET_CATEGORY = 'ROMs+dmXAhgV4TH+1OnQTS76UMVnsBYJM3CX6CKZvFE='
const SIG_HEADERS_WITH_QUERY = 'pLHsOOKmkGO1tftfTEH2AJUiCOXVNr0RfVGs2Eald0k='
const SIG_HEADERS_SAVE = '6tFN/EBNAy7POfHgjGHHZcISE7/FBLCg7na4rEtiK20='

const baseInput: SignInput = {
  method: 'POST',
  uri: SAVE_PATH,
  accept: '*/*',
  contentType: JSON_CONTENT_TYPE,
  nonce: NONCE,
  appKey: CSDN_APP_KEY
}

describe('buildStringToSign', () => {
  it('builds the exact byte-for-byte string for a POST with a JSON body', () => {
    expect(buildStringToSign(baseInput)).toBe(
      [
        'POST',
        '*/*',
        '',
        JSON_CONTENT_TYPE,
        '',
        `x-ca-key:${CSDN_APP_KEY}`,
        `x-ca-nonce:${NONCE}`,
        SAVE_PATH
      ].join('\n')
    )
  })

  it('defaults accept to */* when the caller omits it, which is every call we make', () => {
    const { accept: _ignored, ...withoutAccept } = baseInput
    expect(buildStringToSign(withoutAccept).split('\n')[1]).toBe('*/*')
  })

  it('builds the GET form with an empty contentType line so bodyless reads sign the same way', () => {
    expect(buildStringToSign({ method: 'GET', uri: CATEGORY_PATH, nonce: NONCE, appKey: CSDN_APP_KEY })).toBe(
      ['GET', '*/*', '', '', '', `x-ca-key:${CSDN_APP_KEY}`, `x-ca-nonce:${NONCE}`, CATEGORY_PATH].join('\n')
    )
  })

  it('keeps the blank line between accept and contentType because the gateway counts the lines', () => {
    const lines = buildStringToSign(baseInput).split('\n')
    expect(lines).toHaveLength(8)
    expect(lines[1]).toBe('*/*')
    expect(lines[2]).toBe('')
    expect(lines[3]).toBe(JSON_CONTENT_TYPE)
  })

  it('carries the x-ca-key and x-ca-nonce lines because omitting either yields 401', () => {
    const lines = buildStringToSign(baseInput).split('\n')
    expect(lines[5]).toBe(`x-ca-key:${CSDN_APP_KEY}`)
    expect(lines[6]).toBe(`x-ca-nonce:${NONCE}`)
  })

  it('leaves the date line empty by default, since we never send a Date header', () => {
    expect(buildStringToSign(baseInput).split('\n')[4]).toBe('')
  })

  it('places a custom date on that line, so a caller that does send Date still signs correctly', () => {
    const date = 'Wed, 21 Oct 2015 07:28:00 GMT'
    expect(buildStringToSign({ ...baseInput, date }).split('\n')[4]).toBe(date)
  })

  it('passes the uri through verbatim, query string and percent-encoding included', () => {
    const uri = '/blog-console-api/v1/x?id=7&title=%E4%B8%AD%E6%96%87'
    expect(buildStringToSign({ ...baseInput, uri }).split('\n')[7]).toBe(uri)
  })
})

describe('sign', () => {
  it('produces the same base64 for a fixed nonce/appKey/appSecret/uri every time', () => {
    expect(sign({ ...baseInput, appSecret: CSDN_APP_SECRET })).toBe(SIG_POST_SAVE)
    expect(sign({ ...baseInput, appSecret: CSDN_APP_SECRET })).toBe(SIG_POST_SAVE)
  })

  it('signs the GET form to a hardcoded value too, so the accept/contentType defaults stay pinned', () => {
    expect(
      sign({ method: 'GET', uri: CATEGORY_PATH, nonce: NONCE, appKey: CSDN_APP_KEY, appSecret: CSDN_APP_SECRET })
    ).toBe(SIG_GET_CATEGORY)
  })

  it('changes when only the nonce changes, which is what makes a replay useless', () => {
    const other = sign({ ...baseInput, nonce: 'a-different-nonce', appSecret: CSDN_APP_SECRET })
    expect(other).not.toBe(SIG_POST_SAVE)
  })

  it('is HMAC-SHA256(appSecret, buildStringToSign(input)) base64-encoded', () => {
    const expected = createHmac('sha256', CSDN_APP_SECRET)
      .update(buildStringToSign(baseInput))
      .digest('base64')
    expect(sign({ ...baseInput, appSecret: CSDN_APP_SECRET })).toBe(expected)
  })

  it('changes when the appSecret changes, so a wrong secret cannot accidentally verify', () => {
    expect(sign({ ...baseInput, appSecret: 'wrong-secret' })).not.toBe(SIG_POST_SAVE)
  })
})

describe('buildSignHeaders', () => {
  it('sends the literal X-Ca-Signature-Headers value the gateway folds into the signature', () => {
    const headers = buildSignHeaders({ method: 'GET', path: CATEGORY_PATH, appKey: CSDN_APP_KEY, appSecret: CSDN_APP_SECRET, nonce: 'n-1' })
    expect(headers['X-Ca-Signature-Headers']).toBe('x-ca-key,x-ca-nonce')
    expect(SIGNATURE_HEADERS).toBe('x-ca-key,x-ca-nonce')
  })

  it('echoes the nonce in X-Ca-Nonce, because the gateway re-signs with the header value', () => {
    const headers = buildSignHeaders({ method: 'GET', path: CATEGORY_PATH, appKey: CSDN_APP_KEY, appSecret: CSDN_APP_SECRET, nonce: 'n-1' })
    expect(headers['X-Ca-Nonce']).toBe('n-1')
    expect(headers.nonce).toBe('n-1')
  })

  it('generates a random UUID nonce when none is injected, so no two calls share one', () => {
    const first = buildSignHeaders({ method: 'GET', path: CATEGORY_PATH, appKey: CSDN_APP_KEY, appSecret: CSDN_APP_SECRET })
    const second = buildSignHeaders({ method: 'GET', path: CATEGORY_PATH, appKey: CSDN_APP_KEY, appSecret: CSDN_APP_SECRET })
    expect(first['X-Ca-Nonce']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(first['X-Ca-Nonce']).not.toBe(second['X-Ca-Nonce'])
  })

  it('signs with the generated nonce, so the header and the signature cannot disagree', () => {
    const headers = buildSignHeaders({ method: 'GET', path: CATEGORY_PATH, appKey: CSDN_APP_KEY, appSecret: CSDN_APP_SECRET })
    const expected = sign({
      method: 'GET',
      uri: CATEGORY_PATH,
      accept: '*/*',
      contentType: '',
      nonce: headers['X-Ca-Nonce'],
      appKey: CSDN_APP_KEY,
      appSecret: CSDN_APP_SECRET
    })
    expect(headers['X-Ca-Signature']).toBe(expected)
  })

  it('echoes the app key in X-Ca-Key and X-Ca-Key only', () => {
    const headers = buildSignHeaders({ method: 'GET', path: CATEGORY_PATH, appKey: 'app-key-1', appSecret: CSDN_APP_SECRET, nonce: 'n-1' })
    expect(headers['X-Ca-Key']).toBe('app-key-1')
    expect(headers['X-Ca-Key']).not.toBe(CSDN_APP_KEY)
  })

  it('defaults X-Ca-Timestamp to Date.now() in milliseconds as a string', () => {
    const before = Date.now()
    const headers = buildSignHeaders({ method: 'GET', path: CATEGORY_PATH, appKey: CSDN_APP_KEY, appSecret: CSDN_APP_SECRET, nonce: 'n-1' })
    const timestamp = Number(headers['X-Ca-Timestamp'])
    expect(headers['X-Ca-Timestamp']).toMatch(/^\d+$/)
    expect(timestamp).toBeGreaterThanOrEqual(before)
    expect(timestamp).toBeLessThanOrEqual(Date.now())
  })

  it('accepts an injected timestamp so tests and replays are deterministic', () => {
    const headers = buildSignHeaders({ method: 'GET', path: CATEGORY_PATH, appKey: CSDN_APP_KEY, appSecret: CSDN_APP_SECRET, nonce: 'n-1', timestamp: 1_700_000_000_000 })
    expect(headers['X-Ca-Timestamp']).toBe('1700000000000')
  })

  it('includes the query string in the signed uri, which is the 401 trap when it is dropped', () => {
    const headers = buildSignHeaders({
      method: 'GET',
      path: CATEGORY_PATH,
      query: 'a=1&b=2',
      appKey: CSDN_APP_KEY,
      appSecret: CSDN_APP_SECRET,
      nonce: 'n-1',
      timestamp: 1_700_000_000_000
    })
    expect(headers.uri).toBe(`${CATEGORY_PATH}?a=1&b=2`)
    expect(headers['X-Ca-Signature']).toBe(SIG_HEADERS_WITH_QUERY)
  })

  it('signs the bare path when there is no query, since a stray "?" also yields 401', () => {
    const headers = buildSignHeaders({ method: 'GET', path: CATEGORY_PATH, appKey: CSDN_APP_KEY, appSecret: CSDN_APP_SECRET, nonce: 'n-1' })
    expect(headers.uri).toBe(CATEGORY_PATH)
  })

  it('treats an empty query string as no query, so an empty filter cannot add a "?"', () => {
    const headers = buildSignHeaders({ method: 'GET', path: CATEGORY_PATH, query: '', appKey: CSDN_APP_KEY, appSecret: CSDN_APP_SECRET, nonce: 'n-1' })
    expect(headers.uri).toBe(CATEGORY_PATH)
  })

  it('produces the full POST save header set for a fixed nonce and timestamp', () => {
    const headers = buildSignHeaders({
      method: 'POST',
      path: SAVE_PATH,
      contentType: JSON_CONTENT_TYPE,
      appKey: CSDN_APP_KEY,
      appSecret: CSDN_APP_SECRET,
      nonce: 'fixed',
      timestamp: 1
    })
    expect(headers).toEqual({
      'X-Ca-Key': CSDN_APP_KEY,
      'X-Ca-Nonce': 'fixed',
      'X-Ca-Timestamp': '1',
      'X-Ca-Signature': SIG_HEADERS_SAVE,
      'X-Ca-Signature-Headers': 'x-ca-key,x-ca-nonce',
      nonce: 'fixed',
      uri: SAVE_PATH
    })
  })

  it('folds an explicit accept value into the signature instead of the default', () => {
    const headers = buildSignHeaders({
      method: 'GET',
      path: CATEGORY_PATH,
      accept: 'application/json',
      appKey: CSDN_APP_KEY,
      appSecret: CSDN_APP_SECRET,
      nonce: 'n-1'
    })
    const expected = sign({
      method: 'GET',
      uri: CATEGORY_PATH,
      accept: 'application/json',
      contentType: '',
      nonce: 'n-1',
      appKey: CSDN_APP_KEY,
      appSecret: CSDN_APP_SECRET
    })
    expect(headers['X-Ca-Signature']).toBe(expected)
  })

  it('uses a non-empty contentType when given, since bizapi re-signs the body type too', () => {
    const withType = buildSignHeaders({ method: 'POST', path: SAVE_PATH, contentType: 'text/plain', appKey: CSDN_APP_KEY, appSecret: CSDN_APP_SECRET, nonce: 'n-1' })
    const withoutType = buildSignHeaders({ method: 'POST', path: SAVE_PATH, appKey: CSDN_APP_KEY, appSecret: CSDN_APP_SECRET, nonce: 'n-1' })
    expect(withType['X-Ca-Signature']).not.toBe(withoutType['X-Ca-Signature'])
  })
})

describe('exported CSDN constants', () => {
  it('exposes the public app key and secret hardcoded in CSDN own front-end bundle', () => {
    expect(CSDN_APP_KEY).toBe('203803574')
    expect(CSDN_APP_SECRET).toBe('9znpamsyl2c7cdrr9sas0le9vbc3r6ba')
  })
})
