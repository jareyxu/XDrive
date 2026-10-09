// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { TransferPanel } from './TransferPanel'
import type { UploadResumeRecord } from '../uploads/resume'

afterEach(cleanup)

const record = (expiresAt: number): UploadResumeRecord => ({
  version: 1, id: 'resume-record-0001', uploadId: 'upload-session-0001', expiresAt,
  directoryId: 'directory-index-001', name: '旅行照片.jpg', mime: 'image/jpeg', size: 16 * 1024 * 1024,
  lastModified: 1, fingerprint: 'a'.repeat(64), fileId: 'file-identifier-0001', entryId: 'entry-identifier-0001',
  chunks: [null, null], manifest: null, index: null, indexRevision: null, idempotencyKey: null,
})

test('automatically reveals recoverable uploads with confirmed bytes and continuation actions', () => {
  const onResume = vi.fn()
  const view = render(<TransferPanel active={[]} recoverable={[{ record: record(2_000), uploadedBytes: 8 * 1024 * 1024, reservedBytes: 17_000_000, state: 'active' }]} now={1_000} reservedBytes={17_000_000} onCancel={vi.fn()} onResume={onResume} onRestart={vi.fn()} onAbandon={vi.fn()} />)
  expect(view.getByRole('region', { name: '可恢复的上传任务' })).toBeTruthy()
  expect(view.getByText(/已上传 8\.0 MB \/ 16 MB/)).toBeTruthy()
  expect(view.getByText('已为上传预留 16 MB')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: '重新选择原文件并续传' }))
  expect(onResume).toHaveBeenCalledWith('resume-record-0001')
})

test('expired records offer a fresh upload, and active progress updates are exposed accessibly', () => {
  const onRestart = vi.fn(), onCancel = vi.fn()
  const view = render(<TransferPanel
    active={[{ id: 'transfer-1', name: '报告.pdf', kind: 'download', phase: 'downloading', completedBytes: 10, totalBytes: 40 }]}
    recoverable={[{ record: record(500), uploadedBytes: 4, reservedBytes: 0, state: 'expired' }]}
    now={1_000} onCancel={onCancel} onResume={vi.fn()} onRestart={onRestart} onAbandon={vi.fn()}
  />)
  expect(view.getByRole('region', { name: '可恢复的上传任务' })).toBeTruthy()
  expect(view.getByText('已上传 4 B / 16 MB')).toBeTruthy()
  expect(view.getByRole('progressbar', { name: '报告.pdf进度' }).getAttribute('value')).toBe('10')
  fireEvent.click(view.getByRole('button', { name: '重新上传' }))
  expect(onRestart).toHaveBeenCalledWith('resume-record-0001')
  fireEvent.click(view.getByRole('button', { name: '取消' }))
  expect(onCancel).toHaveBeenCalledWith('transfer-1')
})
