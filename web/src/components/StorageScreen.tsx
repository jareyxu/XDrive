import { RequestIdControl } from './RequestIdControl'
import { APIError } from '../api/api-error'
import { useEffect } from 'react'
import { useStorageUsage } from '../queries/storage-usage'
import styles from './StorageScreen.module.css'
import { effectiveBackupReminderDays, backupIsOverdue, usePreferences } from '../preferences/preferences'

export function StorageScreen(props: { now: number; revision: number; formatBytes: (bytes: number) => string; onTrash: () => void; onClearTrash: (trigger: HTMLButtonElement) => void; clearDisabled: boolean }) {
  const { backupReminderDays } = usePreferences()
  const query = useStorageUsage(props.revision)
  const usage = query.data ?? null
  const cause = query.error
  const error = query.isError && !query.isFetching ? `无法更新存储用量：${cause instanceof Error ? cause.message : '请稍后重试'}${usage ? '。下方为上次读取的用量。' : ''}` : ''
  const errorRequestId = cause instanceof APIError ? cause.requestId : undefined
  const refresh = query.refetch
  const busy = query.isFetching || query.isPending
  // Entering this view refreshes counters even if the sidebar has cached them.
  // A concurrent revision read shares its request instead of restarting it.
  useEffect(() => {
    void refresh({ cancelRefetch: false })
  }, [refresh, props.revision])
  const bytes = props.formatBytes
  const reminderDays = usage ? effectiveBackupReminderDays(usage.backupWarnAfterDays, backupReminderDays) : null
  const expired = usage && backupIsOverdue(usage.lastBackupAt, props.now, reminderDays!)
  const files = usage ? Math.max(0, usage.usedBytes - usage.trashBytes) : 0
  const parts = usage ? [files, usage.trashBytes, usage.reservedBytes, usage.availableBytes] : []
  return <section className={styles.page} aria-label="存储空间详情" aria-busy={busy}>
    <div className="content-heading"><div><p className="eyebrow">容量与备份</p><h1>存储空间</h1></div><button className={`toolbar-button ${styles.action}`} type="button" disabled={busy} onClick={() => void refresh({ cancelRefetch: false })}>{busy ? '正在更新…' : '刷新用量'}</button></div>
    {error && <p className="form-error" role="alert">{error}<RequestIdControl requestId={errorRequestId} /></p>}
    {!usage && !error && <p role="status">正在读取存储用量…</p>}
    {usage && <>
      <section className={styles.card} aria-label="容量明细">
        <p className={styles.total}>{bytes(usage.usedBytes)} 已用，共 {bytes(usage.quotaBytes)}</p>
        <div className={styles.bar} role="meter" aria-label="已用和预留容量" aria-valuemin={0} aria-valuemax={usage.quotaBytes} aria-valuenow={Math.min(usage.quotaBytes, usage.usedBytes + usage.reservedBytes)} aria-valuetext={`已用 ${bytes(usage.usedBytes)}，预留 ${bytes(usage.reservedBytes)}，可用 ${bytes(usage.availableBytes)}`}>
          {parts.map((size, index) => <span key={index} className={[styles.files, styles.trash, styles.reserved, styles.free][index]} style={{ flexGrow: size / usage.quotaBytes }} />)}
        </div>
        <dl className={styles.stats}>
          <div><dt>文件（含未完成上传）</dt><dd>{bytes(files)}</dd></div>
          <div><dt>回收站</dt><dd>{bytes(usage.trashBytes)}</dd></div>
          <div><dt>预留上传</dt><dd>{bytes(usage.uploadReservedBytes ?? usage.reservedBytes)}</dd></div>
          <div><dt>元数据维护预留</dt><dd>{bytes(usage.maintenanceReservedBytes ?? 0)}</dd></div>
          <div><dt>可用</dt><dd>{bytes(usage.availableBytes)}</dd></div>
          <div><dt>其中未完成上传</dt><dd>{bytes(usage.pendingBytes)}</dd></div>
        </dl>
        <p className={styles.help}>未完成上传已包含在已用空间内。预留上传包含正在接收的数据，不另行重复计算。元数据维护预留已计入总预留，供空间不足时移到回收站使用，不能用于普通上传。永久清理会补回已使用的维护额度，因此新增可用容量可能少于回收站占用。</p>
        {usage.trashBytes > 0 && <><button className={`toolbar-button ${styles.action}`} type="button" onClick={props.onTrash}>前往回收站清理 · 占用 {bytes(usage.trashBytes)}</button><button className={`toolbar-button is-danger ${styles.action}`} type="button" disabled={props.clearDisabled} onClick={event => props.onClearTrash(event.currentTarget)}>清空回收站 · 占用 {bytes(usage.trashBytes)}</button></>}
      </section>
      <section className={`${styles.card}${expired ? ` ${styles.warning}` : ''}`} aria-label="备份状态">
        <h2>备份</h2>
        <p>{usage.lastBackupAt === null ? '从未备份。' : <>上次备份：<time dateTime={new Date(usage.lastBackupAt).toISOString()}>{new Date(usage.lastBackupAt).toLocaleString('zh-CN')}</time></>}</p>
        {expired && <p>请将云盘备份到外部存储；{usage.lastBackupAt === null ? '尚无已完成的备份。' : `上次备份已超过 ${reminderDays} 天。`}</p>}
        <p className={styles.help}>在服务器上运行 <code>xdrive backup &lt;目录&gt;</code> 创建备份。备份不能找回遗忘的密码。</p>
      </section>
      <p className={styles.help}>服务器文件系统剩余空间：{bytes(usage.freeDiskBytes)}。这是物理磁盘余量，不增加云盘配额。</p>
    </>}
  </section>
}
