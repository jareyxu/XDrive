export async function controlledRelayWorker(signal?: AbortSignal): Promise<ServiceWorker> {
  if (!('serviceWorker' in navigator)) throw new TypeError('当前浏览器不支持流式转发。')
  signal?.throwIfAborted()
  const registration = await waitForRelay(navigator.serviceWorker.register('/media-sw.js', { scope: '/', updateViaCache: 'none' }), signal)
  // ready/controller can still refer to the previous release during an update.
  // Registering a session there and fetching through the replacement worker
  // loses that session, so wait for the installing worker before admission.
  const updating = registration.installing ?? registration.waiting
  if (updating) await waitForActivation(updating, signal)
  await waitForRelay(navigator.serviceWorker.ready, signal)
  signal?.throwIfAborted()
  const controlled = () => Boolean(registration.active && navigator.serviceWorker.controller === registration.active)
  if (controlled()) return navigator.serviceWorker.controller!
  return new Promise<ServiceWorker>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new TypeError('流式服务未能接管当前页面。')), 10000)
    const onChange = () => { if (controlled()) finish(undefined, navigator.serviceWorker.controller!) }
    const onAbort = () => finish(signal?.reason)
    const finish = (error?: Error, worker?: ServiceWorker) => {
      window.clearTimeout(timeout)
      navigator.serviceWorker.removeEventListener('controllerchange', onChange)
      signal?.removeEventListener('abort', onAbort)
      if (worker) resolve(worker)
      else reject(error)
    }
    navigator.serviceWorker.addEventListener('controllerchange', onChange)
    signal?.addEventListener('abort', onAbort, { once: true })
    onChange()
    if (signal?.aborted) onAbort()
    else if (!controlled()) {
      try { registration.active?.postMessage({ type: 'xdrive-relay-claim' }) }
      catch (cause) { finish(cause instanceof Error ? cause : new TypeError('流式服务无法接管当前页面。')) }
    }
  })
}

function waitForActivation(worker: ServiceWorker, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { window.clearTimeout(timer); worker.removeEventListener('statechange', changed); signal?.removeEventListener('abort', aborted) }
    const finish = (error?: unknown) => { cleanup(); if (error) reject(error); else resolve() }
    const changed = () => {
      if (worker.state === 'activated') finish()
      else if (worker.state === 'redundant') finish(new TypeError('流式服务更新失败，请刷新页面后重试。'))
    }
    const aborted = () => finish(signal?.reason ?? new DOMException('Cancelled', 'AbortError'))
    const timer = window.setTimeout(() => finish(new TypeError('流式服务更新超时，请重试。')), 10000)
    worker.addEventListener('statechange', changed)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) aborted(); else changed()
  })
}

function waitForRelay<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new TypeError('流式服务启动超时。')) }, 10000)
    const abort = () => { cleanup(); reject(signal?.reason) }
    const cleanup = () => { window.clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    void pending.then((value) => { cleanup(); resolve(value) }, (error) => { cleanup(); reject(error) })
  })
}
