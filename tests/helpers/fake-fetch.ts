/**
 * Shared test doubles.
 *
 * `createFakeFetch` is the only seam tests need for HTTP: it records every
 * request (so tests can assert on headers, signatures and bodies) and replies
 * from a script of responses.
 */

import type { FetchLike, HttpResponse } from '../../src/core/http.js'

export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** Parsed JSON body when the request was JSON, else `undefined`. */
  json: unknown
  /** Raw body as passed to fetch. */
  body: unknown
  signal: AbortSignal | null | undefined
}

export interface ResponseSpec {
  status?: number
  /** String is sent verbatim; anything else is JSON.stringified. */
  body?: string | object
  headers?: Record<string, string>
}

export type ResponseScript =
  ResponseSpec | ((request: RecordedRequest, index: number) => ResponseSpec | Promise<ResponseSpec>)

export interface FakeFetch {
  fetch: FetchLike
  requests: RecordedRequest[]
  /** Requests whose URL contains `fragment`. */
  matching(fragment: string): RecordedRequest[]
  last(): RecordedRequest
}

function toHeaders(init: RequestInit): Record<string, string> {
  const raw = init.headers ?? {}
  const out: Record<string, string> = {}
  if (Array.isArray(raw)) {
    for (const entry of raw as Array<[string, string]>) out[entry[0]] = String(entry[1])
  } else if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      out[key] = value
    })
  } else {
    for (const [key, value] of Object.entries(raw as Record<string, string>)) out[key] = String(value)
  }
  return out
}

function makeResponse(spec: ResponseSpec): HttpResponse {
  const status = spec.status ?? 200
  const body =
    typeof spec.body === 'string' ? spec.body : spec.body === undefined ? '' : JSON.stringify(spec.body)
  const headers = spec.headers ?? {}
  return {
    status,
    headers: {
      get: (name: string) => {
        const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
        return found ? found[1] : null
      }
    },
    text: async () => body
  }
}

/**
 * Build a `FetchLike`.
 *
 * Pass one spec per expected call, or a single function that decides per call.
 * When the script runs out, the last spec is reused and an extra call is
 * recorded — tests assert on `requests.length` to catch unexpected traffic.
 */
export function createFakeFetch(...script: ResponseScript[]): FakeFetch {
  const requests: RecordedRequest[] = []
  if (script.length === 0) script = [{ status: 200, body: { code: 200, data: {} } }]

  const fake: FetchLike = async (url, init) => {
    const headers = toHeaders(init)
    let json: unknown
    if (typeof init.body === 'string') {
      try {
        json = JSON.parse(init.body)
      } catch {
        json = undefined
      }
    }
    const recorded: RecordedRequest = {
      url,
      method: init.method ?? 'GET',
      headers,
      json,
      body: init.body,
      signal: init.signal as AbortSignal | null | undefined
    }
    const index = requests.length
    requests.push(recorded)
    const entry = script[Math.min(index, script.length - 1)]
    const spec = typeof entry === 'function' ? await entry(recorded, index) : entry
    return makeResponse(spec ?? {})
  }

  return {
    fetch: fake,
    requests,
    matching: (fragment: string) => requests.filter(request => request.url.includes(fragment)),
    last: () => {
      const last = requests.at(-1)
      if (!last) throw new Error('no request was recorded')
      return last
    }
  }
}

/** A JSON envelope with `code: 200`. */
export function okEnvelope(data: unknown): ResponseSpec {
  return { status: 200, body: { code: 200, data } }
}

/** A JSON envelope carrying a non-200 code (checked before the HTTP status). */
export function apiErrorEnvelope(code: number, msg: string): ResponseSpec {
  return { status: 200, body: { code, msg, data: null } }
}

/** The `openresty` 404 page bizapi serves with HTTP 200 for dead endpoints. */
export function openresty404(): ResponseSpec {
  return { status: 200, body: '<html><head><title>404 Not Found</title></head><body>openresty</body></html>' }
}

/** Collects log lines so tests can assert on level filtering and redaction. */
export function createMemorySink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = []
  return {
    lines,
    sink: (line: string) => {
      lines.push(line)
    }
  }
}
