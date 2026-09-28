# 已知问题（v0.1.0 baseline）

本文件是重构的**需求输入**：下列每一条都已实测复现，v1.0 必须逐条修复或明确不支持。

来源：Hermes Agent 在真实发布流程中踩到的坑（2026-09）。

## E. 状态（v1.0.1 复核）

下表是逐条核对的结果，证据指向文件与测试名，而不是「应该已经修了」。

| # | 状态 | 证据 |
|---|---|---|
| A1–A6 | FIXED | `src/tools/` 11 个工具；`tests/unit/tools/registry.test.ts` 断言注册表完整 |
| B1 | FIXED | `buildSaveArticleBody` 的 `status` 由 `resolveSaveStatus()` 按 `(mode, readType, 当前状态)` 计算，不再查表；**v1.0.4 修正了编码本身**（发布是 `0` 不是 `1`，见下），测试覆盖 publish→0 / private→64 / draft-on-draft→2 / draft-on-published→0 / 状态未知→2 |
| B2 | FIXED | 发 `Description`；变异 M5（改回小写）被 4 个测试抓到 |
| B3 | FIXED | `src/csdn/verify.ts`；`publish_article` / `update_article` 默认 `verify: true` |
| B4 | FIXED | 两步上传 `resource-api/v1/image/direct/upload/signature` |
| B5 | FIXED | 工具层 zod 在任何请求之前拒绝 `tags > 5` / `description > 256` / 空 markdown；csdn 层的 256 截断保留为最后一道兜底（语义是「工具层负责拒绝，csdn 层负责不发出超限请求」） |
| B6 | 未在本次复核范围内 | 未实测表格与脚注的渲染结果，UNVERIFIABLE |
| C1 | FIXED | `core` / `csdn` / `tools` 单向分层，`src/context.ts` 组合根 |
| C2 | FIXED | 23 文件 / 526 用例，语句·分支·函数·行 100% |
| C3 | FIXED | `.github/workflows/ci.yml`：Node 18/20/22 矩阵 + secret-scan |
| C4 | FIXED | 限流器；**v1.0.1 修掉了「重试绕过限流」** |
| C5 | FIXED | 超时 + 退避重试；**v1.0.1 起非幂等写只在 `RATE_LIMITED` 时重试**（避免重复建文章） |
| C6 | FIXED | `CsdnError` 分类 + 工具层按 code 给中文提示 |
| C7 | FIXED | 12 篇 docs + README / CONTRIBUTING / NOTICE |
| C8 | PARTIAL | `dist/*.d.ts` 已产出，但没有独立的库入口，未验证「作为库使用」 |
| D1 | PARTIAL | 按字段名脱敏，且家族名容忍后缀；**按值擦除仍未做**，见 CHANGELOG 的 Known gaps |
| D2 | FIXED | ci.yml 的 `secret-scan` job（替代 gitleaks：无许可证与网络依赖，可本地复跑，且带自检） |

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
| B1 | **草稿状态码写错** | 代码用 `status: 0` 表示草稿，但 CSDN 现在把 `status:0` 当**发布**处理 → 用户还没审稿文章就公开可见，接口无法回退，只能删掉重建。草稿正确值是 `2`。**⚠️ v1.0.4 更正**：这里原本还写着「发布 `1`」——错的。`1` 是 `getArticle` **读回来**的编码，要写的值是编辑器用的 `0`；照 `1` 发会让已发布文章的正文改动到不了线上，详见 `API-NOTES.md` 的 status 章节 |
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

## F. 待线上验证（v1.0.4 引入，**不要当成已验证**）

这四条都只能靠一次真实的线上动作结案，而本仓库的规矩是 live 检查只建删草稿、**绝不发布**，所以它们**没有被测过**，只是按 CSDN 编辑器源码推断后加了保护。任何一条在验证前都不要对外说成"已确认"。

| # | 待验证的事 | 现状与依据 | 结案方式 |
|---|---|---|---|
| F1 | **`status: 0` 改已发布文章的正文，公开页是否真的跟着更新** | 依据是编辑器 `publish()`：重新发布发 `0`。我们以前发 `1`，观察到的现象是线上正文不动——我们曾据此断言"CSDN 不支持"，那是误诊 | 改一篇已发布文章的正文（哪怕只改一个字），然后 `curl` 公开页看内容是否变了 |
| F2 | **`scheduled_time` 的单位是秒还是毫秒** | 编辑器**读**的时候乘 1000（说明接口是秒），**写**的时候直接发本地毫秒值——自相矛盾。工具按秒发送，并拒绝过去的排期（万一猜错，过去的排期会立刻发布） | 排一次期（如 10 分钟后），看是否在预期时刻上线 |
| F3 | **`categories` 在发布时能否写入** | 已实测：草稿（`status=2`）新建与更新都读回空串；已发布文章能读出分类，所以读路径没问题。编辑器把分类选择器放在**发布弹窗**里 | 发布时带上 `categories`（如"前端"），再 `get_article` 读回 |
| F4 | **`read_type: 'private'` 的 `status: 64` 是否被接受** | 依据是编辑器的 `isPrivate ? 64 : 0`，没有线上样本 | 建一篇私密文章并读回 `read_type` |

F1 与 F3 可以用**同一次发布**一起结案。
