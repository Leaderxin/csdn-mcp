# Architecture

> Frozen contract for v1.0.0. Every module below has one owner, one exported
> surface, and one test file. If you need to change an interface listed here,
> change this document in the same commit.

## 1. Layering

```
        ┌───────────────────────────────────────────────┐
        │  src/tools/*        MCP tool definitions      │  zod schemas,
        │                     (one file per domain)     │  text formatting,
        └───────────────────────┬───────────────────────┘  error → isError
                                │  ServerContext
        ┌───────────────────────▼───────────────────────┐
        │  src/csdn/*         CSDN domain logic         │  endpoints, field
        │  article · media · meta · verify · markdown   │  names, state codes
        └───────────────────────┬───────────────────────┘
                                │  CsdnHttpClient
        ┌───────────────────────▼───────────────────────┐
        │  src/core/*         transport + platform      │  signing, retry,
        │  config · signer · http · ratelimit · logger  │  errors, throttling
        │  errors                                       │
        └───────────────────────────────────────────────┘
```

Rules:

1. Imports only point **downwards**. `tools → csdn → core`. `core` imports nothing
   from the layers above it.
2. `core` and `csdn` never import `@modelcontextprotocol/sdk` and never write to
   stdout. stdout belongs to the stdio transport; logs go to stderr.
3. Nothing outside `src/core/config.ts` reads `process.env`.
4. Every module is importable and testable without a network (`fetchImpl`,
   `sleep`, `now` are constructor seams) and without a real MCP host
   (`src/tools/*` exports plain handler functions).

## 2. Module ownership

| File | Owner task | Exports |
|---|---|---|
| `src/core/config.ts` | foundation | `CsdnConfig`, `loadConfig`, `buildConfig`, `validateCookie`, `parseCookie`, `getCookieValue`, `DEFAULT_CONFIG` |
| `src/core/errors.ts` | foundation | `CsdnError`, `CsdnErrorCode`, `isCsdnError`, `toCsdnError` |
| `src/core/signer.ts` | foundation | `buildStringToSign`, `sign`, `buildSignHeaders`, `CSDN_APP_KEY` |
| `src/core/logger.ts` | foundation | `createLogger`, `redact`, `Logger` |
| `src/core/ratelimit.ts` | foundation | `RateLimiter`, `defaultSleep` |
| `src/core/http.ts` | foundation | `CsdnHttpClient`, `unwrapEnvelope`, `parseJsonBody`, `buildQuery` |
| `src/csdn/types.ts` | foundation | domain types, `ARTICLE_STATE_BY_CODE`, `articleStateFromCode`, `articleUrl` |
| `src/csdn/markdown.ts` | media+markdown | `renderMarkdown`, `stripMarkdown`, `deriveDescription`, `parseFrontMatter`, `findImagePlaceholders`, `substituteImagePlaceholders` |
| `src/csdn/media.ts` | media+markdown | `MediaClient`, `resolveMimeType` |
| `src/csdn/article.ts` | article api | `ArticleClient`, `buildSaveArticleBody` |
| `src/csdn/meta.ts` | meta+verify | `MetaClient`, `BUILTIN_CATEGORIES`, `COMMON_TAGS` |
| `src/csdn/verify.ts` | meta+verify | `verifyArticle` |
| `src/context.ts` | foundation | `ServerContext`, `createContext` |
| `src/server.ts` | mcp wiring | `createServer` |
| `src/index.ts` | mcp wiring | bootstrap only — **excluded from coverage** |

## 3. Interfaces (do not change without updating this file)

### `ArticleClient`

```ts
class ArticleClient {
  constructor(deps: { http: CsdnHttpClient; config: CsdnConfig; logger?: Logger })
  save(input: SaveArticleInput): Promise<SaveArticleResult>
  get(articleId: string): Promise<ArticleDetail>
  list(params?: { page?: number; pageSize?: number; scope?: 'published' | 'all' }): Promise<ArticleListPage>
  remove(articleId: string, permanent?: boolean): Promise<DeleteArticleResult>
}
```

* `save` posts to `/blog-console-api/v3/mdeditor/saveArticle`.
  `mode: 'draft'` ⇒ `status: 2` + `pubStatus: 'draft'`.
  `mode: 'publish'` ⇒ `status: 1` + `pubStatus: 'publish'`.
  **Never send `status: 0`** — CSDN treats it as publish. `Description` is
  capitalised, ≤256 chars.
* `save` is throttled with `config.saveIntervalMs` (`rateLimitKey: 'saveArticle'`).
* `get` reads `/blog-console-api/v1/editor/getArticle?id=` and maps `status`
  through `articleStateFromCode`.
* `list` reads the public community API
  `/community/home-api/v1/get-business-list?page&size&businessType=blog&username=` —
  no cookie, published articles only. Drafts are **not** listed; documenting that
  limitation is part of the contract.
* `remove` posts `/blog/phoenix/console/v1/article/del` with
  `{ articleId, deep }`, throttled on the `saveArticle` key.

### `MediaClient`

```ts
class MediaClient {
  constructor(deps: { http: CsdnHttpClient; config: CsdnConfig; logger?: Logger })
  upload(input: UploadImageInput): Promise<UploadedImage>
  uploadBuffer(data: Buffer, kind: ImageKind, fileName: string): Promise<UploadedImage>
}
function resolveMimeType(fileName: string): string
```

Two-step upload, both steps authenticated + signed:

1. `POST /resource-api/v1/image/direct/upload/signature`
   body `{ appName, imageTemplate, imageSuffix }`
   * `kind: 'body'` → `appName: 'direct_blog'`, `imageTemplate: 'standard'`
   * `kind: 'cover'` → `appName: 'direct_blog_coverimage'`, `imageTemplate: ''`
     — the two channels are **not** interchangeable.
   `Content-Type` must be exactly `application/json;charset=UTF-8` (no space)
   and must match the signed value.
2. `POST` multipart to the returned `host` with `key`, `policy`, `signature`,
   `callbackBody`, `callbackBodyType`, plus `AccessKeyId`/`callbackUrl` when
   `provider === 'obs'` and `OSSAccessKeyId`/`callback` otherwise. Every
   `customParam` entry is sent as `x:<key>`. Response `data.imageUrl` is the
   public URL.

Supported types: `.jpg/.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`. Anything else ⇒
`INVALID_ARGUMENT`.

### `MetaClient`

```ts
class MetaClient {
  constructor(deps: { http: CsdnHttpClient; config: CsdnConfig; logger?: Logger })
  listCategories(): Promise<{ items: string[]; source: 'api' | 'builtin' }>
  listTags(): Promise<{ items: string[]; source: 'api' | 'builtin' }>
}
```

The v0 endpoints (`/blog-console-api/v3/blog/list`) are **404**. Implement a
probe list of candidate endpoints; on total failure return the builtin list with
`source: 'builtin'` so the tool degrades instead of erroring. Record every probe
result in `docs/reverse-engineering.md`.

### `verifyArticle`

```ts
function verifyArticle(
  deps: { articles: ArticleClient; http: CsdnHttpClient; config: CsdnConfig },
  articleId: string,
  expected: 'draft' | 'publish'
): Promise<VerificationResult>
```

The implementation accepts an optional superset of `deps` — `sleep`, `now`,
`publicRetries` and `retryDelayMs` — purely as injection seams for the 521 retry
described below. A caller passing only `{ articles, http, config }` is unaffected
and needs no change; the file is the authority on the exact shape.

`consistent` is only true when **both** the API state and the public page agree
with `expected`: draft ⇒ `state: 'draft'` and public HTTP 404; publish ⇒
`state: 'published'` (or `'reviewing'`, which is a legitimate in-flight state) and
public HTTP 200.

### `ServerContext`

```ts
interface ServerContext {
  config: CsdnConfig            // mutable in place, see updateCookie
  logger: Logger
  http: CsdnHttpClient
  articles: ArticleClient
  media: MediaClient
  meta: MetaClient
  updateCookie(cookie: string): { userName: string }
}
function createContext(overrides?: Partial<CsdnConfig>, deps?: Partial<...>): ServerContext
```

`updateCookie` mutates `config` in place so the shared `CsdnHttpClient` (which
holds the same object) picks up the new value immediately.

## 4. Tool surface (frozen)

| Tool | Required params | Optional params | Success payload |
|---|---|---|---|
| `auth_login` | `cookie` | — | username + validity |
| `auth_status` | — | — | configured / valid / username |
| `publish_article` | `title`, `markdown` | `description`, `tags`, `categories`, `cover_image`, `mode`, `verify` | `{ articleId, url, state, verification? }` |
| `update_article` | `article_id` | `title`, `markdown`, `description`, `tags`, `categories`, `cover_image`, `mode` | `{ articleId, url, state }` |
| `get_article` | `article_id` | `include_content` | `ArticleDetail` |
| `list_articles` | — | `page`, `page_size`, `scope` | `ArticleListPage` |
| `delete_article` | `article_id` | `permanent` | `{ articleId, permanent }` |
| `upload_image` | `path`, `kind` | — | `UploadedImage` |
| `list_categories` | — | — | `{ items, source }` |
| `list_tags` | — | — | `{ items, source }` |
| `verify_article` | `article_id` | `expected` | `VerificationResult` |

Rules for every tool handler:

* Validate with zod; reject impossible inputs **before** any network call
  (`tags` ≤ 5, `description` ≤ 256 chars, `markdown` non-empty, `kind ∈ {cover,body}`).
* Return JSON in a `text` content block, prefixed by a one-line human summary.
* Convert `CsdnError` to `{ isError: true, content: [...] }` with the error
  `code` in the text. Never let a raw exception escape — an MCP host will show an
  unusable stack trace.
* `mode` defaults to `'draft'`. Publishing must be an explicit, deliberate act.
* `publish_article` / `update_article` run verification by default (`verify: true`)
  and report the verification result alongside the write result, so a caller is
  never told "published" on the strength of a 200 alone.

## 5. Testing contract

* Runner: **vitest**, `tests/**/*.test.ts`, no live network in `npm test`.
* `tests/helpers/` provides `createFakeFetch(...)` (a scriptable `FetchLike` that
  records requests), `createTestContext(...)`, and JSON fixtures under
  `tests/fixtures/`.
* Coverage thresholds are **100%** for statements/branches/functions/lines over
  `src/**` (excluding `src/index.ts`). `npm run test:coverage` fails the build if
  they are not met — treat a threshold failure as a failing test, not advice.
* `tests/live/**` holds opt-in integration tests (`CSDN_LIVE=1 npm run test:live`).
  They may create and delete drafts, but **must never publish**. They are skipped
  by default.
* Every test name states a behavior, not a function name. `it('sends status: 2
  for drafts because 0 publishes the article')` — the "why" is the test.

## 6. Commit conventions

Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`).
One logical change per commit. Never commit a `.env`, a cookie, or a captured
`Cookie:` header — CI has a `secret-scan` job that fails on a tracked `.env`, a
populated `CSDN_COOKIE` literal, or any `UserToken`/`csrfToken`/`c_session`
assignment with a real-looking value.

## 7. Non-goals for v1.0.0

* Editing the live body of an already-published article through the API. CSDN
  only applies body edits when the editor UI publishes; the API touches the
  draft copy. `update_article` therefore updates metadata + the draft copy and
  says so, rather than pretending.
* Comment, follower or analytics APIs.
* Any browser automation. This server is headless by design.
