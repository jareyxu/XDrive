import { imageDimensions, THUMBNAIL_MAX_BYTES, THUMBNAIL_MAX_EDGE } from './thumbnail-schema'
import { takeArrayBufferBytes } from '../crypto/encoding'
import { convertHeicToJpeg, HEIC_MAX_DECODE_BYTES, isHeicImage } from './heic'
export interface GeneratedThumbnail { bytes: Uint8Array; mime: 'image/webp' | 'image/jpeg'; width: number; height: number }
const maxPixels = 32 * 1024 * 1024
// Native bitmap decoding cannot be aborted. Keep its slot occupied until the
// native promise settles, even after a timeout or owner cancellation.
let imageDecoderBusy = false
async function decodeImage(file: File, width: number, height: number, signal?: AbortSignal): Promise<ImageBitmap> {
 if (imageDecoderBusy) throw new Error('Thumbnail decoder busy')
 signal?.throwIfAborted(); imageDecoderBusy = true
 return new Promise((resolve, reject) => {
  let settled = false
  const finish = (error?: unknown, bitmap?: ImageBitmap) => {
   if (settled) { bitmap?.close(); return }
   settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
   if (error) reject(error); else resolve(bitmap!)
  }
  const abort = () => finish(new DOMException('Cancelled', 'AbortError'))
  const timer = setTimeout(() => finish(new Error('Thumbnail decode timeout')), 8000)
  signal?.addEventListener('abort', abort, { once: true })
  try {
   void createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' }).then(
    bitmap => { imageDecoderBusy = false; finish(undefined, bitmap) },
    error => { imageDecoderBusy = false; finish(error) },
   )
  } catch (error) { imageDecoderBusy = false; finish(error) }
 })
}
const validDimensions = (width: number, height: number) => Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= maxPixels
function canvas(width: number, height: number) { const result = document.createElement('canvas'); result.width = width; result.height = height; return result }
async function encode(source: CanvasImageSource, width: number, height: number, signal?: AbortSignal): Promise<GeneratedThumbnail | null> {
 signal?.throwIfAborted()
 const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(width, height))
 const output = canvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)))
 try {
  const context = output.getContext('2d'); if (!context) return null
  context.drawImage(source, 0, 0, output.width, output.height)
  let blob: Blob | null = null
  let mime: GeneratedThumbnail['mime'] = 'image/webp'
  try { blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, mime, 0.8)) } catch { /* Unsupported native encoder; try the required JPEG fallback. */ }
  signal?.throwIfAborted()
  if (!blob || blob.type !== mime) {
   mime = 'image/jpeg'
   // JPEG has no alpha; use a deterministic light matte before drawing again.
   context.fillStyle = '#ffffff'; context.fillRect(0, 0, output.width, output.height)
   context.drawImage(source, 0, 0, output.width, output.height)
   blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, mime, 0.8))
   signal?.throwIfAborted()
  }
  if (!blob || blob.type !== mime || blob.size > THUMBNAIL_MAX_BYTES) return null
  const bytes = takeArrayBufferBytes(await blob.arrayBuffer()); if (signal?.aborted) { bytes.fill(0); signal.throwIfAborted() }
  return { bytes, mime, width: output.width, height: output.height }
 } finally { output.width = 0; output.height = 0 }
}
export async function generateThumbnail(file: File, signal?: AbortSignal): Promise<GeneratedThumbnail | null> {
 signal?.throwIfAborted()
 try {
  if (isHeicImage(file.name, file.type)) {
   if (file.size > HEIC_MAX_DECODE_BYTES) return null
   const converted = await convertHeicToJpeg(file, THUMBNAIL_MAX_EDGE, signal)
   if (converted.blob.size > THUMBNAIL_MAX_BYTES) return null
   const bytes = takeArrayBufferBytes(await converted.blob.arrayBuffer())
   if (signal?.aborted) { bytes.fill(0); signal.throwIfAborted() }
   return { bytes, mime: 'image/jpeg', width: converted.width, height: converted.height }
  }
  if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
   if (file.size > 32 * 1024 * 1024 || typeof createImageBitmap !== 'function') return null
   const header = takeArrayBufferBytes(await file.slice(0, 128 * 1024).arrayBuffer())
   let dimensions: ReturnType<typeof imageDimensions>
   try { dimensions = imageDimensions(header) } finally { header.fill(0) }
   signal?.throwIfAborted()
   if (!dimensions || !validDimensions(dimensions.width, dimensions.height)) return null
   const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(dimensions.width, dimensions.height))
   const bitmap = await decodeImage(file, Math.max(1, Math.round(dimensions.width * scale)), Math.max(1, Math.round(dimensions.height * scale)), signal)
   try { signal?.throwIfAborted(); return await encode(bitmap, bitmap.width, bitmap.height, signal) } finally { bitmap.close() }
  }
  if (!file.type.startsWith('video/')) return null
  const video = document.createElement('video'), url = URL.createObjectURL(file)
  video.preload = 'metadata'; video.muted = true; video.playsInline = true
  try {
   await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); video.onloadedmetadata = null; video.onseeked = null; video.onerror = null; if (error) reject(error); else resolve() }
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('Video thumbnail timeout')), 8000)
    signal?.addEventListener('abort', abort, { once: true })
    video.onerror = () => finish(new Error('Unsupported video'))
    video.onseeked = () => finish()
    video.onloadedmetadata = () => { if (!validDimensions(video.videoWidth, video.videoHeight) || !Number.isFinite(video.duration) || video.duration <= 0) { finish(new Error('Invalid video metadata')); return }; video.currentTime = Math.min(video.duration * 0.1, Math.max(0, video.duration - 0.01)) }
    video.src = url
   })
   return await encode(video, video.videoWidth, video.videoHeight, signal)
  } finally { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url) }
 } catch (error) { if (signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw error; return null }
}
