import { useCallback, useEffect, useRef, useState } from 'react'
import { downloadFile, fetchVideoBlobFallbackLimit, type DriveEntry, type UnlockedVault } from '../api/client'
import type { IdleLockTask } from '../security/idle-lock'
import { formatBytes } from '../utils/format-bytes'
import { RequestIdControl } from './RequestIdControl'
import { useErrorNotice } from './use-error-notice'
import type { VideoRangeSession } from '../media/video-range'

export function VideoPreview(props: { vault: UnlockedVault; entry: DriveEntry; holdIdleLock: (kind: IdleLockTask) => () => void }) {
  const [source, setSource] = useState('')
  const [error, setError, errorRequestId] = useErrorNotice()
  const [retry, setRetry] = useState(0)
  const [status, setStatus] = useState('正在验证分块播放能力…')
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
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', suspend)
    window.addEventListener('pageshow', restore)

    if (!suspended) void (async () => {
      let module: typeof import('../media/video-range') | undefined
      try {
        module = await import('../media/video-range')
        if (!active()) return
        if (forceBlob.current) throw new module.VideoStreamError('session', '浏览器媒体播放器未能使用分块播放。')
        if (!module.supportsVideoRange()) throw new module.VideoStreamError('session', '浏览器缺少分块播放能力，请使用 HTTPS 和支持 Service Worker 的浏览器。')
        rangeSession = await module.createVideoRangeSession(props.vault, props.entry, controller.signal)
        if (!active()) { rangeSession.close(); return }
        session.current = rangeSession
        blobMode.current = false
        setSource(rangeSession.url)
      } catch (rangeError) {
        if (!active()) return
        if (!module) { setError('视频播放器组件加载失败，请刷新页面后重试。', rangeError); return }
        if (rangeError instanceof module.VideoStreamError && rangeError.kind !== 'session') {
          setError(rangeError.message, rangeError.cause ?? rangeError)
          return
        }
        try {
          const limit = await fetchVideoBlobFallbackLimit(controller.signal)
          if (!active()) return
          if (!Number.isSafeInteger(props.entry.size) || props.entry.size === undefined || props.entry.size < 0) throw new TypeError('视频目录项不完整，请下载后播放。')
          if (props.entry.size > limit) {
            setError(`分块播放会话未能建立，请重试播放。此视频超过 ${formatBytes(limit)} 内存播放上限，也可下载后播放。`, rangeError)
            return
          }
          setStatus('分块播放不可用，正在准备小视频内存播放…')
          const blob = await downloadFile(props.vault, props.entry, controller.signal)
          if (!blob || !active()) return
          blobURL = URL.createObjectURL(blob)
          blobMode.current = true
          setSource(blobURL)
        } catch (cause) {
          if (active()) setError(cause instanceof TypeError ? cause.message : '视频下载失败，请检查网络后重试。', cause)
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
    }
  }, [props.vault, props.entry, retry, setError, detachVideo, rememberPosition])

  useEffect(() => {
    if (!source) return
    // A successful fetch probe alone cannot establish native decoder support.
    metadataTimer.current = setTimeout(() => {
      if ((video.current?.readyState ?? 0) < HTMLMediaElement.HAVE_METADATA) {
        rememberPosition()
        releasePlayback.current()
        setSource('')
        setError('浏览器未能加载视频信息，可能是网络中断或视频格式不兼容。请重试或下载后播放。')
      }
    }, 30000)
    return clearMetadataTimer
  }, [source, setError, detachVideo, clearMetadataTimer, rememberPosition])

  const playbackError = () => {
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
    setError(message, failure?.cause)
  }
  return <div className="video-preview-area">
    {source && <video ref={video} className="preview-video" src={source} preload="metadata" controls playsInline
      onLoadedMetadata={() => {
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
    {!source && !error && <p role="status">{status}</p>}
    {error && <div className="preview-fallback" role="alert"><p>{error}<RequestIdControl requestId={errorRequestId} /></p><button type="button" onClick={() => { forceBlob.current = false; rememberPosition(); detachVideo(); setSource(''); setError(''); setStatus('正在重新建立播放会话…'); setRetry(value => value + 1) }}>重试播放</button></div>}
  </div>
}
