import type { LogLevel } from './config.js'

/**
 * Minimal logger.
 *
 * Two hard rules, both from incidents:
 *   - stdout belongs to the MCP stdio transport. Anything written there
 *     corrupts the protocol stream, so logs go to stderr.
 *   - Cookie values must never reach the log. Rather than trusting call sites to
 *     remember, every message and every field is run through `redact`.
 */

export interface LogFields {
  [key: string]: unknown
}

export interface Logger {
  level: LogLevel
  error(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  debug(message: string, fields?: LogFields): void
  child(bindings: LogFields): Logger
}

export type LogSink = (line: string) => void

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
}

/** Matches `UserToken=abc`, `Cookie: a=b`, `"cookie": "..."` and friends. */
const COOKIE_PATTERN = /(UserToken|UserName|csrfToken|uuid_tt_dd|c_session|Cookie)\s*[=:]\s*"?[^\s;"]{3,}/gi

/** Redact anything that looks like a credential. Applied to every log line. */
export function redact(input: string): string {
  return input.replace(COOKIE_PATTERN, (_match, name: string) => `${name}=<redacted>`)
}

/** Serialize a field value without ever emitting a raw cookie-ish string. */
function serializeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return redact(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) return redact(`${value.name}: ${value.message}`)
  try {
    return redact(JSON.stringify(value))
  } catch {
    return '[unserializable]'
  }
}

function formatLine(level: LogLevel, message: string, bindings: LogFields, fields?: LogFields): string {
  const parts = [`[csdn-mcp]`, level.toUpperCase(), redact(message)]
  const merged = { ...bindings, ...(fields ?? {}) }
  for (const [key, value] of Object.entries(merged)) {
    parts.push(`${key}=${serializeValue(value)}`)
  }
  return parts.join(' ')
}

export interface CreateLoggerOptions {
  level?: LogLevel
  sink?: LogSink
  bindings?: LogFields
}

/**
 * Create a logger. The default sink writes to stderr; tests inject a sink to
 * assert on redaction and level filtering.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? 'warn'
  const sink: LogSink = options.sink ?? ((line) => process.stderr.write(`${line}\n`))
  const bindings = options.bindings ?? {}
  const threshold = LEVEL_WEIGHT[level]

  const emit = (messageLevel: Exclude<LogLevel, 'silent'>) => (message: string, fields?: LogFields): void => {
    if (threshold === 0 || LEVEL_WEIGHT[messageLevel] > threshold) return
    sink(formatLine(messageLevel, message, bindings, fields))
  }

  return {
    level,
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    child: (extra: LogFields) =>
      createLogger({ level, sink, bindings: { ...bindings, ...extra } })
  }
}
