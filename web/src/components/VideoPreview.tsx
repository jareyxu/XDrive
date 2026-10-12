import { useCallback, useEffect, useRef, useState } from 'react'
import { downloadFile, fetchVideoBlobFallbackLimit, type DriveEntry, type UnlockedVault } from '../api/client'
import type { IdleLockTask } from '../security/idle-lock'
import { formatBytes } from '../utils/format-bytes'
import { RequestIdControl } from './RequestIdControl'
import { useErrorNotice } from './use-error-notice'
import type { VideoRangeSession } from '../media/video-range'

export function VideoPreview(props: { vault: UnlockedVault; entry: DriveEntry; holdIdleLock: (kind: IdleLockTask) => () => void }) {
  const [source, setSource] = useState('')
  const [readySource, setReadySource] = useState('')
  const [error, setError, errorRequestId] = useErrorNotice()
  const [retry, setRetry] = useState(0)
  const [status, setStatus] = useState('正在验证分块播放能力…')
  const [diagnostic, setDiagnostic] = useState<{ stage: string; reason: string; mediaCode?: number; errorName?: string } | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const reportError = useCallback((message: string, cause?: unknown, stage = 'player', mediaCode?: number) => {
    setError(message, cause)
    const original = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause
    const name = original instanceof Error || original instanceof DOMException ? original.name : undefined
    setDiagnostic({ stage, reason: message, mediaCode, errorName: name && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(name) ? name : undefined })
    setCopyStatus('')
  }, [setError])
  const video = useRef<HTMLVideoElement>(null)
  const session = useRef<VideoRangeSession | null>(null)
  const playbackHold = useRef<(() => void) | null>(null)
  const resumePosition = useRef(0)
  const metadataTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const blobMode = useRef(false)
  const forceBlob = useRef(false)
  const acceptTimeUpdates = useRef(false)
  const releasePlayback = useRef<() => void>(() => {})
  const clearMetadataTimer = useCallback(() => { if (metadataTimer.current !== null) clearTimeout(metadataTimer.current); metadataTimer.current = null }, [])
  const stopPlaying = useCallback(() => { playbackHold.current?.(); playbackHold.current = null }, [])
  const rememberPosition = useCallback(() => {
    const time = video.current?.currentTime
    if (time !== undefined && Number.isFinite(time)) resumePosition.current = time
  }, [])
  const detachVideo = useCallback(() => { acceptTimeUpdates.current = false; const element = video.current; element?.pause(); element?.removeAttribute('src'); element?.load(); stopPlaying(); clearMetadataTimer() }, [stopPlaying, clearMetadataTimer])
  const resumePlaying = () => {
    const element = video.current
    if (element && !element.paused && !element.ended && !element.seeking && element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !playbackHold.current) {
      try { playbackHold.current = props.holdIdleLock('video') } catch { element.pause() }
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let rangeSession: VideoRangeSession | undefined
    let blobURL = ''
    let suspended = document.visibilityState === 'hidden'
    const active = () => !disposed && !controller.signal.aborted
    const disposePlayback = () => {
      controller.abort()
      rangeSession?.close()
      session.current = null
      detachVideo()
      if (blobURL) { URL.revokeObjectURL(blobURL); blobURL = '' }
    }
    releasePlayback.current = disposePlayback
    const suspend = () => {
      if (disposed || suspended) return
      suspended = true
      rememberPosition()
      disposePlayback()
      setSource('')
      setStatus('播放已暂停，返回页面后将恢复播放位置。')
    }
    const restore = () => {
      if (disposed || !suspended || document.visibilityState === 'hidden') return
      suspended = false
      setError('')
      setStatus('正在恢复播放会话，完成后请点击播放继续。')
      setRetry(value => value + 1)
    }
    const visibility = () => { if (document.visibilityState === 'hidden') suspend(); else restore() }
    const controllerChanged = () => {
      if (!active() || suspended || !session.current) return
      rememberPosition()
      disposePlayback()
      setSource('')
      setStatus('播放服务已更新，正在恢复播放会话…')
      setRetry(value => value + 1)
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', suspend)
    window.addEventListener('pageshow', restore)
    navigator.serviceWorker?.addEventListener('controllerchange', controllerChanged)

    if (!suspended) void (async () => {
      let module: typeof import('../media/video-range') | undefined
      try {
        module = await import('../media/video-range')
        if (!active()) return
        if (forceBlob.current) throw new module.VideoStreamError('session', '浏览器原生播放器拒绝此视频流，可能是播放接口或视频编码不兼容。', undefined, 'player')
        if (!module.supportsVideoRange()) throw new module.VideoStreamError('session', '浏览器缺少分块播放能力，请使用 HTTPS 和支持 Service Worker 的浏览器。', undefined, 'controller')
        rangeSession = await module.createVideoRangeSession(props.vault, props.entry, controller.signal)
        if (!active()) { rangeSession.close(); return }
        session.current = rangeSession
        blobMode.current = false
        setSource(rangeSession.url)
      } catch (rangeError) {
        if (!active()) return
        if (!module) { reportError('视频播放器组件加载失败，请刷新页面后重试。', rangeError, 'module'); return }
        if (rangeError instanceof module.VideoStreamError && rangeError.kind !== 'session') {
          reportError(rangeError.message, rangeError.cause ?? rangeError, rangeError.stage)
          return
        }
        try {
          const limit = await fetchVideoBlobFallbackLimit(controller.signal)
          if (!active()) return
          if (!Number.isSafeInteger(props.entry.size) || props.entry.size === undefined || props.entry.size < 0) throw new TypeError('视频目录项不完整，请下载后播放。')
          if (props.entry.size > limit) {
            const reason = rangeError instanceof module.VideoStreamError ? rangeError.message : '分块播放会话验证失败，请重试。'
            reportError(`${reason} 此视频超过 ${formatBytes(limit)} 内存播放上限，请下载后播放或重试。`, rangeError, rangeError instanceof module.VideoStreamError ? rangeError.stage : 'registration', forceBlob.current ? 4 : undefined)
            return
          }
          setStatus('分块播放不可用，正在准备小视频内存播放…')
          const blob = await downloadFile(props.vault, props.entry, controller.signal)
          if (!blob || !active()) return
          blobURL = URL.createObjectURL(blob)
          blobMode.current = true
          setSource(blobURL)
        } catch (cause) {
          if (active()) reportError(cause instanceof TypeError ? cause.message : '视频下载失败，请检查网络后重试。', cause, 'fallback')
        }
      }
    })()
    return () => {
      disposed = true
      disposePlayback()
      if (releasePlayback.current === disposePlayback) releasePlayback.current = () => {}
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', suspend)
      window.removeEventListener('pageshow', restore)
      navigator.serviceWorker?.removeEventListener('controllerchange', controllerChanged)
    }
  }, [props.vault, props.entry, retry, setError, reportError, detachVideo, rememberPosition])

  useEffect(() => {
    if (!source) return
    // A successful fetch probe alone cannot establish native decoder support.
    metadataTimer.current = setTimeout(() => {
      if ((video.current?.readyState ?? 0) < HTMLMediaElement.HAVE_METADATA) {
        rememberPosition()
        releasePlayback.current()
        setSource('')
        reportError('浏览器未能加载视频信息，可能是网络中断或视频格式不兼容。请重试或下载后播放。', undefined, 'metadata')
      }
    }, 120000)
    return clearMetadataTimer
  }, [source, reportError, clearMetadataTimer, rememberPosition])

  const playbackError = () => {
    if (!video.current?.getAttribute('src')) return
    stopPlaying()
    clearMetadataTimer()
    const failure = session.current?.failure()
    const code = video.current?.error?.code
    if (!failure && code === 4 && !blobMode.current) {
      forceBlob.current = true
      rememberPosition()
      session.current?.close()
      detachVideo()
      setSource('')
      setStatus('正在检查兼容播放方式…')
      setRetry(value => value + 1)
      return
    }
    const message = failure?.message ?? (code === 2 ? '视频数据读取中断，请检查网络后重试。' : code === 3 || blobMode.current && code === 4 ? '浏览器无法解码此视频，请下载后使用兼容的播放器打开。' : '分块播放会话中断，或浏览器不支持此视频格式。请重试或下载后播放。')
    rememberPosition()
    releasePlayback.current()
    setSource('')
    reportError(message, failure?.cause, failure?.stage ?? 'player', code)
  }
  const copyDiagnostic = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ stage: diagnostic?.stage, reason: diagnostic?.reason, errorName: diagnostic?.errorName, mediaErrorCode: diagnostic?.mediaCode, fileSizeBytes: props.entry.size, userAgent: navigator.userAgent, secureContext: isSecureContext, serviceWorkerAvailable: 'serviceWorker' in navigator, pageControlled: Boolean(navigator.serviceWorker?.controller) }, null, 2))
      setCopyStatus('播放诊断已复制。')
    } catch { setCopyStatus('无法复制，请截图保留当前提示。') }
  }
  return <div className="video-preview-area">
    {source && <video ref={video} className="preview-video" src={source} preload="metadata" controls playsInline
      onLoadedMetadata={() => {
        setReadySource(source)
        acceptTimeUpdates.current = true
        clearMetadataTimer()
        const element = video.current
        if (element && resumePosition.current > 0) {
          const target = Number.isFinite(element.duration) ? Math.min(resumePosition.current, Math.max(0, element.duration - 0.1)) : resumePosition.current
          element.currentTime = target
        }
      }}
      onTimeUpdate={() => { if (acceptTimeUpdates.current) rememberPosition() }} onPlaying={resumePlaying} onSeeked={resumePlaying} onPause={stopPlaying}
      onEnded={() => { resumePosition.current = 0; stopPlaying() }} onWaiting={stopPlaying}
      onSeeking={() => { stopPlaying(); if ((video.current?.currentTime ?? 0) > 0) session.current?.cancelPendingReads() }} onError={playbackError} />}
    {source && readySource !== source && !error && <p role="status">正在缓冲视频信息，首次播放需要读取并校验加密分块…</p>}
    {!source && !error && <p role="status">{status}</p>}
    {error && <div className="preview-fallback" role="alert"><p>{error}<RequestIdControl requestId={errorRequestId} /></p><button type="button" onClick={() => { forceBlob.current = false; rememberPosition(); detachVideo(); setSource(''); setError(''); setDiagnostic(null); setCopyStatus(''); setStatus('正在重新建立播放会话…'); setRetry(value => value + 1) }}>重试播放</button><button type="button" onClick={() => void copyDiagnostic()}>复制播放诊断</button>{copyStatus && <p role="status">{copyStatus}</p>}</div>}
  </div>
}
