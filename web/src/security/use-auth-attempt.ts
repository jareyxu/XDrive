import { useCallback, useEffect, useRef } from 'react'

// This ref owns cancellation only; passwords and derived keys stay in callers.
export function useAuthAttempt() {
  const current = useRef<AbortController | null>(null)
  const cancel = useCallback(() => { current.current?.abort(); current.current = null }, [])
  const begin = useCallback(() => {
    cancel()
    const controller = new AbortController()
    current.current = controller
    return controller
  }, [cancel])
  const owns = useCallback((controller: AbortController) => current.current === controller && !controller.signal.aborted, [])
  const finish = useCallback((controller: AbortController) => { if (current.current === controller) current.current = null }, [])
  useEffect(() => cancel, [cancel])
  return { begin, cancel, owns, finish }
}
