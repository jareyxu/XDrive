export class NetworkUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('The network request could not be completed.', { cause })
    this.name = 'NetworkUnavailableError'
  }
}

/** Keeps an idempotent object transfer alive across brief offline periods. */
export async function retryNetworkRequest<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  onWaiting: (waiting: boolean) => void = () => undefined,
): Promise<T> {
  let attempt = 0
  let announcedWaiting = false
  const announce = (waiting: boolean) => {
    if (announcedWaiting === waiting) return
    announcedWaiting = waiting
    onWaiting(waiting)
  }
  try {
    while (true) {
      throwIfAborted(signal)
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        announce(true)
        await waitForNetwork(signal, 1000)
        continue
      }
      try {
        const result = await operation()
        announce(false)
        return result
      } catch (error) {
        if (!(error instanceof NetworkUnavailableError)) throw error
        announce(true)
        const delay = Math.min(5000, 250 * 2 ** Math.min(attempt, 5))
        attempt += 1
        await waitForNetwork(signal, delay)
      }
    }
  } finally {
    announce(false)
  }
}

function waitForNetwork(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      window.removeEventListener('online', online)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    const online = () => finish()
    const abort = () => finish(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    const timer = window.setTimeout(() => finish(), delayMs)
    window.addEventListener('online', online, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}
