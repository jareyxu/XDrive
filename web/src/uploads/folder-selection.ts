import { folderPathOf } from './folder-path'

export const MAX_FOLDER_UPLOAD_FILES = 250_000
/** Bound the complete selected tree, including directory entries, while preserving the 250,000-file allowance. The selected root itself is excluded. */
export const MAX_FOLDER_UPLOAD_ENTRIES = MAX_FOLDER_UPLOAD_FILES * 2
/** Bound nesting below the selected root; the selected root and leaf file are not included. */
export const MAX_FOLDER_NESTING = 256
export const MAX_DIRECTORY_ENTRIES = 5000
export interface FolderSource { readonly name: string; readonly webkitRelativePath: string }
export interface FolderRecord<T extends FolderSource> { readonly file: T; readonly segments: readonly string[] }
export interface FolderSelection<T extends FolderSource> {
  readonly rootName: string
  readonly records: readonly FolderRecord<T>[]
  readonly children: ReadonlyMap<string, ReadonlyMap<string, 'file' | 'folder'>>
}
export function assertFolderNestingDepth(depth: number): void {
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_FOLDER_NESTING) {
    throw new TypeError(`文件夹路径嵌套超过 ${MAX_FOLDER_NESTING} 层的安全上限。`)
  }
}
export function isValidFileName(name: string): boolean {
  return name.length > 0 && name === name.normalize('NFC') && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !Array.from(name).some((character) => {
    const value = character.codePointAt(0) ?? 0
    return value <= 0x1f || (value >= 0x7f && value <= 0x9f)
  })
}
export function parseFolderSelection<T extends FolderSource>(files: readonly T[]): FolderSelection<T> {
  if (files.length === 0) throw new TypeError('此文件夹没有可上传的文件；浏览器不会提供空目录条目。')
  if (files.length > MAX_FOLDER_UPLOAD_FILES) throw new TypeError('所选文件夹超过 250,000 个文件的安全枚举上限。')
  const children = new Map<string, Map<string, 'file' | 'folder'>>()
  // Reuse each implied directory's canonical path across files. Without this
  // cache, a deep tree rebuilds every ancestor prefix for every leaf file.
  const directoryPaths = new Map<string, Map<string, string>>()
  let rootName = ''
  let entryCount = 0
  const records = files.map((file) => {
    const path = folderPathOf(file, file.webkitRelativePath)
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')) throw new TypeError('当前浏览器没有提供安全的文件夹相对路径。')
    let separatorCount = 0
    for (let index = 0; index < path.length; index += 1) {
      if (path.charCodeAt(index) === 47) separatorCount += 1
    }
    // One separator separates the selected root from the file. Every extra
    // separator represents one directory level below the selected root.
    assertFolderNestingDepth(separatorCount - 1)
    const segments = path.split('/').map((part) => part.normalize('NFC'))
    if (segments.length < 2 || segments.some((part) => !isValidFileName(part))) throw new TypeError('文件夹路径包含无效名称。')
    if (typeof file.name !== 'string' || file.name.normalize('NFC') !== segments.at(-1)) throw new TypeError('文件名与浏览器提供的相对路径不一致。')
    if (!rootName) rootName = segments[0]!
    if (segments[0] !== rootName) throw new TypeError('一次只能上传一个所选文件夹。')
    let parent = segments[0]!
    for (let index = 1; index < segments.length; index += 1) {
      const parentPath = parent
      const name = segments[index]!
      const kind = index === segments.length - 1 ? 'file' : 'folder'
      const items = children.get(parentPath) ?? new Map<string, 'file' | 'folder'>()
      const prior = items.get(name)
      if (prior && prior !== kind) throw new TypeError(`所选路径“${[...segments.slice(0, index), name].join('/')}”同时表示文件和文件夹。`)
      if (prior === 'file') throw new TypeError(`所选文件包含规范化后重复的路径“${segments.join('/')}”。`)
      if (prior === undefined) {
        entryCount += 1
        if (entryCount > MAX_FOLDER_UPLOAD_ENTRIES) throw new TypeError(`所选文件夹超过 ${MAX_FOLDER_UPLOAD_ENTRIES.toLocaleString()} 个文件与目录项的安全上限。`)
        items.set(name, kind)
        if (kind === 'folder') {
          const childPath = `${parentPath}/${name}`
          const paths = directoryPaths.get(parentPath) ?? new Map<string, string>()
          paths.set(name, childPath)
          directoryPaths.set(parentPath, paths)
          parent = childPath
        }
      } else if (kind === 'folder') {
        const childPath = directoryPaths.get(parentPath)?.get(name)
        if (!childPath) throw new TypeError('所选文件夹路径状态无效。')
        parent = childPath
      }
      children.set(parentPath, items)
      if (items.size > MAX_DIRECTORY_ENTRIES) throw new TypeError(`文件夹“${parentPath}”超过 5000 个直接子项限制。`)
    }
    return { file, segments }
  }).sort((a, b) => a.segments.join('/').localeCompare(b.segments.join('/')))
  return { rootName, records, children }
}
/** A flat picker batch targets the existing directory; it creates no wrapper. */
export function parseFileSelection<T extends FolderSource>(files: readonly T[]): FolderSelection<T> {
  if (!files.length) throw new TypeError('请选择要上传的文件。')
  if (files.length > MAX_DIRECTORY_ENTRIES) throw new TypeError('一次选择超过 5000 个文件，无法放入同一目标目录。')
  const children = new Map<string, 'file' | 'folder'>()
  const records = files.map((file) => {
    const name = file.name.normalize('NFC')
    if (!isValidFileName(name) || folderPathOf(file, file.webkitRelativePath)) throw new TypeError('直接选择的文件包含无效名称或文件夹路径。')
    if (children.has(name)) throw new TypeError(`所选文件包含规范化后重复的名称“${name}”。请分别上传或先修改原文件名。`)
    children.set(name, 'file')
    return { file, segments: [name] }
  }).sort((a, b) => a.segments[0]!.localeCompare(b.segments[0]!))
  return { rootName: '', records, children: new Map([['', children]]) }
}
export interface MergeEntry { readonly kind: 'file' | 'folder'; readonly name: string; readonly childIndexId?: string }
export interface MergeDirectory { readonly indexId: string; readonly entries: readonly MergeEntry[]; readonly path: readonly { indexId: string; name: string }[] }
export async function validateFolderMerge<T extends FolderSource>(selection: FolderSelection<T>, destination: MergeDirectory, load: (id: string, path: MergeDirectory['path']) => Promise<MergeDirectory>, signal?: AbortSignal, enforceCapacity = true, allowTypeConflict = false): Promise<ReadonlyMap<string, MergeDirectory | null>> {
  signal?.throwIfAborted()
  const root = selection.rootName ? destination.entries.find((entry) => entry.name === selection.rootName) : undefined
  if (root && root.kind !== 'folder' && !allowTypeConflict) throw new TypeError(`目标位置已有名为“${selection.rootName}”的文件。`)
  if (enforceCapacity && selection.rootName && !root && destination.entries.length >= MAX_DIRECTORY_ENTRIES) throw new TypeError('目标目录已达到 5000 项上限，无法创建所选文件夹。')
  const directories = new Map<string, MergeDirectory | null>()
  // The empty key always denotes the selected folder's containing directory.
  // Keep it for root-name conflicts as well as flat multi-file selections.
  directories.set('', destination)
  directories.set(selection.rootName, selection.rootName === '' ? destination : root?.childIndexId ? await load(root.childIndexId, [...destination.path, { indexId: destination.indexId, name: selection.rootName }]) : null)
  // Selection construction inserts ancestors before descendants. Missing directories
  // are planned only; no upload session or metadata pointer is created here.
  for (const [path, incoming] of selection.children) {
    signal?.throwIfAborted()
    const existing = directories.get(path)
    const existingByName = new Map((existing?.entries ?? []).map((entry) => [entry.name, entry]))
    const names = new Set([...existingByName.keys(), ...incoming.keys()])
    if (enforceCapacity && names.size > MAX_DIRECTORY_ENTRIES) throw new TypeError(`合并后文件夹“${path}”将超过 5000 个直接子项限制。`)
    for (const [name, kind] of incoming) {
      const entry = existingByName.get(name)
      if (entry && entry.kind !== kind && !allowTypeConflict) throw new TypeError(`路径“${path}/${name}”与现有${entry.kind === 'file' ? '文件' : '文件夹'}冲突。`)
      if (kind === 'folder') {
        directories.set(`${path}/${name}`, entry?.childIndexId && existing ? await load(entry.childIndexId, [...existing.path, { indexId: existing.indexId, name }]) : null)
      }
    }
  }
  return directories
}
