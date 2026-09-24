# 故障排查

按**症状**组织。下面每一条都是在真实使用中实际发生过的，不是推演。

先打开日志再看下面的表：

```json
"env": { "CSDN_COOKIE": "...", "CSDN_LOG_LEVEL": "debug" }
```

日志走 stderr，且所有 Cookie 相关值都已脱敏，可以放心贴出来。

---

## 401 HMAC signature does not match

**现象**：请求被拒，HTTP 401，响应体里是 `HMAC signature does not match`。

**原因**：签名串和实际发出的请求对不上。按出现频率排序：

1. 规范串里漏了 `x-ca-key` / `x-ca-nonce` 两行，或者漏了 `X-Ca-Signature-Headers: x-ca-key,x-ca-nonce` 这个头——两个都参与校验，少一个就 401。
2. `uri` 只签了路径，实际请求带了查询串（`getArticle?id=...` 必须连 `?id=...` 一起签）。
3. 签名的 `Content-Type` 与实际发出的头不一致——注意普通请求用 `application/json; charset=UTF-8`（有空格），图片签名接口要求 `application/json;charset=UTF-8`（无空格）。
4. `X-Ca-Nonce` 头的值与签名串里的 nonce 不是同一个。
5. 改动了 `CSDN_APP_KEY` / `CSDN_APP_SECRET`。这两个是 CSDN 前端 bundle 里的公开常量，改了必然签不对，除非你确实指向了别的网关。

**修复**：不要手写签名，用仓库里的签名实现；`docs/API-NOTES.md#hmac-签名规范串` 有逐行的规范串定义。若是自己写的客户端在对接，逐行 diff 规范串——换行符必须是 LF，最后一行是 uri，结尾不要多一个换行。

---

## `文章频繁发布，请稍后再试`

**现象**：保存或删除文章返回该文案，工具层报 `RATE_LIMITED`。

**原因**：CSDN 对 `saveArticle` / `del` 的频控是**按账号、约 10 秒一次**。间隔不足就拒。批量改写多篇文章时最容易撞上。

**修复**：

- 别把 `CSDN_SAVE_INTERVAL_MS`（默认 `11000`）调小。撞上限流后等待更久。
- 串行执行写操作，不要并发跑两个保存。
- `RATE_LIMITED` 是可重试错误，客户端会自动重试，重试等待用 `CSDN_SAVE_INTERVAL_MS`，默认额外 2 次（`CSDN_MAX_RETRIES`）。如果 2 次还不够，说明你的调用节奏本身太快。
- 同一账号被多个进程/多个客户端同时使用时要算总账——节流是进程内的，跨进程不共享。

---

## 草稿存完却是公开状态

**现象**：调 `publish_article` 想存草稿，返回 200，结果文章已经可以匿名访问。

**原因**：`status` 传了 `0`。**CSDN 现在把 `status: 0` 当"发布"处理**，`0` 不是草稿。v0.1.0 就是踩了这个坑：用户还没审稿，文章已经公开，而且接口无法回退。

**修复**：

- v1.0.0 默认 `mode: "draft"`，对应 `status: 2` + `pubStatus: "draft"`，不会发生这种情况。如果你在别的客户端/脚本里自己拼 `saveArticle`，把 `status: 0` 改成 `2`。
- **已经发出去的文章无法通过接口退回草稿。** 正确处置是 `delete_article`（`permanent: false`，进回收站）后重建。
- 事后判断真实状态看 `verify_article`：它同时看 API 的 `status` 和公开页 HTTP 码。`statusCode: 2` + 公开页 404 才是草稿。

---

## 图片能上传但正文不显示

**现象**：`upload_image` 成功返回了 `url`，把它写进 Markdown 发布后，文章里是裂图或空白。

**原因**：按可能性排序：

1. **用错了通道。** 正文图是 `kind: "body"`（`appName: direct_blog`），封面图是 `kind: "cover"`（`appName: direct_blog_coverimage`）。两条通道不通用，用混了往往不报错，只是不显示。
2. **拿错了字段。** 要做图片链接的是响应里的 `data.imageUrl`（工具返回的 `url`），不是 `key` / `policy` / `signature` 这些存储层凭据。
3. **写了相对路径或外链。** CSDN 有防盗链，站外图片容易裂。正文里请写绝对 URL（`https://` 开头）。

**修复**：正文图统一 `kind: "body"`；封面统一 `kind: "cover"`，并且封面通过 `publish_article` 的 `cover_image` 参数传（不要塞进正文）。上传后用浏览器直接打开那个 URL 验证一次，确认公网可访问再发布。

---

## AUTH_MISSING / AUTH_INVALID

**现象**：工具返回 `AUTH_MISSING`，或 `AUTH_INVALID`。

**`AUTH_MISSING` —— 进程里根本没有 Cookie。**

- 检查 MCP 客户端配置：`env` 必须挂在 server 对象里，不是客户端配置的顶层。键名是 `CSDN_COOKIE`。
- 用了 `.env` 文件但客户端不会自动加载它——`.env` 只在你手动 `export` 或自己加载时生效。
- 先用 `auth_status` 看 `configured` 是不是 `false`。不发网络请求就能判断。

**`AUTH_INVALID` —— Cookie 存在但无效。**

- **复制来源不对**：`document.cookie` 拿不到 `UserToken`（HTTP-only），必须从 F12 → Network → Request Headers → Cookie 整段复制。
- **复制不完整**：缺 `UserName=` 也会被本地校验拦下。
- **Cookie 过期**：登录态失效，重新取一次即可。服务运行期间可以用 `auth_login` 直接换，不用重启进程。
- 注意 `AUTH_INVALID` 也覆盖"CSDN 返回 401/403"以及信封里 `code` 为 `401` / `403` / `700` 的情况。

**修复**：按 [CONFIGURATION.md](CONFIGURATION.md#cookie-怎么取) 重新取 Cookie，用 `auth_login` 或改环境变量后重启客户端。

---

## 公开页返回 521

**现象**：`verify_article` 或写入后自检里，`publicStatusCode: 521`。

**原因**：521 是 **Cloudflare** 的错误码，表示源站不可达——和你的文章状态无关。这是 CDN 侧的问题，不是"文章不存在"。

**修复**：

- **重试**，不要据此判断文章没发布。把 521 当成"这次没测出来"，而不是"测试失败"。
- 同一时刻 404 与 521 的含义完全不同：404 是有意义的信号（未公开），521 不是。
- 若 521 持续出现，说明 CSDN 站点侧正在故障，等一会儿再校验；此时 `get_article` 的 API 状态仍是可用的判据。

---

## list_articles 看不到草稿

**现象**：刚保存的草稿，`list_articles` 里找不到。

**原因**：不是 bug。`list_articles` 走的是**公开**社区接口，只列已发布文章，而且**不需要 Cookie**。草稿不在公开列表里，这是接口本身的性质，没有过滤参数能打开。

**修复**：用 `get_article`（按 `article_id`）查草稿。要审核/修改草稿，走 `get_article` → `update_article`。

---

## update_article 改了正文但线上没变

**现象**：`update_article` 传了新的 `markdown`，返回成功，但已经发布的文章正文还是旧的。

**原因**：**CSDN 只在编辑器 UI 发布时把正文应用到线上**，API 对已发布文章改的是**草稿副本**。这是接口层面的边界，不是本服务的选择——`docs/ARCHITECTURE.md` §7 把"通过 API 编辑已发布文章的正文"列为 v1.0.0 的非目标。

**修复**：

- 元数据（标题、标签、摘要、封面）改得动，正文改不动。工具会如实返回状态，不会假装正文已经更新。
- 需要改已发布正文时，只能打开 CSDN 编辑器 UI 手动改并发布。
- 还没发布的内容不受影响：草稿的正文可以反复用 `update_article` 修改。

---

## 正文里出现了 `##` 和 `**` 字面量

**现象**：文章发出来了，但正文开头真的显示 `## 标题`、`**加粗**` 这些标记符号。

**原因**：`saveArticle` 的 `content` 字段要的是**渲染后的 HTML**，Markdown 原文只能放在 `markdowncontent` 里。v0 把 Markdown 原文直接塞进了 `content`，于是 CSDN 把标记符号当普通文本显示，编辑器里还多存了一份带标记的渲染结果。

**修复**：

- v1.0.0 的 `content` 一律由 Markdown 渲染器生成（开启 GFM，表格/任务列表/删除线才会正确渲染），Markdown 原文进 `markdowncontent`。
- 如果你在别处自己拼 `saveArticle`：先渲染再赋值，不要偷懒把两份都填 Markdown。
- 已经发出去的文章，正文可以重新用 `update_article` 覆盖草稿副本；已发布文章的正文变更路径见上一节。

---

## 摘要不是我写的那段

**现象**：明明传了 `description`，线上摘要却是正文开头被截了一段。

**原因**：接口字段名是**大写的 `Description`**。传小写 `description` 时 CSDN **不报错、静默丢弃**，然后退回截取正文开头。这是 v0.1.0 最隐蔽的一个 bug。

**修复**：v1.0.0 传的是 `Description`，不会再有这个问题。自己拼请求的话把字段名改成 `Description`（大写 D，其余小写）。另外摘要 ≤ 256 字，超了会在发请求前被 `INVALID_ARGUMENT` 拦下。

---

## MALFORMED_RESPONSE：接口返回的不是 JSON

**现象**：`MALFORMED_RESPONSE`，`detail` 里是一段 HTML。

**原因**：请求打到了**已经下线或改名**的接口。bizapi 对不存在的路径会返回 `openresty` 的 404 HTML 页面（实测状态码是 HTTP 404），内容不是 JSON。已知下线的端点见 [API-NOTES.md](API-NOTES.md#7-已下线的端点)。

**修复**：确认你/工具用的是本文列出的在端点。元数据工具在接口失效时会降级为内置列表 + `source: "builtin"`，看到 `builtin` 就说明线上接口这次没取到。

---

## 服务启动就退出 / 客户端显示连接失败

**现象**：MCP 客户端里工具列表是空的；手动运行 `node dist/index.js` 进程立刻结束。

**原因**：

1. 没 `npm run build`，`dist/index.js` 不存在。
2. 客户端配置里的路径不是绝对路径（客户端的工作目录和你的 shell 不同）。
3. 启动确实失败了——`index.ts` 会把原因写到 stderr 并以退出码 1 结束。

**修复**：

```bash
npm run build
node /absolute/path/to/csdn-mcp/dist/index.js   # 手动跑一次，看 stderr
```

stderr 里会打印 `[csdn-mcp] 启动失败 <错误>`。另外注意：**stdout 是 MCP 协议流**，日志全在 stderr——如果你的客户端把 stderr 当协议读，会解析失败，那是客户端的配置问题。

---

## VERIFY_FAILED（自检不一致）

**现象**：`publish_article` / `update_article` 返回的 `verification.consistent` 是 `false`，`warnings` 和摘要行里写着不一致；如果意图是草稿而文章已经公开可见，摘要行最前面还会要求**立即删除**。

> `VERIFY_FAILED` 是错误码表里为这种情况保留的码，但 v1.0.0 的工具层**不把它当错误返回**：自检不一致时仍返回完整 payload（`articleId`、`url`、`verification`、`warnings`），因为"删除这篇误发布的文章"恰恰需要那个 `articleId`——换成 error 返回就把它弄丢了。

**原因**：写入返回成功，但自检结果和写入的声明不一致——例如声称发布了、公开页却仍返回 404（文章还在审核，或 CDN 缓存未刷新），或声称是草稿、公开页却已经 200。

**修复**：

- 用 `verify_article` 再测一次，间隔几秒。刚发布的文章会有短暂的审核/缓存窗口。
- 公开页返回 404 而 API 是 `reviewing`（`status: 16`）时，属于正常在途状态，等审核通过即可。
- 公开页返回 521 时属于 CDN 故障，重试，不要当成文章状态（见上一节）。
- **不要**因为验签失败就重复发文章——先 `get_article` 确认线上到底有几篇，再用 `delete_article` 清理多余的那篇。
