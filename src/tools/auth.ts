/**
 * `auth_login` / `auth_status` — the cookie lifecycle.
 *
 * Two facts shape this file:
 *
 *   - A cookie is validated **structurally, locally** before anything is sent.
 *     `UserToken` is an HTTP-only cookie, so a cookie copied out of
 *     `document.cookie` never works; a round trip would only add a confusing
 *     `AUTH_INVALID` on top of a mistake we can already name.
 *   - `ServerContext.updateCookie` mutates the shared config in place, which is
 *     what makes a new cookie take effect for every later request without a
 *     restart. That mutation is the whole point of `auth_login`, and the test
 *     that proves it asserts on the *next request's* `Cookie` header.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { validateCookie, type CookieValidation } from '../core/config.js'
import { CsdnError, toCsdnError } from '../core/errors.js'
import { redact } from '../core/logger.js'
import type { ServerContext } from '../context.js'
import { asCallToolResult, errorResult, jsonResult, type ToolResult } from './shared.js'

export const AUTH_TOOL_NAMES: readonly string[] = Object.freeze(['auth_login', 'auth_status'])

/** Reused by both tools so the two answers a caller can get are worded identically. */
const COOKIE_SETUP_HOWTO =
  '设置方式：在 MCP 客户端配置的 env 里写 CSDN_COOKIE=整段 Cookie 头（必须含 UserToken 与 UserName），改完重启 MCP 进程；或在运行期用 auth_login 传入，不需要重启。'

/**
 * `validateCookie` fills `reason` on every invalid result, so reading it as a
 * definite string is safe. Written as a cast rather than `?? fallback` so the
 * text can never quietly degrade into "undefined" for a caller.
 */
function invalidReason(validation: CookieValidation): string {
  return validation.reason as string
}

/**
 * Report the current authentication state **without any network call**.
 *
 * "Configured" and "valid" are answered separately on purpose: an empty
 * `CSDN_COOKIE` and a cookie missing `UserToken` need different fixes, and a
 * caller that only sees `valid: false` cannot tell them apart.
 */
export function authStatus(ctx: ServerContext): ToolResult {
  try {
    const configured = ctx.config.cookie.trim() !== ''
    const validation = validateCookie(ctx.config.cookie)
    const userName = ctx.config.userName !== '' ? ctx.config.userName : validation.userName
    const payload: Record<string, unknown> = { configured, valid: validation.valid, username: userName }

    if (!configured) {
      payload['howToConfigure'] = COOKIE_SETUP_HOWTO
      return jsonResult(`未配置 Cookie：${COOKIE_SETUP_HOWTO}`, payload)
    }
    if (!validation.valid) {
      payload['reason'] = invalidReason(validation)
      return jsonResult(`Cookie 已配置但结构无效：${invalidReason(validation)}`, payload)
    }
    return jsonResult(
      `Cookie 已配置且结构有效（账号 ${userName}）。结构有效不等于 CSDN 会接受它——那要由一次需要登录的调用给出结论。`,
      payload
    )
  } catch (error) {
    // Unreachable with a well-formed context, and still caught: a tool that can
    // throw turns into a stack trace in the host, which is exactly what this
    // layer exists to prevent.
    return errorResult(error)
  }
}

/**
 * Install a new cookie and prove, by making one live call, that the account
 * resolves.
 *
 * The live check is `ctx.articles.list` — the public community list. It is
 * anonymous (no cookie, no signature; CSDN answers 403 if either is attached),
 * so a success proves the **account name** is reachable, not that the cookie was
 * accepted. That limitation is reported instead of being papered over.
 */
export async function authLogin(ctx: ServerContext, args: { cookie: string }): Promise<ToolResult> {
  try {
    const validation = validateCookie(args.cookie)
    if (!validation.valid) {
      // Rejected before any request: see the file header. The reason is passed
      // through verbatim because it names the exact mistake.
      return errorResult(new CsdnError('INVALID_ARGUMENT', invalidReason(validation)))
    }

    const { userName } = ctx.updateCookie(args.cookie)

    const liveCheck: Record<string, unknown> = { endpoint: 'list_articles', authenticated: false }
    let ok = true
    let detail = ''
    try {
      const page = await ctx.articles.list({ page: 1, pageSize: 1 })
      liveCheck['total'] = page.total
      detail = `list_articles 正常，该账号有 ${page.total} 篇公开文章`
    } catch (error) {
      ok = false
      const csdnError = toCsdnError(error)
      const message = redact(csdnError.message)
      liveCheck['error'] = { code: csdnError.code, message }
      detail = `list_articles 失败（${csdnError.code}：${message}）`
    }
    liveCheck['ok'] = ok

    const payload = { userName, valid: true, liveCheck }
    if (!ok) {
      return jsonResult(
        `Cookie 已更新（账号 ${userName}），但联网自检失败：${detail}。Cookie 已保存，修正后可直接重试，或用 auth_status 复查结构。`,
        payload
      )
    }
    return jsonResult(
      `Cookie 已更新（账号 ${userName}）。联网自检：${detail}。该接口匿名、不带 Cookie，只能说明账号可访问；Cookie 是否被接受要由需要登录的调用给出结论。`,
      payload
    )
  } catch (error) {
    return errorResult(error)
  }
}

export function registerAuthTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'auth_login',
    {
      title: '设置 CSDN Cookie',
      description:
        '在运行期设置/更新 CSDN Cookie（整段 Cookie 头），设置后立即对所有后续请求生效，不需要重启 MCP 进程。' +
        '结构校验完全在本地完成：缺少 UserToken 或 UserName 时直接返回原因，不发任何请求。' +
        '仅在首次配置或 Cookie 失效后才需要调用；只想知道当前状态请用 auth_status（不发网络请求）。' +
        '它不判断 Cookie 是否被 CSDN 接受——结构合法但已经失效的 Cookie，只有后续需要登录的调用才会暴露。',
      inputSchema: {
        cookie: z.string().trim().min(1, 'cookie 不能为空：需要整段 Cookie 头，含 UserToken=...;UserName=...')
      }
    },
    async args => asCallToolResult(await authLogin(ctx, args))
  )

  server.registerTool(
    'auth_status',
    {
      title: '查看认证状态',
      description:
        '报告 Cookie 是否已配置、结构是否有效以及账号名，不发任何网络请求。' +
        '它不判断 Cookie 是否被 CSDN 接受（那要联网），也不知道文章状态。' +
        '需要更换 Cookie 时用 auth_login，不要靠反复调用本工具排查失效——失效只有联网调用才看得出来。',
      inputSchema: {}
    },
    () => asCallToolResult(authStatus(ctx))
  )
}
