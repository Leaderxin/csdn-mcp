# CSDN 接口逆向记录

> 本文的每一条都是**从 CSDN 编辑器前端 bundle（`app.chunk.*.js`）里逆出来的，然后在真实账号上实测验证**的。没有任何一条来自官方文档——CSDN 没有公开过这套接口。
>
> 记录这些东西的唯一目的：下次这个接口改了，能在半小时内定位，而不是像 v0 那样靠"再试一次"。

## 1. 认证与网关

控制台接口都挂在 `bizapi.csdn.net` 上，这是阿里云 API Gateway 的一个部署。它要求每个请求带 `X-Ca-Signature`，并校验签名参与的头。

### HMAC 签名规范串

规范串**逐行、按序**拼接，分隔符是 `\n`（LF，不是 CRLF），最后一行是 uri：

```
{method}
{accept}

{contentType}
{date}
x-ca-key:{appKey}
x-ca-nonce:{nonce}
{uri}
```

一个真实的例子（保存文章那一次请求）：

```
POST
*/*

application/json; charset=UTF-8

x-ca-key:203803574
x-ca-nonce:9f1c4b7a-2e6d-4a58-9d3f-6c2b1a7e5f40
/blog-console-api/v3/mdeditor/saveArticle
```

第 3 行是**空行**（`Accept` 与 `Content-Type` 之间那一行没有内容），第 5 行也是空的——`date` 在我们所有请求里都传空字符串。

各行的取值规则：

| 行 | 取值 |
|---|---|
| `method` | 大写 HTTP 动词，如 `POST`、`GET` |
| `accept` | `Accept` 请求头的值，默认 `*/*` |
| （空行） | 恒为空 |
| `contentType` | `Content-Type` 头的值；无 body 的请求传空字符串 |
| `date` | `Date` 头的值；本项目恒为空 |
| `x-ca-key:{appKey}` | `appKey` 默认 `203803574` |
| `x-ca-nonce:{nonce}` | 必须与 `X-Ca-Nonce` 头**完全相同** |
| `uri` | **路径 + 查询串**，不含 origin。例如 `/blog-console-api/v1/editor/getArticle?id=149234567` |

签名算法：

```
X-Ca-Signature = base64( HMAC-SHA256( appSecret, stringToSign ) )
```

每个请求实际发送的头：

| 头 | 值 |
|---|---|
| `X-Ca-Key` | `203803574` |
| `X-Ca-Nonce` | 每次请求一个新 UUID |
| `X-Ca-Timestamp` | 毫秒时间戳 |
| `X-Ca-Signature` | 上面的 base64 结果 |
| `X-Ca-Signature-Headers` | `x-ca-key,x-ca-nonce` |

**`X-Ca-Signature-Headers` 是必需的**：它告诉网关哪几个头被折进了签名串。少了它，或者少了规范串里的 `x-ca-key` / `x-ca-nonce` 两行，都会得到同一个错误：

```
401 HMAC signature does not match
```

另外两个同样只表现为 401、但原因不同的坑：

- **uri 必须含查询串。** 只签裸路径、实际却带 `?id=...` 发出去，签名不匹配。
- **签名的 `Content-Type` 必须与实际发出的头逐字相同。** 本项目普通请求用 `application/json; charset=UTF-8`（**有**空格），而图片签名接口要求恰好是 `application/json;charset=UTF-8`（**无**空格）——签名值里的这一行必须和 header 值一致，不能"顺手统一一下格式"。

`appKey` / `appSecret` 硬编码在 CSDN 自己的前端 bundle 里，是公开常量，不是用户密钥。代码里放在 `src/core/signer.ts`，可用环境变量覆盖（仅为测试）。

请求还会带上 `User-Agent`、`Referer: https://editor.csdn.net/md/`、`Origin: https://editor.csdn.net`——和浏览器里编辑器发出的请求一致。

## 2. `saveArticle` 字段表

```
POST /blog-console-api/v3/mdeditor/saveArticle
```

| 字段 | 说明 |
|---|---|
| `id` | 文章 ID。**空字符串 = 新建**，非空 = 更新该文章。注意：**创建时这个键必须存在**（传 `''`），整个键缺失时 CSDN 回 500 |
| `title` | 标题 |
| `content` | **渲染后的 HTML**。CSDN 阅读页显示的是它 |
| `markdowncontent` | **全小写**。Markdown 源码，原样存储；编辑器再次打开文章时读的是它 |
| `Description` | **首字母大写**。摘要，≤ 256 字 |
| `tags` | **一个逗号连接的字符串**（`"MCP,CSDN"`），不是 JSON 数组。服务端最多接受 5 个 |
| `categories` | 分类名，**字符串**（不是数组） |
| `type` | 固定 `'original'` |
| `status` | 见下方状态码表 |
| `pubStatus` | 与 `status` 配套：`'draft'` 或 `'publish'` |
| `authorized_status` | 固定 `0`（未授权转载），线上不会出现转载标记 |
| `source` | 固定 `'pc_mdeditor'`，标记来源为 Markdown 编辑器；这是 `markdowncontent` 保持可编辑而不是被当成原始 HTML 的原因 |
| `cover_images` + `cover_type` | 只有传封面时才带。`cover_images` 是**单元素数组**，同时必须带 `cover_type: 1`（`0` 表示无封面） |

### 陷阱：`content` 必须是渲染后的 HTML

正文在请求里出现**两次**，两个字段的契约不同：

- `content`：渲染后的 HTML。
- `markdowncontent`：Markdown 原文，逐字存储。

v0 把 Markdown 原文直接塞进了 `content`，于是线上文章开头真的显示 `## 标题`、`**加粗**` 这些字面量，而且编辑器里还多存了一份带标记的渲染结果。`content` 只能由 Markdown 渲染器产出，渲染时必须开启 GFM，否则表格会退化成一整段竖线。

### 返回：新建和更新不是同一个结构

两种情况都是 HTTP 200 + 信封 `code: 200`，但：

- **新建**返回对象：`{ id, url, qrcode, … }`。
- **更新**返回裸字符串 `'成功'`，**没有任何 id**。

所以更新路径上的文章 URL 只能由账号名 + 已知 id 重新拼出来。如果一次"成功"的保存既没有 id、调用方也没提供 id，那只能是协议异常，不能当成成功。

### 陷阱：`Description` 大写

**这是本仓库最贵的一个字段名。** v0 传的是小写 `description`，CSDN **不报错、不提示**，直接把它丢掉，然后退回"截取正文开头"当摘要。表现是：接口 200，文章发出来了，摘要却不是你写的那段。翻遍响应体和日志都看不出问题，只有对比线上页面才能发现。

正确写法是 `Description`——**大写 D，其余小写**。代码里 `SaveArticleInput.description` 的注释专门标注了这一点（"`Description` on the wire — case matters, lowercase is silently dropped"）。

### 陷阱：`status: 0` 是发布

v0 用 `status: 0` 表示草稿。**现在的 CSDN 把 `status: 0` 当发布处理**。结果是用户以为自己存了草稿，文章其实已经公开可见，而且这个状态写反了之后 API 回不去，只能删掉重建。

v1 的取值：

| `mode` | `status` | `pubStatus` |
|---|---|---|
| `draft`（默认） | `2` | `'draft'` |
| `publish` | `1` | `'publish'` |

**永远不要发 `status: 0`。**

## 3. 状态码表

`GET /blog-console-api/v1/editor/getArticle?id={articleId}` 返回的 `status`，映射关系定义在 `src/csdn/types.ts` 的 `ARTICLE_STATE_BY_CODE`：

| `status` | 状态 | 含义 |
|---|---|---|
| `0` | `published` | **已发布**——这就是那个陷阱：0 不是草稿 |
| `1` | `published` | 已发布 |
| `2` | `draft` | 草稿。只能在创作中心看到，公开页 404 |
| `6` | `rejected` | 审核未通过（`reason` 字段给出原因） |
| `16` | `reviewing` | 审核中。公开页在通过之前是 404 |

表里没有的码一律映射为 `unknown`，**不做猜测**。宁可报告"未知状态"，也不要猜错一个会决定"文章是否已经公开"的字段。

## 4. 两步图片上传

v0 走的 `imgservice.csdn.net` 已经**整体 404**，现在必须两步：

### 第一步：取上传凭据

```
POST /resource-api/v1/image/direct/upload/signature
Content-Type: application/json;charset=UTF-8     ← 无空格，且必须与签名串里的这一行一致
```

请求体：

```json
{ "appName": "direct_blog", "imageTemplate": "standard", "imageSuffix": "png" }
```

**两条通道的 `appName` 不同，不能互换**：

| `kind` | `appName` | `imageTemplate` | 用途 |
|---|---|---|---|
| `body` | `direct_blog` | `standard` | 正文里的插图 |
| `cover` | `direct_blog_coverimage` | `""` | 文章封面 |

用错通道的表现不是报错，而是图上传成功、正文里却不显示——见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md#图片能上传但正文不显示)。

凭据响应里这些字段缺一不可，缺任何一个都直接报 `MALFORMED_RESPONSE`（而不是拿一份残缺凭据去撞存储侧，换来一个没有说明的 400）：`provider`、`host`、`accessId`、`policy`、`signature`、`callbackUrl`、`callbackBody`、`callbackBodyType`、`filePath`。

### 第二步：multipart 直传到返回的 host

**这一步是发给第三方对象存储（华为 OBS 或阿里云 OSS）的**，不是发给 CSDN。所以它既不签 `X-Ca-*`，也不带 Cookie——带上会出错。

| 字段 | 说明 |
|---|---|
| `key` | 对象键，取凭据里的 `filePath` |
| `policy` | 上传策略 |
| `signature` | 存储侧签名 |
| `callbackBody` | 回调体 |
| `callbackBodyType` | 回调体类型 |
| `AccessKeyId` + `callbackUrl` | 当 `provider === 'obs'` 时使用（`accessId` 放这里） |
| `OSSAccessKeyId` + `callback` | 其他 provider 使用（字段名不同，发错了只会得到一个空 body 的 400） |
| `file` | 图片二进制 |

`customParam` 里的每一项都要以 `x:<key>` 的形式作为表单字段发出——CSDN 的回调参数就是靠这个前缀还原的。

响应里的 **`data.imageUrl`（部分存储配置会把它放在顶层 `imageUrl`）才是公网可访问的图片地址**。`key`（即 `filePath`）是存储层标识，直接拼进 Markdown 是裂图。两种形状都没有 `imageUrl` 时报 `MALFORMED_RESPONSE`，不会把一次没成功的上传算作成功。

`imageSuffix` 取文件名扩展名，**去掉查询串并转小写**（`a.PNG` 与 `a.png` 必须产生同一个 key 后缀）。

支持的格式：`.jpg` / `.jpeg` / `.png` / `.gif` / `.webp` / `.bmp`。其他后缀在**申请上传凭据之前**就被 `INVALID_ARGUMENT` 拦下，不会白白占一次上传配额。

正文图片的占位符约定：源码里写 `IMG_xxx` 形式的占位符，上传完成后统一替换。替换前会**先解析整篇文档**，把所有没有对应上传结果的占位符一次性列出来报错——v0 是发到 `saveArticle` 前才发现缺图，白上传一张封面还留下一句看不懂的报错。

## 5. 公开页校验

唯一不会撒谎的信号是公开页本身。文章 URL 的构造规则（`src/csdn/types.ts` 的 `articleUrl`）：

```
{blogBase}/{userName}/article/details/{articleId}
```

校验同时看两件事，缺一不可：

| `expected` | API 状态要求 | 公开页 HTTP 要求 |
|---|---|---|
| `draft` | `state: 'draft'`（`status: 2`） | **404** |
| `publish` | `state: 'published'`（`status: 0` / `1`）或 `'reviewing'`（`status: 16`） | **200** |

`'reviewing'` 对 `publish` 而言是**合法的在途状态**——文章已提交、还在审核，公开页此时仍然 404。把它当失败会误报。

公开页请求以普通浏览器身份发出：`GET`、跟随重定向、`Accept: text/html,...`、`Accept-Language: zh-CN`、`Referer: {blogBase}/`。

### 实测补充：缓存与 521

- **`?t=<timestamp>`**：公开页走 CDN，刚写完立刻请求可能拿到缓存下来的旧结果。实测做法是带上一个时间戳参数（如 `?t=1758692400000`）当 cache buster 再请求。这不是接口约定，是客户端侧的规避手段。
- **HTTP 521**：偶尔会返回 521。这是 **Cloudflare 的错误码**（源站不可达），既不是 404 也不是 200。**它不能用来判断文章是否公开**——拿到 521 应该重试，而不是把文章当"没发布"处理。同理，另一个常见的 5xx 也不代表文章状态变了。
- `saveArticle` 返回 200 **不等于**成功。这正是每次写入都回查公开页的原因。

## 6. 其他在用的端点

| 用途 | 端点 |
|---|---|
| 保存文章 | `POST /blog-console-api/v3/mdeditor/saveArticle` |
| 读单篇（含 `status`） | `GET /blog-console-api/v1/editor/getArticle?id={articleId}` |
| 删除文章 | `POST /blog/phoenix/console/v1/article/del`，body `{ "articleId", "deep" }`，与保存共用节流键 |
| 公开文章列表（**无需 Cookie**，仅已发布） | `GET /community/home-api/v1/get-business-list?page&size&businessType=blog&username=` |
| 图片上传签名 | `POST /resource-api/v1/image/direct/upload/signature` |

删除的 `deep` 对应工具参数 `permanent`：`false` 进回收站，`true` 彻底删除。

**列表接口的两个要点**：

- 它只认 `username` 一个参数，**既不带 Cookie 也不带 `X-Ca-*` 签名**——带上反而会被 CSDN 回 403。这就是 `list_articles` 在没有 Cookie 的情况下也能用的原因。
- 分页参数是 `page`（从 1 开始，默认 1）与 `size`（默认 20，上限 100）。越界在本地就被 `INVALID_ARGUMENT` 拦下。一个没有发布过任何文章的账号，响应里**连 `list` 键都没有**，此时按空列表处理，不是错误。

## 7. 已下线的端点

| 端点 / 域名 | 现状 | 影响 |
|---|---|---|
| `/blog-console-api/v3/blog/list` | **404** | v0 的 `list-categories` / `list-tags` 就挂在这里，长期静默失效 |
| `imgservice.csdn.net` | **全部 404** | v0 的图片上传整体不可用，必须改走第 4 节的两步上传 |

**最阴的一点**：bizapi 对不存在的路径有时会返回 **HTTP 200 + `openresty` 的 404 HTML 页面**。只要按状态码判断就会以为请求成功，实际拿到一坨 HTML。所以响应体必须先确认是 JSON 信封（`{` 开头）再解析，否则抛：

```
MALFORMED_RESPONSE 接口返回的不是 JSON，通常意味着该接口已下线或路径变更
```

v0 的元数据工具就是这么烂掉的——接口没了，工具还在，用户看到的是一个永远返回内置列表的功能。

元数据工具在候选端点**全部失败**时的行为是：返回内置列表 + `source: "builtin"`（降级可用），而不是报错。每次探测的结果记在本文。

## 8. 频控

- 普通读写：突发可以，持续打就会被拦。客户端默认 `CSDN_MIN_INTERVAL_MS=250` 做最小间隔。
- **保存 / 删除：约 10 秒一次**。间隔不足会收到 `文章频繁发布，请稍后再试`，映射为 `RATE_LIMITED`（可重试）。客户端默认 `CSDN_SAVE_INTERVAL_MS=11000`，并且在收到限流后的重试等待也按这个值来。

限流是按账号在服务端算的，客户端节流只能降低概率、不能消除——多个进程用同一个 Cookie 时记得算总账。
