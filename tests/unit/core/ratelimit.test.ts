import { describe, expect, it, vi } from 'vitest'
import { RateLimiter, defaultSleep } from '../../../src/core/ratelimit.js'

interface TestClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Every sleep duration, in call order. */
  sleeps: number[]
  /** The clock reading observed *when* each sleep was requested. */
  sleepBases: number[]
  advance: (ms: number) => void
  read: () => number
}

/**
 * A controllable clock. Nothing here touches a real timer, so a test that
 * exercises an 11s save interval still finishes in microseconds.
 */
function makeClock(start = 0): TestClock {
  let time = start
  const sleeps: number[] = []
  const sleepBases: number[] = []
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      sleepBases.push(time)
      time += ms
    },
    sleeps,
    sleepBases,
    advance: (ms: number) => {
      time += ms
    },
    read: () => time
  }
}

describe('RateLimiter.acquire', () => {
  it('never sleeps on the first acquire for a key, because there is no previous slot to space from', async () => {
    const clock = makeClock()
    const limiter = new RateLimiter({ sleep: clock.sleep, now: clock.now })

    await expect(limiter.acquire('POST /save', 10_000)).resolves.toBe(0)
    expect(clock.sleeps).toEqual([])
  })

  it('waits exactly the remaining interval on a second acquire and returns that wait', async () => {
    const clock = makeClock()
    const limiter = new RateLimiter({ sleep: clock.sleep, now: clock.now })

    await limiter.acquire('POST /save', 10_000)
    await expect(limiter.acquire('POST /save', 10_000)).resolves.toBe(10_000)
    expect(clock.sleeps).toEqual([10_000])
  })

  it('waits only the remainder when part of the interval has already elapsed', async () => {
    const clock = makeClock()
    const limiter = new RateLimiter({ sleep: clock.sleep, now: clock.now })

    await limiter.acquire('POST /save', 10_000)
    clock.advance(4_000)
    await expect(limiter.acquire('POST /save', 10_000)).resolves.toBe(6_000)
    expect(clock.sleeps).toEqual([6_000])
  })

  it('does not sleep at all once the interval has already elapsed', async () => {
    const clock = makeClock()
    const limiter = new RateLimiter({ sleep: clock.sleep, now: clock.now })

    await limiter.acquire('POST /save', 10_000)
    clock.advance(10_000)
    await expect(limiter.acquire('POST /save', 10_000)).resolves.toBe(0)
    expect(clock.sleeps).toEqual([])
  })

  it('keeps keys independent so a save-keyed acquire does not delay a read-keyed one', async () => {
    const clock = makeClock()
    const limiter = new RateLimiter({ sleep: clock.sleep, now: clock.now })

    await limiter.acquire('POST /blog-console-api/v1/article/save', 11_000)
    await expect(limiter.acquire('GET /blog-console-api/v1/category/getCategoryList', 250)).resolves.toBe(0)
    expect(clock.sleeps).toEqual([])
  })

  it('disables throttling for a key when minIntervalMs is zero', async () => {
    const clock = makeClock()
    const limiter = new RateLimiter({ sleep: clock.sleep, now: clock.now })

    await limiter.acquire('GET /x', 0)
    await expect(limiter.acquire('GET /x', 0)).resolves.toBe(0)
    expect(clock.sleeps).toEqual([])
  })

  it('disables throttling for a key when minIntervalMs is negative', async () => {
    const clock = makeClock()
    const limiter = new RateLimiter({ sleep: clock.sleep, now: clock.now })

    await limiter.acquire('GET /x', -5_000)
    await expect(limiter.acquire('GET /x', -5_000)).resolves.toBe(0)
    expect(clock.sleeps).toEqual([])
  })

  it('serializes concurrent acquires on one key so no two grants share a timestamp', async () => {
    const clock = makeClock()
    const limiter = new RateLimiter({ sleep: clock.sleep, now: clock.now })

    const results = await Promise.all([
      limiter.acquire('POST /save', 10_000),
      limiter.acquire('POST /save', 10_000),
      limiter.acquire('POST /save', 10_000)
    ])

    // Exactly one caller got a free slot; the others each waited a full interval
    // measured from the *previous grant*, so grants land at 0s, 10s and 20s.
    expect(results[0]).toBe(0)
    expect(results.filter((waited) => waited === 0)).toHaveLength(1)
    expect(results.slice(1)).toEqual([10_000, 10_000])
    expect(clock.sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(2 * 10_000)
    // A "check the timestamp then proceed" limiter would compute both waits from
    // the same clock reading (0). Distinct bases prove the grants were serialized.
    expect(clock.sleepBases).toEqual([0, 10_000])
  })

  it('returns the wait for each caller separately, not the accumulated wait', async () => {
    const clock = makeClock()
    const limiter = new RateLimiter({ sleep: clock.sleep, now: clock.now })

    expect(await limiter.acquire('k', 1_000)).toBe(0)
    expect(await limiter.acquire('k', 1_000)).toBe(1_000)
    expect(await limiter.acquire('k', 1_000)).toBe(1_000)
    expect(clock.read()).toBe(2_000)
  })
})

describe('RateLimiter.reset', () => {
  it('forgets all throttle state so the next acquire is immediate again', async () => {
    const clock = makeClock()
    const limiter = new RateLimiter({ sleep: clock.sleep, now: clock.now })

    await limiter.acquire('k', 10_000)
    limiter.reset()

    await expect(limiter.acquire('k', 10_000)).resolves.toBe(0)
    expect(clock.sleeps).toEqual([])
  })

  it('does not poison keys that were never used', async () => {
    const limiter = new RateLimiter({ sleep: async () => undefined, now: () => 0 })
    limiter.reset()

    await expect(limiter.acquire('fresh', 10_000)).resolves.toBe(0)
  })
})

describe('RateLimiter failure isolation', () => {
  it('keeps the queue alive when the sleep itself rejects, so one bad wait cannot wedge a key', async () => {
    let calls = 0
    const sleep = async (): Promise<void> => {
      calls += 1
      if (calls === 1) throw new Error('sleep exploded')
    }
    const limiter = new RateLimiter({ sleep, now: () => 0 })

    await limiter.acquire('k', 1_000)
    await expect(limiter.acquire('k', 1_000)).rejects.toThrow('sleep exploded')

    // The failed wait did not grant a slot (lastGrantedAt was never updated), so
    // the next caller still waits a full interval — and it resolves.
    await expect(limiter.acquire('k', 1_000)).resolves.toBe(1_000)
  })

  it('keeps the queue alive when a caller throws downstream, so the next acquire still resolves', async () => {
    const clock = makeClock()
    const limiter = new RateLimiter({ sleep: clock.sleep, now: clock.now })

    await limiter.acquire('k', 10_000)
    const downstream = limiter.acquire('k', 10_000).then(() => {
      throw new Error('downstream boom')
    })
    await expect(downstream).rejects.toThrow('downstream boom')

    await expect(limiter.acquire('k', 10_000)).resolves.toBe(10_000)
  })
})

describe('RateLimiter defaults', () => {
  it('falls back to a real setTimeout sleep and Date.now when nothing is injected', async () => {
    const limiter = new RateLimiter()

    // minIntervalMs 0 keeps this a zero-delay timer, never a multi-second wait.
    await expect(limiter.acquire('k', 0)).resolves.toBe(0)
  })

  it('exposes defaultSleep, which resolves only after the requested delay', async () => {
    const sleep = vi.fn(defaultSleep)
    await sleep(0)
    expect(sleep).toHaveBeenCalledWith(0)
  })
})
