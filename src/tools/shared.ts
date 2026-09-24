/**
 * Shared plumbing for the MCP tool layer.
 *
 * Every tool replies with one of the two shapes built here, and nothing else:
 *
 *   - `jsonResult(summary, payload)` — one human-readable summary line, then the
 *     payload as a fenced JSON block. The split is deliberate: an agent reads
 *     the first line without parsing anything, and a program parses the second
 *     without inferring meaning from prose. A payload-only reply makes an agent
 *     re-derive which field matters; a prose-only reply cannot be parsed at all.
 *   - `errorResult(error)` — `isError: true`, carrying the CsdnError `code`, its
 *     message and an actionable hint keyed off that code. A raw exception never
 *     reaches the host: an MCP host renders an uncaught stack trace as a blob an
 *     agent cannot act on, and the code is what a caller can branch on.
 *
 * Both live here rather than in each tool file because the reply format is part
 * of the tool contract (docs/ARCHITECTURE.md §4) — if it drifts per tool, an
 * agent that learned one tool learns nothing about the next.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { isCsdnError, type CsdnErrorCode } from '../core/errors.js'
import { redact } from '../core/logger.js'

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/**
 * Adapt our closed result shape to the SDK's `CallToolResult` at the boundary.
 *
 * The SDK's type carries `[x: string]: unknown` (it is declared `$loose` so that
 * servers may attach `_meta`), and a closed interface is not assignable to an
 * index-signature type. Converting in one place keeps `ToolResult` closed — a
 * typo in a payload key stays a compile error in every handler — instead of
 * opening up the shape every tool returns.
 */
export function asCallToolResult(result: ToolResult): CallToolResult {
  return { content: result.content, isError: result.isError }
}

/**
 * CSDN rejects an article with more than five tags (the console UI stops at
 * five too), so the schema rejects the sixth **before** any network call.
 */
export const TAG_LIMIT = 5

/**
 * CSDN caps `Description` at 256 characters and counts every character against
 * that budget. The article layer truncates; the tool layer rejects, because a
 * silently shortened summary is a surprise a caller can avoid up front.
 */
export const DESCRIPTION_LIMIT = 256

/** Wrap a summary line and a payload into the one reply shape every tool uses. */
export function jsonResult(summary: string, payload: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: `${summary}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`` }]
  }
}

/**
 * Next action for each failure code.
 *
 * Keyed by `CsdnErrorCode` rather than defaulting to a generic sentence: the
 * code is the only thing an agent can branch on, and "something went wrong,
 * try again" for `AUTH_INVALID` costs a user ten minutes of guessing.
 */
const ERROR_HINTS: Readonly<Record<CsdnErrorCode, string>> = Object.freeze({
  AUTH_MISSING:
    '还没配置 Cookie：用 auth_login 传入整段 Cookie 头，或在 MCP 客户端配置的环境变量里设置 CSDN_COOKIE（改环境变量需要重启 MCP 进程）。',
  AUTH_INVALID:
    'Cookie 很可能已经过期或是复制不完整：重新登录 CSDN 后，从 F12 → Network → 任意 csdn.net 请求 → Request Headers → Cookie 整段复制（必须含 UserToken），再用 auth_login 覆盖，不需要重启进程。注意 UserToken 是 HTTP-only cookie，document.cookie 里取不到。',
  RATE_LIMITED:
    'CSDN 限制了写入频率（保存与删除共用同一个节流键，约 10 秒一次）：等 10 秒以上再重试，并避免并发写入同一个账号。',
  MALFORMED_RESPONSE:
    '响应不是预期的 JSON 信封，通常意味着该接口已下线或改版：先确认 CSDN 是否改版（探测记录见 docs/reverse-engineering.md），不要据此认为操作成功。',
  NOT_FOUND:
    '目标文章或资源不存在：核对 article_id（可用 get_article / list_articles 确认），回收站里的文章也读不到；已彻底删除的文章无法恢复。',
  NETWORK: '网络层失败（DNS / TCP / TLS / 请求中断）：检查网络与代理后重试；该错误已按配置自动重试过。',
  TIMEOUT: '请求超时：确认网络可达后重试，必要时调大 CSDN_TIMEOUT_MS；该错误已按配置自动重试过。',
  HTTP_ERROR: 'CSDN 返回了非预期的 HTTP 状态：先确认 Cookie 与接口是否可用，再重试；不要把它当作参数问题。',
  API_ERROR: 'CSDN 接受了请求但拒绝了内容：按 message 里的原因修正参数（例如分类名不存在、标题为空）后重试。',
  SERVER_ERROR: 'CSDN 侧 5xx：这是对方的问题，稍后重试即可；不要反复改写参数试探。',
  INVALID_ARGUMENT: '入参不满足约束：按上面的原因修正参数后重试，不要重复提交同一份参数。',
  VERIFY_FAILED:
    '写入自称成功但自检不一致：以自检结果为准（它读的是接口状态与公开页），先确认文章真实状态再操作。'
})

/**
 * Message of anything thrown, without a stack trace.
 *
 * `String(error)` is the honest fallback for a non-Error throwable — the only
 * code in this codebase that throws raw values is the transport layer, and a
 * thrown string still says more than "unknown error".
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * `detail` is a body snippet from CSDN: free-form text that can echo request
 * headers, which is why it goes through `redact` like every log line does.
 * An empty detail is dropped rather than rendered as a blank line.
 */
function detailLines(detail: string | undefined): string[] {
  if (detail === undefined) return []
  const trimmed = detail.trim()
  if (trimmed === '') return []
  return [`接口返回：${redact(trimmed)}`]
}

/**
 * Turn anything thrown into a tool error result.
 *
 * Never includes a stack trace and never includes a cookie: `redact` strips
 * `UserToken=` / `Cookie:` style pairs, and a CsdnError's own message is
 * constructed without credentials in the first place.
 */
export function errorResult(error: unknown): ToolResult {
  const lines: string[] = []
  if (isCsdnError(error)) {
    lines.push(`❌ ${error.code}`)
    lines.push(`原因：${redact(error.message)}`)
    lines.push(`处理建议：${ERROR_HINTS[error.code]}`)
    if (error.status !== undefined) lines.push(`HTTP 状态：${error.status}`)
    lines.push(...detailLines(error.detail))
    if (error.retryable) lines.push('可重试：稍后原样重试有机会成功。')
  } else {
    // A non-CsdnError means a bug in this server, not a CSDN refusal — saying so
    // keeps an agent from retrying, which would never help.
    lines.push('❌ UNEXPECTED')
    lines.push(`原因：${redact(errorMessage(error))}`)
    lines.push(
      '处理建议：这是工具内部的非预期错误（不是 CSDN 返回的）。请把上面的原因原样反馈；重试之前先确认参数类型是否正确。'
    )
  }
  return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] }
}
