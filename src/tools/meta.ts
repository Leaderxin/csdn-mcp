/**
 * `list_categories` / `list_tags` — the two tools that must never fail.
 *
 * `MetaClient` already degrades to a builtin list when every candidate endpoint
 * fails, and it reports which of the two happened through `source`. The tool
 * layer's job is to keep that distinction visible, because "these are CSDN's
 * columns" and "these are ours" deserve different amounts of trust — v0 shipped
 * a builtin list behind an API call and nobody could tell.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MetaListResult } from '../csdn/meta.js'
import type { ServerContext } from '../context.js'
import { asCallToolResult, errorResult, jsonResult, type ToolResult } from './shared.js'

export const META_TOOL_NAMES: readonly string[] = Object.freeze(['list_categories', 'list_tags'])

/** Say where the list came from, not just what it contains. */
function metaSummary(label: string, result: MetaListResult): string {
  return result.source === 'builtin'
    ? `已获取${label}列表：${result.items.length} 项，来源为内置列表（CSDN 接口全部不可用，已降级，不是实时数据）`
    : `已获取${label}列表：${result.items.length} 项，来源为 CSDN 接口`
}

export async function listCategories(ctx: ServerContext): Promise<ToolResult> {
  try {
    const result = await ctx.meta.listCategories()
    return jsonResult(metaSummary('分类', result), result)
  } catch (error) {
    return errorResult(error)
  }
}

export async function listTags(ctx: ServerContext): Promise<ToolResult> {
  try {
    const result = await ctx.meta.listTags()
    return jsonResult(metaSummary('标签', result), result)
  } catch (error) {
    return errorResult(error)
  }
}

export function registerMetaTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'list_categories',
    {
      title: '列出文章分类',
      description:
        '列出可用于 publish_article / update_article 的 categories 字段的分类名。' +
        'CSDN 接口不可用时会降级返回内置列表（source=builtin）而不是报错，' +
        '所以拿到 builtin 时要知道那不是账号的真实分类：先确认接口可用，或直接在 CSDN 创作中心里核对分类名。' +
        '它不返回分类 id，也不需要 Cookie 之外的任何参数。',
      inputSchema: {}
    },
    async () => asCallToolResult(await listCategories(ctx))
  )

  server.registerTool(
    'list_tags',
    {
      title: '列出常用标签',
      description:
        '列出账号常用/推荐的标签，供 publish_article 的 tags 字段（每篇最多 5 个）挑选。' +
        '接口不可用时会降级返回内置列表（source=builtin），那不是账号的真实标签，只是能用的候选。' +
        '它不会创建标签，也不校验标签是否存在——CSDN 允许新标签，拼错的标签会原样出现在文章上。',
      inputSchema: {}
    },
    async () => asCallToolResult(await listTags(ctx))
  )
}
