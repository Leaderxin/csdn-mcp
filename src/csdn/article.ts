/**
 * CSDN article console API: save, read, list, delete.
 *
 * Every endpoint, field name and status code below is CSDN's, not ours, and
 * none of them are documented publicly — they were read off the live console
 * API. The surprising ones carry a comment stating the observed behaviour, so
 * that a later "cleanup" cannot quietly reintroduce a bug that publishes an
 * article the author never reviewed.
 */

import type { CsdnConfig } from '../core/config.js'
import { CsdnError } from '../core/errors.js'
import { unwrapEnvelope, type CsdnEnvelope, type CsdnHttpClient } from '../core/http.js'
import { createLogger, type Logger } from '../core/logger.js'
import {
  articleStateFromCode,
  articleUrl,
  type ArticleDetail,
  type ArticleListPage,
  type ArticleListScope,
  type ArticleSummary,
  type DeleteArticleResult,
  type SaveArticleInput,
  type SaveArticleResult
} from './types.js'

/** Console endpoint that creates (empty `id`) and updates (existing `id`). */
const SAVE_ARTICLE_PATH = '/blog-console-api/v3/mdeditor/saveArticle'

/** Console endpoint with the full record of one article, draft or published. */
const GET_ARTICLE_PATH = '/blog-console-api/v1/editor/getArticle'

/**
 * Public community endpoint used for listing.
 *
 * It authenticates with `username` alone — no cookie, no signature — but it
 * only ever returns *published* articles. Drafts are invisible here, which is
 * exactly why `get()` (the console API) exists next to it.
 */
const LIST_ARTICLES_PATH = '/community/home-api/v1/get-business-list'

/**
 * The author's own back office list — the only endpoint that shows drafts.
 *
 * Signed and cookie-bearing, unlike `LIST_ARTICLES_PATH` above. Two measured
 * behaviours are relied on here: it pins its page size server-side (it ignores
 * the `size` it is given and echoes its own back), and it reports per-state
 * tallies under `count`.
 */
const CONSOLE_LIST_PATH = '/blog/phoenix/console/v1/article/list'

/** Console endpoint that recycles an article, or deletes it for good. */
const DELETE_ARTICLE_PATH = '/blog/phoenix/console/v1/article/del'

/**
 * `saveArticle` and `del` share one throttle key: CSDN rate-limits them on the
 * same counter, so a delete followed immediately by a save is rejected with
 * "文章频繁发布，请稍后再试" just the same as two saves.
 */
const WRITE_RATE_LIMIT_KEY = 'saveArticle'

/**
 * The `status` codes `saveArticle` accepts, keyed by the caller's intent.
 *
 * 0 is deliberately not in this table. It used to be the v0 draft value, but
 * CSDN now treats `status: 0` as *publish*: the article goes public before the
 * author has seen it, and no API call can revert that — only delete and
 * recreate. Routing the mode through a table makes the dangerous value
 * unrepresentable rather than merely discouraged.
 */
const SAVE_STATUS: Readonly<Record<SaveArticleInput['mode'], number>> = Object.freeze({
  draft: 2,
  publish: 1
})

/**
 * Sent next to `status`. CSDN reads both, and an article whose two flags
 * disagree is rejected with a generic code.
 */
const PUB_STATUS: Readonly<Record<SaveArticleInput['mode'], string>> = Object.freeze({
  draft: 'draft',
  publish: 'publish'
})

/** CSDN silently truncates `Description` beyond 256 characters. */
const MAX_DESCRIPTION_LENGTH = 256

const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

/**
 * `published` keeps the pre-`scope` behaviour byte for byte: the public list is
 * the cheaper call and needs no credentials, so it stays the default and an
 * existing caller sees no change.
 */
const DEFAULT_LIST_SCOPE: ArticleListScope = 'published'

/**
 * Stand-in for a `status` we could not read. It is absent from
 * `ARTICLE_STATE_BY_CODE`, so it resolves to `'unknown'` — never to `0`, which
 * would be reported as `'published'`.
 */
const STATUS_UNKNOWN_CODE = -1

/**
 * Build the exact `saveArticle` payload for one article.
 *
 * Pure and exported so the wire format can be asserted without a client, which
 * matters most for the fields whose *name* is the bug (see `Description`).
 */
export function buildSaveArticleBody(input: SaveArticleInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    // `''` rather than an omitted key: CSDN reads the field positionally and
    // answers 500 when `id` is absent on a create.
    id: input.id ?? '',
    title: input.title,
    // The rendered HTML the reading page shows. CSDN renders `content` and
    // keeps `markdowncontent` only for the editor to reopen.
    content: input.content,
    // All-lowercase, unlike `Description`. Sending the Markdown here is what
    // makes a re-open of the article in the editor lossless.
    markdowncontent: input.markdownContent,
    // Capital D. With a lowercase `description` CSDN drops the field without
    // an error and falls back to the first ~100 characters of the body as the
    // summary, so the mistake is invisible until the published page is read.
    Description: clampDescription(input.description),
    categories: input.categories,
    // Tags travel as one comma-joined string, not as a JSON array.
    tags: input.tags.join(','),
    type: 'original',
    status: SAVE_STATUS[input.mode],
    pubStatus: PUB_STATUS[input.mode],
    // 0 == 未授权转载: the article is stored as CSDN-original and the console
    // shows no 转载 badge.
    authorized_status: 0,
    // Marks the origin as the Markdown editor, which is what keeps
    // `markdowncontent` editable instead of being treated as raw HTML.
    source: 'pc_mdeditor'
  }

  const cover = input.coverImages?.[0]
  if (cover !== undefined && cover !== '') {
    // CSDN stores a single cover. It is sent as a one-element list flagged with
    // `cover_type: 1` (0 means "no cover image").
    body['cover_images'] = [cover]
    body['cover_type'] = 1
  }

  return body
}

/**
 * Clamp rather than reject: CSDN truncates at 256 itself, so an over-long
 * description changes the summary's wording but never the article — failing
 * the whole publish over it would be the worse trade.
 */
function clampDescription(description: string): string {
  return description.length <= MAX_DESCRIPTION_LENGTH
    ? description
    : description.slice(0, MAX_DESCRIPTION_LENGTH)
}

export class ArticleClient {
  private readonly http: CsdnHttpClient
  private readonly config: CsdnConfig
  private readonly logger: Logger

  constructor(deps: { http: CsdnHttpClient; config: CsdnConfig; logger?: Logger }) {
    this.http = deps.http
    // Kept as its own reference rather than read through `http.config`:
    // `createContext` mutates the shared config object in place when the cookie
    // changes, and `userName` / `blogBase` here must follow the same object.
    this.config = deps.config
    // Defaults to stderr — stdout belongs to the MCP stdio transport.
    this.logger = deps.logger ?? createLogger({ level: deps.config.logLevel })
  }

  /**
   * Create (empty `id`) or update an article.
   *
   * The returned URL is where the article *would* live; it is not evidence that
   * CSDN accepted it. Only `verifyArticle` may claim that.
   */
  async save(input: SaveArticleInput): Promise<SaveArticleResult> {
    const body = buildSaveArticleBody(input)
    this.logger.debug('saving article', { id: body['id'], mode: input.mode, tagCount: input.tags.length })

    const envelope = await this.http.request<CsdnEnvelope<unknown>>({
      method: 'POST',
      path: SAVE_ARTICLE_PATH,
      body,
      rateLimitKey: WRITE_RATE_LIMIT_KEY,
      minIntervalMs: this.config.saveIntervalMs
    })
    const data = unwrapEnvelope<unknown>(envelope, SAVE_ARTICLE_PATH)

    // Two different success shapes, both HTTP 200 with code 200: creating an
    // article answers with an object (`{ id, url, qrcode, … }`), while updating
    // an existing one answers with the bare string `'成功'` and no id at all.
    const record = isRecord(data) ? data : { data }
    const id = asText(record['id']) || (input.id ?? '')
    if (id === '') {
      throw new CsdnError('MALFORMED_RESPONSE', 'saveArticle 报告成功但没有返回文章 id，无法定位新建的文章', {
        // `?? null` because `JSON.stringify(undefined)` is `undefined`, not a string.
        detail: JSON.stringify(data ?? null).slice(0, 200)
      })
    }

    return {
      id,
      // Only the create shape carries a URL; on an update it has to be rebuilt
      // from the account name and the id we already had.
      url: asText(record['url']) || articleUrl(this.config.userName, id, this.config.blogBase),
      raw: record
    }
  }

  /** The full console record of one article — the only way to see a draft. */
  async get(articleId: string): Promise<ArticleDetail> {
    const requestedId = requireArticleId(articleId, 'getArticle')

    const envelope = await this.http.request<CsdnEnvelope<unknown>>({
      method: 'GET',
      path: GET_ARTICLE_PATH,
      query: { id: requestedId }
    })
    const record = asRecord(unwrapEnvelope<unknown>(envelope, GET_ARTICLE_PATH))
    const statusCode = toStatusCode(record['status'])

    // The payload's own id wins over the argument: `getArticle` names the field
    // `article_id` (older responses use `id`) and CSDN will serve an article
    // whose id differs from the one asked for. Echoing the argument would hide
    // exactly that mismatch.
    const payloadId = asText(record['article_id']) || asText(record['id'])
    const id = payloadId === '' ? requestedId : payloadId

    return {
      id,
      title: asText(record['title']),
      state: articleStateFromCode(statusCode),
      statusCode,
      // CSDN's moderation reason, verbatim — empty when the article is clean.
      reason: asText(record['reason']),
      // Capital D on the way in, capital D on the way out.
      description: asText(record['Description']),
      tags: splitTags(record['tags']),
      categories: asText(record['categories']),
      markdownContent: asText(record['markdowncontent']),
      htmlContent: asText(record['content']),
      coverImages: asStringList(record['cover_images']),
      url: articleUrl(this.config.userName, id, this.config.blogBase),
      postTime: asText(record['postTime']),
      // `viewCount` is the field the current console returns; `readCount` is the
      // legacy name that older payloads still carry. Prefer the current one and
      // fall back only when it is missing — a real 0 must stay 0.
      viewCount: asCount(record['viewCount'] ?? record['readCount']),
      raw: record
    }
  }

  /**
   * One page of *published* articles from the public community API.
   *
   * Drafts never appear here — the community API has no notion of them — so a
   * caller that must see a draft has to use `get()` on its id.
   */
  async list(
    params: { page?: number; pageSize?: number; scope?: ArticleListScope } = {}
  ): Promise<ArticleListPage> {
    const page = params.page ?? DEFAULT_PAGE
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE
    const scope = params.scope ?? DEFAULT_LIST_SCOPE
    // `!(x >= 1)` rather than `x < 1` so that NaN is rejected too. Integer-ness
    // is already enforced by the tool layer's zod schema.
    if (!(page >= 1)) {
      throw new CsdnError('INVALID_ARGUMENT', `page 必须 >= 1，收到 ${page}`)
    }
    if (!(pageSize >= 1) || pageSize > MAX_PAGE_SIZE) {
      throw new CsdnError('INVALID_ARGUMENT', `pageSize 必须在 1..${MAX_PAGE_SIZE} 之间，收到 ${pageSize}`)
    }
    if (scope !== 'published' && scope !== 'all') {
      throw new CsdnError('INVALID_ARGUMENT', `scope 只能是 published 或 all，收到 ${String(scope)}`)
    }

    return scope === 'all' ? this.listFromConsole(page, pageSize) : this.listPublished(page, pageSize)
  }

  /**
   * The public community list: published articles only, no cookie, no signature.
   *
   * Drafts never appear here — that is the endpoint's nature, not a bug — which
   * is why `listFromConsole` exists and why `get` takes an id.
   */
  private async listPublished(page: number, pageSize: number): Promise<ArticleListPage> {
    const envelope = await this.http.request<CsdnEnvelope<unknown>>({
      method: 'GET',
      // Absolute URL from `communityBase`, not the relative path: every request
      // that reaches the bizapi gateway must carry X-Ca-Signature, and this
      // call is deliberately unsigned. The community endpoints are served by
      // the public blog origin, which is the origin `communityBase` holds.
      path: `${this.config.communityBase}${LIST_ARTICLES_PATH}`,
      query: { page, size: pageSize, businessType: 'blog', username: this.config.userName },
      // Public endpoint: it authenticates with `username` alone. Attaching the
      // cookie or an X-Ca-* signature to it makes CSDN answer 403.
      signed: false,
      requireAuth: false
    })
    const record = asRecord(unwrapEnvelope<unknown>(envelope, LIST_ARTICLES_PATH))
    const entries = record['list']

    return {
      // An account with nothing published answers without a `list` key at all.
      items: Array.isArray(entries) ? entries.map(toArticleSummary) : [],
      page,
      pageSize,
      total: asCount(record['total']),
      scope: 'published'
    }
  }

  /**
   * The author console: every state, drafts included. Signed and cookie-bearing,
   * because it is the author's own back office rather than a public feed.
   *
   * Two measured quirks live here, both verified 2026-09:
   *
   *  - The endpoint pins the page size server-side and **ignores the `size` it
   *    is given** (requesting 5 returned 20). The response echoes its own
   *    `size`, so that echo is reported as `pageSize`: the caller is told what
   *    it actually got rather than what it asked for.
   *  - Its per-state tallies arrive under `count`, which is the only way to ask
   *    "how many drafts do I have" without paging through everything.
   */
  private async listFromConsole(page: number, pageSize: number): Promise<ArticleListPage> {
    const envelope = await this.http.request<CsdnEnvelope<unknown>>({
      method: 'GET',
      path: CONSOLE_LIST_PATH,
      query: { page, size: pageSize }
    })
    const record = asRecord(unwrapEnvelope<unknown>(envelope, CONSOLE_LIST_PATH))
    const entries = record['list']
    const counts = toCounts(record['count'])
    const effectivePageSize = toCount(record['size'])

    return {
      items: Array.isArray(entries) ? entries.map(entry => toConsoleSummary(entry, this.config)) : [],
      page: toCount(record['page']) || page,
      // Fall back to the request only when the server declined to echo one.
      pageSize: effectivePageSize > 0 ? effectivePageSize : pageSize,
      total: toCount(record['total']),
      scope: 'all',
      ...(counts === undefined ? {} : { counts })
    }
  }

  /**
   * Delete an article. `permanent` false (the default) moves it to the recycle
   * bin; true destroys it.
   */
  async remove(articleId: string, permanent = false): Promise<DeleteArticleResult> {
    const id = requireArticleId(articleId, 'delArticle')
    // Only an explicit `true` deletes for good. A truthy value arriving from a
    // tool layer must never turn a recycle-bin move into an irreversible loss.
    const deep = permanent === true

    const envelope = await this.http.request<CsdnEnvelope<unknown>>({
      method: 'POST',
      path: DELETE_ARTICLE_PATH,
      body: { articleId: id, deep },
      rateLimitKey: WRITE_RATE_LIMIT_KEY,
      minIntervalMs: this.config.saveIntervalMs
    })
    // A delete answers with an envelope like everything else: HTTP 200 carrying
    // `code: 4004` for an article that is already gone must not read as success.
    unwrapEnvelope<unknown>(envelope, DELETE_ARTICLE_PATH)

    return { articleId: id, permanent: deep }
  }
}

/**
 * `get` and `remove` both address an article by id, and an empty id is rejected
 * before any request: CSDN answers a missing id with a generic 500 that says
 * nothing about the real mistake.
 */
function requireArticleId(articleId: string, operation: string): string {
  const trimmed = articleId.trim()
  if (trimmed === '') {
    throw new CsdnError('INVALID_ARGUMENT', `${operation} 需要一个非空的文章 id`)
  }
  return trimmed
}

/** `typeof null === 'object'`, and arrays are not keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read a payload that should be a record, degrading to `{}` when it is not. */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** Ids arrive as either a string or a number depending on the endpoint. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

/** Counters are numbers when present; a missing counter is 0, never NaN. */
function asCount(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

/**
 * Counters for the console payloads, which quote their numbers.
 *
 * The author console sends `viewCount: "1"`, `status: "2"`, `size: 20` as
 * **strings**, while the public community list sends real numbers. `asCount`
 * deliberately treats a string as absent — correct for the public payload, and
 * silently zero for every console counter — so console fields go through this
 * instead. Verified against the live payload: quoting every counter to 0 is the
 * kind of bug that reads as "no views yet" rather than as a failure.
 */
function toCount(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

/**
 * Parse the `status` field. `articleStateFromCode` accepts a string because
 * some console responses quote the code, so the quoting is undone here.
 */
function toStatusCode(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isNaN(parsed) ? STATUS_UNKNOWN_CODE : parsed
  }
  return STATUS_UNKNOWN_CODE
}

/**
 * `tags` is a comma-joined string on every read endpoint ("MCP,CSDN") and CSDN
 * sometimes leaves a trailing comma, which must not become an empty tag.
 */
function splitTags(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map(tag => tag.trim())
    .filter(tag => tag !== '')
}

/**
 * Normalise a list of URLs. CSDN is loose about element types across console
 * versions, so an entry that is not a non-empty string is dropped rather than
 * stringified — a caller receiving `coverImages` must be able to trust that
 * every element is a URL.
 */
function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/** Map one community-list row. Field names are the community API's. */
function toArticleSummary(entry: unknown): ArticleSummary {
  const record = asRecord(entry)
  return {
    // A string here, a number on the console API.
    id: asText(record['articleId']),
    title: asText(record['title']),
    // Absolute, already including the account path.
    url: asText(record['url']),
    description: asText(record['description']),
    tags: splitTags(record['tags']),
    postTime: asText(record['postTime']),
    viewCount: asCount(record['viewCount']),
    diggCount: asCount(record['diggCount']),
    collectCount: asCount(record['collectCount']),
    commentCount: asCount(record['commentCount']),
    raw: record
  }
}

/**
 * Map one entry from the author console list.
 *
 * This is deliberately a separate mapper from `toArticleSummary`: the console
 * sends a different shape. There is no `url`, no `tags` and no `description`,
 * every counter is a **quoted** number, and only here does a `status` come back.
 * The URL is rebuilt from the account name so that a console row is still
 * something you can open and check.
 */
function toConsoleSummary(entry: unknown, config: CsdnConfig): ArticleSummary {
  const record = asRecord(entry)
  const id = asText(record['articleId'])
  const statusCode = toStatusCode(record['status'])
  return {
    id,
    title: asText(record['title']),
    // Keep the endpoint's own url if CSDN ever adds one; build it otherwise.
    url: asText(record['url']) || articleUrl(config.userName, id, config.blogBase),
    // The console list carries neither, and inventing them would be worse than
    // reporting them empty — `get` has the real description when it matters.
    description: '',
    tags: [],
    postTime: asText(record['postTime']),
    viewCount: toCount(record['viewCount']),
    diggCount: toCount(record['diggCount']),
    collectCount: toCount(record['collectCount']),
    commentCount: toCount(record['commentCount']),
    statusCode,
    state: articleStateFromCode(statusCode),
    raw: record
  }
}

/**
 * CSDN's per-state tallies (`count: { all, draft, publish, deleted, ... }`).
 *
 * `undefined` when the field is absent, so the caller omits the key entirely
 * rather than reporting `{}` — an empty object would read as "zero drafts"
 * instead of "this endpoint did not say".
 */
function toCounts(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) out[key] = toCount(entry)
  return out
}
