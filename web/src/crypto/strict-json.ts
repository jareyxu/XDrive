/** Parse JSON while rejecting duplicate object members before JSON.parse loses them. */
export function parseStrictJson(text: string, maxDepth = 128): unknown {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new RangeError('Invalid JSON depth limit')
  let offset = 0

  const whitespace = () => {
    while (offset < text.length && (text[offset] === ' ' || text[offset] === '\n' || text[offset] === '\r' || text[offset] === '\t')) offset += 1
  }

  const stringToken = (): string => {
    const start = offset
    if (text[offset] !== '"') throw new SyntaxError('Expected JSON string')
    offset += 1
    while (offset < text.length) {
      const char = text[offset++]!
      if (char === '"') return text.slice(start, offset)
      if (char === '\\') {
        if (offset >= text.length) throw new SyntaxError('Incomplete JSON escape')
        if (text[offset] === 'u') offset += 5
        else offset += 1
      }
    }
    throw new SyntaxError('Unterminated JSON string')
  }

  const value = (depth: number): void => {
    if (depth > maxDepth) throw new SyntaxError('JSON nesting limit exceeded')
    whitespace()
    const char = text[offset]
    if (char === '"') {
      stringToken()
      return
    }
    if (char === '{') {
      offset += 1
      whitespace()
      const keys = new Set<string>()
      if (text[offset] === '}') { offset += 1; return }
      while (offset < text.length) {
        whitespace()
        const keyToken = stringToken()
        const key = JSON.parse(keyToken) as unknown
        if (typeof key !== 'string' || keys.has(key)) throw new SyntaxError('Duplicate JSON object member')
        keys.add(key)
        whitespace()
        if (text[offset++] !== ':') throw new SyntaxError('Expected JSON object member colon')
        value(depth + 1)
        whitespace()
        const separator = text[offset++]
        if (separator === '}') return
        if (separator !== ',') throw new SyntaxError('Expected JSON object separator')
      }
      throw new SyntaxError('Unterminated JSON object')
    }
    if (char === '[') {
      offset += 1
      whitespace()
      if (text[offset] === ']') { offset += 1; return }
      while (offset < text.length) {
        value(depth + 1)
        whitespace()
        const separator = text[offset++]
        if (separator === ']') return
        if (separator !== ',') throw new SyntaxError('Expected JSON array separator')
      }
      throw new SyntaxError('Unterminated JSON array')
    }

    const start = offset
    while (offset < text.length && !/[\s,\]}]/u.test(text[offset]!)) offset += 1
    if (start === offset) throw new SyntaxError('Expected JSON value')
    const token = text.slice(start, offset)
    if (token !== 'true' && token !== 'false' && token !== 'null' && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(token)) {
      throw new SyntaxError('Invalid JSON token')
    }
  }

  value(0)
  whitespace()
  if (offset !== text.length) throw new SyntaxError('Trailing data after JSON value')
  return JSON.parse(text) as unknown
}
