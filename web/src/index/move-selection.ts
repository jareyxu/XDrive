import type { DirectoryState, DriveEntry } from '../api/client'
import type { ZipSelection } from './zip-selection'

/** Paths and entries must already have been resolved in one revision snapshot. */
export function planMoveSelection(selections: readonly ZipSelection[], parents: ReadonlyMap<string, DirectoryState>, target: DirectoryState) {
  const unique = new Map<string, ZipSelection>()
  for (const selection of selections) {
    const previous = unique.get(selection.entry.entryId)
    if (previous && previous.parentIndexId !== selection.parentIndexId) throw new TypeError('选中项目包含不一致的父目录。')
    unique.set(selection.entry.entryId, selection)
  }
  if (!unique.size) throw new TypeError('请先选择要移动的项目。')
  const folders = new Set([...unique.values()].flatMap(({ entry }) => entry.kind === 'folder' && entry.childIndexId ? [entry.childIndexId] : []))
  const roots = [...unique.values()].filter((selection) => {
    const parent = parents.get(selection.parentIndexId)
    if (!parent || !parent.entries.some((entry) => entry.entryId === selection.entry.entryId)) throw new TypeError('已选项目已移动、被覆盖或删除，请重新选择。')
    return ![parent.indexId, ...parent.path.map((part) => part.indexId)].some((id) => folders.has(id))
  })
  const moving = roots.filter((selection) => selection.parentIndexId !== target.indexId)
  if (!moving.length) throw new TypeError('所有选中项目已位于目标文件夹。')
  if (target.entries.length + moving.length > 5000) throw new TypeError('目标文件夹将超过 5000 项上限。')
  const names = new Set(target.entries.map((entry) => entry.name.normalize('NFC')))
  const removing = new Map<string, Set<string>>()
  for (const selection of moving) {
    const { entry, parentIndexId } = selection
    if (names.has(entry.name.normalize('NFC'))) throw new TypeError(`目标文件夹已有同名项目“${entry.name}”。`)
    names.add(entry.name.normalize('NFC'))
    if (entry.kind === 'folder' && (!entry.childIndexId || [target.indexId, ...target.path.map((part) => part.indexId)].includes(entry.childIndexId))) throw new TypeError('不能将文件夹移动到自身或其下级文件夹。')
    const ids = removing.get(parentIndexId) ?? new Set<string>()
    ids.add(entry.entryId)
    removing.set(parentIndexId, ids)
  }
  const changes = new Map<string, readonly DriveEntry[]>()
  for (const [parentId, ids] of removing) changes.set(parentId, parents.get(parentId)!.entries.filter((entry) => !ids.has(entry.entryId)))
  changes.set(target.indexId, [...target.entries, ...moving.map((selection) => selection.entry)])
  if (changes.size > 500) throw new TypeError('批量移动超过单次原子事务的 500 个目录上限，请缩小选择范围。')
  return { changes, movedCount: moving.length, moving }
}

export function relocatedMovePath(directory: DirectoryState, target: DirectoryState, moving: readonly ZipSelection[]): DirectoryState['path'] {
  for (const { entry } of moving) {
    if (entry.kind !== 'folder' || !entry.childIndexId) continue
    const prefix = [...target.path, { indexId: target.indexId, name: entry.name }]
    if (directory.indexId === entry.childIndexId) return prefix
    const ancestor = directory.path.findIndex((part) => part.indexId === entry.childIndexId)
    if (ancestor >= 0) return [...prefix, ...directory.path.slice(ancestor)]
  }
  return directory.path
}
