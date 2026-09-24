/**
 * Client-side throttling.
 *
 * CSDN throttles two different things at two different rates:
 *   - ordinary reads/writes on the console API: bursts are fine, hammering is not
 *   - `saveArticle` / `del`: at most roughly one per 10 seconds, otherwise
 *     "文章频繁发布，请稍后再试"
 *
 * The limiter is keyed so that a save and a read do not block each other, and it
 * serializes concurrent callers on the same key (a naive "check timestamp then
 * proceed" would let two parallel saves through at the same instant).
 */

export type Sleep = (ms: number) => Promise<void>
export type Now = () => number

export const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export interface RateLimiterOptions {
  sleep?: Sleep
  now?: Now
}

interface KeyState {
  /** Timestamp of the last *granted* slot. */
  lastGrantedAt: number
  /** Tail of the queue for this key: the next caller awaits this promise. */
  queue: Promise<void>
}

export class RateLimiter {
  private readonly states = new Map<string, KeyState>()
  private readonly sleep: Sleep
  private readonly now: Now

  constructor(options: RateLimiterOptions = {}) {
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? Date.now
  }

  /**
   * Wait until a slot for `key` is available, then return how long we waited.
   * `minIntervalMs <= 0` disables throttling for that key.
   */
  async acquire(key: string, minIntervalMs: number): Promise<number> {
    const state = this.states.get(key) ?? { lastGrantedAt: Number.NEGATIVE_INFINITY, queue: Promise.resolve() }
    this.states.set(key, state)

    let waited = 0
    const mine = state.queue.then(async () => {
      const readyAt = state.lastGrantedAt + Math.max(0, minIntervalMs)
      const waitFor = readyAt - this.now()
      if (waitFor > 0) {
        waited = waitFor
        await this.sleep(waitFor)
      }
      state.lastGrantedAt = this.now()
    })
    // Keep the chain alive even if a caller rejects downstream.
    state.queue = mine.catch(() => undefined)
    await mine
    return waited
  }

  /** Forget all throttle state. Useful between tests. */
  reset(): void {
    this.states.clear()
  }
}
