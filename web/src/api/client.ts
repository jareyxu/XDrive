import { APIError, parseAPIError } from './api-error'
export { APIError } from './api-error'
import { CLIENT_PROTOCOL_VERSION } from './protocol'
import { createBoundedBlobOutput } from '../downloads/bounded-blob-output'
import { planTrashSelection } from '../index/trash-selection'
import { generateThumbnail } from '../media/generate-thumbnail'
import { isThumbnailReference, imageDimensions, type SavedThumbnail, type ThumbnailReference } from '../media/thumbnail-schema'
import { runBoundedTasks, createWriteAheadQueue } from '../uploads/bounded-tasks'
import { currentUploadConcurrency } from '../preferences/preferences'
import { isValidFileName as isValidName, parseFileSelection, parseFolderSelection, validateFolderMerge } from '../uploads/folder-selection'
import { collectFolderConflicts, conflictIdentity, folderConflictSignature, planFolderConflictChoices, plannedFolderSelection } from '../uploads/folder-conflicts'
import type { FolderConflict, FolderConflictAction, ConflictEntry } from '../uploads/folder-conflicts'
import { browserMutations } from '../index/browser-coordination'
import { planMoveSelection, relocatedMovePath } from '../index/move-selection'
import { planZipSelection } from '../index/zip-selection'
import type { ZipSelection } from '../index/zip-selection'
import { openAbortableOutput } from '../downloads/abortable-output'
import { chunkAAD, indexAAD, manifestAAD, thumbnailAAD } from '../crypto/aad'
import { sha256Hex } from '../crypto/digest'
import { parseStrictJson } from '../crypto/strict-json'
import { decodeBase64Strict, encodeBase64, takeArrayBufferBytes, utf8Strict } from '../crypto/encoding'
import { decryptObject, encryptObject } from '../crypto/envelope'
import {
  createPasswordKDF,
  deriveDataKey,
  deriveFileKey,
  deriveIndexId,
  derivePasswordMaterials,
  deriveThumbnailKey,
  deriveVaultKey,
  importVaultKey,
  unwrapVaultKey,
  unwrapVaultKeyBytes,
  wrapVaultKey,
} from '../crypto/keys'
import { ENVELOPE_OVERHEAD_BYTES, FILE_CHUNK_BYTES, MAX_CLIENT_FILE_CHUNK_BYTES } from '../crypto/constants'
import type { Argon2idParams } from '../crypto/constants'
import type { VaultConfigV1 } from '../crypto/keys'
import { assertPasswordLength } from '../crypto/kdf'
import { assertOriginalFile, deleteUploadRecord, fingerprintFile, listUploadRecords, saveUploadRecord } from '../uploads/resume'
import type { UploadPiece, UploadResumeRecord } from '../uploads/resume'
import { observeRevisionBaseline, recordRevisionMaxima, replaceRevisionBaseline } from '../security/revision-baseline'
import type { RevisionObservation, RollbackFinding } from '../security/revision-baseline'

import { createChunkRangeReader } from '../media/chunk-range-reader'
import { ConcurrentMutationRetryExhaustedError, retryTraversalMutation } from '../index/traversal-retry'
import { NetworkUnavailableError, retryNetworkRequest } from './network-retry'

let csrfToken = ''
let revisionScope: string | null = null
let revisionEpoch = 0
let revisionWarning: string | null = null
const revisionListeners = new Set<(warning: string | null) => void>()

export function subscribeRevisionWarning(listener: (warning: string | null) => void): () => void {
  revisionListeners.add(listener)
  return () => { revisionListeners.delete(listener) }
}

export function getRevisionWarning(): string | null { return revisionWarning }

export function clearRevisionContext(): void {
  browserMutations.reset()
  revisionEpoch += 1
  revisionScope = null
  setRevisionWarning(null)
}

function setRevisionWarning(warning: string | null): void {
  if (revisionWarning === warning) return
  revisionWarning = warning
  revisionListeners.forEach((listener) => listener(warning))
}

function describeRollback(finding: RollbackFinding): string {
  const target = finding.kind === 'config' ? 'Vault 配置' : finding.kind === 'vault' ? '云盘全局版本' : `目录索引 ${finding.metadataId}`
  return `检测到服务器数据可能发生回退：${target} 当前版本 ${finding.revision}，本设备曾见版本 ${finding.maximumSeen}。`
}

async function checkCurrentRevisions(observations: readonly RevisionObservation[], epoch = revisionEpoch): Promise<void> {
  if (epoch !== revisionEpoch) return
  if (!revisionScope || revisionWarning) return
  const scope = revisionScope
  try {
    const finding = await observeRevisionBaseline(scope, observations)
    if (epoch === revisionEpoch && finding) setRevisionWarning(describeRollback(finding))
  } catch {
    if (epoch === revisionEpoch) setRevisionWarning('无法读取或保存本设备的版本基线。为保护数据，已暂停写入。')
  }
}

async function recordCommittedRevisions(observations: readonly RevisionObservation[], scope: string | null = revisionScope): Promise<void> {
  if (!scope || (scope === revisionScope && revisionWarning)) return
  const epoch = revisionEpoch
  try { await recordRevisionMaxima(scope, observations) }
  catch { if (epoch === revisionEpoch && scope === revisionScope) setRevisionWarning('无法保存本设备的版本基线。为保护数据，已暂停写入。') }
}

function assertRevisionWritable(path: string): void {
  if (revisionWarning && path !== '/api/v1/auth/unlock' && path !== '/api/v1/auth/logout') {
    throw new TypeError('检测到服务器数据可能发生回退；确认合法恢复并重新认证前，写入已暂停。')
  }
}

export interface DriveEntry {
  readonly entryId: string
  readonly kind: 'file' | 'folder'
  readonly name: string
  readonly originalModifiedAt?: number
  readonly createdAt?: number
  readonly size?: number
  readonly mime?: string
  readonly childIndexId?: string
  readonly fileId?: string
  readonly fileCryptoVersion?: 1 | 2
  readonly manifestObjectId?: string
  readonly manifestSha256?: string
  readonly thumbnail?: ThumbnailReference | null
}

export interface UnlockedVault {
  readonly vaultKey: CryptoKey
  readonly dataKey: CryptoKey
  readonly metadataKey: CryptoKey
  readonly rootIndexId: string
  readonly trashIndexId: string
  readonly trashEntries: readonly TrashRootEntry[]
  readonly trashRevision: number
  readonly rootEntries: readonly DriveEntry[]
  readonly username: string
  readonly vaultConfig: VaultConfigV1
  readonly rootRevision: number
  readonly vaultMutationRevision: number
}

export interface TrashPathPart {
  readonly indexId: string
  readonly childIndexId: string
  readonly name: string
}

export interface TrashRootEntry {
  readonly tombstoneId: string
  readonly item: DriveEntry
  readonly originalParentId: string
  readonly originalPath: readonly TrashPathPart[]
  readonly deletedAt: number
}

export interface StorageUsage {
  readonly quotaBytes: number
  readonly usedBytes: number
  readonly reservedBytes: number
  readonly uploadReservedBytes?: number
  readonly maintenanceReservedBytes?: number
  readonly maintenanceCapacityBytes?: number
  readonly trashBytes: number
  readonly pendingBytes: number
  readonly freeDiskBytes: number
  readonly availableBytes: number
  readonly backupWarnAfterDays: number
  readonly lastBackupAt: number | null
}

export interface UploadTransferProgress {
  readonly phase: 'preparing' | 'encrypting' | 'uploading' | 'waiting-network' | 'committing'
  readonly completedBytes: number
  readonly totalBytes: number
}

export type UploadProgressListener = (completedSteps: number, totalSteps: number, transfer?: UploadTransferProgress) => void

export interface FolderUploadProgress {
  readonly phase: UploadTransferProgress['phase']
  readonly completedBytes: number
  readonly totalBytes: number
  readonly currentFileName?: string
}

export type FolderUploadProgressListener = (completedFiles: number, totalFiles: number, transfer?: FolderUploadProgress) => void

export interface DirectoryState {
  readonly indexId: string
  readonly revision: number
  readonly entries: readonly DriveEntry[]
  readonly path: readonly { readonly indexId: string; readonly name: string }[]
}

export async function loadDirectory(vault: UnlockedVault, indexId: string, path: DirectoryState['path'] = [], signal?: AbortSignal): Promise<DirectoryState> {
  throwIfAborted(signal)
  if (indexId === vault.rootIndexId) return { indexId, revision: vault.rootRevision, entries: vault.rootEntries, path }
  const loaded = await fetchIndex(vault.metadataKey, indexId, signal)
  return { indexId, revision: loaded.revision, entries: loaded.entries, path }
}

class DirectoryRouteChangedError extends Error {}

/** Resolve only active root-reachable indexes; neither URL nor history is authority. */
export async function resolveDirectoryRoute(vault: Pick<UnlockedVault, 'rootIndexId' | 'metadataKey'>, indexId: string, ancestors: readonly string[] = [], signal?: AbortSignal): Promise<DirectoryState> {
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(indexId) || ancestors.length > 250_000 || ancestors.some(id => !/^[A-Za-z0-9_-]{16,64}$/u.test(id))) throw new TypeError('无效的文件夹地址。')
  const readRevision = async () => {
    const state = await request<{ vaultMutationRevision: number }>('/api/v1/vault/state', signal)
    if (!Number.isSafeInteger(state.vaultMutationRevision) || state.vaultMutationRevision < 0) throw new TypeError('无效的云盘版本。')
    return state.vaultMutationRevision
  }
  return retryTraversalMutation(async () => {
    const before = await readRevision()
    const root = await fetchIndex(vault.metadataKey, vault.rootIndexId, signal)
    const current = { ...vault, rootEntries: root.entries, rootRevision: root.revision, vaultMutationRevision: before }
    let directory: DirectoryState
    try {
      directory = await locateActiveDirectory(current, { indexId, path: ancestors.map(id => ({ indexId: id, name: '' })) }, signal)
    } catch (cause) {
      throwIfAborted(signal)
      if (await readRevision() !== before) throw new DirectoryRouteChangedError()
      throw cause
    }
    if (await readRevision() !== before) throw new DirectoryRouteChangedError()
    throwIfAborted(signal)
    return directory
  }, cause => cause instanceof DirectoryRouteChangedError, signal)
}

export async function reloadDirectory(vault: UnlockedVault, directory: DirectoryState, signal?: AbortSignal): Promise<DirectoryState> {
  throwIfAborted(signal)
  const loaded = await fetchIndex(vault.metadataKey, directory.indexId, signal)
  return { ...directory, revision: loaded.revision, entries: loaded.entries }
}

async function deleteEntryCore(vault: UnlockedVault, directory: DirectoryState, entryId: string, signal?: AbortSignal): Promise<{ vault: UnlockedVault; directory: DirectoryState }> {
 const entry = directory.entries.find(item => item.entryId === entryId)
 if (!entry) throw new TypeError('此项目已不存在，请刷新目录。')
 const result = await deleteSelectedEntriesCore(vault, [{ entry, parentIndexId: directory.indexId, parentPath: directory.path }], signal)
 return { vault: result.vault, directory: result.directories.get(directory.indexId)! }
}

async function deleteSelectedEntriesCore(vault: UnlockedVault, selections: readonly ZipSelection[], signal?: AbortSignal) {
 if (!selections.length || selections.length > 250000) throw new TypeError('删除选择为空或超过安全上限。')
 return retryTraversalMutation(async () => {
  const current = await refreshVaultFromServer(vault, signal), parents = new Map<string, DirectoryState>(), resolved: ZipSelection[] = []
  let snapshotBytes = 0
  for (const selection of selections) {
   throwIfAborted(signal)
   let parent = parents.get(selection.parentIndexId)
   if (!parent) {
    if (parents.size >= 499) throw new TypeError('批量删除检查超过 499 个父目录，请缩小选择范围。')
    parent = await locateActiveDirectory(current, { indexId: selection.parentIndexId, path: selection.parentPath ?? [] }, signal)
    const measure = utf8Strict(JSON.stringify(parent.entries)); snapshotBytes += measure.byteLength; measure.fill(0)
    if (snapshotBytes > 32 * 1024 * 1024) throw new TypeError('批量删除目录检查超过 32 MiB 安全预算，请缩小选择范围。')
    parents.set(parent.indexId, parent)
   }
   const entry = parent.entries.find(item => item.entryId === selection.entry.entryId)
   if (!entry || conflictIdentity(entry) !== conflictIdentity(selection.entry)) throw new TypeError('已选项目已改名、移动、被覆盖或删除，请重新选择。')
   resolved.push({ entry, parentIndexId: parent.indexId, parentPath: parent.path })
  }
  const plan = planTrashSelection(resolved, parents, current.trashEntries.length)
  const builds: { buildId: string; tombstoneId: string }[] = []
  const newRoots: TrashRootEntry[] = [], allMembers = new Set<string>()
  const prepared: { id: string; revision: number; entries: readonly DriveEntry[] | readonly TrashRootEntry[]; objectId: string; envelope: Uint8Array }[] = []
  let uploadId = '', commitStarted = false
  try {
   for (const selection of plan.roots) {
    throwIfAborted(signal)
    const { buildId } = await post<{ buildId: string }>('/api/v1/tombstone-builds', { expectedGlobalRevision: current.vaultMutationRevision }, true, undefined, signal)
    const tombstoneId = randomObjectId(); builds.push({ buildId, tombstoneId })
    const members = await collectTombstoneMembers(current, selection.entry, signal)
    const batch: { type: 'object' | 'metadata'; id: string }[] = []
    for (const [key, type] of members) {
     if (allMembers.has(key)) throw new TypeError('选中子树包含重叠对象或索引，请刷新后重试。')
     allMembers.add(key); if (allMembers.size > 250000) throw new TypeError('批量删除成员超过 250,000 安全上限，请缩小选择范围。')
     batch.push({ type, id: key.slice(key.indexOf(':') + 1) })
     if (batch.length === 500) await post(`/api/v1/tombstone-builds/${encodeURIComponent(buildId)}/members`, { members: batch.splice(0) }, true, undefined, signal)
    }
    if (batch.length) await post(`/api/v1/tombstone-builds/${encodeURIComponent(buildId)}/members`, { members: batch }, true, undefined, signal)
    const parent = parents.get(selection.parentIndexId)!
    newRoots.push({ tombstoneId, item: selection.entry, originalParentId: parent.indexId, originalPath: parent.path.map((crumb, index) => ({ indexId: crumb.indexId, name: crumb.name, childIndexId: parent.path[index + 1]?.indexId ?? parent.indexId })), deletedAt: Date.now() })
   }
   const trashEntries = [...current.trashEntries, ...newRoots]
   const candidates = [...plan.changes].map(([id, entries]) => ({ id, revision: parents.get(id)!.revision, entries: entries as readonly DriveEntry[] | readonly TrashRootEntry[] }))
   candidates.push({ id: current.trashIndexId, revision: current.trashRevision, entries: trashEntries })
   let reservedBytes = 0
   for (const candidate of candidates) {
    throwIfAborted(signal)
    const plaintext = utf8Strict(JSON.stringify({ version: 1, indexId: candidate.id, entries: candidate.entries })), aad = indexAAD(candidate.id, candidate.revision + 1)
    try {
     if (plaintext.byteLength + ENVELOPE_OVERHEAD_BYTES > 4 * 1024 * 1024) throw new TypeError('单个目录索引超过 4 MiB 限制。')
     if (reservedBytes + plaintext.byteLength + ENVELOPE_OVERHEAD_BYTES > 32 * 1024 * 1024) throw new TypeError('批量删除加密索引超过 32 MiB 安全预算，请缩小选择范围。')
     const envelope = await encryptObject(current.metadataKey, plaintext, aad); reservedBytes += envelope.byteLength
     prepared.push({ ...candidate, objectId: randomObjectId(), envelope })
    } finally { plaintext.fill(0); aad.fill(0) }
   }
   const session = await post<{ uploadId: string }>('/api/v1/uploads', {}, true, undefined, signal); uploadId = session.uploadId
   let maintenance = false
   try { await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/reserve`, { reservedBytes }, true, undefined, signal) }
   catch (error) {
    if (!(error instanceof APIError) || error.status !== 507 || error.code !== 'quota_exceeded') throw error
    await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/abandon`, {}, true, undefined, signal); uploadId = ''; maintenance = true
    if (reservedBytes > 8 * 1024 * 1024) throw new TypeError('批量删除超过满配额维护的 8 MiB 上限，请缩小选择范围或先清理回收站。')
   }
   if (!maintenance) for (const item of prepared) await putEncryptedObject(uploadId, item.objectId, item.envelope, await sha256Hex(item.envelope), signal)
   throwIfAborted(signal); commitStarted = true
   const lifecycle = { expectedGlobalRevision: current.vaultMutationRevision, updates: prepared.map(item => ({ metadataId: item.id, expectedRevision: item.revision, objectId: item.objectId })), ...(builds.length === 1 ? { finalizeTombstoneBuildId: builds[0]!.buildId, createTombstoneId: builds[0]!.tombstoneId } : { finalizeTombstoneBuilds: builds }) }
   const result = await postIdempotentWithRetry<{ vaultMutationRevision: number }>(maintenance ? { ...lifecycle, encryptedObjects: prepared.map(item => encodeBase64(item.envelope)) } : { ...lifecycle, uploadId, activateObjectIds: prepared.map(item => item.objectId) }, randomObjectId(), signal, maintenance ? '/api/v1/metadata/maintenance-trash' : '/api/v1/metadata/transactions')
   let updated = { ...current, trashEntries, trashRevision: current.trashRevision + 1, vaultMutationRevision: result.vaultMutationRevision }
   const directories = new Map(parents)
   for (const [id, entries] of plan.changes) {
    const parent = parents.get(id)!; directories.set(id, { ...parent, entries, revision: parent.revision + 1 })
    if (id === current.rootIndexId) updated = { ...updated, rootEntries: entries, rootRevision: parent.revision + 1 }
   }
   return { vault: updated, directories, deletedCount: plan.roots.length, deletedFolderIds: plan.roots.flatMap(({ entry }) => entry.kind === 'folder' && entry.childIndexId ? [entry.childIndexId] : []) }
  } catch (error) {
   if (signal?.aborted || error instanceof APIError && error.status >= 400 && error.status < 500) commitStarted = false
   if (!commitStarted) {
    if (uploadId) try { await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/abandon`, {}, true) } catch { /* Expiry releases pending objects. */ }
    for (const build of builds) try { await requestWithInit<void>(`/api/v1/tombstone-builds/${encodeURIComponent(build.buildId)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } }) } catch { /* Staging expires. */ }
   }
   throw error
  } finally { for (const item of prepared) item.envelope.fill(0) }
 }, error => error instanceof APIError && error.status === 409 && ['global_revision_conflict', 'vault_mutation_conflict', 'metadata_revision_conflict'].includes(error.code), signal)
}

async function locateActiveDirectory(vault: Pick<UnlockedVault, 'rootIndexId' | 'rootRevision' | 'rootEntries' | 'metadataKey'>, previous: Pick<DirectoryState, 'indexId' | 'path'>, signal?: AbortSignal): Promise<DirectoryState> {
  const root: DirectoryState = { indexId: vault.rootIndexId, revision: vault.rootRevision, entries: vault.rootEntries, path: [] }
  if (root.indexId === previous.indexId) return root
  const childOf = async (parent: DirectoryState, entry: DriveEntry): Promise<DirectoryState> => {
    const loaded = await fetchIndex(vault.metadataKey, entry.childIndexId!, signal)
    return { indexId: entry.childIndexId!, ...loaded, path: [...parent.path, { indexId: parent.indexId, name: entry.name }] }
  }
  // Revalidate each edge by ID, retaining current names. The common path only
  // reads ancestors; a moved ancestor falls back to a bounded active-tree search.
  let candidate = root
  for (let index = 0; index < previous.path.length; index += 1) {
    throwIfAborted(signal)
    const expectedId = previous.path[index + 1]?.indexId ?? previous.indexId
    const edge = candidate.entries.find((entry) => entry.kind === 'folder' && entry.childIndexId === expectedId)
    if (!edge) break
    candidate = await childOf(candidate, edge)
    if (candidate.indexId === previous.indexId) return candidate
  }
  const frames: { directory: DirectoryState; next: number }[] = [{ directory: root, next: 0 }]
  const visited = new Set<string>([root.indexId])
  while (frames.length > 0) {
    throwIfAborted(signal)
    const frame = frames.at(-1)!
    const entry = frame.directory.entries[frame.next++]
    if (!entry) { frames.pop(); continue }
    if (entry.kind !== 'folder' || !entry.childIndexId) continue
    if (visited.has(entry.childIndexId)) throw new TypeError('目录树包含重复或循环引用。')
    visited.add(entry.childIndexId)
    if (visited.size > 250_000) throw new TypeError('目录路径检查超过当前安全遍历上限。')
    const child = await childOf(frame.directory, entry)
    if (child.indexId === previous.indexId) return child
    frames.push({ directory: child, next: 0 })
  }
  throw new TypeError('此目录已移动到回收站或不再存在，请刷新后重试。')
}

export class RestoreNameConflictError extends Error {
  constructor(name: string) {
    super(`恢复位置已有同名项目“${name}”。`)
    this.name = 'RestoreNameConflictError'
  }
}

async function restoreTrashEntryCore(vault: UnlockedVault, trashEntryId: string, conflictChoice: 'reject' | 'keep-both' = 'reject', signal?: AbortSignal): Promise<UnlockedVault> {
  return restoreTrashEntriesCore(vault, [trashEntryId], conflictChoice, signal)
}

async function restoreTrashEntriesCore(vault: UnlockedVault, selectedIds: readonly string[], conflictChoice: 'reject' | 'keep-both' = 'reject', signal?: AbortSignal): Promise<UnlockedVault> {
  if (selectedIds.length < 1 || selectedIds.length > 5000 || new Set(selectedIds).size !== selectedIds.length || selectedIds.some((id) => !/^[A-Za-z0-9_-]{16,64}$/u.test(id))) throw new TypeError('恢复选择无效。')
  const selected = new Set(selectedIds)
  const conflict = (error: unknown) => error instanceof APIError && error.status === 409 && ['vault_mutation_conflict', 'global_revision_conflict', 'metadata_revision_conflict', 'tombstone_unavailable'].includes(error.code)
  return retryTraversalMutation(async () => {
    const current = await refreshVaultFromServer(vault, signal)
    const roots = selectedIds.map((id) => current.trashEntries.find((entry) => entry.tombstoneId === id))
    if (roots.some((entry) => !entry)) throw new TypeError('确认的回收站项目已恢复、过期或删除。请刷新后重新选择；其余项目未恢复。')
    type MutableDirectory = { indexId: string; revision: number; entries: DriveEntry[]; changed: boolean }
    const directories = new Map<string, MutableDirectory>()
    const edges = new Map<string, { parent: string; child: string }>()
    let decodedBytes = 0
    const charge = (value: unknown) => {
      const encoded = utf8Strict(JSON.stringify(value))
      decodedBytes += encoded.byteLength; encoded.fill(0)
      if (decodedBytes > 32 * 1024 * 1024) throw new TypeError('恢复目录检查超过 32 MiB 安全预算，请减少选择。')
    }
    const root: MutableDirectory = { indexId: current.rootIndexId, revision: current.rootRevision, entries: [...current.rootEntries], changed: false }
    directories.set(root.indexId, root); charge(root.entries); charge(current.trashEntries)
    const load = async (indexId: string): Promise<MutableDirectory> => {
      const cached = directories.get(indexId)
      if (cached) return cached
      if (directories.size >= 499) throw new TypeError('恢复涉及的目录超过单次事务限制，请减少选择。')
      const fetched = await fetchIndex(current.metadataKey, indexId, signal)
      charge(fetched.entries)
      const directory: MutableDirectory = { indexId, revision: fetched.revision, entries: [...fetched.entries], changed: false }
      directories.set(indexId, directory); return directory
    }
    // Restore ancestors first so separately deleted children return to the
    // restored original subtree rather than a duplicate placeholder directory.
    for (const trashed of roots.filter((entry): entry is TrashRootEntry => Boolean(entry)).sort((left, right) => left.originalPath.length - right.originalPath.length)) {
      throwIfAborted(signal)
      if (trashed.originalPath.length > 5000 || (trashed.originalPath.length > 0 && trashed.originalPath[0]?.indexId !== current.rootIndexId)) throw new TypeError('回收站原始路径无效，无法安全恢复。')
      let destination = root
      const visited = new Set([root.indexId])
      for (let index = 0; index < trashed.originalPath.length; index += 1) {
        const part = trashed.originalPath[index]!
        const originalChild = trashed.originalPath[index + 1]?.indexId ?? trashed.originalParentId
        const mapped = edges.get(originalChild)
        const existing = mapped?.parent === destination.indexId
          ? destination.entries.find((entry) => entry.kind === 'folder' && entry.childIndexId === mapped.child)
          : destination.entries.find((entry) => entry.name === part.name)
        if (existing?.kind === 'file' && conflictChoice === 'reject') throw new RestoreNameConflictError(part.name)
        if (existing?.kind === 'folder' && existing.childIndexId) {
          if (visited.has(existing.childIndexId)) throw new TypeError('恢复路径包含循环引用。')
          visited.add(existing.childIndexId)
          edges.set(originalChild, { parent: destination.indexId, child: existing.childIndexId })
          destination = await load(existing.childIndexId)
        } else {
          if (existing?.kind === 'folder') throw new TypeError('恢复路径索引无效。')
          if (destination.entries.length >= 5000 || directories.size >= 499) throw new TypeError('恢复路径或事务达到目录容量上限，请减少选择。')
          const childIndexId = randomObjectId(), name = existing ? uniqueSiblingName(part.name, destination.entries) : part.name
          destination.entries.push({ entryId: randomObjectId(), kind: 'folder', name, childIndexId, originalModifiedAt: Date.now(), createdAt: Date.now() }); destination.changed = true
          const next: MutableDirectory = { indexId: childIndexId, revision: 0, entries: [], changed: true }
          edges.set(originalChild, { parent: destination.indexId, child: childIndexId }); directories.set(childIndexId, next); destination = next
        }
      }
      const collides = destination.entries.some((entry) => entry.name === trashed.item.name)
      if (collides && conflictChoice === 'reject') throw new RestoreNameConflictError(trashed.item.name)
      if (destination.entries.length >= 5000) throw new TypeError('恢复位置已达到 5000 项上限。')
      const name = collides ? uniqueSiblingName(trashed.item.name, destination.entries) : trashed.item.name
      destination.entries.push({ ...trashed.item, name }); destination.changed = true
      if (trashed.item.kind === 'folder') edges.set(trashed.item.childIndexId!, { parent: destination.indexId, child: trashed.item.childIndexId! })
    }
    const next = current.trashEntries.filter((entry) => !selected.has(entry.tombstoneId))
    const changes: { metadataId: string; expectedRevision: number; revision: number; value: unknown }[] = [...directories.values()].filter((item) => item.changed).map((item) => ({ metadataId: item.indexId, expectedRevision: item.revision, revision: item.revision + 1, value: { version: 1, indexId: item.indexId, entries: item.entries } }))
    changes.push({ metadataId: current.trashIndexId, expectedRevision: current.trashRevision, revision: current.trashRevision + 1, value: { version: 1, indexId: current.trashIndexId, entries: next } })
    let budget = 0
    for (const change of changes) { const bytes = utf8Strict(JSON.stringify(change.value)); budget += bytes.byteLength + ENVELOPE_OVERHEAD_BYTES; bytes.fill(0) }
    if (changes.length > 500 || budget > 32 * 1024 * 1024) throw new TypeError('批量恢复超出单次事务安全预算，请减少选择。')
    const result = await commitEncryptedIndexes(current, changes, { restoreTombstoneIds: selectedIds }, signal)
    return { ...result, rootEntries: root.entries, rootRevision: root.revision + (root.changed ? 1 : 0), trashEntries: next, trashRevision: current.trashRevision + 1 }
  }, conflict, signal)
}

function uniqueSiblingName(name: string, entries: readonly DriveEntry[]): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  const existing = new Set(entries.map((entry) => entry.name))
  for (let number = 1; number <= 5000; number += 1) {
    const candidate = `${base} (${number})${extension}`
    if (isValidName(candidate) && !existing.has(candidate)) return candidate
  }
  throw new TypeError('无法为恢复项目生成唯一名称，请先清理目标文件夹。')
}

async function purgeTrashEntryCore(vault: UnlockedVault, trashEntryId: string, signal?: AbortSignal): Promise<UnlockedVault> {
  return purgeTrashEntriesCore(vault, [trashEntryId], signal)
}

async function purgeTrashEntriesCore(vault: UnlockedVault, selectedIds: readonly string[], signal?: AbortSignal): Promise<UnlockedVault> {
  if (selectedIds.length < 1 || selectedIds.length > 5000 || new Set(selectedIds).size !== selectedIds.length || selectedIds.some((id) => !/^[A-Za-z0-9_-]{16,64}$/u.test(id))) throw new TypeError('永久删除选择无效。')
  const selected = new Set(selectedIds)
  const conflict = (error: unknown) => error instanceof APIError && error.status === 409 && ['vault_mutation_conflict', 'global_revision_conflict', 'metadata_revision_conflict', 'tombstone_unavailable'].includes(error.code)
  return retryTraversalMutation(async () => {
    const current = await refreshVaultFromServer(vault, signal)
    if (selectedIds.some((id) => !current.trashEntries.some((entry) => entry.tombstoneId === id))) throw new TypeError('确认的回收站项目已恢复、过期或被其他设备删除。请刷新后重新确认；其余项目未删除。')
    const next = current.trashEntries.filter((entry) => !selected.has(entry.tombstoneId))
    const result = await commitEncryptedIndexes(current, [
      { metadataId: current.trashIndexId, expectedRevision: current.trashRevision, revision: current.trashRevision + 1, value: { version: 1, indexId: current.trashIndexId, entries: next } },
    ], { purgeTombstoneIds: selectedIds }, signal)
    return { ...result, trashEntries: next, trashRevision: current.trashRevision + 1 }
  }, conflict, signal)
}

async function commitEncryptedIndexes(
  vault: UnlockedVault,
  changes: readonly { metadataId: string; expectedRevision: number; revision: number; value: unknown }[],
  action: { restoreTombstoneIds?: readonly string[]; restoreTombstoneId?: string; purgeTombstoneId?: string; purgeTombstoneIds?: readonly string[] } = {},
  signal?: AbortSignal,
): Promise<UnlockedVault> {
  const objects = changes.map((change) => ({ ...change, objectId: randomObjectId(), aad: indexAAD(change.metadataId, change.revision), plaintext: utf8Strict(JSON.stringify(change.value)) }))
  if (objects.some((object) => object.plaintext.byteLength + ENVELOPE_OVERHEAD_BYTES > 4 * 1024 * 1024)) {
    objects.forEach((object) => { object.plaintext.fill(0); object.aad.fill(0) })
    throw new TypeError('目录索引超过 4 MiB 限制。')
  }
  let uploadId = ''
  let commitStarted = false
  const envelopes: Uint8Array[] = []
  try {
    for (const object of objects) envelopes.push(await encryptObject(vault.metadataKey, object.plaintext, object.aad))
    throwIfAborted(signal)
    const session = await post<{ uploadId: string }>('/api/v1/uploads', {}, true, undefined, signal)
    uploadId = session.uploadId
    const totalBytes = envelopes.reduce((total, envelope) => total + envelope.byteLength, 0)
    try {
      await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/reserve`, { reservedBytes: totalBytes }, true, undefined, signal)
    } catch (error) {
      const purgeIds = action.purgeTombstoneIds ?? (action.purgeTombstoneId ? [action.purgeTombstoneId] : undefined)
      if (!(error instanceof APIError) || error.status !== 507 || error.code !== 'quota_exceeded' || !purgeIds || objects.length !== 1) throw error
      // No PUT occurred. Close the empty session before attempting the atomic
      // maintenance protocol; it never relaxes ordinary upload reservation.
      await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/abandon`, {}, true, undefined, signal)
      uploadId = ''
      throwIfAborted(signal)
      commitStarted = true
      const response = await postIdempotentWithRetry<{ vaultMutationRevision: number }>({
        expectedGlobalRevision: vault.vaultMutationRevision, purgeTombstoneIds: purgeIds,
        updates: objects.map((object) => ({ metadataId: object.metadataId, expectedRevision: object.expectedRevision, objectId: object.objectId })),
        encryptedObject: encodeBase64(envelopes[0]!),
      }, randomObjectId(), signal, '/api/v1/metadata/maintenance-purge')
      return { ...vault, vaultMutationRevision: response.vaultMutationRevision }
    }

    for (let index = 0; index < objects.length; index += 1) {
      const envelope = envelopes[index]!
      await putEncryptedObject(uploadId, objects[index]!.objectId, envelope, await sha256Hex(envelope), signal)
    }
    throwIfAborted(signal)
    commitStarted = true
    const response = await postIdempotentWithRetry<{ vaultMutationRevision: number }>({
      uploadId, expectedGlobalRevision: vault.vaultMutationRevision,
      activateObjectIds: objects.map((object) => object.objectId),
      updates: objects.map((object) => ({ metadataId: object.metadataId, expectedRevision: object.expectedRevision, objectId: object.objectId })),
      ...action,
    }, randomObjectId(), signal)
    return { ...vault, vaultMutationRevision: response.vaultMutationRevision }
  } catch (error) {
    // Explicit owner cancellation may race a committed transaction. Abandon
    // serializes with it and only closes active sessions; it cannot undo a commit.
    if (signal?.aborted || (error instanceof APIError && error.status >= 400 && error.status < 500)) commitStarted = false
    if (!commitStarted && uploadId) {
      try { await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/abandon`, {}, true, undefined, AbortSignal.timeout(5000)) } catch { /* Expiry recovery releases pending work. */ }
    }
    throw error
  } finally {
    objects.forEach((object) => { object.plaintext.fill(0); object.aad.fill(0) })
    envelopes.forEach((envelope) => envelope.fill(0))
  }
}

interface APIStatus {
  readonly setupRequired: boolean
  readonly accountState: 'uninitialized' | 'pending_setup' | 'active'
}

export interface SystemInfo { readonly version: string; readonly commit: string; readonly clientProtocolVersion: number; readonly encryptedFormatVersion: number }

export async function fetchSystemInfo(signal?: AbortSignal): Promise<SystemInfo> { return request<SystemInfo>('/api/v1/system/info', signal) }

export interface SystemUpdateInfo {
  readonly currentVersion: string
  readonly latestVersion: string
  readonly name: string
  readonly releaseUrl: string
  readonly publishedAt: string
  readonly releaseNotes: string
  readonly updateAvailable: boolean
  readonly canInstall: boolean
}

export interface SystemUpdateStatus {
  readonly id: string
  readonly version: string
  readonly state: 'queued' | 'checking' | 'downloading' | 'installing' | 'succeeded' | 'failed'
  readonly errorCode?: string
  readonly updatedAt: number
}

export async function fetchSystemUpdateInfo(signal?: AbortSignal): Promise<SystemUpdateInfo> {
  const value = await request<SystemUpdateInfo>('/api/v1/system/update', signal)
  const releaseURL = new URL(value.releaseUrl)
  if (releaseURL.origin !== 'https://github.com' || releaseURL.username || releaseURL.password || releaseURL.search || releaseURL.hash || releaseURL.pathname !== `/jareyxu/XDrive/releases/tag/${value.latestVersion}` || typeof value.currentVersion !== 'string' || typeof value.latestVersion !== 'string' || typeof value.updateAvailable !== 'boolean' || typeof value.canInstall !== 'boolean' || typeof value.releaseNotes !== 'string' || value.releaseNotes.length > 8192) {
    throw new TypeError('更新信息格式无效')
  }
  return value
}

export async function startSystemUpdate(version: string, signal?: AbortSignal): Promise<SystemUpdateStatus> {
  return post<SystemUpdateStatus>('/api/v1/system/update', { version }, true, undefined, signal)
}

export async function fetchSystemUpdateStatus(id: string, signal?: AbortSignal): Promise<SystemUpdateStatus> {
  return request<SystemUpdateStatus>(`/api/v1/system/update/status?id=${encodeURIComponent(id)}`, signal)
}

export async function fetchTrashRetentionLabel(signal?: AbortSignal): Promise<string> {
  const info = await request<{ trashRetentionSeconds?: unknown }>('/api/v1/system/info', signal)
  const seconds = info.trashRetentionSeconds
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 9_223_372_036) throw new TypeError('回收站保留期不可用')
  for (const [unit, divisor] of [['天', 86400], ['小时', 3600], ['分钟', 60], ['秒', 1]] as const) {
    if (seconds % divisor === 0) return `保留 ${(seconds / divisor).toLocaleString('zh-CN')} ${unit}`
  }
  throw new TypeError('回收站保留期不可用')
}
export async function fetchZipMemoryFallbackLimit(signal?: AbortSignal): Promise<number> {
  const info = await request<{ zipMemoryFallbackLimit?: unknown }>('/api/v1/system/info', signal)
  const limit = info.zipMemoryFallbackLimit
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 512 * 1024 * 1024) throw new TypeError('无法读取有效的 ZIP 内存上限，请使用流式下载。')
  return limit
}
export async function fetchVideoBlobFallbackLimit(signal?: AbortSignal): Promise<number> {
  const info = await request<{ videoBlobFallbackLimit?: unknown }>('/api/v1/system/info', signal)
  const limit = info.videoBlobFallbackLimit
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 512 * 1024 * 1024) throw new TypeError('无法读取有效的视频内存播放上限，请下载后播放。')
  return limit
}
export async function fetchTextPreviewLimit(signal?: AbortSignal): Promise<number> {
  const info = await request<{ textPreviewLimit?: unknown }>('/api/v1/system/info', signal)
  if (typeof info.textPreviewLimit !== 'number' || !Number.isSafeInteger(info.textPreviewLimit) || info.textPreviewLimit < 1 || info.textPreviewLimit > 512 * 1024 * 1024) throw new TypeError('无法读取有效的文本预览上限，请下载后查看。')
  return info.textPreviewLimit
}

export async function fetchStatus(signal?: AbortSignal): Promise<APIStatus> {
  return request<APIStatus>('/api/v1/status', signal)
}

// This outcome contains no password, key, or decrypted vault state.
export class SetupCommittedError extends Error {
  readonly originalCause: unknown
  constructor(originalCause: unknown) {
    super('设置已完成，但自动登录未成功。请使用刚设置的用户名和密码登录。')
    this.name = 'SetupCommittedError'
    this.originalCause = originalCause
  }
}

export class SetupStateUnknownError extends Error {
  readonly originalCause: unknown
  constructor(originalCause: unknown) {
    super('暂时无法确认初始化结果。请重新连接服务后再继续，避免重复初始化。')
    this.name = 'SetupStateUnknownError'
    this.originalCause = originalCause
  }
}

export async function createVault(input: {
  readonly token: string
  readonly username: string
  readonly password: string
}, signal?: AbortSignal): Promise<UnlockedVault> {
  throwIfAborted(signal)
  const kdf = await createPasswordKDF()
  const { kek, authKey } = await derivePasswordMaterials(input.password, kdf, signal)
  let vaultKeyBytes: Uint8Array | undefined
  let setupCommitted = false
  try {
    vaultKeyBytes = crypto.getRandomValues(new Uint8Array(32))
    throwIfAborted(signal)
    const vaultKey = await importVaultKey(vaultKeyBytes)
    const slot = await wrapVaultKey(kek, vaultKeyBytes, crypto.randomUUID(), kdf, 1, 2)
    const vaultConfig: VaultConfigV1 = { formatVersion: 2, revision: 1, slots: [slot] }
    const metadataKey = await deriveVaultKey(vaultKey, 'xdrive/v1/meta')
    const dataKey = await deriveDataKey(vaultKey)
    const rootIndexId = await deriveIndexId(vaultKey, 'root')
    const trashIndexId = await deriveIndexId(vaultKey, 'trash')
    const rootObjectId = randomObjectId()
    const trashObjectId = randomObjectId()
    const rootEnvelope = await encryptObject(metadataKey, utf8Strict(JSON.stringify({ version: 1, indexId: rootIndexId, entries: [] })), indexAAD(rootIndexId, 1))
    const trashEnvelope = await encryptObject(metadataKey, utf8Strict(JSON.stringify({ version: 1, indexId: trashIndexId, entries: [] })), indexAAD(trashIndexId, 1))
    try {
      await post('/api/v1/setup', {
        token: input.token,
        authKey: encodeBase64(authKey),
        vaultConfig,
        rootIndex: { metadataId: rootIndexId, objectId: rootObjectId, revision: 1, encryptedObject: encodeBase64(rootEnvelope) },
        trashIndex: { metadataId: trashIndexId, objectId: trashObjectId, revision: 1, encryptedObject: encodeBase64(trashEnvelope) },
      }, false, undefined, signal)
      setupCommitted = true
    } catch (cause) {
      throwIfAborted(signal)
      // A lost response is ambiguous: consult authoritative state before offering
      // another initialization. Never regenerate keys for an already active vault.
      const status = await fetchStatus(signal).catch(() => null)
      throwIfAborted(signal)
      if (!status) throw new SetupStateUnknownError(cause)
      if (status.accountState === 'active') setupCommitted = true
      throw cause
    }
    csrfToken = ''
    await loginWithAuthKey(input.username, authKey, signal)
    revisionScope = rootIndexId
    await recordCommittedRevisions([
      { kind: 'config', revision: vaultConfig.revision },
      { kind: 'vault', revision: 1 },
      { kind: 'metadata', metadataId: rootIndexId, revision: 1 },
      { kind: 'metadata', metadataId: trashIndexId, revision: 1 },
    ])
    throwIfAborted(signal)
    return { vaultKey, dataKey, metadataKey, rootIndexId, trashIndexId, rootEntries: [], trashEntries: [], username: input.username, vaultConfig, rootRevision: 1, trashRevision: 1, vaultMutationRevision: 1 }
  } catch (cause) {
    clearRevisionContext()
    throwIfAborted(signal)
    if (setupCommitted) throw new SetupCommittedError(cause)
    throw cause
  } finally {
    authKey.fill(0)
    vaultKeyBytes?.fill(0)
  }
}

export async function unlockWithPassword(username: string, password: string, signal?: AbortSignal): Promise<UnlockedVault> {
  const { kdf } = await post<{ kdf: Argon2idParams }>('/api/v1/auth/prelogin', { username }, false, undefined, signal)
  const { authKey, kek } = await derivePasswordMaterials(password, kdf, signal)
  try {
    const { value: result, responseCsrf } = await postWithResponse<Omit<VaultLoginResponse, 'csrfToken'>>('/api/v1/auth/login', { username, authKey: encodeBase64(authKey) }, false, undefined, signal)
    throwIfAborted(signal)
    csrfToken = responseCsrf
    return await unlockVaultState(username, kek, result, signal)
  } finally {
    authKey.fill(0)
  }
}

export async function fetchCurrentSession(): Promise<{ authenticated: false } | ({ authenticated: true; csrfToken: string; username: string } & VaultLoginResponse)> {
  const { value: response, responseCsrf: token } = await requestWithResponse<{ authenticated: boolean; username?: string; vaultConfig?: VaultConfigV1; vaultMutationRevision?: number }>('/api/v1/auth/session', { method: 'GET', credentials: 'same-origin' })
  if (!response.authenticated || !response.vaultConfig) return { authenticated: false }
  csrfToken = token
  return { authenticated: true, username: response.username ?? 'admin', vaultConfig: response.vaultConfig, vaultMutationRevision: response.vaultMutationRevision ?? 0, csrfToken: token }
}


export async function unlockSession(password: string, username: string, vaultConfig: VaultConfigV1, signal?: AbortSignal): Promise<UnlockedVault> {
  const slot = vaultConfig.slots[0]
  if (!slot) throw new TypeError('password key slot is missing')
  const { authKey, kek } = await derivePasswordMaterials(password, slot.kdf, signal)
  try {
    const { value: result, responseCsrf } = await postWithResponse<Omit<VaultLoginResponse, 'csrfToken'>>('/api/v1/auth/unlock', { authKey: encodeBase64(authKey) }, true, undefined, signal)
    throwIfAborted(signal)
    csrfToken = responseCsrf
    return await unlockVaultState(username, kek, result, signal)
  } finally {
    authKey.fill(0)
  }
}

export async function logout(): Promise<void> {
  await post('/api/v1/auth/logout', {}, true)
  csrfToken = ''
  clearRevisionContext()
}

async function changePasswordCore(vault: UnlockedVault, currentPassword: string, newPassword: string, signal?: AbortSignal): Promise<UnlockedVault> {
  assertPasswordLength(newPassword)
  const currentSlot = vault.vaultConfig.slots[0]
  if (!currentSlot || currentSlot.type !== 'password') throw new TypeError('当前密钥槽位无效。')
  const currentMaterials = await derivePasswordMaterials(currentPassword, currentSlot.kdf, signal)
  let rawVaultKey: Uint8Array | undefined
  let newAuthKey: Uint8Array | undefined
  let checkedVaultKey: Uint8Array | undefined
  try {
    const verified = await post<VaultLoginResponse>('/api/v1/auth/unlock', { authKey: encodeBase64(currentMaterials.authKey) }, true, undefined, signal)
    if (verified.vaultConfig.revision !== vault.vaultConfig.revision) throw new TypeError('Vault 配置已变化，请重新登录后再修改密码。')
    rawVaultKey = await unwrapVaultKeyBytes(currentMaterials.kek, vault.vaultConfig)
    const newKDF = await createPasswordKDF()
    const nextMaterials = await derivePasswordMaterials(newPassword, newKDF, signal)
    newAuthKey = nextMaterials.authKey
    const nextRevision = vault.vaultConfig.revision + 1
    if (!Number.isSafeInteger(nextRevision)) throw new TypeError('Vault 配置版本超出安全范围。')
    const newSlot = await wrapVaultKey(nextMaterials.kek, rawVaultKey, crypto.randomUUID(), newKDF, nextRevision, 2)
    const newVaultConfig: VaultConfigV1 = { formatVersion: 2, revision: nextRevision, slots: [newSlot] }
    checkedVaultKey = await unwrapVaultKeyBytes(nextMaterials.kek, newVaultConfig)
    let mismatch = 0
    for (let index = 0; index < rawVaultKey.byteLength; index += 1) mismatch |= rawVaultKey[index]! ^ checkedVaultKey[index]!
    if (mismatch !== 0) throw new TypeError('新密码密钥槽位自检失败，未修改密码。')
    const operationScope = revisionScope
    const response = await post<{ vaultConfig: VaultConfigV1 }>('/api/v1/auth/change-password', {
      currentAuthKey: encodeBase64(currentMaterials.authKey),
      newAuthKey: encodeBase64(newAuthKey),
      newVaultConfig,
      expectedConfigRevision: vault.vaultConfig.revision,
    }, true, undefined, signal)
    if (response.vaultConfig.revision !== nextRevision) throw new TypeError('服务器返回的 Vault 配置版本不正确。')
    await recordCommittedRevisions([{ kind: 'config', revision: nextRevision }], operationScope)
    throwIfAborted(signal)
    return { ...vault, vaultConfig: response.vaultConfig }
  } finally {
    currentMaterials.authKey.fill(0)
    rawVaultKey?.fill(0)
    newAuthKey?.fill(0)
    checkedVaultKey?.fill(0)
  }
}

export async function fetchStorageUsage(signal?: AbortSignal): Promise<StorageUsage> {
  const usage = await request<StorageUsage>('/api/v1/storage/usage', signal)
  if (!Number.isSafeInteger(usage.backupWarnAfterDays) || usage.backupWarnAfterDays < 1 || usage.backupWarnAfterDays > 3650) throw new TypeError('备份提醒策略不可用，请重新读取存储状态。')
  return usage
}

interface VaultLoginResponse {
  readonly vaultConfig: VaultConfigV1
  readonly vaultMutationRevision: number
}

interface EncryptedChunkRecord {
  readonly objectId: string
  readonly plaintextSize: number
  readonly sha256: string
}

interface UploadStatus {
  readonly uploadId: string
  readonly state: 'active' | 'committed' | 'aborted' | 'expired'
  readonly expiresAt: number
  readonly reservedBytes: number
  readonly objects: readonly UploadPiece[]
  readonly claims: readonly UploadPiece[]
}

export async function pendingUploadRecords(vault: UnlockedVault, signal?: AbortSignal): Promise<{ records: UploadResumeRecord[]; committed: boolean; progressById: ReadonlyMap<string, { uploadedBytes: number; reservedBytes: number; state: 'active' | 'expired' | 'unknown' }> }> {
  signal?.throwIfAborted()
  const records = await listUploadRecords(vault.vaultKey, signal)
  signal?.throwIfAborted()
  const pending: UploadResumeRecord[] = []
  const progressById = new Map<string, { uploadedBytes: number; reservedBytes: number; state: 'active' | 'expired' | 'unknown' }>()
  let committed = false
  for (const record of records) {
    signal?.throwIfAborted()
    try {
      const status = await request<UploadStatus>(`/api/v1/uploads/${encodeURIComponent(record.uploadId)}`, signal)
      signal?.throwIfAborted()
      if (status.state === 'committed') {
        await deleteUploadRecord(record.id)
        signal?.throwIfAborted()
        committed = true
        continue
      }
      const stored = new Map(status.objects.map((piece) => [piece.objectId, piece]))
      let uploadedBytes = 0
      record.chunks.forEach((piece, index) => {
        if (!piece) return
        const actual = stored.get(piece.objectId)
        if (actual?.sizeBytes === piece.sizeBytes && actual.sha256 === piece.sha256) {
          uploadedBytes += Math.min(FILE_CHUNK_BYTES, Math.max(0, record.size - index * FILE_CHUNK_BYTES))
        }
      })
      progressById.set(record.id, { uploadedBytes, reservedBytes: status.reservedBytes, state: status.state === 'active' && status.expiresAt > Math.floor(Date.now() / 1000) ? 'active' : 'expired' })
    } catch (error) {
      signal?.throwIfAborted()
      if (!(error instanceof APIError && error.status === 404)) throw error
      progressById.set(record.id, { uploadedBytes: 0, reservedBytes: 0, state: 'unknown' })
    }
    pending.push(record)
  }
  return { records: pending, committed, progressById }
}

export async function refreshVaultFromServer(vault: UnlockedVault, signal?: AbortSignal): Promise<UnlockedVault> {
  const state = await request<{ vaultMutationRevision: number }>('/api/v1/vault/state', signal)
  const [root, trash] = await Promise.all([
    fetchIndex(vault.metadataKey, vault.rootIndexId, signal),
    fetchActiveTrashIndex(vault.metadataKey, vault.trashIndexId, signal),
  ])
  return { ...vault, rootEntries: root.entries, rootRevision: root.revision, trashEntries: trash.entries, trashRevision: trash.revision, vaultMutationRevision: state.vaultMutationRevision }
}

async function abandonResumableUploadCore(record: UploadResumeRecord): Promise<void> {
  try {
    const status = await request<UploadStatus>(`/api/v1/uploads/${encodeURIComponent(record.uploadId)}`)
    if (status.state === 'active') await post(`/api/v1/uploads/${encodeURIComponent(record.uploadId)}/abandon`, {}, true)
  } catch (error) { if (!(error instanceof APIError && error.status === 404)) throw error }
  await deleteUploadRecord(record.id)
}

async function resumeUploadFileCore(
  vault: UnlockedVault,
  file: File,
  record: UploadResumeRecord,
  onProgress: UploadProgressListener = () => undefined,
  signal?: AbortSignal,
): Promise<{ vault: UnlockedVault; directory: DirectoryState }> {
  await assertOriginalFile(file, record)
  const loaded = await fetchIndex(vault.metadataKey, record.directoryId)
  return uploadFileCore(vault, file, { indexId: record.directoryId, revision: loaded.revision, entries: loaded.entries, path: record.directoryPath ?? [] }, onProgress, signal, record)
}

export interface UploadConflictChoice {
  readonly targetName?: string
  readonly replaceEntryId?: string
  readonly expectedReplacementFileId?: string
  readonly expectedReplacementIdentity?: string
}

class UploadConflictChangedError extends Error {
  constructor() { super('目标同名项目已变化，请重新选择冲突处理方式。'); this.name = 'UploadConflictChangedError' }
}

async function prepareThumbnail(vaultKey: CryptoKey, dataKey: CryptoKey, file: File, fileId: string, keyVersion: 1 | 2, signal?: AbortSignal): Promise<SavedThumbnail | null> {
  const generated = await generateThumbnail(file, signal)
  if (!generated) return null
  let encrypted: Uint8Array | undefined
  const aad = thumbnailAAD(fileId, keyVersion)
  try {
    signal?.throwIfAborted()
    const key = await deriveThumbnailKey(vaultKey, dataKey, fileId, keyVersion)
    encrypted = await encryptObject(key, generated.bytes, aad)
    signal?.throwIfAborted()
    return { reference: { objectId: randomObjectId(), sizeBytes: encrypted.length, sha256: await sha256Hex(encrypted), mime: generated.mime, width: generated.width, height: generated.height, keyVersion }, ciphertext: encodeBase64(encrypted) }
  } finally { generated.bytes.fill(0); aad.fill(0); encrypted?.fill(0) }
}

export async function readThumbnail(vault: Pick<UnlockedVault, 'vaultKey' | 'dataKey'>, entry: DriveEntry, signal?: AbortSignal): Promise<Blob> {
  if (!entry.fileId || !isThumbnailReference(entry.thumbnail)) throw new TypeError('缩略图引用无效。')
  const ref = entry.thumbnail
  const encrypted = new Uint8Array(await requestArrayBuffer(`/api/v1/objects/${encodeURIComponent(ref.objectId)}`, ref.sizeBytes, signal))
  const keyVersion = ref.keyVersion ?? entry.fileCryptoVersion ?? 1
  if (entry.fileCryptoVersion !== undefined && keyVersion !== entry.fileCryptoVersion) throw new TypeError('缩略图密钥版本与文件不一致。')
  const aad = thumbnailAAD(entry.fileId, keyVersion)
  let plaintext: Uint8Array | undefined
  try {
    signal?.throwIfAborted()
    if (encrypted.length !== ref.sizeBytes || await sha256Hex(encrypted) !== ref.sha256) throw new TypeError('缩略图完整性校验失败。')
    const key = await deriveThumbnailKey(vault.vaultKey, vault.dataKey, entry.fileId, keyVersion)
    signal?.throwIfAborted()
    plaintext = await decryptObject(key, encrypted, aad)
    signal?.throwIfAborted()
    const webp = plaintext.length >= 12 && plaintext[0] === 82 && plaintext[1] === 73 && plaintext[2] === 70 && plaintext[3] === 70 && plaintext[8] === 87 && plaintext[9] === 69 && plaintext[10] === 66 && plaintext[11] === 80
    const jpeg = plaintext.length >= 3 && plaintext[0] === 255 && plaintext[1] === 216 && plaintext[2] === 255
    if ((ref.mime === 'image/webp' && !webp) || (ref.mime === 'image/jpeg' && !jpeg)) throw new TypeError('缩略图编码与 MIME 不一致。')
    const dimensions = imageDimensions(plaintext)
    if (!dimensions || dimensions.width !== ref.width || dimensions.height !== ref.height) throw new TypeError('缩略图尺寸无效。')
    return new Blob([plaintext.buffer as ArrayBuffer], { type: ref.mime })
  } finally { encrypted.fill(0); aad.fill(0); plaintext?.fill(0) }
}

async function uploadFileCore(
  vault: UnlockedVault,
  file: File,
  directory: DirectoryState,
  onProgress: UploadProgressListener = () => undefined,
  signal?: AbortSignal,
  recovery?: UploadResumeRecord,
  choice?: UploadConflictChoice,
): Promise<{ vault: UnlockedVault; directory: DirectoryState }> {
  const name = file.name.normalize('NFC')
  const targetName = recovery?.targetName ?? choice?.targetName ?? name
  const replaceEntryId = recovery?.replaceEntryId ?? choice?.replaceEntryId
  const tombstoneId = recovery?.tombstoneId ?? (replaceEntryId ? randomObjectId() : undefined)
  if (!isValidName(name) || !isValidName(targetName)) throw new TypeError('文件名包含不支持的字符。')
  const replaced = replaceEntryId ? directory.entries.find((entry) => entry.entryId === replaceEntryId) : undefined
  const replacementIdentity = conflictIdentity(replaced ?? null)
  if (replaceEntryId && (!replaced || replaced.name !== targetName || (choice?.expectedReplacementFileId && replaced.fileId !== choice.expectedReplacementFileId) || (choice?.expectedReplacementIdentity && replacementIdentity !== choice.expectedReplacementIdentity))) throw new UploadConflictChangedError()
  const identityBytes = utf8Strict(replacementIdentity)
  let replacementFingerprint: string | undefined
  try { replacementFingerprint = replaced ? await sha256Hex(identityBytes) : undefined } finally { identityBytes.fill(0) }
  if (recovery?.replaceEntryId && (!recovery.replacementFingerprint || recovery.replacementFingerprint !== replacementFingerprint)) throw new TypeError('原覆盖目标已变化，或旧版任务缺少目标身份。请放弃此任务后重新选择文件并确认冲突；现有项目保持原位。')
  if (replaced && vault.trashEntries.length >= 5000) throw new TypeError('回收站根目录已达到 5000 项上限，请先清理。')
  if (directory.entries.length >= 5000 && !replaced) throw new TypeError('当前文件夹已达到 5000 项上限。')
  if (directory.entries.some((entry) => entry.name.normalize('NFC') === targetName && entry.entryId !== replaceEntryId && entry.fileId !== recovery?.fileId)) throw new UploadConflictChangedError()
  if (!Number.isSafeInteger(file.size)) throw new TypeError('文件大小超出浏览器安全范围。')
  const originalModifiedAt = recovery?.lastModified ?? file.lastModified
  if (!Number.isSafeInteger(originalModifiedAt) || originalModifiedAt < 0 || originalModifiedAt > 8640000000000000) throw new TypeError('文件修改时间超出支持范围。')
  if (file.type.length > 255) throw new TypeError('文件类型信息过长。')

  const chunkCount = Math.ceil(file.size / FILE_CHUNK_BYTES)
  if (chunkCount + 2 > 4096) throw new TypeError('文件分块数量超出当前单次提交上限。')
  const fileId = recovery?.fileId ?? randomObjectId()
  const fileCryptoVersion = recovery?.fileCryptoVersion ?? (vault.vaultConfig.formatVersion === 2 ? 2 : 1)
  const chunkObjectIds = Array.from({ length: chunkCount }, (_, index) => recovery?.chunks[index]?.objectId ?? randomObjectId())
  let savedThumbnail = recovery ? recovery.thumbnail ?? null : await prepareThumbnail(vault.vaultKey, vault.dataKey, file, fileId, fileCryptoVersion, signal)
  if (chunkCount + 2 + (savedThumbnail ? 1 : 0) + (replaced ? 1 : 0) > 4096) throw new TypeError('文件及元数据对象数量超出当前单次提交上限。')
  let entryBase: DriveEntry = {
    entryId: recovery?.entryId ?? fileId, kind: 'file', name: targetName, size: file.size,
    originalModifiedAt, createdAt: Date.now(),
    fileCryptoVersion,
    ...(savedThumbnail ? { thumbnail: savedThumbnail.reference } : {}),
    mime: recovery?.mime ?? (file.type || 'application/octet-stream'), fileId, manifestObjectId: recovery?.manifest?.objectId ?? randomObjectId(),
  }
  const indexEstimate = utf8Strict(JSON.stringify({
    version: 1, indexId: directory.indexId,
    entries: [...directory.entries.filter((entry) => entry.entryId !== replaceEntryId), { ...entryBase, manifestSha256: '0'.repeat(64) }],
  }))
  if (indexEstimate.byteLength + ENVELOPE_OVERHEAD_BYTES > 4 * 1024 * 1024) {
    indexEstimate.fill(0)
    throw new TypeError('目录索引超过 4 MiB 限制。')
  }
  const manifestChunks: EncryptedChunkRecord[] = Array.from({ length: chunkCount }, (_, index) => ({
    objectId: chunkObjectIds[index]!,
    plaintextSize: Math.min(FILE_CHUNK_BYTES, file.size - index * FILE_CHUNK_BYTES),
    sha256: '0'.repeat(64),
  }))
  const buildManifest = () => ({
    version: 3,
    fileCryptoVersion,
    fileId,
    size: file.size,
    chunkSize: FILE_CHUNK_BYTES,
    chunkCount,
    mime: entryBase.mime,
    originalModifiedAt,
    chunks: manifestChunks.map((chunk, index) => ({ index, ...chunk })),
    thumbnail: savedThumbnail?.reference ?? null,
  })
  const manifestPlaceholder = utf8Strict(JSON.stringify(buildManifest()))
  const trashEstimate = replaced ? utf8Strict(JSON.stringify({ version: 1, indexId: vault.trashIndexId, entries: [...vault.trashEntries, {
    tombstoneId, item: replaced, originalParentId: directory.indexId,
    originalPath: directory.path.map((crumb, index) => ({ indexId: crumb.indexId, name: crumb.name, childIndexId: directory.path[index + 1]?.indexId ?? directory.indexId })),
    deletedAt: Date.now(),
  }] })) : undefined
  if (trashEstimate && trashEstimate.byteLength + ENVELOPE_OVERHEAD_BYTES > 4 * 1024 * 1024) {
    trashEstimate.fill(0); manifestPlaceholder.fill(0); indexEstimate.fill(0)
    throw new TypeError('回收站索引超过 4 MiB 限制。')
  }
  const originalTrashBytes = trashEstimate?.byteLength ?? 0
  const expectedReservation = (savedThumbnail?.reference.sizeBytes ?? 0) + file.size + chunkCount * ENVELOPE_OVERHEAD_BYTES + manifestPlaceholder.byteLength + ENVELOPE_OVERHEAD_BYTES + indexEstimate.byteLength + ENVELOPE_OVERHEAD_BYTES + (trashEstimate ? trashEstimate.byteLength + ENVELOPE_OVERHEAD_BYTES : 0)
  const originalIndexBytes = indexEstimate.byteLength
  manifestPlaceholder.fill(0)
  indexEstimate.fill(0)
  trashEstimate?.fill(0)

  let uploadId = recovery?.uploadId ?? ''
  let record = recovery
  let recordSaved = Boolean(recovery)
  let status: UploadStatus | undefined
  let indexPlaintext: Uint8Array | undefined
  let trashPlaintext: Uint8Array | undefined
  let buildId = ''
  const uploadedObjectIds: string[] = []
  let completed = 0
  let uploadedContentBytes = 0
  let commitStarted = false
  const totalSteps = chunkCount + (savedThumbnail ? 1 : 0) + 2 + (replaced ? 1 : 0)
  const onPutNetworkWaiting = (waiting: boolean) => onProgress(completed, totalSteps, {
    phase: waiting ? 'waiting-network' : 'uploading', completedBytes: uploadedContentBytes, totalBytes: file.size,
  })
  try {
    onProgress(completed, totalSteps, { phase: 'preparing', completedBytes: uploadedContentBytes, totalBytes: file.size })
    if (record) {
      status = await request<UploadStatus>(`/api/v1/uploads/${encodeURIComponent(uploadId)}`)
      if (status.state === 'committed') {
        const fresh = await fetchIndex(vault.metadataKey, directory.indexId)
        if (!fresh.entries.some((entry) => entry.fileId === fileId)) throw new TypeError('上传已提交，但目标目录已变化；请刷新云盘检查文件。')
        const refreshed = await refreshVaultFromServer(vault)
        await deleteUploadRecord(record.id)
        const nextVault = refreshed
        return { vault: directory.indexId === vault.rootIndexId ? { ...nextVault, rootEntries: fresh.entries, rootRevision: fresh.revision } : nextVault, directory: { ...directory, entries: fresh.entries, revision: fresh.revision } }
      }
      if (status.state !== 'active' || status.expiresAt <= Math.floor(Date.now() / 1000)) throw new TypeError('上传会话已过期，请移除恢复任务后重新上传。')
      if (status.claims.length > 0) throw new TypeError('服务器仍在接收上传对象，请稍后重试。')
      const known = new Set([...record.chunks.filter((piece): piece is UploadPiece => piece !== null).map((piece) => piece.objectId), record.manifest?.objectId, record.index?.objectId, record.trashIndex?.objectId, record.thumbnail?.reference.objectId])
      if (status.objects.some((piece) => !known.has(piece.objectId))) throw new TypeError('服务器上传会话包含未知对象；请放弃该任务后重新上传。')
      const stored = new Map(status.objects.map((piece) => [piece.objectId, piece]))
      record.chunks.forEach((piece, index) => {
        if (!piece) return
        const actual = stored.get(piece.objectId)
        if (actual?.sizeBytes === piece.sizeBytes && actual.sha256 === piece.sha256) {
          uploadedContentBytes += Math.min(FILE_CHUNK_BYTES, Math.max(0, file.size - index * FILE_CHUNK_BYTES))
        }
      })
    } else {
      const upload = await post<{ uploadId: string; expiresAt: number }>('/api/v1/uploads', {}, true, undefined, signal)
      uploadId = upload.uploadId
      await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/reserve`, { reservedBytes: expectedReservation }, true, undefined, signal)
      record = {
        version: 4, fileCryptoVersion, thumbnail: savedThumbnail, id: randomObjectId(), uploadId, expiresAt: upload.expiresAt,
        directoryId: directory.indexId, name, mime: entryBase.mime!, size: file.size,
        lastModified: file.lastModified, fingerprint: await fingerprintFile(file), fileId,
        entryId: entryBase.entryId, chunks: Array.from({ length: chunkCount }, () => null),
        manifest: null, index: null, indexRevision: null, idempotencyKey: null,
        targetName, replaceEntryId, replacementFingerprint, tombstoneId, trashIndex: null, directoryPath: directory.path,
      }
      await saveUploadRecord(vault.vaultKey, record)
      recordSaved = true
    }
    const fileKey = await deriveFileKey(vault.vaultKey, vault.dataKey, fileId, fileCryptoVersion)
    const writeAhead = createWriteAheadQueue()
    const uploaded = new Map(status?.objects.map(piece => [piece.objectId, piece]))
    if (savedThumbnail) {
      const prior = savedThumbnail.reference, persisted = uploaded.get(prior.objectId)
      if (!(persisted && persisted.sizeBytes === prior.sizeBytes && persisted.sha256 === prior.sha256)) {
        let encrypted = decodeBase64Strict(savedThumbnail.ciphertext)
        let plaintext: Uint8Array | undefined
        const thumbnailVersion = savedThumbnail.reference.keyVersion ?? fileCryptoVersion
        const aad = thumbnailAAD(fileId, thumbnailVersion)
        try {
          signal?.throwIfAborted()
          if (encrypted.length !== prior.sizeBytes || await sha256Hex(encrypted) !== prior.sha256) throw new TypeError('本地缩略图密文完整性校验失败。')
          if (recovery) {
            if (persisted) await deletePendingUploadObject(uploadId, prior.objectId, signal)
            const key = await deriveThumbnailKey(vault.vaultKey, vault.dataKey, fileId, thumbnailVersion)
            plaintext = await decryptObject(key, encrypted, aad)
            signal?.throwIfAborted()
            encrypted.fill(0); encrypted = await encryptObject(key, plaintext, aad)
            savedThumbnail = { reference: { ...prior, objectId: randomObjectId(), sha256: await sha256Hex(encrypted) }, ciphertext: encodeBase64(encrypted) }
          }
          record = { ...record, thumbnail: savedThumbnail }
          await saveUploadRecord(vault.vaultKey, record)
          signal?.throwIfAborted()
          await putEncryptedObject(uploadId, savedThumbnail.reference.objectId, encrypted, savedThumbnail.reference.sha256, signal, onPutNetworkWaiting)
        } finally { encrypted.fill(0); plaintext?.fill(0); aad.fill(0) }
      }
      entryBase = { ...entryBase, thumbnail: savedThumbnail.reference }
      completed += 1; onProgress(completed, totalSteps)
    }
    // Capture the preference once. Admission covers plaintext and encryption as
    // well as PUT, so large inputs cannot queue unbounded encrypted buffers.
    await runBoundedTasks(chunkCount, currentUploadConcurrency(), async (index, chunkSignal) => {
      if (!record) throw new Error('Upload recovery record missing')
      const prior = record.chunks[index]
      const persisted = prior ? uploaded.get(prior.objectId) : undefined
      if (prior && persisted && persisted.sizeBytes === prior.sizeBytes && persisted.sha256 === prior.sha256) {
        ;(manifestChunks as { objectId: string; sha256: string }[])[index] = { ...manifestChunks[index]!, objectId: prior.objectId, sha256: prior.sha256 }
        uploadedObjectIds[index] = prior.objectId
        completed += 1
        onProgress(completed, totalSteps, { phase: 'uploading', completedBytes: uploadedContentBytes, totalBytes: file.size })
        return
      }
      chunkSignal.throwIfAborted()
      onProgress(completed, totalSteps, { phase: 'encrypting', completedBytes: uploadedContentBytes, totalBytes: file.size })
      if (persisted) await deletePendingUploadObject(uploadId, persisted.objectId, chunkSignal)
      let plaintext: Uint8Array | undefined
      let aad: Uint8Array | undefined
      let encrypted: Uint8Array | undefined
      try {
        const start = index * FILE_CHUNK_BYTES
        plaintext = takeArrayBufferBytes(await file.slice(start, Math.min(start + FILE_CHUNK_BYTES, file.size)).arrayBuffer())
        chunkSignal.throwIfAborted()
        aad = chunkAAD({ fileId, chunkIndex: index, chunkCount, plaintextSize: plaintext.byteLength }, fileCryptoVersion)
        encrypted = await encryptObject(fileKey, plaintext, aad)
        chunkSignal.throwIfAborted()
        const digest = await sha256Hex(encrypted)
        const piece: UploadPiece = { objectId: randomObjectId(), sizeBytes: encrypted.byteLength, sha256: digest }
        await writeAhead(async () => {
          chunkSignal.throwIfAborted()
          if (!record) throw new Error('Upload recovery record missing')
          // Build from the latest persisted snapshot inside the queue, never
          // from a captured older record that can overwrite another chunk.
          const next = { ...record, chunks: record.chunks.map((existing, part) => part === index ? piece : existing), manifest: null, index: null, trashIndex: null, indexRevision: null, idempotencyKey: null }
          await saveUploadRecord(vault.vaultKey, next)
          record = next
        })
        chunkSignal.throwIfAborted()
        ;(manifestChunks as { objectId: string; sha256: string }[])[index] = { ...manifestChunks[index]!, objectId: piece.objectId, sha256: digest }
        onProgress(completed, totalSteps, { phase: 'uploading', completedBytes: uploadedContentBytes, totalBytes: file.size })
        await putEncryptedObject(uploadId, piece.objectId, encrypted, digest, chunkSignal, onPutNetworkWaiting)
        uploadedObjectIds[index] = piece.objectId
        completed += 1
        uploadedContentBytes += plaintext.byteLength
        onProgress(completed, totalSteps, { phase: 'uploading', completedBytes: uploadedContentBytes, totalBytes: file.size })
      } finally {
        plaintext?.fill(0); aad?.fill(0); encrypted?.fill(0)
      }
    }, signal)

    const isCommitConflict = (error: unknown) => error instanceof APIError && error.status === 409 && ['vault_mutation_conflict', 'global_revision_conflict', 'metadata_revision_conflict'].includes(error.code)
    onProgress(completed, totalSteps, { phase: 'committing', completedBytes: uploadedContentBytes, totalBytes: file.size })
    return await retryTraversalMutation(async () => {
      if (!record) throw new Error('Upload recovery record missing')
      status = await request<UploadStatus>(`/api/v1/uploads/${encodeURIComponent(uploadId)}`, signal)
      uploadedObjectIds.length = chunkCount
      if (savedThumbnail) uploadedObjectIds.push(savedThumbnail.reference.objectId)
      completed = chunkCount + (savedThumbnail ? 1 : 0)
      commitStarted = false
      try {
        // A resumed attempt re-encrypts the derived metadata with the latest index revision.
        // Old pending metadata objects cannot be activated and must release their quota first.
        const oldManifest = record.manifest
        const oldIndex = record.index
        const oldTrashIndex = record.trashIndex
        if (status && oldManifest && status.objects.some((piece) => piece.objectId === oldManifest.objectId)) await deletePendingUploadObject(uploadId, oldManifest.objectId)
        if (status && oldIndex && status.objects.some((piece) => piece.objectId === oldIndex.objectId)) await deletePendingUploadObject(uploadId, oldIndex.objectId)
        if (status && oldTrashIndex && status.objects.some((piece) => piece.objectId === oldTrashIndex.objectId)) await deletePendingUploadObject(uploadId, oldTrashIndex.objectId)
        vault = await refreshVaultFromServer(vault, signal)
        directory = await locateActiveDirectory(vault, directory, signal)
        const freshDirectory = directory
        const currentReplaced = replaceEntryId ? freshDirectory.entries.find((entry) => entry.entryId === replaceEntryId) : undefined
        if (replaceEntryId && conflictIdentity(currentReplaced ?? null) !== replacementIdentity) throw new UploadConflictChangedError()
        if (freshDirectory.entries.some((entry) => entry.name === targetName && entry.entryId !== replaceEntryId && entry.fileId !== fileId)) throw new UploadConflictChangedError()
        if (freshDirectory.entries.length >= 5000 && !replaceEntryId) throw new TypeError('目标目录已达到 5000 项上限。')
        directory = { ...directory, revision: freshDirectory.revision, entries: freshDirectory.entries }
        const freshTrash = currentReplaced ? await fetchActiveTrashIndex(vault.metadataKey, vault.trashIndexId) : undefined
        if (freshTrash && freshTrash.entries.length >= 5000) throw new TypeError('回收站根目录已达到 5000 项上限，请先清理。')
        const latestState = await request<{ vaultMutationRevision: number }>('/api/v1/vault/state', signal)
        if (latestState.vaultMutationRevision !== vault.vaultMutationRevision) throw new APIError(409, 'vault_mutation_conflict')

        throwIfAborted(signal)
        const manifestPlaintext = utf8Strict(JSON.stringify(buildManifest()))
        const manifestAADBytes = manifestAAD(fileId, fileCryptoVersion)
        let encryptedManifest: Uint8Array | undefined
        try {
          encryptedManifest = await encryptObject(fileKey, manifestPlaintext, manifestAADBytes)
          const manifestDigest = await sha256Hex(encryptedManifest)
          const manifestPiece: UploadPiece = { objectId: randomObjectId(), sizeBytes: encryptedManifest.byteLength, sha256: manifestDigest }
          record = { ...record, manifest: manifestPiece, index: null, indexRevision: null, idempotencyKey: null }
          await saveUploadRecord(vault.vaultKey, record)
          const entry: DriveEntry = { ...entryBase, manifestObjectId: manifestPiece.objectId, manifestSha256: manifestDigest }
          const nextEntries = [...directory.entries.filter((item) => item.entryId !== replaceEntryId), entry]
          indexPlaintext = utf8Strict(JSON.stringify({ version: 1, indexId: directory.indexId, entries: nextEntries }))
          const trashEntry: TrashRootEntry | undefined = currentReplaced && tombstoneId ? {
            tombstoneId, item: currentReplaced, originalParentId: directory.indexId,
            originalPath: directory.path.map((crumb, index) => ({ indexId: crumb.indexId, name: crumb.name, childIndexId: directory.path[index + 1]?.indexId ?? directory.indexId })),
            deletedAt: Date.now(),
          } : undefined
          const nextTrashEntries = trashEntry && freshTrash ? [...freshTrash.entries, trashEntry] : undefined
          trashPlaintext = nextTrashEntries ? utf8Strict(JSON.stringify({ version: 1, indexId: vault.trashIndexId, entries: nextTrashEntries })) : undefined
          throwIfAborted(signal)
          if (indexPlaintext.byteLength + ENVELOPE_OVERHEAD_BYTES > 4 * 1024 * 1024 || (trashPlaintext && trashPlaintext.byteLength + ENVELOPE_OVERHEAD_BYTES > 4 * 1024 * 1024)) {
            trashPlaintext?.fill(0)
            throw new TypeError('目录或回收站索引超过 4 MiB 限制。')
          }
          const neededReservation = expectedReservation + (indexPlaintext.byteLength - originalIndexBytes) + (trashPlaintext ? trashPlaintext.byteLength - originalTrashBytes : 0)
          if (neededReservation !== (status?.reservedBytes ?? expectedReservation)) {
            await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/reserve`, { reservedBytes: neededReservation }, true, undefined, signal)
          }
          await putEncryptedObject(uploadId, manifestPiece.objectId, encryptedManifest, manifestDigest, signal, onPutNetworkWaiting)
          uploadedObjectIds.push(manifestPiece.objectId)
          const nextIndexRevision = directory.revision + 1
          const indexAADBytes = indexAAD(directory.indexId, nextIndexRevision)
          let encryptedIndex: Uint8Array | undefined
          try {
            encryptedIndex = await encryptObject(vault.metadataKey, indexPlaintext, indexAADBytes)
            const indexPiece: UploadPiece = { objectId: randomObjectId(), sizeBytes: encryptedIndex.byteLength, sha256: await sha256Hex(encryptedIndex) }
            const idempotencyKey = randomObjectId()
            record = { ...record, index: indexPiece, indexRevision: nextIndexRevision, idempotencyKey }
            await saveUploadRecord(vault.vaultKey, record)
            await putEncryptedObject(uploadId, indexPiece.objectId, encryptedIndex, indexPiece.sha256, signal, onPutNetworkWaiting)
            uploadedObjectIds.push(indexPiece.objectId)
          } finally {
            indexAADBytes.fill(0)
            encryptedIndex?.fill(0)
            indexPlaintext.fill(0)
          }
          completed += 1
          onProgress(completed, totalSteps)

          if (trashPlaintext && freshTrash && currentReplaced) {
            const trashAADBytes = indexAAD(vault.trashIndexId, freshTrash.revision + 1)
            let trashEnvelope: Uint8Array | undefined
            try {
              trashEnvelope = await encryptObject(vault.metadataKey, trashPlaintext, trashAADBytes)
              const trashPiece: UploadPiece = { objectId: randomObjectId(), sizeBytes: trashEnvelope.byteLength, sha256: await sha256Hex(trashEnvelope) }
              record = { ...record, trashIndex: trashPiece }
              await saveUploadRecord(vault.vaultKey, record)
              await putEncryptedObject(uploadId, trashPiece.objectId, trashEnvelope, trashPiece.sha256, signal, onPutNetworkWaiting)
              uploadedObjectIds.push(trashPiece.objectId)
            } finally { trashAADBytes.fill(0); trashEnvelope?.fill(0); trashPlaintext.fill(0); trashPlaintext = undefined }
            completed += 1
            onProgress(completed, totalSteps)

            const build = await post<{ buildId: string }>('/api/v1/tombstone-builds', { expectedGlobalRevision: latestState.vaultMutationRevision }, true, undefined, signal)
            buildId = build.buildId
            const members = await collectTombstoneMembers(vault, currentReplaced, signal)
            const batch: { type: 'object' | 'metadata'; id: string }[] = []
            for (const [key, type] of members) {
              batch.push({ type, id: key.slice(key.indexOf(':') + 1) })
              if (batch.length === 500) await post(`/api/v1/tombstone-builds/${encodeURIComponent(buildId)}/members`, { members: batch.splice(0) }, true, undefined, signal)
            }
            if (batch.length > 0) await post(`/api/v1/tombstone-builds/${encodeURIComponent(buildId)}/members`, { members: batch }, true, undefined, signal)
          }

          const transactionRequest = {
            uploadId,
            expectedGlobalRevision: latestState.vaultMutationRevision,
            activateObjectIds: uploadedObjectIds,
            updates: [
              { metadataId: directory.indexId, expectedRevision: directory.revision, objectId: record.index!.objectId },
              ...(freshTrash && record.trashIndex ? [{ metadataId: vault.trashIndexId, expectedRevision: freshTrash.revision, objectId: record.trashIndex.objectId }] : []),
            ],
            ...(buildId && tombstoneId ? { finalizeTombstoneBuildId: buildId, createTombstoneId: tombstoneId } : {}),
          }
          commitStarted = true
          const transaction = await postIdempotentWithRetry<{ vaultMutationRevision: number }>(transactionRequest, record.idempotencyKey!, signal)
          await deleteUploadRecord(record.id)
          const updatedVault = { ...vault, vaultMutationRevision: transaction.vaultMutationRevision,
            ...(nextTrashEntries && freshTrash ? { trashEntries: nextTrashEntries, trashRevision: freshTrash.revision + 1 } : {}) }
          const updatedDirectory = { ...directory, entries: nextEntries, revision: nextIndexRevision }
          return {
            vault: directory.indexId === vault.rootIndexId ? { ...updatedVault, rootEntries: nextEntries, rootRevision: nextIndexRevision } : updatedVault,
            directory: updatedDirectory,
          }
        } finally {
          manifestPlaintext.fill(0)
          manifestAADBytes.fill(0)
          encryptedManifest?.fill(0)
        }
      } catch (error) {
        if (isCommitConflict(error)) {
          commitStarted = false
          if (buildId) {
            try { await requestWithInit<void>(`/api/v1/tombstone-builds/${encodeURIComponent(buildId)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken }, signal: AbortSignal.timeout(5000) }) } catch { /* Membership expires without finalization. */ }
            buildId = ''
          }
          indexPlaintext?.fill(0); trashPlaintext?.fill(0)
        }
        throw error
      }
    }, isCommitConflict, signal)
  } catch (error) {
    // A semantic conflict has no committed transaction. Discard its encrypted
    // recovery record only after the server acknowledges release of the session.
    // Lost/ambiguous commit responses keep their original replayable record.
    indexPlaintext?.fill(0); trashPlaintext?.fill(0)
    if (uploadId && error instanceof UploadConflictChangedError && !commitStarted) {
      await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/abandon`, {}, true)
      if (record) await deleteUploadRecord(record.id)
    }
    if (!commitStarted && uploadId && !recordSaved) {
      try { await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/abandon`, {}, true) } catch { /* Expiry and startup recovery release abandoned work. */ }
    }
    if (buildId) {
      try { await requestWithInit<void>(`/api/v1/tombstone-builds/${encodeURIComponent(buildId)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } }) } catch { /* Build expires after one hour. */ }
    }
    indexPlaintext?.fill(0)
    trashPlaintext?.fill(0)
    throw error
  }
}

export type ResolveFolderConflicts = (conflicts: readonly FolderConflict[], signal?: AbortSignal) => Promise<ReadonlyMap<string, FolderConflictAction>>

async function uploadFolderCore(
  vault: UnlockedVault,
  destination: DirectoryState,
  files: readonly File[],
  onProgress: FolderUploadProgressListener = () => undefined,
  signal?: AbortSignal,
  resolveConflicts?: ResolveFolderConflicts,
  flat = false,
): Promise<{ vault: UnlockedVault; directory: DirectoryState; completedFiles: number; skippedFiles: number; failures: readonly string[]; capacityFailure?: { code: string; shortfallBytes?: number } }> {
  const parseSelection = flat ? parseFileSelection<File> : parseFolderSelection<File>
  const original = parseSelection(files)
  const remaining = new Map(original.records.map((record) => [record.segments.join('/'), record.file]))
  const failures: string[] = []
  let completedFiles = 0, skippedFiles = 0, processedFiles = 0, rechecks = 0
  const totalPlaintextBytes = original.records.reduce((sum, record) => sum + record.file.size, 0)
  let committedPlaintextBytes = 0
  let capacityFailure: { code: string; shortfallBytes?: number } | undefined
  const readSnapshot = async (selection: ReturnType<typeof parseFolderSelection<File>>) => retryTraversalMutation(async () => {
    const freshVault = await refreshVaultFromServer(vault, signal)
    const freshDestination = await locateActiveDirectory(freshVault, destination, signal)
    const directories = await validateFolderMerge(selection, freshDestination, (id, path) => loadDirectory(freshVault, id, path, signal), signal, false, true)
    const state = await request<{ vaultMutationRevision: number }>('/api/v1/vault/state', signal)
    if (state.vaultMutationRevision !== freshVault.vaultMutationRevision) throw new APIError(409, 'vault_mutation_conflict')
    return { vault: freshVault, destination: freshDestination, directories }
  }, (error) => error instanceof APIError && ['vault_mutation_conflict', 'metadata_revision_conflict'].includes(error.code), signal)
  while (remaining.size > 0) {
    throwIfAborted(signal)
    const selection = parseSelection([...remaining.values()])
    const before = await readSnapshot(selection)
    const conflicts = collectFolderConflicts(selection, before.directories)
    if (conflicts.length && !resolveConflicts) throw new TypeError('上传项目存在同名文件，请先选择批量冲突处理方式。')
    const choices = conflicts.length ? await resolveConflicts!(conflicts, signal) : new Map<string, FolderConflictAction>()
    throwIfAborted(signal)
    // Never carry an approval across a changed replacement identity. New or
    // changed conflicts are shown again, rather than inheriting "replace all".
    const checked = await readSnapshot(selection)
    if (folderConflictSignature(conflicts) !== folderConflictSignature(collectFolderConflicts(selection, checked.directories))) {
      if (++rechecks >= 4) throw new TypeError('目标目录持续变化，请等待其他操作完成后重新选择上传项目。')
      continue
    }
    const plan = planFolderConflictChoices(selection, checked.directories, choices)
    if (plan.records.length) {
      await validateFolderMerge(plannedFolderSelection(plan.records), checked.destination, (id, path) => loadDirectory(checked.vault, id, path, signal), signal, true, true)
      const state = await request<{ vaultMutationRevision: number }>('/api/v1/vault/state', signal)
      if (state.vaultMutationRevision !== checked.vault.vaultMutationRevision) {
        if (++rechecks >= 4) throw new TypeError('目标目录持续变化，请等待其他操作完成后重新选择上传项目。')
        continue
      }
    }
    vault = checked.vault; destination = checked.destination
    const ensureChildFolder = async (parent: DirectoryState, name: string): Promise<DirectoryState> => {
      let child = parent.entries.find((entry) => entry.name === name)
      if (child && child.kind !== 'folder') throw new TypeError(`路径“${name}”与现有文件冲突。`)
      if (!child) {
        const created = await createFolderCore(vault, parent, name, signal)
        vault = created.vault; parent = created.directory
        if (parent.indexId === destination.indexId) destination = parent
        child = parent.entries.find((entry) => entry.name === name)
      }
      if (!child?.childIndexId) throw new TypeError(`无法打开文件夹“${name}”。`)
      return loadDirectory(vault, child.childIndexId, [...parent.path, { indexId: parent.indexId, name }], signal)
    }
    let restart = false
    for (const replacement of [...plan.folderReplacements].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
      try {
        const segments = replacement.path.split('/')
        let parent = destination
        for (const name of segments.slice(0, -1)) parent = await ensureChildFolder(parent, name)
        const current = parent.entries.find((entry) => entry.name === segments.at(-1))
        if (conflictIdentity(current ?? null) !== conflictIdentity(replacement.expected)) throw new UploadConflictChangedError()
        const created = await replaceFileWithFolderCore(vault, parent, replacement.expected, signal)
        vault = created.vault
        if (created.directory.indexId === destination.indexId) destination = created.directory
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        if (error instanceof UploadConflictChangedError) {
          if (++rechecks >= 4) throw new TypeError('目标目录持续出现新冲突，已停止上传；已完成项目保留，请重新选择。')
          restart = true; break
        }
        throw error
      }
    }
    if (restart) continue
    for (const path of plan.skippedPaths) { remaining.delete(path); skippedFiles += 1; processedFiles += 1; onProgress(processedFiles, files.length) }
    for (const record of plan.records) {
      throwIfAborted(signal)
      try {
        // Another device can mutate while this page owns its local Web Lock.
        // Read actual paths/entries for every file; only completed files persist.
        vault = await refreshVaultFromServer(vault, signal)
        destination = await locateActiveDirectory(vault, destination, signal)
        let parent = destination
        for (const name of record.segments.slice(0, -1)) parent = await ensureChildFolder(parent, name)
        const current = parent.entries.find((entry) => entry.name === record.targetName) as ConflictEntry | undefined
        if (conflictIdentity(current ?? null) !== conflictIdentity(record.expected)) throw new UploadConflictChangedError()
        const result = await uploadFileCore(vault, record.file, parent, (_steps, _total, progress) => {
          if (progress) onProgress(processedFiles, files.length, {
            phase: progress.phase,
            completedBytes: committedPlaintextBytes + progress.completedBytes,
            totalBytes: totalPlaintextBytes,
            currentFileName: record.file.name,
          })
        }, signal, undefined, {
          targetName: record.targetName, ...(record.expected ? { replaceEntryId: record.expected.entryId, expectedReplacementIdentity: conflictIdentity(record.expected) } : {}),
        })
        vault = result.vault
        remaining.delete(record.sourcePath); completedFiles += 1; processedFiles += 1
        committedPlaintextBytes += record.file.size
        onProgress(processedFiles, files.length, { phase: 'uploading', completedBytes: committedPlaintextBytes, totalBytes: totalPlaintextBytes, currentFileName: record.file.name })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        if (error instanceof ConcurrentMutationRetryExhaustedError) throw error
        if (error instanceof UploadConflictChangedError) {
          if (++rechecks >= 4) throw new TypeError('目标目录持续出现新冲突，已停止上传；已完成文件保留，请重新选择剩余文件。')
          restart = true; break
        }
        failures.push(`${record.sourcePath}: ${error instanceof Error ? error.message : '上传失败'}`)
        remaining.delete(record.sourcePath); processedFiles += 1
        onProgress(processedFiles, files.length)
        if (error instanceof APIError && ['quota_exceeded', 'disk_space_low', 'vault_mutation_conflict', 'global_revision_conflict', 'metadata_revision_conflict'].includes(error.code)) {
          if (['quota_exceeded', 'disk_space_low'].includes(error.code)) capacityFailure = { code: error.code, shortfallBytes: error.shortfallBytes }
          remaining.clear(); break
        }
      }
    }
    if (restart) continue
  }
  vault = await refreshVaultFromServer(vault, signal)
  const directory = await locateActiveDirectory(vault, destination, signal)
  return { vault, directory, completedFiles, skippedFiles, failures, capacityFailure }
}

async function createFolderCore(vault: UnlockedVault, directory: DirectoryState, rawName: string, signal?: AbortSignal): Promise<{ vault: UnlockedVault; directory: DirectoryState }> {
  const name = rawName.normalize('NFC')
  if (!isValidName(name)) throw new TypeError('文件夹名称包含不支持的字符。')
  if (directory.entries.length >= 5000) throw new TypeError('当前文件夹已达到 5000 项上限。')
  if (directory.entries.some((entry) => entry.name === name)) throw new TypeError('当前文件夹已有同名项目。')

  const childIndexId = randomObjectId()
  const entry: DriveEntry = { entryId: randomObjectId(), kind: 'folder', name, childIndexId, originalModifiedAt: Date.now(), createdAt: Date.now() }
  const nextEntries = [...directory.entries, entry]
  const nextRevision = directory.revision + 1
  const childObjectId = randomObjectId()
  const parentObjectId = randomObjectId()
  const childPlaintext = utf8Strict(JSON.stringify({ version: 1, indexId: childIndexId, entries: [] }))
  const parentPlaintext = utf8Strict(JSON.stringify({ version: 1, indexId: directory.indexId, entries: nextEntries }))
  if (childPlaintext.byteLength + parentPlaintext.byteLength + ENVELOPE_OVERHEAD_BYTES * 2 > 4 * 1024 * 1024) {
    childPlaintext.fill(0)
    parentPlaintext.fill(0)
    throw new TypeError('目录索引超过 4 MiB 限制。')
  }
  const childAAD = indexAAD(childIndexId, 1)
  const parentAAD = indexAAD(directory.indexId, nextRevision)
  let childEnvelope: Uint8Array | undefined
  let parentEnvelope: Uint8Array | undefined
  let uploadId = ''
  let commitStarted = false
  try {
    childEnvelope = await encryptObject(vault.metadataKey, childPlaintext, childAAD)
    parentEnvelope = await encryptObject(vault.metadataKey, parentPlaintext, parentAAD)
    const reserveBytes = childEnvelope.byteLength + parentEnvelope.byteLength
    const session = await post<{ uploadId: string }>('/api/v1/uploads', {}, true, undefined, signal)
    uploadId = session.uploadId
    await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/reserve`, { reservedBytes: reserveBytes }, true, undefined, signal)
    await putEncryptedObject(uploadId, childObjectId, childEnvelope, await sha256Hex(childEnvelope), signal)
    await putEncryptedObject(uploadId, parentObjectId, parentEnvelope, await sha256Hex(parentEnvelope), signal)
    throwIfAborted(signal)
    commitStarted = true
    const transaction = await postIdempotentWithRetry<{ vaultMutationRevision: number }>({
      uploadId,
      expectedGlobalRevision: vault.vaultMutationRevision,
      activateObjectIds: [childObjectId, parentObjectId],
      updates: [
        { metadataId: childIndexId, expectedRevision: 0, objectId: childObjectId },
        { metadataId: directory.indexId, expectedRevision: directory.revision, objectId: parentObjectId },
      ],
    }, randomObjectId(), signal)
    const updatedVault = { ...vault, vaultMutationRevision: transaction.vaultMutationRevision }
    const updatedDirectory = { ...directory, entries: nextEntries, revision: nextRevision }
    return {
      vault: directory.indexId === vault.rootIndexId ? { ...updatedVault, rootEntries: nextEntries, rootRevision: nextRevision } : updatedVault,
      directory: updatedDirectory,
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof APIError && error.status >= 400 && error.status < 500)) commitStarted = false
    if (!commitStarted && uploadId) {
      try { await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/abandon`, {}, true) } catch { /* Expiry recovery releases abandoned work. */ }
    }
    throw error
  } finally {
    childPlaintext.fill(0)
    parentPlaintext.fill(0)
    childAAD.fill(0)
    parentAAD.fill(0)
    childEnvelope?.fill(0)
    parentEnvelope?.fill(0)
  }
}

/** Atomically replace a file with a new folder shell and move the old file to trash. */
async function replaceFileWithFolderCore(vault: UnlockedVault, previous: DirectoryState, expected: ConflictEntry, signal?: AbortSignal): Promise<{ vault: UnlockedVault; directory: DirectoryState }> {
  return retryTraversalMutation(async () => {
    const current = await refreshVaultFromServer(vault, signal)
    const directory = await locateActiveDirectory(current, previous, signal)
    const replaced = directory.entries.find((entry) => entry.name === expected.name)
    if (!replaced || conflictIdentity(replaced) !== conflictIdentity(expected) || replaced.kind !== 'file') throw new UploadConflictChangedError()
    if (directory.entries.length > 5000 || current.trashEntries.length >= 5000) throw new TypeError('当前目录或回收站已达到 5000 项限制，请先清理。')
    const trash = await fetchActiveTrashIndex(current.metadataKey, current.trashIndexId, signal)
    if (trash.entries.length >= 5000) throw new TypeError('回收站根目录已达到 5000 项上限，请先清理。')

    const childIndexId = randomObjectId(), tombstoneId = randomObjectId()
    const folder: DriveEntry = { entryId: randomObjectId(), kind: 'folder', name: expected.name, childIndexId, originalModifiedAt: Date.now(), createdAt: Date.now() }
    const root: TrashRootEntry = {
      tombstoneId, item: replaced, originalParentId: directory.indexId,
      originalPath: directory.path.map((crumb, index) => ({ indexId: crumb.indexId, name: crumb.name, childIndexId: directory.path[index + 1]?.indexId ?? directory.indexId })),
      deletedAt: Date.now(),
    }
    const nextEntries = [...directory.entries.filter((entry) => entry.entryId !== replaced.entryId), folder]
    const nextTrash = [...trash.entries, root]
    const definitions = [
      { id: childIndexId, revision: 0, entries: [] as readonly DriveEntry[] },
      { id: directory.indexId, revision: directory.revision, entries: nextEntries as readonly DriveEntry[] },
      { id: current.trashIndexId, revision: trash.revision, entries: nextTrash as readonly TrashRootEntry[] },
    ]
    const prepared: { id: string; revision: number; objectId: string; envelope: Uint8Array }[] = []
    const plaintexts: Uint8Array[] = [], aads: Uint8Array[] = []
    let buildId = '', uploadId = '', commitStarted = false
    try {
      let reservedBytes = 0
      for (const definition of definitions) {
        throwIfAborted(signal)
        const plaintext = utf8Strict(JSON.stringify({ version: 1, indexId: definition.id, entries: definition.entries }))
        const aad = indexAAD(definition.id, definition.revision + 1)
        plaintexts.push(plaintext); aads.push(aad)
        if (plaintext.byteLength + ENVELOPE_OVERHEAD_BYTES > 4 * 1024 * 1024) throw new TypeError('目录或回收站索引超过 4 MiB 限制。')
        const envelope = await encryptObject(current.metadataKey, plaintext, aad)
        reservedBytes += envelope.byteLength
        if (reservedBytes > 32 * 1024 * 1024) { envelope.fill(0); throw new TypeError('文件夹替换索引超过 32 MiB 安全预算。') }
        prepared.push({ id: definition.id, revision: definition.revision, objectId: randomObjectId(), envelope })
      }
      const staged = await post<{ buildId: string }>('/api/v1/tombstone-builds', { expectedGlobalRevision: current.vaultMutationRevision }, true, undefined, signal)
      buildId = staged.buildId
      const members = await collectTombstoneMembers(current, replaced, signal)
      const batch: { type: 'object' | 'metadata'; id: string }[] = []
      for (const [key, type] of members) {
        batch.push({ type, id: key.slice(key.indexOf(':') + 1) })
        if (batch.length === 500) await post(`/api/v1/tombstone-builds/${encodeURIComponent(buildId)}/members`, { members: batch.splice(0) }, true, undefined, signal)
      }
      if (batch.length) await post(`/api/v1/tombstone-builds/${encodeURIComponent(buildId)}/members`, { members: batch }, true, undefined, signal)

      const session = await post<{ uploadId: string }>('/api/v1/uploads', {}, true, undefined, signal)
      uploadId = session.uploadId
      await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/reserve`, { reservedBytes }, true, undefined, signal)
      for (const item of prepared) await putEncryptedObject(uploadId, item.objectId, item.envelope, await sha256Hex(item.envelope), signal)
      throwIfAborted(signal)
      commitStarted = true
      const result = await postIdempotentWithRetry<{ vaultMutationRevision: number }>({
        uploadId, expectedGlobalRevision: current.vaultMutationRevision,
        activateObjectIds: prepared.map((item) => item.objectId),
        updates: prepared.map((item) => ({ metadataId: item.id, expectedRevision: item.revision, objectId: item.objectId })),
        finalizeTombstoneBuildId: buildId, createTombstoneId: tombstoneId,
      }, randomObjectId(), signal)
      const updatedVault = { ...current, trashEntries: nextTrash, trashRevision: trash.revision + 1, vaultMutationRevision: result.vaultMutationRevision }
      const updatedDirectory = { ...directory, entries: nextEntries, revision: directory.revision + 1 }
      return {
        vault: directory.indexId === current.rootIndexId ? { ...updatedVault, rootEntries: nextEntries, rootRevision: updatedDirectory.revision } : updatedVault,
        directory: updatedDirectory,
      }
    } catch (error) {
      if (error instanceof APIError && error.status >= 400 && error.status < 500) commitStarted = false
      if (!commitStarted) {
        if (uploadId) try { await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/abandon`, {}, true) } catch { /* Expiry releases pending objects. */ }
        if (buildId) try { await requestWithInit<void>(`/api/v1/tombstone-builds/${encodeURIComponent(buildId)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken }, signal: AbortSignal.timeout(5000) }) } catch { /* Membership expires without finalization. */ }
      }
      throw error
    } finally {
      plaintexts.forEach((bytes) => bytes.fill(0)); aads.forEach((bytes) => bytes.fill(0)); prepared.forEach((item) => item.envelope.fill(0))
    }
  }, (error) => error instanceof APIError && error.status === 409 && ['global_revision_conflict', 'vault_mutation_conflict', 'metadata_revision_conflict'].includes(error.code), signal)
}

async function renameEntryCore(vault: UnlockedVault, directory: DirectoryState, entryId: string, rawName: string, signal?: AbortSignal): Promise<{ vault: UnlockedVault; directory: DirectoryState }> {
  const name = rawName.normalize('NFC')
  if (!isValidName(name)) throw new TypeError('名称包含不支持的字符。')
  const current = directory.entries.find((entry) => entry.entryId === entryId)
  if (!current) throw new TypeError('此项目已不存在，请刷新目录。')
  if (current.name === name) return { vault, directory }
  if (directory.entries.some((entry) => entry.entryId !== entryId && entry.name === name)) throw new TypeError('当前文件夹已有同名项目。')
  const nextEntries = directory.entries.map((entry) => entry.entryId === entryId ? { ...entry, name } : entry)
  const revision = directory.revision + 1
  const objectId = randomObjectId()
  const plaintext = utf8Strict(JSON.stringify({ version: 1, indexId: directory.indexId, entries: nextEntries }))
  if (plaintext.byteLength + ENVELOPE_OVERHEAD_BYTES > 4 * 1024 * 1024) {
    plaintext.fill(0)
    throw new TypeError('目录索引超过 4 MiB 限制。')
  }
  const aad = indexAAD(directory.indexId, revision)
  let envelope: Uint8Array | undefined
  let uploadId = ''
  let commitStarted = false
  try {
    envelope = await encryptObject(vault.metadataKey, plaintext, aad)
    throwIfAborted(signal)
    const session = await post<{ uploadId: string }>('/api/v1/uploads', {}, true, undefined, signal)
    uploadId = session.uploadId
    await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/reserve`, { reservedBytes: envelope.byteLength }, true, undefined, signal)
    await putEncryptedObject(uploadId, objectId, envelope, await sha256Hex(envelope), signal)
    throwIfAborted(signal)
    commitStarted = true
    const result = await postIdempotentWithRetry<{ vaultMutationRevision: number }>({
      uploadId,
      expectedGlobalRevision: vault.vaultMutationRevision,
      activateObjectIds: [objectId],
      updates: [{ metadataId: directory.indexId, expectedRevision: directory.revision, objectId }],
    }, randomObjectId(), signal)
    const updatedVault = { ...vault, vaultMutationRevision: result.vaultMutationRevision }
    const updatedDirectory = { ...directory, revision, entries: nextEntries }
    return {
      vault: directory.indexId === vault.rootIndexId ? { ...updatedVault, rootRevision: revision, rootEntries: nextEntries } : updatedVault,
      directory: updatedDirectory,
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof APIError && error.status >= 400 && error.status < 500)) commitStarted = false
    if (!commitStarted && uploadId) {
      try { await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/abandon`, {}, true) } catch { /* Expiry recovery releases abandoned work. */ }
    }
    throw error
  } finally {
    plaintext.fill(0)
    aad.fill(0)
    envelope?.fill(0)
  }
}

async function moveEntryCore(vault: UnlockedVault, source: DirectoryState, target: DirectoryState, entryId: string, signal?: AbortSignal): Promise<{ vault: UnlockedVault; source: DirectoryState; target: DirectoryState }> {
  return moveEntriesCore(vault, source, target, [entryId], signal)
}

async function moveEntriesCore(vault: UnlockedVault, source: DirectoryState, target: DirectoryState, entryIds: readonly string[], signal?: AbortSignal): Promise<{ vault: UnlockedVault; source: DirectoryState; target: DirectoryState }> {
  const selections = entryIds.map((id) => {
    const entry = source.entries.find((item) => item.entryId === id)
    if (!entry) throw new TypeError('选中的项目已变化，请刷新目录。')
    return { entry, parentIndexId: source.indexId, parentPath: source.path }
  })
  const result = await moveSelectedEntriesCore(vault, selections, target, signal)
  return { vault: result.vault, source: result.directories.get(source.indexId)!, target: result.target }
}

/** All source pointers and the destination switch in one global-revision CAS. */
async function moveSelectedEntriesCore(vault: UnlockedVault, selections: readonly ZipSelection[], target: DirectoryState, signal?: AbortSignal) {
  if (selections.length === 0 || selections.length > 250_000) throw new TypeError('移动选择为空或超过 250,000 项安全上限。')
  return retryTraversalMutation(async () => {
    const current = await refreshVaultFromServer(vault, signal)
    const destination = await locateActiveDirectory(current, target, signal)
    const parents = new Map<string, DirectoryState>([[destination.indexId, destination]])
    const resolved: ZipSelection[] = []
    const targetMeasure = utf8Strict(JSON.stringify(destination.entries))
    let snapshotBytes = targetMeasure.byteLength
    targetMeasure.fill(0)
    for (const selection of selections) {
      throwIfAborted(signal)
      let parent = parents.get(selection.parentIndexId)
      if (!parent) {
        if (parents.size >= 500) throw new TypeError('批量移动检查超过 500 个目录，请缩小选择范围。')
        parent = await locateActiveDirectory(current, { indexId: selection.parentIndexId, path: selection.parentPath ?? [] }, signal)
        const measure = utf8Strict(JSON.stringify(parent.entries))
        snapshotBytes += measure.byteLength
        measure.fill(0)
        if (snapshotBytes > 32 * 1024 * 1024) throw new TypeError('批量移动目录检查超过 32 MiB 安全预算，请缩小选择范围。')
        parents.set(parent.indexId, parent)
      }
      const entry = parent.entries.find((item) => item.entryId === selection.entry.entryId)
      if (!entry) throw new TypeError('已选项目已移动、被覆盖或删除，请重新选择。')
      resolved.push({ entry, parentIndexId: parent.indexId, parentPath: parent.path })
    }
    const plan = planMoveSelection(resolved, parents, destination)
    const prepared: { directory: DirectoryState; entries: readonly DriveEntry[]; objectId: string; envelope: Uint8Array }[] = []
    let uploadId = ''
    let commitStarted = false
    try {
      let reservedBytes = 0
      for (const [id, entries] of plan.changes) {
        throwIfAborted(signal)
        const directory = parents.get(id)!
        const plaintext = utf8Strict(JSON.stringify({ version: 1, indexId: id, entries }))
        const aad = indexAAD(id, directory.revision + 1)
        try {
          if (plaintext.byteLength + ENVELOPE_OVERHEAD_BYTES > 4 * 1024 * 1024) throw new TypeError('目录索引超过 4 MiB 限制。')
          if (reservedBytes + plaintext.byteLength + ENVELOPE_OVERHEAD_BYTES > 32 * 1024 * 1024) throw new TypeError('批量移动加密索引超过 32 MiB 安全预算，请缩小选择范围。')
          const envelope = await encryptObject(current.metadataKey, plaintext, aad)
          reservedBytes += envelope.byteLength
          prepared.push({ directory, entries, objectId: randomObjectId(), envelope })
        } finally { plaintext.fill(0); aad.fill(0) }
      }
      const session = await post<{ uploadId: string }>('/api/v1/uploads', {}, true, undefined, signal)
      uploadId = session.uploadId
      await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/reserve`, { reservedBytes }, true, undefined, signal)
      for (const item of prepared) await putEncryptedObject(uploadId, item.objectId, item.envelope, await sha256Hex(item.envelope), signal)
      throwIfAborted(signal)
      commitStarted = true
      const result = await postIdempotentWithRetry<{ vaultMutationRevision: number }>({
        uploadId, expectedGlobalRevision: current.vaultMutationRevision,
        activateObjectIds: prepared.map((item) => item.objectId),
        updates: prepared.map((item) => ({ metadataId: item.directory.indexId, expectedRevision: item.directory.revision, objectId: item.objectId })),
      }, randomObjectId(), signal)
      let updatedVault = { ...current, vaultMutationRevision: result.vaultMutationRevision }
      const directories = new Map(parents)
      for (const item of prepared) {
        const updated = { ...item.directory, entries: item.entries, revision: item.directory.revision + 1 }
        directories.set(updated.indexId, updated)
        if (updated.indexId === current.rootIndexId) updatedVault = { ...updatedVault, rootEntries: updated.entries, rootRevision: updated.revision }
      }
      for (const [id, directory] of directories) directories.set(id, { ...directory, path: relocatedMovePath(directory, destination, plan.moving) })
      return { vault: updatedVault, directories, target: directories.get(destination.indexId)!, movedCount: plan.movedCount }
    } catch (error) {
      if (signal?.aborted || (error instanceof APIError && error.status >= 400 && error.status < 500)) commitStarted = false
      if (!commitStarted && uploadId) {
        try { await post(`/api/v1/uploads/${encodeURIComponent(uploadId)}/abandon`, {}, true) } catch { /* Expiry releases abandoned work. */ }
      }
      throw error
    } finally { for (const item of prepared) item.envelope.fill(0) }
  }, (error) => error instanceof APIError && error.status === 409 && ['global_revision_conflict', 'vault_mutation_conflict', 'metadata_revision_conflict'].includes(error.code), signal)
}

export async function downloadFile(
  vault: UnlockedVault, entry: DriveEntry, signal?: AbortSignal, writable?: WritableStream<Uint8Array>,
  onProgress: (completedBytes: number, totalBytes: number) => void = () => undefined,
  onNetworkWaiting: (waiting: boolean) => void = () => undefined,
): Promise<Blob | void> {
  let destination: ReturnType<typeof openAbortableOutput> | undefined
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined
  let reader: EncryptedRangeReader | undefined
  const plaintextParts: Uint8Array[] = []
  try {
    if (!Number.isSafeInteger(entry.size) || entry.size === undefined || entry.size < 0) throw new TypeError('文件目录项不完整。')
    if (entry.size > 512 * 1024 * 1024 && !writable) throw new TypeError('此文件超过当前浏览器安全内存下载上限。')
    destination = writable ? openAbortableOutput(writable, signal) : undefined
    writer = destination?.stream.getWriter()
    reader = await createEncryptedRangeReader(vault, entry, signal, onNetworkWaiting)
    for (let offset = 0; offset < reader.length; offset += FILE_CHUNK_BYTES) {
      throwIfAborted(signal)
      const plaintext = await reader.readRange(offset, Math.min(reader.length, offset + FILE_CHUNK_BYTES), signal)
      if (writer) {
        try { await writer.write(plaintext) } finally { plaintext.fill(0) }
      } else { plaintextParts.push(plaintext) }
      onProgress(Math.min(reader.length, offset + Math.min(FILE_CHUNK_BYTES, reader.length - offset)), reader.length)
    }
    throwIfAborted(signal)
    if (writer) {
      await writer.close()
      throwIfAborted(signal)
      return
    }
    const temporaryCopies: Uint8Array<ArrayBuffer>[] = []
    try {
      const blobParts: BlobPart[] = plaintextParts.map((part) => {
        if (part.buffer instanceof ArrayBuffer) return part as Uint8Array<ArrayBuffer>
        const copy = new Uint8Array(new ArrayBuffer(part.byteLength))
        copy.set(part)
        temporaryCopies.push(copy)
        return copy
      })
      return new Blob(blobParts, { type: entry.mime || 'application/octet-stream' })
    } finally { temporaryCopies.forEach((part) => part.fill(0)) }
  } catch (error) {
    destination?.abort(error)
    if (!destination) void writable?.abort(error).catch(() => undefined)
    throw error
  } finally {
    reader?.destroy()
    writer?.releaseLock()
    destination?.dispose()
    plaintextParts.forEach((part) => part.fill(0))
  }
}

export interface EncryptedRangeReader {
  readonly length: number
  readRange(begin: number, end: number, signal?: AbortSignal): Promise<Uint8Array>
  destroy(): void
}

/** Exports current directory contents (without an extra enclosing directory). */
export async function downloadDirectoryAsZip(
  vault: UnlockedVault, directory: DirectoryState, signal?: AbortSignal, writable?: WritableStream<Uint8Array>,
  onProgress: (written: number, total: number) => void = () => undefined,
  onNetworkWaiting: (waiting: boolean) => void = () => undefined,
): Promise<Blob | void> {
  try { return await writeZipSelection(vault, directory.entries.map((entry) => ({ entry, parentIndexId: directory.indexId })), signal, writable, onProgress, undefined, onNetworkWaiting) }
  catch (error) { void writable?.abort(error).catch(() => undefined); throw error }
}

/** Resolves selected opaque entries afresh before emitting any archive bytes. */
export async function downloadSelectedAsZip(
  vault: UnlockedVault, selections: readonly ZipSelection[], signal?: AbortSignal, writable?: WritableStream<Uint8Array>,
  onProgress: (written: number, total: number) => void = () => undefined,
  onNetworkWaiting: (waiting: boolean) => void = () => undefined,
): Promise<Blob | void> {
  try {
    const current = await refreshVaultFromServer(vault, signal)
    const parents = new Map<string, DirectoryState>()
    const resolved: ZipSelection[] = []
    for (const selection of selections) {
      throwIfAborted(signal)
      let parent = parents.get(selection.parentIndexId)
      if (!parent) {
        parent = await locateActiveDirectory(current, { indexId: selection.parentIndexId, path: selection.parentPath ?? [] }, signal)
        parents.set(parent.indexId, parent)
      }
      const entry = parent.entries.find((item) => item.entryId === selection.entry.entryId)
      if (!entry) throw new TypeError('已选项目已移动、被覆盖或删除，请重新选择后下载。')
      resolved.push({ entry, parentIndexId: parent.indexId, parentPath: parent.path })
    }
    return await writeZipSelection(current, resolved, signal, writable, onProgress, current.vaultMutationRevision, onNetworkWaiting)
  } catch (error) { void writable?.abort(error).catch(() => undefined); throw error }
}

async function writeZipSelection(
  vault: UnlockedVault, selections: readonly ZipSelection[], signal?: AbortSignal, writable?: WritableStream<Uint8Array>,
  onProgress: (written: number, total: number) => void = () => undefined, expectedGlobalRevision?: number,
  onNetworkWaiting: (waiting: boolean) => void = () => undefined,
): Promise<Blob | void> {
  const { items: archiveItems, totalPlaintextBytes, estimatedArchiveBytes } = await planZipSelection(selections, async (id) => (await fetchIndex(vault.metadataKey, id, signal)).entries, signal)
  if (expectedGlobalRevision !== undefined) {
    const state = await request<{ vaultMutationRevision: number }>('/api/v1/vault/state', signal)
    if (state.vaultMutationRevision !== expectedGlobalRevision) throw new TypeError('打包检查期间云盘发生变化，请等待其他操作完成后重新下载。')
  }
  const fallbackLimit = writable ? undefined : await fetchZipMemoryFallbackLimit(signal)
  if (fallbackLimit !== undefined && estimatedArchiveBytes > fallbackLimit) throw new TypeError(`所选内容的 ZIP 预计超过 ${fallbackLimit.toLocaleString('zh-CN')} bytes 内存上限；请使用支持流式下载的浏览器，或缩小打包范围。`)

  const { ZipWriter } = await import('@zip.js/zip.js')
  const destination = writable ? openAbortableOutput(writable, signal) : undefined
  const memory = fallbackLimit === undefined ? undefined : createBoundedBlobOutput(fallbackLimit, 'application/zip', signal)
  const output = destination?.stream ?? memory!.stream
  const writer = new ZipWriter(output, { zip64: true, level: 0, useWebWorkers: false, useCompressionStream: false, signal })
  let writtenPlaintextBytes = 0
  try {
    for (const item of archiveItems) {
      throwIfAborted(signal)
      if (item.directory) {
        await writer.add(item.path, null, { directory: true, zip64: true, signal })
        continue
      }
      const entry = item.entry!
      const reader = await createEncryptedRangeReader(vault, entry, signal, onNetworkWaiting)
      let offset = 0
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            throwIfAborted(signal)
            if (offset >= reader.length) {
              reader.destroy()
              controller.close()
              return
            }
            const end = Math.min(reader.length, offset + FILE_CHUNK_BYTES)
            const chunk = await reader.readRange(offset, end, signal)
            offset = end
            controller.enqueue(chunk)
            if (offset >= reader.length) {
              reader.destroy()
              controller.close()
            }
          } catch (error) {
            reader.destroy()
            controller.error(error)
          }
        },
        cancel() { reader.destroy() },
      })
      try {
        await writer.add(item.path, stream, {
          zip64: true,
          level: 0,
          useWebWorkers: false,
          useCompressionStream: false,
          signal,
          onprogress(progress) {
            onProgress(writtenPlaintextBytes + Math.min(entry.size ?? 0, progress), totalPlaintextBytes)
          },
        })
      } finally {
        reader.destroy()
      }
      writtenPlaintextBytes += entry.size ?? 0
      onProgress(writtenPlaintextBytes, totalPlaintextBytes)
    }
    throwIfAborted(signal)
    await writer.close(undefined, { zip64: true })
    throwIfAborted(signal)
    if (writable) return
    return memory!.blob()
  } catch (error) {
    destination?.abort(error)
    memory?.destroy()
    throw error
  } finally {
    memory?.destroy()
    destination?.dispose()
  }
}

/** Reads authenticated plaintext ranges without ever materializing the whole file. */
export async function createEncryptedRangeReader(vault: Pick<UnlockedVault, 'vaultKey' | 'dataKey'>, entry: DriveEntry, signal?: AbortSignal, onNetworkWaiting: (waiting: boolean) => void = () => undefined): Promise<EncryptedRangeReader> {
  if (!entry.fileId || !entry.manifestObjectId || !entry.manifestSha256 || !Number.isSafeInteger(entry.size) || entry.size === undefined || entry.size < 0) {
    throw new TypeError('文件目录项不完整。')
  }
  const fileCryptoVersion = entry.fileCryptoVersion ?? 1
  const manifest = await readFileManifest(vault, entry, signal, onNetworkWaiting)
  const fileKey = await deriveFileKey(vault.vaultKey, vault.dataKey, entry.fileId, fileCryptoVersion)
  throwIfAborted(signal)
  return createChunkRangeReader(entry.size, manifest.chunkSize ?? FILE_CHUNK_BYTES, async (index, chunkSignal) => {
    const record = manifest.chunks[index]
    if (!record) throw new RangeError('Range points outside the file')
    const encrypted = new Uint8Array(await requestArrayBuffer(`/api/v1/objects/${encodeURIComponent(record.objectId)}`, record.plaintextSize + ENVELOPE_OVERHEAD_BYTES, chunkSignal, onNetworkWaiting))
    const aad = chunkAAD({ fileId: entry.fileId!, chunkIndex: index, chunkCount: manifest.chunks.length, plaintextSize: record.plaintextSize }, fileCryptoVersion)
    let plaintext: Uint8Array | undefined
    try {
      if (encrypted.byteLength !== record.plaintextSize + ENVELOPE_OVERHEAD_BYTES || await sha256Hex(encrypted) !== record.sha256) {
        throw new TypeError('文件数据块完整性校验失败。')
      }
      chunkSignal.throwIfAborted()
      plaintext = await decryptObject(fileKey, encrypted, aad)
      chunkSignal.throwIfAborted()
      const result = plaintext
      plaintext = undefined
      return result
    } finally { encrypted.fill(0); aad.fill(0); plaintext?.fill(0) }
  }, signal)
}

async function collectTombstoneMembers(vault: UnlockedVault, root: DriveEntry, signal?: AbortSignal): Promise<Map<string, 'object' | 'metadata'>> {
  const members = new Map<string, 'object' | 'metadata'>()
  const pendingEntries: DriveEntry[] = [root]
  const visitedDirectories = new Set<string>()
  const add = (type: 'object' | 'metadata', id: string) => {
    members.set(`${type}:${id}`, type)
    if (members.size > 250_000) throw new TypeError('删除的子树超过当前安全遍历上限。')
  }
  while (pendingEntries.length > 0) {
    throwIfAborted(signal)
    const entry = pendingEntries.pop()!
    if (entry.kind === 'file') {
      if (!entry.fileId || !entry.manifestObjectId || !entry.manifestSha256) throw new TypeError('文件目录项缺少清单信息。')
      add('object', entry.manifestObjectId)
      const manifest = await readFileManifest(vault, entry, signal)
      for (const chunk of manifest.chunks) add('object', chunk.objectId)
      if (manifest.thumbnail) add('object', manifest.thumbnail.objectId)
      continue
    }
    if (!entry.childIndexId || visitedDirectories.has(entry.childIndexId)) throw new TypeError('目录树包含缺失或重复的文件夹引用。')
    visitedDirectories.add(entry.childIndexId)
    add('metadata', entry.childIndexId)
    const childIndex = await fetchIndex(vault.metadataKey, entry.childIndexId, signal)
    for (const child of childIndex.entries) pendingEntries.push(child)
  }
  return members
}

interface ManifestChunkRecord extends EncryptedChunkRecord { readonly index?: number }
interface FileManifest {
  version: 1 | 2 | 3
  fileCryptoVersion?: 1 | 2
  fileId: string
  size: number
  chunkSize?: number
  chunkCount?: number
  mime: string
  originalModifiedAt?: number
  chunks: ManifestChunkRecord[]
  thumbnail?: ThumbnailReference | null
  media?: { readonly durationMs: number; readonly width: number; readonly height: number }
}
async function readFileManifest(vault: Pick<UnlockedVault, 'vaultKey' | 'dataKey'>, entry: DriveEntry, signal?: AbortSignal, onNetworkWaiting: (waiting: boolean) => void = () => undefined): Promise<FileManifest> {
  if (!entry.fileId || !entry.manifestObjectId || !entry.manifestSha256) throw new TypeError('文件目录项缺少清单信息。')
  const encrypted = new Uint8Array(await requestArrayBuffer(`/api/v1/objects/${encodeURIComponent(entry.manifestObjectId)}`, 4 * 1024 * 1024, signal, onNetworkWaiting))
  if (await sha256Hex(encrypted) !== entry.manifestSha256) { encrypted.fill(0); throw new TypeError('文件清单完整性校验失败。') }
  const fileCryptoVersion = entry.fileCryptoVersion ?? 1
  const fileKey = await deriveFileKey(vault.vaultKey, vault.dataKey, entry.fileId, fileCryptoVersion)
  const aad = manifestAAD(entry.fileId, fileCryptoVersion)
  let plaintext: Uint8Array | undefined
  try {
    plaintext = await decryptObject(fileKey, encrypted, aad)
    const parsed: unknown = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    if (!isFileManifest(parsed, entry)) throw new TypeError('文件清单格式无效。')
    return parsed
  } finally { encrypted.fill(0); aad.fill(0); plaintext?.fill(0) }
}

export function isFileManifest(value: unknown, entry: DriveEntry): value is FileManifest {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  const hasThumbnail = Object.hasOwn(candidate, 'thumbnail')
  if (hasThumbnail && candidate.thumbnail !== null && !isThumbnailReference(candidate.thumbnail)) return false
  const thumbnail = candidate.thumbnail as ThumbnailReference | null | undefined
  if ((thumbnail ?? null) !== (entry.thumbnail ?? null) && (!thumbnail || !entry.thumbnail || (['objectId', 'sizeBytes', 'sha256', 'mime', 'width', 'height', 'keyVersion'] as const).some(key => thumbnail[key] !== entry.thumbnail![key]))) return false
  const isCurrentSchema = candidate.version === 3
  const expectedCryptoVersion = entry.fileCryptoVersion ?? 1
  const hasChunkSize = Object.hasOwn(candidate, 'chunkSize')
  const chunkSize = hasChunkSize ? candidate.chunkSize : FILE_CHUNK_BYTES
  const hasMedia = Object.hasOwn(candidate, 'media')
  const allowedKeys = isCurrentSchema
    ? ['version', 'fileCryptoVersion', 'fileId', 'size', 'chunkSize', 'chunkCount', 'mime', 'originalModifiedAt', 'chunks', 'thumbnail', ...(hasMedia ? ['media'] : [])]
    : ['version', 'fileId', 'size', 'mime', 'chunks', ...(hasChunkSize ? ['chunkSize'] : []), ...(hasThumbnail ? ['thumbnail'] : [])]
  if (!hasExactKeys(candidate, allowedKeys) || candidate.fileId !== entry.fileId || candidate.size !== entry.size || candidate.mime !== (entry.mime || 'application/octet-stream') || typeof candidate.mime !== 'string' || candidate.mime.length > 255 || !Array.isArray(candidate.chunks) || candidate.chunks.length > 4094 || !Number.isSafeInteger(chunkSize) || Number(chunkSize) < 1 || Number(chunkSize) > MAX_CLIENT_FILE_CHUNK_BYTES) return false
  if (isCurrentSchema) {
    if (candidate.version !== 3 || candidate.fileCryptoVersion !== expectedCryptoVersion || !hasChunkSize || candidate.chunkCount !== candidate.chunks.length || !Number.isSafeInteger(candidate.originalModifiedAt) || Number(candidate.originalModifiedAt) < 0 || Number(candidate.originalModifiedAt) > 8640000000000000 || candidate.originalModifiedAt !== entry.originalModifiedAt || !hasThumbnail) return false
    if (hasMedia) {
      if (typeof candidate.media !== 'object' || candidate.media === null || Array.isArray(candidate.media)) return false
      const media = candidate.media as Record<string, unknown>
      if (!hasExactKeys(media, ['durationMs', 'width', 'height']) || !Number.isSafeInteger(media.durationMs) || Number(media.durationMs) < 0 || !Number.isSafeInteger(media.width) || Number(media.width) < 1 || !Number.isSafeInteger(media.height) || Number(media.height) < 1) return false
    }
  } else if ((candidate.version !== 1 && candidate.version !== 2) || candidate.version !== expectedCryptoVersion) return false
  if (thumbnail && (thumbnail.keyVersion ?? 1) !== expectedCryptoVersion) return false
  const expectedCount = Math.ceil(Number(entry.size) / Number(chunkSize))
  if (candidate.chunks.length !== expectedCount || (isCurrentSchema && candidate.chunkCount !== expectedCount)) return false
  let total = 0
  const objectIds = new Set<string>()
  for (let index = 0; index < candidate.chunks.length; index += 1) {
    const chunk = candidate.chunks[index]
    if (typeof chunk !== 'object' || chunk === null) return false
    const item = chunk as Record<string, unknown>
    if (!hasExactKeys(item, isCurrentSchema ? ['index', 'objectId', 'plaintextSize', 'sha256'] : ['objectId', 'plaintextSize', 'sha256']) || (isCurrentSchema && item.index !== index) || typeof item.objectId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/u.test(item.objectId) ||
      !Number.isSafeInteger(item.plaintextSize) || Number(item.plaintextSize) !== Math.min(Number(chunkSize), Number(entry.size) - index * Number(chunkSize)) ||
      typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(item.sha256) || objectIds.has(item.objectId)) return false
    objectIds.add(item.objectId)
    total += Number(item.plaintextSize)
  }
  return total === entry.size && (!thumbnail || !objectIds.has(thumbnail.objectId) && thumbnail.objectId !== entry.manifestObjectId)
}

async function postIdempotentWithRetry<T>(value: unknown, idempotencyKey: string, signal?: AbortSignal, path = '/api/v1/metadata/transactions'): Promise<T> {
  const operationScope = revisionScope
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await post<T>(path, value, true, idempotencyKey, signal)
      const response = result as { vaultMutationRevision?: unknown }
      const request = value as { updates?: { metadataId: string; expectedRevision: number }[] }
      if (Number.isSafeInteger(response.vaultMutationRevision) && Array.isArray(request.updates)) {
        await recordCommittedRevisions([
          { kind: 'vault', revision: Number(response.vaultMutationRevision) },
          ...request.updates.map((item) => ({ kind: 'metadata' as const, metadataId: item.metadataId, revision: item.expectedRevision + 1 })),
        ], operationScope)
      }
      if (operationScope) browserMutations.invalidate(operationScope)
      return result
    } catch (error) {
      lastError = error
      throwIfAborted(signal)
      if (error instanceof APIError || attempt === 2) break
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
    }
  }
  throw lastError
}

async function loginWithAuthKey(username: string, authKey: Uint8Array, signal?: AbortSignal): Promise<void> {
  const { responseCsrf } = await postWithResponse<Omit<VaultLoginResponse, 'csrfToken'>>('/api/v1/auth/login', { username, authKey: encodeBase64(authKey) }, false, undefined, signal)
  throwIfAborted(signal)
  csrfToken = responseCsrf
}

async function unlockVaultState(username: string, kek: CryptoKey, response: VaultLoginResponse, signal?: AbortSignal): Promise<UnlockedVault> {
  throwIfAborted(signal)
  const epoch = ++revisionEpoch
  revisionScope = null
  const vaultKey = await unwrapVaultKey(kek, response.vaultConfig)
  const dataKey = await deriveDataKey(vaultKey)
  const metadataKey = await deriveVaultKey(vaultKey, 'xdrive/v1/meta')
  const rootIndexId = await deriveIndexId(vaultKey, 'root')
  const trashIndexId = await deriveIndexId(vaultKey, 'trash')
  const rootIndex = await fetchIndex(metadataKey, rootIndexId, signal)
  const trashIndex = await fetchActiveTrashIndex(metadataKey, trashIndexId, signal)
  throwIfAborted(signal)
  if (epoch !== revisionEpoch) throw new DOMException('Unlock context expired', 'AbortError')
  revisionScope = rootIndexId
  try {
    const finding = await observeRevisionBaseline(rootIndexId, [
      { kind: 'config', revision: response.vaultConfig.revision },
      { kind: 'vault', revision: response.vaultMutationRevision },
      { kind: 'metadata', metadataId: rootIndexId, revision: rootIndex.revision },
      { kind: 'metadata', metadataId: trashIndexId, revision: trashIndex.revision },
    ])
    if (epoch !== revisionEpoch) throw new DOMException('Unlock context expired', 'AbortError')
    // Reauthentication does not acknowledge a previously observed descendant rollback.
    // Only a successful explicit baseline replacement releases the read-only latch.
    if (finding && !revisionWarning) setRevisionWarning(describeRollback(finding))
  } catch {
    if (epoch !== revisionEpoch) throw new DOMException('Unlock context expired', 'AbortError')
    setRevisionWarning('无法读取或保存本设备的版本基线。为保护数据，已暂停写入。')
  }
  throwIfAborted(signal)
  return { vaultKey, dataKey, metadataKey, rootIndexId, trashIndexId, rootEntries: rootIndex.entries, rootRevision: rootIndex.revision, trashEntries: trashIndex.entries, trashRevision: trashIndex.revision, vaultMutationRevision: response.vaultMutationRevision, username, vaultConfig: response.vaultConfig }
}

export async function confirmRestoredBaseline(vault: UnlockedVault, password: string, signal?: AbortSignal): Promise<UnlockedVault> {
  if (!revisionWarning) throw new TypeError('当前未检测到回退，无需重建版本基线。')
  const verified = await unlockSession(password, vault.username, vault.vaultConfig, signal)
  const epoch = revisionEpoch
  if (verified.rootIndexId !== vault.rootIndexId) throw new TypeError('恢复后的云盘身份与本设备记录不一致。')
  const observations: RevisionObservation[] = [
    { kind: 'config', revision: verified.vaultConfig.revision },
    { kind: 'vault', revision: verified.vaultMutationRevision },
    { kind: 'metadata', metadataId: verified.rootIndexId, revision: verified.rootRevision },
    { kind: 'metadata', metadataId: verified.trashIndexId, revision: verified.trashRevision },
  ]
  await replaceRevisionBaseline(verified.rootIndexId, observations)
  throwIfAborted(signal)
  if (epoch !== revisionEpoch) throw new DOMException('Restore confirmation context expired', 'AbortError')
  revisionScope = verified.rootIndexId
  setRevisionWarning(null)
  return verified
}

async function fetchActiveTrashIndex(key: CryptoKey, metadataId: string, signal?: AbortSignal): Promise<{ entries: readonly TrashRootEntry[]; revision: number }> {
  const [index, active] = await Promise.all([
    fetchTrashIndex(key, metadataId, signal),
    request<{ tombstones: { id: string; deletedAt: number }[] }>('/api/v1/trash/tombstones', signal),
  ])
  if (!Array.isArray(active.tombstones) || active.tombstones.length > 5000 || active.tombstones.some((item) => typeof item.id !== 'string' || !Number.isSafeInteger(item.deletedAt))) {
    throw new TypeError('invalid trash lifecycle state')
  }
  const ids = new Set(active.tombstones.map((item) => item.id))
  return { revision: index.revision, entries: index.entries.filter((entry) => ids.has(entry.tombstoneId)) }
}

async function fetchIndex(key: CryptoKey, metadataId: string, signal?: AbortSignal): Promise<{ entries: readonly DriveEntry[]; revision: number }> {
  const epoch = revisionEpoch
  const pointer = await request<{ objectId: string; revision: number; sizeBytes: number; sha256: string }>(`/api/v1/metadata/${encodeURIComponent(metadataId)}`, signal)
  if (!Number.isSafeInteger(pointer.revision) || pointer.revision < 1 || pointer.sizeBytes < 36 || pointer.sizeBytes > 4 * 1024 * 1024) {
    throw new TypeError('invalid encrypted metadata pointer')
  }
  const encrypted = new Uint8Array(await requestArrayBuffer(`/api/v1/objects/${encodeURIComponent(pointer.objectId)}`, 4 * 1024 * 1024, signal))
  if (encrypted.byteLength !== pointer.sizeBytes || await sha256Hex(encrypted) !== pointer.sha256) {
    encrypted.fill(0)
    throw new TypeError('metadata integrity check failed')
  }
  assertIndexReadContext(epoch, signal)
  const plaintext = await decryptObject(key, encrypted, indexAAD(metadataId, pointer.revision))
  encrypted.fill(0)
  try {
    assertIndexReadContext(epoch, signal)
    if (plaintext.byteLength > 4 * 1024 * 1024) throw new TypeError('metadata object is too large')
    const parsed: unknown = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    if (!isDirectoryIndex(parsed, metadataId)) throw new TypeError('invalid directory index')
    await checkCurrentRevisions([{ kind: 'metadata', metadataId, revision: pointer.revision }], epoch)
    assertIndexReadContext(epoch, signal)
    return { entries: parsed.entries, revision: pointer.revision }
  } finally {
    plaintext.fill(0)
  }
}

async function fetchTrashIndex(key: CryptoKey, metadataId: string, signal?: AbortSignal): Promise<{ entries: readonly TrashRootEntry[]; revision: number }> {
  const epoch = revisionEpoch
  const pointer = await request<{ objectId: string; revision: number; sizeBytes: number; sha256: string }>(`/api/v1/metadata/${encodeURIComponent(metadataId)}`, signal)
  if (!Number.isSafeInteger(pointer.revision) || pointer.revision < 1 || pointer.sizeBytes < 36 || pointer.sizeBytes > 4 * 1024 * 1024) throw new TypeError('invalid encrypted trash pointer')
  const encrypted = new Uint8Array(await requestArrayBuffer(`/api/v1/objects/${encodeURIComponent(pointer.objectId)}`, 4 * 1024 * 1024, signal))
  if (encrypted.byteLength !== pointer.sizeBytes || await sha256Hex(encrypted) !== pointer.sha256) {
    encrypted.fill(0)
    throw new TypeError('trash index integrity check failed')
  }
  assertIndexReadContext(epoch, signal)
  const plaintext = await decryptObject(key, encrypted, indexAAD(metadataId, pointer.revision))
  encrypted.fill(0)
  try {
    assertIndexReadContext(epoch, signal)
    const parsed: unknown = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    if (!isTrashIndex(parsed, metadataId)) throw new TypeError('invalid trash index')
    await checkCurrentRevisions([{ kind: 'metadata', metadataId, revision: pointer.revision }], epoch)
    assertIndexReadContext(epoch, signal)
    return { entries: parsed.entries, revision: pointer.revision }
  } finally { plaintext.fill(0) }
}

export function isDirectoryIndex(value: unknown, metadataId: string): value is { version: number; indexId: string; entries: DriveEntry[] } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (!hasExactKeys(candidate, ['version', 'indexId', 'entries']) || candidate.version !== 1 || candidate.indexId !== metadataId || !Array.isArray(candidate.entries) || candidate.entries.length > 5000) return false
  const names = new Set<string>()
  return candidate.entries.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const item = entry as Record<string, unknown>
    if (!isValidDriveEntry(item)) return false
    const name = item.name as string
    if (names.has(name)) return false
    names.add(name)
    return true
  })
}

export function isValidDriveEntry(item: Record<string, unknown>): boolean {
  const timestamps = ['originalModifiedAt', 'createdAt'].filter(key => Object.hasOwn(item, key))
  if (timestamps.some(key => !Number.isSafeInteger(item[key]) || Number(item[key]) < 0 || Number(item[key]) > 8640000000000000)) return false

  if (typeof item.entryId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/u.test(item.entryId) || typeof item.name !== 'string' || !isValidName(item.name)) return false
  if (item.kind === 'folder') return hasExactKeys(item, ['entryId', 'kind', 'name', 'childIndexId', ...timestamps]) && typeof item.childIndexId === 'string' && /^[A-Za-z0-9_-]{16,64}$/u.test(item.childIndexId)
  const hasThumbnail = Object.hasOwn(item, 'thumbnail')
  const hasFileCryptoVersion = Object.hasOwn(item, 'fileCryptoVersion')
  if (hasFileCryptoVersion && item.fileCryptoVersion !== 1 && item.fileCryptoVersion !== 2) return false
  if (hasThumbnail && item.thumbnail !== null && !isThumbnailReference(item.thumbnail)) return false
  const fileCryptoVersion = hasFileCryptoVersion ? item.fileCryptoVersion : 1
  if (hasThumbnail && item.thumbnail !== null && ((item.thumbnail as ThumbnailReference).keyVersion ?? 1) !== fileCryptoVersion) return false
  return item.kind === 'file' && hasExactKeys(item, ['entryId', 'kind', 'name', 'size', 'mime', 'fileId', 'manifestObjectId', 'manifestSha256', ...timestamps, ...(hasThumbnail ? ['thumbnail'] : []), ...(hasFileCryptoVersion ? ['fileCryptoVersion'] : [])]) &&
    typeof item.fileId === 'string' && /^[A-Za-z0-9_-]{16,64}$/u.test(item.fileId) &&
    typeof item.manifestObjectId === 'string' && /^[A-Za-z0-9_-]{16,64}$/u.test(item.manifestObjectId) &&
    typeof item.manifestSha256 === 'string' && /^[0-9a-f]{64}$/u.test(item.manifestSha256) &&
    Number.isSafeInteger(item.size) && Number(item.size) >= 0 && typeof item.mime === 'string' && item.mime.length <= 255
}

export function isTrashIndex(value: unknown, metadataId: string): value is { version: number; indexId: string; entries: TrashRootEntry[] } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (!hasExactKeys(candidate, ['version', 'indexId', 'entries']) || candidate.version !== 1 || candidate.indexId !== metadataId || !Array.isArray(candidate.entries) || candidate.entries.length > 5000) return false
  const tombstoneIds = new Set<string>()
  return candidate.entries.every((value) => {
    if (typeof value !== 'object' || value === null) return false
    const entry = value as Record<string, unknown>
    if (!hasExactKeys(entry, ['tombstoneId', 'item', 'originalParentId', 'originalPath', 'deletedAt']) || typeof entry.tombstoneId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/u.test(entry.tombstoneId) || tombstoneIds.has(entry.tombstoneId)) return false
    if (typeof entry.item !== 'object' || entry.item === null || !isValidDriveEntry(entry.item as Record<string, unknown>)) return false
    if (typeof entry.originalParentId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/u.test(entry.originalParentId) || !Number.isSafeInteger(entry.deletedAt) || Number(entry.deletedAt) <= 0 || !Array.isArray(entry.originalPath)) return false
    for (const partValue of entry.originalPath) {
      if (typeof partValue !== 'object' || partValue === null) return false
      const part = partValue as Record<string, unknown>
      if (!hasExactKeys(part, ['indexId', 'childIndexId', 'name']) || typeof part.indexId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/u.test(part.indexId) || typeof part.childIndexId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/u.test(part.childIndexId) || typeof part.name !== 'string' || !isValidName(part.name)) return false
    }
    tombstoneIds.add(entry.tombstoneId)
    return true
  })
}

export function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key))
}


function randomObjectId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  try {
    return encodeBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  } finally {
    bytes.fill(0)
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestWithInit<T>(path, { method: 'GET', credentials: 'same-origin', signal })
}

async function requestArrayBuffer(path: string, maxBytes = 16 * 1024 * 1024, signal?: AbortSignal, onNetworkWaiting: (waiting: boolean) => void = () => undefined): Promise<ArrayBuffer> {
  return retryNetworkRequest(async () => {
    let response: Response
    try { response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal }) }
    catch (error) { if (signal?.aborted) throw error; throw new NetworkUnavailableError(error) }
    if (!response.ok) throw await parseAPIError(response)
    const header = response.headers.get('Content-Length')
    const contentLength = header === null ? NaN : Number(header)
    if (header === null || !/^[0-9]+$/u.test(header) || !Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new TypeError('encrypted object exceeds the configured read limit')
    }
    if (!response.body) throw new TypeError('encrypted object response has no body')
    const reader = response.body.getReader()
    const cancel = () => { void reader.cancel(signal?.reason).catch(() => undefined) }
    signal?.addEventListener('abort', cancel, { once: true })
    const buffer = new Uint8Array(contentLength)
    let offset = 0
    try {
      while (true) {
        throwIfAborted(signal)
        let result: ReadableStreamReadResult<Uint8Array>
        try { result = await reader.read() }
        catch (error) { if (signal?.aborted) throw error; throw new NetworkUnavailableError(error) }
        if (result.done) break
        if (result.value.byteLength > contentLength - offset) throw new TypeError('encrypted object size does not match its response header')
        buffer.set(result.value, offset)
        offset += result.value.byteLength
      }
      throwIfAborted(signal)
      if (offset !== contentLength) throw new TypeError('encrypted object size does not match its response header')
      return buffer.buffer as ArrayBuffer
    } catch (error) {
      buffer.fill(0)
      await reader.cancel(error).catch(() => undefined)
      throw error
    } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock() }
  }, signal, onNetworkWaiting)
}

async function post<T = void>(path: string, value: unknown, withCSRF = false, idempotencyKey?: string, signal?: AbortSignal): Promise<T> {
  return (await postWithResponse<T>(path, value, withCSRF, idempotencyKey, signal)).value
}

async function postWithResponse<T>(path: string, value: unknown, withCSRF = false, idempotencyKey?: string, signal?: AbortSignal): Promise<{ value: T; responseCsrf: string }> {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (withCSRF) headers.set('X-CSRF-Token', csrfToken)
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey)
  return requestWithResponse<T>(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers, body: JSON.stringify(value), signal })
}

async function putEncryptedObject(uploadId: string, objectId: string, encrypted: Uint8Array, digest: string, signal?: AbortSignal, onNetworkWaiting: (waiting: boolean) => void = () => undefined): Promise<void> {
  assertRevisionWritable(`/api/v1/uploads/${uploadId}/objects/${objectId}`)
  const mutationSignal = await browserMutations.guard(requireMutationScope())
  signal = signal ? AbortSignal.any([signal, mutationSignal]) : mutationSignal
  const response = await retryNetworkRequest(async () => {
    try {
      return await fetch(`/api/v1/uploads/${encodeURIComponent(uploadId)}/objects/${encodeURIComponent(objectId)}`, {
        method: 'PUT',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-CSRF-Token': csrfToken, 'X-XDrive-Client-Protocol': CLIENT_PROTOCOL_VERSION, 'X-XDrive-Object-Size': String(encrypted.byteLength), 'X-XDrive-Ciphertext-SHA256': digest },
        body: encrypted.slice().buffer as ArrayBuffer,
        signal,
      })
    } catch (error) { if (signal?.aborted) throw error; throw new NetworkUnavailableError(error) }
  }, signal, onNetworkWaiting)
  if (!response.ok) throw await parseAPIError(response)
}

async function deletePendingUploadObject(uploadId: string, objectId: string, signal?: AbortSignal): Promise<void> {
  await requestWithInit<void>(`/api/v1/uploads/${encodeURIComponent(uploadId)}/objects/${encodeURIComponent(objectId)}`, {
    signal, method: 'DELETE', credentials: 'same-origin', cache: 'no-store', headers: { 'X-CSRF-Token': csrfToken },
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
}

async function requestWithInit<T>(path: string, init: RequestInit): Promise<T> {
  return (await requestWithResponse<T>(path, init)).value
}

async function requestWithResponse<T>(path: string, init: RequestInit): Promise<{ value: T; responseCsrf: string }> {
  throwIfAborted(init.signal ?? undefined)
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    const headers = new Headers(init.headers)
    headers.set('X-XDrive-Client-Protocol', CLIENT_PROTOCOL_VERSION)
    init = { ...init, headers }
  }
  const epoch = revisionEpoch
  if (method !== 'GET' && method !== 'HEAD') assertRevisionWritable(path)
  if (method !== 'GET' && method !== 'HEAD' && (path.startsWith('/api/v1/uploads') || path.startsWith('/api/v1/metadata/transactions') || (path === '/api/v1/metadata/maintenance-purge' || path === '/api/v1/metadata/maintenance-trash') || path.startsWith('/api/v1/tombstone-builds') || path === '/api/v1/auth/change-password')) {
    // First setup builds its initial encrypted objects before an unlocked scope exists.
    if (revisionScope) {
      const mutationSignal = await browserMutations.guard(revisionScope)
      init.signal = init.signal ? AbortSignal.any([init.signal, mutationSignal]) : mutationSignal
    }
  }
  const response = await fetch(path, init)
  throwIfAborted(init.signal ?? undefined)
  const responseCsrf = response.headers.get('X-CSRF-Token') ?? ''
  if (!response.ok) throw await parseAPIError(response)
  if (response.status === 204) return { value: undefined as T, responseCsrf }
  const value = await response.json() as T
  throwIfAborted(init.signal ?? undefined)
  if (path === '/api/v1/vault/state') {
    const revision = (value as { vaultMutationRevision?: unknown }).vaultMutationRevision
    if (Number.isSafeInteger(revision)) await checkCurrentRevisions([{ kind: 'vault', revision: Number(revision) }], epoch)
  }
  return { value, responseCsrf }
}

function requireMutationScope(): string {
  if (!revisionScope) throw new TypeError('请先解锁云盘。')
  return revisionScope
}
function coordinated<F extends (...args: never[]) => Promise<unknown>>(operation: F, signalIndex?: number): F {
  return ((...args: Parameters<F>) => {
    const vault = args[0] as unknown as { rootIndexId?: string }
    const scope = vault?.rootIndexId ?? requireMutationScope()
    const signal = signalIndex === undefined ? undefined : args[signalIndex] as AbortSignal | undefined
    return browserMutations.run(scope, async (coordinatedSignal) => {
      const forwarded = [...args] as Parameters<F>
      if (signalIndex !== undefined) (forwarded as unknown[])[signalIndex] = coordinatedSignal
      if (vault?.rootIndexId) {
        const updated = await refreshVaultFromServer(vault as UnlockedVault, coordinatedSignal)
        ;(forwarded as unknown[])[0] = updated
        for (let index = 1; index < forwarded.length; index += 1) {
          const argument = forwarded[index] as unknown
          if (argument && typeof argument === 'object' && 'indexId' in argument && 'entries' in argument && 'path' in argument) {
            const directory = argument as DirectoryState
            ;(forwarded as unknown[])[index] = await loadDirectory(updated, directory.indexId, directory.path, coordinatedSignal)
          }
        }
      }
      coordinatedSignal.throwIfAborted()
      return operation(...forwarded)
    }, signal)
  }) as F
}
export const deleteEntry = coordinated(deleteEntryCore, 3)
export const restoreTrashEntry = coordinated(restoreTrashEntryCore, 3)
export const restoreTrashEntries = coordinated(restoreTrashEntriesCore, 3)
export const purgeTrashEntry = coordinated(purgeTrashEntryCore, 2)
export const purgeTrashEntries = coordinated(purgeTrashEntriesCore, 2)
export const changePassword = coordinated(changePasswordCore, 3)
export const abandonResumableUpload = coordinated(abandonResumableUploadCore)
export const resumeUploadFile = coordinated(resumeUploadFileCore, 4)
export const uploadFile = coordinated(uploadFileCore, 4)
export const uploadFolder = coordinated(uploadFolderCore, 4)
export const uploadFiles = coordinated((vault: UnlockedVault, destination: DirectoryState, files: readonly File[], onProgress?: FolderUploadProgressListener, signal?: AbortSignal, resolveConflicts?: ResolveFolderConflicts) => uploadFolderCore(vault, destination, files, onProgress, signal, resolveConflicts, true), 4)
export const createFolder = coordinated(createFolderCore, 3)
export const renameEntry = coordinated(renameEntryCore, 4)
export const moveEntry = coordinated(moveEntryCore, 4)
export const moveEntries = coordinated(moveEntriesCore, 4)
export const moveSelectedEntries = coordinated(moveSelectedEntriesCore, 3)

function assertIndexReadContext(epoch: number, signal?: AbortSignal): void {
  throwIfAborted(signal)
  if (epoch !== revisionEpoch) throw new DOMException('Vault context expired', 'AbortError')
}

export const deleteSelectedEntries = coordinated(deleteSelectedEntriesCore, 2)
