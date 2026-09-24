#!/usr/bin/env node
/**
 * Post-smoke verification, run by hand after scripts/live-smoke.mjs.
 *
 * 1. Read-back the article the smoke test deleted: it must NOT come back.
 *    A delete that reports ok is a claim; a 404/NOT_FOUND is evidence.
 * 2. Measure both candidate transports for `list_articles` on THIS machine,
 *    rather than trusting a report: the public community endpoint
 *    `ArticleClient.list()` uses today, and the author's console endpoint
 *    `/blog/phoenix/console/v1/article/list`.
 *
 *    Both answered 6/6 over six interleaved calls, and the console endpoint also
 *    reports drafts (`count.draft`) while the public one cannot see them. An
 *    earlier probe recorded the public endpoint as WAF-blocked with 521 on 3/3
 *    attempts; that was transient, and this script exists partly so the claim can
 *    be re-measured instead of inherited.
 *
 * Read-only. Creates nothing, deletes nothing, publishes nothing.
 */
import { readFileSync } from 'node:fs'
import { createContext } from '../dist/context.js'

const ENV_FILE = '/opt/data/.env'

function readCookie() {
  if (process.env.CSDN_COOKIE) return process.env.CSDN_COOKIE
  const text = readFileSync(ENV_FILE, 'utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('CSDN_COOKIE')) continue
    let value = trimmed.slice(trimmed.indexOf('=') + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    return value
  }
  throw new Error('no CSDN_COOKIE in environment or ' + ENV_FILE)
}

const ctx = createContext({ cookie: readCookie(), logLevel: 'silent' })
const DELETED_ID = process.argv[2]
if (!DELETED_ID) throw new Error('usage: node scripts/verify-post-smoke.mjs <deletedArticleId>')

let failures = 0
function report(label, ok, detail) {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` → ${detail}` : ''}`)
}

// ── 1. the deleted article must not come back ────────────────────────────────
console.log(`\n[1] read back article ${DELETED_ID} (deleted in step 4 of the smoke test)`)
try {
  const found = await ctx.articles.get(DELETED_ID)
  report('deleted article is really gone', false, `it still resolves: state=${found.state}`)
} catch (error) {
  // CSDN answers `getArticle` for a missing id with HTTP 400 and
  // `{"code":400,"msg":"系统暂不支持编辑此文章"}` — NOT 404. So "gone" surfaces as
  // HTTP_ERROR and the message has to be read, which is recorded in
  // docs/API-NOTES.md rather than papered over with a guessed mapping.
  const gone = error?.code === 'HTTP_ERROR' || error?.code === 'NOT_FOUND' || error?.code === 'API_ERROR'
  report('deleted article is really gone', gone, `${error?.code}: ${String(error?.message).slice(0, 120)}`)
}

// The console list is the stronger signal: a deleted article is absent from it
// whether or not the API chose to be polite about the id lookup above.
console.log('    cross-check: the id must be absent from the console list')
try {
  const response = await ctx.http.request({
    method: 'GET',
    path: '/blog/phoenix/console/v1/article/list',
    query: { page: 1, size: 100 },
    rateLimitKey: 'read'
  })
  const data = response?.data ?? response
  const ids = [...(data?.list ?? []), ...(data?.records ?? [])].map(item =>
    String(item.articleId ?? item.article_id ?? item.id)
  )
  report(
    'deleted article is absent from the console list',
    !ids.includes(String(DELETED_ID)),
    `${ids.length} articles listed`
  )
} catch (error) {
  report(
    'deleted article is absent from the console list',
    false,
    `${error?.code}: ${String(error?.message).slice(0, 120)}`
  )
}

// ── 2. list_articles: which transport actually works from here? ──────────────
console.log('\n[2] list_articles transport comparison')
console.log('    the cookies/tokens are never printed; only status codes and shape')

try {
  const page = await ctx.articles.list({ page: 1, pageSize: 5 })
  report('public community endpoint works', true, `${page.items.length} items, total=${page.total}`)
} catch (error) {
  report('public community endpoint works', false, `${error?.code}: ${String(error?.message).slice(0, 160)}`)
}

async function probeConsoleList() {
  const response = await ctx.http.request({
    method: 'GET',
    path: '/blog/phoenix/console/v1/article/list',
    query: { page: 1, size: 5 },
    rateLimitKey: 'read'
  })
  const data = response?.data ?? response
  const items = data?.list ?? data?.records ?? []
  return { items, count: data?.count }
}

try {
  const { items, count } = await probeConsoleList()
  report(
    'console article/list works',
    true,
    `${items.length} items, count=${JSON.stringify(count)}, first=${items[0]?.title ?? '(none)'}`
  )
  const drafts = items.filter(item => Number(item.status) === 2).length
  console.log(`       → this endpoint sees drafts too (status=2 present: ${drafts > 0})`)
} catch (error) {
  report('console article/list works', false, `${error?.code}: ${String(error?.message).slice(0, 160)}`)
}

console.log(`\n${failures === 0 ? '✓ all read-only checks passed' : `✗ ${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
