import type { Browser, CDPSession } from '@playwright/test'

export interface WorkerHeapSample {
  usedSize: number
  totalSize: number
  embedderHeapUsedSize: number
  backingStorageSize: number
}

/** Explicit opt-in Chromium measurement. Never change production worker code. */
export async function createWorkerHeapProbe(browser: Browser, workerURL: string) {
  const protocol = await browser.newBrowserCDPSession()
  const { targetInfos } = await protocol.send('Target.getTargets')
  const targets = targetInfos.filter(target => target.type === 'worker' && target.url === workerURL)
  if (targets.length !== 1) { await protocol.detach(); throw new Error('Expected exactly one owned PDF worker target') }
  let sessionId: string
  try { sessionId = (await protocol.send('Target.attachToTarget', { targetId: targets[0].targetId, flatten: false })).sessionId }
  catch (error) { await protocol.detach(); throw error }
  let sequence = 0
  let closed = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timeout: ReturnType<typeof setTimeout> }>()
  const received = (event: { sessionId: string; message: string }) => {
    if (event.sessionId !== sessionId) return
    const message = JSON.parse(event.message)
    const waiting = pending.get(message.id)
    if (!waiting) return
    clearTimeout(waiting.timeout); pending.delete(message.id)
    if (message.error) waiting.reject(new Error(message.error.message))
    else waiting.resolve(message.result)
  }
  protocol.on('Target.receivedMessageFromTarget', received)
  const send = (method: string) => {
    if (closed) return Promise.reject(new Error('Worker heap probe closed'))
    const id = ++sequence
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Worker measurement timed out: ${method}`)) }, 5000)
      pending.set(id, { resolve, reject, timeout })
      void protocol.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) }).catch(error => {
        clearTimeout(timeout); pending.delete(id); reject(error)
      })
    })
  }
  return {
    async sample(collectGarbage = false): Promise<WorkerHeapSample> {
      // Collect only when explicitly requested; natural samples are separate.
      if (collectGarbage) await send('HeapProfiler.collectGarbage')
      const result = await send('Runtime.getHeapUsage') as WorkerHeapSample
      for (const key of ['usedSize', 'totalSize', 'embedderHeapUsedSize', 'backingStorageSize'] as const) {
        if (!Number.isFinite(result[key]) || result[key] < 0) throw new Error(`Missing Worker memory counter: ${key}`)
      }
      return result
    },
    async close() {
      if (closed) return
      closed = true
      protocol.off('Target.receivedMessageFromTarget', received)
      for (const waiting of pending.values()) { clearTimeout(waiting.timeout); waiting.reject(new Error('Worker heap probe closed')) }
      pending.clear()
      try { await protocol.send('Target.detachFromTarget', { sessionId }) }
      finally { await (protocol as CDPSession).detach() }
    },
  }
}
