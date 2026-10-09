import { readFileSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

const baseURL = process.env.XDRIVE_RESOURCE_BASE_URL
const storageState = process.env.XDRIVE_RESOURCE_STATE_PATH
if (!baseURL || new URL(baseURL).hostname !== 'localhost' || !storageState) {
  throw new TypeError('Set XDRIVE_RESOURCE_BASE_URL to the task-owned HTTPS localhost guest and XDRIVE_RESOURCE_STATE_PATH to its private Playwright state.')
}
const pin = JSON.parse(readFileSync(new URL('../output/systemd-upgrade-2026-10-07/test-certificate.json', import.meta.url), 'utf8')) as { leafSPKIsha256Base64: string }

export default defineConfig({
  testDir: './e2e',
  testMatch: 'resource-vps-1g.pw.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 20 * 60_000,
  use: {
    baseURL,
    storageState,
    browserName: 'chromium',
    headless: true,
    acceptDownloads: true,
    // This isolated local Caddy guest uses a task-local CA; the browser process
    // is separately pinned to the recorded leaf SPKI above.
    ignoreHTTPSErrors: true,
    launchOptions: { args: [`--ignore-certificate-errors-spki-list=${pin.leafSPKIsha256Base64}`] },
    trace: 'retain-on-failure',
  },
})
