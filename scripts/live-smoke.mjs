#!/usr/bin/env node
/**
 * live-smoke.mjs — an OPT-IN, MANUALLY RUN end-to-end smoke test against the
 * REAL CSDN API.
 *
 *   Run:  CSDN_LIVE=1 node scripts/live-smoke.mjs
 *
 * There is deliberately no npm script for this, unlike `test:live` (which runs
 * the vitest live suite). This one is not part of any suite: it exists to be run
 * by hand after a change to the article write path, against a real account, and
 * it creates and deletes one real draft while it runs.
 *
 * What it proves, in one pass:
 *   1. a new article written with `mode: 'draft'` is accepted by CSDN;
 *   2. the console API reports it as `state: 'draft'` — the write did not
 *      quietly land as a publish (v0 sent `status: 0`, which CSDN now treats as
 *      *publish*; see ARTICLE_STATE_BY_CODE in src/csdn/types.ts);
 *   3. the public article page 404s, which is the only claim that cannot lie.
 *      Step 3 is the regression test for "an unreviewed draft became public":
 *      a 200 here means the draft is live, and the fix is to delete it, not to
 *      debug anything;
 *   4. the draft is deleted for good, in a `finally`, so a failure in steps 1-3
 *      still cleans up after itself.
 *
 * It never publishes. It never prints the cookie — not the value, not a prefix,
 * not a suffix; every line of output goes through `redact()` first.
 *
 * Requirements: `npm run build` has been run (this drives the built server in
 * dist/, it compiles nothing itself), plus CSDN_LIVE=1 and a cookie.
 */

import { readFileSync } from 'node:fs'

/** Where the cookie is looked up when it is not already in the environment. */
const ENV_FILE = '/opt/data/.env'

/** Marks the throwaway article, so a leftover is obvious in the console. */
const TITLE_PREFIX = '[smoke-test]'

/**
 * TEST-ONLY relaxation of the write throttle.
 *
 * The production default is `saveIntervalMs: 11000` (CSDN rejects writes closer
 * together than ~10s with "文章频繁发布，请稍后再试"). This run makes exactly two
 * writes — create and delete — watched by a human, so 4s keeps it quick while
 * still letting the client's own rate-limit retry absorb a server-side
 * rejection. A throttle hit therefore only makes the run slower, never flaky.
 */
const SAVE_INTERVAL_MS = 4000

const STEP_TOTAL = 4

// ─────────────────────────────────────────────────────────────────────────────
// Preconditions. Checked before anything is imported or sent, so a missing
// cookie produces one clear message instead of a stack trace from a 401 path.
// ─────────────────────────────────────────────────────────────────────────────

/** Produced by `npm run build`; the guard below explains it when absent. */
const CONTEXT_MODULE = '../dist/context.js'

/** Strip one layer of shell/`.env`-style quotes. */
function unquote(value) {
  const doubleQuoted = value.startsWith('"') && value.endsWith('"')
  const singleQuoted = value.startsWith("'") && value.endsWith("'")
  return doubleQuoted || singleQuoted ? value.slice(1, -1) : value
}

/** Minimal `KEY=VALUE` reader for one key. No dotenv dependency, on purpose. */
function readCookieFromEnvFile(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq).trim() !== 'CSDN_COOKIE') continue
    return unquote(trimmed.slice(eq + 1).trim())
  }
  return undefined
}

const problems = []

if (process.env.CSDN_LIVE !== '1') {
  problems.push(
    'CSDN_LIVE is not set to 1 — this script talks to the real CSDN API and must never run by accident.'
  )
}

const cookieFromEnv = (process.env.CSDN_COOKIE ?? '').trim()
const cookie = cookieFromEnv !== '' ? cookieFromEnv : (readCookieFromEnvFile(ENV_FILE) ?? '').trim()
const cookieSource = cookieFromEnv !== '' ? 'environment (CSDN_COOKIE)' : `env file (${ENV_FILE})`

if (cookie === '') {
  problems.push(
    `CSDN_COOKIE is empty, both in the environment and in ${ENV_FILE}. Copy the full 'Cookie' header ` +
      'from F12 → Network → any csdn.net request → Request Headers → Cookie.'
  )
} else {
  // Structural checks only, mirroring validateCookie() in src/core/config.ts.
  // The value itself is never printed.
  if (!cookie.includes('UserToken=')) {
    problems.push(
      'CSDN_COOKIE does not contain `UserToken=`. That cookie is HTTP-only, so a value copied from ' +
        '`document.cookie` cannot work — copy the request header instead.'
    )
  }
  if (!cookie.includes('UserName=')) {
    problems.push('CSDN_COOKIE does not contain `UserName=` — the copy is probably truncated.')
  }
}

if (problems.length > 0) {
  console.error('✗ Refusing to run the live smoke test. Missing:')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\n  Usage: CSDN_LIVE=1 node scripts/live-smoke.mjs')
  process.exit(2)
}

console.log('csdn-mcp live smoke test')
console.log(`  cookie source : ${cookieSource} (${cookie.length} chars — value never printed)`)
console.log(`  writes        : 1 draft + 1 delete, saveIntervalMs=${SAVE_INTERVAL_MS} (test-only)`)
console.log('')

// ─────────────────────────────────────────────────────────────────────────────
// Output helpers. Every printed value passes through `redact()`: the cookie is
// a list of tokens and any single one of them is a credential, so the whole
// string *and* every individual token value are masked.
// ─────────────────────────────────────────────────────────────────────────────

const SECRET_PARTS = cookie
  .split(';')
  .map(part => part.trim())
  .filter(part => part.includes('='))
  .map(part => part.slice(part.indexOf('=') + 1))
  // Short values would match innocent text (a bare "1", "true", a date slice).
  .filter(value => value.length >= 6)
  .sort((a, b) => b.length - a.length)

function redact(text) {
  let out = String(text)
  // Longest first: masking a short token inside a longer one would leave the
  // longer value half-exposed.
  for (const secret of [cookie, ...SECRET_PARTS]) {
    if (secret === '') continue
    out = out.split(secret).join('<redacted>')
  }
  return out
}

/** One-line JSON that cannot leak a secret and cannot flood the terminal. */
function show(value, limit = 600) {
  let text
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text === undefined) text = String(value)
  const collapsed = redact(text).replace(/\s+/g, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`
}

class SmokeFailure extends Error {}

function check(condition, message) {
  if (!condition) throw new SmokeFailure(message)
}

let passed = 0

/** Run one numbered step, print its raw result, and let failures propagate. */
async function step(index, description, action) {
  console.log(`[${index}/${STEP_TOTAL}] ${description}`)
  try {
    const result = await action()
    console.log(`      ok → ${show(result)}`)
    passed += 1
    return result
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    console.log(`      FAILED → ${redact(message)}`)
    throw error
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The run itself.
// ─────────────────────────────────────────────────────────────────────────────

// Dynamic import, not a static one: static imports are evaluated before the
// guards above, so a missing build would surface as ERR_MODULE_NOT_FOUND
// instead of "run npm run build".
const contextModule = await import(CONTEXT_MODULE).catch(error => {
  console.error(`✗ Cannot import ${CONTEXT_MODULE}: ${redact(error.message)}`)
  console.error('  The smoke test drives the built server. Run `npm run build` first.')
  process.exit(2)
})
const { createContext } = contextModule
check(typeof createContext === 'function', `${CONTEXT_MODULE} does not export createContext()`)

const context = createContext({
  // Test-only: see SAVE_INTERVAL_MS above. Every other field is production config.
  saveIntervalMs: SAVE_INTERVAL_MS
})

const startedAt = new Date().toISOString()
const title = `${TITLE_PREFIX} ${startedAt}`
let articleId = ''
let failure = null

console.log(`  apiBase     : ${context.config.apiBase}`)
console.log(`  public base : ${context.config.blogBase}`)
console.log('')

try {
  // ── step 1: create the throwaway draft ───────────────────────────────────
  await step(1, `create a draft titled "${title}" (mode: 'draft')`, async () => {
    const saved = await context.articles.save({
      title,
      content: '<p>Automated smoke test. This draft is deleted again in step 4.</p>',
      markdownContent: 'Automated smoke test. This draft is deleted again in step 4.',
      description: 'Automated smoke test draft; created and deleted by scripts/live-smoke.mjs.',
      tags: ['MCP', 'smoke-test'],
      categories: '后端',
      mode: 'draft'
    })
    // Recorded before asserting: a malformed response must still be cleaned up.
    articleId = saved.id
    check(typeof articleId === 'string' && articleId.trim() !== '', 'save() resolved without an article id')
    check(
      typeof saved.url === 'string' && saved.url.startsWith('http'),
      `save() returned a non-absolute url: ${show(saved.url)}`
    )
    return saved
  })

  // ── step 2: the console API is the only place a draft is visible ─────────
  const detail = await step(2, `get(${articleId}) reports state 'draft'`, async () => {
    const record = await context.articles.get(articleId)
    check(
      record.state === 'draft',
      `expected state 'draft' but CSDN reports '${record.state}' (status=${record.statusCode}). ` +
        'A non-draft state means the write published the article — delete it immediately.'
    )
    check(record.statusCode === 2, `expected status code 2 for a draft, got ${record.statusCode}`)
    return record
  })

  // ── step 3: the public page must 404 while the article is a draft ────────
  const publicUrl = detail.url
  check(
    typeof publicUrl === 'string' && publicUrl !== '',
    'get() returned no public url to check — rebuilding it needs config.userName'
  )
  await step(
    3,
    `the public page ${publicUrl} still answers 404 (this is the draft-did-not-leak check)`,
    async () => {
      const response = await context.http.fetchText(publicUrl)
      check(
        response.status === 404,
        `the public page answered HTTP ${response.status} for an unpublished draft. An unreviewed ` +
          `draft is publicly readable — delete article ${articleId} at once. ` +
          `Body head: ${show(response.text, 160)}`
      )
      return { status: response.status, url: publicUrl, bodyHead: response.text.slice(0, 120) }
    }
  )

  // ── step 4 runs in `finally` below, so a failure above still cleans up ───
} catch (error) {
  failure = error
} finally {
  if (articleId === '') {
    console.log(`[${STEP_TOTAL}/${STEP_TOTAL}] cleanup: nothing to delete (no article was created)`)
  } else {
    try {
      const removed = await step(4, `delete draft ${articleId} permanently`, () =>
        context.articles.remove(articleId, true)
      )
      if (removed.permanent !== true) {
        throw new SmokeFailure('remove() did not report a permanent delete')
      }
    } catch (error) {
      if (failure === null) failure = error
      console.error(
        `      ! ${articleId} was not confirmed deleted — check ` +
          'https://mp.csdn.net/mp_blog/manage/article and remove it by hand before running this again.'
      )
    }
  }
}

console.log('')
if (failure === null) {
  console.log(`✓ smoke test passed (${passed}/${STEP_TOTAL} steps). Nothing was published.`)
} else {
  const message = failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure)
  console.error(`✗ smoke test failed → ${redact(message)}`)
  console.error(`  ${passed}/${STEP_TOTAL} steps passed. Nothing was published.`)
  process.exitCode = 1
}
