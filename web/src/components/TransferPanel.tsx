import { useState } from 'react'
import { Archive, Check, ChevronDown, CircleAlert, Download, FileClock, LoaderCircle, RotateCcw, Upload, X } from 'lucide-react'
import styles from './TransferPanel.module.css'
import type { ActiveTransfer, RecoverableTransfer } from '../transfers/transfer-types'
import { transferPhaseLabel, transferProgressPercent } from '../transfers/transfer-types'

interface TransferPanelProps {
  readonly active: readonly ActiveTransfer[]
  readonly recoverable: readonly RecoverableTransfer[]
  readonly now: number
  readonly reservedBytes?: number
  readonly disabled?: boolean
  readonly onCancel: (id: string) => void
  readonly onResume: (recordId: string) => void
  readonly onRestart: (recordId: string) => void
  readonly onAbandon: (recordId: string) => void
}

export function TransferPanel(props: TransferPanelProps) {
  const [expanded, setExpanded] = useState(() => props.recoverable.length > 0)
  const activeCount = props.active.filter((task) => !['completed', 'failed', 'cancelled'].includes(task.phase)).length
  const count = activeCount + props.recoverable.length
  const completed = props.active.reduce((sum, task) => sum + Math.min(task.completedBytes, task.totalBytes), 0) + props.recoverable.reduce((sum, task) => sum + Math.min(task.uploadedBytes, task.record.size), 0)
  const total = props.active.reduce((sum, task) => sum + task.totalBytes, 0) + props.recoverable.reduce((sum, task) => sum + task.record.size, 0)
  const percentage = transferProgressPercent(completed, total)
  const latest = props.active.at(-1)
  const announcement = latest
    ? `${latest.name}：${transferPhaseLabel(latest.phase)}`
    : props.recoverable.length ? `有 ${props.recoverable.length} 个可续传上传任务。` : '所有传输任务已结束。'

  if (count === 0 && props.active.length === 0) return null

  return <aside className={`${styles.root}${expanded ? ` ${styles.expanded}` : ''}`} aria-label="传输面板" data-testid="transfer-panel">
    <span className={styles.live} aria-live="polite" aria-atomic="true">{announcement}</span>
    <button className={`${styles.pill} glass-chrome`} type="button" aria-expanded={expanded} aria-controls="xdrive-transfer-content" onClick={() => setExpanded((value) => !value)}>
      <span className={styles.pillIcon} aria-hidden="true">{activeCount > 0 ? <LoaderCircle size={16} /> : <Check size={16} />}</span>
      <span>{count > 0 ? `${count} 项传输${total > 0 ? `，${percentage}%` : ''}` : '传输已完成'}</span>
      <ChevronDown className={styles.chevron} size={15} aria-hidden="true" />
    </button>
    {expanded && <section id="xdrive-transfer-content" className={`${styles.panel} glass-chrome`} aria-label="上传和下载任务">
      <header className={styles.header}>
        <div><h2>传输</h2><p>{activeCount ? `${activeCount} 项正在处理` : '没有正在处理的任务'}</p></div>
        <button className={styles.close} type="button" aria-label="折叠传输面板" onClick={() => setExpanded(false)}><X size={17} /></button>
      </header>
      {(props.reservedBytes ?? 0) > 0 && <p className={styles.reservation}>已为上传预留 {formatBytes(props.reservedBytes!)}</p>}
      <div className={styles.items}>
        {props.active.map((task) => {
          const percent = transferProgressPercent(task.completedBytes, task.totalBytes)
          const Icon = task.kind === 'zip' ? Archive : task.kind === 'download' ? Download : Upload
          const terminal = ['completed', 'failed', 'cancelled'].includes(task.phase)
          return <article className={styles.item} key={task.id}>
            <div className={styles.itemHeading}><Icon size={16} aria-hidden="true" /><strong title={task.name}>{task.name}</strong><span>{transferPhaseLabel(task.phase)}</span></div>
            {task.totalBytes > 0 && <><progress max={task.totalBytes} value={Math.min(task.totalBytes, task.completedBytes)} aria-label={`${task.name}进度`} /><div className={styles.progressText}><span>{formatBytes(task.completedBytes)} / {formatBytes(task.totalBytes)}</span><span>{percent}%</span></div></>}
            {task.detail && <p className={styles.detail}>{task.detail}</p>}
            {!terminal && <button type="button" className={styles.action} onClick={() => props.onCancel(task.id)}>取消</button>}
            {task.phase === 'failed' && <span className={styles.failure}><CircleAlert size={14} />任务失败，可从本地恢复记录继续。</span>}
            {task.phase === 'completed' && <span className={styles.done}><Check size={14} />已完成</span>}
          </article>
        })}
        {props.recoverable.length > 0 && <section className={styles.recoverable} aria-label="可恢复的上传任务">
        {props.recoverable.map(({ record, uploadedBytes, reservedBytes, state }) => {
          const expired = state === 'expired' || record.expiresAt * 1000 <= props.now
          const remaining = Math.max(0, record.expiresAt * 1000 - props.now)
          const remainingLabel = remaining >= 3_600_000 ? `剩余可续传时间 ${Math.floor(remaining / 3_600_000)} 小时` : remaining > 0 ? `剩余可续传时间 ${Math.max(1, Math.floor(remaining / 60_000))} 分钟` : '上传已过期，需要重新上传。'
          return <article className={styles.item} key={record.id}>
            <div className={styles.itemHeading}><FileClock size={16} aria-hidden="true" /><strong title={record.name}>{record.name}</strong><span>{expired ? '已过期' : '需要选择原文件'}</span></div>
            <progress max={Math.max(1, record.size)} value={Math.min(record.size, uploadedBytes)} aria-label={`${record.name}已上传进度`} />
            <div className={styles.progressText}><span>已上传 {formatBytes(uploadedBytes)} / {formatBytes(record.size)}</span><span>{transferProgressPercent(uploadedBytes, record.size)}%</span></div>
            <p className={styles.detail}>{expired ? '上传已过期，需要重新上传。' : `${remainingLabel}${reservedBytes > 0 ? ` · 预留 ${formatBytes(reservedBytes)}` : ''}`}</p>
            <div className={styles.actions}>
              {expired
                ? <button type="button" className={styles.action} disabled={props.disabled} onClick={() => props.onRestart(record.id)}><RotateCcw size={14} />重新上传</button>
                : <button type="button" className={styles.action} disabled={props.disabled} onClick={() => props.onResume(record.id)}>重新选择原文件并续传</button>}
              <button type="button" className={styles.quietAction} disabled={props.disabled} onClick={() => props.onAbandon(record.id)}>放弃</button>
            </div>
          </article>
        })}
        </section>}
      </div>
      <footer className={styles.footer}>有传输进行时，不会自动锁定。</footer>
    </section>}
  </aside>
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** unit
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}
