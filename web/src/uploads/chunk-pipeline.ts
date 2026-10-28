import { uploadBuffers, uploadPreparation } from '../transfers/policy'

/** The preparation stage must persist write-ahead state before returning.
 * Only the ciphertext survives into the network stage, and it is erased after
 * success, failure or cancellation, including while waiting for a network slot. */
export async function runUploadChunk<T extends { ciphertext: Uint8Array }>(
  prepare: () => Promise<T>, send: (chunk: T) => Promise<void>, signal: AbortSignal,
): Promise<void> {
  await uploadBuffers.run(async () => {
    let chunk: T | undefined
    try {
      // Acquire manually: if cancellation arrives as prepare resolves, the
      // returned ciphertext must reach this owner before checking the signal.
      const release = await uploadPreparation.acquire(signal)
      try { signal.throwIfAborted(); chunk = await prepare() } finally { release() }
      signal.throwIfAborted()
      await send(chunk)
    } finally { chunk?.ciphertext.fill(0) }
  }, signal)
}
