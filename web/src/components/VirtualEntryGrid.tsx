import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HTMLAttributes, KeyboardEvent, ReactElement } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { gridKeyboardTarget } from '../index/entry-sort'
import styles from './VirtualEntryGrid.module.css'
type CardAttributes = HTMLAttributes<HTMLDivElement> & { 'data-grid-index'?: number }
interface Props<T> { entries: readonly T[]; itemKey(entry: T): string; renderEntry(entry: T): ReactElement<CardAttributes> }
export function VirtualEntryGrid<T>({ entries, itemKey, renderEntry }: Props<T>) {
  'use no memo'
  const viewport = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [compact, setCompact] = useState(() => typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches)
  const [focused, setFocused] = useState(() => entries[0] ? itemKey(entries[0]) : '')
  const index = Math.max(0, entries.findIndex(entry => itemKey(entry) === focused))
  const gap = compact ? 8 : 16
  const columns = compact ? 3 : Math.max(1, Math.floor((width + gap) / (148 + gap)))
  const cardWidth = (width - (columns - 1) * gap) / columns
  const rowHeight = cardWidth + 70 + gap
  const count = Math.ceil(entries.length / columns)
  const focusRow = Math.floor(index / columns)
  useLayoutEffect(() => {
    const query = matchMedia('(max-width: 760px)')
    const update = () => setCompact(query.matches)
    query.addEventListener('change', update)
    const measureWidth = () => { const next = viewport.current?.clientWidth ?? 0; if (next > 0) setWidth(next) }
    const observer = new ResizeObserver(measureWidth)
    if (viewport.current) { measureWidth(); observer.observe(viewport.current) }
    return () => { observer.disconnect(); query.removeEventListener('change', update) }
  }, [])
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const rows = defaultRangeExtractor(range)
    if (focusRow < count && !rows.includes(focusRow)) rows.push(focusRow)
    return rows.sort((a, b) => a - b)
  }, [focusRow, count])
  const virtualizer = useVirtualizer({ count, getScrollElement: () => viewport.current, estimateSize: () => rowHeight, overscan: 2, rangeExtractor, initialRect: { width: 800, height: 400 } })
  useLayoutEffect(() => { virtualizer.measure() }, [rowHeight, virtualizer])
  const frame = useRef<number | null>(null)
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current) }, [])
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.matches('input, textarea, select') || target.isContentEditable || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const source = target.closest<HTMLElement>('[data-grid-index]')
    if (!source) return
    const next = gridKeyboardTarget(event.key, Number(source.dataset.gridIndex), entries.length, columns, Math.max(1, Math.floor((viewport.current?.clientHeight ?? 400) / rowHeight)))
    if (next === null) return
    event.preventDefault(); setFocused(itemKey(entries[next]!)); virtualizer.scrollToIndex(Math.floor(next / columns), { align: 'auto' })
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => { frame.current = null; viewport.current?.querySelector<HTMLElement>(`[data-grid-index="${next}"]`)?.focus({ preventScroll: true }) })
  }
  return <div ref={viewport} className={styles.viewport} role="list" aria-label="文件网格" data-columns={columns} style={{ height: `min(${Math.max(rowHeight, count * rowHeight)}px, max(180px, calc(100dvh - 300px)))` }} onKeyDown={navigate} onFocusCapture={event => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-grid-index]')
    if (card) setFocused(itemKey(entries[Number(card.dataset.gridIndex)]!))
  }}>
    <div role="presentation" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map(row => <div key={row.key} role="presentation" className={styles.row} style={{ transform: `translateY(${row.start}px)`, height: row.size - gap, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap }}>
        {Array.from({ length: Math.min(columns, entries.length - row.index * columns) }, (_, column) => {
          const position = row.index * columns + column
          return cloneElement(renderEntry(entries[position]!), { key: itemKey(entries[position]!), tabIndex: position === index ? 0 : -1, 'data-grid-index': position, 'aria-setsize': entries.length, 'aria-posinset': position + 1 })
        })}
      </div>)}
    </div>
  </div>
}
