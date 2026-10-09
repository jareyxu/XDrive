import type { CodeHighlight } from './text-preview'

/** Consume only highlight.js-generated spans. User text becomes React text nodes, never innerHTML. */
export function parseHighlightRanges(source: string, html: string): CodeHighlight {
  if (html.length > 32 * 1024 * 1024) throw new RangeError('highlight output budget')
  const ranges: number[] = [], classes: string[] = [], stack: string[] = []
  const classIds = new Map<string, number>()
  let cursor = 0, offset = 0
  const text = (encoded: string) => {
    const decoded = encoded.replace(/&(amp|lt|gt|quot|#x27);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'" })[entity]!)
    if (source.slice(offset, offset + decoded.length) !== decoded) throw new TypeError('highlight text mismatch')
    if (decoded.length && stack.length) {
      const name = stack.join(' ')
      let id = classIds.get(name)
      if (id === undefined) { id = classes.length; classes.push(name); classIds.set(name, id) }
      if (ranges.length / 3 >= 250_000) throw new RangeError('highlight token budget')
      ranges.push(offset, offset + decoded.length, id)
    }
    offset += decoded.length
  }
  const tags = /<span class="([\w -]+)">|<\/span>/g
  for (const match of html.matchAll(tags)) {
    text(html.slice(cursor, match.index))
    if (match[1]) stack.push(match[1]); else if (!stack.pop()) throw new TypeError('unbalanced highlight')
    cursor = match.index! + match[0].length
  }
  text(html.slice(cursor))
  if (stack.length || offset !== source.length) throw new TypeError('invalid highlight output')
  return { ranges: new Uint32Array(ranges), classes }
}
