import type { Page } from '@playwright/test'

// Match the production control handshake before testing virtual-route security.
// A visible registration alone cannot prove that fetch is intercepted by SW.
export async function ensureRelayControl(page: Page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/media-sw.js', { scope: '/', updateViaCache: 'none' })
    await navigator.serviceWorker.ready
    if (navigator.serviceWorker.controller) return
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => finish(new Error('SW did not claim page')), 10000)
      const change = () => { if (navigator.serviceWorker.controller) finish() }
      const finish = (error?: unknown) => {
        window.clearTimeout(timeout)
        navigator.serviceWorker.removeEventListener('controllerchange', change)
        if (error) reject(error)
        else resolve()
      }
      navigator.serviceWorker.addEventListener('controllerchange', change)
      change()
      if (!navigator.serviceWorker.controller) {
        try { registration.active?.postMessage({ type: 'xdrive-relay-claim' }) }
        catch (error) { finish(error) }
      }
    })
  })
}
