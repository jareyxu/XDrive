export const TRAVERSAL_MUTATION_MAX_ATTEMPTS = 4

export class ConcurrentMutationRetryExhaustedError extends Error {
  readonly code = 'concurrent_mutation_retry_exhausted'
  constructor(cause: unknown) {
    super('检测到其他标签页或设备正在持续修改云盘，请等待上传 / 移动等操作完成后重试。', { cause })
    this.name = 'ConcurrentMutationRetryExhaustedError'
  }
}

/** Each invocation must discard the previous snapshot and staged membership. */
export async function retryTraversalMutation<T>(
  rebuild: () => Promise<T>,
  isConflict: (error: unknown) => boolean,
  signal?: AbortSignal,
  random: () => number = Math.random,
): Promise<T> {
  for (let attempt = 0; attempt < TRAVERSAL_MUTATION_MAX_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted()
    try { return await rebuild() }
    catch (error) {
      signal?.throwIfAborted()
      if (!isConflict(error)) throw error
      if (attempt === TRAVERSAL_MUTATION_MAX_ATTEMPTS - 1) throw new ConcurrentMutationRetryExhaustedError(error)
      const sample = random()
      if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new TypeError('invalid jitter sample')
      await waitForRetry(sample * 500 * 2 ** attempt, signal)
    }
  }
  throw new Error('unreachable traversal attempt')
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
