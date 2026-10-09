import { Breadcrumbs } from './components/Breadcrumbs'
import { RequestIdControl } from './components/RequestIdControl'
import { useErrorNotice } from './components/use-error-notice'
import { BackupNotice } from './components/BackupNotice'
import { DeleteSelectionDialog } from './components/DeleteSelectionDialog'
import { ThumbnailCache } from './media/thumbnail-cache'
import { ThumbnailImage } from './components/ThumbnailImage'
import { useLongPressSelection } from './index/use-long-press-selection'
import { SelectionStore } from './index/selection-store'
import { assessMoveDrop } from './index/move-drop'
import { VirtualEntryGrid } from './components/VirtualEntryGrid'
import { DriveListHeader } from './components/DriveListHeader'
import { EntryActionsDialog, type EntryAction } from './components/EntryActionsDialog'
import { formatEntryModifiedAt, sortEntries, splitFileExtension, type SortBy } from './index/entry-sort'
import { ClearTrashDialog } from './components/ClearTrashDialog'
import { StorageScreen } from './components/StorageScreen'
import { UnlockedQueries } from './queries/UnlockedQueries'
import { useStorageUsage } from './queries/storage-usage'
import { useStore } from 'zustand'
import { TransferStore, type TransferUpdate } from './transfers/transfer-store'
import { VirtualEntryList } from './components/VirtualEntryList'
import { FolderConflictDialog } from './components/FolderConflictDialog'
import { TransferPanel } from './components/TransferPanel'
import { setPreferences, usePreferences } from './preferences/preferences'
import { useIdleLock } from './security/use-idle-lock'
import { useAuthAttempt } from './security/use-auth-attempt'
import type { IdleLockTask } from './security/idle-lock'
import type { FolderConflict, FolderConflictAction } from './uploads/folder-conflicts'
import { conflictIdentity } from './uploads/folder-conflicts'
import { enumerateDirectoryHandle, readDroppedSelection, type DirectoryHandleLike } from './uploads/folder-input'
import type { ZipSelection } from './index/zip-selection'
import { createRelayDownload, supportsRelayDownload, type RelayDownload } from './downloads/sw-download'
import { createPDFRangeQueue } from './media/pdf-range-queue'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { browserMutations } from './index/browser-coordination'
import type { WriterState } from './index/mutation-coordinator'
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, FormEvent, ReactNode } from 'react'
import { Archive, ArrowDownToLine, ArrowUpFromLine, CornerUpLeft, File, FilePenLine, Folder, FolderPlus, HardDrive, LockKeyhole, LogOut, MoveRight, ShieldCheck, Trash2, RotateCcw, LayoutGrid, List, MoreHorizontal } from 'lucide-react'
import {
  APIError,
  SetupCommittedError,
  SetupStateUnknownError,
  readThumbnail,
  RestoreNameConflictError,
  clearRevisionContext,
  changePassword,
  confirmRestoredBaseline,
  createFolder,
  createEncryptedRangeReader,
  downloadSelectedAsZip,
  createVault,
  deleteEntry,
  deleteSelectedEntries,
  downloadFile,
  fetchTextPreviewLimit,
  fetchVideoBlobFallbackLimit,
  fetchTrashRetentionLabel,
  fetchCurrentSession,
  fetchStatus,
  getRevisionWarning,
  loadDirectory,
  reloadDirectory,
  resolveDirectoryRoute,
  logout,
  moveEntry,
  moveSelectedEntries,
  purgeTrashEntry,
  purgeTrashEntries,
  renameEntry,
  restoreTrashEntries,
  subscribeRevisionWarning,
  pendingUploadRecords,
  abandonResumableUpload,
  refreshVaultFromServer,
  resumeUploadFile,
  uploadFolder,
  uploadFiles,
  uploadFile,
  unlockSession,
  unlockWithPassword,
} from './api/client'
import type { DirectoryState, DriveEntry, StorageUsage, TrashRootEntry, UnlockedVault } from './api/client'
import type { UploadConflictChoice } from './api/client'
import type { VaultConfigV1 } from './crypto/keys'
import type { UploadResumeRecord } from './uploads/resume'
import { assertPasswordLength } from './crypto/kdf'
import { assertOriginalFile } from './uploads/resume'
import type { ActiveTransfer, RecoverableTransfer, TransferPhase } from './transfers/transfer-types'
import { textPreviewKind } from './media/text-preview'
import './App.css'

const SettingsScreen = lazy(() => import('./components/SettingsScreen').then(module => ({ default: module.SettingsScreen })))
const MarkdownPreview = lazy(() => import('./components/MarkdownPreview').then(module => ({ default: module.MarkdownPreview })))
const CodePreview = lazy(() => import('./components/CodePreview').then(module => ({ default: module.CodePreview })))

interface LockedSession {
  readonly username: string
  readonly vaultConfig: VaultConfigV1
}

interface PreviewState {
  readonly entry: import('./api/client').DriveEntry
  readonly kind: 'image' | 'video' | 'text' | 'markdown' | 'code' | 'pdf'
  readonly url?: string
  readonly text?: string
}

function App() {
  const [loading, setLoading] = useState(true)
  const [error, setError, errorRequestId] = useErrorNotice()
  const [serviceReady, setServiceReady] = useState(false)
  const [accountState, setAccountState] = useState<'uninitialized' | 'pending_setup' | 'active'>('uninitialized')
  const [setupToken] = useState(() => {
    if (window.location.pathname !== '/setup' || window.location.hash.length < 2) return ''
    const token = decodeURIComponent(window.location.hash.slice(1))
    window.history.replaceState(null, '', '/setup')
    return token
  })
  const [lockedSession, setLockedSession] = useState<LockedSession | null>(null)
  const [vault, setVault] = useState<UnlockedVault | null>(null)
  const [logoutPending, setLogoutPending] = useState(false)
  const logoutOwner = useRef(false)
  const [revisionWarning, setRevisionWarning] = useState<string | null>(getRevisionWarning)

  useEffect(() => subscribeRevisionWarning(setRevisionWarning), [])

  useEffect(() => {
    document.title = 'XDrive'
    void Promise.all([fetchStatus(), fetchCurrentSession()]).then(([status, session]) => {
      setServiceReady(true)
      setAccountState(status.accountState)
      if (session.authenticated) setLockedSession({ username: session.username, vaultConfig: session.vaultConfig })
    }).catch((cause) => {
      setError('无法连接到 XDrive 服务。请检查服务状态后重试。', cause)
    }).finally(() => setLoading(false))
  }, [setError])

  const enterVault = (unlocked: UnlockedVault) => {
    setError('')
    setAccountState('active')
    setVault(unlocked)
    setRevisionWarning(getRevisionWarning())
    setLockedSession(null)
  }

  const updateVault = useCallback((next: UnlockedVault) => {
    setVault(current => current && current.metadataKey === next.metadataKey &&
      current.vaultConfig.revision <= next.vaultConfig.revision &&
      current.vaultMutationRevision <= next.vaultMutationRevision &&
      current.rootRevision <= next.rootRevision && current.trashRevision <= next.trashRevision ? next : current)
  }, [])

  const handleLock = () => {
    if (!vault) return
    clearRevisionContext()
    setLockedSession({ username: vault.username, vaultConfig: vault.vaultConfig })
    setVault(null)
  }
  const holdIdleLock = useIdleLock(Boolean(vault), handleLock)

  const handleLogout = async () => {
    if (logoutOwner.current) return
    logoutOwner.current = true
    setLogoutPending(true)
    // Local plaintext ownership ends before waiting for server/network logout.
    clearRevisionContext()
    setVault(null)
    setLockedSession(null)
    setAccountState('active')
    setRevisionWarning(null)
    try {
      await logout()
    } catch (cause) {
      setError('本地云盘已锁定，但服务器会话退出未确认。请检查连接并刷新页面后重试。', cause)
    } finally {
      logoutOwner.current = false
      setLogoutPending(false)
    }
  }

  if (loading) return <main className="boot-screen"><div className="boot-mark"><HardDrive size={21} /></div><p>正在连接你的云盘…</p></main>
  if (!serviceReady) return <ServiceUnavailable message={error} requestId={errorRequestId} onRetry={() => window.location.reload()} />
  if (vault && revisionWarning) return <RollbackWarningScreen vault={vault} warning={revisionWarning} onAccepted={enterVault} onLock={handleLock} onLogout={() => void handleLogout()} />
  if (vault) return <UnlockedQueries><DriveScreen vault={vault} holdIdleLock={holdIdleLock} onVaultUpdate={updateVault} onLock={handleLock} onLogout={() => void handleLogout()} /></UnlockedQueries>
  if (accountState !== 'active') {
    return <SetupScreen token={setupToken} state={accountState} error={error} requestId={errorRequestId} onError={setError} onComplete={enterVault} onCommitted={() => { setAccountState('active'); setLockedSession(null) }} onUnknown={() => setServiceReady(false)} />
  }
  return <LoginScreen session={lockedSession} logoutPending={logoutPending} error={error} requestId={errorRequestId} onError={setError} onComplete={enterVault} onLogout={handleLogout} />
}

function SetupScreen(props: {
  onCommitted: () => void
  onUnknown: () => void
  token: string
  state: string
  error: string
  requestId?: string
  onError: (message: string, cause?: unknown) => void
  onComplete: (vault: UnlockedVault) => void
}) {
  const authAttempt = useAuthAttempt()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const hasToken = props.token.length > 0

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const attempt = authAttempt.begin()
    props.onError('')
    try {
      assertPasswordLength(password)
      if (password !== confirmation) throw new Error('两次输入的密码不一致。')
      if (!acknowledged) throw new Error('请确认忘记密码后无法恢复云盘数据。')
      if (!hasToken) throw new Error('缺少一次性设置令牌。请在服务器运行 xdrive setup-token。')
      setBusy(true)
      const unlocked = await createVault({ token: props.token, username, password }, attempt.signal)
      if (authAttempt.owns(attempt)) props.onComplete(unlocked)
    } catch (cause) {
      if (authAttempt.owns(attempt)) {
        if (cause instanceof SetupCommittedError) {
          props.onError(cause.message, cause.originalCause)
          props.onCommitted()
        } else if (cause instanceof SetupStateUnknownError) {
          props.onError(cause.message, cause.originalCause)
          props.onUnknown()
        } else props.onError(describeSetupError(cause), cause)
      }
    } finally {
      if (authAttempt.owns(attempt)) { setBusy(false); setPassword(''); setConfirmation('') }
      authAttempt.finish(attempt)
    }
  }

  return <AuthLayout eyebrow="仅你可访问" title="建立你的私有云盘" description="密码和文件密钥只在此浏览器中处理。XDrive 服务端只保存加密后的内容。">
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      <label className="field-label" htmlFor="username">管理员用户名</label>
      <input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={128} />
      <label className="field-label" htmlFor="setup-password">设置密码</label>
      <input id="setup-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required />
      <p className="field-help">至少 12 个字符。忘记密码后，服务端无法恢复已加密的文件。</p>
      <label className="field-label" htmlFor="confirm-password">再次输入密码</label>
      <input id="confirm-password" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={12} required />
      <label className="acknowledgement">
        <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
        <span>我已了解：如果忘记密码，云盘数据无法恢复。</span>
      </label>
      {props.error && <p className="form-error" role="alert">{props.error}<RequestIdControl requestId={props.requestId} /></p>}
      {!hasToken && <p className="form-notice" role="status">{props.state === 'uninitialized' ? '服务端尚未生成设置令牌。' : '设置令牌未提供或已过期。'}请运行 <code>xdrive setup-token</code> 后重新打开链接。</p>}
      <button className="primary-button" type="submit" disabled={busy || !hasToken}>
        {busy ? <><span className="spinner" /> 正在本地加密并初始化…</> : '创建加密云盘'}
      </button>
    </form>
    <SecurityNote />
  </AuthLayout>
}

function LoginScreen(props: {
  session: LockedSession | null
  logoutPending: boolean
  error: string
  requestId?: string
  onError: (message: string, cause?: unknown) => void
  onComplete: (vault: UnlockedVault) => void
  onLogout: () => Promise<void>
}) {
  const authAttempt = useAuthAttempt()
  const [username, setUsername] = useState(props.session?.username ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (props.logoutPending || busy) return
    const attempt = authAttempt.begin()
    props.onError('')
    setBusy(true)
    try {
      const unlocked = props.session
        ? await unlockSession(password, props.session.username, props.session.vaultConfig, attempt.signal)
        : await unlockWithPassword(username, password, attempt.signal)
      if (authAttempt.owns(attempt)) props.onComplete(unlocked)
    } catch (cause) {
      if (authAttempt.owns(attempt)) props.onError(describeLoginError(cause), cause)
    } finally {
      if (authAttempt.owns(attempt)) { setBusy(false); setPassword('') }
      authAttempt.finish(attempt)
    }
  }

  return <AuthLayout eyebrow={props.session ? '云盘已锁定' : '安全登录'} title={props.session ? '重新解锁云盘' : '欢迎回来'} description="输入密码，在本地解锁你的加密数据。">
    <form className="auth-form" aria-busy={busy || props.logoutPending} onSubmit={(event) => void submit(event)}>
      {!props.session && <><label className="field-label" htmlFor="login-username">管理员用户名</label><input id="login-username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={128} disabled={props.logoutPending} /> </>}
      <label className="field-label" htmlFor="login-password">密码</label>
      <input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus disabled={props.logoutPending} />
      {props.logoutPending && <p role="status">正在退出登录…</p>}
      {props.error && <p className="form-error" role="alert">{props.error}<RequestIdControl requestId={props.requestId} /></p>}
      <button className="primary-button" type="submit" disabled={busy || props.logoutPending}>
        {busy ? <><span className="spinner" /> 正在派生密钥…</> : '解锁云盘'}
      </button>
      {props.session && <button className="quiet-button" type="button" onClick={() => { authAttempt.cancel(); setBusy(false); setPassword(''); void props.onLogout() }}>退出此会话</button>}
    </form>
    <SecurityNote />
  </AuthLayout>
}

function AuthLayout(props: { eyebrow: string; title: string; description: string; children: ReactNode }) {
  return <main className="auth-screen">
    <div className="auth-glow" aria-hidden="true" />
    <header className="brand-row"><div className="brand-icon"><HardDrive size={19} strokeWidth={2} /></div><span>XDrive</span><span className="brand-private"><LockKeyhole size={12} /> 私有云盘</span></header>
    <section className="auth-content">
      <div className="auth-card glass-thick">
        <div className="auth-heading"><span className="eyebrow"><ShieldCheck size={14} /> {props.eyebrow}</span><h1>{props.title}</h1><p>{props.description}</p></div>
        {props.children}
      </div>
      <p className="auth-footnote">端到端加密 · 单用户 · 数据保存在你的服务器</p>
    </section>
  </main>
}

function SecurityNote() {
  return <div className="security-note"><LockKeyhole size={15} /><p>密码不会发送到服务器。密钥派生在本地后台线程中运行。</p></div>
}

function RollbackWarningScreen(props: { vault: UnlockedVault; warning: string; onAccepted: (vault: UnlockedVault) => void; onLock: () => void; onLogout: () => void }) {
  const authAttempt = useAuthAttempt()
  const [confirmed, setConfirmed] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError, errorRequestId] = useErrorNotice()
  const acceptRestore = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!confirmed) return
    const attempt = authAttempt.begin()
    setBusy(true)
    setError('')
    try { const unlocked = await confirmRestoredBaseline(props.vault, password, attempt.signal); if (authAttempt.owns(attempt)) props.onAccepted(unlocked) }
    catch (cause) { if (authAttempt.owns(attempt)) setError(cause instanceof Error ? cause.message : '无法重新建立版本基线。', cause) }
    finally { if (authAttempt.owns(attempt)) { setBusy(false); setPassword('') }; authAttempt.finish(attempt) }
  }
  return <AuthLayout eyebrow="只读保护" title="检测到服务器数据可能发生回退" description="本设备记得比服务器当前状态更新的版本。确认原因前，云盘写入已暂停。">
    <div className="form-notice" role="alert">{props.warning}</div>
    <p className="field-help">当前云盘全局版本：{props.vault.vaultMutationRevision}；Vault 配置版本：{props.vault.vaultConfig.revision}。你可以锁定云盘或退出登录，再检查服务器备份和运行状态。</p>
    <form className="auth-form" onSubmit={(event) => void acceptRestore(event)}>
      <label className="acknowledgement"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我刚刚从备份恢复了 XDrive，确认要重新建立本设备的版本基线。</span></label>
      <label className="field-label" htmlFor="restore-baseline-password">重新输入密码</label>
      <input id="restore-baseline-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      {error && <p className="form-error" role="alert">{error}<RequestIdControl requestId={errorRequestId} /></p>}
      <button className="primary-button" type="submit" disabled={!confirmed || busy}>{busy ? '正在重新认证并读取云盘…' : '确认恢复并重新建立基线'}</button>
      <button className="quiet-button" type="button" onClick={() => { authAttempt.cancel(); props.onLock() }}>锁定云盘</button>
      <button className="quiet-button" type="button" onClick={() => { authAttempt.cancel(); setBusy(false); setPassword(''); props.onLogout() }}>退出登录</button>
    </form>
  </AuthLayout>
}

function DriveScreen(props: { vault: UnlockedVault; holdIdleLock: (kind: IdleLockTask) => () => void; onVaultUpdate: (vault: UnlockedVault) => void; onLock: () => void; onLogout: () => void }) {
  const { backupReminderDays, view } = usePreferences()
  const thumbnailVaultKey = props.vault.vaultKey
  const thumbnailDataKey = props.vault.dataKey
  const thumbnailCache = useMemo(() => new ThumbnailCache((item, signal) => readThumbnail({ vaultKey: thumbnailVaultKey, dataKey: thumbnailDataKey }, { entryId: item.fileId, name: '', kind: 'file', fileId: item.fileId, thumbnail: item.thumbnail }, signal)), [thumbnailVaultKey, thumbnailDataKey])
  useLayoutEffect(() => { thumbnailCache.open(); return () => thumbnailCache.dispose() }, [thumbnailCache])
  const [sortBy, setSortBy] = useState<SortBy>('name')
  const [descending, setDescending] = useState(false)
  const [actionsEntry, setActionsEntry] = useState<DriveEntry | null>(null)
  const actionsTrigger = useRef<HTMLElement | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState({ complete: 0, total: 0 })
  const [uploadNotice, setUploadNotice] = useState<{ message: string; revision: number | null }>({ message: '', revision: null })
  const setUploadMessage = useCallback((message: string) => setUploadNotice({ message, revision: null }), [])
  const [uploadError, setUploadError, uploadRequestId] = useErrorNotice()
  const [routeError, setRouteError, routeRequestId] = useErrorNotice()
  const [directory, setDirectory] = useState<DirectoryState>(() => ({ indexId: props.vault.rootIndexId, revision: props.vault.rootRevision, entries: props.vault.rootEntries, path: [] }))
  const publishDirectoryUpdate = (next: DirectoryState) => {
    setDirectory(current => (window.location.pathname === `/drive/${next.indexId}` ||
      next.indexId === props.vault.rootIndexId && window.location.pathname === '/drive') &&
      current.indexId === next.indexId && current.revision <= next.revision
      ? { ...next, path: current.path } : current)
  }
  const [folderLoading, setFolderLoading] = useState(true)
  const [resolvedRouteRevision, setResolvedRouteRevision] = useState<number | null>(null)
  const uploadMessage = uploadNotice.revision === null || (!folderLoading && resolvedRouteRevision !== null && resolvedRouteRevision >= uploadNotice.revision)
    ? uploadNotice.message : '正在校验上传后的目录…'
  const [selection] = useState(() => new SelectionStore())
  const selectedEntryId = useStore(selection.store, state => state.focusedId)
  const zipSelections = useStore(selection.store, state => state.selections)
  const [zipController, setZipController] = useState<AbortController | null>(null)
  const batchIds = new Set(zipSelections.keys())
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const location = useLocation()
  const navigate = useNavigate()
  const activeView = location.pathname === '/settings' ? 'settings' : location.pathname === '/storage' ? 'storage' : location.pathname === '/trash' ? 'trash' : 'drive'
  const setActiveView = (view: 'drive' | 'trash' | 'storage' | 'settings') => { void navigate(`/${view}`) }
  const { rootIndexId: routeRootId, metadataKey: routeMetadataKey } = props.vault
  const [routeAttempt, setRouteAttempt] = useState(0)
  const routeNavigation = useRef<string | null>(null)
  const [routeUnavailable, setRouteUnavailable] = useState(false)
  const [activeTrashRoot, setActiveTrashRoot] = useState<TrashRootEntry | null>(null)
  const [trashDirectory, setTrashDirectory] = useState<DirectoryState | null>(null)
  const [movingSelections, setMovingSelections] = useState<readonly ZipSelection[]>([])
  const moveDragSelections = useRef<readonly ZipSelection[]>([])
  const dropTargetId = useRef('')
  const dragPreview = useRef<HTMLElement | null>(null)
  const [dropFeedback, setDropFeedback] = useState<{ entryId: string; state: 'checking' | 'allowed' | 'blocked'; message: string } | null>(null)
  const [externalDropActive, setExternalDropActive] = useState(false)
  const [pendingUploadConflict, setPendingUploadConflict] = useState<{ file: File; existing: DriveEntry; destination: DirectoryState } | null>(null)
  const [pendingFolderConflict, setPendingFolderConflict] = useState<{ kind: 'folder' | 'files'; destinationLabel: string; conflicts: readonly FolderConflict[]; confirm: (choices: ReadonlyMap<string, FolderConflictAction>) => void; cancel: () => void } | null>(null)
  const [pendingRestoreConflict, setPendingRestoreConflict] = useState<{ ids: readonly string[]; message: string } | null>(null)
  const [trashSelected, setTrashSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [clearTrashMode, setClearTrashMode] = useState<'all' | 'selected'>('all')
  const [clearTrashIds, setClearTrashIds] = useState<readonly string[] | null>(null)
  const clearTrashFocus = useRef<HTMLElement | null>(null)
  const [clearingTrash, setClearingTrash] = useState(false)
  const [deletingSelection, setDeletingSelection] = useState(false)
  const [deleteSelections, setDeleteSelections] = useState<readonly ZipSelection[] | null>(null)
  const deleteSelectionFocus = useRef<HTMLElement | null>(null)
  const [quotaBlocked, setQuotaBlocked] = useState(false)
  const [changePasswordOpen, setChangePasswordOpen] = useState(false)
  const [writerState, setWriterState] = useState<WriterState>(() => browserMutations.getState())
  const writeBlocked = (activeView === 'drive' && routeUnavailable) || writerState === 'fallback-reader' || writerState === 'unavailable' || clearingTrash || deletingSelection
  const [now, setNow] = useState(Date.now)
  const [resumeRecords, setResumeRecords] = useState<UploadResumeRecord[]>([])
  const [resumeProgressById, setResumeProgressById] = useState<ReadonlyMap<string, { uploadedBytes: number; reservedBytes: number; state: 'active' | 'expired' | 'unknown' }>>(() => new Map())
  const [transfers] = useState(() => new TransferStore())
  const transferTasks = useStore(transfers.store, state => state.tasks)
  const [selectedResume, setSelectedResume] = useState<UploadResumeRecord | null>(null)
  const [expiredRestart, setExpiredRestart] = useState<UploadResumeRecord | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadTrigger = useRef<HTMLButtonElement | null>(null)
  const resumeInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const taskControllers = useRef(new Set<AbortController>())
  const screenActive = useRef(true)
  const previewRequest = useRef<{ controller: AbortController; entry: DriveEntry } | null>(null)
  const cancelPendingPreview = useCallback(() => {
    const request = previewRequest.current
    previewRequest.current = null
    if (request) {
      request.controller.abort()
      taskControllers.current.delete(request.controller)
      if (screenActive.current) setUploadMessage('')
    }
  }, [setUploadMessage])
  const vaultForRecovery = props.vault
  const onVaultUpdate = props.onVaultUpdate
  useEffect(() => browserMutations.subscribe(setWriterState), [])
  const mutationRootId = props.vault.rootIndexId
  useEffect(() => { void browserMutations.prepare(mutationRootId).catch(() => undefined) }, [mutationRootId])
  useEffect(() => {
    let live = true
    let refresh = new AbortController()
    const unsubscribe = browserMutations.subscribeInvalidation((scope) => {
      if (scope !== mutationRootId) return
      refresh.abort()
      refresh = new AbortController()
      const signal = refresh.signal
      void refreshVaultFromServer(vaultForRecovery, signal).then(updated => {
        if (!live || signal.aborted) return
        onVaultUpdate(updated)
        // Re-resolve the current URL, not the directory captured by this notice.
        // Authenticated root edges determine current names, ancestry and reachability.
        setRouteAttempt(attempt => attempt + 1)
        selection.clear()
      }).catch(cause => {
        if (live && !signal.aborted) setUploadError('无法同步其他标签页的更新，请重新读取目录。', cause)
      })
    })
    return () => { live = false; refresh.abort(); unsubscribe() }
  }, [vaultForRecovery, mutationRootId, onVaultUpdate, setUploadError, selection])
  const downloadURLs = useRef(new Set<string>())
  const trashRead = useRef<AbortController | null>(null)
  useLayoutEffect(() => {
    trashRead.current?.abort(); trashRead.current = null
    if (activeView !== 'trash' || (activeTrashRoot && !props.vault.trashEntries.some(item => item.tombstoneId === activeTrashRoot.tombstoneId))) {
      setActiveTrashRoot(null); setTrashDirectory(null)
    }
    return () => { trashRead.current?.abort(); trashRead.current = null }
  }, [location.key, location.pathname, activeView, activeTrashRoot, props.vault.trashEntries, props.vault.vaultMutationRevision])
  useLayoutEffect(() => {
    cancelPendingPreview()
    setPreview(current => {
      if (current?.url) { URL.revokeObjectURL(current.url); downloadURLs.current.delete(current.url) }
      return null
    })
    return cancelPendingPreview
  }, [location.key, location.pathname, activeTrashRoot?.tombstoneId, trashDirectory?.indexId, cancelPendingPreview])
  useLayoutEffect(() => {
    const navigation = `${location.key}:${location.pathname}`
    const navigated = routeNavigation.current !== navigation
    routeNavigation.current = navigation
    const discardPreview = (current: PreviewState | null) => {
      if (current?.url) { URL.revokeObjectURL(current.url); downloadURLs.current.delete(current.url) }
      return null
    }
    if (navigated) {
      selection.navigate()
      setActionsEntry(null)
      setPreview(discardPreview)
    }
    const folder = /^\/drive\/([A-Za-z0-9_-]{16,64})$/u.exec(location.pathname)
    if (!folder && !['/drive', '/trash', '/storage', '/settings'].includes(location.pathname)) {
      void navigate('/drive', { replace: true })
      return
    }
    if (activeView !== 'drive') { setFolderLoading(false); return }
    const controller = new AbortController()
    const controllers = taskControllers.current
    controllers.add(controller)
    setFolderLoading(true)
    const hint: unknown = (location.state as { ancestors?: unknown } | null)?.ancestors
    const ancestors = Array.isArray(hint) && hint.length <= 250_000 && hint.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/u.test(id)) ? hint as string[] : []
    void resolveDirectoryRoute({ rootIndexId: routeRootId, metadataKey: routeMetadataKey }, folder?.[1] ?? routeRootId, ancestors, controller.signal).then(next => {
      if (controller.signal.aborted) return
      setDirectory(next)
      const pending = previewRequest.current
      if (pending && conflictIdentity(next.entries.find(entry => entry.entryId === pending.entry.entryId) ?? null) !== conflictIdentity(pending.entry)) cancelPendingPreview()
      setPreview(current => current && conflictIdentity(next.entries.find(entry => entry.entryId === current.entry.entryId) ?? null) !== conflictIdentity(current.entry) ? discardPreview(current) : current)
      setRouteUnavailable(false)
      setRouteError('')
      setResolvedRouteRevision(props.vault.vaultMutationRevision)
    }).catch(cause => {
      if (controller.signal.aborted) return
      // An invalid/unreachable URL must not expose an unrelated old directory.
      setRouteUnavailable(true)
      cancelPendingPreview()
      setDirectory({ indexId: routeRootId, revision: 0, entries: [], path: [] })
      setPreview(discardPreview)
      setRouteError(cause instanceof Error ? cause.message : '无法读取此文件夹，请重试。', cause)
    }).finally(() => {
      taskControllers.current.delete(controller)
      if (!controller.signal.aborted) setFolderLoading(false)
    })
    return () => { controller.abort(); controllers.delete(controller) }
  }, [location.key, location.pathname, location.state, activeView, routeRootId, routeMetadataKey, props.vault.vaultMutationRevision, routeAttempt, navigate, setRouteError, cancelPendingPreview, selection])
  const entries = useMemo(() => sortEntries(directory.entries, sortBy, descending), [directory.entries, sortBy, descending])

  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '')
    folderInput.current?.setAttribute('directory', '')
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const recoveryRequest = useRef<AbortController | null>(null)
  const refreshResumeRecords = useCallback(async () => {
    if (!screenActive.current) return false
    recoveryRequest.current?.abort()
    const controller = new AbortController()
    recoveryRequest.current = controller
    taskControllers.current.add(controller)
    const ownsRecovery = () => screenActive.current && !controller.signal.aborted && recoveryRequest.current === controller
    try {
      const { records, committed, progressById } = await pendingUploadRecords(vaultForRecovery, controller.signal)
      if (!ownsRecovery()) return false
      setResumeRecords(records)
      setResumeProgressById(progressById)
      if (committed) {
        const updated = await refreshVaultFromServer(vaultForRecovery, controller.signal)
        if (!ownsRecovery()) return false
        onVaultUpdate(updated)
        // Resolve the active URL from its authenticated tree instead of publishing
        // a captured root snapshot over a newer displayed directory revision.
        setRouteAttempt(attempt => attempt + 1)
      }
      return true
    } catch (cause) {
      if (ownsRecovery()) throw cause
      return false
    } finally {
      taskControllers.current.delete(controller)
      if (recoveryRequest.current === controller) recoveryRequest.current = null
    }
  }, [vaultForRecovery, onVaultUpdate])

  useEffect(() => {
    let active = true
    void refreshResumeRecords().catch(cause => {
      if (active && screenActive.current) setUploadError('无法读取本地加密恢复记录，请检查浏览器存储权限。', cause)
    })
    return () => { active = false; recoveryRequest.current?.abort(); recoveryRequest.current = null }
  }, [refreshResumeRecords, setUploadError])

  useLayoutEffect(() => {
    screenActive.current = true
    transfers.open()
    selection.open()
    const controllers = taskControllers.current
    const urls = downloadURLs.current
    return () => {
      screenActive.current = false
      transfers.close()
      selection.close()
      controllers.forEach((controller) => controller.abort())
      urls.forEach((url) => URL.revokeObjectURL(url))
      controllers.clear()
      urls.clear()
    }
  }, [transfers, selection])

  const beginTransfer = (task: ActiveTransfer, controller: AbortController) => {
    const accepted = transfers.begin(task, controller)
    if (!accepted) {
      controller.abort(); taskControllers.current.delete(controller)
      if (screenActive.current && task.kind === 'upload') { setUploading(false); setUploadMessage('') }
    }
    return accepted
  }
  const updateTransfer = (id: string, controller: AbortController, update: TransferUpdate) => {
    transfers.update(id, controller, update)
  }
  const finishTransfer = (id: string, controller: AbortController, phase: Extract<TransferPhase, 'completed' | 'failed' | 'cancelled'>, detail?: string) => {
    transfers.finish(id, controller, phase, detail)
  }
  const cancelTransfer = (id: string) => { transfers.cancel(id) }

  const hasActiveTransfers = transferTasks.some((task) => !['completed', 'failed', 'cancelled'].includes(task.phase))
  const usageQuery = useStorageUsage(props.vault.vaultMutationRevision, hasActiveTransfers)
  const usage = usageQuery.isError ? null : usageQuery.data ?? null

  const selectFile = (event: ReactMouseEvent<HTMLButtonElement>) => { uploadTrigger.current = event.currentTarget; fileInput.current?.click() }
  const selectFolder = (event: ReactMouseEvent<HTMLButtonElement>) => {
    uploadTrigger.current = event.currentTarget
    const picker = (window as Window & { showDirectoryPicker?: (options: { mode: 'read' }) => Promise<DirectoryHandleLike> }).showDirectoryPicker
    if (!picker) { folderInput.current?.click(); return }
    void picker.call(window, { mode: 'read' }).then((directoryHandle) => enumerateAndUploadFolder(directoryHandle)).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setUploadError(cause instanceof Error ? cause.message : '无法打开文件夹选择器。', cause)
    })
  }
  const cancelTasks = () => taskControllers.current.forEach((controller) => controller.abort())
  const lockAndCancel = () => { screenActive.current = false; transfers.close(); selection.close(); cancelTasks(); props.onLock() }
  const logoutAndCancel = () => { screenActive.current = false; transfers.close(); selection.close(); cancelTasks(); props.onLogout() }
  const handleDownload = async (entry: (typeof entries)[number]) => {
    const controller = new AbortController()
    const transferId = crypto.randomUUID()
    if (!beginTransfer({ id: transferId, name: entry.name, kind: 'download', phase: 'preparing', completedBytes: 0, totalBytes: entry.size ?? 0 }, controller)) return
    taskControllers.current.add(controller)
    setUploadError('')
    setUploadProgress({ complete: 0, total: 0 })
    setUploadMessage(`正在准备保存 ${entry.name}…`)
    let relay: RelayDownload | undefined
    let releaseIdle = () => {}
    try {
      releaseIdle = props.holdIdleLock('download')
      // Invoke the picker before any network await so browsers retain the user's activation.
      const picker = (window as Window & {
        showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>
      }).showSaveFilePicker
      if (!picker && supportsRelayDownload()) relay = await createRelayDownload(entry.name, entry.size ?? null, controller.signal)
      const writable = picker ? await picker.call(window, { suggestedName: entry.name }).then((handle) => handle.createWritable()) : relay?.writable
      setUploadMessage(`正在本地解密并保存 ${entry.name}…`)
      updateTransfer(transferId, controller, { phase: 'downloading' })
      const blob = await downloadFile(props.vault, entry, relay?.signal ?? controller.signal, writable,
        (completedBytes, totalBytes) => updateTransfer(transferId, controller, { phase: 'downloading', completedBytes, totalBytes }),
        (waiting) => updateTransfer(transferId, controller, { phase: waiting ? 'waiting-network' : 'downloading' }))
      if (!blob) {
        setUploadMessage(relay ? '文件已传输到浏览器下载。' : '文件已保存。')
        finishTransfer(transferId, controller, 'completed')
        return
      }
      const objectURL = URL.createObjectURL(blob)
      downloadURLs.current.add(objectURL)
      const link = document.createElement('a')
      link.href = objectURL
      link.download = entry.name
      link.click()
      window.setTimeout(() => { URL.revokeObjectURL(objectURL); downloadURLs.current.delete(objectURL) }, 1000)
      setUploadMessage('下载已开始。')
      finishTransfer(transferId, controller, 'completed')
    } catch (cause) {
      setUploadMessage('')
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setUploadError(cause instanceof Error ? cause.message : '无法下载此文件。', cause)
      finishTransfer(transferId, controller, cause instanceof DOMException && cause.name === 'AbortError' ? 'cancelled' : 'failed', cause instanceof Error && !(cause instanceof DOMException && cause.name === 'AbortError') ? cause.message : undefined)
    } finally {
      releaseIdle()
      relay?.close()
      taskControllers.current.delete(controller)
    }
  }
  const handleDownloadFolderZip = async (selected = false) => {
    if (zipController) return
    if (selected ? zipSelections.size === 0 : directory.entries.length === 0) return
    const controller = new AbortController()
    const transferId = crypto.randomUUID()
    if (!beginTransfer({ id: transferId, name: selected ? '所选项目.zip' : `${directory.path.at(-1)?.name ?? 'XDrive'}.zip`, kind: 'zip', phase: 'preparing', completedBytes: 0, totalBytes: 0 }, controller)) return
    setZipController(controller)
    taskControllers.current.add(controller)
    setUploadError('')
    setUploadProgress({ complete: 0, total: 0 })
    setUploadMessage('正在检查目录并准备 ZIP64…')
    let writable: WritableStream<Uint8Array> | undefined
    let relay: RelayDownload | undefined
    let releaseIdle = () => {}
    try {
      releaseIdle = props.holdIdleLock('zip')
      const suggestedName = selected ? 'XDrive-selection.zip' : `${directory.path.at(-1)?.name ?? 'XDrive'}.zip`
      const picker = (window as Window & {
        showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>
      }).showSaveFilePicker
      if (!picker && supportsRelayDownload()) relay = await createRelayDownload(suggestedName, null, controller.signal)
      writable = picker ? await picker.call(window, { suggestedName }).then((handle) => handle.createWritable()) : relay?.writable
      const selections = selected ? [...zipSelections.values()] : (await reloadDirectory(props.vault, directory)).entries.map((entry) => ({ entry, parentIndexId: directory.indexId, parentPath: directory.path }))
      const blob = await downloadSelectedAsZip(props.vault, selections, relay?.signal ?? controller.signal, writable, (complete, total) => {
        setUploadProgress({ complete, total })
        setUploadMessage(total > 0 ? `正在生成 ZIP64 · ${Math.min(100, Math.floor(complete / total * 100))}%` : '正在生成 ZIP64…')
        updateTransfer(transferId, controller, { phase: 'downloading', completedBytes: complete, totalBytes: total })
      }, (waiting) => updateTransfer(transferId, controller, { phase: waiting ? 'waiting-network' : 'downloading' }))
      if (blob) {
        const url = URL.createObjectURL(blob)
        downloadURLs.current.add(url)
        const link = document.createElement('a')
        link.href = url
        link.download = suggestedName
        link.click()
        window.setTimeout(() => { URL.revokeObjectURL(url); downloadURLs.current.delete(url) }, 1000)
      }
      setUploadMessage(relay ? 'ZIP 已传输到浏览器下载。' : 'ZIP 文件已保存。')
      finishTransfer(transferId, controller, 'completed')
    } catch (cause) {
      if (writable && !writable.locked) void writable.abort(cause).catch(() => undefined)
      setUploadMessage(controller.signal.aborted ? 'ZIP 已取消。' : '')
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setUploadError(cause instanceof Error ? cause.message : '无法创建 ZIP 文件。', cause)
      finishTransfer(transferId, controller, cause instanceof DOMException && cause.name === 'AbortError' ? 'cancelled' : 'failed', cause instanceof Error && !(cause instanceof DOMException && cause.name === 'AbortError') ? cause.message : undefined)
    } finally {
      releaseIdle()
      relay?.close()
      taskControllers.current.delete(controller)
      setZipController((current) => current === controller ? null : current)
      setUploadProgress({ complete: 0, total: 0 })
    }
  }
  const handlePreview = async (entry: (typeof entries)[number]) => {
    if (entry.kind !== 'file') return
    cancelPendingPreview()
    const mime = entry.mime ?? 'application/octet-stream'
    const ext = entry.name.split('.').at(-1)?.toLowerCase() ?? ''
    const textKind = textPreviewKind(entry.name, mime)
    const isText = textKind !== null
    const isPdf = mime === 'application/pdf' || ext === 'pdf'
    if (!isText && !isPdf && !mime.startsWith('image/') && !mime.startsWith('video/')) {
      setUploadError('此文件类型暂不支持预览，请下载后打开。')
      return
    }
    const controller = new AbortController()
    const request = { controller, entry }
    previewRequest.current = request
    const ownsPreview = () => screenActive.current && !controller.signal.aborted && previewRequest.current === request
    taskControllers.current.add(controller)
    setUploadError('')
    setUploadMessage(`正在解密预览 ${entry.name}…`)
    if (isPdf) {
      previewRequest.current = null
      taskControllers.current.delete(controller)
      setPreview({ entry, kind: 'pdf' })
      setUploadMessage('')
      return
    }
    if (mime.startsWith('video/')) {
      previewRequest.current = null
      taskControllers.current.delete(controller)
      setPreview({ entry, kind: 'video' })
      setUploadMessage('')
      return
    }
    try {
      if (isText) {
        const limit = await fetchTextPreviewLimit(controller.signal)
        controller.signal.throwIfAborted()
        if ((entry.size ?? 0) > limit) throw new TypeError(`文本文件超过 ${limit.toLocaleString('zh-CN')} bytes 预览上限，请下载后查看。`)
      }
      const blob = await downloadFile(props.vault, entry, controller.signal)
      if (!ownsPreview()) return
      if (!blob) throw new TypeError('浏览器没有返回预览数据。')
      if (textKind) {
        const text = await blob.text()
        if (!ownsPreview()) return
        setPreview({ entry, kind: textKind, text })
      }
      else {
        const url = URL.createObjectURL(blob)
        downloadURLs.current.add(url)
        setPreview({ entry, kind: 'image', url })
      }
      setUploadMessage('')
    } catch (cause) {
      if (!ownsPreview()) return
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setUploadError(cause instanceof Error ? cause.message : '无法预览此文件。', cause)
      setUploadMessage('')
    } finally {
      taskControllers.current.delete(controller)
      if (previewRequest.current === request) previewRequest.current = null
    }
  }
  const closePreview = () => {
    cancelPendingPreview()
    if (preview?.url) {
      URL.revokeObjectURL(preview.url)
      downloadURLs.current.delete(preview.url)
    }
    setPreview(null)
  }
  const openFolder = (entry: (typeof entries)[number]) => {
    if (entry.kind !== 'folder' || !entry.childIndexId) return
    void navigate(`/drive/${entry.childIndexId}`, { state: { ancestors: [...directory.path.map(crumb => crumb.indexId), directory.indexId] } })
  }
  const navigateTo = (depth: number) => {
    const target = depth < 0 ? routeRootId : directory.path[depth]!.indexId
    void navigate(target === routeRootId ? '/drive' : `/drive/${target}`, { state: { ancestors: directory.path.slice(0, Math.max(0, depth)).map(crumb => crumb.indexId) } })
  }
  const handleCreateFolder = async () => {
    if (writeBlocked || uploading || folderLoading) return
    const name = window.prompt('新文件夹名称')
    if (name === null) return
    const controller = new AbortController()
    taskControllers.current.add(controller)
    setUploadError('')
    setUploadMessage('正在创建加密文件夹…')
    try {
      const result = await createFolder(props.vault, directory, name, controller.signal)
      if (!screenActive.current || controller.signal.aborted) return
      props.onVaultUpdate(result.vault)
      publishDirectoryUpdate(result.directory)
      setUploadMessage('文件夹已创建。')
    } catch (cause) {
      if (!screenActive.current || controller.signal.aborted) return
      setUploadMessage('')
      setUploadError(cause instanceof Error ? cause.message : '创建文件夹失败。', cause)
    } finally { taskControllers.current.delete(controller) }
  }
  const handleRename = async (entryId: string) => {
    if (writeBlocked || uploading || folderLoading) return
    const selected = directory.entries.find((entry) => entry.entryId === entryId)
    if (!selected) return
    const name = window.prompt('重命名', selected.name)
    if (name === null) return
    const controller = new AbortController()
    taskControllers.current.add(controller)
    try {
      const result = await renameEntry(props.vault, directory, entryId, name, controller.signal)
      if (!screenActive.current || controller.signal.aborted) return
      props.onVaultUpdate(result.vault)
      publishDirectoryUpdate(result.directory)
      setUploadError('')
      setUploadMessage('重命名完成。')
    } catch (cause) {
      if (!screenActive.current || controller.signal.aborted) return
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setUploadError(cause instanceof Error ? cause.message : '重命名失败。', cause)
    } finally { taskControllers.current.delete(controller) }
  }
  const handleMoveToParent = async (entryId: string) => {
    if (writeBlocked || uploading || folderLoading || !directory.path.length) return
    const parentPath = directory.path.slice(0, -1)
    const parentId = directory.path.at(-1)!.indexId
    const controller = new AbortController()
    taskControllers.current.add(controller)
    try {
      const parent = await loadDirectory(props.vault, parentId, parentPath, controller.signal)
      const result = await moveEntry(props.vault, directory, parent, entryId, controller.signal)
      if (!screenActive.current || controller.signal.aborted) return
      props.onVaultUpdate(result.vault)
      publishDirectoryUpdate(result.source)
      publishDirectoryUpdate(result.target)
      setUploadError('')
      setUploadMessage('项目已移动到上一级文件夹。')
    } catch (cause) {
      if (!screenActive.current || controller.signal.aborted) return
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setUploadError(cause instanceof Error ? cause.message : '移动失败。', cause)
    } finally { taskControllers.current.delete(controller) }
  }
  const commitMoveSelections = async (selections: readonly ZipSelection[], target: DirectoryState): Promise<boolean> => {
    if (selections.length === 0 || writeBlocked || uploading || folderLoading) return false
    const controller = new AbortController()
    taskControllers.current.add(controller)
    try {
      const result = await moveSelectedEntries(props.vault, selections, target, controller.signal)
      if (!screenActive.current || controller.signal.aborted) return false
      props.onVaultUpdate(result.vault)
      for (const updated of result.directories.values()) publishDirectoryUpdate(updated)
      selection.complete(selections)
      setUploadError('')
      setUploadMessage(result.movedCount === 1 ? '项目已移动。' : `${result.movedCount} 个项目已原子移动。`)
      return true
    } catch (cause) {
      if (!screenActive.current || controller.signal.aborted) return false
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setUploadError(cause instanceof Error ? cause.message : '移动失败。', cause)
      return false
    } finally { taskControllers.current.delete(controller) }
  }
  const handleMoveToTarget = async (target: DirectoryState): Promise<boolean> => {
    const moved = await commitMoveSelections(movingSelections, target)
    if (moved) setMovingSelections([])
    return moved
  }
  const clearMoveDrag = () => {
    moveDragSelections.current = []
    dropTargetId.current = ''
    setDropFeedback(null)
    dragPreview.current?.remove()
    dragPreview.current = null
  }
  useEffect(() => () => { dragPreview.current?.remove() }, [])
  const startEntryDrag = (event: ReactDragEvent<HTMLDivElement>, entry: DriveEntry) => {
    const target = event.target as HTMLElement
    if (target.closest('input, label, .entry-download, .entry-card-more') || writeBlocked || uploading || folderLoading || zipController) {
      event.preventDefault()
      return
    }
    const selections = zipSelections.has(entry.entryId)
      ? [...zipSelections.values()]
      : [{ entry, parentIndexId: directory.indexId, parentPath: directory.path }]
    moveDragSelections.current = selections
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-xdrive-move', 'move')
    const preview = document.createElement('div')
    preview.className = 'move-drag-preview'
    for (const selection of selections.slice(0, 3)) {
      const card = document.createElement('span'); card.textContent = selection.entry.name; preview.append(card)
    }
    if (selections.length > 3) { const badge = document.createElement('b'); badge.textContent = `+${selections.length - 3}`; preview.append(badge) }
    document.body.append(preview); dragPreview.current = preview
    event.dataTransfer.setDragImage(preview, 24, 24)
    requestAnimationFrame(() => { preview.remove(); if (dragPreview.current === preview) dragPreview.current = null })
  }
  const enterFolderDrop = (event: ReactDragEvent<HTMLDivElement>, entry: DriveEntry) => {
    if (!moveDragSelections.current.length || !event.dataTransfer.types.includes('application/x-xdrive-move') || entry.kind !== 'folder' || !entry.childIndexId) return
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'
    if (dropTargetId.current === entry.entryId) return
    dropTargetId.current = entry.entryId
    setDropFeedback({ entryId: entry.entryId, state: 'checking', message: '正在检查目标文件夹…' })
    const path = [...directory.path, { indexId: directory.indexId, name: entry.name }]
    void loadDirectory(props.vault, entry.childIndexId, path).then(targetDirectory => {
      if (dropTargetId.current !== entry.entryId) return
      const assessment = assessMoveDrop(targetDirectory, moveDragSelections.current)
      setDropFeedback({ entryId: entry.entryId, state: assessment.state === 'allowed' ? 'allowed' : 'blocked', message: assessment.state === 'allowed' ? `移到「${entry.name}」` : assessment.message })
    }).catch(() => {
      if (dropTargetId.current === entry.entryId) setDropFeedback({ entryId: entry.entryId, state: 'blocked', message: '无法检查目标文件夹。' })
    })
  }
  const leaveFolderDrop = (event: ReactDragEvent<HTMLDivElement>, entry: DriveEntry) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    if (dropTargetId.current === entry.entryId) { dropTargetId.current = ''; setDropFeedback(null) }
  }
  const dropIntoFolder = async (event: ReactDragEvent<HTMLDivElement>, entry: DriveEntry) => {
    if (!moveDragSelections.current.length || !event.dataTransfer.types.includes('application/x-xdrive-move') || entry.kind !== 'folder' || !entry.childIndexId) return
    event.preventDefault()
    const selections = [...moveDragSelections.current]
    clearMoveDrag()
    const path = [...directory.path, { indexId: directory.indexId, name: entry.name }]
    try {
      const targetDirectory = await loadDirectory(props.vault, entry.childIndexId, path)
      const assessment = assessMoveDrop(targetDirectory, selections)
      if (assessment.state !== 'allowed') { setUploadError(assessment.message); return }
      await commitMoveSelections(selections, targetDirectory)
    } catch (cause) { setUploadError(cause instanceof Error ? cause.message : '无法将项目移动到目标文件夹。', cause) }
  }
  const closeDeleteSelection = () => {
    setDeleteSelections(null)
    const target = deleteSelectionFocus.current; deleteSelectionFocus.current = null
    requestAnimationFrame(() => { if (target?.isConnected) target.focus() })
  }
  const requestDeleteSelection = () => {
    if (writeBlocked || uploading || folderLoading || !zipSelections.size) return
    deleteSelectionFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDeleteSelections([...zipSelections.values()])
  }
  const handleDeleteSelection = async () => {
    if (writeBlocked || uploading || !deleteSelections?.length) return
    const confirmed = deleteSelections; closeDeleteSelection()
    const controller = new AbortController(); taskControllers.current.add(controller)
    setDeletingSelection(true); setUploadError(''); setUploadMessage('正在原子移入回收站…')
    try {
      const result = await deleteSelectedEntries(props.vault, confirmed, controller.signal)
      if (!screenActive.current || controller.signal.aborted) return
      props.onVaultUpdate(result.vault)
      for (const updated of result.directories.values()) publishDirectoryUpdate(updated)
      setRouteAttempt(attempt => attempt + 1)
      selection.complete(confirmed)
      setUploadMessage(`已将 ${result.deletedCount} 个顶层项目原子移到回收站。`)
    } catch (cause) {
      if (!screenActive.current || controller.signal.aborted) return
      setUploadMessage(''); setUploadError(cause instanceof APIError && cause.code === 'maintenance_reserve_exhausted' ? '元数据维护预留不足。所选项目保持原位。可尝试永久清空回收站后刷新存储用量；如果预留仍不足或无法清理，请联系管理员检查维护预留配置。取消普通上传不会增加这项预留。' : cause instanceof Error ? cause.message : '批量移入回收站失败。', cause)
    } finally { taskControllers.current.delete(controller); if (screenActive.current) setDeletingSelection(false) }
  }
  const handleDelete = async (entryId: string) => {
    if (writeBlocked || uploading || folderLoading) return
    const selected = directory.entries.find((entry) => entry.entryId === entryId)
    if (!selected || !window.confirm(`将“${selected.name}”移到回收站？`)) return
    const controller = new AbortController()
    taskControllers.current.add(controller)
    setUploadError('')
    setUploadMessage('正在安全移入回收站…')
    try {
      const result = await deleteEntry(props.vault, directory, entryId, controller.signal)
      if (!screenActive.current || controller.signal.aborted) return
      props.onVaultUpdate(result.vault)
      publishDirectoryUpdate(result.directory)
      setUploadMessage('已移到回收站。')
    } catch (cause) {
      if (!screenActive.current || controller.signal.aborted) return
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setUploadError(cause instanceof APIError && cause.code === 'maintenance_reserve_exhausted' ? '元数据维护预留不足。原项目保持原位。可尝试永久清空回收站后刷新存储用量；如果预留仍不足或无法清理，请联系管理员检查维护预留配置。取消普通上传不会增加这项预留。' : cause instanceof Error ? cause.message : '移入回收站失败。', cause)
      setUploadMessage('')
    } finally { taskControllers.current.delete(controller) }
  }
  const readTrashDirectory = async (root: TrashRootEntry, id: string, path: DirectoryState['path']) => {
    trashRead.current?.abort()
    const controller = new AbortController()
    trashRead.current = controller
    taskControllers.current.add(controller)
    const ownsRead = () => screenActive.current && !controller.signal.aborted && trashRead.current === controller
    setFolderLoading(true)
    try {
      const loaded = await loadDirectory(props.vault, id, path, controller.signal)
      if (!ownsRead()) return
      setActiveTrashRoot(root); setTrashDirectory(loaded); setUploadError('')
    } catch (cause) { if (ownsRead()) setUploadError('无法读取回收站中的文件夹。', cause) }
    finally {
      taskControllers.current.delete(controller)
      if (ownsRead()) { trashRead.current = null; setFolderLoading(false) }
    }
  }
  const resetTrashPath = () => {
    trashRead.current?.abort(); trashRead.current = null
    setActiveTrashRoot(null); setTrashDirectory(null); setFolderLoading(false)
  }
  const openTrashFolder = async (root: TrashRootEntry) => {
    if (root.item.kind === 'folder' && root.item.childIndexId) await readTrashDirectory(root, root.item.childIndexId, [])
  }
  const openTrashChildFolder = async (entry: DriveEntry) => {
    if (!activeTrashRoot || !trashDirectory || entry.kind !== 'folder' || !entry.childIndexId) return
    await readTrashDirectory(activeTrashRoot, entry.childIndexId, [...trashDirectory.path, { indexId: trashDirectory.indexId, name: entry.name }])
  }
  const restoreRoots = async (ids: readonly string[], choice: 'reject' | 'keep-both' = 'reject') => {
    if (writeBlocked || uploading || clearingTrash || !ids.length) return
    const controller = new AbortController()
    taskControllers.current.add(controller); setClearingTrash(true); setPendingRestoreConflict(null); setUploadError('')
    try {
      const updated = await restoreTrashEntries(props.vault, ids, choice, controller.signal)
      if (!screenActive.current || controller.signal.aborted) return
      props.onVaultUpdate(updated)
      setRouteAttempt(attempt => attempt + 1)
      setActiveTrashRoot(null); setTrashDirectory(null)
      setTrashSelected((current) => new Set([...current].filter((id) => !ids.includes(id))))
      setUploadMessage(ids.length === 1 ? '项目已恢复。' : `已原子恢复 ${ids.length} 个顶层项目。`)
    } catch (cause) {
      if (!screenActive.current || controller.signal.aborted) return
      if (cause instanceof RestoreNameConflictError && choice === 'reject') setPendingRestoreConflict({ ids: [...ids], message: cause.message })
      else {
        setUploadError(cause instanceof Error ? cause.message : '恢复失败。', cause)
        try {
          const current = await refreshVaultFromServer(props.vault, controller.signal)
          if (screenActive.current && !controller.signal.aborted) {
            props.onVaultUpdate(current); setActiveTrashRoot(null); setTrashDirectory(null)
            const present = new Set(current.trashEntries.map((entry) => entry.tombstoneId))
            setTrashSelected((previous) => new Set([...previous].filter((id) => present.has(id))))
          }
        } catch { /* Retain the error if reconciliation is unavailable. */ }
      }
    } finally {
      taskControllers.current.delete(controller)
      if (screenActive.current) setClearingTrash(false)
    }
  }
  const handleRestore = (root: TrashRootEntry) => restoreRoots([root.tombstoneId])
  const requestSelectedPurge = (trigger: HTMLButtonElement) => {
    if (writeBlocked || uploading || !trashSelected.size) return
    clearTrashFocus.current = trigger
    setClearTrashMode('selected'); setClearTrashIds([...trashSelected])
  }
  const requestClearTrash = (trigger: HTMLButtonElement) => {
    if (writeBlocked || uploading || clearingTrash || !props.vault.trashEntries.length) return
    clearTrashFocus.current = trigger
    setClearTrashMode('all'); setClearTrashIds(props.vault.trashEntries.map((entry) => entry.tombstoneId))
  }
  const closeClearTrash = () => {
    setClearTrashIds(null)
    const target = clearTrashFocus.current
    requestAnimationFrame(() => { if (screenActive.current && target?.isConnected) target.focus() })
  }
  const handleClearTrash = async () => {
    if (!clearTrashIds || writeBlocked || clearingTrash) return
    const ids = clearTrashIds
    closeClearTrash()
    const controller = new AbortController()
    taskControllers.current.add(controller)
    setClearingTrash(true); setUploadError(''); setUploadMessage('正在永久删除确认的回收站项目…')
    try {
      const updated = await purgeTrashEntries(props.vault, ids, controller.signal)
      if (!screenActive.current || controller.signal.aborted) return
      props.onVaultUpdate(updated); setActiveTrashRoot(null); setTrashDirectory(null)
      setTrashSelected((current) => new Set([...current].filter((id) => !ids.includes(id))))
      setUploadMessage(clearTrashMode === 'selected' ? `已原子永久删除 ${ids.length} 个选中顶层项目；未选项目保留。` : updated.trashEntries.length ? '确认的项目已永久删除。期间新移入的项目仍在回收站。' : '回收站已清空。')
    } catch (cause) {
      if (screenActive.current && !controller.signal.aborted) {
        setUploadMessage('')
        setUploadError(describePurgeError(cause), cause)
        try {
          const current = await refreshVaultFromServer(props.vault, controller.signal)
          if (screenActive.current && !controller.signal.aborted) { props.onVaultUpdate(current); setActiveTrashRoot(null); setTrashDirectory(null) }
        } catch { /* Keep the error and previous view when reconciliation is unavailable. */ }
      }
    } finally {
      taskControllers.current.delete(controller)
      if (screenActive.current) {
        setClearingTrash(false)
        requestAnimationFrame(() => {
          if (!screenActive.current) return
          const target = clearTrashFocus.current
          if (target?.isConnected && !target.matches(':disabled')) target.focus()
          else document.querySelector<HTMLElement>('.nav-item.is-current')?.focus()
        })
      }
    }
  }
  const handlePurge = async (trashRoot: TrashRootEntry) => {
    if (writeBlocked || clearingTrash || !window.confirm(`永久删除“${trashRoot.item.name}”？此操作无法撤销。`)) return
    const controller = new AbortController()
    taskControllers.current.add(controller); setClearingTrash(true); setUploadError('')
    try {
      const updated = await purgeTrashEntry(props.vault, trashRoot.tombstoneId, controller.signal)
      if (!screenActive.current || controller.signal.aborted) return
      props.onVaultUpdate(updated)
      setActiveTrashRoot(null)
      setTrashDirectory(null)
      setTrashSelected((previous) => new Set([...previous].filter((id) => id !== trashRoot.tombstoneId)))
      setUploadMessage('项目已永久删除。')
    } catch (cause) {
      if (screenActive.current && !controller.signal.aborted) setUploadError(describePurgeError(cause), cause)
    } finally {
      taskControllers.current.delete(controller)
      if (screenActive.current) setClearingTrash(false)
    }
  }
  const selectEntry = (entry: DriveEntry, range = false) => selection.select(entries, directory.indexId, directory.path, range ? 'range' : 'toggle', entry.entryId)
  const selectAll = () => selection.select(entries, directory.indexId, directory.path, 'all')
  const longPress = useLongPressSelection(`${activeView}/${directory.indexId}`, id => {
    const entry = entries.find(item => item.entryId === id)
    if (entry && !batchIds.has(id)) selectEntry(entry)
  })
  const selectionClick = (event: React.MouseEvent<HTMLDivElement>, entry: DriveEntry) => {
    if (longPress.consumeClick(entry.entryId)) { event.preventDefault(); event.stopPropagation(); return }
    const touchMode = zipSelections.size > 0 && matchMedia('(pointer: coarse)').matches
    if (!(event.ctrlKey || event.metaKey || event.shiftKey || touchMode)) return
    const target = event.target as HTMLElement
    if (target.closest('input, label, .entry-download, .entry-card-more')) return
    event.preventDefault(); event.stopPropagation(); selectEntry(entry, event.shiftKey)
  }
  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, entry: (typeof entries)[number]) => {
    if (event.target !== event.currentTarget) return
    if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); selectEntry(entry, event.shiftKey)
    } else if (event.key === 'F2') {
      event.preventDefault()
      void handleRename(entry.entryId)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (entry.kind === 'folder') void openFolder(entry)
      else void handlePreview(entry)
    }
  }
  const handleFile = async (file: File | undefined, choice?: UploadConflictChoice, destination: DirectoryState = directory) => {
    if (!file || !screenActive.current || (!choice && (folderLoading || routeUnavailable))) return
    setUploadMessage('')
    setUploadError('')
    const controller = new AbortController()
    taskControllers.current.add(controller)
    let freshDirectory: DirectoryState
    try {
      freshDirectory = await resolveDirectoryRoute(props.vault, destination.indexId, destination.path.map(part => part.indexId), controller.signal)
      if (controller.signal.aborted) return
      publishDirectoryUpdate(freshDirectory)
      await usageQuery.read(controller.signal)
      if (controller.signal.aborted) return
    } catch (cause) {
      if (!controller.signal.aborted) setUploadError(cause instanceof Error ? cause.message : '无法重新检查目标文件夹和容量。', cause)
      taskControllers.current.delete(controller)
      return
    } finally {
      if (controller.signal.aborted) taskControllers.current.delete(controller)
    }
    if (!choice) {
      const existing = freshDirectory.entries.find((entry) => entry.name.normalize('NFC') === file.name.normalize('NFC'))
      if (existing) {
        taskControllers.current.delete(controller)
        setPendingUploadConflict({ file, existing, destination: freshDirectory })
        if (fileInput.current) fileInput.current.value = ''
        return
      }
    }
    if (choice?.replaceEntryId && !freshDirectory.entries.some((entry) => entry.entryId === choice.replaceEntryId && entry.name === file.name.normalize('NFC') && (!choice.expectedReplacementIdentity || conflictIdentity(entry) === choice.expectedReplacementIdentity))) {
      const existing = freshDirectory.entries.find((entry) => entry.name === file.name.normalize('NFC'))
      taskControllers.current.delete(controller)
      if (existing) setPendingUploadConflict({ file, existing, destination: freshDirectory })
      else setUploadError('待覆盖文件已变化；请重新选择文件并检查目标目录。')
      return
    }
    if (choice?.targetName && freshDirectory.entries.some(entry => entry.name === choice.targetName)) {
      taskControllers.current.delete(controller)
      const existing = freshDirectory.entries.find(entry => entry.name === file.name.normalize('NFC'))
      if (existing) setPendingUploadConflict({ file, existing, destination: freshDirectory })
      else setUploadError('保留两者的目标名称已变化；请重新选择文件并检查目标目录。')
      return
    }
    setUploading(true)
    setQuotaBlocked(false)
    setUploadError('')
    setUploadMessage('正在准备加密上传…')
    setUploadProgress({ complete: 0, total: 0 })
    const transferId = crypto.randomUUID()
    if (!beginTransfer({ id: transferId, name: choice?.targetName ?? file.name, kind: 'upload', phase: 'preparing', completedBytes: 0, totalBytes: file.size }, controller)) return
    let transferOutcome: Extract<TransferPhase, 'completed' | 'failed' | 'cancelled'> = 'failed'
    let transferFailure = ''
    let releaseIdle = () => {}
    try {
      releaseIdle = props.holdIdleLock('upload')
      const result = await uploadFile(props.vault, file, freshDirectory, (complete, total, transfer) => {
        setUploadProgress({ complete, total })
        setUploadMessage(complete === total ? '正在安全提交目录…' : `已加密并上传 ${complete} / ${total} 个数据块`)
        if (transfer) updateTransfer(transferId, controller, { phase: transfer.phase, completedBytes: transfer.completedBytes, totalBytes: transfer.totalBytes })
      }, controller.signal, undefined, choice)
      if (!screenActive.current || controller.signal.aborted) return
      props.onVaultUpdate(result.vault)
      publishDirectoryUpdate(result.directory)
      setUploadMessage('上传完成。')
      transferOutcome = 'completed'
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        setUploadMessage('')
        transferOutcome = 'cancelled'
      } else if (cause instanceof APIError && cause.code === 'quota_exceeded') {
        setQuotaBlocked(true)
        const latestUsage = await usageQuery.read(controller.signal).catch(() => usage)
        if (!screenActive.current || controller.signal.aborted) { transferOutcome = 'cancelled'; return }
        const shortfall = cause.shortfallBytes ?? (latestUsage ? Math.max(0, file.size - latestUsage.availableBytes) : 0)
        setUploadError(`空间不足${shortfall > 0 ? `，${cause.shortfallBytes === undefined ? '至少' : ''}缺少 ${formatBytes(shortfall)}` : ''}。回收站占用 ${formatBytes(latestUsage?.trashBytes ?? 0)}；请先清理其他内容，再重新检查同名冲突并重试。旧文件保持原位。`, cause)
      } else if (cause instanceof APIError && cause.code === 'disk_space_low') {
        setUploadError('服务器磁盘空间不足，XDrive 保留了现有文件。请释放服务器磁盘后重试。', cause)
      } else if (cause instanceof APIError && ['vault_mutation_conflict', 'global_revision_conflict'].includes(cause.code)) {
        setUploadError('云盘已在其他标签页发生变化。请刷新页面后重新上传。', cause)
      } else {
        setUploadError(cause instanceof Error ? cause.message : '上传失败，请重试。', cause)
      }
      transferFailure = cause instanceof Error ? cause.message : '上传失败。'
      setUploadMessage('')
    } finally {
      releaseIdle()
      taskControllers.current.delete(controller)
      setUploading(false)
      if (screenActive.current) {
        try { await refreshResumeRecords() } catch { setUploadError('无法读取本地加密恢复记录。') }
      }
      if (fileInput.current) fileInput.current.value = ''
      finishTransfer(transferId, controller, transferOutcome, transferOutcome === 'failed' ? transferFailure : undefined)
    }
  }
  const handleResume = async (file: File | undefined) => {
    const record = selectedResume
    setSelectedResume(null)
    if (!file || !record) return
    setUploading(true)
    setUploadError('')
    setUploadMessage(`正在核对“${record.name}”的已上传密文…`)
    const controller = new AbortController()
    taskControllers.current.add(controller)
    const transferId = crypto.randomUUID()
    if (!beginTransfer({ id: transferId, name: record.name, kind: 'upload', phase: 'preparing', completedBytes: resumeProgressById.get(record.id)?.uploadedBytes ?? 0, totalBytes: record.size }, controller)) return
    let transferOutcome: Extract<TransferPhase, 'completed' | 'failed' | 'cancelled'> = 'failed'
    let transferFailure = ''
    let releaseIdle = () => {}
    try {
      releaseIdle = props.holdIdleLock('upload')
      const result = await resumeUploadFile(props.vault, file, record, (complete, total, transfer) => {
        setUploadProgress({ complete, total })
        setUploadMessage(complete === total ? '正在安全提交目录…' : `已核对或上传 ${complete} / ${total} 个数据块`)
        if (transfer) updateTransfer(transferId, controller, { phase: transfer.phase, completedBytes: transfer.completedBytes, totalBytes: transfer.totalBytes })
      }, controller.signal)
      if (!screenActive.current || controller.signal.aborted) return
      props.onVaultUpdate(result.vault)
      publishDirectoryUpdate(result.directory)
      setUploadMessage('续传完成。')
      transferOutcome = 'completed'
    } catch (cause) {
      setUploadMessage('')
      setUploadError(cause instanceof Error ? cause.message : '续传失败，请稍后重试。', cause)
      transferOutcome = cause instanceof DOMException && cause.name === 'AbortError' ? 'cancelled' : 'failed'
      transferFailure = cause instanceof Error ? cause.message : '续传失败。'
    } finally {
      releaseIdle()
      taskControllers.current.delete(controller)
      setUploading(false)
      if (resumeInput.current) resumeInput.current.value = ''
      if (screenActive.current) {
        try { await refreshResumeRecords() } catch { setUploadError('无法读取本地加密恢复记录。') }
      }
      finishTransfer(transferId, controller, transferOutcome, transferOutcome === 'failed' ? transferFailure : undefined)
    }
  }
  const handleRestartExpiredUpload = async (record: UploadResumeRecord, file: File | undefined) => {
    if (!file || !screenActive.current) return
    try {
      await assertOriginalFile(file, record)
      if (!screenActive.current) return
      await abandonResumableUpload(record)
      if (!await refreshResumeRecords()) return
      await handleFile(file)
    } catch (cause) {
      if (!screenActive.current) return
      setUploadError(cause instanceof Error ? cause.message : '无法重新开始过期上传。', cause)
    }
  }
  const handleAbandonResume = async (record: UploadResumeRecord) => {
    if (!screenActive.current) return
    try {
      await abandonResumableUpload(record)
      if (!await refreshResumeRecords()) return
      setUploadMessage('已放弃该上传任务。')
      setUploadError('')
    } catch (cause) { setUploadError(cause instanceof Error ? cause.message : '无法放弃上传任务。', cause) }
  }
  const handleFolder = async (files: FileList | readonly File[] | null, kind: 'folder' | 'files' = 'folder') => {
    if (!files?.length || folderLoading || routeUnavailable) return
    const selected = Array.from(files)
    const label = kind === 'folder' ? '文件夹上传' : '批量上传'
    const returnFocus = uploadTrigger.current ?? document.activeElement
    uploadTrigger.current = null
    let promptShown = false
    setUploading(true)
    setUploadError('')
    setQuotaBlocked(false)
    setUploadProgress({ complete: 0, total: selected.length })
    setUploadMessage(`正在准备${label}的 ${selected.length} 个文件…`)
    const controller = new AbortController()
    taskControllers.current.add(controller)
    const transferId = crypto.randomUUID()
    const totalBytes = selected.reduce((sum, file) => sum + file.size, 0)
    if (!beginTransfer({ id: transferId, name: label, kind: 'upload', phase: 'preparing', completedBytes: 0, totalBytes, detail: `${selected.length} 个文件` }, controller)) return
    let transferOutcome: Extract<TransferPhase, 'completed' | 'failed' | 'cancelled'> = 'failed'
    let transferFailure = ''
    let releaseIdle = () => {}
    try {
      releaseIdle = props.holdIdleLock('upload')
      const result = await (kind === 'folder' ? uploadFolder : uploadFiles)(props.vault, directory, selected, (complete, total, transfer) => {
        setUploadProgress({ complete, total })
        setUploadMessage(`${label}进度：${complete} / ${total} 个文件`)
        if (transfer) updateTransfer(transferId, controller, { phase: transfer.phase, completedBytes: transfer.completedBytes, totalBytes: transfer.totalBytes, detail: `${complete} / ${total} 个文件${transfer.currentFileName ? ` · ${transfer.currentFileName}` : ''}` })
      }, controller.signal, async (conflicts, signal) => {
        promptShown = true
        await usageQuery.read(signal)
        signal?.throwIfAborted()
        setUploadMessage('等待确认所选文件的同名冲突…')
        // Waiting for a human decision is not an active upload. Let it lock.
        releaseIdle(); releaseIdle = () => {}
        return new Promise<ReadonlyMap<string, FolderConflictAction>>((resolve, reject) => {
          let settled = false
          const cleanup = () => { settled = true; signal?.removeEventListener('abort', abort); setPendingFolderConflict(null) }
          const abort = () => { if (!settled) { cleanup(); reject(new DOMException('Folder upload cancelled', 'AbortError')) } }
          signal?.addEventListener('abort', abort, { once: true })
          setPendingFolderConflict({ kind, destinationLabel: ['我的文件', ...directory.path.map(part => part.name)].join(' / '), conflicts, confirm: (choices) => {
            if (!settled) {
              try { releaseIdle = props.holdIdleLock('upload'); cleanup(); resolve(choices) }
              catch (cause) { cleanup(); reject(cause) }
            }
          }, cancel: () => controller.abort() })
          if (signal?.aborted) abort()
        })
      })
      if (!screenActive.current || controller.signal.aborted) return
      props.onVaultUpdate(result.vault)
      publishDirectoryUpdate(result.directory)
      if (result.failures.length > 0) {
        setUploadMessage(`已完成 ${result.completedFiles} / ${selected.length} 个文件，跳过 ${result.skippedFiles} 个；其余项目未上传。${kind === 'folder' ? '空文件夹不会上传。' : ''}`)
        setUploadError(result.failures.slice(0, 5).join('；'))
        if (result.capacityFailure?.code === 'quota_exceeded') {
          const latestUsage = await usageQuery.read(controller.signal)
          controller.signal.throwIfAborted()
          if (!screenActive.current) throw new DOMException('Upload owner ended', 'AbortError')
          setQuotaBlocked(true)
          const shortfall = result.capacityFailure.shortfallBytes
          setUploadError(`空间不足${shortfall ? `，缺少 ${formatBytes(shortfall)}` : ''}。回收站占用 ${formatBytes(latestUsage.trashBytes)}；请先清理其他内容，再重新选择${kind === 'folder' ? '文件夹' : '文件'}检查冲突。已完成文件保留，未覆盖的旧文件保持原位。`)
        } else if (result.capacityFailure?.code === 'disk_space_low') setUploadError(`服务器磁盘空间不足，已停止${label}。已完成文件保留，未覆盖的旧文件保持原位。`)
      } else {
        setUploadNotice({ message: `${label}完成，共 ${result.completedFiles} 个文件${result.skippedFiles ? `，跳过 ${result.skippedFiles} 个` : ''}。${kind === 'folder' ? '空文件夹不会上传。' : ''}`, revision: result.vault.vaultMutationRevision })
      }
      transferOutcome = result.failures.length > 0 ? 'failed' : 'completed'
      if (result.failures.length > 0) transferFailure = result.failures.slice(0, 5).join('；')
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') { setUploadMessage(`${label}已取消；已提交文件仍保留。`); transferOutcome = 'cancelled' }
      else { setUploadMessage(''); setUploadError(cause instanceof Error ? cause.message : `${label}失败。`, cause); transferFailure = cause instanceof Error ? cause.message : `${label}失败。` }
      // A batch is a series of committed files. Reflect those commits after
      // cancel/failure, but never begin a new decrypt with an unmounted context.
      if (screenActive.current) {
        const refresh = new AbortController()
        taskControllers.current.add(refresh)
        try {
          const updated = await refreshVaultFromServer(props.vault, refresh.signal)
          const current = await reloadDirectory(updated, directory, refresh.signal).catch(() => loadDirectory(updated, updated.rootIndexId, [], refresh.signal))
          if (screenActive.current && !refresh.signal.aborted) { props.onVaultUpdate(updated); publishDirectoryUpdate(current) }
        } catch { /* Preserve the original error; the next unlock rereads the tree. */ }
        finally { taskControllers.current.delete(refresh) }
      }
    } finally {
      releaseIdle()
      taskControllers.current.delete(controller)
      setUploading(false)
      if (screenActive.current) {
        try { await refreshResumeRecords() } catch { setUploadError('无法读取本地加密恢复记录。') }
      }
      finishTransfer(transferId, controller, transferOutcome, transferOutcome === 'failed' ? transferFailure : undefined)
      if (promptShown && screenActive.current && returnFocus instanceof HTMLElement) requestAnimationFrame(() => {
        if (screenActive.current && returnFocus.isConnected && !returnFocus.matches(':disabled')) returnFocus.focus()
      })
    }
  }
  const enumerateAndUploadFolder = async (directoryHandle: DirectoryHandleLike) => {
    if (!screenActive.current || folderLoading || routeUnavailable || uploading) return
    const controller = new AbortController()
    taskControllers.current.add(controller)
    let releaseIdle = () => {}
    setUploading(true)
    setUploadError('')
    setUploadMessage(`正在读取文件夹“${directoryHandle.name}”…`)
    try {
      releaseIdle = props.holdIdleLock('upload')
      const files = await enumerateDirectoryHandle(directoryHandle, controller.signal)
      if (!screenActive.current || controller.signal.aborted) return
      if (files.length === 0) throw new TypeError('此文件夹没有可上传的文件；浏览器不会提供空目录条目。')
      await handleFolder(files)
    } catch (cause) {
      if (!screenActive.current || controller.signal.aborted) return
      setUploadMessage('')
      setUploadError(cause instanceof Error ? cause.message : '无法读取所选文件夹。', cause)
    } finally {
      releaseIdle()
      taskControllers.current.delete(controller)
      if (screenActive.current) setUploading(false)
    }
  }
  const handleExternalDrop = async (dataTransfer: DataTransfer) => {
    if (!screenActive.current || activeView !== 'drive' || writeBlocked || uploading || folderLoading || routeUnavailable) return
    const controller = new AbortController()
    taskControllers.current.add(controller)
    let releaseIdle = () => {}
    setUploading(true)
    setUploadError('')
    setUploadMessage('正在检查拖入的文件和文件夹…')
    try {
      releaseIdle = props.holdIdleLock('upload')
      const selection = await readDroppedSelection(dataTransfer, controller.signal)
      if (!screenActive.current || controller.signal.aborted) return
      await handleFolder(selection.files, selection.kind === 'folder' ? 'folder' : 'files')
    } catch (cause) {
      if (!screenActive.current || controller.signal.aborted) return
      setUploadMessage('')
      setUploadError(cause instanceof Error ? cause.message : '无法读取拖入的文件或文件夹。', cause)
    } finally {
      releaseIdle()
      taskControllers.current.delete(controller)
      if (screenActive.current) setUploading(false)
    }
  }
  const recoverableTransfers: RecoverableTransfer[] = resumeRecords.map((record) => {
    const progress = resumeProgressById.get(record.id)
    return {
      record,
      uploadedBytes: progress?.uploadedBytes ?? 0,
      reservedBytes: progress?.reservedBytes ?? 0,
      state: progress?.state === 'expired' || record.expiresAt * 1000 <= now ? 'expired' : progress?.state ?? 'unknown',
    }
  })
  const resumeTransfer = (recordId: string) => {
    const record = resumeRecords.find((item) => item.id === recordId)
    if (!record) return
    setSelectedResume(record)
    if (resumeInput.current) { resumeInput.current.value = ''; resumeInput.current.click() }
  }
  const restartExpiredTransfer = (recordId: string) => {
    const record = resumeRecords.find((item) => item.id === recordId)
    if (!record) return
    setExpiredRestart(record)
    if (fileInput.current) { fileInput.current.value = ''; fileInput.current.click() }
  }
  const sortFromListHeader = (field: SortBy) => {
    if (sortBy === field) setDescending((current) => !current)
    else setSortBy(field)
  }
  const renderDriveListEntry = (entry: DriveEntry) => {
    const drop = dropFeedback?.entryId === entry.entryId ? dropFeedback : null
    const modified = formatEntryModifiedAt(entry.originalModifiedAt)
    const size = entry.kind === 'folder' ? '—' : formatBytes(entry.size ?? 0)
    const kind = entry.kind === 'folder' ? '文件夹' : entry.mime ?? '未知'
    return <div className={`entry-row drive-list-row${selectedEntryId === entry.entryId || batchIds.has(entry.entryId) ? ' is-selected' : ''}${drop ? ` is-drop-target is-drop-${drop.state}` : ''}`} role="listitem" draggable={!writeBlocked && !uploading && !folderLoading} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => enterFolderDrop(event, entry)} onDragLeave={event => leaveFolderDrop(event, entry)} onDrop={event => void dropIntoFolder(event, entry)} onDragEnd={clearMoveDrag} tabIndex={0} key={entry.entryId} onPointerDown={event => longPress.down(event, entry.entryId)} onPointerMove={longPress.move} onPointerUp={longPress.up} onPointerCancel={longPress.cancel} onClickCapture={event => selectionClick(event, entry)} onFocus={() => selection.focus(entry.entryId)} onKeyDown={event => handleRowKeyDown(event, entry)}>
      <input className="entry-select" type="checkbox" aria-label={`选择 ${entry.name}`} checked={batchIds.has(entry.entryId)} onChange={(event) => { selection.check({ entry, parentIndexId: directory.indexId, parentPath: directory.path }, event.target.checked) }} />
      <span className="entry-icon">{entry.kind === 'folder' ? <Folder size={18} /> : <File size={18} />}</span>
      {entry.kind === 'folder' ? <button aria-label={entry.name} title={entry.name} className="entry-name entry-name-button drive-list-name" onClick={() => void openFolder(entry)}>{entry.name}<span className="drive-list-mobile-meta">{size} · {modified}</span></button> : <button aria-label={entry.name} title={entry.name} className="entry-name entry-name-button drive-list-name" onClick={() => void handlePreview(entry)}>{entry.name}<span className="drive-list-mobile-meta">{size} · {modified}</span></button>}
      <span className="drive-list-modified" aria-label={`原始修改时间 ${modified}`}>{modified}</span>
      <span className="entry-kind drive-list-size">{size}</span>
      <span className="drive-list-mime" title={kind}>{kind}</span>
      <span className="entry-row-actions">
        {directory.path.length > 0 && <button type="button" className="entry-download" aria-label={`移动到上一级 ${entry.name}`} title="移动到上一级" disabled={writeBlocked} onClick={() => void handleMoveToParent(entry.entryId)}><CornerUpLeft size={15} /></button>}
        <button type="button" className="entry-download" aria-label={`移动 ${entry.name}`} title="移动" disabled={writeBlocked} onClick={() => setMovingSelections([{ entry, parentIndexId: directory.indexId, parentPath: directory.path }])}><MoveRight size={15} /></button>
        <button type="button" className="entry-download" aria-label={`重命名 ${entry.name}`} title="重命名" disabled={writeBlocked} onClick={() => void handleRename(entry.entryId)}><FilePenLine size={15} /></button>
        <button type="button" className="entry-download" aria-label={`移到回收站 ${entry.name}`} title="移到回收站" disabled={writeBlocked} onClick={() => void handleDelete(entry.entryId)}><Trash2 size={15} /></button>
        {entry.kind === 'file' && <button type="button" className="entry-download" aria-label={`下载 ${entry.name}`} title="下载" onClick={() => void handleDownload(entry)}><ArrowDownToLine size={16} /></button>}
        <button type="button" className="entry-download entry-download-more" aria-label={`更多操作 ${entry.name}`} title="更多操作" onClick={event => { actionsTrigger.current = event.currentTarget; setActionsEntry(entry) }}><MoreHorizontal size={18} /></button>
      </span>
      {drop && <span className="move-drop-label" aria-live="polite">{drop.message}</span>}
    </div>
  }
  return <main className={`drive-shell${activeView === 'drive' && zipSelections.size > 0 ? ' has-drive-selection' : ''}`}>
    <aside className="sidebar glass-chrome">
      <div className="sidebar-brand"><div className="brand-icon"><HardDrive size={18} /></div><strong>XDrive</strong></div>
      <nav aria-label="主导航"><button className={`nav-item${activeView === 'drive' ? ' is-current' : ''}`} onClick={() => { if (location.pathname !== '/drive') setActiveView('drive'); setActiveTrashRoot(null); setTrashDirectory(null) }}><HardDrive size={17} /> 我的文件</button><button className={`nav-item${activeView === 'trash' ? ' is-current' : ''}`} onClick={() => { setActiveView('trash'); selection.clear(); setActiveTrashRoot(null); setTrashDirectory(null) }}><Trash2 size={17} /> 回收站</button><button className={`nav-item${activeView === 'storage' ? ' is-current' : ''}`} onClick={() => { setActiveView('storage'); selection.clear() }}><HardDrive size={17} /> 存储空间</button><button className={`nav-item${activeView === 'settings' ? ' is-current' : ''}`} onClick={() => { setActiveView('settings'); selection.clear() }}><ShieldCheck size={17} /> 设置</button></nav>
      <div className="sidebar-bottom"><div className="privacy-status"><span className="status-dot" /> 已解锁 <span className="privacy-caption">本地密钥</span></div>{usage && <div className="storage-meter"><div><span>存储空间</span><span>{formatBytes(usage.usedBytes)} / {formatBytes(usage.quotaBytes)}</span></div><progress max={usage.quotaBytes} value={Math.min(usage.quotaBytes, usage.usedBytes + usage.reservedBytes)} aria-label="已使用存储空间" /><small>回收站 {formatBytes(usage.trashBytes)}</small></div>}</div>
    </aside>
    <section className="drive-main"
      onDragEnter={event => {
        const types = event.dataTransfer.types
        if (!types.includes('Files') || types.includes('application/x-xdrive-move')) return
        event.preventDefault()
        if (activeView === 'drive' && !writeBlocked && !uploading && !folderLoading) setExternalDropActive(true)
      }}
      onDragOver={event => {
        const types = event.dataTransfer.types
        if (!types.includes('Files') || types.includes('application/x-xdrive-move')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = activeView === 'drive' && !writeBlocked && !uploading && !folderLoading ? 'copy' : 'none'
      }}
      onDragLeave={event => {
        const target = event.relatedTarget
        if (!(target instanceof Node) || !event.currentTarget.contains(target)) setExternalDropActive(false)
      }}
      onDrop={event => {
        const types = event.dataTransfer.types
        if (!types.includes('Files') || types.includes('application/x-xdrive-move')) return
        event.preventDefault()
        setExternalDropActive(false)
        if (event.target instanceof Element && event.target.closest('dialog')) return
        if (activeView === 'drive' && !writeBlocked && !uploading && !folderLoading) void handleExternalDrop(event.dataTransfer)
      }}
      onKeyDownCapture={event => {
      const target = event.target as HTMLElement
      if (target.closest('dialog')) return
      if (activeView === 'drive' && event.key === 'Delete' && !event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !target.matches('input:not([type=checkbox]), textarea, select') && !target.isContentEditable && !target.closest('dialog')) { event.preventDefault(); requestDeleteSelection(); return }
      if (activeView === 'drive' && event.key === 'Escape' && !target.matches('input, textarea, select') && !target.isContentEditable) { selection.clear(); return }
      if (activeView !== 'drive' || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'a') return
      if (target.matches('input:not([type="checkbox"]), textarea, select') || target.isContentEditable) return
      event.preventDefault(); event.stopPropagation(); selectAll()
    }}>
      {externalDropActive && activeView === 'drive' && <div className="folder-drop-overlay" role="status" aria-live="polite">放开以加密上传文件或文件夹</div>}
      {writerState !== 'locks' && <div className="form-notice" role="status">{writerState === 'fallback-writer' ? '此浏览器不支持标签页锁：当前标签页负责写入，其他标签页只读。' : writerState === 'unavailable' ? '无法验证标签页写入登记，已暂停修改。请检查浏览器本地存储权限。' : '此标签页只读。请先关闭其他 XDrive 标签页；若上次写入标签页异常退出，可重新接管。'}{writerState === 'fallback-reader' && <button className="quiet-button" type="button" onClick={() => { if (window.confirm('请确认其他 XDrive 标签页已关闭。接管后，旧标签页将失去写入权限。')) void browserMutations.prepare(props.vault.rootIndexId, true).catch(() => undefined) }}>关闭其他标签页后接管写入</button>}</div>}
      <header className="drive-toolbar glass-chrome">
        <div className={`toolbar-path${activeView === 'drive' ? '' : ' breadcrumbs'}`}>{activeView === 'settings' ? <span>设置</span> : activeView === 'storage' ? <span>存储空间</span> : activeView === 'drive' ? <Breadcrumbs count={folderLoading ? undefined : entries.length} items={[{ id: props.vault.rootIndexId, name: "我的文件", onSelect: () => void navigateTo(-1) }, ...directory.path.map((crumb, index) => ({ id: directory.path[index + 1]?.indexId ?? directory.indexId, name: crumb.name, onSelect: () => void navigateTo(index + 1) }))]} /> : <Breadcrumbs label="回收站路径" count={activeTrashRoot && trashDirectory && !folderLoading ? trashDirectory.entries.length : undefined} items={[{ id: 'trash-root', name: '回收站', onSelect: resetTrashPath }, ...(activeTrashRoot ? [{ id: activeTrashRoot.item.childIndexId ?? activeTrashRoot.tombstoneId, name: activeTrashRoot.item.name, onSelect: () => void openTrashFolder(activeTrashRoot) }, ...(trashDirectory?.path ?? []).map((crumb, index) => ({ id: trashDirectory?.path[index + 1]?.indexId ?? trashDirectory!.indexId, name: crumb.name, onSelect: () => void readTrashDirectory(activeTrashRoot, trashDirectory!.path[index + 1]?.indexId ?? trashDirectory!.indexId, trashDirectory!.path.slice(0, index + 1)) }))] : [])]} />}</div>
        <div className="toolbar-actions">{activeView === 'drive' ? <><button className="toolbar-button" onClick={() => void handleCreateFolder()} disabled={writeBlocked || uploading || folderLoading}><FolderPlus size={16} /> 新建文件夹</button><button className="toolbar-button" onClick={() => void handleDownloadFolderZip()} disabled={uploading || folderLoading || !!zipController || entries.length === 0}><Archive size={16} /> 下载为 ZIP</button><button className="toolbar-button" onClick={selectFolder} disabled={writeBlocked || uploading || folderLoading}><Folder size={16} /> 上传文件夹</button><button className="toolbar-button" onClick={selectFile} disabled={writeBlocked || uploading || folderLoading}><ArrowUpFromLine size={16} /> 上传</button></> : activeView === 'trash' && activeTrashRoot && <><button className="toolbar-button" disabled={writeBlocked || clearingTrash || uploading} onClick={() => void handleRestore(activeTrashRoot)}><RotateCcw size={16} /> 恢复</button><button className="toolbar-button is-danger" disabled={writeBlocked || clearingTrash || uploading} onClick={() => void handlePurge(activeTrashRoot)}><Trash2 size={16} /> 永久删除</button></>}{activeView !== 'settings' && <button className="toolbar-button" onClick={() => setChangePasswordOpen(true)} disabled={writeBlocked || uploading}><ShieldCheck size={16} /> 修改密码</button>}<button className="icon-button" aria-label="锁定云盘" onClick={lockAndCancel}><LockKeyhole size={17} /></button><button className="icon-button" aria-label="退出登录" onClick={logoutAndCancel}><LogOut size={17} /></button></div>
      {activeView === 'drive' && <div className="view-controls" role="group" aria-label="视图与排序"><button type="button" aria-label="网格视图" aria-pressed={view === 'grid'} onClick={() => setPreferences({ view: 'grid' })}><LayoutGrid size={16} /></button><button type="button" aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => setPreferences({ view: 'list' })}><List size={16} /></button><button type="button" disabled={entries.length === 0} onClick={selectAll}>全选当前文件夹</button><label htmlFor="sort-by">排序</label><select id="sort-by" aria-label="排序字段" value={sortBy} onChange={event => setSortBy(event.target.value as SortBy)}><option value="name">名称</option><option value="modified">原始修改时间</option><option value="size">大小</option><option value="type">文件类型</option></select><button type="button" aria-label={descending ? '切换为升序' : '切换为降序'} onClick={() => setDescending(value => !value)}>{descending ? '降序 ↓' : '升序 ↑'}</button></div>}
      </header>
      <input ref={fileInput} type="file" hidden multiple onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; const restart = expiredRestart; setExpiredRestart(null); if (restart) void handleRestartExpiredUpload(restart, files[0]); else if (files.length > 1) void handleFolder(files, 'files'); else void handleFile(files[0]) }} />
      <input ref={resumeInput} type="file" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void handleResume(file) }} />
      <input ref={folderInput} type="file" hidden multiple onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (files.length === 0) { setUploadMessage(''); setUploadError('浏览器没有返回可上传的文件；空文件夹不会上传。'); return }; void handleFolder(files) }} />
      {usage && <BackupNotice usage={usage} now={now} browserDays={backupReminderDays} />}
      {(uploadMessage || uploadError || routeError) && <div className={uploadError || routeError ? 'upload-status is-error' : 'upload-status'} role={uploadError || routeError ? 'alert' : 'status'}>
        {uploadMessage && <span>{uploadMessage}{uploadProgress.total > 0 && ` · ${Math.round(uploadProgress.complete / uploadProgress.total * 100)}%`}</span>}
        {uploadError && <span>{uploadError}<RequestIdControl requestId={uploadRequestId} /></span>}
        {routeError && <span>{routeError}<RequestIdControl requestId={routeRequestId} /></span>}
        {zipController && <button type="button" onClick={() => zipController.abort()}>取消 ZIP 下载</button>}
        {activeView === 'drive' && (uploadError || routeError) && <button type="button" onClick={() => setRouteAttempt(attempt => attempt + 1)}>重新读取目录</button>}
        {quotaBlocked && <button type="button" onClick={() => { setActiveView('trash'); setActiveTrashRoot(null); setTrashDirectory(null) }}>前往回收站清理</button>}
      </div>}
      {activeView === 'settings' ? <Suspense fallback={<p role="status">正在载入设置…</p>}><SettingsScreen now={now} revision={props.vault.vaultMutationRevision} onChangePassword={() => setChangePasswordOpen(true)} passwordDisabled={writeBlocked || uploading} /></Suspense> : activeView === 'storage' ? <StorageScreen now={now} revision={props.vault.vaultMutationRevision} formatBytes={formatBytes} onClearTrash={requestClearTrash} clearDisabled={writeBlocked || uploading || clearingTrash || props.vault.trashEntries.length === 0} onTrash={() => { setActiveView('trash'); setActiveTrashRoot(null); setTrashDirectory(null) }} /> : activeView === 'drive' ? <>
        <div className="content-heading"><div><p className="eyebrow">已解锁空间</p><h1>{folderLoading ? '正在读取文件夹…' : directory.path.at(-1)?.name ?? '我的文件'}</h1></div><p className="item-count">{entries.length} 项</p></div>

        {folderLoading ? <p role={uploadMessage && !uploadError ? undefined : 'status'} aria-live="polite">正在读取文件夹…</p> : <>{activeView === 'drive' && zipSelections.size > 0 && <div className="batch-actions drive-batch-actions" role="toolbar" aria-label="批量操作"><span>已选 {zipSelections.size} 项</span><button type="button" disabled={uploading || folderLoading || !!zipController} onClick={() => void handleDownloadFolderZip(true)}>下载所选为 ZIP</button><button type="button" disabled={writeBlocked || uploading || folderLoading} onClick={() => setMovingSelections([...zipSelections.values()])}>批量移动</button><button type="button" disabled={writeBlocked || uploading || folderLoading} onClick={requestDeleteSelection}>移到回收站所选</button><button type="button" onClick={() => { selection.clear() }}>取消选择</button></div>}{entries.length === 0 ? <div className="empty-state"><div className="empty-icon"><Folder size={26} /></div><h2>{folderLoading ? '正在读取文件夹…' : '这里还没有文件'}</h2><p>文件在浏览器中加密后才会上传到服务器。</p><button className="primary-button" onClick={selectFile} disabled={writeBlocked || uploading || folderLoading}><ArrowUpFromLine size={16} /> 上传文件</button></div> : view === 'grid' ? <VirtualEntryGrid key={directory.indexId} entries={entries} itemKey={entry => entry.entryId} renderEntry={entry => {
          const parts = entry.kind === 'file' ? splitFileExtension(entry.name) : { stem: entry.name, extension: '' }
          const drop = dropFeedback?.entryId === entry.entryId ? dropFeedback : null
          return <div className={`entry-card${batchIds.has(entry.entryId) ? ' is-selected' : ''}${drop ? ` is-drop-target is-drop-${drop.state}` : ''}`} role="listitem" draggable={!writeBlocked && !uploading && !folderLoading} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => enterFolderDrop(event, entry)} onDragLeave={event => leaveFolderDrop(event, entry)} onDrop={event => void dropIntoFolder(event, entry)} onDragEnd={clearMoveDrag} onPointerDown={event => longPress.down(event, entry.entryId)} onPointerMove={longPress.move} onPointerUp={longPress.up} onPointerCancel={longPress.cancel} onClickCapture={event => selectionClick(event, entry)} onFocus={() => selection.focus(entry.entryId)} onKeyDown={event => handleRowKeyDown(event, entry)} onContextMenu={event => { event.preventDefault(); if (!longPress.touchContext(entry.entryId)) { actionsTrigger.current = event.currentTarget; setActionsEntry(entry) } }}>
            <button type="button" className="entry-card-media" aria-label={`打开 ${entry.name}`} onClick={() => { if (entry.kind === 'folder') void openFolder(entry); else void handlePreview(entry) }}>{entry.kind === 'folder' ? <Folder size={48} /> : entry.thumbnail && entry.fileId ? <ThumbnailImage cache={thumbnailCache} fileId={entry.fileId} thumbnail={entry.thumbnail} /> : <File size={42} />}</button>
            <label className="entry-card-selection"><input className="entry-select" type="checkbox" aria-label={`选择 ${entry.name}`} checked={batchIds.has(entry.entryId)} onChange={event => { selection.check({ entry, parentIndexId: directory.indexId, parentPath: directory.path }, event.target.checked) }} /></label>
            <button className="entry-card-more" aria-label={`更多操作 ${entry.name}`} onClick={event => { actionsTrigger.current = event.currentTarget; setActionsEntry(entry) }}><MoreHorizontal size={18} /></button>
            <button className="entry-card-name" aria-label={entry.name} title={entry.name} onClick={() => { if (entry.kind === 'folder') void openFolder(entry); else void handlePreview(entry) }}><span>{parts.stem}</span><span>{parts.extension}</span></button>
            <span className="entry-card-kind">{entry.kind === 'folder' ? '文件夹' : formatBytes(entry.size ?? 0)}</span>
            {drop && <span className="move-drop-label" aria-live="polite">{drop.message}</span>}
          </div>
        }} /> : <><DriveListHeader sortBy={sortBy} descending={descending} onSort={sortFromListHeader} /><VirtualEntryList key={directory.indexId} entries={entries} itemKey={(entry) => entry.entryId} renderEntry={renderDriveListEntry} /></>}</>}
      </> : <TrashView vault={props.vault} writeBlocked={writeBlocked} root={activeTrashRoot} directory={trashDirectory} loading={folderLoading} onClear={requestClearTrash} selected={trashSelected} onSelected={setTrashSelected} onRestoreSelected={() => void restoreRoots([...trashSelected])} onPurgeSelected={requestSelectedPurge} clearing={clearingTrash || uploading} onOpenRoot={(item) => void openTrashFolder(item)} onOpenFolder={(entry) => void openTrashChildFolder(entry)} onPreview={(entry) => void handlePreview(entry)} onDownload={(entry) => void handleDownload(entry)} onRestore={(item) => void handleRestore(item)} onPurge={(item) => void handlePurge(item)} />}
    </section>
    {actionsEntry && <EntryActionsDialog entry={actionsEntry} parent={directory.path.length > 0} writeBlocked={writeBlocked || uploading} returnFocus={actionsTrigger} onClose={() => setActionsEntry(null)} onAction={(action: EntryAction) => {
      const entry = actionsEntry; setActionsEntry(null)
      if (action === 'rename') void handleRename(entry.entryId)
      if (action === 'trash') void handleDelete(entry.entryId)
      if (action === 'parent') void handleMoveToParent(entry.entryId)
      if (action === 'move') setMovingSelections([{ entry, parentIndexId: directory.indexId, parentPath: directory.path }])
      if (action === 'download') void handleDownload(entry)
    }} />}
    {clearTrashIds && <ClearTrashDialog selected={clearTrashMode === 'selected'} count={clearTrashIds.length} onConfirm={() => void handleClearTrash()} onCancel={closeClearTrash} />}
    {preview && <PreviewDialog preview={preview} vault={props.vault} holdIdleLock={props.holdIdleLock} onClose={closePreview} onDownload={() => void handleDownload(preview.entry)} />}
    {changePasswordOpen && <ChangePasswordDialog vault={props.vault} onClose={() => setChangePasswordOpen(false)} onChanged={(updated) => { props.onVaultUpdate(updated); setChangePasswordOpen(false); setUploadMessage('密码已修改。其他设备上的登录已失效。') }} />}
    {deleteSelections && <DeleteSelectionDialog count={deleteSelections.length} onCancel={closeDeleteSelection} onConfirm={() => void handleDeleteSelection()} />}
    {movingSelections.length > 0 && <MoveDialog vault={props.vault} selections={movingSelections} entries={movingSelections.map((item) => item.entry)} onClose={() => setMovingSelections([])} onMove={handleMoveToTarget} />}
    {pendingUploadConflict && <UploadConflictDialog existing={pendingUploadConflict.existing} file={pendingUploadConflict.file} destinationLabel={['我的文件', ...pendingUploadConflict.destination.path.map(part => part.name)].join(' / ')} usage={usage} onClose={() => setPendingUploadConflict(null)} onSkip={() => { setPendingUploadConflict(null); setUploadMessage('已跳过同名文件。'); setUploadError('') }} onKeepBoth={() => {
      try {
        const { file, destination } = pendingUploadConflict
        const targetName = uniqueUploadName(file.name.normalize('NFC'), destination.entries)
        setPendingUploadConflict(null)
        void handleFile(file, { targetName }, destination)
      } catch (cause) { setUploadError(cause instanceof Error ? cause.message : '无法生成唯一文件名。', cause) }
    }} onOverwrite={() => {
      const { file, existing, destination } = pendingUploadConflict
      setPendingUploadConflict(null)
      void handleFile(file, { replaceEntryId: existing.entryId, expectedReplacementIdentity: conflictIdentity(existing) }, destination)
    }} />}
    {pendingRestoreConflict && <RestoreConflictDialog message={pendingRestoreConflict.message} count={pendingRestoreConflict.ids.length} onClose={() => setPendingRestoreConflict(null)} onKeepBoth={() => void restoreRoots(pendingRestoreConflict.ids, 'keep-both')} />}
    {pendingFolderConflict && <FolderConflictDialog kind={pendingFolderConflict.kind} destinationLabel={pendingFolderConflict.destinationLabel} conflicts={pendingFolderConflict.conflicts} availableBytes={usage?.availableBytes ?? null} trashBytes={usage?.trashBytes ?? null} formatBytes={formatBytes} onConfirm={pendingFolderConflict.confirm} onCancel={pendingFolderConflict.cancel} />}
    <TransferPanel
      key={recoverableTransfers.length > 0 ? 'has-recoverable-uploads' : 'no-recoverable-uploads'}
      active={transferTasks}
      recoverable={recoverableTransfers}
      now={now}
      disabled={writeBlocked || uploading}
      onCancel={cancelTransfer}
      onResume={resumeTransfer}
      onRestart={restartExpiredTransfer}
      onAbandon={(recordId) => { const record = resumeRecords.find((item) => item.id === recordId); if (record) void handleAbandonResume(record) }}
      reservedBytes={usage?.uploadReservedBytes ?? usage?.reservedBytes ?? 0}
    />
  </main>
}

function uniqueUploadName(name: string, entries: readonly DriveEntry[]): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  const existing = new Set(entries.map((entry) => entry.name.normalize('NFC')))
  for (let number = 1; number <= 5000; number += 1) {
    const candidate = `${base} (${number})${extension}`
    if (!existing.has(candidate)) return candidate
  }
  throw new TypeError('无法为同名文件生成唯一名称，请先清理目标文件夹。')
}

function UploadConflictDialog(props: { file: File; existing: DriveEntry; destinationLabel: string; usage: StorageUsage | null; onClose: () => void; onSkip: () => void; onKeepBoth: () => void; onOverwrite: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal() }, [])
  return <dialog ref={dialog} className="move-dialog conflict-dialog" aria-label="同名文件冲突" onClose={props.onClose} onCancel={(event) => { event.preventDefault(); props.onClose() }}>
    <header><div><span className="eyebrow">上传冲突</span><h2>上传目标已有“{props.file.name}”</h2></div><button className="icon-button" aria-label="关闭冲突对话框" onClick={props.onClose}>×</button></header>
    <p>上传位置：{props.destinationLabel}</p>
    <p>现有项目：{props.existing.kind === 'file' ? `文件 · ${formatBytes(props.existing.size ?? 0)}` : '文件夹'}。请选择如何处理本次上传。</p>
    <p>覆盖会在新文件完整上传并提交后，将旧项目移入回收站；同名文件夹及全部后代一起移入。所需空间按新文件的完整密文体积计算。</p>
    {props.usage && <p>可用 {formatBytes(props.usage.availableBytes)} · 回收站占用 {formatBytes(props.usage.trashBytes)}</p>}
    <footer><button className="quiet-button" onClick={props.onSkip}>跳过</button><button className="quiet-button" onClick={props.onKeepBoth}>保留两者</button><button className="primary-button" onClick={props.onOverwrite}>覆盖并移入回收站</button></footer>
  </dialog>
}

function RestoreConflictDialog(props: { message: string; count: number; onClose: () => void; onKeepBoth: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (dialog.current && !dialog.current.open) dialog.current.showModal()
    dialog.current?.querySelector<HTMLElement>('[data-restore-cancel]')?.focus()
    return () => { if (previous?.isConnected && !previous.matches(':disabled')) previous.focus() }
  }, [])
  return <dialog ref={dialog} className="move-dialog conflict-dialog" aria-label="恢复名称冲突" onKeyDown={(event) => {
    if (event.key !== 'Tab') return
    const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')].filter((button) => !button.disabled)
    // WebKit may skip native button stops; cycle each enabled modal control.
    event.preventDefault()
    const current = controls.findIndex((button) => button === document.activeElement)
    const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
    controls[next]?.focus()
  }} onClose={props.onClose} onCancel={(event) => { event.preventDefault(); props.onClose() }}>
    <header><div><span className="eyebrow">恢复冲突</span><h2>恢复 {props.count} 项时遇到同名项目</h2></div><button className="icon-button" aria-label="关闭恢复冲突对话框" onClick={props.onClose}>×</button></header>
    <p>{props.message} 本次尚未恢复任何项目。现有项目会保留；选择“保留两者”后，使用带序号的名称原子恢复整个确认集合。</p>
    <footer><button className="quiet-button" data-restore-cancel onClick={props.onClose}>取消恢复</button><button className="primary-button" onClick={props.onKeepBoth}>保留两者并恢复</button></footer>
  </dialog>
}

function TrashView(props: {
  vault: UnlockedVault
  writeBlocked: boolean
  root: TrashRootEntry | null
  directory: DirectoryState | null
  loading: boolean
  onClear: (trigger: HTMLButtonElement) => void
  selected: ReadonlySet<string>
  onSelected: (selected: ReadonlySet<string>) => void
  onRestoreSelected: () => void
  onPurgeSelected: (trigger: HTMLButtonElement) => void
  clearing: boolean
  onOpenRoot: (item: TrashRootEntry) => void
  onOpenFolder: (entry: DriveEntry) => void
  onPreview: (entry: DriveEntry) => void
  onDownload: (entry: DriveEntry) => void
  onRestore: (item: TrashRootEntry) => void
  onPurge: (item: TrashRootEntry) => void
}) {
  const [retention, setRetention] = useState('正在读取保留期…')
  useEffect(() => {
    const controller = new AbortController()
    void fetchTrashRetentionLabel(controller.signal).then(label => { if (!controller.signal.aborted) setRetention(label) }).catch(() => { if (!controller.signal.aborted) setRetention('保留期读取失败；项目按服务器策略自动清理。') })
    return () => controller.abort()
  }, [])
  if (!props.root) return <>
    <div className="content-heading"><div><p className="eyebrow">{retention}</p><h1>回收站</h1></div><div><p className="item-count">{props.vault.trashEntries.length} 项</p>{props.vault.trashEntries.length > 0 && <button className="quiet-button is-danger clear-trash-action" type="button" disabled={props.writeBlocked || props.clearing} onClick={event => props.onClear(event.currentTarget)}>清空回收站</button>}</div></div>
    {props.vault.trashEntries.length > 0 && <div className="batch-actions trash-batch-actions" role="toolbar" aria-label="回收站批量操作"><span>已选 {props.selected.size} 个顶层项目</span><button className="quiet-button" type="button" disabled={props.writeBlocked || props.clearing} onClick={() => props.onSelected(new Set(props.vault.trashEntries.map((item) => item.tombstoneId)))}>全选顶层项目</button><button className="quiet-button" type="button" disabled={props.writeBlocked || props.clearing || !props.selected.size} onClick={props.onRestoreSelected}>恢复所选</button><button className="quiet-button is-danger" type="button" disabled={props.writeBlocked || props.clearing || !props.selected.size} onClick={event => props.onPurgeSelected(event.currentTarget)}>永久删除所选</button><button className="quiet-button" type="button" disabled={props.clearing || !props.selected.size} onClick={() => props.onSelected(new Set())}>取消回收站选择</button></div>}
    {props.vault.trashEntries.length === 0 ? <div className="empty-state"><div className="empty-icon"><Trash2 size={26} /></div><h2>回收站为空</h2><p>移入回收站的项目按服务器保留期自动清理，清理前可以恢复。</p></div> : <VirtualEntryList key={"trash-roots"} entries={props.vault.trashEntries} itemKey={(item) => item.tombstoneId} renderEntry={(item) => <div className="entry-row trash-root-row" role="listitem" key={item.tombstoneId}><label className="trash-choice"><input className="entry-select" type="checkbox" aria-label={`选择回收站 ${item.item.name}`} checked={props.selected.has(item.tombstoneId)} disabled={props.writeBlocked || props.clearing} onChange={(event) => { const next = new Set(props.selected); if (event.target.checked) next.add(item.tombstoneId); else next.delete(item.tombstoneId); props.onSelected(next) }} /></label><span className="entry-icon">{item.item.kind === 'folder' ? <Folder size={18} /> : <File size={18} />}</span>{item.item.kind === 'folder' ? <button className="entry-name entry-name-button" onClick={() => props.onOpenRoot(item)}>{item.item.name}</button> : <button className="entry-name entry-name-button" onClick={() => props.onPreview(item.item)}>{item.item.name}</button>}<span className="entry-kind">{item.item.kind === 'folder' ? '文件夹' : formatBytes(item.item.size ?? 0)}</span><button className="entry-download" aria-label={`恢复 ${item.item.name}`} disabled={props.writeBlocked || props.clearing} title="恢复" onClick={() => props.onRestore(item)}><RotateCcw size={16} /></button><button className="entry-download is-danger" aria-label={`永久删除 ${item.item.name}`} disabled={props.writeBlocked || props.clearing} title="永久删除" onClick={() => props.onPurge(item)}><Trash2 size={16} /></button>{item.item.kind === 'file' && <button className="entry-download" aria-label={`下载 ${item.item.name}`} onClick={() => props.onDownload(item.item)}><ArrowDownToLine size={16} /></button>}</div>} />}
  </>
  const rows = [...(props.directory?.entries ?? [])].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  return <>
    <div className="content-heading"><div><p className="eyebrow">回收站中的文件夹</p><h1>{props.directory?.path.at(-1)?.name ?? props.root.item.name}</h1></div><p className="item-count">{rows.length} 项</p></div>
    {props.loading ? <div className="empty-state"><h2>正在读取…</h2></div> : rows.length === 0 ? <div className="empty-state"><div className="empty-icon"><Folder size={26} /></div><h2>此文件夹为空</h2><p>恢复或永久删除只能对回收站中的顶层项目执行。</p></div> : <VirtualEntryList key={props.directory?.indexId ?? props.root.tombstoneId} entries={rows} itemKey={(entry) => entry.entryId} renderEntry={(entry) => <div className="entry-row" role="listitem" key={entry.entryId}><span className="entry-icon">{entry.kind === 'folder' ? <Folder size={18} /> : <File size={18} />}</span>{entry.kind === 'folder' ? <button className="entry-name entry-name-button" onClick={() => props.onOpenFolder(entry)}>{entry.name}</button> : <button className="entry-name entry-name-button" onClick={() => props.onPreview(entry)}>{entry.name}</button>}<span className="entry-kind">{entry.kind === 'folder' ? '文件夹' : formatBytes(entry.size ?? 0)}</span>{entry.kind === 'file' && <button className="entry-download" aria-label={`下载 ${entry.name}`} onClick={() => props.onDownload(entry)}><ArrowDownToLine size={16} /></button>}</div>} />}
  </>
}

function PreviewDialog(props: { preview: PreviewState; vault: UnlockedVault; holdIdleLock: (kind: IdleLockTask) => () => void; onClose: () => void; onDownload: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])
  return <dialog ref={dialog} className="preview-dialog" aria-label={`预览 ${props.preview.entry.name}`} onClose={props.onClose} onCancel={(event) => { event.preventDefault(); props.onClose() }}>
    <header><strong>{props.preview.entry.name}</strong><button className="quiet-button" onClick={props.onDownload}>下载原文件</button><button className="icon-button" aria-label="关闭预览" onClick={props.onClose}>×</button></header>
    {props.preview.kind === 'text' && <pre className="preview-text">{props.preview.text}</pre>}
    {props.preview.kind === 'markdown' && <Suspense fallback={<p role="status">正在加载 Markdown 预览…</p>}><MarkdownPreview source={props.preview.text ?? ''} /></Suspense>}
    {props.preview.kind === 'code' && <Suspense fallback={<p role="status">正在加载代码预览…</p>}><CodePreview key={props.preview.entry.entryId} source={props.preview.text ?? ''} name={props.preview.entry.name} mime={props.preview.entry.mime ?? ''} /></Suspense>}
    {props.preview.kind === 'image' && props.preview.url && <img className="preview-image" src={props.preview.url} alt={props.preview.entry.name} />}
    {props.preview.kind === 'video' && <VideoPreview key={props.preview.entry.entryId} vault={props.vault} entry={props.preview.entry} holdIdleLock={props.holdIdleLock} />}
    {props.preview.kind === 'pdf' && <PDFPreview vault={props.vault} entry={props.preview.entry} />}
  </dialog>
}

function VideoPreview(props: { vault: UnlockedVault; entry: DriveEntry; holdIdleLock: (kind: IdleLockTask) => () => void }) {
  const [source, setSource] = useState('')
  const [error, setError, errorRequestId] = useErrorNotice()
  const [retry, setRetry] = useState(0)
  const video = useRef<HTMLVideoElement>(null)
  const playbackHold = useRef<(() => void) | null>(null)
  const cancelPendingVideoReads = useRef<() => void>(() => {})
  const stopPlaying = () => { playbackHold.current?.(); playbackHold.current = null }
  const resumePlaying = () => {
    const element = video.current
    if (element && !element.paused && !element.ended && !element.seeking && element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !playbackHold.current) {
      try { playbackHold.current = props.holdIdleLock('video') } catch { element.pause() }
    }
  }
  useEffect(() => {
    const element = video.current
    return () => { element?.pause(); element?.removeAttribute('src'); element?.load(); playbackHold.current?.(); playbackHold.current = null }
  }, [source])

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let rangeSession: import('./media/video-range').VideoRangeSession | undefined
    let blobURL = ''
    void (async () => {
      try {
        const module = await import('./media/video-range')
        if (!module.supportsVideoRange()) throw new TypeError('当前浏览器或设备暂不支持有界流式视频播放。')
        rangeSession = await module.createVideoRangeSession(props.vault, props.entry, controller.signal)
        if (disposed) { rangeSession.close(); return }
        cancelPendingVideoReads.current = rangeSession.cancelPendingReads
        setSource(rangeSession.url)
      } catch (rangeError) {
        if (disposed) return
        try {
          const limit = await fetchVideoBlobFallbackLimit(controller.signal)
          if (disposed) return
          if (!Number.isSafeInteger(props.entry.size) || props.entry.size === undefined || props.entry.size < 0) throw new TypeError('视频目录项不完整，请下载后播放。')
          if (props.entry.size > limit) {
            setError(`当前浏览器无法建立流式播放会话；此视频超过 ${formatBytes(limit)} 内存播放上限，请下载后播放。`, rangeError)
            return
          }
          const blob = await downloadFile(props.vault, props.entry, controller.signal)
          if (!blob || disposed) return
          blobURL = URL.createObjectURL(blob)
          setSource(blobURL)
        } catch (cause) {
          if (!disposed) setError(cause instanceof TypeError ? cause.message : '无法打开此视频，请下载后播放。', cause)
        }
      }
    })()
    return () => {
      disposed = true
      controller.abort()
      cancelPendingVideoReads.current = () => {}
      rangeSession?.close()
      if (blobURL) URL.revokeObjectURL(blobURL)
    }
  }, [props.vault, props.entry, retry, setError])

  return <div className="video-preview-area">
    {source && <video ref={video} className="preview-video" src={source} controls playsInline onPlaying={resumePlaying} onSeeked={resumePlaying} onPause={stopPlaying} onEnded={stopPlaying} onWaiting={stopPlaying} onSeeking={() => { stopPlaying(); if ((video.current?.currentTime ?? 0) > 0) cancelPendingVideoReads.current() }} onError={() => { stopPlaying(); setError('浏览器无法播放此编码，或播放会话已中断。') }} />}
    {!source && !error && <p role="status">正在建立本地解密播放会话…</p>}
    {error && <div className="preview-fallback" role="alert"><p>{error}<RequestIdControl requestId={errorRequestId} /></p><button type="button" onClick={() => { setSource(''); setError(''); setRetry((value) => value + 1) }}>重试播放</button></div>}
  </div>
}

function PDFPreview(props: { vault: UnlockedVault; entry: DriveEntry }) {
  const vaultKey = props.vault.vaultKey
  const dataKey = props.vault.dataKey
  const entry = props.entry
  const canvas = useRef<HTMLCanvasElement>(null)
  const [documentProxy, setDocumentProxy] = useState<import('pdfjs-dist/types/src/display/api.js').PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [scale, setScale] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [pageInput, setPageInput] = useState<string | null>(null)
  const [renderedPage, setRenderedPage] = useState<{ number: number; scale: number } | null>(null)
  const [error, setError, errorRequestId] = useErrorNotice()

  const goToPage = (target: number) => { setPageNumber(target); setPageInput(null) }
  const renderedCurrentPage = renderedPage?.number === pageNumber && renderedPage.scale === scale ? pageNumber : null

  useEffect(() => {
    let disposed = false
    let loadingTask: import('pdfjs-dist/types/src/display/api.js').PDFDocumentLoadingTask | undefined
    let rangeReader: Awaited<ReturnType<typeof createEncryptedRangeReader>> | undefined
    let rangeQueue: ReturnType<typeof createPDFRangeQueue> | undefined
    const controller = new AbortController()
    void createEncryptedRangeReader({ vaultKey, dataKey }, entry, controller.signal).then(async (reader) => {
      rangeReader = reader
      if (disposed) { reader.destroy(); return }
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      if (disposed) { reader.destroy(); return }
      const { default: workerURL } = await import('virtual:xdrive-pdf-worker')
      if (disposed) { reader.destroy(); return }
      pdfjs.GlobalWorkerOptions.workerSrc = workerURL
      const transport = new pdfjs.PDFDataRangeTransport(reader.length, null)
      rangeQueue = createPDFRangeQueue(reader, (begin, data) => transport.onDataRange(begin, data), (cause) => {
        if (!disposed) { setError('PDF 数据读取失败，请下载文件后查看。', cause); void loadingTask?.destroy() }
      })
      transport.requestDataRange = (begin, end) => rangeQueue?.request(begin, end)
      transport.abort = () => rangeQueue?.close()
      loadingTask = pdfjs.getDocument({ range: transport, disableStream: true, disableAutoFetch: true })
      return loadingTask.promise.then((document) => {
        if (disposed) { void loadingTask?.destroy(); return }
        setDocumentProxy(document)
        setPageCount(document.numPages)
        setPageNumber(1)
      })
    }).catch((cause) => {
      rangeQueue?.close()
      void loadingTask?.destroy()
      if (!disposed) setError((current) => current || 'PDF 无法打开，文件可能损坏或需要当前预览不支持的解析方式。请下载原文件后查看。', cause)
    })
    return () => {
      disposed = true
      controller.abort()
      rangeQueue?.close()
      rangeReader?.destroy()
      setDocumentProxy(null)
      if (loadingTask) void loadingTask.destroy()
    }
  }, [vaultKey, dataKey, entry, setError])

  useEffect(() => {
    if (!documentProxy || !canvas.current) return
    let cancelled = false
    let renderTask: ReturnType<import('pdfjs-dist/types/src/display/api.js').PDFPageProxy['render']> | undefined
    void documentProxy.getPage(pageNumber).then((page) => {
      if (cancelled || !canvas.current) { page.cleanup(); return }
      const naturalViewport = page.getViewport({ scale: 1 })
      const maxCanvasPixels = 16_000_000
      const boundedScale = Math.min(scale, Math.sqrt(maxCanvasPixels / Math.max(1, naturalViewport.width * naturalViewport.height)))
      const viewport = page.getViewport({ scale: boundedScale })
      const context = canvas.current.getContext('2d')
      if (!context) throw new TypeError('Canvas 2D is unavailable')
      canvas.current.width = Math.ceil(viewport.width)
      canvas.current.height = Math.ceil(viewport.height)
      renderTask = page.render({ canvas: canvas.current, canvasContext: context, viewport })
      return renderTask.promise.then(() => { if (!cancelled) setRenderedPage({ number: pageNumber, scale }) }).finally(() => { page.cleanup() })
    }).catch((cause) => {
      if (!cancelled) setError('PDF 页面渲染失败。', cause)
    })
    return () => { cancelled = true; renderTask?.cancel() }
  }, [documentProxy, pageNumber, scale, setError])

  return <section className="pdf-preview" aria-label="PDF 预览">
    <div className="pdf-controls"><button type="button" onClick={() => goToPage(Math.max(1, pageNumber - 1))} disabled={pageNumber <= 1}>上一页</button><form onSubmit={(event) => {
      event.preventDefault()
      const draft = pageInput ?? String(pageNumber)
      const target = Number(draft)
      if (/^[0-9]+$/u.test(draft) && Number.isSafeInteger(target) && target >= 1 && target <= pageCount) { setError(''); goToPage(target) }
      else setPageInput(null)
    }}><input aria-label="PDF 页码" type="text" inputMode="numeric" pattern="[0-9]+" value={pageInput ?? String(pageNumber)} disabled={!pageCount} onChange={(event) => setPageInput(event.target.value)} /><span> / {pageCount || '…'}</span><button type="submit" disabled={!pageCount}>跳转</button></form><button type="button" onClick={() => goToPage(Math.min(pageCount, pageNumber + 1))} disabled={pageNumber >= pageCount}>下一页</button><button type="button" onClick={() => setScale((value) => Math.max(0.5, value - 0.25))} aria-label="缩小 PDF">−</button><button type="button" onClick={() => setScale((value) => Math.min(2, value + 0.25))} aria-label="放大 PDF">+</button></div>
    {error ? <p role="alert">{error}<RequestIdControl requestId={errorRequestId} /></p> : <div className="pdf-page"><canvas ref={canvas} data-rendered-page={renderedCurrentPage ?? ''} aria-label={renderedCurrentPage ? `PDF 第 ${renderedCurrentPage} 页` : 'PDF 正在渲染'} /></div>}
  </section>
}

function MoveDialog(props: {
  vault: UnlockedVault
  selections: readonly ZipSelection[]
  entries: readonly DriveEntry[]
  onClose: () => void
  onMove: (target: DirectoryState) => Promise<boolean>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [target, setTarget] = useState<DirectoryState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError, errorRequestId] = useErrorNotice()
  const forbiddenFolderIds = props.entries.flatMap((entry) => entry.kind === 'folder' && entry.childIndexId ? [entry.childIndexId] : [])
  const targetIsForbidden = Boolean(target && (props.selections.every((selection) => selection.parentIndexId === target.indexId) ||
    forbiddenFolderIds.some((id) => target.indexId === id || target.path.some((part) => part.indexId === id))))

  const targetRead = useRef<AbortController | null>(null)
  const readTarget = useCallback(async (id: string, path: DirectoryState['path']) => {
    targetRead.current?.abort()
    const controller = new AbortController()
    targetRead.current = controller
    setLoading(true); setError('')
    try {
      const loaded = await loadDirectory(props.vault, id, path, controller.signal)
      if (!controller.signal.aborted && targetRead.current === controller) setTarget(loaded)
    } catch (cause) {
      if (!controller.signal.aborted && targetRead.current === controller) setError('无法读取目标文件夹。', cause)
    } finally {
      if (!controller.signal.aborted && targetRead.current === controller) { targetRead.current = null; setLoading(false) }
    }
  }, [props.vault, setError])
  useLayoutEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
    void readTarget(props.vault.rootIndexId, [])
    return () => { targetRead.current?.abort(); targetRead.current = null }
  }, [props.vault.rootIndexId, readTarget])

  const openFolder = async (entry: DriveEntry) => {
    if (!target || entry.kind !== 'folder' || !entry.childIndexId) return
    if (forbiddenFolderIds.some(id => entry.childIndexId === id || target.path.some(part => part.indexId === id))) return
    await readTarget(entry.childIndexId, [...target.path, { indexId: target.indexId, name: entry.name }])
  }
  const navigateTo = async (depth: number) => {
    if (!target) return
    await readTarget(depth < 0 ? props.vault.rootIndexId : target.path[depth]!.indexId, depth < 0 ? [] : target.path.slice(0, depth))
  }

  const moveHere = async () => {
    if (!target || targetIsForbidden) return
    setBusy(true)
    setError('')
    const succeeded = await props.onMove(target)
    setBusy(false)
    if (succeeded) props.onClose()
    else setError('移动未完成。请检查冲突或刷新目录后重试。')
  }

  const description = props.entries.length === 1 ? `“${props.entries[0]!.name}”` : `${props.entries.length} 个项目`
  return <dialog ref={dialog} className="move-dialog" aria-label={props.entries.length === 1 ? `移动 ${props.entries[0]!.name}` : `移动 ${description}`} onClose={() => { if (!busy) props.onClose() }} onCancel={(event) => { event.preventDefault(); if (!busy) props.onClose() }}>
    <header><div><span className="eyebrow">选择目标位置</span><h2>移动{description}</h2></div><button className="icon-button" aria-label="关闭移动对话框" disabled={busy} onClick={props.onClose}>×</button></header>
    <div className="move-breadcrumbs"><Breadcrumbs label="目标文件夹路径" count={loading ? undefined : target?.entries.length} items={[{ id: props.vault.rootIndexId, name: '我的文件', onSelect: () => void navigateTo(-1) }, ...(target?.path ?? []).map((part, index) => ({ id: target?.path[index + 1]?.indexId ?? target!.indexId, name: part.name, onSelect: () => void navigateTo(index + 1) }))]} /></div>
    {error && <p role="alert" className="form-error">{error}<RequestIdControl requestId={errorRequestId} /></p>}
    {loading ? <p className="move-loading">正在读取文件夹…</p> : (target?.entries ?? []).some((entry) => entry.kind === 'folder') ? <VirtualEntryList key={target?.indexId} className="move-folder-list" label="目标文件夹列表" entries={(target?.entries ?? []).filter((entry) => entry.kind === 'folder')} itemKey={(entry) => entry.entryId} renderEntry={(entry) => <div className="entry-row" role="listitem"><button className="move-folder-option" onClick={() => void openFolder(entry)}><Folder size={16} /> {entry.name}</button></div>} /> : <div className="move-folder-list"><p>此位置没有子文件夹。</p></div>}
    <footer><button className="quiet-button" disabled={busy} onClick={props.onClose}>取消</button><button className="primary-button" disabled={!target || targetIsForbidden || busy || loading} onClick={() => void moveHere()}>{busy ? '正在移动…' : targetIsForbidden ? '不能移动到此处' : '移动到此文件夹'}</button></footer>
  </dialog>
}

function ChangePasswordDialog(props: { vault: UnlockedVault; onClose: () => void; onChanged: (vault: UnlockedVault) => void }) {
  const authAttempt = useAuthAttempt()
  const dialog = useRef<HTMLDialogElement>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError, errorRequestId] = useErrorNotice()
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const attempt = authAttempt.begin()
    setError('')
    try {
      assertPasswordLength(newPassword)
      if (newPassword !== confirmation) throw new TypeError('两次输入的新密码不一致。')
      setBusy(true)
      const updated = await changePassword(props.vault, currentPassword, newPassword, attempt.signal)
      if (authAttempt.owns(attempt)) props.onChanged(updated)
    } catch (cause) {
      if (!authAttempt.owns(attempt)) return
      if (cause instanceof APIError && cause.code === 'invalid_credentials') setError('当前密码不正确。', cause)
      else if (cause instanceof APIError && cause.code === 'vault_config_conflict') setError('Vault 配置已变化，请重新登录后再修改密码。', cause)
      else setError(cause instanceof Error ? cause.message : '修改密码失败。', cause)
    } finally {
      if (authAttempt.owns(attempt)) { setBusy(false); setCurrentPassword(''); setNewPassword(''); setConfirmation('') }
      authAttempt.finish(attempt)
    }
  }
  return <dialog ref={dialog} className="move-dialog password-dialog" aria-label="修改密码" onClose={props.onClose} onCancel={(event) => { if (busy) event.preventDefault(); else props.onClose() }}>
    <header><div><span className="eyebrow">安全设置</span><h2>修改密码</h2></div><button className="icon-button" type="button" aria-label="关闭修改密码对话框" disabled={busy} onClick={props.onClose}>×</button></header>
    <form onSubmit={(event) => void submit(event)}>
      <div className="password-dialog-fields">
        <label className="field-label" htmlFor="current-password">当前密码</label><input id="current-password" type="password" autoComplete="current-password" spellCheck={false} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required autoFocus />
        <label className="field-label" htmlFor="new-password">新密码</label><input id="new-password" type="password" autoComplete="new-password" spellCheck={false} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
        <label className="field-label" htmlFor="confirm-new-password">确认新密码</label><input id="confirm-new-password" type="password" autoComplete="new-password" spellCheck={false} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
        <p>修改密码不会更换主密钥。若旧密码和旧服务器快照同时泄露，旧快照仍可能被解开。</p>
        {error && <p role="alert" className="form-error">{error}<RequestIdControl requestId={errorRequestId} /></p>}
      </div>
      <footer><button className="quiet-button" type="button" disabled={busy} onClick={props.onClose}>取消</button><button className="primary-button" type="submit" disabled={busy}>{busy ? '正在本地派生密钥…' : '确认修改密码'}</button></footer>
    </form>
  </dialog>
}

function ServiceUnavailable(props: { message: string; requestId?: string; onRetry: () => void }) {
  return <main className="boot-screen"><div className="brand-icon"><HardDrive size={20} /></div><h1>XDrive</h1><p role="alert">{props.message}<RequestIdControl requestId={props.requestId} /></p><button className="primary-button" onClick={props.onRetry}>重新连接</button></main>
}

function describeSetupError(error: unknown): string {
  if (error instanceof APIError) {
    if (error.code === 'setup_conflict') return '首次设置发生冲突，尚未完成。请重新载入页面查看当前状态；若仍显示未初始化，可重新提交。持续失败时请联系管理员并提供请求编号。'
    if (error.code === 'storage_unavailable' || error.code === 'disk_space_low') return '首次设置数据暂时无法写入，设置未完成。请联系管理员检查服务器存储后重试。'
    if (error.code === 'quota_exceeded') return '初始化索引所需空间不足，设置未完成。请联系管理员检查配额和维护预留后重试。'
    return error.message
  }
  return error instanceof Error ? error.message : '首次设置未完成，请重试。'
}

function describeLoginError(error: unknown): string {
  if (error instanceof APIError && error.code === 'invalid_credentials') return '用户名或密码不正确。'
  if (error instanceof APIError && error.code === 'invalid_session') return '会话已失效，请重新登录。'
  if (error instanceof DOMException && error.name === 'OperationError') return '认证成功，但加密配置无法解锁。请检查备份或恢复状态。'
  return '无法解锁云盘。请检查连接和密码后重试。'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = -1
  do { value /= 1024; index += 1 } while (value >= 1024 && index < units.length - 1)
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`
}

export default App

function describePurgeError(error: unknown): string {
  if (error instanceof APIError) {
    if (error.code === 'quota_exceeded') return '清理释放的空间不足以保存回收站索引。原项目仍保留；请清空更多项目，或取消其他未完成上传后重试。'
    if (error.code === 'disk_space_low' || error.code === 'storage_unavailable') return '服务器磁盘空间不足或不可用。原项目仍保留，请检查服务器磁盘后重试。'
    if (error.code === 'maintenance_in_progress') return '另一项清理维护尚未结束。请稍后重试；本次没有删除项目。'
  }
  return error instanceof Error ? error.message : '永久删除失败。'
}
