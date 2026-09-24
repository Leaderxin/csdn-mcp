/**
 * MCP server assembly.
 *
 * Kept separate from `index.ts` so the whole server can be built and driven
 * in-process by tests (the MCP SDK ships an in-memory transport pair for
 * exactly this), while `index.ts` stays a three-line bootstrap.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createContext, type ServerContext } from './context.js'
import { registerTools } from './tools/index.js'

export const SERVER_NAME = 'csdn-mcp'
export const SERVER_VERSION = '1.0.0'

export interface CreateServerOptions {
  /** Pre-built context. Defaults to one assembled from the environment. */
  context?: ServerContext
}

export interface BuiltServer {
  server: McpServer
  context: ServerContext
}

export function createServer(options: CreateServerOptions = {}): BuiltServer {
  const context = options.context ?? createContext()
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  registerTools(server, context)
  return { server, context }
}

/**
 * Build the server and connect it to stdio.
 *
 * Anything the returned promise rejects with has already been written to stderr
 * by the caller in `index.ts`; stdout is never touched, because it carries the
 * protocol stream.
 */
export async function startStdioServer(options: CreateServerOptions = {}): Promise<BuiltServer> {
  const built = createServer(options)
  const transport = new StdioServerTransport()
  await built.server.connect(transport)
  return built
}

/** Format a fatal bootstrap error for stderr. */
export function formatFatalError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
