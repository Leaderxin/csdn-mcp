/**
 * `src/csdn/types.ts` unit tests.
 *
 * The state table is the single place where a CSDN status number becomes a
 * word an agent can reason about, so both the table and the fallback path are
 * pinned here: an unrecognised code must come back as `'unknown'` and never as
 * `'published'`.
 */

import { describe, expect, it } from 'vitest'

import { ARTICLE_STATE_BY_CODE, articleStateFromCode, articleUrl } from '../../../src/csdn/types.js'

describe('ARTICLE_STATE_BY_CODE', () => {
  it('holds exactly the codes observed on getArticle', () => {
    expect(ARTICLE_STATE_BY_CODE).toEqual({
      0: 'published',
      1: 'published',
      2: 'draft',
      6: 'rejected',
      16: 'reviewing'
    })
  })

  it('maps 0 to published, which is why saveArticle must never send it', () => {
    expect(ARTICLE_STATE_BY_CODE[0]).toBe('published')
  })
})

describe('articleStateFromCode', () => {
  it('maps every known status code to its state', () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [0, 'published'],
      [1, 'published'],
      [2, 'draft'],
      [6, 'rejected'],
      [16, 'reviewing']
    ]
    for (const [code, state] of cases) {
      expect(articleStateFromCode(code)).toBe(state)
    }
  })

  it('parses a numeric string because some console responses quote the code', () => {
    expect(articleStateFromCode('2')).toBe('draft')
    expect(articleStateFromCode('16')).toBe('reviewing')
  })

  it('maps a non-numeric string to unknown instead of guessing', () => {
    expect(articleStateFromCode('审核中')).toBe('unknown')
  })

  it('maps undefined to unknown because a missing status is not a draft or a publish', () => {
    expect(articleStateFromCode(undefined)).toBe('unknown')
  })

  it('maps NaN to unknown', () => {
    expect(articleStateFromCode(Number.NaN)).toBe('unknown')
  })

  it('maps a code CSDN has not published yet to unknown', () => {
    expect(articleStateFromCode(99)).toBe('unknown')
  })
})

describe('articleUrl', () => {
  it('builds the public article URL from the account name and the id', () => {
    expect(articleUrl('alice', '1042')).toBe('https://blog.csdn.net/alice/article/details/1042')
  })

  it('honours a custom base so a self-hosted or mirrored origin can be used', () => {
    expect(articleUrl('alice', '1042', 'https://mirror.example')).toBe(
      'https://mirror.example/alice/article/details/1042'
    )
  })
})
