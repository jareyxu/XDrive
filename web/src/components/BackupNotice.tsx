import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { StorageUsage } from '../api/client'
import { backupIsOverdue, effectiveBackupReminderDays } from '../preferences/preferences'

export function BackupNotice(props: { usage: StorageUsage; now: number; browserDays: number }) {
  const [dismissed, setDismissed] = useState(false)
  const [help, setHelp] = useState(false)
  const helpTrigger = useRef<HTMLButtonElement>(null)
  const days = effectiveBackupReminderDays(props.usage.backupWarnAfterDays, props.browserDays)
  return <>
    {!dismissed && backupIsOverdue(props.usage.lastBackupAt, props.now, days) && <div className="backup-notice" role="note" aria-label="备份提醒">
      <p>{props.usage.lastBackupAt === null ? '尚无已完成的备份。' : `上次备份已超过 ${days} 天。已 ${Math.floor(Math.max(0, props.now - props.usage.lastBackupAt) / 86400000)} 天没有备份。`} VPS 上的数据默认是唯一副本。请将云盘备份到外部存储。</p>
      <div className="backup-notice-actions"><button ref={helpTrigger} type="button" className="quiet-button" onClick={() => setHelp(true)}>了解如何备份</button><button type="button" className="quiet-button" onClick={() => setDismissed(true)}>本次关闭备份提醒</button></div>
    </div>}
    {help && <BackupHelpDialog onClose={() => setHelp(false)} returnFocus={helpTrigger} />}
  </>
}

function BackupHelpDialog(props: { onClose: () => void; returnFocus: RefObject<HTMLButtonElement | null> }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const trigger = props.returnFocus.current
    const element = dialog.current!
    element.showModal()
    return () => { element.close(); if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus() }
  }, [props.returnFocus])
  return <dialog ref={dialog} className="move-dialog backup-help-dialog" aria-labelledby="backup-help-title" aria-describedby="backup-help-description" onClose={props.onClose} onCancel={event => { event.preventDefault(); props.onClose() }} onKeyDown={event => {
    if (event.key === 'Tab') { event.preventDefault(); dialog.current?.querySelector<HTMLButtonElement>('button')?.focus() }
  }}>
    <header><h2 id="backup-help-title">如何备份 XDrive</h2></header>
    <div className="backup-help-content">
      <p id="backup-help-description">由服务器管理员在服务器上运行备份命令。备份包含加密文件和数据库，不能找回遗忘的密码。</p>
      <ol><li>准备外部存储上的备份目录，使用服务配置运行 <code>xdrive backup /path/to/external-backup</code>。</li><li>复制或同步已完成的备份到 VPS 之外。仅在同一 VPS 上留一份副本，无法防止服务器或磁盘损坏。</li><li>运行 <code>xdrive backup --verify /path/to/external-backup</code> 验证对象，并在空目标目录演练恢复。</li></ol>
      <p>容量页显示上次完成备份的时间；提醒不会自动执行备份。完整配置、恢复及权限步骤请查看项目 README 的备份说明。</p>
    </div>
    <footer><button type="button" className="quiet-button" autoFocus onClick={props.onClose}>关闭备份说明</button></footer>
  </dialog>
}
