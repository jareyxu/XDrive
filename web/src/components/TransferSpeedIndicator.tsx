import { useEffect, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react'
import type { ActiveTransfer } from '../transfers/transfer-types'
import { networkBytes } from '../transfers/network-meter'
import { formatBytes } from '../utils/format-bytes'

interface TransferRate {
  readonly upload: number
  readonly download: number
}

interface Sample extends TransferRate {
  readonly duration: number
}

const EMPTY_RATE: TransferRate = { upload: 0, download: 0 }

export function TransferSpeedIndicator(props: { tasks: readonly ActiveTransfer[] }) {
  const [rateState, setRateState] = useState<{ key: string; rate: TransferRate }>({ key: '', rate: EMPTY_RATE })
  const transferKey = props.tasks
    .filter(task => !['completed', 'failed', 'cancelled'].includes(task.phase))
    .map(task => task.id)
    .sort()
    .join('|')
  const rate = rateState.key === transferKey ? rateState.rate : EMPTY_RATE
  const hasTransfers = props.tasks.some(task => !['completed', 'failed', 'cancelled'].includes(task.phase))


  useEffect(() => {
    if (!hasTransfers) return

    let previous = networkBytes()
    let previousAt = performance.now()
    const samples: Sample[] = []
    const sample = () => {
      const now = performance.now()
      const current = networkBytes()
      const upload = Math.max(0, current.upload - previous.upload)
      const download = Math.max(0, current.download - previous.download)
      previous = current
      const duration = Math.max(1, now - previousAt)
      previousAt = now
      samples.push({ upload, download, duration })
      while (samples.length > 3) samples.shift()

      const durationMs = samples.reduce((total, item) => total + item.duration, 0)
      const next = {
        upload: Math.round(samples.reduce((total, item) => total + item.upload, 0) * 1000 / durationMs),
        download: Math.round(samples.reduce((total, item) => total + item.download, 0) * 1000 / durationMs),
      }
      setRateState(current => current.key === transferKey && current.rate.upload === next.upload && current.rate.download === next.download
        ? current
        : { key: transferKey, rate: next })
    }

    const timer = window.setInterval(sample, 1000)
    return () => window.clearInterval(timer)
  }, [hasTransfers, transferKey])

  if (!hasTransfers) return null
  return <div className="desktop-transfer-speed" role="group" aria-label="实时传输速度" title="按实际传输的加密数据计算，含重试流量，显示最近约 3 秒平均速度">
    <span className="desktop-transfer-rate"><ArrowUpFromLine size={14} aria-hidden="true" /><span>上传</span><strong>{formatBytes(rate.upload)}/s</strong></span>
    <span className="desktop-transfer-rate"><ArrowDownToLine size={14} aria-hidden="true" /><span>下载</span><strong>{formatBytes(rate.download)}/s</strong></span>
  </div>
}
