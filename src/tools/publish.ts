/**
 * `publish_article` — create an article.
 *
 * Three behaviours here are not negotiable, and each one exists because the
 * naive version shipped a bug:
 *
 *   - `mode` defaults to `draft`. CSDN reads `status: 0` as *publish*, so v0's
 *     "save a draft" published articles the author had never read, and no API
 *     call can undo it. Publishing is therefore an explicit argument.
 *   - The Markdown is rendered to HTML and the source is kept alongside it:
 *     `saveArticle` wants rendered HTML in `content` and the Markdown in
 *     `markdowncontent`, and sending Markdown in `content` is what made v0's
 *     articles open with a literal `##`.
 *   - Verification runs by default and its verdict is reported next to the write
 *     result, because HTTP 200 from `saveArticle` is not evidence that anything
 *     happened. When the intent was a draft and the article turns out to be
 *     publicly visible, the reply says so in the loudest terms available — that
 *     combination is a real incident, and the only fix is to delete the article.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { deriveDescription, renderMarkdown } from '../csdn/markdown.js'
import type { VerificationResult } from '../csdn/types.js'
import { verifyArticle } from '../csdn/verify.js'
import type { ServerContext } from '../context.js'
import {
  DESCRIPTION_LIMIT,
  TAG_LIMIT,
  asCallToolResult,
  errorResult,
  jsonResult,
  type ToolResult
} from './shared.js'
import { uploadCover } from './upload.js'

export const PUBLISH_TOOL_NAMES: readonly string[] = Object.freeze(['publish_article'])

export interface PublishArgs {
  title: string
  markdown: string
  description?: string
  tags?: string[]
  categories?: string
  cover_image?: string
  mode?: 'draft' | 'publish'
  verify?: boolean
}

/**
 * The two modes, with the warning in the error itself: a caller that typos
 * `mode` must not be silently downgraded to a draft, and must not be silently
 * upgraded to a publish either.
 */
export const MODE_SCHEMA = z.enum(['draft', 'publish'], {
  errorMap: () => ({ message: 'mode 只能是 draft（存草稿）或 publish（发布）；省略等同于 draft。' })
})

/** The public status a draft must never produce. */
const PUBLIC_STATUS_OK = 200

/**
 * Whether the article is reachable by anyone with the URL.
 *
 * Two independent signals, either of which is enough to act on: the interface
 * says `published`, or the public page answered 200. A draft only counts as
 * safe when *both* say no.
 */
function isPubliclyVisible(verification: VerificationResult): boolean {
  return verification.state === 'published' || verification.publicStatusCode === PUBLIC_STATUS_OK
}

/**
 * The incident reply. Kept as one constant because it must not drift into a
 * softer wording: nothing in this server can turn a published article back into
 * a draft, so the only safe instruction is "delete it now".
 */
const ACCIDENTAL_PUBLISH_ALERT =
  '⚠️ 严重：本次意图是「存草稿」，但文章已经对外可见（公开页 200 或接口状态为已发布）。' +
  'CSDN 的接口无法把已发布文章退回草稿，唯一的安全处置是立即删除：调用 delete_article（permanent 保持 false，先进回收站），确认后再重新创建草稿。'

export async function publishArticle(ctx: ServerContext, args: PublishArgs): Promise<ToolResult> {
  try {
    const mode = args.mode ?? 'draft'

    // A local path goes up the cover channel; an already-hosted URL is used as
    // it is. Sending a body image as a cover (or vice versa) uploads fine and
    // never shows up, which is why the channel is fixed here, not by the caller.
    let coverImages: string[] | undefined
    if (args.cover_image !== undefined) {
      coverImages = [await uploadCover(ctx, args.cover_image)]
    }

    const saved = await ctx.articles.save({
      title: args.title,
      content: renderMarkdown(args.markdown),
      markdownContent: args.markdown,
      // CSDN caps the summary at 256 characters; when the caller omits it we
      // derive one from the body instead of sending an empty string, which CSDN
      // answers by inventing its own summary from the first lines of HTML.
      description: args.description ?? deriveDescription(args.markdown),
      tags: args.tags ?? [],
      categories: args.categories ?? '',
      coverImages,
      mode
    })

    let verification: VerificationResult | undefined
    if (args.verify !== false) {
      verification = await verifyArticle(
        { articles: ctx.articles, http: ctx.http, config: ctx.config },
        saved.id,
        mode
      )
    }

    const warnings: string[] = []
    if (verification !== undefined && !verification.consistent) {
      warnings.push(`⚠️ 自检不一致：${verification.message}`)
    }
    if (verification !== undefined && mode === 'draft' && isPubliclyVisible(verification)) {
      warnings.push(ACCIDENTAL_PUBLISH_ALERT)
    }

    const payload = {
      articleId: saved.id,
      url: saved.url,
      // Without a verification pass the real state is unknowable — `saveArticle`
      // answers 200 for a draft, a publish and a write it quietly discarded — so
      // it is reported as unknown rather than guessed from the request.
      state: verification === undefined ? 'unknown' : verification.state,
      mode,
      ...(verification === undefined ? {} : { verification }),
      ...(warnings.length === 0 ? {} : { warnings })
    }

    const parts = [...warnings]
    parts.push(
      `${mode === 'draft' ? '已按草稿保存' : '已发布'}：${args.title}（article_id=${saved.id}，${saved.url}）`
    )
    if (verification === undefined) {
      parts.push('未自检（verify=false）：state 未知，需要结论请调用 verify_article。')
    } else {
      parts.push(`自检${verification.consistent ? '一致' : '不一致'}：${verification.message}`)
    }
    return jsonResult(parts.join(' '), payload)
  } catch (error) {
    return errorResult(error)
  }
}

export function registerPublishTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'publish_article',
    {
      title: '新建文章',
      description:
        '新建一篇文章并保存到 CSDN。mode 默认 draft（存草稿）；**显式传 mode=publish 才会公开发布，且发布后接口无法退回草稿——已发布的文章只能删除重建**，所以想先审稿就保持默认。' +
        'markdown 传源码（会渲染成 HTML 保存，原文同时保留）；tags 最多 5 个；description 省略时按正文自动生成。' +
        '不要用它更新已有文章（那会新建一篇），也不要传 mode=publish 来"试试能不能成功"——发布是不可逆的对外动作。',
      inputSchema: {
        title: z.string().trim().min(1, 'title 不能为空'),
        markdown: z
          .string()
          .min(1, 'markdown 不能为空：需要 Markdown 源码')
          .refine(value => value.trim() !== '', 'markdown 不能只包含空白字符'),
        description: z
          .string()
          .max(DESCRIPTION_LIMIT, `description 最多 ${DESCRIPTION_LIMIT} 字（CSDN 会静默截断）`)
          .optional(),
        tags: z.array(z.string()).max(TAG_LIMIT, `tags 最多 ${TAG_LIMIT} 个`).optional(),
        categories: z.string().optional(),
        cover_image: z.string().trim().min(1, 'cover_image 不能为空').optional(),
        mode: MODE_SCHEMA.optional(),
        verify: z.boolean().optional()
      }
    },
    async args => asCallToolResult(await publishArticle(ctx, args))
  )
}
