# 快速上手

目标：从零到第一次成功调用，大约 5 分钟。

## 1. 装依赖、构建

```bash
git clone https://github.com/Leaderxin/csdn-mcp.git
cd csdn-mcp
npm install
npm run build
```

要求 Node.js ≥ 18.17。构建产物是 `dist/index.js`（ESM）。确认一下：

```bash
ls dist/index.js
```

后面的配置里请用**绝对路径**指向这个文件，别用相对路径——MCP 客户端的工作目录不是你能预料的。

## 2. 取 Cookie

1. 浏览器登录 [csdn.net](https://www.csdn.net/)。
2. `F12` → **Network** → 刷新页面。
3. 点任意一个发往 `csdn.net` 的请求 → **Request Headers** → **Cookie**。
4. 整段复制，确保里面有 `UserToken=` 和 `UserName=`。

**不要**在浏览器控制台执行 `document.cookie` 去取——`UserToken` 是 HTTP-only cookie，控制台看不到它。原因见 [CONFIGURATION.md](CONFIGURATION.md#为什么-documentcookie-不行)。

## 3. 配客户端

以 Claude Desktop 为例（其余客户端的现成配置见 [CONFIGURATION.md](CONFIGURATION.md#客户端配置)）：

```json
{
  "mcpServers": {
    "csdn": {
      "command": "node",
      "args": ["/absolute/path/to/csdn-mcp/dist/index.js"],
      "env": {
        "CSDN_COOKIE": "UserToken=...; UserName=...; ...",
        "CSDN_LOG_LEVEL": "warn"
      }
    }
  }
}
```

重启客户端。服务启动失败时会把原因写到 stderr，并把退出码置为 1——看不到日志就先临时把 `CSDN_LOG_LEVEL` 换成 `debug`。

## 4. 确认认证正常

让 Agent 调用：

```
auth_status
```

期望：

```json
{ "configured": true, "valid": true, "username": "你的用户名" }
```

- `configured: false` → `CSDN_COOKIE` 没传进进程（检查客户端配置里 `env` 的位置，它属于 server 对象，不属于客户端顶层）。
- `valid: false` → Cookie 不完整，多半缺 `UserToken` 或 `UserName`。重做第 2 步。

也可以直接调 `auth_login` 在运行期换 Cookie，换完立刻生效，不用重启。

## 5. 走一遍草稿流程

```
1) publish_article({ "title": "测试草稿", "markdown": "# 测试草稿\n\n这是一次连通性验证。" })
2) get_article({ "article_id": "<上一步返回的 articleId>" })
3) verify_article({ "article_id": "<同上>", "expected": "draft" })
4) delete_article({ "article_id": "<同上>" })
```

第 1 步**没有传 `mode`**，因此得到的是一篇草稿：`state: "draft"`、`statusCode: 2`、公开页 404，`verification.consistent: true`。

确认无误后不要删，改成：

```
update_article({ "article_id": "<同上>", "mode": "publish" })
verify_article({ "article_id": "<同上>", "expected": "publish" })
```

公开页返回 200 才算真的上线了。

## 6. 图片放进正文

```
upload_image({ "path": "/tmp/diagram.png", "kind": "body" })
```

把返回的 `url` 写进 Markdown 的图片语法：感叹号 + 方括号里写说明文字 + 圆括号里填那个 URL。封面图要用 `kind: "cover"`，**两条通道不能混用**。正文里请写绝对 URL——CSDN 有防盗链，外链图片容易裂。

## 下一步

| 想知道 | 看 |
|---|---|
| 每个工具的完整参数与错误码 | [TOOLS.md](TOOLS.md) |
| 所有环境变量与客户端配置 | [CONFIGURATION.md](CONFIGURATION.md) |
| 报错了怎么办 | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| 接口是怎么逆出来的 | [API-NOTES.md](API-NOTES.md) |
| 能力边界（哪些做不到） | [FAQ.md](FAQ.md) |
