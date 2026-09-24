# csdn-mcp

让 AI Agent 通过 MCP 协议管理 CSDN 博客：发布、查询、修改、删除、上传图片。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Leaderxin/csdn-mcp/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/Leaderxin/csdn-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Leaderxin/csdn-mcp/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blue.svg)](https://modelcontextprotocol.io/)

## 30 秒快速开始

```bash
git clone https://github.com/Leaderxin/csdn-mcp.git
cd csdn-mcp
npm install
npm run build
```

然后把下面这段加进 MCP 客户端配置（`args` 必须是 `dist/index.js` 的**绝对路径**）：

```json
{
  "mcpServers": {
    "csdn": {
      "command": "node",
      "args": ["/absolute/path/to/csdn-mcp/dist/index.js"],
      "env": {
        "CSDN_COOKIE": "把整段 Cookie 粘到这里",
        "CSDN_LOG_LEVEL": "warn"
      }
    }
  }
}
```

`CSDN_COOKIE` 是唯一必填项，没有它任何写操作都会返回 `AUTH_MISSING`。获取方式见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md#cookie-怎么取)。

## 工具一览

11 个工具，全部走 stdio。参数、返回结构、错误码的完整定义见 [docs/TOOLS.md](docs/TOOLS.md)。

| 工具              | 说明                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `auth_login`      | 运行期设置 Cookie，随后所有请求立即生效，无需重启进程                |
| `auth_status`     | 检查当前 Cookie 是否已配置、格式是否合法、账号名是什么               |
| `publish_article` | 新建文章；`mode` 默认 `draft`，发布必须显式传 `mode: "publish"`      |
| `update_article`  | 更新已有文章；改标题/标签/摘要/封面 + 草稿副本                       |
| `get_article`     | 按 ID 读取单篇文章，可选是否带正文                                   |
| `list_articles`   | 列出文章；`scope=published` 只看已发布，`scope=all` 含草稿与分类计数 |
| `delete_article`  | 删除文章，默认进回收站，`permanent: true` 彻底删除                   |
| `upload_image`    | 上传本地图片，返回公网 URL，分 `cover` / `body` 两条通道             |
| `list_categories` | 列出文章分类；接口不可用时回退到内置列表                             |
| `list_tags`       | 列出常用标签；接口不可用时回退到内置列表                             |
| `verify_article`  | 回查 API 状态 + 公开页 HTTP 码，确认文章真实状态                     |

## 一次真实的 Agent 调用流程

```
用户：把这篇《MCP 协议入门》给我发成草稿，先别公开。

Agent → publish_article({
          "title": "MCP 协议入门",
          "markdown": "# MCP 协议入门\n\n...",
          "tags": ["MCP", "TypeScript"],
          "categories": "后端"
        })
← { "articleId": "149234567",
    "url": "https://blog.csdn.net/Leaderxin/article/details/149234567",
    "state": "draft",
    "verification": { "state": "draft", "statusCode": 2,
                      "publicStatusCode": 404, "consistent": true,
                      "message": "草稿状态与公开页一致（公开页 404）" } }

Agent → verify_article({ "article_id": "149234567", "expected": "draft" })
← { "articleId": "149234567", "state": "draft", "statusCode": 2,
    "publicStatusCode": 404, "consistent": true, "message": "..." }

用户：内容我看过了，发布吧。

Agent → update_article({ "article_id": "149234567", "mode": "publish" })
← { "articleId": "149234567",
    "url": "https://blog.csdn.net/Leaderxin/article/details/149234567",
    "state": "published" }

Agent → verify_article({ "article_id": "149234567", "expected": "publish" })
← { "articleId": "149234567", "state": "published", "statusCode": 1,
    "publicStatusCode": 200, "consistent": true, "message": "..." }
```

注意 `publish_article` 在步骤 1 里**没有**传 `mode` —— 默认就是草稿。只有用户在步骤 3 明确要求之后，Agent 才发出版本。原因见 [docs/TOOLS.md](docs/TOOLS.md#publish_article)。

## 配置项

完整说明（含"什么时候需要改"）见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。

| 变量                    | 默认值                             | 作用                                                          |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------- |
| `CSDN_COOKIE`           | `""`                               | 认证凭据。所有写操作的必填项                                  |
| `CSDN_USERNAME`         | `""`                               | Cookie 里没有 `UserName` 时使用                               |
| `CSDN_LOG_LEVEL`        | `warn`                             | `silent` / `error` / `warn` / `info` / `debug`，日志走 stderr |
| `CSDN_TIMEOUT_MS`       | `20000`                            | 单次请求超时                                                  |
| `CSDN_MAX_RETRIES`      | `2`                                | 可重试失败的额外尝试次数                                      |
| `CSDN_MIN_INTERVAL_MS`  | `250`                              | 普通请求之间的最小间隔                                        |
| `CSDN_SAVE_INTERVAL_MS` | `11000`                            | 写操作之间的最小间隔（CSDN 约 10s 内会拒绝）                  |
| `CSDN_API_BASE`         | `https://bizapi.csdn.net`          | bizapi 网关地址                                               |
| `CSDN_BLOG_BASE`        | `https://blog.csdn.net`            | 公开页地址，用于写后校验                                      |
| `CSDN_COMMUNITY_BASE`   | `https://blog.csdn.net`            | 社区列表接口地址                                              |
| `CSDN_USER_AGENT`       | Chrome 131 UA                      | 请求头 `User-Agent`                                           |
| `CSDN_APP_KEY`          | `203803574`                        | bizapi 网关 app key（公开常量）                               |
| `CSDN_APP_SECRET`       | `9znpamsyl2c7cdrr9sas0le9vbc3r6ba` | bizapi 网关签名密钥                                           |

## 它是怎么工作的

**HMAC 签名。** 所有走 `bizapi.csdn.net` 的请求都要带 `X-Ca-Signature`。签名串由 method、accept、content-type、`x-ca-key`、`x-ca-nonce` 和含查询串的 uri 按固定换行拼成，再做 `base64(HMAC-SHA256(appSecret, stringToSign))`；同时必须带 `X-Ca-Signature-Headers: x-ca-key,x-ca-nonce` 告诉网关哪几个 header 参与了签名。少一行就是 `401 HMAC signature does not match`。完整格式见 [docs/API-NOTES.md](docs/API-NOTES.md#hmac-签名规范串)。

**两步图片上传。** 先 POST `/resource-api/v1/image/direct/upload/signature` 拿上传凭据，再 multipart 直传到返回的存储 host，响应里的 `data.imageUrl` 才是公网地址。正文图和封面图是两条不同的通道（`appName` 不同），不可互换。见 [docs/TOOLS.md](docs/TOOLS.md#upload_image)。

**为什么每次写入都要回查公开页。** `saveArticle` 返回 200 不等于成功——v0 用 `status: 0` 表示草稿，CSDN 却把它当发布处理，用户拿到 200 的同时文章已经公开可见。所以 `publish_article` / `update_article` 默认跑一次校验：既看 API 返回的 `status`，也真的去请求一次公开页，只有两边都说"是草稿"（公开页 404）或都说"已发布"（公开页 200）才判定 `consistent: true`。任何一边不一致都会如实报告，不会因为一个 200 就宣称"发布成功"。

## v0.1.0 到 v1.0.0 修了什么

- **草稿状态码写反**：v0 用 `status: 0` 当草稿，实际会被直接发布，且无法回退。v1 草稿是 `status: 2` + `pubStatus: 'draft'`，发布是 `status: 1`。
- **摘要字段大小写错误**：v0 传小写 `description`，CSDN 只认大写 `Description`，摘要被静默丢弃。v1 传 `Description`，并且前置校验 ≤256 字。
- **发完不自检**：v1 每次写入都回查 `getArticle.status` 与公开页 HTTP 码。
- **图片上传走已下线域名**：`imgservice.csdn.net` 全 404，v1 改走 `resource-api/v1/image/direct/upload/signature` 两步上传。
- **入参不校验**：v1 在发请求之前拦住 `tags` > 5、`description` > 256 字、空 `markdown`、非法 `kind`。
- **工具面缺失**：从 4 个工具（其中 2 个接口已失效）补齐到 11 个，新增查询、编辑、删除、图片、状态校验能力。
- **频控 / 重试 / 超时**：内置客户端节流（写操作默认间隔 11s）与可重试错误的指数退避，网络抖动不再直接失败。
- **错误不可读**：v0 全部返回 `code: -1` + 字符串；v1 改为命名错误码（`AUTH_INVALID`、`RATE_LIMITED`、`VERIFY_FAILED` 等）+ 可重试标记。
- **Cookie 可能进日志**：v1 日志统一脱敏，且只写 stderr——stdout 属于 MCP 协议流。

## 文档

| 文档                                               | 内容                                       |
| -------------------------------------------------- | ------------------------------------------ |
| [docs/README.md](docs/README.md)                   | 文档索引                                   |
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | 从零到第一次成功调用                       |
| [docs/TOOLS.md](docs/TOOLS.md)                     | 11 个工具的参数、返回、错误码              |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md)     | 环境变量 + 各客户端配置                    |
| [docs/API-NOTES.md](docs/API-NOTES.md)             | 逆向记录：签名串、saveArticle 字段、状态码 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 按症状排查                                 |
| [docs/FAQ.md](docs/FAQ.md)                         | 常见问题与能力边界                         |
| [docs/CHANGELOG.md](docs/CHANGELOG.md)             | 版本变更                                   |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)       | 分层、模块边界、冻结的工具面               |
| [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)       | v0.1.0 基线问题清单                        |

## 许可

MIT，见 [LICENSE](LICENSE)。

本项目派生自 [mcp-csdn-publisher](https://github.com/Ln129402/mcp-csdn-publisher)，上游版权声明按 MIT 的要求保留在 [NOTICE](NOTICE)。
（`LICENSE` 里只放本项目自己的标准 MIT 全文——掺进派生说明会让 GitHub 的许可证识别器匹配不上，仓库侧栏会显示成 `Other`。）
