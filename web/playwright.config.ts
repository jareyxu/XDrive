import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

const browserName = process.env.XDRIVE_E2E_BROWSER ?? 'chromium'
if (browserName !== 'chromium' && browserName !== 'webkit' && browserName !== 'firefox') {
  throw new TypeError('XDRIVE_E2E_BROWSER must be chromium, webkit, or firefox')
}
const useHTTPS = browserName !== 'chromium' || process.env.XDRIVE_E2E_HTTPS === '1'
const webPort = Number(process.env.XDRIVE_E2E_WEB_PORT ?? '8787')
const tlsPort = Number(process.env.XDRIVE_E2E_TLS_PORT ?? '8788')
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535 || !Number.isInteger(tlsPort) || tlsPort < 1 || tlsPort > 65535 || webPort === tlsPort) {
  throw new TypeError('XDRIVE_E2E_WEB_PORT and XDRIVE_E2E_TLS_PORT must be distinct TCP ports')
}

const ownsTestRoot = !process.env.XDRIVE_E2E_TEST_ROOT
const testRoot = process.env.XDRIVE_E2E_TEST_ROOT ?? mkdtempSync(join(tmpdir(), 'xdrive-e2e-'))
if (ownsTestRoot) process.env.XDRIVE_E2E_TEST_ROOT = testRoot
const environment = {
  ...process.env,
  XDRIVE_LISTEN_ADDR: `127.0.0.1:${webPort}`,
  XDRIVE_DATABASE_PATH: join(testRoot, 'drive.db'),
  XDRIVE_STORAGE_PATH: join(testRoot, 'objects'),
  XDRIVE_SECRET_PATH: join(testRoot, 'server.secret'),
  XDRIVE_USERNAME: 'admin',
  GOCACHE: join(testRoot, 'go-cache'),
}
if (ownsTestRoot) {
  // The Go service embeds internal/server/static. Build the web app before
  // running any Go command so a clean checkout has the embedded assets.
  execFileSync('./node_modules/.bin/vite', ['build'], { cwd: import.meta.dirname, env: environment, stdio: 'inherit' })
  const initialization = execFileSync('go', ['run', './cmd/xdrive', 'init'], {
    cwd: join(import.meta.dirname, '..'),
    env: environment,
    encoding: 'utf8',
  })
  const token = initialization.match(/\/setup#([A-Za-z0-9_-]+)/u)?.[1]
  if (!token) throw new Error('xdrive init did not return a setup token')
  process.env.XDRIVE_E2E_SETUP_TOKEN = token
  process.env.XDRIVE_E2E_STORAGE_PATH = environment.XDRIVE_STORAGE_PATH
  process.on('exit', () => rmSync(testRoot, { recursive: true, force: true }))
}

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.ts',
  // The 1 GiB VPS resource test targets a separately provisioned Linux guest.
  // Keep it out of local/default runs unless that guest's state file is supplied.
  testIgnore: process.env.XDRIVE_RESOURCE_STATE_PATH ? [] : ['**/resource-vps-1g.pw.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: useHTTPS ? `https://127.0.0.1:${tlsPort}` : `http://127.0.0.1:${webPort}`,
    // Only test contexts accept the ephemeral, self-signed loopback certificate.
    ignoreHTTPSErrors: useHTTPS,
    browserName,
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: [{
    command: 'go run ./cmd/xdrive serve',
    cwd: join(import.meta.dirname, '..'),
    url: `http://127.0.0.1:${webPort}/healthz`,
    env: environment,
    reuseExistingServer: false,
    timeout: 120_000,
  }, ...(useHTTPS ? [{
    command: 'node e2e/tls-proxy.mjs',
    cwd: import.meta.dirname,
    env: { XDRIVE_E2E_TLS_UPSTREAM: `http://127.0.0.1:${webPort}`, XDRIVE_E2E_TLS_PORT: String(tlsPort) },
    url: `https://127.0.0.1:${tlsPort}/healthz`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 30_000,
  }] : [])],
})
