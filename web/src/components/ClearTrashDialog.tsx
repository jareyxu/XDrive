import { useEffect, useRef } from 'react'
import styles from './ConfirmationDialog.module.css'

export function ClearTrashDialog(props: { selected?: boolean; count: number; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className={`${styles.root} ${styles.purge}`} aria-labelledby="clear-trash-title" aria-describedby="clear-trash-description" onKeyDown={(event) => {
    if (event.key !== 'Tab') return
    const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')].filter((button) => !button.disabled)
    const first = controls[0], last = controls.at(-1)
    if (first && last && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) {
      event.preventDefault(); (event.shiftKey ? last : first).focus()
    }
  }} onCancel={(event) => { event.preventDefault(); props.onCancel() }}>
    <header><h2 id="clear-trash-title">{props.selected ? '永久删除所选项目' : '清空回收站'}</h2></header>
    <p id="clear-trash-description">将永久删除当前确认的 {props.count} 个顶层项目及其全部后代。此操作无法恢复。</p>
    <p>确认后新移入的项目会保留。如果其他设备恢复了其中的项目，本次操作会停止，请重新确认。</p>
    <footer><button className={`quiet-button ${styles.cancel}`} type="button" autoFocus onClick={props.onCancel}>取消</button><button className={`primary-button is-danger ${styles.confirm}`} type="button" onClick={props.onConfirm}>永久删除这 {props.count} 项</button></footer>
  </dialog>
}
