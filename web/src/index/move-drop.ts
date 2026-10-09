import type { DirectoryState } from '../api/client'
import type { ZipSelection } from './zip-selection'

export type MoveDropAssessment =
 | { readonly state: 'allowed'; readonly count: number }
 | { readonly state: 'same'; readonly message: string }
 | { readonly state: 'full'; readonly message: string }
 | { readonly state: 'cycle'; readonly message: string }
 | { readonly state: 'conflict'; readonly message: string }

/** Resolve the selected top-level entries without requiring stale parent snapshots. */
export function selectedMoveRoots(selections: readonly ZipSelection[]): readonly ZipSelection[] {
 const folders = selections.flatMap(({ entry, parentIndexId }) => entry.kind === 'folder' && entry.childIndexId
  ? [{ childIndexId: entry.childIndexId, parentIndexId, name: entry.name.normalize('NFC') }]
  : [])
 const unique = new Map<string, ZipSelection>()
 for (const selection of selections) unique.set(selection.entry.entryId, selection)
 return [...unique.values()].filter(selection => {
  const path = selection.parentPath ?? []
  return !folders.some(folder => folder.childIndexId === selection.parentIndexId ||
   path.some(crumb => crumb.indexId === folder.parentIndexId && crumb.name.normalize('NFC') === folder.name))
 })
}

/** Advisory preflight for a folder hover; moveSelectedEntries rechecks the live tree on drop. */
export function assessMoveDrop(target: DirectoryState, selections: readonly ZipSelection[]): MoveDropAssessment {
 const roots = selectedMoveRoots(selections)
 const moving = roots.filter(selection => selection.parentIndexId !== target.indexId)
 if (!moving.length) return { state: 'same', message: '所选项目已在此文件夹中。' }
 const targetAncestors = new Set([target.indexId, ...target.path.map(crumb => crumb.indexId)])
 if (moving.some(({ entry }) => entry.kind === 'folder' && Boolean(entry.childIndexId && targetAncestors.has(entry.childIndexId)))) {
  return { state: 'cycle', message: '不能把文件夹移动到自身或其下级文件夹。' }
 }
 if (target.entries.length + moving.length > 5000) return { state: 'full', message: '目标文件夹已有 5000 项，无法放入。' }
 const names = new Set(target.entries.map(entry => entry.name.normalize('NFC')))
 for (const { entry } of moving) {
  const name = entry.name.normalize('NFC')
  if (names.has(name)) return { state: 'conflict', message: `目标文件夹已有同名项目“${entry.name}”。` }
  names.add(name)
 }
 return { state: 'allowed', count: moving.length }
}
