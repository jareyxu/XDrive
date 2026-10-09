/** Retains only output within the configured payload budget; never used for streaming sinks. */
export function createBoundedBlobOutput(limit: number, mime: string, signal?: AbortSignal) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid memory output budget')
  const parts: Uint8Array<ArrayBuffer>[] = []
  let bytes = 0
  let destroyed = false
  const destroy = () => {
    if (destroyed) return
    destroyed = true
    for (const part of parts) part.fill(0)
    parts.length = 0
    signal?.removeEventListener('abort', destroy)
  }
  signal?.addEventListener('abort', destroy, { once: true })
  if (signal?.aborted) destroy()
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      signal?.throwIfAborted()
      if (destroyed) throw new TypeError('Memory output has been released')
      if (chunk.byteLength > limit - bytes) {
        destroy()
        throw new TypeError(`ZIP 输出超过 ${limit.toLocaleString('zh-CN')} bytes 内存上限，请使用流式下载。`)
      }
      parts.push(chunk.slice())
      bytes += chunk.byteLength
    },
    abort: destroy,
  })
  return {
    stream, destroy,
    blob() {
      signal?.throwIfAborted()
      if (destroyed) throw new TypeError('Memory output has been released')
      // Blob snapshots the typed arrays; callers destroy retained buffers afterward.
      return new Blob(parts, { type: mime })
    },
  }
}
