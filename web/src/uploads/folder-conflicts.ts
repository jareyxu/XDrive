import { parseFileSelection, parseFolderSelection } from './folder-selection'
import type { FolderRecord, FolderSelection, FolderSource, MergeDirectory, MergeEntry } from './folder-selection'

export type FolderConflictAction = 'overwrite' | 'skip' | 'keep-both'
export interface ConflictEntry extends MergeEntry { readonly entryId: string; readonly fileId?: string; readonly size?: number; readonly manifestSha256?: string }
export interface FolderConflict { readonly path: string; readonly incomingKind: 'file' | 'folder'; readonly incomingSize: number; readonly incomingFileCount: number; readonly existing: ConflictEntry }
export interface FolderConflictFile extends FolderSource { readonly size: number }
export interface PlannedFolderFile<T extends FolderConflictFile> extends FolderRecord<T> {
  readonly sourcePath: string
  readonly targetName: string
  readonly expected: ConflictEntry | null
}
export interface PlannedFolderReplacement { readonly path: string; readonly expected: ConflictEntry }
export function conflictIdentity(entry: ConflictEntry | null): string {
  return entry ? JSON.stringify([entry.entryId, entry.kind, entry.name, entry.fileId, entry.manifestSha256, entry.childIndexId]) : ''
}
export function collectFolderConflicts<T extends FolderConflictFile>(selection: FolderSelection<T>, directories: ReadonlyMap<string, MergeDirectory | null>): readonly FolderConflict[] {
  const conflicts: FolderConflict[] = selection.records.flatMap<FolderConflict>((record) => {
    const parentPath = record.segments.slice(0, -1).join('/')
    const existing = directories.get(parentPath)?.entries.find((entry) => entry.name === record.segments.at(-1)) as ConflictEntry | undefined
    return existing ? [{ path: record.segments.join('/'), incomingKind: 'file' as const, incomingSize: record.file.size, incomingFileCount: 1, existing }] : []
  })
  if (selection.rootName) {
    const existing = directories.get('')?.entries.find((entry) => entry.name === selection.rootName) as ConflictEntry | undefined
    if (existing?.kind === 'file') {
      conflicts.push({ path: selection.rootName, incomingKind: 'folder', incomingSize: selection.records.reduce((sum, record) => sum + record.file.size, 0), incomingFileCount: selection.records.length, existing })
    }
  }
  for (const [parentPath, incoming] of selection.children) {
    for (const [name, kind] of incoming) {
      if (kind !== 'folder') continue
      const existing = directories.get(parentPath)?.entries.find((entry) => entry.name === name) as ConflictEntry | undefined
      if (!existing || existing.kind !== 'file') continue
      const path = parentPath ? `${parentPath}/${name}` : name
      const descendants = selection.records.filter((record) => record.segments.length > path.split('/').length && record.segments.slice(0, path.split('/').length).join('/') === path)
      conflicts.push({ path, incomingKind: 'folder', incomingSize: descendants.reduce((sum, record) => sum + record.file.size, 0), incomingFileCount: descendants.length, existing })
    }
  }
  return conflicts.sort((a, b) => a.path.localeCompare(b.path))
}
export function folderConflictSignature(conflicts: readonly FolderConflict[]): string {
  return JSON.stringify(conflicts.map((item) => [item.path, conflictIdentity(item.existing)]))
}
export function planFolderConflictChoices<T extends FolderConflictFile>(selection: FolderSelection<T>, directories: ReadonlyMap<string, MergeDirectory | null>, choices: ReadonlyMap<string, FolderConflictAction>): { records: readonly PlannedFolderFile<T>[]; skippedPaths: readonly string[]; folderReplacements: readonly PlannedFolderReplacement[] } {
  const conflicts = collectFolderConflicts(selection, directories)
  const conflictPaths = new Set(conflicts.map((item) => item.path))
  if (choices.size !== conflictPaths.size || [...choices].some(([path, action]) => !conflictPaths.has(path) || !['overwrite', 'skip', 'keep-both'].includes(action))) throw new TypeError('上传冲突决定与当前目标不一致，请重新检查。')
  // Reserve every original incoming name, even if skipped: a generated name must
  // not steal the name of another selected file or directory.
  const names = new Map([...selection.children].map(([path, incoming]) => [path, new Set([...incoming.keys(), ...(directories.get(path)?.entries ?? []).map((entry) => entry.name)])]))
  if (selection.rootName) names.set('', new Set([selection.rootName, ...(directories.get('')?.entries ?? []).map((entry) => entry.name)]))
  const skippedPaths: string[] = []
  const skippedFolders: string[] = []
  const folderRenames = new Map<string, string>()
  const folderReplacements: PlannedFolderReplacement[] = []
  for (const conflict of conflicts) {
    if (conflict.incomingKind !== 'folder') continue
    const action = choices.get(conflict.path)
    if (action === 'skip') skippedFolders.push(conflict.path)
    if (action === 'overwrite') folderReplacements.push({ path: conflict.path, expected: conflict.existing })
    if (action === 'keep-both') {
      const segments = conflict.path.split('/')
      const name = segments.pop()!
      const parentPath = segments.join('/')
      const taken = names.get(parentPath)
      if (!taken) throw new TypeError('上传冲突目录状态不完整，请重新检查。')
      let found = false
      for (let number = 1; number <= 5000; number += 1) {
        const candidate = `${name} (${number})`
        if (!taken.has(candidate)) { folderRenames.set(conflict.path, candidate); taken.add(candidate); found = true; break }
      }
      if (!found) throw new TypeError('无法生成唯一文件夹名称，请先清理目标文件夹。')
    }
  }
  const records: PlannedFolderFile<T>[] = []
  for (const record of selection.records) {
    const sourcePath = record.segments.join('/')
    if (skippedFolders.some((path) => sourcePath.startsWith(`${path}/`))) { skippedPaths.push(sourcePath); continue }
    const targetSegments = [...record.segments]
    for (const [folderPath, targetName] of folderRenames) {
      const folderSegments = folderPath.split('/')
      if (targetSegments.length > folderSegments.length && folderSegments.every((segment, index) => targetSegments[index] === segment)) targetSegments[folderSegments.length - 1] = targetName
    }
    const parentPath = record.segments.slice(0, -1).join('/')
    const name = record.segments.at(-1)!
    const existing = directories.get(parentPath)?.entries.find((entry) => entry.name === name) as ConflictEntry | undefined
    const action = choices.get(sourcePath)
    if (action === 'skip') { skippedPaths.push(sourcePath); continue }
    let targetName = name
    if (action === 'keep-both') {
      const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : ''
      const taken = names.get(parentPath)!
      let found = false
      for (let number = 1; number <= 5000; number += 1) {
        const candidate = `${base} (${number})${extension}`
        if (!taken.has(candidate)) { targetName = candidate; taken.add(candidate); found = true; break }
      }
      if (!found) throw new TypeError('无法生成唯一上传名称，请先清理目标文件夹。')
    }
    records.push({ ...record, segments: targetSegments, sourcePath, targetName, expected: action === 'overwrite' ? existing! : null })
  }
  return { records, skippedPaths, folderReplacements }
}
export function plannedFolderSelection<T extends FolderConflictFile>(records: readonly PlannedFolderFile<T>[]): FolderSelection<FolderSource> {
  if (records.length && records[0]!.segments.length === 1) return parseFileSelection(records.map((record) => ({ name: record.targetName, webkitRelativePath: '' })))
  return parseFolderSelection(records.map((record) => ({ name: record.targetName, webkitRelativePath: [...record.segments.slice(0, -1), record.targetName].join('/') })))
}
