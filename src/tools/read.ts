/**
 * Read-only tools: `get_article`, `list_articles` and `verify_article`.
 *
 * They share a purpose that is easy to lose sight of: these are the only tools
 * whose answer is *evidence*. A write tool reports what it asked CSDN to do;
 * these report what CSDN actually has — the raw `status` code, the public page,
 * the account's published list. That is why `verify_article` lives here and not
 * next to the writers it is used by.
 *
 * `get_article` with `include_content: false` is a context-management tool, not
 * a cosmetic flag: an article body can be tens of thousands of tokens, and an
 * agent that only needs the state should not pay for the body.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ArticleListPage, ArticleListScope, ArticleState, ArticleSummary } from '../csdn/types.js'
import { verifyArticle } from '../csdn/verify.js'
import type { ServerContext } from '../context.js'
import { asCallToolResult, errorResult, jsonResult, type ToolResult } from './shared.js'

export const READ_TOOL_NAMES: readonly string[] = Object.freeze([
  'get_article',
  'list_articles',
  'verify_article'
])

/** The two body fields, plus the same two keys inside `raw` (CSDN's own names). */
function withoutBodies(raw: Record<string, unknown>): Record<string, unknown> {
  const { content: _content, markdowncontent: _markdowncontent, ...rest } = raw
  return rest
}

export async function getArticle(
  ctx: ServerContext,
  args: { article_id: string; include_content?: boolean }
): Promise<ToolResult> {
  try {
    const detail = await ctx.articles.get(args.article_id)
    const summary =
      `已读取文章 ${detail.id}「${detail.title}」：state=${detail.state}（status=${detail.statusCode}），` +
      `标签 ${detail.tags.length} 个，封面 ${detail.coverImages.length} 张`

    if (args.include_content === false) {
      // `raw` is the same record verbatim, so leaving it in would hand the agent
      // the body it just asked to skip from a different key.
      const { markdownContent: _markdown, htmlContent: _html, raw, ...meta } = detail
      return jsonResult(
        `${summary}；已按 include_content=false 省略正文（markdownContent / htmlContent，以及 raw 里的副本）`,
        {
          ...meta,
          raw: withoutBodies(raw)
        }
      )
    }
    return jsonResult(summary, detail)
  } catch (error) {
    return errorResult(error)
  }
}

/**
 * How many CSDN pages the local filter walks before giving up.
 *
 * CSDN's author-console list ignores `size` and returns a server-fixed page, and
 * it has no state or keyword parameters, so filtering has to happen here. The
 * cap keeps a filter that matches nothing from paging through the whole account.
 */
const FILTER_SCAN_LIMIT = 5

export interface ListFilters {
  state?: ArticleState
  title_contains?: string
}

function matchesFilters(item: ArticleSummary, filters: ListFilters): boolean {
  if (filters.state !== undefined && item.state !== filters.state) return false
  const needle = filters.title_contains
  if (needle === undefined) return true
  // Case-insensitive: the titles are Chinese and English mixed, and a
  // case-sensitive match on the English half surprises people.
  return item.title.toLowerCase().includes(needle.toLowerCase())
}

export async function listArticles(
  ctx: ServerContext,
  args: {
    page?: number
    page_size?: number
    scope?: ArticleListScope
    state?: ArticleState
    title_contains?: string
  }
): Promise<ToolResult> {
  try {
    const filters: ListFilters = { state: args.state, title_contains: args.title_contains }
    const filtering = filters.state !== undefined || filters.title_contains !== undefined

    let page: ArticleListPage = await ctx.articles.list({
      page: args.page,
      pageSize: args.page_size,
      scope: args.scope
    })
    let pagesScanned = 1
    const matches = page.items.filter(item => matchesFilters(item, filters))

    // Only when a filter is active: a plain listing must stay a single request,
    // both for the caller's latency and because CSDN rate-limits the console.
    while (
      filtering &&
      matches.length < page.pageSize &&
      page.items.length > 0 &&
      pagesScanned < FILTER_SCAN_LIMIT
    ) {
      page = await ctx.articles.list({
        page: page.page + 1,
        pageSize: args.page_size,
        scope: args.scope
      })
      pagesScanned += 1
      matches.push(...page.items.filter(item => matchesFilters(item, filters)))
    }

    const items = filtering ? matches.slice(0, page.pageSize) : page.items

    // The two scopes see different sets, so the message must say which one
    // answered. An agent that asked for drafts and reads "只含已发布文章" would
    // conclude its draft is missing when it simply asked the wrong endpoint.
    const scopeNote =
      page.scope === 'all'
        ? '这是作者后台接口，包含草稿（item.state 里区分 draft/published/reviewing）；' +
          `CSDN 后台页大小由服务端固定，本次实际每页 ${page.pageSize} 篇`
        : '这是公开接口，只含已发布文章，草稿查不到（草稿用 list_articles 的 scope=all，或 get_article 按 id 查）'
    const countsNote =
      page.counts === undefined
        ? ''
        : `；CSDN 分类计数 ${Object.entries(page.counts)
            .map(([key, value]) => `${key}=${value}`)
            .join(', ')}`
    // Said out loud because `total` is CSDN's, not the filtered count: without
    // this a caller reads "共 27 篇" next to 2 items and assumes a bug.
    const filterNote = filtering
      ? `；**筛选在本地做**（CSDN 接口没有状态/关键词参数），翻了 ${pagesScanned} 页共 ${matches.length} 篇命中，` +
        `下面的 total 是 CSDN 的总数、不是命中数`
      : ''

    return jsonResult(
      `已列出第 ${page.page} 页（每页 ${page.pageSize}）：本页 ${items.length} 篇，共 ${page.total} 篇；` +
        `${scopeNote}${countsNote}${filterNote}`,
      { ...page, items, ...(filtering ? { filteredBy: filters, pagesScanned } : {}) }
    )
  } catch (error) {
    return errorResult(error)
  }
}

/**
 * Derive the expected state from what CSDN currently says.
 *
 * Used only when the caller omits `expected`: a published or in-review article
 * is being verified as a publish, anything else (draft, rejected, unknown) as a
 * draft. It costs one extra read, which is cheaper than guessing wrong.
 */
async function expectedFromState(ctx: ServerContext, articleId: string): Promise<'draft' | 'publish'> {
  const detail = await ctx.articles.get(articleId)
  return detail.state === 'published' || detail.state === 'reviewing' ? 'publish' : 'draft'
}

export async function verifyArticleTool(
  ctx: ServerContext,
  args: { article_id: string; expected?: 'draft' | 'publish' }
): Promise<ToolResult> {
  try {
    const expected = args.expected ?? (await expectedFromState(ctx, args.article_id))
    const result = await verifyArticle(
      { articles: ctx.articles, http: ctx.http, config: ctx.config },
      args.article_id,
      expected
    )
    return jsonResult(
      `${result.consistent ? '✅ 自检一致' : '⚠️ 自检不一致'}（按 expected=${expected} 判定：接口 state=${result.state}/status=${result.statusCode}，公开页 ${result.publicStatusCode}）：${result.message}`,
      result
    )
  } catch (error) {
    return errorResult(error)
  }
}

export function registerReadTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'get_article',
    {
      title: '读取文章',
      description:
        '按 id 读取一篇文章的完整记录（草稿也能读到），这是确认 status 原始状态码、判断草稿/审核/发布的权威口径。' +
        '文章很长时传 include_content=false，只取元数据、不返回正文，避免把上下文挤爆。' +
        '想浏览已发布文章列表用 list_articles；想验证一次写入是否真的生效用 verify_article。',
      inputSchema: {
        article_id: z.string().trim().min(1, 'article_id 不能为空'),
        include_content: z.boolean().optional()
      }
    },
    async args => asCallToolResult(await getArticle(ctx, args))
  )

  server.registerTool(
    'list_articles',
    {
      title: '列出文章',
      description:
        '列出账号的文章。scope="published"（默认）走公开接口、不需要 Cookie，**只含已发布文章**；' +
        'scope="all" 走作者后台接口、需要 Cookie，**包含草稿**，并在 counts 里给出 draft/publish 等分类计数——' +
        '这是唯一能回答「我有哪些草稿」的口径（公开接口看不到草稿，get_article 又要先知道 id）。' +
        '注意后台接口的每页条数由 CSDN 服务端固定，page_size 传入后可能被忽略，返回的 pageSize 是实际值。' +
        'state / title_contains 是**本地筛选**（CSDN 接口没有这两个参数）：会自动多翻几页凑够匹配项（最多 5 页），返回的 total 仍是 CSDN 的总数。' +
        '不要用它判断某篇文章是否发布成功——看不到不等于没发布，请用 verify_article。',
      inputSchema: {
        page: z.number().int().min(1, 'page 从 1 开始').optional(),
        page_size: z.number().int().min(1, 'page_size 至少为 1').max(100, 'page_size 最大 100').optional(),
        scope: z
          .enum(['published', 'all'], {
            errorMap: () => ({
              message: 'scope 只能是 published（公开接口，只看已发布）或 all（作者后台，含草稿）'
            })
          })
          .optional(),
        state: z
          .enum(['draft', 'published', 'reviewing', 'rejected', 'unknown'], {
            errorMap: () => ({ message: 'state 只能是 draft / published / reviewing / rejected / unknown' })
          })
          .optional(),
        title_contains: z
          .string()
          .trim()
          .min(1, 'title_contains 不能为空字符串')
          .optional()
          .describe('标题包含的关键词（不区分大小写），本地筛选')
      }
    },
    async args => asCallToolResult(await listArticles(ctx, args))
  )

  server.registerTool(
    'verify_article',
    {
      title: '校验文章真实状态',
      description:
        '回查一篇文章的真实状态：CSDN 接口的 status + 公开页的 HTTP 码，两个信号都看，缺一不可（只看接口会漏判，只看公开页会把审核中误判成失败）。' +
        'expected 省略时按当前状态推断。' +
        '它是只读的，不会修改任何东西；也不是必须的步骤——publish_article / update_article 已经默认自检，重复调用只会多花两次请求。',
      inputSchema: {
        article_id: z.string().trim().min(1, 'article_id 不能为空'),
        expected: z
          .enum(['draft', 'publish'], {
            errorMap: () => ({ message: 'expected 只能是 draft（期望它是草稿）或 publish（期望它已发布）' })
          })
          .optional()
      }
    },
    async args => asCallToolResult(await verifyArticleTool(ctx, args))
  )
}
