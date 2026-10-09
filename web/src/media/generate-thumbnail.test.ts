// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { generateThumbnail } from './generate-thumbnail'
const header = () => { const bytes = new Uint8Array(24); bytes.set([137,80,78,71,13,10,26,10]); bytes.set([73,72,68,82],12); new DataView(bytes.buffer).setUint32(16,320); new DataView(bytes.buffer).setUint32(20,180); return bytes }
const file = () => ({ type: 'image/png', size: 24, slice: () => ({ arrayBuffer: async () => header().buffer }) }) as unknown as File
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
test('timed-out native decode retains its slot, skips subsequent decoding and closes the late bitmap', async () => {
 vi.useFakeTimers(); let complete!: (bitmap: ImageBitmap) => void
 const decode = vi.fn(() => new Promise<ImageBitmap>(resolve => { complete = resolve })); vi.stubGlobal('createImageBitmap', decode)
 const task = generateThumbnail(file()); await vi.advanceTimersByTimeAsync(8000); expect(await task).toBeNull()
 expect(await generateThumbnail(file())).toBeNull(); expect(decode).toHaveBeenCalledTimes(1)
 const close = vi.fn(); complete({ close, width: 256, height: 144 } as unknown as ImageBitmap); await Promise.resolve(); expect(close).toHaveBeenCalledOnce()
})
test('owner abort returns promptly and closes a bitmap that native decoding delivers afterward', async () => {
 let complete!: (bitmap: ImageBitmap) => void
 vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise<ImageBitmap>(resolve => { complete = resolve })))
 const signal = new AbortController(), task = generateThumbnail(file(), signal.signal); const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' })
 await vi.waitFor(() => expect(complete).toBeDefined()); signal.abort(); await rejected
 const close = vi.fn(); complete({ close, width: 256, height: 144 } as unknown as ImageBitmap); await Promise.resolve(); expect(close).toHaveBeenCalledOnce()
})

function encoderFixture(encode: (mime: string) => { type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> } | null) {
 const close = vi.fn()
 vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close, width: 256, height: 144 })))
 const context = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' }
 vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
 const calls: string[] = []
 vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, mime) => { calls.push(mime!); callback(encode(mime!) as Blob | null) })
 return { close, context, calls }
}
const encoded = (type: string, size = 16) => ({ type, size, arrayBuffer: async () => new Uint8Array(size).fill(7).buffer })
test('prefers WebP and preserves its actual MIME without invoking JPEG', async () => {
 const fixture = encoderFixture(mime => encoded(mime))
 const result = await generateThumbnail(file())
 expect(result).toMatchObject({ mime: 'image/webp', width: 256, height: 144 }); result!.bytes.fill(0)
 expect(fixture.calls).toEqual(['image/webp']); expect(fixture.context.fillRect).not.toHaveBeenCalled(); expect(fixture.close).toHaveBeenCalledOnce()
})
test('native PNG response to WebP falls back to a bounded JPEG with a light matte', async () => {
 const fixture = encoderFixture(mime => encoded(mime === 'image/webp' ? 'image/png' : mime))
 const result = await generateThumbnail(file())
 expect(result).toMatchObject({ mime: 'image/jpeg', width: 256, height: 144 }); expect(result!.bytes.length).toBe(16); result!.bytes.fill(0)
 expect(fixture.calls).toEqual(['image/webp', 'image/jpeg']); expect(fixture.context.fillRect).toHaveBeenCalledWith(0, 0, 256, 144); expect(fixture.context.fillStyle).toBe('#ffffff'); expect(fixture.close).toHaveBeenCalledOnce()
})
test.each(['image/webp', 'image/jpeg'])('rejects an oversized %s encode without unbounded arrayBuffer reads', async mime => {
 const read = vi.fn(async () => new ArrayBuffer(0))
 encoderFixture(requested => requested === mime ? { type: mime, size: 262145, arrayBuffer: read } : encoded('image/png'))
 expect(await generateThumbnail(file())).toBeNull(); expect(read).not.toHaveBeenCalled()
})
test('does not accept PNG as JPEG or retain its bytes', async () => {
 const fixture = encoderFixture(() => encoded('image/png'))
 expect(await generateThumbnail(file())).toBeNull(); expect(fixture.calls).toEqual(['image/webp', 'image/jpeg'])
})
test('clears encoded thumbnail bytes when creating their typed-array view fails', async () => {
 const rawBytes = new ArrayBuffer(16); new Uint8Array(rawBytes).fill(0x5b)
 const fixture = encoderFixture(mime => ({ type: mime, size: rawBytes.byteLength, arrayBuffer: async () => rawBytes }))
 const NativeUint8Array = globalThis.Uint8Array
 const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Uint8Array')!
 const replacement = new Proxy(NativeUint8Array, {
  construct(target, args, newTarget) {
   if (args[0] === rawBytes) throw new Error('thumbnail view allocation failed')
   return Reflect.construct(target, args, newTarget)
  },
 })
 Object.defineProperty(globalThis, 'Uint8Array', { configurable: true, enumerable: descriptor.enumerable, writable: true, value: replacement })
 try {
  expect(await generateThumbnail(file())).toBeNull()
  expect(new NativeUint8Array(rawBytes)).toEqual(new NativeUint8Array(rawBytes.byteLength))
  expect(fixture.close).toHaveBeenCalledOnce()
 } finally { Object.defineProperty(globalThis, 'Uint8Array', descriptor) }
})
test('owner cancellation after an unsupported WebP response never starts JPEG', async () => {
 const owner = new AbortController()
 const fixture = encoderFixture(() => { owner.abort(); return encoded('image/png') })
 await expect(generateThumbnail(file(), owner.signal)).rejects.toMatchObject({ name: 'AbortError' })
 expect(fixture.calls).toEqual(['image/webp']); expect(fixture.close).toHaveBeenCalledOnce()
})
