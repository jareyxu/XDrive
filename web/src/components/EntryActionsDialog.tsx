import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { DriveEntry } from '../api/client'
export type EntryAction = 'rename' | 'move' | 'parent' | 'trash' | 'download'
export function EntryActionsDialog(props: { entry: DriveEntry; parent: boolean; writeBlocked: boolean; returnFocus: RefObject<HTMLElement | null>; onAction: (action: EntryAction) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = props.returnFocus.current
    const dialog = ref.current
    dialog?.showModal(); dialog?.querySelector<HTMLButtonElement>('header button')?.focus()
    return () => { if (dialog?.open) dialog.close(); if (previous?.isConnected && !previous.matches(':disabled')) previous.focus({ preventScroll: true }) }
  }, [props.returnFocus])
  return <dialog ref={ref} className="move-dialog entry-actions-dialog" aria-label={`项目操作 ${props.entry.name}`} onCancel={event => { event.preventDefault(); props.onClose() }} onKeyDown={event => {
    if (event.key !== 'Tab') return
    const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.disabled)
    event.preventDefault()
    if (!controls.length) return
    const current = controls.findIndex(button => button === document.activeElement)
    const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
    controls[next].focus()
  }}>
    <header><h2>{props.entry.name}</h2><button className="quiet-button" onClick={props.onClose}>关闭</button></header>
    <div>{([['rename', '重命名'], ['move', '移动'], ...(props.parent ? [['parent', '移动到上一级']] : []), ['trash', '移到回收站'], ...(props.entry.kind === 'file' ? [['download', '下载']] : [])] as [EntryAction, string][]).map(([action, label]) => <button key={action} type="button" className={`quiet-button${action === 'trash' ? ' is-danger' : ''}`} disabled={action !== 'download' && props.writeBlocked} onClick={() => props.onAction(action)} aria-label={`${label} ${props.entry.name}`}>{label}</button>)}</div>
  </dialog>
}
