/**
 * Category and tag metadata for the editor.
 *
 * Every endpoint in this file was verified against the live API and against the
 * editor/console JavaScript bundles; `docs/reverse-engineering.md` holds the full
 * probe table, including the endpoints that are dead (`/blog-console-api/v3/blog/list`
 * answers with the openresty 404 page, which is how v0's `list-categories` and
 * `list-tags` silently rotted).
 *
 * Two rules shape the design:
 *   - These calls must **never** throw. An author choosing a category cannot be
 *     blocked because a metadata endpoint moved; a curated builtin list is
 *     returned with `source: 'builtin'` instead, so the caller can always tell
 *     "CSDN told me this" apart from "we guessed".
 *   - The endpoint order encodes what was actually measured, not preference.
 *
 * Runtime exports are exactly `BUILTIN_CATEGORIES`, `COMMON_TAGS` and
 * `MetaClient` (the frozen contract in docs/ARCHITECTURE.md); the interfaces
 * below are types only and add nothing to the module graph.
 */

import type { CsdnConfig } from '../core/config.js'
import { isCsdnError } from '../core/errors.js'
import type { CsdnHttpClient } from '../core/http.js'
import { createLogger, type Logger } from '../core/logger.js'

/**
 * CSDN's standard columns. Used only when every endpoint above fails, so it is
 * deliberately a *safe* list: names an author would recognise and a `categories`
 * field would accept, rather than an exhaustive taxonomy.
 */
export const BUILTIN_CATEGORIES: string[] = [
  '前端',
  '后端',
  '数据库',
  '人工智能',
  '开发工具',
  '阅读',
  '运维',
  '云计算',
  '大数据',
  '算法',
  '数据结构',
  '移动开发',
  '架构设计',
  '网络与通信',
  '网络安全',
  '音视频',
  '图形图像',
  '游戏开发',
  '嵌入式',
  '物联网',
  '区块链',
  '操作系统',
  '软件工程',
  '测试',
  '开源',
  '项目笔记',
  '日常笔记',
  '程序人生'
]

/**
 * A curated tag set — the tags that actually appear on CSDN front-page posts.
 * CSDN accepts at most 5 tags per article, so this only has to be broad enough
 * to cover the common domains; the API list (877 tags when probed) is far larger
 * than an author needs to see.
 */
export const COMMON_TAGS: string[] = [
  '前端',
  '后端',
  'JavaScript',
  'TypeScript',
  'Vue',
  'React',
  'Node.js',
  'CSS',
  'HTML',
  'Java',
  'Spring Boot',
  'Python',
  'Django',
  'Go',
  'Rust',
  'C++',
  '数据库',
  'MySQL',
  'Redis',
  'Linux',
  'Docker',
  'Kubernetes',
  'Git',
  '算法',
  '数据结构',
  '设计模式',
  '人工智能',
  '机器学习',
  '深度学习',
  '大模型',
  '大数据',
  '云原生',
  '微服务',
  '分布式',
  '性能优化',
  '网络',
  '网络安全',
  '运维',
  '测试',
  '架构',
  '面试',
  '程序人生'
]

/** Where a list came from. `builtin` means every API candidate failed. */
export type MetaSource = 'api' | 'builtin'

export interface MetaListResult {
  items: string[]
  source: MetaSource
}

export interface MetaClientDeps {
  http: CsdnHttpClient
  config: CsdnConfig
  logger?: Logger
}

/**
 * Candidate 1: the author's own columns (`data.categorys`), which is exactly the
 * string `saveArticle` expects in its `categories` field.
 */
const AUTHOR_INFO_PATH = '/blog-console-api/v1/editor/getBaseInfo'

/**
 * Candidate 2: the same columns with ids, from the article-management console.
 * Ordered after `getBaseInfo` only because its payload is much larger for the
 * same content.
 */
const AUTHOR_CRITERIA_PATH = '/blog-console-api/v1/article/getQueryCriteriaNew'

/**
 * Candidate 3: CSDN's platform taxonomy, parent categories with a `childList`.
 * Reached only when the account has no columns of its own — the names are real
 * CSDN category names, so an empty console still gets something usable.
 */
const PLATFORM_CATEGORY_PATH = '/blog/phoenix/console/v1/category/get-list'

/**
 * The only tag-listing endpoint that exists in either front-end bundle. POST
 * only — a GET answers `405 Method Not Allowed` — and the console sends the
 * `Content-Type` verbatim as `application/json;` (no charset), so that is what
 * we sign and send. `search-recommend-tag` is not a fallback: it needs a query
 * and returns `[]` for an empty body.
 */
const RECOMMEND_TAGS_PATH = '/blog/phoenix/console/v1/tag/get-recommend-tags'
const TAGS_CONTENT_TYPE = 'application/json;'

/** Narrow an unknown JSON value to a plain object (arrays and null excluded). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Treat anything that is not an array as an empty one. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Web-shape a tag/category list: drop non-strings and blanks, trim, and remove
 * duplicates while keeping first-seen order (the API's own ordering is the
 * meaningful one — `common` before the grouped dictionary).
 */
function normalizeList(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Log-friendly description of a failure, without ever touching the cookie. */
function describeError(error: unknown): string {
  if (isCsdnError(error)) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}

interface Candidate {
  /** Endpoint name, used in debug logs. */
  name: string
  load: () => Promise<string[]>
}

export class MetaClient {
  readonly config: CsdnConfig
  readonly logger: Logger
  private readonly http: CsdnHttpClient

  constructor(deps: MetaClientDeps) {
    this.http = deps.http
    this.config = deps.config
    this.logger = deps.logger ?? createLogger({ level: deps.config.logLevel })
  }

  /**
   * The author's article categories, newest endpoint first.
   *
   * Never rejects: if every candidate fails or answers with nothing usable, the
   * builtin list is returned with `source: 'builtin'`.
   */
  async listCategories(): Promise<MetaListResult> {
    return this.resolve('categories', BUILTIN_CATEGORIES, [
      { name: AUTHOR_INFO_PATH, load: async () => this.categoriesFromAuthorInfo() },
      { name: AUTHOR_CRITERIA_PATH, load: async () => this.categoriesFromCriteria() },
      { name: PLATFORM_CATEGORY_PATH, load: async () => this.categoriesFromPlatform() }
    ])
  }

  /**
   * Tags an author can attach to a post: the personalised `common` list first,
   * then CSDN's grouped tag dictionary.
   *
   * Never rejects: see `listCategories`.
   */
  async listTags(): Promise<MetaListResult> {
    return this.resolve('tags', COMMON_TAGS, [
      { name: RECOMMEND_TAGS_PATH, load: async () => this.tagsFromRecommendations() }
    ])
  }

  /**
   * Walk the candidates in order and return the first non-empty answer.
   *
   * Anything a candidate throws is swallowed and logged at debug: the caller
   * asked for a list to choose from, not for a diagnosis of CSDN's gateway.
   */
  private async resolve(label: string, fallback: string[], candidates: Candidate[]): Promise<MetaListResult> {
    for (const candidate of candidates) {
      try {
        const items = await candidate.load()
        if (items.length === 0) {
          this.logger.debug('metadata endpoint returned nothing', { label, endpoint: candidate.name })
          continue
        }
        this.logger.debug('metadata loaded from api', {
          label,
          endpoint: candidate.name,
          count: items.length
        })
        return { items, source: 'api' }
      } catch (error) {
        this.logger.debug('metadata endpoint failed', {
          label,
          endpoint: candidate.name,
          error: describeError(error)
        })
      }
    }
    this.logger.debug('falling back to builtin metadata', { label, count: fallback.length })
    // A copy: a caller must not be able to mutate the shared constant.
    return { items: [...fallback], source: 'builtin' }
  }

  /** `GET /blog-console-api/v1/editor/getBaseInfo` → `data.categorys`. */
  private async categoriesFromAuthorInfo(): Promise<string[]> {
    const data = await this.http.requestData<unknown>({ method: 'GET', path: AUTHOR_INFO_PATH })
    return normalizeList(asArray(asRecord(data)?.['categorys']))
  }

  /** `GET /blog-console-api/v1/article/getQueryCriteriaNew` → `data.column[].title`. */
  private async categoriesFromCriteria(): Promise<string[]> {
    const data = await this.http.requestData<unknown>({ method: 'GET', path: AUTHOR_CRITERIA_PATH })
    const columns = asArray(asRecord(data)?.['column'])
    return normalizeList(columns.map(column => asRecord(column)?.['title']))
  }

  /** `GET /blog/phoenix/console/v1/category/get-list` → parent + child names. */
  private async categoriesFromPlatform(): Promise<string[]> {
    const data = await this.http.requestData<unknown>({ method: 'GET', path: PLATFORM_CATEGORY_PATH })
    const names: unknown[] = []
    for (const node of asArray(data)) {
      const record = asRecord(node)
      if (record === undefined) continue
      names.push(record['categoryName'])
      for (const child of asArray(record['childList'])) names.push(asRecord(child)?.['categoryName'])
    }
    return normalizeList(names)
  }

  /** `POST /blog/phoenix/console/v1/tag/get-recommend-tags` → `data.common` + `data.list`. */
  private async tagsFromRecommendations(): Promise<string[]> {
    const data = await this.http.requestData<unknown>({
      method: 'POST',
      path: RECOMMEND_TAGS_PATH,
      body: {},
      contentType: TAGS_CONTENT_TYPE
    })
    const record = asRecord(data)
    if (record === undefined) return []
    const tags: unknown[] = [...asArray(record['common'])]
    const grouped = asRecord(record['list'])
    if (grouped !== undefined) {
      for (const group of Object.values(grouped)) tags.push(...asArray(group))
    }
    return normalizeList(tags)
  }
}
