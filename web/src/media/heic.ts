export const HEIC_MAX_DECODE_BYTES = 32 * 1024 * 1024

const heicMimes = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
])

let decoderQueue: Promise<void> = Promise.resolve()

export interface ConvertedHeicImage {
  readonly blob: Blob
  readonly width: number
  readonly height: number
}

export function isHeicImage(name: string | undefined, mime: string): boolean {
  const extension = name?.split('.').at(-1)?.toLowerCase()
  return heicMimes.has(mime.toLowerCase()) || ['heic', 'heif', 'heics', 'heifs'].includes(extension ?? '')
}

export function convertHeicToJpeg(blob: Blob, maxEdge: number, signal?: AbortSignal): Promise<ConvertedHeicImage> {
  if (blob.size > HEIC_MAX_DECODE_BYTES) {
    return Promise.reject(new TypeError('HEIC 图片超过 32 MiB 的浏览器解码上限，请下载原文件查看。'))
  }
  if (!Number.isSafeInteger(maxEdge) || maxEdge < 1 || maxEdge > 8192) {
    return Promise.reject(new TypeError('Invalid HEIC output size'))
  }

  const current = decoderQueue.then(() => {
    signal?.throwIfAborted()
    return decodeWithWorker(blob, maxEdge, signal)
  })
  decoderQueue = current.then(() => undefined, () => undefined)
  return current
}

function decodeWithWorker(blob: Blob, maxEdge: number, signal?: AbortSignal): Promise<ConvertedHeicImage> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/heic.worker.ts', import.meta.url), { type: 'module' })
    let settled = false
    const finish = (error?: Error, result?: ConvertedHeicImage) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.terminate()
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'))
    const onMessage = (event: MessageEvent<HeicWorkerResponse>) => {
      if (event.data.error) finish(new Error(event.data.error))
      else {
        const { blob: resultBlob, width, height } = event.data
        if (resultBlob && Number.isSafeInteger(width) && Number.isSafeInteger(height)) {
          finish(undefined, { blob: resultBlob, width: width!, height: height! })
        } else finish(new Error('HEIC 解码器没有返回有效图片。'))
      }
    }
    const onError = () => finish(new Error('HEIC 解码器意外退出，请下载原文件查看。'))
    const timer = window.setTimeout(() => finish(new Error('HEIC 解码超过 30 秒，已停止解码。')), 30_000)
    signal?.addEventListener('abort', abort, { once: true })
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    try { worker.postMessage({ blob, maxEdge }) } catch (error) {
      finish(error instanceof Error ? error : new Error('无法启动 HEIC 解码器。'))
    }
  })
}

interface HeicWorkerResponse {
  readonly blob?: Blob
  readonly width?: number
  readonly height?: number
  readonly error?: string
}
