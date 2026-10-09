import { useEffect, useLayoutEffect, useRef } from 'react'
import type { PointerEvent } from 'react'
interface Hold { id: string; pointer: number; x: number; y: number; timer: ReturnType<typeof setTimeout> | null; held: boolean }
export function useLongPressSelection(context: string, activate: (id: string) => void) {
 const callback = useRef(activate)
 useLayoutEffect(() => { callback.current = activate }, [activate])
 const hold = useRef<Hold | null>(null)
 const suppressed = useRef<{ id: string; until: number } | null>(null)
 const cancel = () => { if (hold.current?.timer) clearTimeout(hold.current.timer); hold.current = null }
 useEffect(() => {
  const clear = () => { cancel(); suppressed.current = null }
  const visibility = () => { if (document.visibilityState !== 'visible') clear() }
  window.addEventListener('blur', clear); document.addEventListener('visibilitychange', visibility)
  return () => { window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', visibility); clear() }
 }, [context])
 return {
  down(event: PointerEvent<HTMLElement>, id: string) {
   if (event.pointerType !== 'touch' || event.isPrimary === false || (event.target as HTMLElement).closest('input, label, .entry-download, .entry-card-more')) return
   cancel(); suppressed.current = null
   const next: Hold = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, timer: null, held: false }
   hold.current = next
   next.timer = setTimeout(() => { if (hold.current !== next) return; next.timer = null; next.held = true; callback.current(id) }, 500)
  },
  move(event: PointerEvent<HTMLElement>) { const current = hold.current; if (current?.pointer === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10) cancel() },
  up(event: PointerEvent<HTMLElement>) { const current = hold.current; if (current?.pointer !== event.pointerId) return; if (current.held) suppressed.current = { id: current.id, until: Date.now() + 1000 }; cancel() },
  cancel,
  consumeClick(id: string) { const current = suppressed.current; if (hold.current?.id === id && hold.current.held) return true; if (!current || current.id !== id || current.until < Date.now()) return false; suppressed.current = null; return true },
  touchContext(id: string) { return hold.current?.id === id || (suppressed.current?.id === id && suppressed.current.until >= Date.now()) },
 }
}
