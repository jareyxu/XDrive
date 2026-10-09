import { test as base, type BrowserContext } from '@playwright/test'
export * from '@playwright/test'
// Existing operation regressions exercise the explicit list preference. Dedicated
// grid tests import Playwright directly and verify the real default grid path.
export async function selectListPreference(context: BrowserContext) {
  await context.addInitScript(() => {
    try {
      const key = 'xdrive.preferences.v1'
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}')
      localStorage.setItem(key, JSON.stringify({ ...stored, view: 'list' }))
    } catch { /* Storage-unavailable tests exercise the production fallback. */ }
  })
}
export const test = base.extend({
  context: async ({ context }, runFixture) => {
    await selectListPreference(context)
    await runFixture(context)
  },
})
