/**
 * Upload the local images a Markdown document points at, and hand the document
 * back with those paths swapped for CDN URLs.
 *
 * This exists because CSDN has hotlink protection: a relative path or a
 * third-party URL renders as a broken image, and the only fix is to have the
 * bytes on CSDN's own CDN. Doing it by hand means one `upload_image` call per
 * image plus a copy-paste back into the Markdown — the most repetitive part of
 * publishing, and the part where a missed replacement is invisible until the
 * article is read.
 *
 * The two existing mechanisms stay separate on purpose. `IMG_*` placeholders
 * (`substituteImagePlaceholders`) are for a caller that already has URLs; this
 * one is for a caller that has files.
 */

import { CsdnError, isCsdnError } from '../core/errors.js'
import { findLocalImageRefs, rewriteImageRefs } from '../csdn/markdown.js'
import type { ServerContext } from '../context.js'

export interface MaterializedImages {
  /** The document, with every local path replaced. Unchanged when there were none. */
  markdown: string
  /** Local path → uploaded URL, in upload order. Empty when nothing was needed. */
  uploaded: Record<string, string>
}

/**
 * Upload every local image the document references through the **body** channel.
 *
 * Fails the whole call on the first upload error rather than publishing a broken
 * document. The error names the file that failed *and* every path already
 * uploaded: a partial upload is bytes already spent, and the caller needs to fix
 * one file without re-uploading the others.
 */
export async function uploadLocalImages(ctx: ServerContext, markdown: string): Promise<MaterializedImages> {
  const refs = findLocalImageRefs(markdown)
  if (refs.length === 0) return { markdown, uploaded: {} }

  const uploaded: Record<string, string> = {}
  for (const ref of refs) {
    try {
      // Body channel, never cover: a body image sent up the cover channel
      // uploads fine and then never appears as a cover, or as a body image.
      const result = await ctx.media.upload({ path: ref, kind: 'body' })
      uploaded[ref] = result.url
    } catch (error) {
      const done = Object.keys(uploaded)
      const reason = error instanceof Error ? error.message : String(error)
      throw new CsdnError(
        isCsdnError(error) ? error.code : 'INVALID_ARGUMENT',
        `正文图片上传失败：${ref} —— ${reason}`,
        {
          detail: `failed=${ref}; already_uploaded=${done.length === 0 ? 'none' : done.join(',')}`
        }
      )
    }
  }

  return { markdown: rewriteImageRefs(markdown, uploaded), uploaded }
}

/**
 * One line for the reply. Silent when nothing was uploaded, so a caller that
 * never passes local paths sees no change at all.
 */
export function describeUploadedImages(uploaded: Record<string, string>): string | undefined {
  const entries = Object.entries(uploaded)
  if (entries.length === 0) return undefined
  const pairs = entries.map(([path, url]) => `${path} → ${url}`).join('；')
  return `正文图片已自动上传 ${entries.length} 张（body 通道）并替换为 CDN 地址：${pairs}`
}
