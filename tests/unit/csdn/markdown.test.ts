/**
 * `src/csdn/markdown.ts`
 *
 * Every test here pins a behaviour that CSDN's fields forced on us: `content`
 * must be HTML, `Description` must stay inside 256 characters without an
 * ellipsis, and placeholders must be resolved *before* anything is uploaded.
 */

import { describe, expect, it } from 'vitest'
import { CsdnError } from '../../../src/core/errors.js'
import {
  deriveDescription,
  findImagePlaceholders,
  parseFrontMatter,
  renderMarkdown,
  stripMarkdown,
  substituteImagePlaceholders
} from '../../../src/csdn/markdown.js'

/** Run `fn`, returning the CsdnError it threw (so tests can assert on `code`). */
function captureCsdnError(fn: () => unknown): CsdnError {
  try {
    fn()
  } catch (error) {
    if (error instanceof CsdnError) return error
    throw error
  }
  throw new Error('expected a CsdnError, but nothing was thrown')
}

describe('renderMarkdown', () => {
  it('renders a GFM table to a real <table> element because saveArticle.content must be HTML, not Markdown', () => {
    const html = renderMarkdown('| 名称 | 值 |\n| --- | --- |\n| a | 1 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>名称</th>')
    expect(html).toContain('<td>1</td>')
  })

  it('renders headings, emphasis and strikethrough instead of leaving the markers visible', () => {
    const html = renderMarkdown('## 标题\n\n**粗体** ~~删除~~')
    expect(html).toContain('<h2>标题</h2>')
    expect(html).toContain('<strong>粗体</strong>')
    expect(html).toContain('<del>删除</del>')
    expect(html).not.toContain('##')
  })

  it('renders task lists (gfm: true) because CSDN authors paste them from GitHub', () => {
    const html = renderMarkdown('- [x] done\n- [ ] todo')
    expect(html).toContain('type="checkbox"')
  })

  it('returns a plain string, not a Promise, because callers build the body synchronously', () => {
    const html = renderMarkdown('plain')
    expect(typeof html).toBe('string')
    expect(html).toContain('<p>plain</p>')
  })
})

describe('stripMarkdown', () => {
  it('drops fenced code blocks together with their content so a snippet never leaks into a摘要', () => {
    const markdown = '前文\n\n```js\nconst a = 1; // ## not a heading\n```\n\n后文'
    expect(stripMarkdown(markdown)).toBe('前文 后文')
  })

  it('drops an unterminated fence to the end of the document, as CSDN renders it', () => {
    expect(stripMarkdown('正文\n```\ncode here')).toBe('正文')
  })

  it('unwraps inline code but keeps its visible text, the way a link keeps its label', () => {
    const text = stripMarkdown('运行 `npm run build` 之后')
    expect(text).toBe('运行 npm run build 之后')
    expect(text).not.toContain('`')
  })

  it('never emits a # or a * marker, because a description with ## in it reads as a bug', () => {
    const markdown = [
      '# 标题',
      '',
      '> 引用 **重点**',
      '',
      '- 列表 *项*',
      '',
      '---',
      '',
      '普通段落'
    ].join('\n')
    const text = stripMarkdown(markdown)
    expect(text).toBe('标题 引用 重点 列表 项 普通段落')
    expect(text).not.toContain('#')
    expect(text).not.toContain('*')
  })

  it('keeps the visible text of a link and drops its target', () => {
    expect(stripMarkdown('见 [文档](https://example.com/a_b) 说明')).toBe('见 文档 说明')
  })

  it('drops images including their alt text, because the URL is meaningless in a摘要', () => {
    expect(stripMarkdown('前 ![封面图](https://img/x.png) 后')).toBe('前 后')
    expect(stripMarkdown('前 ![alt][ref] 后')).toBe('前 后')
  })

  it('strips raw HTML tags and collapses whitespace runs to single spaces', () => {
    expect(stripMarkdown('<div class="a">你好</div>\n\n\n  世界  ')).toBe('你好 世界')
  })
})

describe('deriveDescription', () => {
  it('returns a stable non-empty fallback for an empty body, because CSDN rejects an empty Description', () => {
    const fallback = deriveDescription('   \n\n')
    expect(fallback).toBe(deriveDescription(''))
    expect(fallback.length).toBeGreaterThan(0)
  })

  it('drops a body that is nothing but a code block, since there is no prose to summarise', () => {
    expect(deriveDescription('```sh\nls -la\n```')).toBe(deriveDescription(''))
  })

  it.each([
    [255, 255],
    [256, 256],
    [257, 256]
  ])('returns %i source characters as %i characters, exactly, with no ellipsis added', (sourceLength, expected) => {
    const source = 'a'.repeat(sourceLength)
    const description = deriveDescription(source)
    expect(description).toBe('a'.repeat(expected))
    expect(description.length).toBe(expected)
  })

  it('honours a shorter custom limit, because the field length is a parameter, not a constant', () => {
    expect(deriveDescription('# 标题\n\n后续内容', 2)).toBe('标题')
  })
})

describe('parseFrontMatter', () => {
  it('parses a plain block and returns the body without the delimiters', () => {
    const { attributes, body } = parseFrontMatter('---\ntitle: 我的文章\ntags: a,b\n---\n正文')
    expect(attributes).toEqual({ title: '我的文章', tags: 'a,b' })
    expect(body).toBe('正文')
  })

  it('parses CRLF blocks, because Windows editors write \\r\\n and the attributes still have to be found', () => {
    const { attributes, body } = parseFrontMatter('---\r\ntitle: "Hello"\r\ntags: a,b\r\n---\r\nBody\r\n')
    expect(attributes).toEqual({ title: 'Hello', tags: 'a,b' })
    expect(body).toBe('Body\r\n')
  })

  it('strips one layer of surrounding single or double quotes, and leaves unbalanced quotes alone', () => {
    const { attributes } = parseFrontMatter(
      "---\ndouble: \"a b\"\nsingle: 'c d'\nunbalanced: \"half\nvalue: it's fine\n---\nbody"
    )
    expect(attributes).toEqual({
      double: 'a b',
      single: 'c d',
      unbalanced: '"half',
      value: "it's fine"
    })
  })

  it('does not let a value containing dashes end the block early, because that would delete the body', () => {
    const { attributes, body } = parseFrontMatter('---\ntitle: a---b\n---\n真实正文')
    expect(attributes).toEqual({ title: 'a---b' })
    expect(body).toBe('真实正文')
  })

  it('skips blank lines, comments and non key: value lines instead of failing the publish', () => {
    const { attributes } = parseFrontMatter('---\n\n# 注释\nnotakeyvalue\ntitle: x\n---\n正文')
    expect(attributes).toEqual({ title: 'x' })
  })

  it('treats an unterminated block as no front matter and returns the input untouched', () => {
    const raw = '---\ntitle: x\n\n正文\n'
    const { attributes, body } = parseFrontMatter(raw)
    expect(attributes).toEqual({})
    expect(body).toBe(raw)
  })

  it('returns an empty attribute map and the original text when there is no block at all', () => {
    const raw = '# 标题\n\n正文'
    const { attributes, body } = parseFrontMatter(raw)
    expect(attributes).toEqual({})
    expect(body).toBe(raw)
  })
})

describe('findImagePlaceholders', () => {
  it('returns placeholders in order of first appearance and de-duplicates them, so each image uploads once', () => {
    const markdown = '![c](IMG_COVER_1)\n\n![b](IMG_body2)\n\n![c again](IMG_COVER_1)\n\n![d](IMG_3)'
    expect(findImagePlaceholders(markdown)).toEqual(['IMG_COVER_1', 'IMG_body2', 'IMG_3'])
  })

  it('ignores tokens that only look like placeholders (IMG_ with nothing after it)', () => {
    expect(findImagePlaceholders('IMG_ and IMG- and IMG_ok')).toEqual(['IMG_ok'])
  })
})

describe('substituteImagePlaceholders', () => {
  it('replaces every occurrence of a placeholder, because one image can legitimately be used twice', () => {
    const markdown = '![c](IMG_COVER)\n\n![c2](IMG_COVER)\n\n![b](IMG_BODY)'
    expect(
      substituteImagePlaceholders(markdown, {
        IMG_COVER: 'https://img/cover.png',
        IMG_BODY: 'https://img/body.png'
      })
    ).toBe('![c](https://img/cover.png)\n\n![c2](https://img/cover.png)\n\n![b](https://img/body.png)')
  })

  it('leaves text without placeholders untouched', () => {
    expect(substituteImagePlaceholders('没有占位符', {})).toBe('没有占位符')
  })

  it('throws INVALID_ARGUMENT naming every unmapped placeholder before any upload happens', () => {
    const error = captureCsdnError(() =>
      substituteImagePlaceholders('![a](IMG_A) ![b](IMG_B) ![c](IMG_C)', { IMG_B: 'https://img/b.png' })
    )
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(error.message).toContain('IMG_A')
    expect(error.message).toContain('IMG_C')
    expect(error.message).not.toContain('IMG_B')
  })
})
