# 变更日志

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

暂无。

## [1.0.0] - 未发布

一次完整重写：从 4 个工具（其中 2 个接口已失效）的 249 行单文件，改为分层架构 + 11 个工具 + 100% 覆盖率的测试。工具面在此版本**冻结**，契约见 `docs/ARCHITECTURE.md` §4。

### Added

- **工具面补齐到 11 个**：`auth_login`、`auth_status`、`publish_article`、`update_article`、`get_article`、`list_articles`、`delete_article`、`upload_image`、`list_categories`、`list_tags`、`verify_article`。新增的原能力：更新已有文章、读取单篇/列表、删除（回收站或彻底删除）、图片上传、分类与标签、账号状态。
- **图片上传链路改为两步**：`POST /resource-api/v1/image/direct/upload/signature` 取凭据 + multipart 直传到第三方对象存储（华为 OBS / 阿里云 OSS），区分 `body`（`direct_blog`）与 `cover`（`direct_blog_coverimage`）两条通道；正文图片支持 `IMG_*` 占位符，替换前一次性报出所有缺映射的占位符，避免"上传成功、发布失败"的半成品状态。
- **写入后自检**：`publish_article` / `update_article` 默认回查 `getArticle.status` **和**公开页 HTTP 码，两者都一致才算成功。
- **命名错误码体系**：`AUTH_MISSING`、`AUTH_INVALID`、`NETWORK`、`TIMEOUT`、`HTTP_ERROR`、`MALFORMED_RESPONSE`、`API_ERROR`、`RATE_LIMITED`、`SERVER_ERROR`、`NOT_FOUND`、`INVALID_ARGUMENT`、`VERIFY_FAILED`，每个错误自带 `retryable` 判定。
- **传输层加固**：单次请求超时、可重试错误的指数退避（500ms → 1s → 2s，上限 8s）、客户端节流（读 250ms / 写 11s，按 key 分桶且串行化并发调用者）。
- **入参前置校验**：`tags` ≤ 5、`description` ≤ 256 字、`markdown` 非空、`kind ∈ {cover, body}`，全部在任何网络请求之前拒绝。
- **分层架构**：`src/core`（配置、签名、HTTP、限流、日志、错误）/ `src/csdn`（领域逻辑）/ `src/tools`（MCP 工具定义），依赖只向下；`core` 与 `csdn` 不 import MCP SDK、不写 stdout。
- **日志脱敏**：所有日志消息与字段统一过滤 `UserToken` / `UserName` / `csrfToken` 等凭据，Cookie 永不落盘；日志只写 stderr。
- **测试与工程化**：vitest，`src/**` 语句/分支/函数/行覆盖率达 100%，可注入的 `fetchImpl` / `sleep` / `now` 使得全部用例无需网络；可选的真实环境集成测试（`CSDN_LIVE=1`，只建草稿、绝不发布）。
- **文档集**：`README.md` + `docs/` 下 9 篇（入门、工具参考、配置、逆向记录、故障排查、FAQ、变更日志、索引），另有架构与已知问题两份内部文档。
- **类型导出**：`csdn-mcp/core` 子路径导出可复用的核心类型。

### Changed

- **工具重命名**：`login` → `auth_login`，`publish-blog` → `publish_article`，`list-categories` → `list_categories`，`list-tags` → `list_tags`。
- **`publish_article` 的 `mode` 默认 `draft`**：发布必须显式传 `mode: "publish"`。
- **草稿与发布的线上取值**：草稿 `status: 2` + `pubStatus: 'draft'`，发布 `status: 1` + `pubStatus: 'publish'`。
- **`update_article` 独立成工具**：v0 的 `publish-blog` 无法传 `id`，因此永远只能新建。
- **公开页校验取代"看状态码"**：`saveArticle` 返回 200 不再被当作成功。
- **元数据工具支持降级**：分类/标签的候选接口全部失败时返回内置列表 + `source: "builtin"`，而不是抛错。
- **运行环境**：要求 Node.js ≥ 18.17，包改为 ESM。

### Fixed

- **草稿状态码写反导致文章被误发布**：`status: 0` 被 CSDN 当作发布，用户未审稿文章即公开、且无法回退。现有草稿用 `2`、发布用 `1`，并有测试锁定这一行为。
- **摘要被静默丢弃**：线上字段名是大写的 `Description`，v0 传小写 `description`，CSDN 不报错直接丢弃并退回截取正文开头。
- **发布后无自检**：现在同时校验 API 状态与公开页 HTTP 码，二者不一致会报 `VERIFY_FAILED`。
- **图片上传域名整体 404**：`imgservice.csdn.net` 已下线，改走 `resource-api/v1/image/direct/upload/signature` 两步上传。
- **元数据接口静默失效**：v0 的 `/blog-console-api/v3/blog/list` 已 404，且 bizapi 对失效路径返回的是 `openresty` 的 404 HTML 页面（实测状态码为 HTTP 404）。现在响应体不是 JSON 信封时一律抛 `MALFORMED_RESPONSE`，不依赖状态码判断。
- **入参越界由服务端静默处理**：`tags` > 5 现在在本地被拒；摘要超过 256 字不再原样上线（写入层截断到 256，CSDN 自己也是按 256 截断）。
- **正文未渲染，线上显示 `##` 与 `**` 字面量**：`saveArticle` 的 `content` 必须是渲染后的 HTML，Markdown 原文只能进 `markdowncontent`；v0 把 Markdown 原文填进了 `content`。
- **Markdown 表格与脚注未渲染**：显式开启 `marked` 的 GFM 能力（关闭时表格会退化成一整段竖线）。
- **网络抖动直接失败**：加入超时与可重试错误的退避重试。
- **错误不可读**：不再统一返回 `code: -1` + 字符串。
- **Cookie 可能进日志**：日志层统一脱敏。

### Breaking

- **工具名与参数名全面变更**：旧名 `login` / `publish-blog` / `list-categories` / `list-tags` 已移除；参数改为 snake_case（`article_id`、`page_size`、`cover_image`），返回载荷为 camelCase（`articleId`、`statusCode`、`publicStatusCode`）。调用方需要同步改造。
- **草稿语义变更**：`status: 0` 不再等于草稿。任何自定义脚本里写死 `0` 的都必须在升级前改成 `2`。
- **错误返回结构变更**：由 `code: -1` + 自由文本改为命名错误码，且失败返回 `{ isError: true, content: [...] }`。
- **元数据工具的端点变更**：v0 的 `/blog-console-api/v3/blog/list` 不可用，行为改为"探测候选端点，失败则降级内置列表"。
- **运行环境**：Node.js ≥ 18.17，包为 ESM，入口 `dist/index.js`，必须先构建。

### 已知限制（v1.0.0 非目标）

- **已发布文章的正文无法通过 API 修改**：CSDN 只在编辑器 UI 发布时把正文应用到线上，API 改的是草稿副本。`update_article` 会如实说明，不假装成功。
- **草稿不出现在 `list_articles`**：公开接口只列已发布文章。
- 无评论、粉丝、分析类接口；无任何浏览器自动化。

## [0.1.0] - 2026-09

Hermes Agent 在真实发布流程中硬出来的基线版本，单文件 249 行，零测试。

### 特性

- 4 个工具：`login`、`publish-blog`、`list-categories`、`list-tags`（后两个的接口已失效）。
- Cookie 认证，Markdown 正文，分类与标签，草稿/发布切换。
- `publish-blog` 可创建文章，但**不能传 `id`**，因此无法更新已有文章。

### 已知问题

见 `docs/KNOWN-ISSUES.md`。其中会真实伤到用户的是：草稿状态码写反导致误发布、摘要字段大小写错误、发布后无自检、图片上传接口已下线、入参无校验。

[Unreleased]: https://github.com/Leaderxin/csdn-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Leaderxin/csdn-mcp/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/Leaderxin/csdn-mcp/releases/tag/v0.1.0
