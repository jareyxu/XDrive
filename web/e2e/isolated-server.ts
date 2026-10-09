import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTLSProxy, testUsesHTTPS } from './tls-proxy.mjs'

export async function startIsolatedServer(options: { quotaBytes?: number; maintenanceReserveBytes?: number; textPreviewLimit?: number; videoBlobFallbackLimit?: number; zipMemoryFallbackLimit?: number; backupWarnAfterDays?: number; trashRetention?: string } = {}): Promise<{ baseURL: string; token: string; dataRoot: string; backupTo: (destination: string) => void; restartWithQuota: (quota: number) => Promise<void>; close: () => Promise<void> }> {
  if (options.quotaBytes !== undefined && (!Number.isSafeInteger(options.quotaBytes) || options.quotaBytes < 1)) throw new TypeError('invalid isolated fixture quota')
  const root = mkdtempSync(join(tmpdir(), 'xdrive-isolated-e2e-'))
  const cwd = join(import.meta.dirname, '..', '..')
  let server: ReturnType<typeof spawn> | undefined
  let tlsProxy: Awaited<ReturnType<typeof startTLSProxy>> | undefined
  const close = async () => {
    await tlsProxy?.close()
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      await once(server, 'exit')
    }
    rmSync(root, { recursive: true, force: true })
  }
  try {
    const probe = createServer()
    probe.listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const address = probe.address()
    if (!address || typeof address === 'string') throw new Error('test port unavailable')
    probe.close()
    await once(probe, 'close')
    const env = {
      ...process.env,
      XDRIVE_DATABASE_PATH: join(root, 'drive.db'),
      XDRIVE_STORAGE_PATH: join(root, 'objects'),
      XDRIVE_SECRET_PATH: join(root, 'server.secret'),
      XDRIVE_USERNAME: 'admin',
      ...(options.quotaBytes === undefined ? {} : { XDRIVE_QUOTA_BYTES: String(options.quotaBytes) }),
      ...(options.maintenanceReserveBytes === undefined ? {} : { XDRIVE_MAINTENANCE_RESERVE_BYTES: String(options.maintenanceReserveBytes) }),
      XDRIVE_TEXT_PREVIEW_LIMIT: String(options.textPreviewLimit ?? 20 * 1024 * 1024),
      XDRIVE_BACKUP_WARN_AFTER_DAYS: String(options.backupWarnAfterDays ?? 30),
      XDRIVE_ZIP_MEMORY_FALLBACK_LIMIT: String(options.zipMemoryFallbackLimit ?? 536870912),
      XDRIVE_VIDEO_BLOB_FALLBACK_LIMIT: String(options.videoBlobFallbackLimit ?? 268435456),
      XDRIVE_TRASH_RETENTION: options.trashRetention ?? '720h',
      XDRIVE_DISK_SAFETY_BYTES: '0',
      XDRIVE_LISTEN_ADDR: `127.0.0.1:${address.port}`,
    }
    const binary = join(root, 'xdrive-test')
    execFileSync('go', ['build', '-o', binary, './cmd/xdrive'], { cwd, env })
    const output = execFileSync(binary, ['init'], { cwd, env, encoding: 'utf8' })
    const token = output.match(/\/setup#([A-Za-z0-9_-]+)/u)?.[1]
    if (!token) throw new Error('setup token missing')
    server = spawn(binary, ['serve'], { cwd, env, stdio: 'ignore' })
    const upstreamURL = `http://127.0.0.1:${address.port}`
    const waitReady = async () => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if (server?.exitCode !== null) throw new Error('test service exited')
        try { if ((await fetch(`${upstreamURL}/readyz`)).status === 200) return } catch { /* Startup is asynchronous. */ }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error('test service readiness timeout')
    }
    await waitReady()
    if (testUsesHTTPS()) tlsProxy = await startTLSProxy(upstreamURL)
    return {
      baseURL: tlsProxy?.baseURL ?? upstreamURL,
      token,
      dataRoot: root,
      restartWithQuota: async (quota) => {
        if (!Number.isSafeInteger(quota) || quota < 1) throw new TypeError('invalid restart quota')
        if (server && server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await once(server, 'exit') }
        Object.assign(env, { XDRIVE_QUOTA_BYTES: String(quota) })
        server = spawn(binary, ['serve'], { cwd, env, stdio: 'ignore' })
        await waitReady()
      },
      backupTo: (destination) => { execFileSync(binary, ['backup', destination], { cwd, env, stdio: 'pipe' }) },
      close,
    }
  } catch (error) { await close(); throw error }
}
