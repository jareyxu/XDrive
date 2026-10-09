import type { DriveEntry } from '../api/client'

export interface ZipSelection {
  readonly entry: DriveEntry
  readonly parentIndexId: string
  readonly parentPath?: readonly { readonly indexId: string; readonly name: string }[]
}
export interface ZipArchiveItem { readonly path: string; readonly entry: DriveEntry; readonly directory: boolean }

export async function planZipSelection(selections: readonly ZipSelection[], read: (id: string) => Promise<readonly DriveEntry[]>, signal?: AbortSignal) {
  if (selections.length === 0 || selections.length > 250_000) throw new TypeError('ZIP 选择为空或超过 250,000 项上限。')
  const roots = new Map<string, ZipSelection>()
  const owners = new Map<string, string>()
  const entriesById = new Map<string, DriveEntry>()
  const folderOwners = new Map<string, string>()
  const indexes = new Map<string, readonly DriveEntry[]>()
  const descendants = new Set<string>()
  const record = (entry: DriveEntry, parent: string) => {
    const prior = owners.get(entry.entryId)
    if (prior && prior !== parent) throw new TypeError('ZIP 目录树存在重复目录项引用。')
    const existing = entriesById.get(entry.entryId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new TypeError('ZIP 目录树包含不一致的目录项。')
    entriesById.set(entry.entryId, entry)
    owners.set(entry.entryId, parent)
    if (owners.size > 250_000) throw new TypeError('ZIP 条目超过当前安全上限。')
    zipPathSegment(entry.name)
    if (entry.kind === 'folder') {
      if (!entry.childIndexId) throw new TypeError('ZIP 文件夹缺少索引。')
      const owner = folderOwners.get(entry.childIndexId)
      if (owner && owner !== entry.entryId) throw new TypeError('ZIP 目录树包含重复文件夹引用。')
      folderOwners.set(entry.childIndexId, entry.entryId)
    }
  }
  for (const selection of selections) {
    record(selection.entry, selection.parentIndexId)
    const prior = roots.get(selection.entry.entryId)
    if (prior && JSON.stringify(prior.entry) !== JSON.stringify(selection.entry)) throw new TypeError('ZIP 选择包含不一致的目录项。')
    roots.set(selection.entry.entryId, selection)
  }
  const pending = [...roots.values()].filter((item) => item.entry.kind === 'folder').map((item) => item.entry.childIndexId!)
  while (pending.length > 0) {
    signal?.throwIfAborted()
    const id = pending.pop()!
    if (indexes.has(id)) continue
    const entries = await read(id)
    if (new Set(entries.map((entry) => entry.entryId)).size !== entries.length) throw new TypeError('ZIP 目录包含重复目录项。')
    indexes.set(id, entries)
    for (const entry of entries) {
      record(entry, id)
      descendants.add(entry.entryId)
      if (entry.kind === 'folder') pending.push(entry.childIndexId!)
    }
  }
  // Detect cycles independently of overlap removal; a selected cyclic root must
  // never disappear from the selection and turn into an apparently empty ZIP.
  const colors = new Map<string, number>()
  for (const root of indexes.keys()) {
    if (colors.get(root) === 2) continue
    const frames = [{ id: root, next: 0 }]
    colors.set(root, 1)
    while (frames.length > 0) {
      signal?.throwIfAborted()
      const frame = frames.at(-1)!
      const child = indexes.get(frame.id)![frame.next++]
      if (!child) { colors.set(frame.id, 2); frames.pop(); continue }
      if (child.kind !== 'folder') continue
      const id = child.childIndexId!
      if (colors.get(id) === 1) throw new TypeError('ZIP 目录树包含循环引用。')
      if (colors.get(id) !== 2) { colors.set(id, 1); frames.push({ id, next: 0 }) }
    }
  }
  const items: ZipArchiveItem[] = []
  const paths = new Set<string>()
  const stack = [...roots.values()].filter((selection) => !descendants.has(selection.entry.entryId)).reverse().map((selection) => ({ entry: selection.entry, prefix: '' }))
  let totalPlaintextBytes = 0
  // ZIP64 end records and archive comment budget, independent of entry count.
  let estimatedArchiveBytes = 128
  while (stack.length > 0) {
    signal?.throwIfAborted()
    const { entry, prefix } = stack.pop()!
    const path = `${prefix}${zipPathSegment(entry.name)}`
    const portable = path.normalize('NFC').toLocaleLowerCase('en-US')
    if (paths.has(portable)) throw new TypeError('ZIP 中存在重复或跨平台大小写冲突的路径，已停止打包以避免覆盖文件。')
    paths.add(portable)
    const directory = entry.kind === 'folder'
    const outputPath = directory ? `${path}/` : path
    const nameBytes = new TextEncoder().encode(outputPath).byteLength
    if (nameBytes > 65535) throw new TypeError('ZIP 路径超过格式长度上限。')
    estimatedArchiveBytes += 2 * nameBytes + 256
    items.push({ path: outputPath, entry, directory })
    if (directory) {
      for (const child of [...indexes.get(entry.childIndexId!)!].reverse()) stack.push({ entry: child, prefix: `${path}/` })
    } else {
      if (!entry.fileId || !entry.manifestObjectId || !entry.manifestSha256 || !Number.isSafeInteger(entry.size) || entry.size === undefined || entry.size < 0) throw new TypeError('ZIP 文件目录项缺少完整性信息。')
      totalPlaintextBytes += entry.size
    }
    if (!Number.isSafeInteger(totalPlaintextBytes) || !Number.isSafeInteger(estimatedArchiveBytes + totalPlaintextBytes)) throw new TypeError('ZIP 总大小超出浏览器安全范围。')
  }
  return { items, totalPlaintextBytes, estimatedArchiveBytes: estimatedArchiveBytes + totalPlaintextBytes }
}

export function zipPathSegment(name: string): string {
  const normalized = name.normalize('NFC')
  const hasControl = [...normalized].some((character) => { const code = character.codePointAt(0)!; return code < 32 || (code >= 127 && code <= 159) })
  if (!normalized || normalized === '.' || normalized === '..' || /^[A-Za-z]:/u.test(normalized) || normalized.endsWith('.') || normalized.endsWith(' ') || normalized.includes('/') || normalized.includes('\\') || hasControl) throw new TypeError('文件名不适合安全地写入 ZIP 路径。')
  return normalized
}
