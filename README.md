# csdn-mcp

> MCP server for CSDN — let any AI agent publish, query and manage your blog posts.

## ⚠️ 当前状态：v0.1.0 (legacy baseline)

这个仓库当前处于**重构起点**。`main` 上的 `src/index.ts` 是一个单文件 MCP server，
它是 [mcp-csdn-publisher](https://github.com/Ln129402/mcp-csdn-publisher) 经过 Hermes
实测反馈后打过补丁的版本，作为重构的**功能基线**保留。

它**能跑，但能力不完整**，已知问题记录在 [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md)。

## 快速开始

```bash
git clone https://github.com/Leaderxin/csdn-mcp.git
cd csdn-mcp
npm install
npm run build
```

在 MCP 客户端（Claude Desktop / Cursor / Cline …）中配置：

```json
{
  "mcpServers": {
    "csdn": {
      "command": "node",
      "args": ["/absolute/path/to/csdn-mcp/dist/index.js"],
      "env": { "CSDN_COOKIE": "<your cookie>" }
    }
  }
}
```

## 已提供的工具（v0.1.0）

| Tool | 说明 | 可用性 |
|---|---|---|
| `login` | 设置并校验 CSDN Cookie | ✅ |
| `publish-blog` | 新建文章（草稿 / 发布） | ⚠️ 见已知问题 |
| `list-categories` | 读取分类列表 | ❌ 接口已 404 |
| `list-tags` | 读取标签列表 | ❌ 接口已 404 |

> v1.0 将完整覆盖 发布 / 查询 / 编辑 / 删除 / 图片 / 认证 等能力，见
> [`docs/ROADMAP.md`](docs/ROADMAP.md)。

## License

MIT — 衍生于 [mcp-csdn-publisher](https://github.com/Ln129402/mcp-csdn-publisher)。
