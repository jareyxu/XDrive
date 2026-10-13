// Monotonic wire-byte counters only. No names, keys or persistent state.
const bytes = { upload: 0, download: 0 }
export function recordNetworkBytes(direction: keyof typeof bytes, count: number): void {
  if (Number.isSafeInteger(count) && count > 0) bytes[direction] += count
}
export function networkBytes(): Readonly<typeof bytes> { return { ...bytes } }
