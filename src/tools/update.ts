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
 *   2. **Whether the body of an already-published article goes live is decided
 *      by the `status` we send.** CSDN's editor republishes with `status: 0`;
 *      this server used to send `1` — the value `getArticle` *reports*, not the
 *      one any client sends — and observed the body staying put. 1.0.4 sends 0,
 *      which is the editor's own value, so a body edit is now written as a live
 *      publish. That conclusion comes from CSDN's source rather than from a live
 *      observation, so the reply carries a caution instead of a promise.
 *
 * `mode` is treated differently from `publish_article` too: when the caller
 * omits it, the article's *current* visibility is preserved instead of falling
 * back to `draft`. A silent downgrade would take a public article offline, and a
 * metadata edit must never be able to do that.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { renderMarkdown } from '../csdn/markdown.js'
import type { ArticleReadType, ArticleState } from '../csdn/types.js'
import { verifyArticle } from '../csdn/verify.js'
import type { ServerContext } from '../context.js'
import { CsdnError } from '../core/errors.js'
import { describeUploadedImages, uploadLocalImages } from './assets.js'
import {
  DESCRIPTION_LIMIT,
  TAG_LIMIT,
  asCallToolResult,
  categoriesDraftWarning,
  errorResult,
  jsonResult,
  parseScheduledAt,
  type ToolResult
} from './shared.js'
import { MODE_SCHEMA, READ_TYPE_SCHEMA } from './publish.js'
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
  read_type?: ArticleReadType
  scheduled_at?: string
  upload_local_images?: boolean
}

/** Every field whose absence means "keep the current value". */
const UPDATE_FIELDS = [
  'title',
  'markdown',
  'description',
  'tags',
  'categories',
  'cover_image',
  'read_type',
  'mode'
] as const

/** Publicly readable, or submitted and awaiting moderation. */
function isLive(state: ArticleState): boolean {
  return state === 'published' || state === 'reviewing'
}

/** The explicit fallback when an API-side republish does not take. */
function editorUrl(articleId: string): string {
  return `https://editor.csdn.net/md/?articleId=${articleId}`
}

/**
 * Said when the body of an already-live article is edited.
 *
 * This used to be a flat verdict — "the API does not update a published body, go
 * to the editor" — which came from watching the symptom while we sent
 * `status: 1`. `1` is what `getArticle` *reports* for a published article; it is
 * not what CSDN sends. CSDN's editor republishes with `status: 0`
 * (`publish()` in app.chunk.*.js), the value this server now sends, so the old
 * warning described our own bug rather than CSDN's behaviour.
 *
 * It stays a caution instead of flipping to a promise because the new value has
 * not been observed against a live article yet — see `docs/KNOWN-ISSUES.md`.
 * Claiming either outcome before that check would repeat the original mistake.
 */
function bodyLiveCaveat(articleId: string): string {
  return (
    '⚠️ 正文改动是按「线上发布」写入的（status=0，与 CSDN 编辑器点「发布文章」同一个值），' +
    '所以公开页应当跟着更新，但这一点来自编辑器源码、尚未在线上实测过；' +
    `请以公开页实际内容为准，若没变化就在编辑器里再点一次发布：${editorUrl(articleId)}`
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

    // Scheduling only means something on the publish path, and CSDN would drop
    // it silently otherwise.
    if (args.scheduled_at !== undefined && mode !== 'publish') {
      throw new CsdnError(
        'INVALID_ARGUMENT',
        'scheduled_at 需要同时传 mode=publish：定时发布是发布动作，草稿没有可等待的时刻，CSDN 会直接忽略排期。'
      )
    }

    // Merge, never blank: see the file header. The cover comes from the current
    // record unless a new one was supplied, and a new local path goes through the
    // cover channel.
    let coverImages: string[] = current.coverImages
    if (args.cover_image !== undefined) {
      coverImages = [await uploadCover(ctx, args.cover_image)]
    }

    const warnings: string[] = []
    if (mode === 'draft' && args.categories !== undefined && args.categories !== '') {
      // Listing `categories` among the modified fields would be a false claim:
      // CSDN drops it on any status=2 save.
      warnings.push(categoriesDraftWarning(args.categories))
    }
    if (args.mode === undefined && mode === 'publish') {
      warnings.push('未指定 mode：文章当前已公开，本次沿用 publish，避免一次元数据修改把它退回草稿。')
    }
    if (args.markdown !== undefined && isLive(current.state)) {
      warnings.push(bodyLiveCaveat(current.id))
    }

    // Local images go up before the save, so what is stored already points at
    // CDN URLs. Only the caller's new Markdown is scanned: the article's stored
    // body was rewritten on the way in and needs no second pass.
    const materialized =
      args.upload_local_images === false || args.markdown === undefined
        ? { markdown: args.markdown, uploaded: {} as Record<string, string> }
        : await uploadLocalImages(ctx, args.markdown)

    const saved = await ctx.articles.save({
      id: current.id,
      title: args.title ?? current.title,
      content: renderMarkdown(materialized.markdown ?? current.markdownContent),
      markdownContent: materialized.markdown ?? current.markdownContent,
      description: args.description ?? current.description,
      tags: args.tags ?? current.tags,
      categories: args.categories ?? current.categories,
      coverImages,
      mode,
      // Preserved unless the caller says otherwise: overwriting this with the
      // default would flip a private article public.
      readType: args.read_type ?? current.readType,
      // `status` means "is this article live" — without the current code, a
      // draft-mode save of a published article would take it down.
      currentStatusCode: current.statusCode,
      ...(args.scheduled_at === undefined ? {} : { scheduledTime: parseScheduledAt(args.scheduled_at) })
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
    // `categories` is dropped by a draft save, so counting it as a modified field
    // would contradict the warning printed right above this sentence. Measured
    // live: the warning and "修改字段：categories" appeared in the same reply.
    const effective = mode === 'draft' ? provided.filter(field => field !== 'categories') : provided
    const changed = effective.length === 0 ? '（无：本次只会用同样的内容重写一次）' : effective.join('、')
    parts.push(
      `已更新文章 ${saved.id}（${saved.url}）：state=${verification.state}，本次写入 mode=${mode}，修改字段：${changed}。` +
        `自检${verification.consistent ? '一致' : '不一致'}：${verification.message}`
    )
    const imageNote = describeUploadedImages(materialized.uploaded)
    if (imageNote !== undefined) parts.push(imageNote)
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
        mode: MODE_SCHEMA.optional(),
        read_type: READ_TYPE_SCHEMA.optional(),
        scheduled_at: z
          .string()
          .trim()
          .min(1, 'scheduled_at 不能为空')
          .optional()
          .describe(
            '定时发布时间（ISO 8601，需配合 mode=publish）。实验特性：线上单位未验证，见 docs/API-NOTES.md'
          ),
        upload_local_images: z.boolean().optional()
      }
    },
    async args => asCallToolResult(await updateArticle(ctx, args))
  )
}
