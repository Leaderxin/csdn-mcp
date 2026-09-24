/**
 * The composition root.
 *
 * Everything the tool layer needs is assembled here and injected, so no module
 * has to reach for a global. Tests build a context with fakes instead of
 * monkey-patching the network.
 */

import { buildConfig, getCookieValue, loadConfig, type CsdnConfig } from './core/config.js'
import { createLogger, type Logger } from './core/logger.js'
import { CsdnHttpClient } from './core/http.js'
import { ArticleClient } from './csdn/article.js'
import { MediaClient } from './csdn/media.js'
import { MetaClient } from './csdn/meta.js'

export interface UpdateCookieResult {
  userName: string
}

export interface ServerContext {
  /**
   * Mutable *in place*. A handful of callers (`auth_login`) swap the cookie on a
   * running server, and `CsdnHttpClient` holds this same object reference — so
   * mutating the fields here is what makes the new cookie take effect for every
   * subsequent request without rebuilding the client graph.
   */
  config: CsdnConfig
  logger: Logger
  http: CsdnHttpClient
  articles: ArticleClient
  media: MediaClient
  meta: MetaClient
  updateCookie(cookie: string): UpdateCookieResult
}

/** Injection seams. Every one of them is optional and defaults to the real thing. */
export interface ContextDeps {
  logger?: Logger
  http?: CsdnHttpClient
  articles?: ArticleClient
  media?: MediaClient
  meta?: MetaClient
}

/** Drop keys whose value is `undefined` so a partial override cannot blank a default. */
function definedOnly<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out as Partial<T>
}

export function createContext(overrides: Partial<CsdnConfig> = {}, deps: ContextDeps = {}): ServerContext {
  const config = buildConfig({ ...loadConfig(), ...definedOnly(overrides) })
  const logger = deps.logger ?? createLogger({ level: config.logLevel })
  const http = deps.http ?? new CsdnHttpClient({ config, logger })
  const articles = deps.articles ?? new ArticleClient({ http, config, logger })
  const media = deps.media ?? new MediaClient({ http, config, logger })
  const meta = deps.meta ?? new MetaClient({ http, config, logger })

  return {
    config,
    logger,
    http,
    articles,
    media,
    meta,
    updateCookie(cookie: string): UpdateCookieResult {
      config.cookie = cookie.trim()
      const userName = getCookieValue(config.cookie, 'UserName')
      // Keep the previous name when the new cookie carries none: a cookie
      // without UserName is a partial paste, and keeping the last known name
      // yields a better error message than an empty one later.
      if (userName !== undefined) config.userName = userName
      return { userName: config.userName }
    }
  }
}
