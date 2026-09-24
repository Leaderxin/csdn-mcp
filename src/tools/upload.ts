/**
 * `upload_image` plus the cover helper the two write tools share.
 *
 * The upload itself lives in `src/csdn/media.ts`; this file is only the tool
 * surface: validate `kind`, hand the path to the client and report what came
 * back. `uploadCover` exists here rather than in `publish.ts` because the
 * cover/body channel split is an upload concern — the two channels are not
 * interchangeable, and a cover uploaded through the body channel simply does
 * not show up as a cover.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ServerContext } from '../context.js'
import { asCallToolResult, errorResult, jsonResult, type ToolResult } from './shared.js'

export const UPLOAD_TOOL_NAMES: readonly string[] = Object.freeze(['upload_image'])

/** Only these two channels exist, and the mistake is silent, so say it in the error. */
const KIND_SCHEMA = z.enum(['cover', 'body'], {
  errorMap: () => ({
    message:
      'kind 只能是 cover（封面图）或 body（正文图）：两条上传通道不通用，用混了不会报错，只是图片不显示。'
  })
})

/** An already-hosted cover passes straight through; anything else is a local path. */
const ABSOLUTE_URL = /^https?:\/\//i

/**
 * Resolve a `cover_image` argument to the URL `saveArticle` needs.
 *
 * Both forms are accepted on purpose: a URL returned by `upload_image` is used
 * as-is (re-uploading it would be impossible — there is no local file), while a
 * local path is uploaded through the **cover** channel. A path passed through
 * the body channel would upload successfully and never appear as a cover.
 */
export async function uploadCover(ctx: ServerContext, cover: string): Promise<string> {
  if (ABSOLUTE_URL.test(cover)) return cover
  const uploaded = await ctx.media.upload({ path: cover, kind: 'cover' })
  return uploaded.url
}

export async function uploadImage(
  ctx: ServerContext,
  args: { path: string; kind: 'cover' | 'body' }
): Promise<ToolResult> {
  try {
    const uploaded = await ctx.media.upload({ path: args.path, kind: args.kind })
    return jsonResult(
      `图片已上传（kind=${args.kind}）：${uploaded.url}（${uploaded.size} 字节，${uploaded.mimeType}）`,
      uploaded
    )
  } catch (error) {
    return errorResult(error)
  }
}

export function registerUploadTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'upload_image',
    {
      title: '上传图片',
      description:
        '把本地图片上传到 CSDN 图床，返回公网 URL（正文里请写这个绝对 URL，CSDN 有防盗链）。' +
        'kind 决定通道：封面图用 cover，正文图用 body，两条通道不通用。' +
        '不要用它上传非图片文件（仅支持 jpg/jpeg/png/gif/webp/bmp）；' +
        '也不要拿返回的 key 当图片地址用，那不是公网地址。',
      inputSchema: {
        path: z.string().trim().min(1, 'path 不能为空：需要本地图片文件的路径'),
        kind: KIND_SCHEMA
      }
    },
    async args => asCallToolResult(await uploadImage(ctx, args))
  )
}
