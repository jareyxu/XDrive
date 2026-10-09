import { heicTo } from 'heic-to/csp'
import { findHeifImageDimensions } from '../media/heif-dimensions'

interface DecodeRequest {
  readonly blob: Blob
  readonly maxEdge: number
}

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<DecodeRequest>) => void): void
  postMessage(message: { blob?: Blob; width?: number; height?: number; error?: string }): void
}

const workerScope = self as unknown as WorkerScope

workerScope.addEventListener('message', (event) => { void decode(event.data) })

async function decode(request: DecodeRequest): Promise<void> {
  let bitmap: ImageBitmap | undefined
  let canvas: OffscreenCanvas | undefined
  try {
    const input = await request.blob.arrayBuffer()
    let dimensions: ReturnType<typeof findHeifImageDimensions>
    try { dimensions = findHeifImageDimensions(input) } finally { new Uint8Array(input).fill(0) }
    if (!dimensions || dimensions.some(({ width, height }) => width > 16_384 || height > 16_384 || width * height > 48_000_000)) {
      throw new Error('无法验证 HEIC 图片尺寸，或图片超过浏览器解码上限。')
    }
    bitmap = await heicTo({ blob: request.blob, type: 'bitmap' })
    const { width, height } = bitmap
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > 48_000_000) {
      throw new Error('图片尺寸超过浏览器解码上限。')
    }
    const scale = Math.min(1, request.maxEdge / Math.max(width, height))
    const outputWidth = Math.max(1, Math.round(width * scale))
    const outputHeight = Math.max(1, Math.round(height * scale))
    canvas = new OffscreenCanvas(outputWidth, outputHeight)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建图片预览画布。')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, outputWidth, outputHeight)
    context.drawImage(bitmap, 0, 0, outputWidth, outputHeight)
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 })
    if (jpeg.type !== 'image/jpeg') throw new Error('浏览器无法生成 HEIC 预览。')
    workerScope.postMessage({ blob: jpeg, width: outputWidth, height: outputHeight })
  } catch {
    workerScope.postMessage({ error: '无法解码此 HEIC 图片，请下载原文件查看。' })
  } finally {
    bitmap?.close()
    if (canvas) { canvas.width = 0; canvas.height = 0 }
  }
}
