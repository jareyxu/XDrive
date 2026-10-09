import { describe, expect, it } from 'vitest'
import hljs from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import python from 'highlight.js/lib/languages/python'
import { codeLanguage, codeLineRuns, indexCodeLines, textPreviewKind } from './text-preview'
import { parseHighlightRanges } from './highlight-ranges'

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('python', python)
describe('text preview classification and bounded line rendering', () => {
  it('classifies known source languages by extension, basename or normalized MIME without treating every file as text', () => {
    expect(textPreviewKind('main.TSX', 'application/octet-stream')).toBe('code')
    expect(codeLanguage('Dockerfile')).toBe('dockerfile')
    expect(codeLanguage('query', 'application/json; charset=utf-8')).toBe('json')
    expect(textPreviewKind('notes', 'text/markdown')).toBe('markdown')
    expect(textPreviewKind('notes.txt', 'application/octet-stream')).toBe('text')
    expect(textPreviewKind('book.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBeNull()
    expect(codeLanguage('constructor', 'application/octet-stream')).toBeNull()
    expect(codeLanguage('file.__proto__', '__proto__')).toBeNull()
  })
  it('finds arbitrary lines through sparse checkpoints, including empty lines, CRLF and a final newline', () => {
    const lines = Array.from({ length: 1030 }, (_, i) => i % 3 ? `line ${i} 中文` : '')
    const source = lines.join('\r\n')
    const indexed = indexCodeLines(source)
    expect(indexed.count).toBe(lines.length)
    for (let i = 0; i < lines.length; i++) { const { start, end } = indexed.line(i); expect(source.slice(start, end)).toBe(lines[i]) }
    expect(indexCodeLines('').count).toBe(1)
    const newlineOnly = indexCodeLines('\n'.repeat(1_000_000))
    expect(newlineOnly.count).toBe(1_000_001)
    expect(newlineOnly.line(1_000_000)).toEqual({ start: 1_000_000, end: 1_000_000 })
    expect(() => indexed.line(-1)).toThrow()
    expect(() => indexed.line(lines.length)).toThrow()
  })
  it.each([
    ['typescript', 'const x: string = "<script>& 🦊";\r\n/* comment\nnext line */\nexport { x };'],
    ['xml', '<img src="https://tracker.test/pixel" onerror="alert(1)">\n<script>alert("XSS")</script>'],
    ['python', 'def hello():\n    """multi\nline"""\n    return \'a&b\''],
  ])('preserves every source character and multiline token through %s highlighting without accepting HTML', (language, source) => {
    const highlighted = parseHighlightRanges(source, hljs.highlight(source, { language, ignoreIllegals: true }).value)
    expect(highlighted.ranges.length).toBeGreaterThan(0)
    const index = indexCodeLines(source)
    for (let i = 0; i < index.count; i++) {
      const { start, end } = index.line(i)
      expect(codeLineRuns(source, start, end, highlighted).map(run => run.text).join('')).toBe(source.slice(start, end))
    }
  })
  it('fails closed on unknown markup, altered source, unbalanced spans and excessive output', () => {
    expect(() => parseHighlightRanges('x', '<img src=x>')).toThrow()
    expect(() => parseHighlightRanges('x', '<span class="hljs-keyword">y</span>')).toThrow()
    expect(() => parseHighlightRanges('x', '<span class="hljs-keyword">x')).toThrow()
    expect(() => parseHighlightRanges('x', '</span>x')).toThrow()
    expect(() => parseHighlightRanges('', ' '.repeat(32 * 1024 * 1024 + 1))).toThrow(RangeError)
  })
})
