# 已知问题（v0.1.0 baseline）

本文件是重构的**需求输入**：下列每一条都已实测复现，v1.0 必须逐条修复或明确不支持。

来源：Hermes Agent 在真实发布流程中踩到的坑（2026-09）。

## A. 协议层 / 工具面

| # | 问题 | 影响 | v1 目标 |
|---|---|---|---|
| A1 | 只有 4 个工具，且 2 个已失效 | 无法查询、无法编辑、无法删除 | 补齐 publish / update / get / list / delete / upload / meta / auth |
| A2 | `publish-blog` 不能传 `id` | **无法更新已有文章**，只能新建 | `update_article` 独立工具 |
| A3 | 不支持封面图 | 文章列表无缩略图 | `cover_image` 参数 |
| A4 | 不支持正文图上传 | 正文只能写外链，CSDN 有防盗链会裂 | `upload_image` 工具 + 占位符替换 |
| A5 | 无 `delete` 能力 | 误发布的文章只能手动去后台删 | `delete_article`（回收站 / 彻底删除） |
| A6 | 无查询能力 | 无法列文章、无法按状态过滤、无法读单篇 | `list_articles` / `get_article` |

## B. 正确性（会真实伤到用户）

| # | 问题 | 实测表现 |
|---|---|---|
| B1 | **草稿状态码写错** | 代码用 `status: 0` 表示草稿，但 CSDN 现在把 `status:0` 当**发布**处理 → 用户还没审稿文章就公开可见，接口无法回退，只能删掉重建。正确值：草稿 `2`，发布 `1` |
| B2 | **摘要字段名大小写错** | 代码传 `description`（小写），CSDN 只认大写 `Description` → 摘要被静默丢弃，退回正文开头截取 |
| B3 | 缺少发布后自检 | `saveArticle` 返回 200 ≠ 成功。未校验 `getArticle.status` 与公开页 HTTP 码 |
| B4 | 图片上传接口已下线 | `imgservice.csdn.net` 全 404，需改走 `resource-api/v1/image/direct/upload/signature` 两步上传 |
| B5 | 未做入参校验 | `tags` 无 ≤5 个限制，`Description` 无 ≤256 字限制，超限由服务端静默处理 |
| B6 | 未渲染 Markdown 表格/脚注 | `marked` 的 gfm 能力未显式开启 |

## C. 工程化

| # | 问题 | v1 目标 |
|---|---|---|
| C1 | 单文件 249 行，无分层 | `core` / `csdn` / `tools` / `utils` 分层 |
| C2 | 零测试 | 100% 覆盖率（statement / branch / function / line） |
| C3 | 无 CI | GitHub Actions：lint + typecheck + test + build |
| C4 | 无速率限制 | CSDN 有频控（实测间隔 <10s 会被拒），需内置节流 + 重试 |
| C5 | 无重试 / 无超时 | 网络抖动直接失败 |
| C6 | 无结构化错误 | 全部返回 `code: -1` + 字符串 |
| C7 | 文档只有 README | 完整 docs/ 站点：工具参考、API 逆向、配置、FAQ、故障排查 |
| C8 | 无类型导出 | 无法作为库使用 |

## D. 安全

| # | 问题 | v1 目标 |
|---|---|---|
| D1 | Cookie 可能被打进日志 | 日志脱敏（永不输出 Cookie 值） |
| D2 | `.env` 有 gitignore，但无 CI 密钥扫描 | 加 secret scanning（gitleaks / GitHub native） |
