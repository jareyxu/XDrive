export type TextPreviewKind = 'text' | 'markdown' | 'code'
const extensions: Readonly<Record<string, string>> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', css: 'css', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', go: 'go', py: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', java: 'java', rs: 'rust',
  rb: 'ruby', php: 'php', sql: 'sql', swift: 'swift', kt: 'kotlin', kts: 'kotlin', graphql: 'graphql', gql: 'graphql',
}
const mimes: Readonly<Record<string, string>> = {
  'application/json': 'json', 'application/ld+json': 'json', 'application/javascript': 'javascript', 'text/javascript': 'javascript',
  'application/xml': 'xml', 'text/xml': 'xml', 'text/html': 'xml', 'text/css': 'css', 'application/x-sh': 'bash',
}
export function codeLanguage(name: string, mime = ''): string | null {
  const basename = name.toLowerCase()
  if (basename === 'dockerfile') return 'dockerfile'
  if (basename === 'makefile') return 'makefile'
  const extension = basename.split('.').at(-1) ?? ''
  const type = mime.toLowerCase().split(';')[0]!.trim()
  return (Object.hasOwn(extensions, extension) ? extensions[extension]! : null) ?? (Object.hasOwn(mimes, type) ? mimes[type]! : null)
}
export function textPreviewKind(name: string, mime: string): TextPreviewKind | null {
  const type = mime.toLowerCase().split(';')[0]!.trim()
  const extension = name.split('.').at(-1)?.toLowerCase()
  if (extension === 'md' || extension === 'markdown' || type === 'text/markdown') return 'markdown'
  if (codeLanguage(name, type)) return 'code'
  return type.startsWith('text/') || extension === 'txt' ? 'text' : null
}

/** Sparse checkpoints keep even newline-only 20 MiB files from allocating millions of line descriptors. */
export function indexCodeLines(source: string) {
  const checkpoints = [0]
  let count = 1, start = 0, maxLength = 0
  for (let next = source.indexOf('\n'); next !== -1; next = source.indexOf('\n', start)) {
    maxLength = Math.max(maxLength, next - start)
    start = next + 1
    if (count++ % 256 === 0) checkpoints.push(start)
  }
  maxLength = Math.max(maxLength, source.length - start)
  const offsets = new Uint32Array(checkpoints)
  return {
    count, maxLength,
    line(index: number): { start: number; end: number } {
      if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError('invalid code line')
      let offset = offsets[Math.floor(index / 256)]!
      for (let current = Math.floor(index / 256) * 256; current < index; current++) offset = source.indexOf('\n', offset) + 1
      let end = source.indexOf('\n', offset)
      if (end === -1) end = source.length
      if (end > offset && source[end - 1] === '\r') end--
      return { start: offset, end }
    },
  }
}

export interface CodeHighlight { ranges: Uint32Array; classes: readonly string[] }
export function codeLineRuns(source: string, start: number, end: number, highlight: CodeHighlight | null) {
  const runs: { text: string; className?: string }[] = []
  if (!highlight) return [{ text: source.slice(start, end) }]
  const { ranges, classes } = highlight
  let low = 0, high = ranges.length / 3
  while (low < high) { const mid = (low + high) >>> 1; if (ranges[mid * 3 + 1]! <= start) low = mid + 1; else high = mid }
  let offset = start
  for (let i = low * 3; i < ranges.length && ranges[i]! < end; i += 3) {
    const from = Math.max(start, ranges[i]!), to = Math.min(end, ranges[i + 1]!)
    if (from > offset) runs.push({ text: source.slice(offset, from) })
    if (to > from) runs.push({ text: source.slice(from, to), className: classes[ranges[i + 2]!] })
    offset = to
  }
  if (offset < end) runs.push({ text: source.slice(offset, end) })
  return runs
}
