import { useEffect, useId, useRef } from 'react'
import styles from './Breadcrumbs.module.css'

export interface BreadcrumbItem { id: string; name: string; onSelect: () => void }
export function Breadcrumbs(props: { items: BreadcrumbItem[]; label?: string; count?: number }) {
  // A changed path remounts the disclosure: old decrypted ancestors and open
  // state cannot survive a route/scope change.
  return <BreadcrumbPath key={JSON.stringify(props.items.map(item => [item.id, item.name]))} {...props} />
}
function BreadcrumbPath({ items, label = '文件夹路径', count }: { items: BreadcrumbItem[]; label?: string; count?: number }) {
  const disclosure = useRef<HTMLDetailsElement>(null)
  const pointerInside = useRef(false)
  const menuId = useId()
  const folded = items.length > 3 ? items.slice(1, -2) : []
  const visible = folded.length ? [items[0]!, ...items.slice(-2)] : items
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !disclosure.current?.contains(event.target) && disclosure.current) {
        pointerInside.current = false
        disclosure.current.open = false
      }
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  const close = (returnFocus = false) => {
    if (!disclosure.current) return
    disclosure.current.open = false
    if (returnFocus) disclosure.current.querySelector('summary')?.focus()
  }
  return <nav className={`breadcrumbs ${styles.path}`} aria-label={label}>
    <ol className={styles.list}>{visible.map((item, index) => <li className={styles.part} key={item.id}>
      {index > 0 && <span className={styles.separator} aria-hidden="true">/</span>}
      {index === 1 && folded.length > 0 && <>
        <details ref={disclosure} className={styles.disclosure} onPointerDownCapture={() => { pointerInside.current = true }} onPointerCancel={() => { pointerInside.current = false }} onClick={() => { pointerInside.current = false }} onBlur={event => {
          // Safari pointer activation may blur to no focus target before the
          // button click. Hiding now would discard that legitimate activation.
          // Explicit outside pointers and Tab to a known outside target close.
          // Native WebKit dialog focus can also move to DIALOG during an
          // inside pointer activation. The pointer target owns that click.
          if (!pointerInside.current && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close()
        }} onKeyDown={event => {
          pointerInside.current = false
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault(); event.stopPropagation()
          event.currentTarget.open = true
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : current < 0 ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0) : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
          buttons[next]?.focus()
        }}>
          <summary className={styles.toggle} aria-label="展开折叠路径" aria-controls={menuId}>…</summary>
          <ol id={menuId} className={styles.dropdown} aria-label="折叠的上级目录">{folded.map(ancestor => <li key={ancestor.id}><button type="button" title={ancestor.name} onClick={() => { close(); ancestor.onSelect() }}>{ancestor.name}</button></li>)}</ol>
        </details>
        <span className={styles.separator} aria-hidden="true">/</span>
      </>}
      {item === items.at(-1) && index !== 0 ? <span className={styles.current} aria-current="page" title={item.name}>{item.name}</span> : <button type="button" className={styles.ancestor} aria-current={item === items.at(-1) ? 'page' : undefined} title={item.name} onClick={item.onSelect}>{item.name}</button>}
    </li>)}</ol>
    {count !== undefined && <span className={`${styles.count} ${count >= 5000 ? styles.full : count >= 4500 ? styles.warning : ''}`} aria-label={`当前目录 ${count} 项${count >= 5000 ? '，已满' : ''}`}>{count}{count >= 5000 && ' 已满'}</span>}
  </nav>
}
