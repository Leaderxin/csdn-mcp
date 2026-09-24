# 工具参考

v1.0.0 的工具面是**冻结**的（`docs/ARCHITECTURE.md` §4）：11 个工具、参数名、成功返回结构都以那份契约为准。本文逐个写清楚参数、约束、返回和错误码。

## 通用约定

- 参数用 zod 校验，**不可行的输入在任何网络请求之前就被拒绝**，返回 `INVALID_ARGUMENT`。
- 成功返回是一个 `text` 内容块：**一行人类可读的摘要** + 一个 ```` ```json ```` 代码块（payload）。摘要给人看，代码块给程序解析，两者都在同一个块里。
- 失败返回 `{ "isError": true, "content": [...] }`，文本里带错误 `code`。不会把原始异常堆栈丢给 MCP 宿主。
- 所有 `*_article` / `upload_image` / 元数据工具都需要 `CSDN_COOKIE`（`list_articles` 默认的 `scope: "published"` 除外，它走公开接口；`scope: "all"` 需要 Cookie）。
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
| `VERIFY_FAILED` | 写操作的**自检**结果与写入方的成功声明不一致（v1.0.0 的工具层不把它当错误返回，见 `publish_article` 的 `warnings`；此码为兼容保留） | 否 |

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
{
  "userName": "Leaderxin",
  "valid": true,
  "liveCheck": {
    "endpoint": "list_articles",
    "authenticated": false,
    "ok": true,
    "total": 12
  }
}
```

`liveCheck` 是设置 Cookie 之后的一次**联网自检**：用 `list_articles`（公开社区接口）确认账号可访问。注意它 `authenticated: false`——那个接口本身匿名、不带 Cookie，所以自检通过只说明账号名可用，**不能证明 Cookie 被 CSDN 接受**；Cookie 是否有效要由某个需要登录的调用来给结论。自检失败时 `liveCheck.ok: false` 并带 `error: { code, message }`，此时 Cookie 仍然已经保存成功（返回不是错误，摘要里会写明失败原因）。

**错误码**

`INVALID_ARGUMENT`（Cookie 为空、缺 `UserToken`、或找不到 `UserName`）。结构校验完全在本地完成，不发任何请求，因此不会返回 `NETWORK` / `TIMEOUT` / `AUTH_INVALID`。（自检阶段的联网错误不会让调用失败，只体现在 `liveCheck` 里。）

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

`configured: false` 表示 `CSDN_COOKIE` 为空，此时会额外返回 `howToConfigure`（怎么设置，含环境变量名）；`configured: true` 但 `valid: false` 时会额外返回 `reason`（例如缺少 `UserToken`）。`username` 优先取配置里的账号名，没有则回退到 Cookie 里的 `UserName`。

Cookie 内容本身**永远不会**出现在返回值里。

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
| `cover_image` | string | 否 | 封面图：填 `upload_image`（`kind: "cover"`）返回的 `url`；也可以直接给**本地图片路径**，这时会以 `kind: "cover"` 自动上传（`http(s)://` 开头的值不会被重复上传） |
| `mode` | `"draft"` \| `"publish"` | 否 | 默认 `"draft"` |
| `verify` | boolean | 否 | 默认 `true`：写入后回查 API 状态 + 公开页 |

**成功返回**

```json
{
  "articleId": "149234567",
  "url": "https://blog.csdn.net/Leaderxin/article/details/149234567",
  "state": "draft",
  "mode": "draft",
  "verification": {
    "articleId": "149234567",
    "state": "draft",
    "statusCode": 2,
    "publicStatusCode": 404,
    "consistent": true,
    "message": "草稿已确认：接口 status=2，公开页 404"
  }
}
```

- `state` 取自自检结果；`verify: false` 时**不出现** `verification`，`state` 为 `"unknown"`（`saveArticle` 返回 200 既可能是草稿也可能是发布，所以这里不猜）。
- `warnings` 只在有话说时出现（数组，逐条中文）。两种情况会有它：
  1. 自检不一致——`verification.consistent: false`，原文照录；
  2. **意图是草稿但文章已经对外可见**（接口显示已发布，或公开页返回 200）——这是踩过的事故：接口无法把已发布的文章退回草稿，此时 `warnings` 里会出现「立即删除、调用 `delete_article`」的处置建议，**摘要行最前面也会重复它**。自检不一致不会让调用变成错误返回，因为那样会丢掉 `articleId`——而删除它恰恰需要这个 id。

**错误码**

`INVALID_ARGUMENT`（`tags` > 5、`description` > 256 字、`markdown` 为空）、`AUTH_MISSING`、`AUTH_INVALID`、`RATE_LIMITED`（两次保存间隔不足）、`API_ERROR`、`MALFORMED_RESPONSE`（含 `saveArticle` 没返回文章 id 的情况），以及上表的通用联网错误码。自检不一致**不是**错误码，而是 `verification.consistent: false` + `warnings`（见上）。

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
| `mode` | `"draft"` \| `"publish"` | 否 | **不传则沿用文章当前的可见性**：已发布/审核中 → `publish`，其余 → `draft`（见下） |

至少要传一个要修改的字段，只传 `article_id` 会直接 `INVALID_ARGUMENT`（`saveArticle` 是整条重写，什么都没改的重写只会白冒一次写风险）。

**成功返回**

```json
{
  "articleId": "149234567",
  "url": "https://blog.csdn.net/Leaderxin/article/details/149234567",
  "state": "published",
  "mode": "publish",
  "verification": {
    "articleId": "149234567",
    "state": "published",
    "statusCode": 1,
    "publicStatusCode": 200,
    "consistent": true,
    "message": "发布已确认：接口 status=1，公开页 200"
  }
}
```

- **未传的字段保持原值**：先用 `getArticle` 读当前记录，再把未传的字段合并回去（`saveArticle` 会整条覆盖，不合并就会把标题/标签/摘要/封面清空）。`cover_image` 只有传了新的才会重新上传。
- **`mode` 不传时保持当前可见性**：已发布（`published`）或审核中（`reviewing`）的文章会按 `publish` 写入，避免一次元数据修改把它退回草稿；草稿仍是草稿。要发布草稿必须显式 `mode: "publish"`。返回值里的 `mode` 是本次实际写入的模式。
- 参数表里没有 `verify`（见 `docs/ARCHITECTURE.md` §4），所以本工具**总是**执行写入后自检（多两次请求：接口状态 + 公开页）。自检不一致时 `verification.consistent: false` 并写进 `warnings`，不会变成错误返回（否则 `articleId` 会丢）。
- `warnings` 里还有一条最容易踩的：**修改已公开（含审核中）文章的 `markdown` 时**，会明确告知接口不会更新线上正文、需要在编辑器 UI 重新发布，并给出该文章的编辑器地址。

**错误码**

`INVALID_ARGUMENT`、`NOT_FOUND`、`AUTH_MISSING`、`AUTH_INVALID`、`RATE_LIMITED`，以及通用联网错误码。

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

`include_content: false` 会同时去掉 `markdownContent` / `htmlContent`，以及 `raw` 里的 `content` / `markdowncontent` 副本——`raw` 是整条记录，不一起裁掉就等于没省下上下文。返回的摘要行会说明已省略正文。

**错误码**

`INVALID_ARGUMENT`（`article_id` 为空）、`NOT_FOUND`、`AUTH_MISSING`、`AUTH_INVALID`，以及通用联网错误码。

**示例**

```json
{ "name": "get_article", "arguments": { "article_id": "149234567", "include_content": false } }
```

---

## list_articles

列出账号的文章。`scope` 决定走哪个接口，两者的可见范围不同。

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `page` | number | 否 | 页码，从 1 开始，默认 `1` |
| `page_size` | number | 否 | 每页条数，默认 `20`，**上限 `100`**。`scope=all` 时可能被服务端忽略，见下 |
| `scope` | string | 否 | `published`（默认）或 `all` |

越界（`page < 1`、`page_size > 100`，或 `scope` 不是这两个值）在发请求之前就被 `INVALID_ARGUMENT` 拦下。

**两个 scope 的区别**

| | `scope: "published"`（默认） | `scope: "all"` |
|---|---|---|
| 接口 | 公开社区接口 `/community/home-api/v1/get-business-list` | 作者后台 `/blog/phoenix/console/v1/article/list` |
| 凭证 | **无需 Cookie / 签名**（带上反而 403） | 需要 Cookie + 签名 |
| 可见范围 | **只有已发布**，草稿永远不出现 | **全部状态，含草稿** |
| `counts` | 无 | 有：`{all, draft, publish, private, deleted, audit, ...}` |
| 每条带的 `status`/`state` | 无（都是已发布，没有区分必要） | 有 |
| 每页条数 | 按 `page_size` | **服务端固定，`page_size` 会被忽略** |

> **`scope=all` 是唯一能回答「我有哪些草稿」的口径。** 公开接口看不到草稿，`get_article` 又要先知道 ID——agent 建完草稿若丢了 ID，只有这条路径能把它找回来。

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
  "total": 1,
  "scope": "published"
}
```

`scope: "all"` 时每条额外带两个字段，并按此多出 `counts`：

```json
{
  "items": [
    {
      "id": "103343553",
      "title": "还没写完的草稿",
      "url": "https://blog.csdn.net/Leaderxin/article/details/103343553",
      "state": "draft",
      "statusCode": 2,
      "viewCount": 1,
      "tags": [],
      "description": ""
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 26,
  "scope": "all",
  "counts": { "all": 26, "draft": 2, "publish": 26, "deleted": 0 }
}
```

**`scope: "all"` 的三个实测注意点**

1. **`page_size` 会被忽略**：该接口把每页条数固定在服务端（实测恒为 20），传 `5` 也回 20 条。返回的 `pageSize` 是**服务端实际使用的值**，不是你请求的值——所以别用 `items.length < page_size` 去判断「最后一页」。
2. **`counts` 缺省时字段整个不出现**，而不是 `{}`。看到没有 `counts` 键代表「这个接口这次没报」，不代表「草稿数为 0」。
3. 该接口的计数是**带引号的字符串**（`"viewCount": "1"`），已按数字解析。`status` 无法解析时映射为 `state: "unknown"` 而**不是** `published`。

**错误码**

`INVALID_ARGUMENT`（分页/scope 越界）、`MALFORMED_RESPONSE`、`API_ERROR`、`HTTP_ERROR`、`NETWORK`、`TIMEOUT`、`SERVER_ERROR`。

**重要限制**：`scope: "published"` 下**草稿不会出现**——这是接口本身的性质，不是过滤参数。刚保存的草稿查不到属于预期，要用 `scope: "all"` 或 `get_article` 按 ID 查。

**示例**

```json
{ "name": "list_articles", "arguments": { "page": 1, "page_size": 10 } }
```

```json
{ "name": "list_articles", "arguments": { "scope": "all", "page": 1 } }
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

摘要行始终写清楚这次是**移入回收站**还是**彻底删除**：默认（`permanent: false` / 不传）进回收站，可在创作中心的「内容管理 → 回收站」还原；只有显式 `permanent: true` 才会彻底删除（摘要里会写"不可恢复"）。

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
| `expected` | `"draft"` \| `"publish"` | 否 | 你期望的状态。省略时按文章当前状态推断：`published` / `reviewing` → `publish`，其余 → `draft`（多花一次 `getArticle`）；摘要行会写明本次按哪个 `expected` 判定 |

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

成功返回的载荷**就是**上面那 6 个字段（`VerificationResult`），不含额外包装；判定用的 `expected` 在摘要行里。

**错误码**

`NOT_FOUND`、`AUTH_MISSING`、`AUTH_INVALID`、`NETWORK`、`TIMEOUT`、`MALFORMED_RESPONSE`、`API_ERROR`、`SERVER_ERROR`。

**示例**

```json
{ "name": "verify_article", "arguments": { "article_id": "149234567", "expected": "publish" } }
```

> 公开页返回 404 不代表文章丢了，可能是"还没发布"或"还在审核"；返回 521 也不是文章不存在，那是 CDN 侧的错误码，见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md#公开页返回-521)。
