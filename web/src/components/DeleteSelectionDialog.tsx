import { useEffect, useRef } from 'react'
import styles from './ConfirmationDialog.module.css'
export function DeleteSelectionDialog(props: { count: number; onConfirm: () => void; onCancel: () => void }) {
 const ref = useRef<HTMLDialogElement>(null)
 useEffect(() => { ref.current?.showModal() }, [])
 return <dialog ref={ref} className={styles.root} aria-labelledby="delete-selection-title" aria-describedby="delete-selection-description" onCancel={event => { event.preventDefault(); props.onCancel() }} onKeyDown={event => {
  if (event.key !== 'Tab') return
  const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')], first = controls[0], last = controls.at(-1)
  if (first && last && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) { event.preventDefault(); (event.shiftKey ? last : first).focus() }
 }}>
  <header><h2 id="delete-selection-title">将所选项目移到回收站</h2></header>
  <p id="delete-selection-description">已选择 {props.count} 项。文件夹及其已选后代合并为一个回收站项目，其余项目各自保留独立恢复入口。</p>
  <p>将在一次事务中移入回收站，并按服务器保留期自动清理。如果项目已被修改、移走或删除，本次操作会停止。</p>
  <footer><button className={`quiet-button ${styles.cancel}`} type="button" autoFocus onClick={props.onCancel}>取消</button><button className={`primary-button ${styles.confirm}`} type="button" onClick={props.onConfirm}>确认移到回收站</button></footer>
 </dialog>
}
