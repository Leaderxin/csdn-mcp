#!/usr/bin/env node
/**
 * Executable entry point.
 *
 * Deliberately trivial: build the server, attach stdio, report a fatal startup
 * error on stderr. All behavior lives in `server.ts` and below so it can be
 * tested without spawning a process.
 */

import { formatFatalError, startStdioServer } from './server.js'

startStdioServer().catch((error: unknown) => {
  process.stderr.write(`[csdn-mcp] 启动失败 ${formatFatalError(error)}\n`)
  process.exit(1)
})
