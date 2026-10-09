export async function controlledRelayWorker(signal?: AbortSignal): Promise<ServiceWorker> {
  if (!('serviceWorker' in navigator)) throw new TypeError('当前浏览器不支持流式转发。')
  signal?.throwIfAborted()
  const registration = await waitForRelay(navigator.serviceWorker.register('/media-sw.js', { scope: '/', updateViaCache: 'none' }), signal)
  await waitForRelay(navigator.serviceWorker.ready, signal)
  signal?.throwIfAborted()
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller
  return new Promise<ServiceWorker>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new TypeError('流式服务未能接管当前页面。')), 10000)
    const onChange = () => { if (navigator.serviceWorker.controller) finish(undefined, navigator.serviceWorker.controller) }
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
    else if (!navigator.serviceWorker.controller) {
      try { registration.active?.postMessage({ type: 'xdrive-relay-claim' }) }
      catch (cause) { finish(cause instanceof Error ? cause : new TypeError('流式服务无法接管当前页面。')) }
    }
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
