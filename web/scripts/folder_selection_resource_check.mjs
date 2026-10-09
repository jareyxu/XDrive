import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(webRoot, '..')
const reportPath = process.env.XDRIVE_FOLDER_RESOURCE_REPORT
  ? resolve(process.env.XDRIVE_FOLDER_RESOURCE_REPORT)
  : join(repoRoot, 'docs/operations/artifacts/S5-folder-selection-resource-2026-10-09.json')
const sourcePaths = [
  'web/src/uploads/folder-selection.ts',
  'web/src/uploads/folder-path.ts',
]
const harnessPaths = ['web/scripts/folder_selection_resource_check.mjs', 'web/folder-resource-benchmark.html']

async function sourceDigest(path) {
  return createHash('sha256').update(await readFile(join(repoRoot, path))).digest('hex')
}

async function createEmptyFolder(root, directoryDepth, directoryCount, filesPerDirectory) {
  await mkdir(root, { recursive: true })
  if (directoryDepth > 0) {
    let deepest = root
    for (let depth = 0; depth < directoryDepth; depth += 1) {
      deepest = join(deepest, 'd')
      await mkdir(deepest)
    }
    for (let start = 0; start < filesPerDirectory; start += 128) {
      const end = Math.min(start + 128, filesPerDirectory)
      await Promise.all(Array.from({ length: end - start }, (_, offset) => {
        const name = `file-${String(start + offset).padStart(4, '0')}.bin`
        return writeFile(join(deepest, name), new Uint8Array())
      }))
    }
    return
  }

  for (let directory = 0; directory < directoryCount; directory += 1) {
    const childDirectory = join(root, `d-${String(directory).padStart(3, '0')}`)
    await mkdir(childDirectory)
    for (let start = 0; start < filesPerDirectory; start += 128) {
      const end = Math.min(start + 128, filesPerDirectory)
      await Promise.all(Array.from({ length: end - start }, (_, offset) => {
        const name = `file-${String(start + offset).padStart(5, '0')}.bin`
        return writeFile(join(childDirectory, name), new Uint8Array())
      }))
    }
  }
}

const server = await createServer({
  root: webRoot,
  configFile: join(webRoot, 'vite.config.ts'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
})
let browser
let fixtureRoot = ''
try {
  await server.listen()
  const baseUrl = server.resolvedUrls?.local?.[0]
  if (!baseUrl) throw new Error('Vite did not expose a local URL')

  browser = await chromium.launch({
    headless: true,
    args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(new URL('folder-resource-benchmark.html', baseUrl).href)
  const session = await page.context().newCDPSession(page)
  await session.send('HeapProfiler.enable')
  await page.evaluate(async () => {
    window.__xdriveParseFolderSelection = (await import('/src/uploads/folder-selection.ts')).parseFolderSelection
  })
  await session.send('HeapProfiler.collectGarbage')
  const beforeFixture = await session.send('Runtime.getHeapUsage')

  await page.evaluate(() => {
    const files = []
    const fileCount = 250_000
    const filesPerDirectory = 5_000
    for (let index = 0; index < fileCount; index += 1) {
      const directory = String(Math.floor(index / filesPerDirectory)).padStart(3, '0')
      const name = `file-${String(index % filesPerDirectory).padStart(5, '0')}.bin`
      files.push({ name, webkitRelativePath: `selected/d-${directory}/${name}` })
    }
    window.__xdriveFiles = files
  })
  await session.send('HeapProfiler.collectGarbage')
  const afterFixture = await session.send('Runtime.getHeapUsage')

  const measurement = await page.evaluate(() => {
    const start = performance.now()
    const selection = window.__xdriveParseFolderSelection(window.__xdriveFiles)
    const parseMillis = performance.now() - start
    window.__xdriveSelection = selection
    const directDirectories = selection.children.get('selected')?.size ?? 0
    const largestDirectory = Math.max(...[...selection.children.values()].map(children => children.size))
    const lastRecord = selection.records.at(-1)
    return {
      fileCount: selection.records.length,
      directDirectories,
      largestDirectory,
      firstPath: selection.records[0]?.segments.join('/'),
      lastPath: lastRecord?.segments.join('/'),
      parseMillis,
    }
  })
  await session.send('HeapProfiler.collectGarbage')
  const afterParse = await session.send('Runtime.getHeapUsage')
  const deepFixture = await page.evaluate(() => {
    const directoryDepth = 256
    const filesPerDirectory = 5_000
    const pathPrefix = `deep-root/${Array.from({ length: directoryDepth }, (_, index) => `d${index}`).join('/')}`
    const files = Array.from({ length: filesPerDirectory }, (_, index) => {
      const name = `file-${String(index).padStart(4, '0')}.bin`
      return { name, webkitRelativePath: `${pathPrefix}/${name}` }
    })
    window.__xdriveDeepFiles = files
    return { directoryDepth, fileCount: files.length }
  })
  await session.send('HeapProfiler.collectGarbage')
  const beforeDeepFixture = await session.send('Runtime.getHeapUsage')
  const deepParseMillis = await page.evaluate(() => {
    const start = performance.now()
    window.__xdriveDeepSelection = window.__xdriveParseFolderSelection(window.__xdriveDeepFiles)
    return performance.now() - start
  })
  await session.send('HeapProfiler.collectGarbage')
  const afterDeepParse = await session.send('Runtime.getHeapUsage')

  // Exercise the browser-created FileList and webkitRelativePath values from a
  // directory input, using empty temporary files so no content buffers inflate
  // the selection measurement.
  fixtureRoot = await mkdtemp(join(tmpdir(), 'xdrive-folder-resource-'))
  const browserInputPath = join(fixtureRoot, 'selected')
  await createEmptyFolder(browserInputPath, 0, 50, 5_000)
  const fileListPage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  fileListPage.setDefaultTimeout(10 * 60 * 1000)
  await fileListPage.goto(new URL('folder-resource-benchmark.html', baseUrl).href)
  const fileListSession = await fileListPage.context().newCDPSession(fileListPage)
  await fileListSession.send('HeapProfiler.enable')
  await fileListPage.evaluate(async () => {
    window.__xdriveParseFolderSelection = (await import('/src/uploads/folder-selection.ts')).parseFolderSelection
  })
  await fileListSession.send('HeapProfiler.collectGarbage')
  const beforeFileList = await fileListSession.send('Runtime.getHeapUsage')
  const fileListStartedAt = Date.now()
  await fileListPage.locator('#folder-input').setInputFiles(browserInputPath)
  const fileListMaterializeMillis = Date.now() - fileListStartedAt
  const fileListDetails = await fileListPage.locator('#folder-input').evaluate((input) => {
    if (!(input.files instanceof FileList)) throw new Error('Directory input did not create a FileList')
    window.__xdriveFiles = Array.from(input.files)
    return {
      fileCount: input.files.length,
      isFileList: input.files instanceof FileList,
      firstPath: input.files[0]?.webkitRelativePath,
      lastPath: input.files[input.files.length - 1]?.webkitRelativePath,
    }
  })
  await fileListSession.send('HeapProfiler.collectGarbage')
  const afterFileList = await fileListSession.send('Runtime.getHeapUsage')
  const fileListParse = await fileListPage.evaluate(() => {
    const start = performance.now()
    const selection = window.__xdriveParseFolderSelection(window.__xdriveFiles)
    const parseMillis = performance.now() - start
    window.__xdriveFileListSelection = selection
    return {
      fileCount: selection.records.length,
      directDirectories: selection.children.get('selected')?.size ?? 0,
      largestDirectory: Math.max(...[...selection.children.values()].map(children => children.size)),
      firstPath: selection.records[0]?.segments.join('/'),
      lastPath: selection.records.at(-1)?.segments.join('/'),
      parseMillis,
    }
  })
  await fileListSession.send('HeapProfiler.collectGarbage')
  const afterFileListParse = await fileListSession.send('Runtime.getHeapUsage')
  if (fileListDetails.fileCount !== 250_000 || !fileListDetails.isFileList || fileListParse.fileCount !== 250_000 || fileListParse.directDirectories !== 50 || fileListParse.largestDirectory !== 5_000) {
    throw new Error(`Unexpected real FileList result: ${JSON.stringify({ fileListDetails, fileListParse })}`)
  }
  await fileListPage.close()

  const deepInputPath = join(fixtureRoot, 'deep-selected')
  await createEmptyFolder(deepInputPath, 256, 0, 5_000)
  const deepFileListPage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  deepFileListPage.setDefaultTimeout(10 * 60 * 1000)
  await deepFileListPage.goto(new URL('folder-resource-benchmark.html', baseUrl).href)
  const deepFileListSession = await deepFileListPage.context().newCDPSession(deepFileListPage)
  await deepFileListSession.send('HeapProfiler.enable')
  await deepFileListPage.evaluate(async () => {
    window.__xdriveParseFolderSelection = (await import('/src/uploads/folder-selection.ts')).parseFolderSelection
  })
  await deepFileListSession.send('HeapProfiler.collectGarbage')
  const beforeDeepFileList = await deepFileListSession.send('Runtime.getHeapUsage')
  const deepFileListStartedAt = Date.now()
  await deepFileListPage.locator('#folder-input').setInputFiles(deepInputPath)
  const deepFileListMaterializeMillis = Date.now() - deepFileListStartedAt
  const deepFileListDetails = await deepFileListPage.locator('#folder-input').evaluate((input) => {
    if (!(input.files instanceof FileList)) throw new Error('Deep directory input did not create a FileList')
    window.__xdriveDeepFiles = Array.from(input.files)
    return { fileCount: input.files.length, isFileList: input.files instanceof FileList }
  })
  await deepFileListSession.send('HeapProfiler.collectGarbage')
  const afterDeepFileList = await deepFileListSession.send('Runtime.getHeapUsage')
  const deepFileListParse = await deepFileListPage.evaluate(() => {
    const start = performance.now()
    const selection = window.__xdriveParseFolderSelection(window.__xdriveDeepFiles)
    const parseMillis = performance.now() - start
    window.__xdriveDeepFileListSelection = selection
    return { fileCount: selection.records.length, directoryDepth: selection.records[0].segments.length - 2, parseMillis }
  })
  await deepFileListSession.send('HeapProfiler.collectGarbage')
  const afterDeepFileListParse = await deepFileListSession.send('Runtime.getHeapUsage')
  if (deepFileListDetails.fileCount !== 5_000 || !deepFileListDetails.isFileList || deepFileListParse.fileCount !== 5_000 || deepFileListParse.directoryDepth !== 256) {
    throw new Error(`Unexpected deep real FileList result: ${JSON.stringify({ deepFileListDetails, deepFileListParse })}`)
  }
  await deepFileListPage.close()

  const sourceSha256 = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, await sourceDigest(path)])))
  const harnessSha256 = Object.fromEntries(await Promise.all(harnessPaths.map(async path => [path, await sourceDigest(path)])))
  if (measurement.fileCount !== 250_000 || measurement.directDirectories !== 50 || measurement.largestDirectory !== 5_000) {
    throw new Error(`Unexpected parse result: ${JSON.stringify(measurement)}`)
  }

  const report = {
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    browser: 'Chromium',
    browserVersion: browser.version(),
    browserUserAgent: await page.evaluate(() => navigator.userAgent),
    fixture: '250,000 lightweight file records under 50 directories, 5,000 files each; no file content buffers',
    scope: 'Production parseFolderSelection imported through Vite; synthetic records and Chromium-generated webkitdirectory FileLists are retained after explicit renderer garbage collection.',
    limitations: [
      'Playwright setInputFiles populated the actual Chromium FileList from temporary zero-byte OS files; no native OS picker was opened. File contents, per-file encryption/upload, and total browser-process RSS are not included.',
      'Measured on a desktop macOS browser, not iOS/Android or a constrained 1 GiB device.',
    ],
    sourceSha256,
    harnessSha256,
    parser: {
      fileCount: measurement.fileCount,
      directDirectories: measurement.directDirectories,
      largestDirectory: measurement.largestDirectory,
      firstPath: measurement.firstPath,
      lastPath: measurement.lastPath,
      parseMillis: measurement.parseMillis,
      rendererJsHeapBytes: {
        beforeFixture: beforeFixture.usedSize,
        afterFixture: afterFixture.usedSize,
        afterParse: afterParse.usedSize,
        inputFixtureIncrement: afterFixture.usedSize - beforeFixture.usedSize,
        parserOutputIncrement: afterParse.usedSize - afterFixture.usedSize,
      },
    },
    deepestSupportedPath: {
      ...deepFixture,
      parseMillis: deepParseMillis,
      rendererJsHeapBytes: {
        beforeFixture: beforeDeepFixture.usedSize,
        afterParse: afterDeepParse.usedSize,
        parserOutputIncrement: afterDeepParse.usedSize - beforeDeepFixture.usedSize,
      },
    },
    browserFileList: {
      fixture: '250,000 zero-byte OS files under 50 directories; Playwright populated a browser webkitdirectory input and Chromium created the FileList and webkitRelativePath values.',
      fileListMaterializeMillis,
      ...fileListDetails,
      parser: fileListParse,
      rendererJsHeapBytes: {
        beforeFileList: beforeFileList.usedSize,
        afterFileList: afterFileList.usedSize,
        afterParse: afterFileListParse.usedSize,
        fileListAndArrayIncrement: afterFileList.usedSize - beforeFileList.usedSize,
        parserOutputIncrement: afterFileListParse.usedSize - afterFileList.usedSize,
      },
    },
    deepestBrowserFileList: {
      fixture: '5,000 zero-byte OS files at depth 256 in a directory tree with repeated one-character components; Chromium populated a browser webkitdirectory input.',
      directoryDepth: 256,
      fileCount: 5_000,
      isFileList: deepFileListDetails.isFileList,
      fileListMaterializeMillis: deepFileListMaterializeMillis,
      parser: deepFileListParse,
      rendererJsHeapBytes: {
        beforeFileList: beforeDeepFileList.usedSize,
        afterFileList: afterDeepFileList.usedSize,
        afterParse: afterDeepFileListParse.usedSize,
        fileListAndArrayIncrement: afterDeepFileList.usedSize - beforeDeepFileList.usedSize,
        parserOutputIncrement: afterDeepFileListParse.usedSize - afterDeepFileList.usedSize,
      },
    },
  }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ reportPath, parser: report.parser, deepestSupportedPath: report.deepestSupportedPath, browserFileList: report.browserFileList, deepestBrowserFileList: report.deepestBrowserFileList, sourceSha256, harnessSha256 }, null, 2)}\n`)
} finally {
  try {
    await browser?.close()
  } finally {
    try {
      await server.close()
    } finally {
      if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
    }
  }
}
