export const THUMBNAIL_MAX_EDGE = 256
export const THUMBNAIL_MAX_BYTES = 256 * 1024
export interface ThumbnailReference { readonly objectId: string; readonly sizeBytes: number; readonly sha256: string; readonly mime: 'image/webp' | 'image/jpeg'; readonly width: number; readonly height: number; readonly keyVersion?: 1 | 2 }
export interface SavedThumbnail { readonly reference: ThumbnailReference; readonly ciphertext: string }
export function isThumbnailReference(value: unknown): value is ThumbnailReference {
 if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
 const item = value as Record<string, unknown>
 const keys = Object.keys(item)
 return (keys.length === 6 || keys.length === 7) && keys.every(key => ['objectId', 'sizeBytes', 'sha256', 'mime', 'width', 'height', 'keyVersion'].includes(key)) && (keys.length === 6 ? !Object.hasOwn(item, 'keyVersion') : Object.hasOwn(item, 'keyVersion') && (item.keyVersion === 1 || item.keyVersion === 2)) && typeof item.objectId === 'string' && /^[A-Za-z0-9_-]{16,64}$/u.test(item.objectId) && typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(item.sha256) && (item.mime === 'image/webp' || item.mime === 'image/jpeg') && Number.isSafeInteger(item.sizeBytes) && Number(item.sizeBytes) > 36 && Number(item.sizeBytes) <= THUMBNAIL_MAX_BYTES + 36 && ['width', 'height'].every(key => Number.isSafeInteger(item[key]) && Number(item[key]) >= 1 && Number(item[key]) <= THUMBNAIL_MAX_EDGE)
}
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
 const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
 if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && view.getUint32(12) === 0x49484452) return { width: view.getUint32(16), height: view.getUint32(20) }
 if (bytes.length >= 25 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
  const type = view.getUint32(12)
  const uint24 = (index: number) => bytes[index]! + (bytes[index + 1]! << 8) + (bytes[index + 2]! << 16)
  if (type === 0x56503858 && bytes.length >= 30) return { width: uint24(24) + 1, height: uint24(27) + 1 }
  if (type === 0x5650384c && bytes[20] === 47) { const bits = view.getUint32(21, true); return { width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 } }
  if (type === 0x56503820 && bytes.length >= 30 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) return { width: view.getUint16(26, true) & 16383, height: view.getUint16(28, true) & 16383 }
 }
 if (bytes[0] === 255 && bytes[1] === 216) {
  let offset = 2
  while (offset + 4 <= bytes.length) {
   if (bytes[offset++] !== 255) return null
   while (bytes[offset] === 255) offset++
   const marker = bytes[offset++]!
   if (marker === 0xda || marker === 0xd9) return null
   if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
   if (offset + 2 > bytes.length) return null
   const length = view.getUint16(offset)
   if (length < 2 || offset + length > bytes.length) return null
   if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) return { height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) }
   offset += length
  }
 }
 return null
}
