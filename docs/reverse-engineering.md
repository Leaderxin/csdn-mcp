# Reverse engineering: which CSDN endpoints still work

Probed 2026-09-24 against the live API with a real account cookie, to answer one
question: **which endpoints can serve the author's category list and tag list?**

This document is evidence, not narration. Every row in the tables below is an
observed HTTP status and body; nothing here is inferred from a blog post or from
v0's source.

## 1. Method (and what the probe was allowed to do)

* Read-only. `GET`, plus `POST` with an empty JSON body (`{}`). No `saveArticle`,
  no publish, no delete, no upload.
* One request roughly every 400 ms, never more than ~2.5 req/s.
* The cookie came from `/opt/data/.env` inside the probe process. It is never
  printed, logged, or written into this repository, and no response body
  contained it.
* Signing reuses `src/core/signer.ts` (`buildSignHeaders`) — the recipe is not
  re-derived here.
* Bundle discovery: `https://editor.csdn.net/md/` and `https://mp.csdn.net/` were
  fetched and their JavaScript bundles grepped for endpoint names. The bundles
  are public static assets (`csdnimg.cn/release/...`).

Probe scripts live outside the repo, under `/opt/data/cache/scratch/`
(`probe.ts`, `probe3.ts`…`probe8.ts`, `discover.ts`).

## 2. How to read a failure: the gateway has three different "404"s

Distinguishing these three turned a guessing game into a search:

| Observed body | Meaning |
|---|---|
| `<html><title>404 Not Found</title>…openresty…` (HTTP **404**) | The path is **not registered** on the `bizapi.csdn.net` gateway. Nothing to do with your cookie or method. |
| `{"timestamp":…,"status":404,"error":"Not Found","path":"/phoenix/console/v1/…"}` (HTTP 404) | The gateway route **exists** and forwards to the phoenix backend, but the backend has no handler for it. Note the printed `path`: `/blog-console-api/…` is rewritten to `/phoenix/console/…`. |
| `{"code":404,"message":"请求路径不存在[/mp/ch/phoenix/…]","data":null}` (HTTP 404) | A *different* backend mount. `/phoenix/**` on the gateway reaches a service whose paths start `/mp/ch/phoenix/**` — no handler at this path. |

Correction to `docs/ARCHITECTURE.md` and `src/core/http.ts`: the openresty page
arrives with **HTTP 404**, not HTTP 200. The *symptom* is identical — the body is
`text/html`, so `parseJsonBody` raises `MALFORMED_RESPONSE` — but a probe that
trusted "HTTP 200 means the endpoint moved" would have been misled. The
`MALFORMED_RESPONSE` taxonomy already covers this correctly.

## 3. Every endpoint probed

All rows below used the real cookie and full `X-Ca-*` signing. "openresty" means
the HTML 404 page from §2.

### 3.1 The candidate list from the task (13 paths × GET and POST)

| Method | Path | Status | Body | Verdict |
|---|---|---|---|---|
| GET / POST | `/blog-console-api/v3/blog/list` | 404 | openresty | **dead** — v0's endpoint; this is how `list-categories`/`list-tags` silently rotted |
| GET / POST | `/blog-console-api/v3/blog/getArticleList` | 404 | openresty | dead |
| GET / POST | `/blog-console-api/v1/editor/getArticleList` | 404 | phoenix JSON 404 | route exists, no handler |
| GET / POST | `/blog-console-api/v1/editor/getCategory` | 404 | openresty | dead |
| GET / POST | `/blog-console-api/v1/category/getCategoryList` | 404 | openresty | dead |
| GET / POST | `/blog-console-api/v2/blog/getColumnList` | 404 | openresty | dead |
| GET / POST | `/blog-console-api/v1/tag/list` | 404 | openresty | dead |
| GET / POST | `/blog-console-api/v3/blog/getTagList` | 404 | openresty | dead |
| GET / POST | `/blog-console-api/v1/editor/getUserTags` | 404 | openresty | dead |
| GET / POST | `/blog-console-api/v1/editor/getTags` | 404 | openresty | dead |
| GET / POST | `/blog-console-api/v1/mdeditor/getTagList` | 404 | openresty | dead |
| GET / POST | `/blog-console-api/v3/mdeditor/getTagList` | 404 | openresty | dead |
| GET / POST | `/phoenix/console/v1/article/tag/getAllTags` | 404 | envelope `请求路径不存在[/mp/ch/phoenix/console/v1/article/tag/getAllTags]` | backend reachable, path wrong |

Not one of them works. The task's fallback idea — the public community API — was
also checked: `GET https://blog.csdn.net/community/home-api/v1/get-business-list?page=1&size=20&businessType=blog&username=Leaderxin`
answered **521** on three consecutive attempts with a
`请进行安全验证(Security Verification)` HTML page (WAF challenge). It is not
usable from a server-side client; see §6.

### 3.2 Endpoints recovered from the front-end bundles

Grepping `app.chunk.*.js` (editor) and `mp_v3/index-*.js` (创作中心) produced the
request wrappers verbatim, including the base URL constants:

```js
CFG: { API_BLOG_URL: "https://bizapi.csdn.net/blog-console-api/",
       API_BLOG_NEW_URL: "https://bizapi.csdn.net/blog/" }
getCategoryList:    () => je.get(`${API_BLOG_NEW_URL}phoenix/console/v1/category/get-list`)
getRecommendTags:   e  => je.post(`${API_BLOG_NEW_URL}phoenix/console/v1/tag/get-recommend-tags`, e,
                                  { headers: { "Content-Type": "application/json;" } })
searchRecommendTag: e  => je.post(`${API_BLOG_NEW_URL}phoenix/console/v1/tag/search-recommend-tag`, e, …)
getBaseInfo:        () => je.get(`${API_BLOG_URL}v1/editor/getBaseInfo`)
getArticleList:     e  => je.get(`${API_BLOG_NEW_URL}phoenix/console/v1/article/list`, { params: e })
getQueryCriteria:   () => je.get(`${API_BLOG_URL}v1/article/getQueryCriteriaNew`)
```

Probed results:

| Method | Path | Status | Body | Verdict |
|---|---|---|---|---|
| GET | `/blog/phoenix/console/v1/category/get-list` | 200 | JSON | **works** |
| POST | same | 405 | `{"status":405,"message":"Request method 'POST' not supported","path":"/phoenix/console/v1/category/get-list"}` | GET only |
| POST | `/blog/phoenix/console/v1/tag/get-recommend-tags` body `{}`, `Content-Type: application/json;` | 200 | JSON | **works** |
| POST | same, `Content-Type: application/json; charset=UTF-8` | 200 | JSON | works too (the signature covers whatever value is sent) |
| GET | same | 405 | `Request method 'GET' not supported` | POST only |
| POST | `/blog/phoenix/console/v1/tag/search-recommend-tag` body `{}` | 200 | `{"code":200,…,"data":[]}` | alive, but needs a query; empty body returns nothing |
| GET | `/blog-console-api/v1/editor/getBaseInfo` | 200 | JSON | **works** |
| GET | `/blog-console-api/v3/editor/getBaseInfo` | 200 | identical payload | works (v3 alias) |
| GET | `/blog-console-api/v1/article/getQueryCriteriaNew` | 200 | JSON | **works** |
| GET | `/blog/phoenix/console/v1/article/list?page=1&size=20` | 200 | JSON | works (author's articles, no `tags` field) |
| GET | `/blog-console-api/v1/editor/getArticle?id=1` | 400 | `{"code":400,…,"msg":"该文章不存在或状态异常!"}` | control: the article API is alive |

Two notes on behaviour:

* `POST …/tag/get-recommend-tags` ignores the body: `{}` and `{"keyword":"vue"}`
  style payloads both return the same dictionary. There is no way to ask it for
  "my tags".
* `article/list?page=1&size=30` failed once mid-probe with `data: null` and then
  succeeded on a re-run with the same parameters (no envelope captured). Treat
  the article-list endpoint as occasionally flaky rather than parameter-limited.

## 4. The two working answers, with exact shapes

### 4.1 Author's categories

```
GET https://bizapi.csdn.net/blog-console-api/v1/editor/getBaseInfo
```

```json
{
  "code": 200,
  "traceId": "a08a1ed4-…",
  "data": {
    "name": "Leaderxin",
    "categorys": ["前端", "blog", "项目笔记", "日常笔记", "分布式应用", "算法",
                  "# 排序算法", "# 数据结构", "C#爬虫", "Redis缓存"],
    "can_add_category_num": 15,
    "…": "32 more editor settings (avatar, code_style, plan, image_domain_list…)"
  }
}
```

`data.categorys` is the author's own column list — **exactly** the string
`saveArticle` takes in its `categories` field. `can_add_category_num` (15) says
how many more columns the account may create.

The same names, with ids, come from
`GET /blog-console-api/v1/article/getQueryCriteriaNew`:

```json
{ "code": 200, "data": { "column": [ { "id": 13208888, "title": "前端" }, … ],
                         "date": [2026, 2025, …], "types": {"1": "原创", …} } }
```

### 4.2 Platform taxonomy (fallback only)

```
GET https://bizapi.csdn.net/blog/phoenix/console/v1/category/get-list
```

13 parents, 70 names once flattened: `大数据/云计算` (→ Flink, Hbase, Spark, …),
`算法与数据结构`, `数据科学`, `物联网`, `人工智能`, `操作系统`, `运维`, `测试`,
`音视频开发`, `嵌入式与硬件开发`, `编程语言`, `区块链技术`,
`项目管理与协作工具`.

Each node: `{categoryId, categoryName, categoryEnName, parentCategoryId, childList[]}`,
with `parentCategoryId: null` on the parents. These are CSDN's platform categories,
not the author's columns, which is why `meta.ts` orders them last.

### 4.3 Tags

```
POST https://bizapi.csdn.net/blog/phoenix/console/v1/tag/get-recommend-tags
Content-Type: application/json;   (verbatim, as the console sends it)
Body: {}
```

```json
{
  "code": 200, "message": "success", "traceId": "e0276597-…",
  "data": {
    "common": ["Vue3", "深色模式", "主题切换", "CSS变量", "前端工程化"],
    "list": {
      "推荐": [],
      "Python": ["python", "django", "pygame", "…25 items"],
      "Java": ["eclipse", "java", "tomcat", "…28 items"],
      "编程语言": ["…35 items"],
      "前端": ["…54 items"],
      "…": "42 groups in total"
    },
    "images": ["…"]
  }
}
```

* `data.common` is personalised (those five are drawn from this account's own
  recent posts) and is the most useful part.
* `data.list` is CSDN's grouped tag dictionary: 42 groups, **877 unique tags**,
  9 056 bytes of JSON. With `data.common` counted in, `MetaClient.listTags()`
  returned **882** items live. It returns the whole set; a tool layer that wants a
  shorter payload should cap it there rather than here.
* The endpoint is POST-only (GET → 405) and its `Content-Type` has to match what
  the gateway signs: `application/json;` works, and so does
  `application/json; charset=UTF-8` — but not a value that differs from the
  signed string.

## 5. Public page behaviour (what `verifyArticle` relies on)

Public fetches were cookie-less, as the module does them.

| URL | Attempt 1 | 2 | 3 |
|---|---|---|---|
| `/Leaderxin/article/details/166581085?spm=cb…` (published) | 200 | 521 | 521 |
| `/Leaderxin/article/details/103343553?spm=cb…` (draft, `status=2`) | 404 (round 6) | 521 | 521 |
| `/Leaderxin/article/details/1?spm=cb…` (never existed) | 521 | 521 | 521 |

* **A draft really does 404 publicly** — id 103343553 came from the console list
  with `status: 2` and its public page answered 404. That is the fact behind the
  `expected: 'draft'` rule.
* **521 is real and intermittent** — the same published URL returned 200 first and
  521 twice afterwards, seconds apart, with a `请进行安全验证` challenge page.
  This is why `verifyArticle` retries a 521 instead of reading it as "not public",
  and why it says so in `message` when the retries are exhausted.
* The cache buster (`?spm=cb<timestamp>`) was used on every fetch above. Round 6
  fetched the draft page with and without it (404 vs 521) — the two responses
  differed, which is consistent with the CDN/WAF answering inconsistently, and
  it is cheap insurance against a cached page reporting yesterday's state.

## 6. What could NOT be found

* **No endpoint returns "the tags this author has used".** Neither bundle calls
  anything of the sort, and the console's article list does not carry a `tags`
  field. The only tag sources are the recommendation dictionary (§4.3) and the
  public community API.
* **The public community API is unusable server-side right now.**
  `GET /community/home-api/v1/get-business-list?…&username=Leaderxin` returned
  521 with a WAF challenge on 3/3 attempts. `ArticleClient.list` depends on it, so
  that limitation is worth knowing: from this environment the public list is not
  a viable tag or article source.
* **`tag/search-recommend-tag` needs a parameter we could not identify.** `{}`,
  `{"keyword":"vue"}` and `{"keyWord":"vue"}` all returned `data: []`, so it is
  not a listing fallback and `meta.ts` does not use it.
* **No endpoint returns a combined "categories + tags" payload** (the shape v0's
  `/v3/blog/list` was expected to return). Nothing replaces that single call;
  categories and tags come from two different services.
* `/blog-console-api/**` handlers we found are all `v1` or `v3`; no `v2` path
  under that prefix routed at all.

## 7. What `src/csdn/meta.ts` and `src/csdn/verify.ts` do with this

`MetaClient.listCategories()` — three candidates, in this order:

1. `GET /blog-console-api/v1/editor/getBaseInfo` → `data.categorys`
   (the author's own columns; exactly what `saveArticle` wants).
2. `GET /blog-console-api/v1/article/getQueryCriteriaNew` → `data.column[].title`
   (same names with ids; heavier payload, so ordered second).
3. `GET /blog/phoenix/console/v1/category/get-list` → parent + child names
   (platform taxonomy; only reached when the account has no columns).
4. `BUILTIN_CATEGORIES`, `source: 'builtin'`.

`MetaClient.listTags()` — `POST /blog/phoenix/console/v1/tag/get-recommend-tags`
with `{}` and `Content-Type: application/json;` (the only listing endpoint that
exists), flattened as `data.common` first, then the groups in `data.list`,
de-duplicated; `COMMON_TAGS` with `source: 'builtin'` when it fails.

Both methods swallow every error and log at `debug`: an author choosing a
category must not be blocked by a dead endpoint, and a metadata failure is not
worth an MCP error. An empty result counts as a failure and falls through to the
next candidate — that is how an account with zero columns still gets names to
choose from.

`verifyArticle()` — the two signals and the rules they imply:

| Expected | API state | Public | Verdict |
|---|---|---|---|
| `draft` | `draft` (status 2) | 404 | consistent |
| `draft` | `draft` | ≠404 | not consistent — the article may be visible |
| `draft` | `published`/`reviewing` | any | not consistent — the draft request was not honoured |
| `publish` | `published` (status 0/1) | 200 | consistent |
| `publish` | `reviewing` (status 16) | any | consistent — submitted, not yet public |
| `publish` | `published` | ≠200 | not consistent |
| `publish` | `draft` | any | not consistent — CSDN did not accept the publish |
| either | `rejected` (status 6) | any | never consistent; the moderation reason goes in `message` |
| either | unmapped code | any | never consistent; `message` names the raw `status` |

The public URL is `config.blogBase + '/' + config.userName + '/article/details/' + articleId`
with `?spm=cb<timestamp>` appended, re-stamped on every attempt so a retry cannot
reuse the cached page that produced the 521. A 521 earns two extra attempts 3 s
apart (both injectable); if it is still 521 the message says the public-page
conclusion is unavailable rather than implying the article is unpublished.
`articles.get` failures propagate — without the API record there is no state to
compare, and `consistent: false` would read as a verdict about the article
instead of a failure to look at it.
