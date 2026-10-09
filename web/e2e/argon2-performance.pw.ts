import { cpus, platform, arch, totalmem } from 'node:os'
import { writeFileSync } from 'node:fs'
import { ARGON2ID_LIMITS } from '../src/crypto/constants'
import { expect, test, type BrowserContext } from './legacy-list-test'
import { startIsolatedServer } from './isolated-server'
import { testUsesHTTPS } from './tls-proxy.mjs'

interface ArgonSample {
  readonly durationMs: number
  readonly mainThreadFrames: number
  readonly succeeded: boolean
}

test('default Argon2id runs in the production Worker while the page remains responsive', async ({ browser, browserName }, testInfo) => {
  test.setTimeout(120_000)
  const server = await startIsolatedServer()
  let context: BrowserContext | undefined

  try {
    context = await browser.newContext({ baseURL: server.baseURL, ignoreHTTPSErrors: testUsesHTTPS() })
    const page = await context.newPage()
    await page.addInitScript(() => {
      type Probe = { samples: ArgonSample[] }
      type ProbeWindow = Window & { __xdriveArgonProbe?: Probe }
      type ArgonReply = { key?: unknown; error?: unknown }
      const targetWindow = window as ProbeWindow
      const probe: Probe = { samples: [] }
      targetWindow.__xdriveArgonProbe = probe
      const OriginalWorker = window.Worker

      const InstrumentedWorker = new Proxy(OriginalWorker, {
        construct(target, args, newTarget) {
          const scriptURL = String(args[0] ?? '')
          const worker = Reflect.construct(target, args, newTarget) as Worker
          if (!scriptURL.includes('argon.worker')) return worker

          const startedAt = performance.now()
          let mainThreadFrames = 0
          let active = true
          let frameHandle = 0
          const tick = () => {
            if (!active) return
            mainThreadFrames += 1
            frameHandle = requestAnimationFrame(tick)
          }
          frameHandle = requestAnimationFrame(tick)
          const finish = (succeeded: boolean) => {
            if (!active) return
            active = false
            cancelAnimationFrame(frameHandle)
            probe.samples.push({ durationMs: performance.now() - startedAt, mainThreadFrames, succeeded })
          }
          worker.addEventListener('message', (event: MessageEvent<ArgonReply>) => {
            const reply = event.data
            if (typeof reply !== 'object' || reply === null || (!('key' in reply) && !('error' in reply))) return
            finish('key' in reply && reply.key instanceof ArrayBuffer)
          })
          worker.addEventListener('error', () => finish(false), { once: true })
          return worker
        },
      })

      Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: InstrumentedWorker })
    })

    const password = 'correct horse battery'
    await page.goto(`/setup#${server.token}`)
    await page.getByLabel('管理员用户名').fill('admin')
    await page.getByLabel('设置密码').fill(password)
    await page.getByLabel('再次输入密码').fill(password)
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 90_000 })

    await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
    await expect(page.getByLabel('密码', { exact: true })).toBeVisible()
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 90_000 })

    for (let iteration = 1; iteration < 10; iteration += 1) {
      await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
      await expect(page.getByLabel('密码', { exact: true })).toBeVisible()
      await page.getByLabel('密码', { exact: true }).fill(password)
      await page.getByRole('button', { name: '解锁云盘', exact: true }).click()
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 90_000 })
    }

    const samples = await page.evaluate(() => {
      const probeWindow = window as Window & { __xdriveArgonProbe?: { samples: ArgonSample[] } }
      return probeWindow.__xdriveArgonProbe?.samples ?? []
    })
    expect(samples).toHaveLength(11)
    expect(samples.every((sample) => sample.succeeded)).toBe(true)
    expect(samples.every((sample) => sample.durationMs > 0 && sample.mainThreadFrames > 0)).toBe(true)
    const sortedDurations = samples.map((sample) => sample.durationMs).sort((left, right) => left - right)
    const percentile = (value: number) => sortedDurations[Math.ceil(value * sortedDurations.length) - 1]!

    const report = {
      date: new Date().toISOString(),
      browser: browserName,
      browserVersion: browser.version(),
      runtime: { platform: platform(), arch: arch(), totalMemoryBytes: totalmem(), cpuModel: cpus()[0]?.model ?? 'unknown' },
      parameters: {
        algorithm: 'argon2id',
        memoryKiB: ARGON2ID_LIMITS.memoryKiB.default,
        iterations: ARGON2ID_LIMITS.iterations.default,
        parallelism: ARGON2ID_LIMITS.parallelism.default,
      },
      samples,
      summary: {
        sampleCount: samples.length,
        minMs: sortedDurations[0],
        medianMs: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs: sortedDurations.at(-1),
      },
      limitations: [
        'Measures Worker construction through reply, including cold WASM loading in the first sample; it is browser wall time, not an isolated Argon2 kernel benchmark.',
        'Animation-frame counts show the main page continued to run during derivation; they do not measure total browser RSS or Worker memory.',
        'This run is a desktop host measurement, not a mobile-device or 1 GiB browser certification.',
      ],
    }
    const reportPath = testInfo.outputPath('argon2-performance.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    await testInfo.attach('argon2-performance', { path: reportPath, contentType: 'application/json' })
  } finally {
    try {
      await context?.close()
    } finally {
      await server.close()
    }
  }
})
