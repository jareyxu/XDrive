import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { VirtualEntryList } from './VirtualEntryList'
import type { FolderConflict, FolderConflictAction } from '../uploads/folder-conflicts'

export function FolderConflictDialog(props: {
  kind?: 'folder' | 'files'
  destinationLabel?: string
  conflicts: readonly FolderConflict[]
  availableBytes: number | null
  trashBytes: number | null
  formatBytes: (value: number) => string
  onConfirm: (choices: ReadonlyMap<string, FolderConflictAction>) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [choices, setChoices] = useState<ReadonlyMap<string, FolderConflictAction>>(() => new Map(props.conflicts.map((item) => [item.path, 'keep-both'])))
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal() }, [])
  const summary = useMemo(() => {
    const counts = { overwrite: 0, skip: 0, 'keep-both': 0 }
    for (const action of choices.values()) counts[action] += 1
    return counts
  }, [choices])
  const all = (action: FolderConflictAction) => setChoices(new Map(props.conflicts.map((item) => [item.path, action])))
  const trapTab = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button,select,[tabindex]')].filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)
    event.preventDefault()
    if (!controls.length) return
    const current = controls.findIndex((element) => element === document.activeElement)
    const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
    controls[next].focus()
  }
  const label = props.kind === 'files' ? '文件上传' : '文件夹上传'
  return <dialog ref={dialog} className="move-dialog folder-conflict-dialog" aria-label={`${label}冲突`} onKeyDown={trapTab} onCancel={(event) => { event.preventDefault(); props.onCancel() }} onClose={props.onCancel}>
    <header><div><span className="eyebrow">{label}</span><h2>{props.conflicts.length} 项存在同名冲突</h2></div><button className="icon-button" type="button" aria-label={`取消${label}`} onClick={props.onCancel}>×</button></header>
    {props.destinationLabel && <p>上传位置：{props.destinationLabel}</p>}
    <p>选择覆盖时，旧文件或旧文件夹（含全部后代）会进入回收站。新文件仍需完整密文空间；空间不足时请先清理其他内容。</p>
    {props.availableBytes !== null && <p>可用 {props.formatBytes(props.availableBytes)} · 回收站 {props.formatBytes(props.trashBytes ?? 0)}</p>}
    <div className="folder-conflict-actions" role="group" aria-label="所有冲突的处理方式"><button type="button" className="quiet-button" onClick={() => all('overwrite')}>全部覆盖</button><button type="button" className="quiet-button" onClick={() => all('skip')}>全部跳过</button><button type="button" className="quiet-button" onClick={() => all('keep-both')}>全部保留两者</button></div>
    <VirtualEntryList entries={props.conflicts} itemKey={(item) => item.path} label="上传冲突列表" renderEntry={(item) => <div className="folder-conflict-row" role="listitem">
      <span className="folder-conflict-path" title={item.path}>{item.path}<small>{item.existing.kind === 'folder' ? '现有文件夹（含全部后代）' : `现有文件 ${props.formatBytes(item.existing.size ?? 0)}`} · {item.incomingKind === 'folder' ? `新文件夹（${item.incomingFileCount} 个文件，共 ${props.formatBytes(item.incomingSize)}）` : `新文件 ${props.formatBytes(item.incomingSize)}`}</small></span>
      <select aria-label={`处理 ${item.path}`} value={choices.get(item.path) ?? 'keep-both'} onChange={(event) => {
        const action = event.currentTarget.value as FolderConflictAction
        setChoices((current) => new Map(current).set(item.path, action))
      }}><option value="overwrite">覆盖并移入回收站</option><option value="skip">跳过</option><option value="keep-both">保留两者</option></select>
    </div>} />
    <p aria-live="polite">覆盖 {summary.overwrite} 项 · 跳过 {summary.skip} 项 · 保留两者 {summary['keep-both']} 项</p>
    <footer><button type="button" className="quiet-button" onClick={props.onCancel}>取消上传</button><button type="button" className="primary-button" onClick={() => props.onConfirm(choices)}>确认处理并上传</button></footer>
  </dialog>
}
