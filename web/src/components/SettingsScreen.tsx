import { RequestIdControl } from './RequestIdControl'
import { useErrorNotice } from './use-error-notice'
import { useEffect, useState, type ReactNode } from 'react'
import { Palette, ArrowUpDown, HardDrive, ShieldCheck, Archive, RefreshCw, Info } from 'lucide-react'
import { fetchStorageUsage, fetchSystemInfo, fetchSystemUpdateInfo, fetchSystemUpdateStatus, prepareBackupDownload, startSystemUpdate, type StorageUsage, type SystemInfo, type SystemUpdateInfo, type SystemUpdateStatus } from '../api/client'
import { APIError } from '../api/api-error'
import { effectiveBackupReminderDays, backupIsOverdue, setPreferences, usePreferences } from '../preferences/preferences'
import styles from './SettingsScreen.module.css'

export function SettingsScreen(props: { now: number; revision: number; onChangePassword: () => void; passwordDisabled: boolean; active?: boolean; onUpdateNotice?: (message: string, isError: boolean) => void; storageContent?: ReactNode; category?: string; onCategoryChange?: (category: string) => void }) {
  const onUpdateNotice = props.onUpdateNotice
  const preferences = usePreferences()
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [error, setError, errorRequestId] = useErrorNotice()
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(true)
  const [updateInfo, setUpdateInfo] = useState<SystemUpdateInfo | null>(null)
  const [updateStatus, setUpdateStatus] = useState<SystemUpdateStatus | null>(null)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [confirmUpdate, setConfirmUpdate] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const [confirmBackup, setConfirmBackup] = useState(false)
  const [startingBackup, setStartingBackup] = useState(false)
  const [backupMessage, setBackupMessage] = useState('')
  const [backupError, setBackupError] = useState('')
  const [backupErrorRequestId, setBackupErrorRequestId] = useState<string | undefined>()
  const [localCategory, setLocalCategory] = useState('appearance')
  const activeCategory = props.category ?? localCategory
  const setActiveCategory = props.onCategoryChange ?? setLocalCategory
  useEffect(() => {
    if (props.active === false) return
    const controller = new AbortController()
    let live = true
    queueMicrotask(() => {
      if (!live) return
      setBusy(true); setError('')
      void Promise.allSettled([fetchStorageUsage(controller.signal), fetchSystemInfo(controller.signal)]).then(results => {
        if (!live || controller.signal.aborted) return
        const [storage, build] = results
        if (storage.status === 'fulfilled') setUsage(storage.value)
        if (build.status === 'fulfilled') setInfo(build.value)
        const failure = results.find(result => result.status === 'rejected')
        if (failure?.status === 'rejected') setError('无法更新备份或版本信息；已显示的信息为上次读取的结果。请重试。', failure.reason)
        setBusy(false)
      })
    })
    return () => { live = false; controller.abort() }
  }, [props.active, props.revision, refresh, setError])
  useEffect(() => {
    const requestId = updateStatus?.id
    if (!requestId || updateStatus.state === 'succeeded' || updateStatus.state === 'failed') return
    const controller = new AbortController()
    let timer = 0
    let attempts = 0
    const poll = async () => {
      try {
        const status = await fetchSystemUpdateStatus(requestId, controller.signal)
        if (controller.signal.aborted) return
        setUpdateStatus(status)
        if (status.state === 'succeeded') {
          onUpdateNotice?.('更新完成。刷新页面后载入新版本。', false)
          setConfirmUpdate(false)
          void Promise.all([fetchSystemInfo(), fetchSystemUpdateInfo()]).then(([build, release]) => { setInfo(build); setUpdateInfo(release) }).catch(() => undefined)
          return
        }
        if (status.state === 'failed') { onUpdateNotice?.('更新失败。请查看服务器更新服务日志。', true); return }
      } catch {
        if (controller.signal.aborted) return
        attempts += 1
        if (attempts > 120) {
          setUpdateError('更新状态暂时无法读取。请检查服务器上的 xdrive-web-update.service 日志。')
          onUpdateNotice?.('更新状态暂时无法读取，请检查服务器更新服务日志。', true)
          return
        }
      }
      timer = window.setTimeout(() => void poll(), 1800)
    }
    void poll()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [updateStatus?.id, updateStatus?.state, onUpdateNotice])
  const reminderDays = usage ? effectiveBackupReminderDays(usage.backupWarnAfterDays, preferences.backupReminderDays) : null
  const expired = usage && backupIsOverdue(usage.lastBackupAt, props.now, reminderDays!)
  const checkForUpdates = async () => {
    setCheckingUpdates(true)
    setUpdateError('')
    setConfirmUpdate(false)
    try {
      setUpdateInfo(await fetchSystemUpdateInfo(AbortSignal.timeout(25000)))
    } catch (cause) {
      setUpdateError(cause instanceof APIError ? cause.message : '无法连接 GitHub 获取正式版信息。请确认服务器网络正常后重试。')
    } finally {
      setCheckingUpdates(false)
    }
  }
  const beginUpdate = async () => {
    if (!updateInfo?.updateAvailable || !updateInfo.canInstall) return
    setUpdateError('')
    setConfirmUpdate(false)
    try {
      const status = await startSystemUpdate(updateInfo.latestVersion, AbortSignal.timeout(15000))
      setUpdateStatus(status)
      onUpdateNotice?.('已请求安装更新，服务器正在准备更新任务。', false)
    } catch (cause) {
      setUpdateError(cause instanceof APIError ? cause.message : '无法启动更新。请重新检查版本，或查看服务器服务日志。')
      onUpdateNotice?.('无法启动更新。请重新检查版本，或查看服务器服务日志。', true)
    }
  }
  const beginBackup = async () => {
    setStartingBackup(true)
    setBackupError('')
    setBackupErrorRequestId(undefined)
    setBackupMessage('')
    try {
      await prepareBackupDownload(AbortSignal.timeout(15000))
      setConfirmBackup(false)
      setBackupMessage('下载已启动。请在浏览器下载列表确认文件完整，并将备份保存到 VPS 之外。')
      window.location.assign('/api/v1/backups/download')
    } catch (reason) {
      if (reason instanceof APIError) {
        setBackupError(reason.message)
        setBackupErrorRequestId(reason.requestId)
      } else {
        setBackupError('无法启动备份下载。请检查网络并重新登录后重试。')
      }
    } finally {
      setStartingBackup(false)
    }
  }
  const updateStateText = (state: SystemUpdateStatus['state']) => ({ queued: '已排队，等待服务器启动更新任务…', checking: '正在确认正式版信息…', downloading: '正在下载并校验发布包…', installing: '正在安装。XDrive 服务会短暂重启…', succeeded: '更新完成，请刷新页面载入新版界面。', failed: '更新没有完成。' })[state]
  const updateFailureText = (code?: string) => ({ release_check_failed: '服务器无法连接 GitHub；没有更改已安装文件。', release_changed: '正式版在检查后发生变化，请重新检查再试。', version_not_newer: '所选版本已不比当前版本新。', unsupported_architecture: '此服务器架构暂不支持网页更新。', checksum_unavailable: '无法读取正式版校验文件；没有安装该版本。', release_invalid: '正式版信息无效；更新已停止。', upgrade_failed: '更新失败。请查看 xdrive-web-update.service 日志，确认服务恢复状态。' } as Record<string, string>)[code ?? ''] ?? '更新失败；请检查服务器更新服务日志。'
  return <section className={styles.page} aria-label="云盘设置">
    <h1 className="sr-only">设置</h1>
    {!preferences.persistenceAvailable && <p className="form-notice" role="status">浏览器不允许保存偏好。当前设置仍会生效，但刷新后可能恢复默认值。</p>}
    <div className={styles.settingsLayout}>
    <nav className={styles.categoryNav} aria-label="设置分类">
      {([['appearance', '外观', Palette], ['transfer', '传输', ArrowUpDown], ['storage', '存储空间', HardDrive], ['security', '安全', ShieldCheck], ['backup', '备份', Archive], ['updates', '软件更新', RefreshCw], ['about', '关于', Info]] as const).map(([id, label, Icon]) => <button key={id} type="button" aria-current={activeCategory === id ? 'location' : undefined} onClick={() => setActiveCategory(id)}><Icon size={17} />{label}</button>)}
    </nav>
    <div className={styles.settingsGroups}>
    <div hidden={activeCategory !== 'storage'} className={styles.storagePanel}>{activeCategory === 'storage' && props.active !== false && props.storageContent}</div>
    <section className={styles.group} hidden={activeCategory !== 'appearance'} aria-labelledby="appearance-title"><h2 id="appearance-title">外观</h2>
      <div className={styles.row}><span id="theme-label">外观模式</span><div className={styles.segment} role="group" aria-labelledby="theme-label">{([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={preferences.theme === value} onClick={() => setPreferences({ theme: value })}>{label}</button>)}</div></div>
      <div className={`${styles.row} ${styles.stacked}`}><label htmlFor="glass-clarity">玻璃通透度 · {Math.round(preferences.clarity * 100)}%</label><input id="glass-clarity" type="range" min="0" max="1" step="0.05" value={preferences.clarity} onChange={event => setPreferences({ clarity: Number(event.target.value) })} /><div className={styles.ends}><span>着色</span><span>清透</span></div><div className={styles.preview} aria-label="通透度实时预览"><span className="glass-chrome"><strong className={styles.previewLabel}>XDrive · 实时预览</strong></span></div></div>
      <div className={styles.row}><label htmlFor="reduce-transparency">降低透明度<small>使用不透明背景，提升可读性。系统要求降低透明度时始终启用。</small></label><span className={styles.switchControl}><input id="reduce-transparency" className={styles.toggle} role="switch" type="checkbox" checked={preferences.reduceTransparency} onChange={event => setPreferences({ reduceTransparency: event.target.checked })} /><span className={styles.switchTrack} aria-hidden="true" /></span></div>
      <div className={styles.row}><label htmlFor="file-view">默认视图</label><select id="file-view" value={preferences.view} onChange={event => setPreferences({ view: event.target.value as 'grid' | 'list' })}><option value="grid">网格</option><option value="list">列表</option></select></div>
    </section>
    <section className={styles.group} hidden={activeCategory !== 'transfer'} aria-labelledby="transfer-title"><h2 id="transfer-title">传输</h2><div className={styles.row}><label htmlFor="upload-concurrency">上传分块并发</label><select id="upload-concurrency" value={preferences.uploadConcurrency} onChange={event => setPreferences({ uploadConcurrency: Number(event.target.value) as 2 | 3 | 4 })}>{[2, 3, 4].map(count => <option key={count} value={count}>{count} 个分块</option>)}</select></div><p className={styles.help}>从下一次文件上传或续传开始生效。并发越高，浏览器与服务器资源占用越多；默认 2 个分块。</p></section>
    <section className={styles.group} hidden={activeCategory !== 'security'} aria-labelledby="security-title"><h2 id="security-title">安全</h2><div className={styles.row}><div>修改密码<small>修改密码不会更换主密钥。忘记密码无法恢复数据。</small></div><button className="toolbar-button" type="button" disabled={props.passwordDisabled} onClick={props.onChangePassword}>修改密码</button></div><p className={styles.help}>无操作 10 分钟后自动锁定；实际上传、下载和视频播放期间按任务状态延后锁定。</p></section>
    <section className={styles.group} hidden={activeCategory !== 'backup'} aria-labelledby="backup-title"><h2 id="backup-title">备份</h2>
      <div className={styles.row}><label htmlFor="backup-reminder">备份提醒阈值</label><select id="backup-reminder" value={preferences.backupReminderDays} onChange={event => setPreferences({ backupReminderDays: Number(event.target.value) })}>{[7, 30, 90, ...([7, 30, 90].includes(preferences.backupReminderDays) ? [] : [preferences.backupReminderDays])].map(days => <option key={days} value={days}>{days} 天</option>)}</select></div>
      <p className={styles.help}>{busy ? '正在读取备份状态…' : usage ? usage.lastBackupAt === null ? '从未备份。' : <>上次完成备份：<time dateTime={new Date(usage.lastBackupAt).toISOString()}>{new Date(usage.lastBackupAt).toLocaleString('zh-CN')}</time></> : '备份状态不可用。'}</p>
      {!busy && expired && <p className={styles.warning}>请将云盘备份到外部存储；{usage?.lastBackupAt === null ? '尚无已完成的备份。' : `上次备份已超过 ${reminderDays} 天。`}</p>}
      <div className={styles.row}><div>创建完整备份<small>生成与服务器恢复命令兼容的备份文件，并由浏览器直接下载。</small></div><button className="toolbar-button" type="button" disabled={startingBackup} onClick={() => { setBackupMessage(''); setBackupError(''); setConfirmBackup(true) }}>{startingBackup ? '正在准备…' : '创建并下载备份'}</button></div>
      {confirmBackup && <div className={styles.updateConfirm} role="group" aria-label="确认创建备份"><p>备份包含账户数据库和加密文件对象。请通过 HTTPS 下载，并将文件保存在 VPS 以外的受控位置。下载中断会生成不完整文件，不能用于恢复。</p><button className="toolbar-button" type="button" disabled={startingBackup} onClick={() => void beginBackup()}>{startingBackup ? '正在准备…' : '确认并下载'}</button><button className="quiet-button" type="button" disabled={startingBackup} onClick={() => setConfirmBackup(false)}>取消</button></div>}
      <p className={styles.help}>浏览器阈值保存在此浏览器；实际提醒采用它与服务器阈值中较短的天数。{usage && `服务器阈值 ${usage.backupWarnAfterDays} 天，实际阈值 ${reminderDays} 天。`}下载会流式生成，不在 VPS 保存第二份完整对象副本；完成后刷新本页查看备份时间。备份文件不会额外使用密码加密，请按敏感文件保护。</p>
      {backupMessage && <p className={styles.updateMessage} role="status" aria-live="polite">{backupMessage}</p>}{backupError && <div role="alert" className="form-error">{backupError}<RequestIdControl requestId={backupErrorRequestId} /></div>}
    </section>
    <section className={styles.group} hidden={activeCategory !== 'updates'} aria-labelledby="updates-title"><h2 id="updates-title">软件更新</h2>
      <div className={styles.row}><div>正式版<small>仅检查 XDrive GitHub 上的正式稳定版；更新由服务器上的 root 管理服务执行。</small></div><button type="button" className="toolbar-button" onClick={() => void checkForUpdates()} disabled={checkingUpdates || (updateStatus !== null && updateStatus.state !== 'succeeded' && updateStatus.state !== 'failed')}>{checkingUpdates ? '正在检查…' : '检查更新'}</button></div>
      {updateInfo && <><dl className={styles.about}><div><dt>当前版本</dt><dd>{updateInfo.currentVersion}</dd></div><div><dt>最新正式版</dt><dd><a href={updateInfo.releaseUrl} target="_blank" rel="noreferrer">{updateInfo.latestVersion}</a>{updateInfo.publishedAt && <small> · 发布于 {new Date(updateInfo.publishedAt).toLocaleDateString('zh-CN')}</small>}</dd></div></dl>
        {!updateInfo.updateAvailable && <p className={styles.updateMessage} role="status">当前已是最新正式版。</p>}
        {updateInfo.updateAvailable && !updateInfo.canInstall && <p className={styles.warning}>发现新版本，但此服务器尚未启用网页更新管理服务。部署新版本后，以 root 运行 <code>xdrive enable-web-updates</code> 完成一次性启用。</p>}
        {updateInfo.updateAvailable && updateInfo.canInstall && !confirmUpdate && <div className={styles.updateActions}><p className={styles.help}>更新会短暂重启服务。云盘文件和账号数据不会因更新而删除。</p><button type="button" className="toolbar-button" onClick={() => setConfirmUpdate(true)} disabled={updateStatus !== null && updateStatus.state !== 'succeeded' && updateStatus.state !== 'failed'}>安装 {updateInfo.latestVersion}</button></div>}
        {confirmUpdate && <div className={styles.updateConfirm} role="group" aria-label="确认安装更新"><p>确认从官方 GitHub 发布页安装 {updateInfo.latestVersion}？服务会短暂不可用。</p><button type="button" className="toolbar-button" onClick={() => void beginUpdate()}>确认更新</button><button type="button" className="quiet-button" onClick={() => setConfirmUpdate(false)}>取消</button></div>}
        {updateInfo.releaseNotes && <details className={styles.releaseDetails}><summary>查看版本说明</summary><pre>{updateInfo.releaseNotes}</pre></details>}
      </>}
      {updateStatus && <p className={styles.updateMessage} role="status" aria-live="polite">{updateStateText(updateStatus.state)}{updateStatus.state === 'failed' && ` ${updateFailureText(updateStatus.errorCode)}`}</p>}
      {updateError && <p className="form-error" role="alert">{updateError}</p>}
    </section>
    <section className={styles.group} hidden={activeCategory !== 'about'} aria-labelledby="about-title"><h2 id="about-title">关于</h2><dl className={styles.about}><div><dt>应用版本</dt><dd>{info ? info.version === 'dev' ? 'dev（开发构建）' : info.version : busy ? '正在读取…' : '不可用'}</dd></div><div><dt>构建提交</dt><dd>{info?.commit || (busy ? '正在读取…' : '不可用')}</dd></div><div><dt>加密数据格式</dt><dd>{info ? `V${info.encryptedFormatVersion}` : busy ? '正在读取…' : '不可用'}</dd></div></dl></section>
    </div>
    </div>
    {error && <div role="alert" className="form-error">{error}<RequestIdControl requestId={errorRequestId} /><button type="button" className="quiet-button" onClick={() => setRefresh(value => value + 1)}>重新读取</button></div>}
  </section>
}
