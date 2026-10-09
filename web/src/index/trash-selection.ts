import type { DirectoryState } from '../api/client'
import type { ZipSelection } from './zip-selection'
/** Entries and paths must be resolved from one globally protected snapshot. */
export function planTrashSelection(selections: readonly ZipSelection[], parents: ReadonlyMap<string, DirectoryState>, currentTrashCount: number) {
 if (!selections.length || selections.length > 250000) throw new TypeError('删除选择为空或超过安全上限。')
 const unique = new Map<string, ZipSelection>()
 for (const selection of selections) {
  const existing = unique.get(selection.entry.entryId)
  if (existing && existing.parentIndexId !== selection.parentIndexId) throw new TypeError('选中项目包含不一致的父目录。')
  const parent = parents.get(selection.parentIndexId)
  if (!parent?.entries.some(entry => entry.entryId === selection.entry.entryId)) throw new TypeError('已选项目已移动、被覆盖或删除，请重新选择。')
  unique.set(selection.entry.entryId, selection)
 }
 const selectedFolders = [...unique.values()].flatMap(({ entry, parentIndexId }) => entry.kind === 'folder' && entry.childIndexId ? [{ id: entry.childIndexId, parentIndexId, name: entry.name.normalize('NFC') }] : [])
 const roots = [...unique.values()].filter(selection => {
  const parent = parents.get(selection.parentIndexId)!
  const folderIdentity = (indexId: string, name: string) => selectedFolders.some(folder => folder.parentIndexId === indexId && folder.name === name.normalize('NFC'))
  // Exact child-index identity is strongest. The encrypted breadcrumb retains
  // the parent/name edge as a second check when a stale snapshot resolves a path.
  return !selectedFolders.some(folder => folder.id === parent.indexId) && !parent.path.some(crumb => folderIdentity(crumb.indexId, crumb.name))
 })
 if (!roots.length) throw new TypeError('选择包含循环或不一致的目录引用。')
 if (currentTrashCount + roots.length > 5000) throw new TypeError('回收站根目录将超过 5000 项上限，请先清理。')
 const removing = new Map<string, Set<string>>()
 for (const selection of roots) { const ids = removing.get(selection.parentIndexId) ?? new Set<string>(); ids.add(selection.entry.entryId); removing.set(selection.parentIndexId, ids) }
 if (removing.size + 1 > 500) throw new TypeError('批量删除超过 500 个索引的原子事务上限，请缩小选择范围。')
 const changes = new Map([...removing].map(([id, ids]) => [id, parents.get(id)!.entries.filter(entry => !ids.has(entry.entryId))] as const))
 return { roots, changes }
}
