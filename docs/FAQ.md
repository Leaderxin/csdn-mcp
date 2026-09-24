# 常见问题

## 这是 CSDN 官方 API 吗？

不是。CSDN 没有公开的博客写入 API，本服务用的是它创作中心前端自己在用的一套内部接口（`bizapi.csdn.net`）。全部信息来自逆向 + 实测，见 [API-NOTES.md](API-NOTES.md)。

**这意味着**：接口是 CSDN 的私有实现，随时可能变，且不会有任何通知。服务侧能做的是出错时给出可读的错误码，而不是假装稳定。

## 用这个会被封号吗？

不知道，没有人能从 CSDN 拿到这个保证。

能说清楚的是服务怎么发出的请求：用**你自己的账号 Cookie**、你平时用的 User-Agent、和浏览器编辑器一致的 `Referer` / `Origin`，并且内置了节流（写操作默认间隔 11 秒），不会对你的账号发起高频写入。它不注册账号、不刷评论、不抓别人的数据。

风险自担的部分：这是非公开接口，CSDN 的用户协议没有覆盖"用脚本发文章"这个场景。如果你在意，就只在自己的账号上用，并且保持人审之后再发布（`mode` 默认就是 `draft`，这是有意为之）。

## 需要浏览器吗？要装 Playwright / Puppeteer 吗？

不需要。这个服务是**无头设计**，不启动任何浏览器，只用 HTTPS 请求。全项目没有浏览器自动化依赖。

唯一的"浏览器"步骤是**你手动取一次 Cookie**：F12 → Network → Request Headers → Cookie。取完就不需要浏览器了。

## 怎么把图片放进文章？

两步：

```
upload_image({ "path": "/path/to/图.png", "kind": "body" })
→ { "url": "https://img-blog.csdnimg.cn/direct/xxx.png", ... }
```

然后把返回的 `url` 写进 Markdown：`![说明](https://img-blog.csdnimg.cn/direct/xxx.png)`。

注意：

- 正文图用 `kind: "body"`，封面图用 `kind: "cover"`，**两条通道不通用**。封面是传给 `publish_article` / `update_article` 的 `cover_image` 参数，不是塞进正文。
- 支持 `.jpg` / `.jpeg` / `.png` / `.gif` / `.webp` / `.bmp`。
- 正文里请写**绝对 URL**。CSDN 有防盗链，站外图容易裂。
- 目前没有"自动下载 Markdown 里的外链图片再转存"这个功能，需要你自己先 `upload_image` 再替换链接。

## 能改已经发布的文章吗？

**分两种情况，区别很重要。**

- **元数据**（标题、标签、摘要、封面）：能改，`update_article` 直接改。
- **已发布文章的正文**：**改不动。** CSDN 只在编辑器 UI 发布时把正文应用到线上，而 API 改的是**草稿副本**。这是接口层面的边界，不是本服务偷懒——`docs/ARCHITECTURE.md` §7 明确把"通过 API 编辑已发布文章的正文"列为非目标。工具会如实说明，不会假装改成功。

所以已发布正文的修改路径只有一条：打开 CSDN 编辑器 UI 手动改并发布。

还没发布的内容不受此限——草稿的正文可以反复用 `update_article` 改，满意了再 `mode: "publish"`。

## 我的 Cookie 安全吗？

它的传播范围是：

- 传给 CSDN 的请求头（这是它唯一的用途）。
- 你的 MCP 客户端配置文件——**这是最需要注意的地方**，很多客户端把配置放在明文 JSON 里。
- **不会**进日志：日志层对所有消息和字段统一做脱敏，`UserToken` / `UserName` / `csrfToken` 等一律替换成 `<redacted>`。也不能写进 git——`.env` 已在 `.gitignore` 里。

建议：把 Cookie 当成密码对待。别贴进 issue、别贴进聊天记录、别人给的 Cookie 不要用。失效了重新取一个就行，服务运行期间用 `auth_login` 换，不用重启。

## 有频率限制吗？

有，而且是 CSDN 服务端限的，不是本服务限的：

- **保存 / 删除**：约 10 秒一次。间隔不足会返回 `文章频繁发布，请稍后再试`，映射为 `RATE_LIMITED`。
- **普通读写**：突发可以，持续打会被拦。

服务侧做了客户端节流（`CSDN_MIN_INTERVAL_MS=250`、`CSDN_SAVE_INTERVAL_MS=11000`），并对 `NETWORK` / `TIMEOUT` / `RATE_LIMITED` / `SERVER_ERROR` 自动重试（默认额外 2 次，退避 500ms → 1s → 2s）。

**不要**把 `CSDN_SAVE_INTERVAL_MS` 调小——撞上限流要等更久。批量操作请串行。

## 为什么存了草稿，`list_articles` 里没有？

因为那篇是草稿。`list_articles` 走**公开**社区接口，只列已发布文章，而且不需要 Cookie——草稿不在里面不是过滤条件的问题，是接口本身不给。

要查草稿用 `get_article`，传 `article_id`。

## 文章状态 `6` 和 `16` 是什么意思？

- `6` = `rejected`，**审核未通过**，返回的 `reason` 字段会给出原因。
- `16` = `reviewing`，**审核中**。这个状态下公开页仍然是 404，直到审核通过。

完整的码表（含 `0` / `1` / `2`）见 [API-NOTES.md](API-NOTES.md#3-状态码表)。表里没有的码一律报 `unknown`，不会猜。

## 它支持哪些 MCP 客户端？

任何支持 stdio 传输的 MCP 客户端都可以。文档里**写出完整配置**的是这几个：Claude Desktop、Cursor、Cline、VS Code（原生 MCP）、Claude Code（仓库根目录的 `.mcp.json`），以及"通用 stdio 客户端"的最小三分量（命令 / 参数 / 环境变量）。

其余客户端没有在本文档里给出配置，所以也不在此声明兼容——照上面几个的 `mcpServers`（或 `servers`）结构照搬通常可以，但那是你自己验证的事。配置见 [CONFIGURATION.md](CONFIGURATION.md#客户端配置)。

## 需要什么运行环境？

- Node.js ≥ 18.17（`engines` 字段）。实际开发与验证用的是 Node 26。
- 包是 ESM，入口 `dist/index.js`，必须先 `npm run build`。
- 无浏览器、无图形环境依赖。
- 只在**本机**运行，不需要暴露任何端口——stdio 传输，不监听网络。

## 能批量发布 / 一次发多篇吗？

可以，但必须**串行**，并且遵守 10 秒的写入间隔：`publish_article` 一次只处理一篇，连续调用之间的间隔由客户端节流保证（`CSDN_SAVE_INTERVAL_MS`）。并发发多篇必然撞 `RATE_LIMITED`。

另外 `mode` 默认是 `draft`——批量场景更建议先全部落成草稿，人工过一遍再逐篇 `mode: "publish"`。

## 有哪些事它做不到？

明确列一下，免得试：

- 通过 API 修改**已发布文章**的正文（只能在 CSDN 编辑器 UI 里改）。
- 列出草稿（`list_articles` 只有公开文章）。
- 获取阅读量趋势、评论、粉丝、收益等分析数据——只读得到单篇/列表里的 `viewCount`、`diggCount`、`collectCount`、`commentCount` 这类计数字段。
- 自动把 Markdown 里的外链图片转存到 CSDN。
- 把已发布的文章退回草稿（`status` 写反了之后 API 回不去，只能删掉重建）。
- 管理评论。
