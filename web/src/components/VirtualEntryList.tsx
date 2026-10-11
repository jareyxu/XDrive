import { cloneElement, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, HTMLAttributes, KeyboardEvent, ReactElement } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { listKeyboardTarget } from '../index/list-navigation'

interface Props<T> {
  entries: readonly T[]
  itemKey(entry: T): string
  renderEntry(entry: T): ReactElement<HTMLAttributes<HTMLDivElement>>
  label?: string
  className?: string
}
const touchQuery = '(pointer: coarse), (max-width: 760px)'
function currentRowHeight(): number { return typeof matchMedia === 'function' && matchMedia(touchQuery).matches ? 56 : 44 }
export function VirtualEntryList<T>({ entries, itemKey, renderEntry, label = '文件列表', className = '' }: Props<T>) {
  'use no memo' // TanStack Virtual exposes a mutable instance; keep this boundary uncompiled.
  const viewport = useRef<HTMLDivElement>(null)
  const [rowHeight, setRowHeight] = useState(currentRowHeight)
  const [availableHeight, setAvailableHeight] = useState(480)
  const [focusedId, setFocusedId] = useState(() => entries[0] ? itemKey(entries[0]) : '')
  const focusIndex = Math.max(0, entries.findIndex((entry) => itemKey(entry) === focusedId))
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia(touchQuery)
    const changed = () => setRowHeight(query.matches ? 56 : 44)
    query.addEventListener('change', changed)
    return () => query.removeEventListener('change', changed)
  }, [])
  useEffect(() => {
    const element = viewport.current
    const main = element?.closest<HTMLElement>('.drive-main')
    if (!element || !main) return
    const measure = () => {
      const mainRect = main.getBoundingClientRect()
      const listRect = element.getBoundingClientRect()
      setAvailableHeight(Math.max(160, Math.floor(mainRect.bottom - listRect.top - 18)))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(main)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [])
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range)
    if (focusIndex < entries.length && !indexes.includes(focusIndex)) indexes.push(focusIndex)
    return indexes.sort((a, b) => a - b)
  }, [focusIndex, entries.length])
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => rowHeight,
    getItemKey: (index) => itemKey(entries[index]!),
    overscan: 6,
    rangeExtractor,
    initialRect: { width: 1024, height: 400 },
  })
  useEffect(() => { virtualizer.measure() }, [rowHeight, virtualizer])
  const pendingFrame = useRef<number | null>(null)
  useEffect(() => () => { if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current) }, [])
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.matches('input, textarea, select') || target.isContentEditable || event.altKey || event.ctrlKey || event.metaKey) return
    const source = target.closest<HTMLElement>('[data-entry-index]')
    if (!source) return
    const index = Number(source.dataset.entryIndex)
    const next = listKeyboardTarget(event.key, index, entries.length, Math.max(1, Math.floor((viewport.current?.clientHeight ?? 400) / rowHeight)))
    if (next === null) return
    event.preventDefault()
    setFocusedId(itemKey(entries[next]!))
    virtualizer.scrollToIndex(next, { align: 'auto' })
    if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current)
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = null
      viewport.current?.querySelector<HTMLElement>(`[data-entry-index="${next}"] > [role="listitem"]`)?.focus({ preventScroll: true })
    })
  }
  const style = {
    '--entry-row-height': `${rowHeight}px`,
    height: `min(${Math.max(rowHeight, entries.length * rowHeight)}px, ${availableHeight}px)`,
  } as CSSProperties
  return <div ref={viewport} className={`entry-list virtual-entry-list ${className}`} role="list" aria-label={label} style={style} onKeyDown={navigate} onFocusCapture={(event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-entry-index]')
    const index = row ? Number(row.dataset.entryIndex) : -1
    if (index >= 0 && index < entries.length) setFocusedId(itemKey(entries[index]!))
  }}>
    <div role="presentation" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((item) => <div role="presentation" data-entry-index={item.index} key={item.key} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: item.size, transform: `translateY(${item.start}px)` }}>
        {cloneElement(renderEntry(entries[item.index]!), { tabIndex: item.index === focusIndex ? 0 : -1, 'aria-setsize': entries.length, 'aria-posinset': item.index + 1 })}
      </div>)}
    </div>
  </div>
}
