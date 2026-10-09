import AxeBuilder from '@axe-core/playwright'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from '@playwright/test'
import { startIsolatedServer } from './isolated-server'
import { createMinimalPDF, createPreviewPNG } from './media-fixtures'

const axeTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

test('real preview and file-operation states have no axe findings', async ({ page, browserName }) => {
  test.setTimeout(150_000)
  const server = await startIsolatedServer()
  const folderFixture = mkdtempSync(join(tmpdir(), 'xdrive-a11y-folder-conflict-'))
  mkdirSync(join(folderFixture, 'bundle'))
  writeFileSync(join(folderFixture, 'bundle', 'entry.txt'), 'folder conflict fixture')
  const artifacts = join(import.meta.dirname, '..', '..', 'docs', 'operations', 'artifacts', 'accessibility-interactions-2026-10-08', browserName)
  mkdirSync(artifacts, { recursive: true })
  const captures: Array<Record<string, unknown>> = []

  const audit = async (surface: string, viewport: string, state?: Record<string, unknown>) => {
    const result = await new AxeBuilder({ page }).withTags(axeTags).analyze()
    const violations = result.violations.map(issue => ({
      id: issue.id,
      impact: issue.impact,
      description: issue.description,
      help: issue.help,
      helpUrl: issue.helpUrl,
      nodes: issue.nodes.map(node => ({ target: node.target, summary: node.failureSummary })),
    }))
    captures.push({ surface, viewport, ...(state ?? {}), violations })
    expect(violations, `${surface} ${viewport} must not have axe findings`).toEqual([])
  }

  try {
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })

    const fileInput = page.locator('input[type="file"]:not([webkitdirectory])').first()
    const markdown = '# Private notes\n\nThis is a real encrypted preview fixture.\n'
    await fileInput.setInputFiles({ name: 'overview.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown) })
    await expect(page.getByRole('status')).toContainText('上传完成。', { timeout: 30_000 })
    await page.getByRole('button', { name: 'overview.md', exact: true }).click()
    const preview = page.getByRole('dialog', { name: '预览 overview.md', exact: true })
    await expect(preview).toContainText('This is a real encrypted preview fixture.')
    await audit('markdown-preview-dialog', 'desktop')
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()

    const image = await createPreviewPNG(page)
    await fileInput.setInputFiles({ name: 'preview-image.png', mimeType: 'image/png', buffer: image })
    await expect(page.getByRole('status')).toContainText('上传完成。', { timeout: 30_000 })
    await page.getByRole('button', { name: 'preview-image.png', exact: true }).click()
    const imagePreview = page.getByRole('dialog', { name: '预览 preview-image.png', exact: true })
    await expect(imagePreview.locator('img.preview-image')).toHaveJSProperty('naturalWidth', 320)
    await audit('image-preview-dialog', 'desktop')
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()

    const pdfBytes = createMinimalPDF()
    await fileInput.setInputFiles({ name: 'preview-document.pdf', mimeType: 'application/pdf', buffer: pdfBytes })
    await expect(page.getByRole('status')).toContainText('上传完成。', { timeout: 30_000 })
    await page.getByRole('button', { name: 'preview-document.pdf', exact: true }).click()
    const pdfPreview = page.getByRole('dialog', { name: '预览 preview-document.pdf', exact: true })
    const pdfRegion = pdfPreview.getByRole('region', { name: 'PDF 预览', exact: true })
    await expect(pdfRegion).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => pdfRegion.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0)
    await audit('pdf-preview-dialog', 'desktop')
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()

    const source = 'export const encryptedFixture = "code preview is ready"\n'
    await fileInput.setInputFiles({ name: 'preview-source.ts', mimeType: 'application/typescript', buffer: Buffer.from(source) })
    await expect(page.getByRole('status')).toContainText('上传完成。', { timeout: 30_000 })
    await page.getByRole('button', { name: 'preview-source.ts', exact: true }).click()
    const codePreview = page.getByRole('dialog', { name: '预览 preview-source.ts', exact: true })
    const codeRegion = codePreview.getByRole('region', { name: '代码预览', exact: true })
    await expect(codeRegion.getByRole('status')).toHaveText('typescript · 只读', { timeout: 30_000 })
    await expect(codeRegion).toContainText('encryptedFixture')
    await audit('code-preview-dialog', 'desktop')
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()

    const videoBytes = readFileSync(join(import.meta.dirname, '..', '..', 'tests', 'testdata', 'media', 'tail-moov.mp4'))
    await fileInput.setInputFiles({ name: 'preview-video.mp4', mimeType: 'video/mp4', buffer: videoBytes })
    await expect(page.getByRole('status')).toContainText('上传完成。', { timeout: 30_000 })
    await page.getByRole('button', { name: 'preview-video.mp4', exact: true }).click()
    const videoPreview = page.getByRole('dialog', { name: '预览 preview-video.mp4', exact: true })
    const video = videoPreview.locator('video.preview-video')
    const videoFallback = videoPreview.locator('.video-preview-area [role="alert"]')
    await expect.poll(async () => {
      if (await videoFallback.isVisible().catch(() => false)) return 'fallback'
      if (await video.count()) return await video.evaluate(element => (element as HTMLVideoElement).readyState >= HTMLMediaElement.HAVE_METADATA ? 'ready' : 'loading')
      return 'loading'
    }, { timeout: 30_000 }).toMatch(/^(ready|fallback)$/u)
    const videoState = await videoFallback.isVisible().catch(() => false) ? 'fallback' : 'ready'
    await audit('video-preview-dialog', 'desktop', { state: videoState })
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()

    await expect(page.getByRole('note', { name: '备份提醒' })).toBeVisible()
    await page.getByRole('note', { name: '备份提醒' }).getByRole('button', { name: '了解如何备份', exact: true }).click()
    const backupHelp = page.getByRole('dialog', { name: '如何备份 XDrive', exact: true })
    await expect(backupHelp).toContainText('xdrive backup --verify')
    await audit('backup-help-dialog', 'desktop')
    await backupHelp.getByRole('button', { name: '关闭备份说明', exact: true }).click()

    const folderInput = page.locator('input[webkitdirectory]').first()
    await folderInput.setInputFiles(folderFixture)
    await expect(page.getByRole('status')).toContainText('文件夹上传完成，共 1 个文件。', { timeout: 30_000 })
    await folderInput.setInputFiles(folderFixture)
    const folderConflict = page.getByRole('dialog', { name: '文件夹上传冲突', exact: true })
    await expect(folderConflict.getByRole('heading')).toHaveText('1 项存在同名冲突', { timeout: 30_000 })
    await audit('folder-upload-conflict-dialog', 'desktop')
    await folderConflict.getByRole('button', { name: '取消上传', exact: true }).click()
    await expect(folderConflict).toHaveCount(0)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('checkbox', { name: '选择 overview.md', exact: true }).check()
    await page.getByRole('button', { name: '批量移动', exact: true }).click()
    const moveDialog = page.getByRole('dialog', { name: '移动 overview.md', exact: true })
    await expect(moveDialog.getByRole('button', { name: '不能移动到此处', exact: true })).toBeDisabled()
    await audit('move-dialog', 'mobile')
    await moveDialog.getByRole('button', { name: '取消', exact: true }).click()

    await page.getByRole('button', { name: '移到回收站所选', exact: true }).click()
    const deleteDialog = page.getByRole('dialog', { name: '将所选项目移到回收站', exact: true })
    await expect(deleteDialog).toBeVisible()
    await audit('batch-delete-dialog', 'mobile')
    await deleteDialog.getByRole('button', { name: '取消', exact: true }).click()

    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'overview.md', mimeType: 'text/markdown', buffer: Buffer.from(`${markdown}\nA newer copy.`) })
    const conflictDialog = page.getByRole('dialog', { name: '同名文件冲突', exact: true })
    await expect(conflictDialog).toBeVisible({ timeout: 30_000 })
    await audit('upload-conflict-dialog', 'mobile')
    await conflictDialog.getByRole('button', { name: '跳过', exact: true }).click()
    await expect(conflictDialog).toHaveCount(0)

    await page.getByRole('button', { name: '更多操作 overview.md', exact: true }).click()
    const actionsDialog = page.getByRole('dialog', { name: '项目操作 overview.md', exact: true })
    await expect(actionsDialog).toBeVisible()
    await audit('entry-actions-dialog', 'mobile')
    await actionsDialog.getByRole('button', { name: '关闭', exact: true }).click()

    page.once('dialog', dialog => { void dialog.accept() })
    await page.getByRole('button', { name: '更多操作 overview.md', exact: true }).click()
    await page.getByRole('dialog', { name: '项目操作 overview.md', exact: true }).getByRole('button', { name: '移到回收站 overview.md', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('已移到回收站。', { timeout: 30_000 })
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的文件', exact: true }).click()
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'overview.md', mimeType: 'text/markdown', buffer: Buffer.from(`${markdown}\nActive copy.`) })
    await expect(page.getByRole('status')).toContainText('上传完成。', { timeout: 30_000 })
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '回收站', exact: true }).click()
    await page.getByRole('checkbox', { name: '选择回收站 overview.md', exact: true }).check()
    await page.getByRole('button', { name: '恢复所选', exact: true }).click()
    const restoreConflict = page.getByRole('dialog', { name: '恢复名称冲突', exact: true })
    await expect(restoreConflict).toContainText('本次尚未恢复任何项目')
    await audit('restore-conflict-dialog', 'mobile')
    await restoreConflict.getByRole('button', { name: '取消恢复', exact: true }).click()
    await expect(restoreConflict).toHaveCount(0)
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '回收站', exact: true }).click()
    await page.getByRole('button', { name: '清空回收站', exact: true }).click()
    const clearDialog = page.getByRole('dialog', { name: '清空回收站', exact: true })
    await expect(clearDialog).toBeVisible()
    await audit('clear-trash-dialog', 'mobile')
    await clearDialog.getByRole('button', { name: '取消', exact: true }).click()

    writeFileSync(join(artifacts, 'accessibility.json'), `${JSON.stringify({ schemaVersion: 1, date: '2026-10-08', browser: `Playwright ${browserName}`, physicalDevice: false, screenReaderTested: false, tags: axeTags, threshold: 'zero axe violations', auditCount: captures.length, captures }, null, 2)}\n`)
  } finally {
    await server.close()
    rmSync(folderFixture, { recursive: true, force: true })
  }
})
