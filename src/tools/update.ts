/**
 * `update_article` — change an existing article.
 *
 * Two CSDN behaviours dictate the whole shape of this file:
 *
 *   1. **`saveArticle` replaces the whole record.** A field left out of the
 *      request is not "keep the current value" — it is "write an empty value
 *      over it". So every field is merged from the record returned by
 *      `getArticle` unless the caller supplied a new one, and the cover is
 *      re-uploaded only when a new `cover_image` was passed.
 *   2. **The body of an already-published article is not updated by the API.**
 *      CSDN only applies body edits when the editor UI publishes; the API write
 *      touches the draft copy. That is a documented non-goal of v1.0.0
 *      (docs/ARCHITECTURE.md §7), so instead of reporting a body change as live,
 *      the reply says, in its own words, that the change is not live yet.
 *
 * `mode` is treated differently from `publish_article` too: when the caller
 * omits it, the article's *current* visibility is preserved instead of falling
 * back to `draft`. A silent downgrade would take a public article offline, and a
 * metadata edit must never be able to do that.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { renderMarkdown } from '../csdn/markdown.js'
import type { ArticleState } from '../csdn/types.js'
import { verifyArticle } from '../csdn/verify.js'
import type { ServerContext } from '../context.js'
import { CsdnError } from '../core/errors.js'
import {
  DESCRIPTION_LIMIT,
  TAG_LIMIT,
  asCallToolResult,
  errorResult,
  jsonResult,
  type ToolResult
} from './shared.js'
import { MODE_SCHEMA } from './publish.js'
import { uploadCover } from './upload.js'

export const UPDATE_TOOL_NAMES: readonly string[] = Object.freeze(['update_article'])

export interface UpdateArgs {
  article_id: string
  title?: string
  markdown?: string
  description?: string
  tags?: string[]
  categories?: string
  cover_image?: string
  mode?: 'draft' | 'publish'
}

/** Every field whose absence means "keep the current value". */
const UPDATE_FIELDS = [
  'title',
  'markdown',
  'description',
  'tags',
  'categories',
  'cover_image',
  'mode'
] as const

/** Publicly readable, or submitted and awaiting moderation. */
function isLive(state: ArticleState): boolean {
  return state === 'published' || state === 'reviewing'
}

/** The explicit way out of a body edit the API cannot apply. */
function editorUrl(articleId: string): string {
  return `https://editor.csdn.net/md/?articleId=${articleId}`
}

function bodyNotLiveWarning(articleId: string): string {
  return (
    '⚠️ 注意：CSDN 的接口不会更新已公开（含审核中）文章的线上正文——本次 markdown 修改只写入了草稿副本，公开页面不会变化。' +
    `要在线上生效，只能打开编辑器 UI 重新发布：${editorUrl(articleId)}`
  )
}

export async function updateArticle(ctx: ServerContext, args: UpdateArgs): Promise<ToolResult> {
  try {
    const provided = UPDATE_FIELDS.filter(field => args[field] !== undefined)
    if (provided.length === 0) {
      throw new CsdnError(
        'INVALID_ARGUMENT',
        `至少要提供一个要修改的字段：${UPDATE_FIELDS.join(' / ')}。只传 article_id 的调用什么都没改，` +
          '而 saveArticle 会把整条记录重写一遍，所以这里直接拒绝。'
      )
    }

    const current = await ctx.articles.get(args.article_id)
    const mode = args.mode ?? (isLive(current.state) ? 'publish' : 'draft')

    // Merge, never blank: see the file header. The cover comes from the current
    // record unless a new one was supplied, and a new local path goes through the
    // cover channel.
    let coverImages: string[] = current.coverImages
    if (args.cover_image !== undefined) {
      coverImages = [await uploadCover(ctx, args.cover_image)]
    }

    const warnings: string[] = []
    if (args.mode === undefined && mode === 'publish') {
      warnings.push('未指定 mode：文章当前已公开，本次沿用 publish，避免一次元数据修改把它退回草稿。')
    }
    if (args.markdown !== undefined && isLive(current.state)) {
      warnings.push(bodyNotLiveWarning(current.id))
    }

    const saved = await ctx.articles.save({
      id: current.id,
      title: args.title ?? current.title,
      content: renderMarkdown(args.markdown ?? current.markdownContent),
      markdownContent: args.markdown ?? current.markdownContent,
      description: args.description ?? current.description,
      tags: args.tags ?? current.tags,
      categories: args.categories ?? current.categories,
      coverImages,
      mode
    })

    // Unconditional on purpose: the frozen parameter table has no `verify` for
    // this tool, and without a verification pass `state` would only be a guess
    // taken from the request — exactly the claim this project refuses to make.
    const verification = await verifyArticle(
      { articles: ctx.articles, http: ctx.http, config: ctx.config },
      saved.id,
      mode
    )

    if (!verification.consistent) {
      warnings.push(`⚠️ 自检不一致：${verification.message}`)
    }

    const payload = {
      articleId: saved.id,
      url: saved.url,
      state: verification.state,
      mode,
      verification,
      ...(warnings.length === 0 ? {} : { warnings })
    }

    const parts = [...warnings]
    parts.push(
      `已更新文章 ${saved.id}（${saved.url}）：state=${verification.state}，本次写入 mode=${mode}，修改字段：${provided.join('、')}。` +
        `自检${verification.consistent ? '一致' : '不一致'}：${verification.message}`
    )
    return jsonResult(parts.join(' '), payload)
  } catch (error) {
    return errorResult(error)
  }
}

export function registerUpdateTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'update_article',
    {
      title: '更新文章',
      description:
        '更新已有文章：只传要改的字段，未传的字段保持原值（saveArticle 会整条重写，所以未传的字段由本工具从当前记录合并回来）。' +
        '**已公开发布文章的线上正文（markdown）不会被接口更新**：正文修改只写入草稿副本，需要在编辑器 UI 里重新发布才生效，工具会在返回里明确说明。' +
        '不传 mode 时保持文章当前可见性（不会把已发布的文章退回草稿）；想发布一篇草稿请显式传 mode=publish。' +
        '不要用它校正正文之外的东西（那要重新发布），也不要传空字段试图"清空"某个值——省略即保持原值。',
      inputSchema: {
        article_id: z.string().trim().min(1, 'article_id 不能为空'),
        title: z.string().trim().min(1, 'title 不能为空字符串：要去掉标题请改用别的操作').optional(),
        markdown: z
          .string()
          .min(1, 'markdown 不能为空：需要 Markdown 源码')
          .refine(value => value.trim() !== '', 'markdown 不能只包含空白字符')
          .optional(),
        description: z
          .string()
          .max(DESCRIPTION_LIMIT, `description 最多 ${DESCRIPTION_LIMIT} 字（CSDN 会静默截断）`)
          .optional(),
        tags: z.array(z.string()).max(TAG_LIMIT, `tags 最多 ${TAG_LIMIT} 个`).optional(),
        categories: z.string().optional(),
        cover_image: z.string().trim().min(1, 'cover_image 不能为空').optional(),
        mode: MODE_SCHEMA.optional()
      }
    },
    async args => asCallToolResult(await updateArticle(ctx, args))
  )
}
