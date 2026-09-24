# csdn-mcp 文档索引

按读者的目的分组。第一次用，按顺序读 ①→③ 就够。

## 上手

| 文档 | 一句话 |
|---|---|
| [../README.md](../README.md) | 项目门面：它是什么、快速开始、11 个工具一览、配置表 |
| [GETTING-STARTED.md](GETTING-STARTED.md) | 从零到第一次成功调用：装依赖、拿 Cookie、配客户端、验证跑通 |
| [CONFIGURATION.md](CONFIGURATION.md) | 每个 `CSDN_*` 环境变量的默认值、作用、什么时候改；Claude Desktop / Cursor / Cline / VS Code / 通用 stdio 的现成配置 |

## 使用

| 文档 | 一句话 |
|---|---|
| [TOOLS.md](TOOLS.md) | 11 个工具的参数（类型、必填、约束）、成功返回结构、可能出现的错误码、每工具一个实例 |
| [FAQ.md](FAQ.md) | 常见问题：是不是官方 API、会不会封号、要不要浏览器、Cookie 安全性、能力边界 |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | 按症状排查的真实故障与修复：401 签名、频控、草稿变公开、图片不显示、521 等 |

## 内部与逆向

| 文档 | 一句话 |
|---|---|
| [API-NOTES.md](API-NOTES.md) | CSDN 接口逆向记录：HMAC 规范串、`saveArticle` 字段表、状态码含义、两步图片上传、公开页校验手法、已下线接口清单 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | v1.0.0 冻结契约：分层、模块归属、接口签名、工具面、测试与提交规范、非目标 |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | v0.1.0 基线的问题清单（重构的需求输入），每条都是实测复现过的 |
| [CHANGELOG.md](CHANGELOG.md) | Keep a Changelog 格式的版本变更：1.0.0 的 Added / Changed / Fixed / Breaking 与 0.1.0 基线 |
| [LEGACY-README.md](LEGACY-README.md) | v0.1.0 的原 README，保留用于对照旧工具名与旧用法 |

## 相关文件（仓库根目录）

| 文件 | 说明 |
|---|---|
| [../.env.example](../.env.example) | 环境变量样例，复制成 `.env` 后填 `CSDN_COOKIE` |
| [../.mcp.json](../.mcp.json) | Claude Code 在本仓库内直接使用时的 MCP 配置样例 |
