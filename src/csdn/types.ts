/**
 * Domain types for CSDN articles.
 *
 * These mirror what the console API actually returns, including the parts that
 * are surprising. Where a value is derived rather than echoed, the comment says
 * how — because the derivation is the part that was learned by experiment.
 */

/** Article lifecycle as CSDN models it. */
export type ArticleState =
  /** Live and publicly readable. */
  | 'published'
  /** Saved in the author console, not publicly reachable. */
  | 'draft'
  /** Submitted and awaiting moderation: public page 404s until it passes. */
  | 'reviewing'
  /** Blocked by moderation (`reason` explains why). */
  | 'rejected'
  /** CSDN returned a state code we have no mapping for. */
  | 'unknown'

/**
 * `status` numbers observed on `GET /blog-console-api/v1/editor/getArticle`.
 *
 * The `0` entry is the trap that motivated this table: the v0 tool sent
 * `status: 0` believing it meant "draft", and CSDN published the article
 * immediately. Any state code not listed here maps to `unknown` rather than
 * being guessed at.
 */
export const ARTICLE_STATE_BY_CODE: Readonly<Record<number, ArticleState>> = Object.freeze({
  0: 'published',
  1: 'published',
  2: 'draft',
  6: 'rejected',
  16: 'reviewing'
})

export function articleStateFromCode(code: number | string | undefined): ArticleState {
  const parsed = typeof code === 'string' ? Number.parseInt(code, 10) : code
  if (parsed === undefined || !Number.isFinite(parsed)) return 'unknown'
  return ARTICLE_STATE_BY_CODE[parsed] ?? 'unknown'
}

/** Public URL of an article. CSDN writes it as `/article/details/{id}`. */
export function articleUrl(userName: string, articleId: string, base = 'https://blog.csdn.net'): string {
  return `${base}/${userName}/article/details/${articleId}`
}

/** Input accepted by `saveArticle`. Field names are CSDN's, not ours. */
export interface SaveArticleInput {
  /** Article id. Empty string creates a new article. */
  id?: string
  title: string
  /** Rendered HTML. Callers pass Markdown to the csdn layer, which renders it. */
  content: string
  /** Markdown source, stored verbatim. */
  markdownContent: string
  /** `Description` on the wire — case matters, lowercase is silently dropped. */
  description: string
  tags: string[]
  categories: string
  /** Absolute image URLs for the cover. */
  coverImages?: string[]
  /** Whether this call publishes or keeps a draft. */
  mode: 'draft' | 'publish'
}

/** What `saveArticle` gives back when it creates an article. */
export interface SaveArticleResult {
  id: string
  url: string
  /** Raw envelope data, for fields we do not model yet. */
  raw: Record<string, unknown>
}

/** Full article record returned by `getArticle`. */
export interface ArticleDetail {
  id: string
  title: string
  state: ArticleState
  statusCode: number
  /** Moderation reason; empty string when the article is clean. */
  reason: string
  description: string
  tags: string[]
  categories: string
  markdownContent: string
  htmlContent: string
  coverImages: string[]
  url: string
  postTime: string
  viewCount: number
  raw: Record<string, unknown>
}

/** One row of the public article list. */
export interface ArticleSummary {
  id: string
  title: string
  url: string
  description: string
  tags: string[]
  postTime: string
  viewCount: number
  diggCount: number
  collectCount: number
  commentCount: number
  /**
   * CSDN's raw `status` code. Only the author console reports it: every article
   * the public list returns is by definition published, so there is nothing to
   * distinguish. Absent (rather than 0) when the endpoint did not say, because
   * `0` is a meaningful code here and would read as `'published'`.
   */
  statusCode?: number
  /** `statusCode` mapped through `articleStateFromCode`. Console only. */
  state?: ArticleState
  raw: Record<string, unknown>
}

/**
 * Which endpoint answers a list call. They see different sets of articles, and
 * the difference is not a detail: the public list cannot show a draft, so it can
 * never answer "which drafts do I have?".
 */
export type ArticleListScope =
  /** The public community endpoint: published articles, no credentials needed. */
  | 'published'
  /** The author console: every state, drafts included. Needs the cookie. */
  | 'all'

export interface ArticleListPage {
  items: ArticleSummary[]
  page: number
  pageSize: number
  total: number
  /** Which endpoint answered, so a caller never has to guess what it sees. */
  scope: ArticleListScope
  /**
   * CSDN's own per-state tallies, reported by the console endpoint only:
   * `{ all, draft, publish, private, deleted, audit, ... }`. This is the only
   * place a draft *count* is available without walking every page.
   */
  counts?: Record<string, number>
}

/** Result of an image upload to the CSDN image host. */
export interface UploadedImage {
  url: string
  /** Object key on the storage backend, useful for logging. */
  key: string
  /** Byte size of the uploaded payload. */
  size: number
  /** MIME type used in the upload signature. */
  mimeType: string
}

/** Which upload channel to use. The two channels are not interchangeable. */
export type ImageKind = 'cover' | 'body'

export interface UploadImageInput {
  /** Local file path. */
  path: string
  kind: ImageKind
}

export interface DeleteArticleResult {
  articleId: string
  /** `true` when the article was removed permanently instead of recycled. */
  permanent: boolean
}

/** Outcome of a post-write verification pass. */
export interface VerificationResult {
  articleId: string
  state: ArticleState
  statusCode: number
  /** HTTP status of the public article page (404 = not public). */
  publicStatusCode: number
  /** `true` when the observed state matches the state the write claimed. */
  consistent: boolean
  /** Human-readable explanation of any mismatch. */
  message: string
}
