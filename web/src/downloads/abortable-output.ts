/** Stops the producer immediately even if an OS/browser sink has a pending write.
 * Bytes already handed to that sink cannot be revoked; its abort finishes when
 * the underlying write settles. No subsequent writes are allowed after abort.
 */
export function openAbortableOutput(destination: WritableStream<Uint8Array>, signal?: AbortSignal) {
  const writer = destination.getWriter()
  let controller: WritableStreamDefaultController
  let failed = false
  let abortStarted = false
  let disposed = false
  const abort = (reason: unknown) => {
    if (!failed) { failed = true; controller.error(reason) }
    if (!abortStarted) {
      abortStarted = true
      void writer.abort(reason).catch(() => undefined)
    }
  }
  const onAbort = () => abort(signal?.reason)
  const wait = <T>(pending: Promise<T>): Promise<T> => {
    if (!signal) return pending
    return new Promise((resolve, reject) => {
      const rejectAbort = () => { signal.removeEventListener('abort', rejectAbort); reject(signal.reason) }
      signal.addEventListener('abort', rejectAbort, { once: true })
      if (signal.aborted) rejectAbort()
      void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', rejectAbort))
    })
  }
  const stream = new WritableStream<Uint8Array>({
    start(value) { controller = value },
    write(bytes) { signal?.throwIfAborted(); return wait(writer.write(bytes)) },
    close() { signal?.throwIfAborted(); return wait(writer.close()) },
    abort,
  })
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  return {
    stream,
    abort,
    dispose() {
      if (disposed) return
      disposed = true
      signal?.removeEventListener('abort', onAbort)
      writer.releaseLock()
    },
  }
}
