import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startIsolatedServer } from './isolated-server'

const axeTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
const criticalImpacts = new Set(['critical', 'serious'])

test('full application surfaces pass serious/critical axe checks across desktop, mobile, themes and system preferences', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const server = await startIsolatedServer()
  const artifacts = join(import.meta.dirname, '..', '..', 'docs', 'operations', 'artifacts', 'accessibility-surface-2026-10-08', browserName)
  mkdirSync(artifacts, { recursive: true })
  const captures: Array<Record<string, unknown>> = []
  const systemPreferenceChecks: Array<Record<string, unknown>> = []
  const reducedTransparencyChecks: Array<Record<string, unknown>> = []

  const audit = async (surface: string, viewport: string, appearance: string, forcedColors = false) => {
    const builder = new AxeBuilder({ page }).withTags(axeTags)
    // Playwright sets the forced-colors media query but does not apply the OS
    // palette to computed colors. Axe's contrast calculation is therefore not
    // meaningful in this emulated mode; normal light/dark runs retain it.
    const result = await (forcedColors ? builder.disableRules(['color-contrast']) : builder).analyze()
    const violations = result.violations.map((issue) => ({
      id: issue.id,
      impact: issue.impact,
      description: issue.description,
      help: issue.help,
      helpUrl: issue.helpUrl,
      nodes: issue.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
    }))
    captures.push({ surface, viewport, appearance, violations })
    return violations
  }

  try {
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.goto(`${server.baseURL}/setup#${server.token}`)
    const setupViolations = await audit('setup', 'desktop', 'light')
    const setupCritical = setupViolations.filter((issue) => criticalImpacts.has(String(issue.impact)))
    expect(setupCritical, 'setup page must not have serious or critical axe violations').toEqual([])

    await page.getByLabel('设置密码').fill('correct horse battery')
    await page.getByLabel('再次输入密码').fill('correct horse battery')
    await page.getByLabel('我已了解：如果忘记密码，云盘数据无法恢复。').check()
    await page.getByRole('button', { name: '创建加密云盘' }).click()
    await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible({ timeout: 30_000 })

    const nav = page.getByRole('navigation', { name: '主导航' })
    const routes = [
      { id: 'drive', label: '我的文件', url: '/drive', ready: async () => {
        await page.getByRole('heading', { name: '我的文件', exact: true }).waitFor()
        await expect(page.getByRole('heading', { name: '这里还没有文件', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: '新建文件夹', exact: true })).toBeEnabled()
      } },
      { id: 'trash', label: '回收站', url: '/trash', ready: () => page.getByRole('heading', { name: '回收站', exact: true }).waitFor() },
      { id: 'storage', label: '存储空间', url: '/storage', ready: async () => {
        await page.getByRole('region', { name: '存储空间详情' }).waitFor()
        await expect(page.getByRole('region', { name: '存储空间详情' })).toHaveAttribute('aria-busy', 'false')
      } },
      { id: 'settings', label: '设置', url: '/settings', ready: () => page.getByRole('region', { name: '云盘设置' }).waitFor() },
    ]

    const visit = async (route: typeof routes[number]) => {
      await nav.getByRole('button', { name: route.label, exact: true }).click()
      await expect(page).toHaveURL(`${server.baseURL}${route.url}`)
      await route.ready()
    }

    const criticalFindings: Array<Record<string, unknown>> = []
    const viewports = [
      { id: 'desktop', width: 1440, height: 960 },
      { id: 'mobile', width: 390, height: 844 },
    ]
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      for (const appearance of ['light', 'dark'] as const) {
        await visit(routes[3]!)
        await page.getByRole('group', { name: '外观模式' }).getByRole('button', { name: appearance === 'light' ? '浅色' : '深色' }).click()
        for (const route of routes) {
          await visit(route)
          const violations = await audit(route.id, viewport.id, appearance)
          const critical = violations.filter((issue) => criticalImpacts.has(String(issue.impact)))
          if (critical.length) criticalFindings.push({ surface: route.id, viewport: viewport.id, appearance, violations: critical })
          if (viewport.id === 'mobile' && appearance === 'light') {
            await page.screenshot({ path: join(artifacts, `${route.id}-mobile-light.png`), fullPage: true })
          }
        }
      }
    }

    await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
    await page.setViewportSize({ width: 1440, height: 960 })
    for (const route of routes) {
      await visit(route)
      const paletteBehavior = await page.evaluate(() => ({
        forcedColorsActive: matchMedia('(forced-colors: active)').matches,
        reducedMotionActive: matchMedia('(prefers-reduced-motion: reduce)').matches,
        forcedColorAdjustSupported: CSS.supports('forced-color-adjust', 'none'),
        rootColorAdjustment: getComputedStyle(document.documentElement).getPropertyValue('forced-color-adjust') || null,
        optedOutElements: [...document.querySelectorAll<HTMLElement>('*')].filter((element) => getComputedStyle(element).getPropertyValue('forced-color-adjust') === 'none').length,
        navigationTransitionSeconds: (() => {
          const navigationButton = document.querySelector<HTMLElement>('.nav-item')
          if (!navigationButton) return Number.NaN
          const duration = getComputedStyle(navigationButton).transitionDuration.split(',')[0]!.trim()
          const amount = Number.parseFloat(duration)
          return duration.endsWith('ms') ? amount / 1000 : amount
        })(),
      }))
      expect(paletteBehavior.forcedColorsActive).toBe(true)
      expect(paletteBehavior.reducedMotionActive).toBe(true)
      expect(paletteBehavior.optedOutElements).toBe(0)
      expect(paletteBehavior.navigationTransitionSeconds).toBeLessThanOrEqual(0.000011)
      if (paletteBehavior.forcedColorAdjustSupported) expect(paletteBehavior.rootColorAdjustment).toBe('auto')
      systemPreferenceChecks.push({ surface: route.id, ...paletteBehavior })
      const violations = await audit(route.id, 'desktop', 'forced-colors+reduced-motion', true)
      const critical = violations.filter((issue) => criticalImpacts.has(String(issue.impact)))
      if (critical.length) criticalFindings.push({ surface: route.id, viewport: 'desktop', appearance: 'forced-colors+reduced-motion', violations: critical })
    }
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' })

    await visit(routes[3]!)
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.getByRole('group', { name: '外观模式' }).getByRole('button', { name: '浅色' }).click()
    await page.getByLabel('降低透明度').check()
    await page.setViewportSize({ width: 390, height: 844 })
    for (const route of routes) {
      await visit(route)
      const backdropState = await page.locator('.drive-toolbar').evaluate((element) => ({
        standard: getComputedStyle(element).getPropertyValue('backdrop-filter'),
        webkit: getComputedStyle(element).getPropertyValue('-webkit-backdrop-filter'),
      }))
      expect(Object.values(backdropState).filter(Boolean).every((value) => value === 'none')).toBe(true)
      reducedTransparencyChecks.push({ surface: route.id, ...backdropState })
      const violations = await audit(route.id, 'mobile', 'light+reduced-transparency')
      const critical = violations.filter((issue) => criticalImpacts.has(String(issue.impact)))
      if (critical.length) criticalFindings.push({ surface: route.id, viewport: 'mobile', appearance: 'light+reduced-transparency', violations: critical })
      await page.screenshot({ path: join(artifacts, `${route.id}-mobile-solid.png`), fullPage: true })
    }

    await visit(routes[3]!)
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.getByRole('button', { name: '修改密码', exact: true }).last().click()
    const dialog = page.getByRole('dialog', { name: '修改密码' })
    await expect(dialog).toBeVisible()
    const dialogViolations = await audit('settings-password-dialog', 'desktop', 'light')
    const dialogCritical = dialogViolations.filter((issue) => criticalImpacts.has(String(issue.impact)))
    if (dialogCritical.length) criticalFindings.push({ surface: 'settings-password-dialog', viewport: 'desktop', appearance: 'light', violations: dialogCritical })
    await page.getByRole('button', { name: '关闭修改密码对话框' }).click()
    await page.getByLabel('降低透明度').uncheck()

    const report = {
      schemaVersion: 1,
      date: '2026-10-08',
      browser: `Playwright ${browserName}`,
      physicalDevice: false,
      screenReaderTested: false,
      tags: axeTags,
      threshold: 'zero serious or critical axe violations; color-contrast excluded only for forced-colors media emulation because the browser does not apply the OS palette',
      auditCount: captures.length,
      criticalFindingCount: criticalFindings.length,
      captures,
      systemPreferenceChecks,
      reducedTransparencyChecks,
      criticalFindings,
    }
    writeFileSync(join(artifacts, 'accessibility.json'), `${JSON.stringify(report, null, 2)}\n`)
    const conciseFindings = criticalFindings.flatMap((capture) => {
      const meta = `${capture.surface}/${capture.viewport}/${capture.appearance}`
      return (capture.violations as Array<{ id: string; impact: string; nodes: Array<unknown> }>).map((issue) => `${meta}: ${issue.id} (${issue.impact}, ${issue.nodes.length} nodes)`)
    })
    expect(conciseFindings, 'application surfaces must not have serious or critical axe violations').toEqual([])
  } finally {
    await server.close()
  }
})
