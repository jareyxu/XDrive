import { expect, test } from 'vitest'
import { imageDimensions, isThumbnailReference } from './thumbnail-schema'
const valid = { objectId: 'abcdefghijklmnop', sha256: 'a'.repeat(64), sizeBytes: 100, mime: 'image/webp', width: 256, height: 1 }
test('only opaque, bounded and authenticated WebP/JPEG references pass', () => {
 expect(isThumbnailReference(valid)).toBe(true)
 expect(isThumbnailReference({ ...valid, mime: 'image/jpeg' })).toBe(true)
 for (const change of [{ width: 257 }, { height: 0 }, { sizeBytes: 36 }, { sizeBytes: 262181 }, { mime: 'image/svg+xml' }, { mime: 'image/png' }, { sha256: 'g'.repeat(64) }, { extra: true }, { width: '1' }]) expect(isThumbnailReference({ ...valid, ...change })).toBe(false)
})
test('PNG/JPEG/WebP dimensions are read from a bounded header before decoding', () => {
 const png = new Uint8Array(24), p = new DataView(png.buffer); png.set([137, 80, 78, 71]); p.setUint32(12, 0x49484452); p.setUint32(16, 100000); p.setUint32(20, 600)
 expect(imageDimensions(png)).toEqual({ width: 100000, height: 600 })
 const jpeg = Uint8Array.from([255,216,255,192,0,8,8,0,80,0,160,1]); expect(imageDimensions(jpeg)).toEqual({ width: 160, height: 80 })
 const webp = new Uint8Array(30), w = new DataView(webp.buffer); w.setUint32(0, 0x52494646); w.setUint32(8, 0x57454250); w.setUint32(12, 0x56503858); webp[24] = 255; webp[27] = 127
 expect(imageDimensions(webp)).toEqual({ width: 256, height: 128 })
 for (let i = 0; i < 24; i++) expect(() => imageDimensions(png.slice(0, i))).not.toThrow()
 expect(imageDimensions(new Uint8Array(128))).toBeNull()
})
