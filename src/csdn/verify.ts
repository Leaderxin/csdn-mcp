/**
 * Post-write verification.
 *
 * `saveArticle` answering HTTP 200 is **not** evidence that anything happened:
 * the envelope is 200 for a draft, for a publish, and for a write CSDN quietly
 * discarded. v0 shipped the opposite belief — it sent `status: 0` thinking that
 * meant "draft", CSDN published the article immediately, and only a fetch of the
 * public page revealed it.
 *
 * So verification combines two independent signals and refuses to conclude from
 * one of them alone:
 *   1. the console API record (`ArticleClient.get`) — the only place a draft is
 *      visible at all;
 *   2. the public article page, fetched **with a cache buster**, because CSDN's
 *      CDN happily serves yesterday's 404 (or 200) for today's state.
 *
 * `consistent` is true only when both agree with what the caller asked for:
 *   draft   → API state `draft`   AND public 404
 *   publish → API state `published` AND public 200, or API state `reviewing`
 *             (submitted but not yet public: 404 is the normal in-flight answer)
 */

import type { CsdnConfig } from '../core/config.js'
import type { CsdnHttpClient } from '../core/http.js'
import { defaultSleep, type Now, type Sleep } from '../core/ratelimit.js'
import type { ArticleClient } from './article.js'
import { articleUrl, type ArticleDetail, type ArticleState, type VerificationResult } from './types.js'

/**
 * Extra public-page attempts a `521` earns. CSDN's front door returns 521 with a
 * "安全验证" challenge page intermittently; that is a flake, not a verdict.
 */
const DEFAULT_PUBLIC_RETRIES = 2

/** Delay between public-page attempts: long enough for a WAF challenge to clear. */
const DEFAULT_PUBLIC_RETRY_DELAY_MS = 3_000

/** Cloudflare's challenge/origin-down status, seen intermittently on blog.csdn.net. */
const PUBLIC_STATUS_CHALLENGE = 521
const PUBLIC_STATUS_NOT_FOUND = 404
const PUBLIC_STATUS_OK = 200

const STATE_LABEL: Readonly<Record<ArticleState, string>> = {
  published: '已发布',
  draft: '草稿',
  reviewing: '审核中',
  rejected: '审核被拒',
  unknown: '状态未知'
}

const EXPECTED_LABEL: Readonly<Record<'draft' | 'publish', string>> = {
  draft: '草稿',
  publish: '发布'
}

/**
 * `verifyArticle`'s dependencies.
 *
 * The first three fields are the frozen contract from docs/ARCHITECTURE.md; the
 * rest are optional seams so the retry can be tested (and tuned) without a real
 * three-second wait. A structural superset, so existing callers are unaffected.
 */
export interface VerifyArticleDeps {
  articles: ArticleClient
  http: CsdnHttpClient
  config: CsdnConfig
  /** Injectable clock for the retry wait. */
  sleep?: Sleep
  /** Injectable time source, also used for the cache-buster. */
  now?: Now
  /** Extra public-page attempts after a 521. Default 2 (three attempts total). */
  publicRetries?: number
  /** Delay between those attempts. Default 3000ms. */
  retryDelayMs?: number
}

/**
 * The public URL, with a cache-busting `spm` value.
 *
 * Without the cache buster CSDN's CDN answers from cache and the check reports
 * the *previous* state of the article — the failure mode that makes a broken
 * publish look verified.
 */
function publicArticleUrl(config: CsdnConfig, articleId: string, timestamp: number): string {
  return `${articleUrl(config.userName, articleId, config.blogBase)}?spm=cb${timestamp}`
}

interface Judgement {
  consistent: boolean
  message: string
}

/**
 * Turn the two observations into one verdict and one sentence.
 *
 * The message is the deliverable: an agent (or the author) reads it instead of
 * the raw fields, so it always names the raw `status` code and the public status
 * it actually saw.
 */
function judge(expected: 'draft' | 'publish', detail: ArticleDetail, publicStatus: number): Judgement {
  const code = detail.statusCode

  if (detail.state === 'rejected') {
    const reason = detail.reason.trim() === '' ? 'CSDN 未给出原因' : detail.reason.trim()
    return { consistent: false, message: `文章被审核拒绝（status=${code}）：${reason}` }
  }

  if (detail.state === 'unknown') {
    return {
      consistent: false,
      message: `无法确认${EXPECTED_LABEL[expected]}：接口返回无法识别的状态 status=${code}`
    }
  }

  if (expected === 'draft') {
    if (detail.state === 'draft' && publicStatus === PUBLIC_STATUS_NOT_FOUND) {
      return { consistent: true, message: `草稿已确认：接口 status=${code}，公开页 404` }
    }
    if (detail.state === 'draft') {
      return {
        consistent: false,
        message: `草稿状态一致，但公开页返回 ${publicStatus}（应为 404）：文章可能已经对外可见`
      }
    }
    return {
      consistent: false,
      message: `草稿未被接受：接口 status=${code} 显示为${STATE_LABEL[detail.state]}，公开页 ${publicStatus}`
    }
  }

  // expected === 'publish'
  if (detail.state === 'reviewing') {
    return {
      consistent: true,
      message: `已提交审核：接口 status=${code} 处于审核中，公开页 ${publicStatus} 属正常（审核通过后才会公开）`
    }
  }
  if (detail.state === 'published' && publicStatus === PUBLIC_STATUS_OK) {
    return { consistent: true, message: `发布已确认：接口 status=${code}，公开页 200` }
  }
  if (detail.state === 'published') {
    return {
      consistent: false,
      message: `接口显示已发布（status=${code}），但公开页返回 ${publicStatus}（应为 200），无法确认对外可见`
    }
  }
  return {
    consistent: false,
    message: `CSDN 未接受发布：接口 status=${code} 仍为草稿，公开页 ${publicStatus}`
  }
}

/**
 * A `521` is not a statement about the article, so it must never be allowed to
 * read as one. Both "confirmed" verdicts require a 404/200 and therefore can
 * never carry a 521, so this note simply decorates every inconclusive message.
 */
function challengeNote(publicStatus: number, attempts: number): string {
  if (publicStatus !== PUBLIC_STATUS_CHALLENGE) return ''
  return `（公开页 ${publicStatus} 为安全验证页，重试 ${attempts} 次仍未通过，公开页结论不可用）`
}

/**
 * Check that a write really did what it claimed.
 *
 * Errors from the console API (`articles.get`) propagate: without the API record
 * there is no state to compare, and reporting `consistent: false` would look
 * like a verdict about the article instead of a failure to look at it.
 */
export async function verifyArticle(
  deps: VerifyArticleDeps,
  articleId: string,
  expected: 'draft' | 'publish'
): Promise<VerificationResult> {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const delay = deps.retryDelayMs ?? DEFAULT_PUBLIC_RETRY_DELAY_MS
  const maxAttempts = Math.max(1, (deps.publicRetries ?? DEFAULT_PUBLIC_RETRIES) + 1)

  const detail = await deps.articles.get(articleId)

  let publicStatusCode = 0
  let attempts = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // A fresh cache buster per attempt: a retry must not reuse the cached page
    // that produced the 521.
    const response = await deps.http.fetchText(publicArticleUrl(deps.config, articleId, now()))
    publicStatusCode = response.status
    attempts = attempt
    if (publicStatusCode !== PUBLIC_STATUS_CHALLENGE) break
    if (attempt < maxAttempts) await sleep(delay)
  }

  const { consistent, message } = judge(expected, detail, publicStatusCode)

  return {
    articleId,
    state: detail.state,
    statusCode: detail.statusCode,
    publicStatusCode,
    consistent,
    message: `${message}${challengeNote(publicStatusCode, attempts)}`
  }
}
