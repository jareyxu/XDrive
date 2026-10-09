import { useCallback, useEffect, useRef } from 'react'
import { IdleLock } from './idle-lock'
import type { IdleLockTask } from './idle-lock'

export function useIdleLock(enabled: boolean, onLock: () => void): (kind: IdleLockTask) => () => void {
  const controller = useRef<IdleLock | null>(null)
  const callback = useRef(onLock)
  useEffect(() => { callback.current = onLock }, [onLock])
  useEffect(() => {
    if (!enabled) return
    const idle = new IdleLock(() => callback.current())
    controller.current = idle
    const activity = (event: Event) => {
      if (!event.isTrusted) return
      if (!idle.activity()) {
        if (event.cancelable) event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    const check = () => { idle.check() }
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'input'] as const
    for (const event of events) document.addEventListener(event, activity, { capture: true, passive: false })
    document.addEventListener('visibilitychange', check)
    window.addEventListener('pageshow', check)
    window.addEventListener('focus', check)
    return () => {
      idle.dispose()
      if (controller.current === idle) controller.current = null
      for (const event of events) document.removeEventListener(event, activity, true)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('pageshow', check)
      window.removeEventListener('focus', check)
    }
  }, [enabled])
  return useCallback((kind: IdleLockTask) => {
    if (!controller.current) throw new DOMException('Vault context is not unlocked', 'AbortError')
    return controller.current.hold(kind)
  }, [])
}
