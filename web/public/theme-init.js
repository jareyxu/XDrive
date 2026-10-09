/* Same-origin, synchronous head script. Stores only explicitly allowed UI preferences. */
(() => {
  'use strict'
  const key = 'xdrive.preferences.v1'
  const defaults = { theme: 'system', clarity: 0.5, reduceTransparency: false, backupReminderDays: 30, uploadConcurrency: 2, view: 'grid' }
  const normalize = value => {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    return Object.freeze({
      theme: ['system', 'light', 'dark'].includes(source.theme) ? source.theme : defaults.theme,
      clarity: typeof source.clarity === 'number' && Number.isFinite(source.clarity) && source.clarity >= 0 && source.clarity <= 1 ? source.clarity : defaults.clarity,
      reduceTransparency: typeof source.reduceTransparency === 'boolean' ? source.reduceTransparency : defaults.reduceTransparency,
      backupReminderDays: Number.isInteger(source.backupReminderDays) && source.backupReminderDays >= 1 && source.backupReminderDays <= 365 ? source.backupReminderDays : defaults.backupReminderDays,
      view: ['grid', 'list'].includes(source.view) ? source.view : defaults.view,
      uploadConcurrency: Number.isInteger(source.uploadConcurrency) && source.uploadConcurrency >= 2 && source.uploadConcurrency <= 4 ? source.uploadConcurrency : defaults.uploadConcurrency,
    })
  }
  const parse = raw => {
    try { return normalize(typeof raw === 'string' && raw.length <= 4096 ? JSON.parse(raw) : null) } catch { return normalize(null) }
  }
  let persistenceAvailable = true
  let saved
  try { saved = localStorage.getItem(key) } catch { persistenceAvailable = false }
  let preferences = parse(saved)
  let snapshot = Object.freeze({ ...preferences, persistenceAvailable })
  const listeners = new Set()
  const dark = matchMedia('(prefers-color-scheme: dark)')
  const reduced = matchMedia('(prefers-reduced-transparency: reduce)')
  const apply = () => {
    const root = document.documentElement
    root.dataset.theme = preferences.theme === 'system' ? dark.matches ? 'dark' : 'light' : preferences.theme
    root.dataset.reduceTransparency = String(preferences.reduceTransparency || reduced.matches)
    root.style.setProperty('--glass-clarity', String(preferences.clarity))
  }
  const publish = () => {
    snapshot = Object.freeze({ ...preferences, persistenceAvailable })
    apply()
    for (const listener of listeners) listener()
  }
  const set = change => {
    preferences = normalize({ ...preferences, ...change })
    try { localStorage.setItem(key, JSON.stringify(preferences)); persistenceAvailable = true } catch { persistenceAvailable = false }
    publish()
  }
  window.xdrivePreferences = Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    set,
  })
  dark.addEventListener('change', apply)
  reduced.addEventListener('change', apply)
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return
    preferences = parse(event.key === null ? null : event.newValue)
    publish()
  })
  apply()
})()
