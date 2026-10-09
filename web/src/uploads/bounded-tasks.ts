/** Starts only a bounded number of whole read/encrypt/write-ahead/PUT tasks.
 * On the first failure stop admission, abort siblings and await their cleanup. */
export async function runBoundedTasks(count: number, concurrency: number, task: (index: number, signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(count) || count < 0 || count > 4096 || !Number.isInteger(concurrency) || concurrency < 2 || concurrency > 4) throw new RangeError('invalid bounded upload schedule')
  const controller = new AbortController()
  const operation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let cursor = 0
  let failed = false
  let failure: unknown
  const worker = async () => {
    while (!failed && cursor < count) {
      try {
        operation.throwIfAborted()
        const index = cursor++
        await task(index, operation)
      } catch (error) {
        if (!failed) { failed = true; failure = error; controller.abort(error) }
      }
    }
  }
  operation.throwIfAborted()
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, worker))
  if (failed) throw failure
  operation.throwIfAborted()
}

/** Serializes encrypted recovery snapshots; a failed persistence stops the queue. */
export function createWriteAheadQueue(): <T>(write: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve()
  let failed = false
  let failure: unknown
  return <T>(write: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => { if (failed) throw failure; return write() })
    tail = result.then(() => undefined, error => { failed = true; failure = error })
    return result
  }
}
