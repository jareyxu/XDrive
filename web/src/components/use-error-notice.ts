import { useCallback, useState } from 'react'
import { APIError } from '../api/api-error'

// The message and identifier belong to the same caught error. A later local
// error or reset cannot accidentally reuse an unrelated background request ID.
export function useErrorNotice() {
  const [notice, setNotice] = useState<{ message: string; requestId?: string }>({ message: '' })
  const setError = useCallback((next: string | ((current: string) => string), cause?: unknown) => {
    setNotice(current => {
      const message = typeof next === 'function' ? next(current.message) : next
      // A conditional fallback must not replace an earlier, more specific error.
      if (typeof next === 'function' && message === current.message) return current
      return { message, requestId: message && cause instanceof APIError ? cause.requestId : undefined }
    })
  }, [])
  return [notice.message, setError, notice.requestId] as const
}
