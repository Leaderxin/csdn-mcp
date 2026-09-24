# 工具参考

v1.0.0 的工具面是**冻结**的（`docs/ARCHITECTURE.md` §4）：11 个工具、参数名、成功返回结构都以那份契约为准。本文逐个写清楚参数、约束、返回和错误码。

## 通用约定

- 参数用 zod 校验，**不可行的输入在任何网络请求之前就被拒绝**，返回 `INVALID_ARGUMENT`。
- 成功返回是一个 `text` 内容块，内容为 JSON，前面有一行人类可读的摘要。
- 失败返回 `{ "isError": true, "content": [...] }`，文本里带错误 `code`。不会把原始异常堆栈丢给 MCP 宿主。
- 所有 `*_article` / `upload_image` / 元数据工具都需要 `CSDN_COOKIE`（`list_articles` 除外，它走公开接口）。
- 字段名是 camelCase（`articleId`、`pageSize`、`publicStatusCode`）。**参数名是 snake_case**（`article_id`、`page_size`、`cover_image`）——这两套命名不要互相套用。

### 通用错误码（所有联网工具都可能返回）

| code | 含义 | 可重试 |
|---|---|---|
| `AUTH_MISSING` | 完全没配置 Cookie | 否 |
| `AUTH_INVALID` | Cookie 无效、缺 `UserToken`、或 CSDN 返回 401/403 | 否 |
| `NETWORK` | DNS / TCP / TLS / 请求被中断 | 是 |
| `TIMEOUT` | 超过 `CSDN_TIMEOUT_MS` | 是 |
| `HTTP_ERROR` | 非 2xx，且不属于鉴权/限流 | 否 |
| `MALFORMED_RESPONSE` | 2xx 但响应体不是预期的 JSON 信封 | 否 |
| `API_ERROR` | JSON 信封里 `code !== 200` | 否 |
| `RATE_LIMITED` | 被限流（`文章频繁发布，请稍后再试` / HTTP 429） | 是 |
| `SERVER_ERROR` | CSDN 侧 5xx | 是 |
| `NOT_FOUND` | 文章/资源不存在（HTTP 404 或信封 `404` / `4004`） | 否 |
| `INVALID_ARGUMENT` | 入参违反 CSDN 的约束 | 否 |
| `VERIFY_FAILED` | 写操作的**自检**结果与写入方的成功声明不一致 | 否 |

`NETWORK` / `TIMEOUT` / `RATE_LIMITED` / `SERVER_ERROR` 会自动重试，默认额外 2 次，退避 500ms → 1s → 2s（上限 8s）；`RATE_LIMITED` 的重试等待改用 `CSDN_SAVE_INTERVAL_MS`。

---

## auth_login

运行期设置 Cookie。成功后，后续所有请求立即使用新 Cookie——`ServerContext.updateCookie` 就地修改共享的配置对象，不需要重启 MCP 进程。

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `cookie` | string | 是 | 整段 `Cookie` 头，必须含 `UserToken=`；建议同时含 `UserName=` |

**成功返回**

```json
{ "userName": "Leaderxin", "valid": true }
```

**错误码**

`INVALID_ARGUMENT`（Cookie 为空、缺 `UserToken`、或找不到 `UserName`）。结构校验完全在本地完成，不发任何请求，因此不会返回 `NETWORK` / `TIMEOUT` / `AUTH_INVALID`。

**示例**

```json
{ "name": "auth_login", "arguments": { "cookie": "UserToken=eyJ...; UserName=Leaderxin; ..." } }
```

> Cookie 里没有 `UserName` 时，本地校验会判为无效（多半是复制不完整）。如果确实拿不到 `UserName`，用环境变量 `CSDN_USERNAME` 兜底，而不是改 Cookie 字符串。

---

## auth_status

报告当前认证状态。不发网络请求。

**参数**：无。

**成功返回**

```json
{
  "configured": true,
  "valid": true,
  "username": "Leaderxin"
}
```

`configured: false` 表示 `CSDN_COOKIE` 为空；`valid: false` 时返回值里会带原因（例如缺少 `UserToken`）。

**错误码**：无。

**示例**

```json
{ "name": "auth_status", "arguments": {} }
```

---

## publish_article

新建一篇文章。

> **`mode` 默认 `"draft"`，发布必须显式传 `mode: "publish"`。**
> 这不是保守，是踩过坑：CSDN 把 `status: 0` 当**发布**处理，v0 拿它当草稿用，用户还没审稿文章就已经公开可见，而且接口无法回退，只能删掉重建。所以 v1 里"发布"必须是一个明确的动作，而不能是省略参数时的默认后果。

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `title` | string | 是 | 文章标题 |
| `markdown` | string | 是 | 非空。**Markdown 源码**：会渲染成 HTML 塞进 `content`，原文同时存进 `markdowncontent` |
| `description` | string | 否 | 摘要，**≤ 256 字**。超过 256 的部分不会上线——写入层会先截断到 256（CSDN 自己也是按 256 截断的） |
| `tags` | string[] | 否 | **最多 5 个**。超过直接 `INVALID_ARGUMENT`（线上会把它拼成逗号连接的字符串） |
| `categories` | string | 否 | 分类名。取 `list_categories` 的返回值 |
| `cover_image` | string | 否 | 封面图 URL，填 `upload_image` 且 `kind: "cover"` 返回的 `url` |
| `mode` | `"draft"` \| `"publish"` | 否 | 默认 `"draft"` |
| `verify` | boolean | 否 | 默认 `true`：写入后回查 API 状态 + 公开页 |

**成功返回**

```json
{
  "articleId": "149234567",
  "url": "https://blog.csdn.net/Leaderxin/article/details/149234567",
  "state": "draft",
  "verification": {
    "articleId": "149234567",
    "state": "draft",
    "statusCode": 2,
    "publicStatusCode": 404,
    "consistent": true,
    "message": "草稿状态与公开页一致（公开页 404）"
  }
}
```

`verification` 在 `verify: false` 时不出现。

**错误码**

`INVALID_ARGUMENT`（`tags` > 5、`markdown` 为空）、`AUTH_MISSING`、`AUTH_INVALID`、`RATE_LIMITED`（两次保存间隔不足）、`API_ERROR`（含 `saveArticle` 没返回文章 id 的情况）、`MALFORMED_RESPONSE`、`VERIFY_FAILED`（写入声称成功但自检不一致），以及上表的通用联网错误码。

**示例**

```json
{
  "name": "publish_article",
  "arguments": {
    "title": "MCP 协议入门",
    "markdown": "# MCP 协议入门\n\n正文……",
    "tags": ["MCP", "TypeScript"],
    "categories": "后端",
    "mode": "draft"
  }
}
```

---

## update_article

更新一篇已有文章。可以只改元数据（标题、标签、摘要、封面），也可以配合 `mode` 把草稿发布出去。

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `article_id` | string | 是 | 文章 ID |
| `title` | string | 否 | 不传则保持原值 |
| `markdown` | string | 否 | 非空（传了就校验） |
| `description` | string | 否 | ≤ 256 字 |
| `tags` | string[] | 否 | ≤ 5 个 |
| `categories` | string | 否 | 分类名 |
| `cover_image` | string | 否 | 封面图 URL |
| `mode` | `"draft"` \| `"publish"` | 否 | 默认 `"draft"` |

**成功返回**

```json
{
  "articleId": "149234567",
  "url": "https://blog.csdn.net/Leaderxin/article/details/149234567",
  "state": "published"
}
```

`update_article` 的参数表里没有 `verify`（见 `docs/ARCHITECTURE.md` §4），但它和 `publish_article` 一样**默认执行写入后自检**。自检不一致时报 `VERIFY_FAILED`。

**错误码**

`INVALID_ARGUMENT`、`NOT_FOUND`、`AUTH_MISSING`、`AUTH_INVALID`、`RATE_LIMITED`、`VERIFY_FAILED`，以及通用联网错误码。

**已知边界**：**已经发布**的文章，正文（`markdown`）改不动。CSDN 只在编辑器 UI 发布时把正文应用到线上，API 改的是草稿副本。见 [FAQ](FAQ.md#能改已经发布的文章吗)。

**示例**

```json
{ "name": "update_article", "arguments": { "article_id": "149234567", "mode": "publish" } }
```

---

## get_article

按 ID 读取一篇文章。这是读取 `status` 原始状态码、确认草稿/发布状态的权威口径。

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `article_id` | string | 是 | 文章 ID |
| `include_content` | boolean | 否 | 是否返回正文 |

**成功返回**（`ArticleDetail`）

```json
{
  "id": "149234567",
  "title": "MCP 协议入门",
  "state": "draft",
  "statusCode": 2,
  "reason": "",
  "description": "一句话摘要",
  "tags": ["MCP", "TypeScript"],
  "categories": "后端",
  "markdownContent": "# MCP 协议入门\n\n...",
  "htmlContent": "<h1>MCP 协议入门</h1>...",
  "coverImages": [],
  "url": "https://blog.csdn.net/Leaderxin/article/details/149234567",
  "postTime": "2026-09-24 08:10:00",
  "viewCount": 0,
  "raw": {}
}
```

`reason` 是审核原因，干净的文章为空字符串。`raw` 是未建模字段的原始信封，用于排查。

**错误码**

`INVALID_ARGUMENT`（`article_id` 为空）、`NOT_FOUND`、`AUTH_MISSING`、`AUTH_INVALID`，以及通用联网错误码。

**示例**

```json
{ "name": "get_article", "arguments": { "article_id": "149234567", "include_content": false } }
```

---

## list_articles

列出**已公开**的文章。走公开社区接口，**不需要 Cookie**。

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `page` | number | 否 | 页码，从 1 开始，默认 `1` |
| `page_size` | number | 否 | 每页条数，默认 `20`，**上限 `100`** |

越界（`page < 1` 或 `page_size > 100`）在发请求之前就被 `INVALID_ARGUMENT` 拦下。

**成功返回**（`ArticleListPage`）

```json
{
  "items": [
    {
      "id": "149234567",
      "title": "MCP 协议入门",
      "url": "https://blog.csdn.net/Leaderxin/article/details/149234567",
      "description": "一句话摘要",
      "tags": ["MCP", "TypeScript"],
      "postTime": "2026-09-24 08:10:00",
      "viewCount": 128,
      "diggCount": 4,
      "collectCount": 7,
      "commentCount": 2,
      "raw": {}
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1
}
```

**错误码**

`INVALID_ARGUMENT`（分页参数越界）、`MALFORMED_RESPONSE`、`API_ERROR`、`HTTP_ERROR`、`NETWORK`、`TIMEOUT`、`SERVER_ERROR`。

**重要限制**：**草稿不会出现在这里**。公开接口只列已发布内容，这是接口本身的性质，不是过滤参数。刚保存的草稿查不到属于预期行为，要用 `get_article` 按 ID 查。另外这个接口是匿名的——服务侧**不会**给它带 Cookie 或签名，带上反而会被拒（403）。

**示例**

```json
{ "name": "list_articles", "arguments": { "page": 1, "page_size": 10 } }
```

---

## delete_article

删除一篇文章。默认进回收站，`permanent: true` 彻底删除。

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `article_id` | string | 是 | 文章 ID |
| `permanent` | boolean | 否 | 默认 `false`（回收站） |

**成功返回**

```json
{ "articleId": "149234567", "permanent": false }
```

**错误码**

`INVALID_ARGUMENT`（`article_id` 为空）、`NOT_FOUND`（文章已不在，信封 `code: 4004`，不能当作删除成功）、`AUTH_MISSING`、`AUTH_INVALID`、`RATE_LIMITED`（删除与保存共用同一个节流键，间隔至少 `CSDN_SAVE_INTERVAL_MS`）、`API_ERROR`，以及通用联网错误码。

**示例**

```json
{ "name": "delete_article", "arguments": { "article_id": "149234567", "permanent": false } }
```

> 误发布且无法回退的文章，正确处置方式就是删掉重建——把 `permanent` 留成 `false`，先放回收站。

---

## upload_image

上传一张本地图片，返回公网 URL。

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `path` | string | 是 | 本地文件路径 |
| `kind` | `"cover"` \| `"body"` | 是 | 封面图 / 正文图，**两条通道不能互换** |

支持 `.jpg` / `.jpeg` / `.png` / `.gif` / `.webp` / `.bmp`，其他后缀直接 `INVALID_ARGUMENT`。

**成功返回**（`UploadedImage`）

```json
{
  "url": "https://img-blog.csdnimg.cn/direct/abc123.png",
  "key": "direct/abc123.png",
  "size": 20480,
  "mimeType": "image/png"
}
```

**错误码**

`INVALID_ARGUMENT`（后缀不支持、文件不存在）、`AUTH_MISSING`、`AUTH_INVALID`、`HTTP_ERROR`、`MALFORMED_RESPONSE`、`TIMEOUT`、`SERVER_ERROR`、`NETWORK`。

**说明**：上传是两步的——先向签名接口取凭据，再 multipart 直传。第二步是发给**第三方对象存储**（华为 OBS / 阿里云 OSS）的，不是发给 CSDN，所以它不带 Cookie、也不带签名。返回的 `data.imageUrl` 才是公网地址；中间那些 `key` / `policy` / `signature` 是存储层凭据，不要拿去当图片链接用。凭据响应缺必需字段、或存储回调没返回 `imageUrl`，都会报 `MALFORMED_RESPONSE`——不会把一次没成功的上传算作成功。正文里请写**绝对 URL**，CSDN 有防盗链，外链容易裂图。

**示例**

```json
{ "name": "upload_image", "arguments": { "path": "/tmp/cover.png", "kind": "cover" } }
```

---

## list_categories

列出文章分类。

**参数**：无。

**成功返回**

```json
{ "items": ["后端", "前端", "人工智能"], "source": "api" }
```

`source` 有两个取值：

- `"api"`：来自 CSDN 接口。
- `"builtin"`：接口不可用，回退到内置列表。v0 用的 `/blog-console-api/v3/blog/list` 已经 404，所以候选接口全部失败时工具**降级返回内置列表**，而不是报错。

**错误码**

正常路径不抛错；只有在持久化失败且内置列表也无法提供时才可能返回通用联网错误码。

**示例**

```json
{ "name": "list_categories", "arguments": {} }
```

---

## list_tags

列出常用标签。参数、返回、错误码与 `list_categories` 完全一致。

**成功返回**

```json
{ "items": ["MCP", "TypeScript", "前端"], "source": "api" }
```

**示例**

```json
{ "name": "list_tags", "arguments": {} }
```

---

## verify_article

回查一篇文章的**真实**状态：API 说的状态 + 公开页的 HTTP 码。

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `article_id` | string | 是 | 文章 ID |
| `expected` | `"draft"` \| `"publish"` | 否 | 你期望的状态；省略时使用工具的内置默认值 |

**成功返回**（`VerificationResult`）

```json
{
  "articleId": "149234567",
  "state": "draft",
  "statusCode": 2,
  "publicStatusCode": 404,
  "consistent": true,
  "message": "草稿状态与公开页一致（公开页 404）"
}
```

**`consistent` 什么时候为 true**

- `expected: "draft"`：API 状态是 `draft`（`statusCode: 2`）**且**公开页返回 404。
- `expected: "publish"`：API 状态是 `published`（`statusCode: 0` 或 `1`）**或** `reviewing`（`16`，是合法的在途状态）**且**公开页返回 200。

两个条件缺一不可。只看 API 的 `status` 会漏判，只看公开页会误判审核中。

**错误码**

`NOT_FOUND`、`AUTH_MISSING`、`AUTH_INVALID`、`NETWORK`、`TIMEOUT`、`MALFORMED_RESPONSE`、`API_ERROR`、`SERVER_ERROR`。

**示例**

```json
{ "name": "verify_article", "arguments": { "article_id": "149234567", "expected": "publish" } }
```

> 公开页返回 404 不代表文章丢了，可能是"还没发布"或"还在审核"；返回 521 也不是文章不存在，那是 CDN 侧的错误码，见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md#公开页返回-521)。
