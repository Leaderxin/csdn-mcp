/**
 * The tool registry — the one place the frozen tool surface is assembled.
 *
 * `src/server.ts` calls `registerTools(server, context)` and nothing else, so a
 * tool that is not registered here does not exist as far as an MCP host is
 * concerned. That makes this file the single point where a tool can silently go
 * missing, which is why:
 *
 *   - `TOOL_NAMES` is a hard-coded literal list instead of being derived from the
 *     registrations (a derived list would agree with itself even after a
 *     registration was deleted), and
 *   - each domain module also exports the names it registers, so the registry
 *     test can cross-check the three sources: the frozen list, the domain lists,
 *     and what `tools/list` actually answers.
 *
 * Order matters only for documentation: it follows docs/ARCHITECTURE.md §4.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ServerContext } from '../context.js'
import { AUTH_TOOL_NAMES, registerAuthTools } from './auth.js'
import { DELETE_TOOL_NAMES, registerDeleteTools } from './delete.js'
import { META_TOOL_NAMES, registerMetaTools } from './meta.js'
import { PUBLISH_TOOL_NAMES, registerPublishTools } from './publish.js'
import { READ_TOOL_NAMES, registerReadTools } from './read.js'
import { UPDATE_TOOL_NAMES, registerUpdateTools } from './update.js'
import { UPLOAD_TOOL_NAMES, registerUploadTools } from './upload.js'

/**
 * The v1.0.0 tool surface, frozen by docs/ARCHITECTURE.md §4. Spelled exactly as
 * an MCP host must call them.
 */
export const TOOL_NAMES: readonly string[] = Object.freeze([
  'auth_login',
  'auth_status',
  'publish_article',
  'update_article',
  'get_article',
  'list_articles',
  'delete_article',
  'upload_image',
  'list_categories',
  'list_tags',
  'verify_article'
])

/** Register every tool on `server`, all of them bound to `ctx`. */
export function registerTools(server: McpServer, ctx: ServerContext): void {
  registerAuthTools(server, ctx)
  registerPublishTools(server, ctx)
  registerUpdateTools(server, ctx)
  registerReadTools(server, ctx)
  registerDeleteTools(server, ctx)
  registerUploadTools(server, ctx)
  registerMetaTools(server, ctx)
}

/**
 * The names each domain module registers. Exported so a test can assert the
 * domain split is exhaustive against `TOOL_NAMES` — the check that turns "a file
 * forgot to register its tool" into a failing test rather than a missing tool.
 */
export const TOOL_NAMES_BY_DOMAIN: readonly (readonly string[])[] = Object.freeze([
  AUTH_TOOL_NAMES,
  PUBLISH_TOOL_NAMES,
  UPDATE_TOOL_NAMES,
  READ_TOOL_NAMES,
  DELETE_TOOL_NAMES,
  UPLOAD_TOOL_NAMES,
  META_TOOL_NAMES
])
