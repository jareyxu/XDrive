import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, Folder, LoaderCircle, RotateCw } from 'lucide-react'
import type { DirectoryState, DriveEntry, UnlockedVault } from '../api/client'
import { loadDirectory } from '../api/client'

interface Props {
  readonly vault: UnlockedVault
  readonly currentIndexId: string
  readonly currentPath: DirectoryState['path']
  readonly onNavigate: (indexId: string, ancestors: readonly string[]) => void
}
type FolderEntry = DriveEntry & { readonly childIndexId: string }
interface TreeRow {
  readonly id: string
  readonly name: string
  readonly indexId: string
  readonly ancestors: readonly string[]
  readonly depth: number
  readonly expanded: boolean
  readonly state?: 'loading' | 'error' | 'empty' | 'depth-limit'
}

export function FolderTree({ vault, currentIndexId, currentPath, onNavigate }: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([vault.rootIndexId]))
  const [directories, setDirectories] = useState<ReadonlyMap<string, readonly FolderEntry[]>>(() => new Map([[vault.rootIndexId, folders(vault.rootEntries)]]))
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set())
  const [errors, setErrors] = useState<ReadonlySet<string>>(() => new Set())
  const [focusedId, setFocusedId] = useState(currentIndexId)
  const controllers = useMemo(() => new Map<string, AbortController>(), [])
  const viewport = useRef<HTMLDivElement>(null)
  const pathTooDeep = currentPath.length > 128
  const ancestors = useMemo(() => pathTooDeep ? [vault.rootIndexId] : [vault.rootIndexId, ...currentPath.slice(1).map(item => item.indexId)], [vault.rootIndexId, currentPath, pathTooDeep])

  useEffect(() => setExpanded(new Set(ancestors)), [ancestors])
  useEffect(() => {
    setDirectories(new Map([[vault.rootIndexId, folders(vault.rootEntries)]]))
    setErrors(new Set())
    setLoading(new Set())
    return () => { for (const controller of controllers.values()) controller.abort(); controllers.clear() }
  }, [vault.rootIndexId, vault.rootRevision, vault.vaultMutationRevision, vault.rootEntries, controllers])

  const read = useCallback(async (indexId: string) => {
    if (directories.has(indexId) || controllers.has(indexId)) return
    const controller = new AbortController()
    controllers.set(indexId, controller)
    setLoading(current => new Set(current).add(indexId))
    setErrors(current => { const next = new Set(current); next.delete(indexId); return next })
    try {
      const directory = await loadDirectory(vault, indexId, [], controller.signal)
      if (!controller.signal.aborted) setDirectories(current => new Map(current).set(indexId, folders(directory.entries)))
    } catch {
      if (!controller.signal.aborted) setErrors(current => new Set(current).add(indexId))
    } finally {
      if (controllers.get(indexId) === controller) controllers.delete(indexId)
      setLoading(current => { const next = new Set(current); next.delete(indexId); return next })
    }
  }, [controllers, directories, vault])

  useEffect(() => {
    if (pathTooDeep) return
    for (const indexId of currentPath.slice(1).map(item => item.indexId)) void read(indexId)
  }, [currentPath, pathTooDeep, read])

  const toggle = (indexId: string) => {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(indexId)) next.delete(indexId)
      else next.add(indexId)
      return next
    })
    if (!directories.has(indexId)) void read(indexId)
  }

  const rows = useMemo(() => {
    const result: TreeRow[] = [{ id: vault.rootIndexId, name: '我的文件', indexId: vault.rootIndexId, ancestors: [], depth: 0, expanded: expanded.has(vault.rootIndexId) }]
    const append = (parentId: string, ancestorsForParent: readonly string[], depth: number) => {
      if (!expanded.has(parentId)) return
      if (loading.has(parentId)) { result.push({ id: `loading:${parentId}`, name: '正在读取…', indexId: parentId, ancestors: ancestorsForParent, depth, expanded: false, state: 'loading' }); return }
      if (errors.has(parentId)) { result.push({ id: `error:${parentId}`, name: '读取失败，按 Enter 重试', indexId: parentId, ancestors: ancestorsForParent, depth, expanded: false, state: 'error' }); return }
      const entries = directories.get(parentId)
      if (!entries) { result.push({ id: `loading:${parentId}`, name: '正在准备目录…', indexId: parentId, ancestors: ancestorsForParent, depth, expanded: false, state: 'loading' }); return }
      if (entries.length === 0) { result.push({ id: `empty:${parentId}`, name: '此文件夹为空', indexId: parentId, ancestors: ancestorsForParent, depth, expanded: false, state: 'empty' }); return }
      for (const entry of entries) {
        if (result.length >= 10_000) {
          result.push({ id: `limit:${parentId}`, name: '文件夹树达到显示上限，请继续使用面包屑浏览', indexId: parentId, ancestors: ancestorsForParent, depth, expanded: false, state: 'depth-limit' })
          return
        }
        const childId = entry.childIndexId
        const childAncestors = [...ancestorsForParent, parentId]
        const isExpanded = expanded.has(childId)
        result.push({ id: childId, name: entry.name, indexId: childId, ancestors: childAncestors, depth, expanded: isExpanded })
        if (isExpanded) {
          if (depth >= 127) result.push({ id: `depth:${childId}`, name: '目录树已达到显示深度，请通过面包屑继续浏览', indexId: childId, ancestors: childAncestors, depth: depth + 1, expanded: false, state: 'depth-limit' })
          else append(childId, childAncestors, depth + 1)
        }
      }
    }
    append(vault.rootIndexId, [], 1)
    if (pathTooDeep) result.splice(1, 0, { id: 'path-depth-limit', name: '当前路径层级较深，请使用面包屑定位父文件夹', indexId: currentIndexId, ancestors: [], depth: 1, expanded: false, state: 'depth-limit' })
    return result
  }, [currentIndexId, directories, errors, expanded, loading, pathTooDeep, vault.rootIndexId])

  const focusIndex = Math.max(0, rows.findIndex(row => row.id === focusedId))
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range)
    if (focusIndex < rows.length && !indexes.includes(focusIndex)) indexes.push(focusIndex)
    return indexes.sort((a, b) => a - b)
  }, [focusIndex, rows.length])
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => viewport.current, estimateSize: () => 34, overscan: 6, rangeExtractor, getItemKey: index => rows[index]!.id, initialRect: { width: 220, height: 460 } })

  const focusRow = (index: number) => {
    if (index < 0 || index >= rows.length) return
    setFocusedId(rows[index]!.id)
    virtualizer.scrollToIndex(index, { align: 'auto' })
    requestAnimationFrame(() => [...(viewport.current?.querySelectorAll<HTMLButtonElement>('.folder-tree-name') ?? [])].find(button => button.closest<HTMLElement>('[data-tree-row]')?.dataset.treeRow === rows[index]!.id)?.focus({ preventScroll: true }))
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.folder-tree-name, .folder-tree-expander, .folder-tree-state')
    if (!target) return
    const id = target.closest<HTMLElement>('[data-tree-row]')?.dataset.treeRow
    const index = rows.findIndex(row => row.id === id)
    if (index < 0) return
    const row = rows[index]!
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusRow(event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'ArrowRight' && row.state === 'error') {
      event.preventDefault(); void read(row.indexId)
    } else if (event.key === 'ArrowRight' && row.indexId && !row.state && !row.expanded) {
      event.preventDefault(); toggle(row.indexId)
    } else if (event.key === 'ArrowRight' && row.expanded) {
      const child = rows[index + 1]
      if (child && child.depth > row.depth) { event.preventDefault(); focusRow(index + 1) }
    } else if (event.key === 'ArrowLeft' && row.expanded) {
      event.preventDefault(); toggle(row.indexId)
    } else if (event.key === 'ArrowLeft') {
      let parentIndex = -1
      for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
        if (rows[candidateIndex]!.depth < row.depth) { parentIndex = candidateIndex; break }
      }
      if (parentIndex >= 0) { event.preventDefault(); focusRow(parentIndex) }
    } else if (event.key === 'Enter' && row.state === 'error') {
      event.preventDefault(); void read(row.indexId)
    }
  }

  return <nav className="folder-tree" aria-label="文件夹">
    <div className="folder-tree-heading">文件夹</div>
    <div ref={viewport} className="folder-tree-scroll" role="tree" aria-label="我的文件夹" onKeyDown={handleKeyDown} onFocusCapture={event => {
      const rowId = (event.target as HTMLElement).closest<HTMLElement>('[data-tree-row]')?.dataset.treeRow
      if (rowId) setFocusedId(rowId)
    }}>
      <div role="presentation" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(item => {
          const row = rows[item.index]!
          const selected = row.id === currentIndexId
          const focused = row.id === focusedId || (!rows.some(candidate => candidate.id === focusedId) && item.index === focusIndex)
          return <div key={row.id} data-tree-row={row.id} role={row.state ? 'presentation' : 'treeitem'} aria-level={row.depth + 1} aria-expanded={!row.state && (row.depth === 0 || directories.has(row.indexId)) ? row.expanded : undefined} aria-selected={selected} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: item.size, transform: `translateY(${item.start}px)` }}>
            {row.state ? <button type="button" className={`folder-tree-state${row.state === 'error' ? ' is-error' : ''}`} tabIndex={focused ? 0 : -1} onFocus={() => setFocusedId(row.id)} onClick={() => row.state === 'error' && void read(row.indexId)}><span aria-hidden="true">{row.state === 'loading' ? <LoaderCircle size={13} /> : row.state === 'error' ? <RotateCw size={13} /> : null}</span>{row.name}</button> : <div className={`folder-tree-row${selected ? ' is-current' : ''}`} style={{ '--tree-depth': row.depth } as CSSProperties}>
              <button className="folder-tree-expander" type="button" tabIndex={focused ? 0 : -1} aria-label={`${row.expanded ? '折叠' : '展开'} ${row.name}`} aria-expanded={row.expanded} onFocus={() => setFocusedId(row.id)} onClick={() => toggle(row.indexId)}>{row.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
              <button className="folder-tree-name" type="button" tabIndex={focused ? 0 : -1} aria-current={selected ? 'page' : undefined} onFocus={() => setFocusedId(row.id)} onClick={() => onNavigate(row.indexId, row.ancestors)}>
                <Folder size={16} aria-hidden="true" /><span>{row.name}</span>
              </button>
            </div>}
          </div>
        })}
      </div>
    </div>
  </nav>
}

function folders(entries: readonly DriveEntry[]): readonly FolderEntry[] {
  return entries.filter((entry): entry is FolderEntry => entry.kind === 'folder' && typeof entry.childIndexId === 'string')
}
