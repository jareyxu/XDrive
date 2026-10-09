import { RequestIdControl } from './RequestIdControl'
import { useErrorNotice } from './use-error-notice'
import { useEffect, useState } from 'react'
import { fetchStorageUsage, fetchSystemInfo, type StorageUsage, type SystemInfo } from '../api/client'
import { effectiveBackupReminderDays, backupIsOverdue, setPreferences, usePreferences } from '../preferences/preferences'
import styles from './SettingsScreen.module.css'

export function SettingsScreen(props: { now: number; revision: number; onChangePassword: () => void; passwordDisabled: boolean }) {
  const preferences = usePreferences()
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [error, setError, errorRequestId] = useErrorNotice()
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(true)
  useEffect(() => {
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
  }, [props.revision, refresh, setError])
  const reminderDays = usage ? effectiveBackupReminderDays(usage.backupWarnAfterDays, preferences.backupReminderDays) : null
  const expired = usage && backupIsOverdue(usage.lastBackupAt, props.now, reminderDays!)
  return <section className={styles.page} aria-label="云盘设置">
    <div className="content-heading"><div><p className="eyebrow">此浏览器与账号</p><h1>设置</h1></div></div>
    {!preferences.persistenceAvailable && <p className="form-notice" role="status">浏览器不允许保存偏好。当前设置仍会生效，但刷新后可能恢复默认值。</p>}
    <section className={styles.group} aria-labelledby="appearance-title"><h2 id="appearance-title">外观</h2>
      <div className={styles.row}><span id="theme-label">外观模式</span><div className={styles.segment} role="group" aria-labelledby="theme-label">{([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={preferences.theme === value} onClick={() => setPreferences({ theme: value })}>{label}</button>)}</div></div>
      <div className={`${styles.row} ${styles.stacked}`}><label htmlFor="glass-clarity">玻璃通透度 · {Math.round(preferences.clarity * 100)}%</label><input id="glass-clarity" type="range" min="0" max="1" step="0.05" value={preferences.clarity} onChange={event => setPreferences({ clarity: Number(event.target.value) })} /><div className={styles.ends}><span>着色</span><span>清透</span></div><div className={styles.preview} aria-label="通透度实时预览"><span className="glass-chrome"><strong className={styles.previewLabel}>XDrive · 实时预览</strong></span></div></div>
      <div className={styles.row}><label htmlFor="reduce-transparency">降低透明度<small>使用不透明背景，提升可读性。系统要求降低透明度时始终启用。</small></label><input id="reduce-transparency" className={styles.toggle} type="checkbox" checked={preferences.reduceTransparency} onChange={event => setPreferences({ reduceTransparency: event.target.checked })} /></div>
      <div className={styles.row}><label htmlFor="file-view">默认视图</label><select id="file-view" value={preferences.view} onChange={event => setPreferences({ view: event.target.value as 'grid' | 'list' })}><option value="grid">网格</option><option value="list">列表</option></select></div>
    </section>
    <section className={styles.group} aria-labelledby="transfer-title"><h2 id="transfer-title">传输</h2><div className={styles.row}><label htmlFor="upload-concurrency">上传分块并发</label><select id="upload-concurrency" value={preferences.uploadConcurrency} onChange={event => setPreferences({ uploadConcurrency: Number(event.target.value) as 2 | 3 | 4 })}>{[2, 3, 4].map(count => <option key={count} value={count}>{count} 个分块</option>)}</select></div><p className={styles.help}>从下一次文件上传或续传开始生效。并发越高，浏览器与服务器资源占用越多；默认 2 个分块。</p></section>
    <section className={styles.group} aria-labelledby="security-title"><h2 id="security-title">安全</h2><div className={styles.row}><div>修改密码<small>修改密码不会更换主密钥。忘记密码无法恢复数据。</small></div><button className="toolbar-button" type="button" disabled={props.passwordDisabled} onClick={props.onChangePassword}>修改密码</button></div><p className={styles.help}>无操作 10 分钟后自动锁定；实际上传、下载和视频播放期间按任务状态延后锁定。</p></section>
    <section className={styles.group} aria-labelledby="backup-title"><h2 id="backup-title">备份</h2><div className={styles.row}><label htmlFor="backup-reminder">备份提醒阈值</label><select id="backup-reminder" value={preferences.backupReminderDays} onChange={event => setPreferences({ backupReminderDays: Number(event.target.value) })}>{[7, 30, 90, ...([7, 30, 90].includes(preferences.backupReminderDays) ? [] : [preferences.backupReminderDays])].map(days => <option key={days} value={days}>{days} 天</option>)}</select></div><p className={styles.help}>{busy ? '正在读取备份状态…' : usage ? usage.lastBackupAt === null ? '从未备份。' : <>上次备份：<time dateTime={new Date(usage.lastBackupAt).toISOString()}>{new Date(usage.lastBackupAt).toLocaleString('zh-CN')}</time></> : '备份状态不可用。'}</p>{!busy && expired && <p className={styles.warning}>请将云盘备份到外部存储；{usage?.lastBackupAt === null ? '尚无已完成的备份。' : `上次备份已超过 ${reminderDays} 天。`}</p>}<p className={styles.help}>浏览器阈值保存在此浏览器；实际提醒采用它与服务器阈值中较短的天数。{usage && `服务器阈值 ${usage.backupWarnAfterDays} 天，实际阈值 ${reminderDays} 天。`}不会自动创建备份。备份和恢复请使用服务器上的管理命令。</p></section>
    <section className={styles.group} aria-labelledby="about-title"><h2 id="about-title">关于</h2><dl className={styles.about}><div><dt>应用版本</dt><dd>{info ? info.version === 'dev' ? 'dev（开发构建）' : info.version : busy ? '正在读取…' : '不可用'}</dd></div><div><dt>构建提交</dt><dd>{info?.commit || (busy ? '正在读取…' : '不可用')}</dd></div><div><dt>加密数据格式</dt><dd>{info ? `V${info.encryptedFormatVersion}` : busy ? '正在读取…' : '不可用'}</dd></div></dl></section>
    {error && <div role="alert" className="form-error">{error}<RequestIdControl requestId={errorRequestId} /><button type="button" className="quiet-button" onClick={() => setRefresh(value => value + 1)}>重新读取</button></div>}
  </section>
}
