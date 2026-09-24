# 配置

## 环境变量

全部来自 `src/core/config.ts` 的 `loadConfig`。整数值若解析失败或为负数，回退到默认值；字符串若为空或只有空白，同样回退。

| 变量 | 默认值 | 作用 | 什么时候需要改 |
|---|---|---|---|
| `CSDN_COOKIE` | `""` | 认证凭据。作为 `Cookie` 头发给所有需要登录的接口 | **必填**。不配任何写操作都会 `AUTH_MISSING` |
| `CSDN_USERNAME` | `""` | 账号名。仅当 Cookie 里取不到 `UserName` 时使用 | Cookie 不完整但你确知账号名时 |
| `CSDN_LOG_LEVEL` | `warn` | 日志级别：`silent` / `error` / `warn` / `info` / `debug`。日志写 stderr | 排查问题时开 `debug`；不想看日志开 `silent` |
| `CSDN_TIMEOUT_MS` | `20000` | 单次请求超时（毫秒） | 网络慢时调大；CI 里想快速失败时调小 |
| `CSDN_MAX_RETRIES` | `2` | 首次之外的重试次数。只对可重试错误生效 | 网络抖动严重时调大；不希望自动重试时设 `0` |
| `CSDN_MIN_INTERVAL_MS` | `250` | 普通签名请求之间的最小间隔（毫秒） | 一般不用动；被限流时可调大 |
| `CSDN_SAVE_INTERVAL_MS` | `11000` | 写操作（保存 / 删除）之间的最小间隔（毫秒） | CSDN 约 10 秒内会拒绝连续保存。要放宽就调大，不建议调小 |
| `CSDN_API_BASE` | `https://bizapi.csdn.net` | 签名接口的网关地址。末尾斜杠会被去掉 | 仅用于指向测试网关 |
| `CSDN_BLOG_BASE` | `https://blog.csdn.net` | 公开页地址，写入后校验用 | 一般不用动 |
| `CSDN_COMMUNITY_BASE` | `https://blog.csdn.net` | 公开社区列表接口地址 | 一般不用动 |
| `CSDN_USER_AGENT` | Chrome 131 桌面版 UA | 所有请求的 `User-Agent` | 一般不用动 |
| `CSDN_APP_KEY` | `203803574` | bizapi 网关 app key | 这是 CSDN 前端 bundle 里的**公开常量**，不是密钥。只在测试时覆盖 |
| `CSDN_APP_SECRET` | `9znpamsyl2c7cdrr9sas0le9vbc3r6ba` | bizapi 网关签名密钥 | 同上，公开常量。只为测试覆盖而存在 |

最小可用配置只有一个变量：

```bash
export CSDN_COOKIE="UserToken=...; UserName=用户名; ..."
```

仓库根的 `.env.example` 是同一份清单的样例，复制成 `.env` 再填 Cookie 即可。**`.env` 已被 gitignore，永远不要提交。**

## Cookie 怎么取

`UserToken` 是 **HTTP-only** cookie，`document.cookie` 取不到它——所以下面这条路必须走 DevTools 的请求头，不能走控制台。

1. 浏览器登录 [csdn.net](https://www.csdn.net/)。
2. `F12` → **Network** 面板。
3. 刷新页面，或点进"创作中心"触发一次请求。
4. 点任意一个发往 `csdn.net` 的请求 → **Request Headers** → 找到 **Cookie**。
5. **整段复制**（右键 → Copy value），粘进 `CSDN_COOKIE`，保持在**一行**内。

复制完整性检查（`auth_login` 的本地校验用的就是这套规则）：

- 必须包含 `UserToken=`。
- 必须包含 `UserName=`（否则会报"可能复制不完整"）。
- 没看到 `UserToken=` 说明你复制的是 `document.cookie` 的产物，或者只复制了一部分。

### 为什么 `document.cookie` 不行

`UserToken` 带 HTTP-only 标记，浏览器不会把它暴露给 JavaScript，所以：

```js
document.cookie          // 能看到 uuid_tt_dd、UserName 等，看不到 UserToken
```

用这份字符串去配置，服务端拿到的请求会被判定为未登录。工具层把这种情况单独列为一种失败，而不是笼统的"Cookie 无效"——因为这是最常见的配置错误。

Cookie 会过期。一旦接口开始返回 `AUTH_INVALID`，重新按上面 5 步取一次即可；服务运行期间也可以用 `auth_login` 直接换，不用重启进程。

## 客户端配置

下面 5 份配置都是可以直接粘贴的。`args` 里的路径必须是 `dist/index.js` 的**绝对路径**（Windows 上写成 `C:\\path\\to\\csdn-mcp\\dist\\index.js`）。

### Claude Desktop

`claude_desktop_config.json`：

- Windows：`%APPDATA%\Claude\claude_desktop_config.json`
- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux：`~/.config/Claude/claude_desktop_config.json`

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

改完要重启 Claude Desktop。

### Cursor

全局 `~/.cursor/mcp.json`，或项目内 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "csdn": {
      "command": "node",
      "args": ["/absolute/path/to/csdn-mcp/dist/index.js"],
      "env": {
        "CSDN_COOKIE": "UserToken=...; UserName=...; ..."
      }
    }
  }
}
```

### Cline

`cline_mcp_settings.json`：

- Windows：`%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- macOS：`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

```json
{
  "mcpServers": {
    "csdn": {
      "command": "node",
      "args": ["/absolute/path/to/csdn-mcp/dist/index.js"],
      "env": {
        "CSDN_COOKIE": "UserToken=...; UserName=...; ..."
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

`autoApprove` 建议留空：`publish_article` 的 `mode: "publish"` 与 `delete_article` 都属于会让线上内容变化的操作，值得每次确认。

### VS Code（原生 MCP）

项目内 `.vscode/mcp.json`：

```json
{
  "servers": {
    "csdn": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/csdn-mcp/dist/index.js"],
      "env": {
        "CSDN_COOKIE": "UserToken=...; UserName=...; ..."
      }
    }
  }
}
```

注意 VS Code 用的是 `servers` 键，不是 `mcpServers`，并且要显式写 `"type": "stdio"`。

### Claude Code（仓库内）

本仓库根目录已带一份 `.mcp.json`，在仓库里打开 Claude Code 会直接生效：

```json
{
  "mcpServers": {
    "csdn-publisher": {
      "command": "node",
      "args": ["./dist/index.js"]
    }
  }
}
```

这里用的是相对路径，只在仓库目录下有效；Cookie 走 shell 环境变量传入。

### 通用 stdio 客户端

任何支持 stdio 传输的 MCP 客户端，本质只需三件事：

```
可执行文件：node
参数：      /absolute/path/to/csdn-mcp/dist/index.js
环境变量：  CSDN_COOKIE=...
```

服务把 JSON-RPC 写在 **stdout**，日志写在 **stderr**。如果客户端把 stderr 当协议流读，会出现乱码或解析失败——那是客户端配置问题，`CSDN_LOG_LEVEL=silent` 可以临时验证这一点。

也可以用 npm 安装后的 bin：

```bash
csdn-mcp              # 等价于 node dist/index.js
node dist/index.js    # 本地构建后的直接入口
```

## 环境要求

- **Node.js ≥ 18.17**（`package.json` 的 `engines`；实际使用 Node 26 开发与验证）。
- 包是 **ESM**（`"type": "module"`），入口是 `dist/index.js`，必须先 `npm run build`。
- 不需要浏览器，也不需要任何图形环境——本服务是无头设计。
