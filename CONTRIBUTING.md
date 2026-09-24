# 贡献指南

本文只讲参与开发必须知道的事：怎么装、有哪些命令、代码怎么分层、测试要过什么闸门、提交怎么写。
接口与模块契约以 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 为准，两者冲突时以那份文档为准。

## 1. 开发环境

要求 Node >= 18.17（见 `package.json` 的 `engines`）与 npm 9+。

```bash
git clone https://github.com/Leaderxin/csdn-mcp.git
cd csdn-mcp
npm ci                    # 严格按 package-lock.json 安装，不要用 npm install
npm run build             # tsc -p tsconfig.build.json，产物在 dist/
cp .env.example .env      # 再把 CSDN_COOKIE 填进去
```

- `.env` 已被 `.gitignore` 忽略，**永远不要提交**。
- 跑单元测试不需要 cookie；只有 `npm run test:live` 和 `scripts/live-smoke.mjs` 需要真实 cookie。
- Cookie 取法：F12 → Network → 任意 `csdn.net` 请求 → Request Headers → Cookie，整段复制。必须包含 `UserToken=`；它是 HTTP-only cookie，`document.cookie` 取不到，粘贴后一定要自查。

## 2. 常用命令

| 命令                    | 作用                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `npm run build`         | `tsc -p tsconfig.build.json`，编译到 `dist/`（发布产物）                            |
| `npm run dev`           | 同上的 watch 模式                                                                   |
| `npm run start`         | `node dist/index.js`，手工起 MCP server（stdio，无 `--help`，起来后会阻塞等待帧）   |
| `npm run typecheck`     | `tsc --noEmit`，覆盖 `src/`、`tests/` 与 vitest 配置                                |
| `npm run lint`          | `eslint . --ext .ts`，类型感知规则见 `.eslintrc.cjs`                                |
| `npm test`              | `vitest run`，不联网                                                                |
| `npm run test:watch`    | vitest 监听模式                                                                     |
| `npm run test:coverage` | 带覆盖率，未达阈值即失败                                                            |
| `npm run test:live`     | 打真实 CSDN 接口的集成测试（内部固定 `CSDN_LIVE=1`），只建草稿、必须删除            |
| `npm run format`        | prettier 写入 `{src,tests}/**/*.ts`、根目录 `*.md`、`docs/**/*.md`                  |
| `npm run format:check`  | prettier 只检查不写                                                                 |
| `npm run verify`        | `typecheck` + `lint` + `test:coverage` + `build`，CI 与 `prepublishOnly` 用的就是它 |

没有 npm script 的两件事：

- `CSDN_LIVE=1 node scripts/live-smoke.mjs`：真实端到端冒烟测试。它会**真的**建一篇草稿、验证后台状态为 draft 且公开页 404、再彻底删除；不会发布任何东西，也不会打印 cookie。默认拒绝运行，需要 `CSDN_LIVE=1` 和 cookie。
- `node dist/index.js`：手工验证 server 能否启动。

## 3. 分层规则（硬约束）

```
src/tools/*   →  src/csdn/*   →  src/core/*
```

- import 只能**向下**。`core` 不得 import 上面任何一层；`csdn` 不得 import `tools`。
- 每层各管一段：`tools` 只做 zod 校验、参数映射、文本格式化、把 `CsdnError` 转成 `{ isError: true }`；`csdn` 管 CSDN 的接口路径、字段名、状态码；`core` 管传输（签名、重试、限流、错误、配置）。
- `core` 与 `csdn` 不得 import `@modelcontextprotocol/sdk`，也不得写 stdout —— stdout 归 stdio 传输层，日志一律走 stderr。
- 只有 `src/core/config.ts` 读 `process.env`。其他模块通过构造函数注入拿配置，这样测试不用改全局状态。
- 改动任何跨层接口时，同一次提交里更新 `docs/ARCHITECTURE.md`。

## 4. 测试契约

- 测试放在 `tests/**/*.test.ts`，公共夹具在 `tests/helpers/`（`createFakeFetch()` 记录请求、`createTestContext()` 组装上下文）。
- 覆盖率阈值是 **100%**（statements / branches / functions / lines，仅排除 `src/index.ts`）。阈值不达标等同于测试失败，不是"建议优化"。
- 单元测试**不得联网**：所有网络、时钟、睡眠都通过 `fetchImpl` / `now` / `sleep` 这些构造注入的 seam 替换。
- 用例名写**行为**，不写函数名。例如：`it('sends status: 2 for drafts because 0 publishes the article')` —— 名字里的"为什么"就是这条用例的价值。
- `tests/live/**` 是 opt-in 集成测试，必须 `CSDN_LIVE=1`；允许建草稿并删除，**永远不允许发布**。

## 5. 提交规范

使用 Conventional Commits：`feat:`、`fix:`、`test:`、`docs:`、`chore:`、`refactor:`。
一次提交只做一件逻辑上的事；格式化、重命名这类噪音不要和功能改动混在一起。

## 6. 绝不提交密钥

- `.env`、任何 cookie、抓包得到的 `Cookie:` 请求头，一律不得进仓库 —— 包括测试夹具、日志、示例配置和 issue 截图。
- `.github/workflows/ci.yml` 里有一个 `secret-scan` 任务：只要仓库里跟踪了 `.env`、写死了非空的 `CSDN_COOKIE`、或出现形如 `UserToken=xxxx` 的真实取值，CI 直接失败。本地可以原样跑：`git ls-files -z | xargs -0 grep -lE 'CSDN_COOKIE[[:space:]]*=[[:space:]]*"?[^"[:space:]]{20,}'`。
- 万一已经泄露：先去 CSDN 重新登录让旧 `UserToken` 失效，再用 `git filter-repo` 清理历史。只删文件是不够的，密钥已经在历史里了。
