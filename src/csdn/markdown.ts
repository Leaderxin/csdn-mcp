/**
 * Markdown → HTML rendering plus the plain-text helpers CSDN's `saveArticle`
 * needs.
 *
 * Why this module exists: `saveArticle` carries the article body twice, and the
 * two fields have different contracts.
 *
 *   - `markdowncontent` stores the Markdown source verbatim.
 *   - `content` must be **rendered HTML**.
 *
 * v0 sent the raw Markdown in `content`, so CSDN displayed every `##` and `**`
 * literally: articles opened with the text "## 标题" and the editor kept a second
 * copy of the markers in the rendered body. `renderMarkdown` is the only way
 * `content` may be produced.
 *
 * The remaining exports exist for the metadata fields, which have their own
 * traps: CSDN's `Description` is capped at 256 characters and counts every
 * character against that budget (so nothing here appends an ellipsis), and a
 * `verification`/cover workflow needs to find `IMG_*` placeholders in the source
 * *before* it uploads anything — an upload that happened for a placeholder the
 * body never referenced is bytes thrown away.
 */

import { marked } from 'marked'
import { CsdnError } from '../core/errors.js'

/**
 * Render Markdown to the HTML that `saveArticle.content` expects.
 *
 * Synchronous on purpose: `marked` only returns a Promise when `async: true` or
 * an async extension is registered, and callers (`buildSaveArticleBody`) treat
 * the body as a string. `gfm: true` is what makes tables, task lists and
 * strikethrough render — CSDN's editor produces all three, and without GFM a
 * pasted table arrives as a paragraph of pipes.
 */
export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false, gfm: true })
}

/** Fence opener: up to three leading spaces then at least three backticks/tildes. */
const FENCE_OPEN = /^[ \t]{0,3}(?:`{3,}|~{3,})/
/**
 * Fence closer. A closing fence carries no info string, so the line must be
 * nothing but the fence — otherwise ```` ```js ```` inside a code sample would
 * end the block early.
 */
const FENCE_CLOSE = /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*$/

/**
 * Drop fenced code blocks together with their content.
 *
 * Content is dropped, not just the fences: a summary that keeps a shell snippet
 * ends up containing `##` and `*` from the snippet's own comments, which is the
 * exact noise this helper exists to remove. An unterminated fence swallows the
 * rest of the document, mirroring how CSDN's renderer treats it.
 */
function removeFencedCodeBlocks(markdown: string): string {
  const kept: string[] = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (inFence) {
      if (FENCE_CLOSE.test(line)) inFence = false
      continue
    }
    if (FENCE_OPEN.test(line)) {
      inFence = true
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Reduce Markdown to readable plain text.
 *
 * This feeds `deriveDescription`, so the contract is stricter than "looks
 * tidy": the result must never contain a `#` or a `*` marker. A description is
 * shown on the blog homepage and in search results, where a leaked `**` reads as
 * a bug in the tool.
 *
 * Order matters. Fenced blocks go first (their contents must not be mined for
 * markers), then images before links (otherwise `![alt](url)` matches the link
 * rule and leaves its alt text behind), then the remaining inline and line-level
 * markup.
 */
export function stripMarkdown(markdown: string): string {
  return removeFencedCodeBlocks(markdown.replace(/\r\n?/g, '\n'))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/<[^>\n]*>/g, '')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
    .replace(/^[ \t]*={3,}[ \t]*$/gm, '')
    .replace(/~~([\s\S]*?)~~/g, '$1')
    .replace(/(\*{1,3})([^\s*][\s\S]*?)\1/g, '$2')
    .replace(/(_{2,3})([^\s_][\s\S]*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fallback used when a body has no text to summarise (an image-only post, for
 * example). CSDN rejects an empty `Description`, so this must never be `''`.
 */
const EMPTY_DESCRIPTION_FALLBACK = '本文暂无摘要'

/**
 * Build the value for CSDN's `Description` field.
 *
 * Two CSDN-specific constraints shape this: the field is limited to 256
 * characters, and the limit counts every character we send — an appended "…"
 * would either overflow the budget or push real text out of it. So the result is
 * a hard slice, never an elided string.
 */
export function deriveDescription(markdown: string, maxLength = 256): string {
  const text = stripMarkdown(markdown).replace(/\s+/g, ' ').trim()
  if (text === '') return EMPTY_DESCRIPTION_FALLBACK
  return text.slice(0, maxLength)
}

/**
 * Front matter block, matched in one pass so the body can be sliced straight out
 * of the original text (CRLF included) instead of being rebuilt line by line.
 *
 * The `\r?\n` before the closing delimiter is mandatory, which forces the
 * closing dashes to be the first thing on their own line. Without it a value
 * such as `title: a---b` would be mistaken for the end of the block and the
 * post would lose its real body.
 */
const FRONT_MATTER = /^-{3,}[ \t]*\r?\n([\s\S]*?)\r?\n-{3,}[ \t]*(?:\r?\n|$)/

/** One `key: value` line. The key may not start with, or contain, a colon. */
const ATTRIBUTE_LINE = /^([^:\s][^:]*?)[ \t]*:[ \t]*(.*)$/

/**
 * Strip one layer of *matching* surrounding quotes.
 *
 * Implemented as a replace so an unbalanced value (`title: "half`) is returned
 * untouched rather than losing its opening quote.
 */
function unquote(value: string): string {
  return value.replace(/^(['"])([\s\S]*)\1$/, '$2')
}

export interface FrontMatter {
  attributes: Record<string, string>
  body: string
}

/**
 * Split an optional leading `---` block off the Markdown source.
 *
 * Never throws. Anything that is not a well-formed block — no opening dashes, or
 * an opening that is never closed — is reported as "no front matter", because
 * the alternative (guessing where the block ends) silently deletes the first
 * lines of a post.
 */
export function parseFrontMatter(markdown: string): FrontMatter {
  const match = FRONT_MATTER.exec(markdown)
  if (match === null) {
    return { attributes: {}, body: markdown }
  }
  // Group 1 is mandatory in the pattern, so it always participates when the
  // overall match succeeded.
  const rawAttributes = String(match[1])
  const attributes: Record<string, string> = {}
  for (const line of rawAttributes.split(/\r?\n/)) {
    const trimmed = line.trim()
    // Blank lines and `#` comments are common in hand-written front matter.
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const attribute = ATTRIBUTE_LINE.exec(trimmed)
    // A line without a `:` is not an attribute; skipping it is friendlier than
    // failing the whole publish over a stray line.
    if (attribute === null) continue
    attributes[String(attribute[1])] = unquote(String(attribute[2]))
  }
  // `match[0]` also swallows the newline that ends the closing delimiter, so the
  // body starts on the first real line of content.
  return { attributes, body: markdown.slice(match[0].length) }
}

/** A placeholder: `IMG_` followed by one or more word characters. */
const IMAGE_PLACEHOLDER = /IMG_[A-Za-z0-9_]+/g

/**
 * Find every `IMG_*` placeholder, in order of first appearance.
 *
 * De-duplicated so a caller uploads each image once even when the author reuses
 * the same placeholder several times.
 */
export function findImagePlaceholders(markdown: string): string[] {
  const seen = new Set<string>()
  const found: string[] = []
  for (const match of markdown.matchAll(IMAGE_PLACEHOLDER)) {
    const token = match[0]
    if (seen.has(token)) continue
    seen.add(token)
    found.push(token)
  }
  return found
}

/**
 * Replace placeholders with their uploaded URLs.
 *
 * Resolves the whole document before touching it: when a placeholder has no
 * mapping, every missing one is named in a single error. v0 uploaded the cover
 * image, then failed on an unmapped body placeholder immediately before
 * `saveArticle`, leaving a wasted upload and an unclear message behind.
 */
export function substituteImagePlaceholders(markdown: string, images: Record<string, string>): string {
  const placeholders = findImagePlaceholders(markdown)
  const missing = placeholders.filter((placeholder) => images[placeholder] === undefined)
  if (missing.length > 0) {
    throw new CsdnError('INVALID_ARGUMENT', `以下图片占位符没有对应的上传结果：${missing.join(', ')}`, {
      detail: `missing=${missing.join(',')}`
    })
  }
  let result = markdown
  for (const [placeholder, url] of Object.entries(images)) {
    // Split/join instead of a RegExp: placeholder text needs no escaping and
    // every occurrence is replaced, not just the first. Iterating the map's own
    // entries keeps the lookup free of index-signature typing.
    result = result.split(placeholder).join(url)
  }
  return result
}
