import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startIsolatedServer } from './isolated-server'
import { loadMediaResourceTarget, unlockMediaResourceTarget } from './media-resource-target'

const password = 'correct horse battery'
const minimumPayloadBytes = 2 * 1024 ** 3
const usesMediaResourceTarget = Boolean(process.env.XDRIVE_MEDIA_RESOURCE_STATE_PATH)
test.use({
  trace: 'off',
  // Chromium ignores the Caddy validation guest's local CA for page requests
  // via ignoreHTTPSErrors, but Service Worker script fetches still require this
  // test-only launch flag. It is enabled only for the explicit loopback target.
  launchOptions: { args: usesMediaResourceTarget ? ['--ignore-certificate-errors'] : [] },
})

test('MP4 files with over 2 GiB of encoded media preserve encrypted front/tail moov Range playback and seek', async ({ page, browserName }, testInfo) => {
  test.skip(process.env.XDRIVE_LARGE_VIDEO_E2E !== '1', 'Opt-in S1 gate: generates and uploads two >2 GiB encoded videos; requires FFmpeg with libx264.')
  test.skip(browserName === 'firefox', 'Firefox uses the configured bounded Blob video fallback; large Firefox playback is verified by video-fallback-policy.pw.ts instead of the Service Worker Range relay.')
  test.setTimeout(30 * 60_000)
  const temporary = mkdtempSync(join(tmpdir(), 'xdrive-large-video-'))
  const resourceTarget = loadMediaResourceTarget()
  const server = resourceTarget ? undefined : await startIsolatedServer({ quotaBytes: 6 * 1024 ** 3 })
  const reports: Array<Record<string, unknown>> = []
  try {
    const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' })
    if (!encoders.includes('libx264')) throw new Error('The S1 content-heavy video test requires FFmpeg built with libx264.')
    const fixtures = (['front', 'tail'] as const).map((layout) => {
      const name = `${layout}-moov-content-2g.mp4`
      const path = join(temporary, name)
      const generationStarted = Date.now()
      execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30', '-t', '75', '-an',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
        '-x264-params', 'nal-hrd=cbr:force-cfr=1:vbv-bufsize=256000:vbv-maxrate=256000:keyint=30:min-keyint=30:scenecut=0',
        '-b:v', '256M', '-minrate', '256M', '-maxrate', '256M', '-bufsize', '256M',
        ...(layout === 'front' ? ['-movflags', '+faststart'] : []),
        path,
      ], { stdio: 'pipe', timeout: 20 * 60_000 })
      const boxes = parseTopLevelBoxes(path)
      const moov = boxes.find((box) => box.type === 'moov')
      const mdat = boxes.find((box) => box.type === 'mdat')
      const fileBytes = statSync(path).size
      if (!moov || !mdat || (layout === 'front' ? moov.offset >= mdat.offset : moov.offset <= mdat.offset)) throw new TypeError(`FFmpeg did not produce the requested ${layout}-moov layout`)
      const encodedMediaBytes = mdat.size - mdat.headerBytes
      if (encodedMediaBytes < minimumPayloadBytes) throw new RangeError(`${name} contains only ${encodedMediaBytes} encoded bytes`)
      return { name, path, layout, fileBytes, encodedMediaBytes, generationMs: Date.now() - generationStarted }
    })

    if (resourceTarget) {
      await unlockMediaResourceTarget(page, resourceTarget)
    } else {
      await page.goto(`${server!.baseURL}/setup#${server!.token}`)
      await page.getByLabel('设置密码').fill(password)
      await page.getByLabel('再次输入密码').fill(password)
      await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
      await page.getByRole('button', { name: '创建加密云盘' }).click()
      await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })
    }

    await page.evaluate(() => {
      const target = window as Window & { __largeVideoMemoryBlobs?: number[]; __largeVideoFileUrls?: number[] }
      target.__largeVideoMemoryBlobs = []
      target.__largeVideoFileUrls = []
      const create = URL.createObjectURL.bind(URL)
      URL.createObjectURL = (blob) => {
        if (blob instanceof File && blob.size >= 64 * 1024 ** 2) target.__largeVideoFileUrls?.push(blob.size)
        else if (blob instanceof Blob && blob.size >= 64 * 1024 ** 2) target.__largeVideoMemoryBlobs?.push(blob.size)
        return create(blob)
      }
    })

    for (const fixture of fixtures) {
      const entry = page.getByRole('button', { name: fixture.name, exact: true })
      const reuseFrontUpload = resourceTarget !== undefined && process.env.XDRIVE_MEDIA_RESOURCE_REUSE_FRONT_UPLOAD === '1' && fixture.layout === 'front'
      const uploadStarted = Date.now()
      if (!reuseFrontUpload) await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(fixture.path)
      await expect(entry).toBeVisible({ timeout: 20 * 60_000 })
      const uploadMs = reuseFrontUpload ? null : Date.now() - uploadStarted
      console.log(reuseFrontUpload ? `${fixture.name} reuses an already completed encrypted upload` : `${fixture.name} encrypted upload completed in ${uploadMs} ms`)

      const mediaRanges: string[] = []
      const virtualRequests: Array<{ resourceType: string; range: string | null }> = []
      const observeMedia = (request: { resourceType(): string; url(): string; headers(): Record<string, string> }) => {
        if (request.url().includes('/__xdrive_media/')) {
          const range = request.headers().range
          virtualRequests.push({ resourceType: request.resourceType(), range: range ?? null })
          if (range) mediaRanges.push(range)
        }
      }
      page.on('request', observeMedia)
      await entry.click()
      const dialog = page.getByRole('dialog', { name: `预览 ${fixture.name}` })
      const video = dialog.locator('video')
      await expect(video).toHaveAttribute('src', /^\/__xdrive_media\/[A-Za-z0-9_-]{32}$/u, { timeout: 30_000 })
      const mediaURL = await video.getAttribute('src')
      if (!mediaURL) throw new Error('large video has no virtual media URL')

      const rangeStarted = Date.now()
      const edgeRanges = await page.evaluate(async (url) => {
        const [head, tail] = await Promise.all([
          fetch(url, { headers: { Range: 'bytes=0-127' } }),
          fetch(url, { headers: { Range: 'bytes=-128' } }),
        ])
        return {
          headStatus: head.status,
          headBytes: [...new Uint8Array(await head.arrayBuffer())],
          tailStatus: tail.status,
          tailBytes: [...new Uint8Array(await tail.arrayBuffer())],
        }
      }, mediaURL)
      const rangeMs = Date.now() - rangeStarted
      expect(edgeRanges.headStatus).toBe(206)
      expect(edgeRanges.tailStatus).toBe(206)
      expect(Buffer.from(edgeRanges.headBytes)).toEqual(readAt(fixture.path, 0, 128))
      expect(Buffer.from(edgeRanges.tailBytes)).toEqual(readAt(fixture.path, fixture.fileBytes - 128, 128))

      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 60_000 }).toBeGreaterThanOrEqual(1)
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration), { timeout: 30_000 }).toBeGreaterThanOrEqual(74.9)
      const playbackStarted = Date.now()
      await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; await element.play() })
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 20_000 }).toBeGreaterThan(0.2)
      const seekTarget = await video.evaluate((element: HTMLVideoElement) => element.duration - 2.5)
      await video.evaluate(async (element: HTMLVideoElement, target) => {
        element.pause()
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error('large video seek timed out')), 60_000)
          element.addEventListener('seeked', () => { window.clearTimeout(timer); resolve() }, { once: true })
          element.currentTime = target
        })
      }, seekTarget)
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 5_000 }).toBeGreaterThan(seekTarget - 0.5)
      const playbackAndSeekMs = Date.now() - playbackStarted
      const readyState = await video.evaluate((element: HTMLVideoElement) => element.readyState)
      // The fixture's only explicit fetches are these two edge probes. Keep the
      // actual high-offset player gate without assuming an engine's resource
      // classification for requests intercepted by a Service Worker.
      const playerRanges = mediaRanges.filter(range => range !== 'bytes=0-127' && range !== 'bytes=-128')
      console.log(`${fixture.name} virtual requests: ${JSON.stringify(virtualRequests)}`)
      expect(playerRanges.some((range) => Number(range.match(/^bytes=(\d+)-/u)?.[1] ?? -1) >= fixture.fileBytes - 128 * 1024 ** 2)).toBe(true)
      console.log(`${fixture.name} media element ranges: ${JSON.stringify(playerRanges)}`)
      const objectUrlUsage = await page.evaluate(() => {
        const target = window as Window & { __largeVideoMemoryBlobs?: number[]; __largeVideoFileUrls?: number[] }
        return { largeMemoryBlobSizes: target.__largeVideoMemoryBlobs ?? [], largeFileUrlSizes: target.__largeVideoFileUrls ?? [] }
      })
      expect(objectUrlUsage.largeMemoryBlobSizes).toEqual([])
      page.off('request', observeMedia)

      await dialog.getByRole('button', { name: '关闭预览' }).click()
      await expect.poll(() => page.evaluate(async (url) => (await fetch(url, { method: 'HEAD' })).status, mediaURL)).toBe(410)
      reports.push({
        name: fixture.name,
        moovLayout: fixture.layout,
        fileBytes: fixture.fileBytes,
        encodedMediaBytes: fixture.encodedMediaBytes,
        generatedDurationSeconds: 75,
        generationMs: fixture.generationMs,
        uploadMs,
        uploadReused: reuseFrontUpload,
        edgeRangeMs: rangeMs,
        playbackAndSeekMs,
        seekTargetSeconds: seekTarget,
        readyState,
        mediaElementRanges: playerRanges,
        observedVirtualRequests: virtualRequests,
        headAndTailRangeStatuses: [edgeRanges.headStatus, edgeRanges.tailStatus],
        ...objectUrlUsage,
        virtualSessionExpiredAfterClose: true,
      })
      console.log(`${fixture.name} range playback and seek completed in ${playbackAndSeekMs} ms`)
    }

    await page.getByRole('button', { name: '锁定云盘', exact: true }).click()
    await expect(page.getByRole('heading', { name: '重新解锁云盘' })).toBeVisible()
    const report = {
      date: new Date().toISOString(),
      browser: testInfo.project.use.browserName,
      platform: process.platform,
      architecture: process.arch,
      resourceTarget: resourceTarget ? { environment: 'isolated Linux VPS validation guest', guestOS: 'Debian 12 amd64', guestVCPU: 1, guestMemoryMiB: 1024, guestDiskGiB: 25, browserRunsOnGuest: false } : null,
      fixtureMethod: 'FFmpeg libx264 256 Mbit/s CBR testsrc2 at 30 fps for 75 seconds; the ISO BMFF mdat contains over 2 GiB of actual H.264 encoded access units, with faststart front-moov and default tail-moov outputs.',
      cases: reports,
      limitations: [resourceTarget ? 'The Go service runs in a 1 vCPU/1 GiB Linux guest; Chromium runs on the macOS host, so this does not measure constrained-browser RSS.' : `This proves a >2 GiB encoded-media object and high-offset Range playback on macOS ${browserName}, not 1 vCPU/1 GB RSS.`, 'Safari and physical mobile devices were not tested.'],
    }
    const reportPath = testInfo.outputPath('large-video-range-report.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    await testInfo.attach('large-video-range-report.json', { path: reportPath, contentType: 'application/json' })
  } finally {
    await server?.close()
    rmSync(temporary, { recursive: true, force: true })
  }
})

interface Mp4Box { type: string; offset: number; size: number; headerBytes: number }

function parseTopLevelBoxes(path: string): Mp4Box[] {
  const fileBytes = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const boxes: Mp4Box[] = []
    let offset = 0
    while (offset + 8 <= fileBytes) {
      const header = Buffer.alloc(16)
      const bytesRead = readSync(fd, header, 0, 16, offset)
      if (bytesRead < 8) throw new TypeError('truncated ISO BMFF box header')
      const size32 = header.readUInt32BE(0)
      const type = header.toString('ascii', 4, 8)
      const headerBytes = size32 === 1 ? 16 : 8
      const size = size32 === 1 ? Number(header.readBigUInt64BE(8)) : size32 === 0 ? fileBytes - offset : size32
      if (!Number.isSafeInteger(size) || size < headerBytes || offset + size > fileBytes) throw new TypeError(`invalid ISO BMFF ${type} box size`)
      boxes.push({ type, offset, size, headerBytes })
      offset += size
    }
    if (offset !== fileBytes) throw new TypeError('trailing bytes after ISO BMFF boxes')
    return boxes
  } finally { closeSync(fd) }
}

function readAt(path: string, position: number, length: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const bytes = Buffer.alloc(length)
    const count = readSync(fd, bytes, 0, length, position)
    if (count !== length) throw new TypeError('short read from large MP4 fixture')
    return bytes
  } finally { closeSync(fd) }
}
