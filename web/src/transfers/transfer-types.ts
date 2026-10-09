import type { UploadResumeRecord } from '../uploads/resume'

export type TransferPhase = 'preparing' | 'encrypting' | 'uploading' | 'committing' | 'downloading' | 'waiting-network' | 'completed' | 'failed' | 'cancelled'

export interface ActiveTransfer {
  readonly id: string
  readonly name: string
  readonly kind: 'upload' | 'download' | 'zip'
  readonly phase: TransferPhase
  readonly completedBytes: number
  readonly totalBytes: number
  readonly detail?: string
}

export interface RecoverableTransfer {
  readonly record: UploadResumeRecord
  readonly uploadedBytes: number
  readonly reservedBytes: number
  readonly state: 'active' | 'expired' | 'unknown'
}

export function transferPhaseLabel(phase: TransferPhase): string {
  switch (phase) {
    case 'preparing': return '准备中'
    case 'encrypting': return '加密中'
    case 'uploading': return '上传中'
    case 'committing': return '正在提交'
    case 'downloading': return '下载中'
    case 'waiting-network': return '等待网络'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已暂停'
  }
}

export function transferProgressPercent(completed: number, total: number): number {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.floor(completed / total * 100)))
}
