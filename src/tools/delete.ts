/**
 * `delete_article`.
 *
 * The recycle bin is the default and `permanent: true` is the deliberate,
 * separate act — deleting is the only thing this server can do that a user
 * cannot undo from the console, and an accidentally published article (the
 * incident `publish_article` warns about) is *fixed* by recycling it.
 *
 * The reply always states which of the two happened, and where the article went:
 * "deleted" alone is ambiguous in exactly the case where the difference matters.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ServerContext } from '../context.js'
import { asCallToolResult, errorResult, jsonResult, type ToolResult } from './shared.js'

export const DELETE_TOOL_NAMES: readonly string[] = Object.freeze(['delete_article'])

export async function deleteArticle(
  ctx: ServerContext,
  args: { article_id: string; permanent?: boolean }
): Promise<ToolResult> {
  try {
    // Only an explicit `true` deletes for good: a truthy value from a loosely
    // typed caller must never turn a reversible move into an irreversible one.
    const permanent = args.permanent === true
    const result = await ctx.articles.remove(args.article_id, permanent)

    if (permanent) {
      return jsonResult(
        `已彻底删除文章 ${result.articleId}（permanent=true）：不可恢复，回收站里也没有。`,
        result
      )
    }
    return jsonResult(
      `已将文章 ${result.articleId} 移入回收站（permanent=false）。` +
        '如需恢复，打开 CSDN 创作中心（mp.csdn.net）的「内容管理 → 回收站」还原即可；' +
        '确认不再需要时，再调用一次并传 permanent=true 才会彻底删除。',
      result
    )
  } catch (error) {
    return errorResult(error)
  }
}

export function registerDeleteTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'delete_article',
    {
      title: '删除文章',
      description:
        '删除一篇文章，默认进回收站（permanent=false，可在创作中心的回收站里恢复）。' +
        '只有确认文章永远不该存在时才传 permanent=true——那是彻底删除，无法恢复。' +
        '不要用它清理草稿以外的临时状态，也不要因为"想改标题"而删除重建：元数据直接改 update_article 就行，' +
        '只有误发布的文章才必须走"删除后重建"这条路。',
      inputSchema: {
        article_id: z.string().trim().min(1, 'article_id 不能为空'),
        permanent: z.boolean().optional()
      }
    },
    async args => asCallToolResult(await deleteArticle(ctx, args))
  )
}
