export function listKeyboardTarget(key: string, index: number, count: number, pageSize: number): number | null {
  if (count === 0) return null
  let target: number
  switch (key) {
    case 'ArrowDown': target = index + 1; break
    case 'ArrowUp': target = index - 1; break
    case 'Home': target = 0; break
    case 'End': target = count - 1; break
    case 'PageDown': target = index + Math.max(1, pageSize); break
    case 'PageUp': target = index - Math.max(1, pageSize); break
    default: return null
  }
  return Math.max(0, Math.min(count - 1, target))
}
