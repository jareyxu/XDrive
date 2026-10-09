import { useEffect, useRef, useState } from 'react'
import { validRequestId } from '../api/api-error'
import styles from './RequestIdControl.module.css'

export function RequestIdControl({ requestId }: { requestId?: string }) {
  return validRequestId(requestId) ? <CopyRequestId key={requestId} requestId={requestId!} /> : null
}

function CopyRequestId({ requestId }: { requestId: string }) {
  const input = useRef<HTMLInputElement>(null)
  const live = useRef(false)
  const [status, setStatus] = useState('')
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(requestId)
      if (live.current) setStatus('请求编号已复制。')
    } catch {
      if (!live.current) return
      setStatus('无法自动复制，请选中编号后手动复制。')
      input.current?.focus(); input.current?.select()
    }
  }
  return <span className={styles.control}>
    <label className={styles.identifier}>请求编号<input ref={input} aria-label="请求编号" value={requestId} readOnly spellCheck={false} onFocus={event => event.currentTarget.select()} /></label>
    <button type="button" className="quiet-button" onClick={() => void copy()}>复制请求编号</button>
    <span className={styles.status} role="status">{status}</span>
  </span>
}
