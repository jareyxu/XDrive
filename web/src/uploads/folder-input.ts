import { associateFolderPath, folderPathOf } from './folder-path'
import { assertFolderNestingDepth, MAX_DIRECTORY_ENTRIES, MAX_FOLDER_UPLOAD_ENTRIES, MAX_FOLDER_UPLOAD_FILES } from './folder-selection'

export interface FileHandleLike {
  readonly kind: 'file'
  readonly name: string
  getFile(): Promise<File>
}

export interface DirectoryHandleLike {
  readonly kind: 'directory'
  readonly name: string
  values(): AsyncIterable<FileHandleLike | DirectoryHandleLike>
}

export type FileSystemHandleLike = FileHandleLike | DirectoryHandleLike

interface WebkitFileEntryLike {
  readonly name: string
  readonly isFile: boolean
  readonly isDirectory: boolean
  file?(success: (file: File) => void, failure?: (error: DOMException) => void): void
  createReader?(): {
    readEntries(success: (entries: WebkitFileEntryLike[]) => void, failure?: (error: DOMException) => void): void
  }
}

interface DataTransferItemLike {
  readonly kind: string
  getAsFile(): File | null
  getAsFileSystemHandle?(): Promise<FileSystemHandleLike | null>
  webkitGetAsEntry?(): WebkitFileEntryLike | null
}

export type DroppedSelection =
  | { readonly kind: 'files'; readonly files: readonly File[] }
  | { readonly kind: 'folder'; readonly files: readonly File[] }

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Folder enumeration cancelled', 'AbortError')
}

function pushFolderFile(files: File[], file: File, path: string): void {
  if (files.length >= MAX_FOLDER_UPLOAD_FILES) {
    throw new TypeError(`所选文件夹超过 ${MAX_FOLDER_UPLOAD_FILES.toLocaleString()} 个文件的安全枚举上限。`)
  }
  associateFolderPath(file, path)
  files.push(file)
}

function countFolderEntry(counter: { value: number }): void {
  counter.value += 1
  if (counter.value > MAX_FOLDER_UPLOAD_ENTRIES) {
    throw new TypeError(`所选文件夹超过 ${MAX_FOLDER_UPLOAD_ENTRIES.toLocaleString()} 个文件与目录项的安全上限。`)
  }
}

export async function enumerateDirectoryHandle(root: DirectoryHandleLike, signal?: AbortSignal): Promise<File[]> {
  if (root.kind !== 'directory' || typeof root.values !== 'function') throw new TypeError('此浏览器无法读取所选文件夹。')
  const files: File[] = []
  const pending: { directory: DirectoryHandleLike; path: string; depth: number }[] = [{ directory: root, path: root.name, depth: 0 }]
  const entryCount = { value: 0 }
  while (pending.length) {
    assertNotAborted(signal)
    const current = pending.pop()!
    let childCount = 0
    for await (const child of current.directory.values()) {
      assertNotAborted(signal)
      childCount += 1
      if (childCount > MAX_DIRECTORY_ENTRIES) throw new TypeError(`文件夹“${current.path}”超过 ${MAX_DIRECTORY_ENTRIES} 个直接子项限制。`)
      countFolderEntry(entryCount)
      if (child.kind === 'directory') {
        const depth = current.depth + 1
        assertFolderNestingDepth(depth)
        pending.push({ directory: child, path: `${current.path}/${child.name}`, depth })
      } else if (child.kind === 'file') {
        const file = await child.getFile()
        assertNotAborted(signal)
        if (file.name !== child.name) throw new TypeError('浏览器返回的文件名与目录项不一致。')
        pushFolderFile(files, file, `${current.path}/${child.name}`)
      } else {
        throw new TypeError('所选文件夹包含不支持的项目。')
      }
    }
  }
  return files.sort((left, right) => folderPathOf(left, left.webkitRelativePath).localeCompare(folderPathOf(right, right.webkitRelativePath)))
}

function readWebkitFile(entry: WebkitFileEntryLike): Promise<File> {
  if (!entry.isFile || typeof entry.file !== 'function') return Promise.reject(new TypeError('浏览器无法读取拖入的文件。'))
  return new Promise((resolve, reject) => entry.file!(resolve, reject))
}

async function readWebkitDirectoryBatch(entry: WebkitFileEntryLike): Promise<WebkitFileEntryLike[]> {
  if (!entry.isDirectory || typeof entry.createReader !== 'function') return Promise.reject(new TypeError('浏览器无法枚举拖入的文件夹。'))
  const reader = entry.createReader()
  const entries: WebkitFileEntryLike[] = []
  while (true) {
    const batch = await new Promise<WebkitFileEntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (batch.length === 0) return entries
    if (entries.length + batch.length > MAX_DIRECTORY_ENTRIES) throw new TypeError(`文件夹“${entry.name}”超过 ${MAX_DIRECTORY_ENTRIES} 个直接子项限制。`)
    entries.push(...batch)
  }
}

export async function enumerateWebkitDirectoryEntry(root: WebkitFileEntryLike, signal?: AbortSignal): Promise<File[]> {
  if (!root.isDirectory) throw new TypeError('拖入的项目不是文件夹。')
  const files: File[] = []
  const pending: { directory: WebkitFileEntryLike; path: string; depth: number }[] = [{ directory: root, path: root.name, depth: 0 }]
  const entryCount = { value: 0 }
  while (pending.length) {
    assertNotAborted(signal)
    const current = pending.pop()!
    const children = await readWebkitDirectoryBatch(current.directory)
    for (const child of children) {
      assertNotAborted(signal)
      countFolderEntry(entryCount)
      const path = `${current.path}/${child.name}`
      if (child.isDirectory) {
        const depth = current.depth + 1
        assertFolderNestingDepth(depth)
        pending.push({ directory: child, path, depth })
      }
      else if (child.isFile) {
        const file = await readWebkitFile(child)
        assertNotAborted(signal)
        if (file.name !== child.name) throw new TypeError('浏览器返回的文件名与目录项不一致。')
        pushFolderFile(files, file, path)
      } else throw new TypeError('拖入的文件夹包含不支持的项目。')
    }
  }
  return files.sort((left, right) => folderPathOf(left, left.webkitRelativePath).localeCompare(folderPathOf(right, right.webkitRelativePath)))
}

function isDirectoryHandle(handle: FileSystemHandleLike | null): handle is DirectoryHandleLike {
  return handle?.kind === 'directory'
}

export async function readDroppedSelection(transfer: DataTransfer, signal?: AbortSignal): Promise<DroppedSelection> {
  assertNotAborted(signal)
  const items: DataTransferItemLike[] = []
  for (let index = 0; index < transfer.items.length; index += 1) {
    const item = transfer.items[index] as DataTransferItemLike | undefined
    if (item?.kind !== 'file') continue
    if (items.length >= MAX_DIRECTORY_ENTRIES) throw new TypeError('一次拖入超过 5000 个文件或目录项，无法放入同一目标目录。')
    items.push(item)
  }
  if (items.length === 0) {
    if (transfer.files.length > MAX_DIRECTORY_ENTRIES) throw new TypeError('一次拖入超过 5000 个文件，无法放入同一目标目录。')
    const files = Array.from(transfer.files)
    if (files.length === 0) throw new TypeError('拖入内容中没有可读取的文件。')
    if (files.some((file) => file.webkitRelativePath)) return { kind: 'folder', files }
    return { kind: 'files', files }
  }

  // Capture drag-only handles and entries synchronously while the DataTransfer
  // item list is still live. The handle API is preferred; WebKit entries are
  // the compatibility path used by Safari and older Chromium versions.
  const captured = items.map((item) => {
    let handle: Promise<FileSystemHandleLike | null> | undefined
    try { handle = item.getAsFileSystemHandle?.() } catch { /* try the WebKit entry or File fallback */ }
    let entry: WebkitFileEntryLike | null = null
    try { entry = item.webkitGetAsEntry?.() ?? null } catch { /* use the File fallback */ }
    let file: File | null = null
    try { file = item.getAsFile() } catch { /* directory entries commonly return null */ }
    return { item, handle, entry, file }
  })

  const resolvedHandles = await Promise.all(captured.map(async (item) => {
    if (!item.handle) return null
    try { return await item.handle } catch { return null }
  }))
  assertNotAborted(signal)

  const directories: (DirectoryHandleLike | WebkitFileEntryLike)[] = []
  const files: File[] = []
  for (let index = 0; index < captured.length; index += 1) {
    const item = captured[index]!
    const handle = resolvedHandles[index]
    if (isDirectoryHandle(handle)) {
      directories.push(handle)
      continue
    }
    const entry = item.entry
    if (entry?.isDirectory) {
      directories.push(entry)
      continue
    }
    if (handle?.kind === 'file') files.push(await handle.getFile())
    else if (entry?.isFile) files.push(await readWebkitFile(entry))
    else if (item.file) files.push(item.file)
  }
  assertNotAborted(signal)

  if (directories.length > 0) {
    if (directories.length !== 1 || files.length > 0 || captured.length !== 1) {
      throw new TypeError('请一次拖入一个文件夹；文件和文件夹请分开拖入。')
    }
    const root = directories[0]!
    const folderFiles = 'kind' in root
      ? await enumerateDirectoryHandle(root as DirectoryHandleLike, signal)
      : await enumerateWebkitDirectoryEntry(root as WebkitFileEntryLike, signal)
    if (folderFiles.length === 0) throw new TypeError('此文件夹没有可上传的文件；浏览器不会提供空目录条目。')
    return { kind: 'folder', files: folderFiles }
  }
  if (files.length === 0) throw new TypeError('浏览器无法读取拖入的文件或文件夹。')
  return { kind: 'files', files }
}
