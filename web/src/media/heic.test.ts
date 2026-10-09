// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { convertHeicToJpeg, HEIC_MAX_DECODE_BYTES, isHeicImage } from './heic'
import { generateThumbnail } from './generate-thumbnail'
import { findHeifImageDimensions } from './heif-dimensions'

class FakeWorker {
  static instances: FakeWorker[] = []
  readonly listeners = new Map<string, (event: MessageEvent | ErrorEvent) => void>()
  readonly terminate = vi.fn()
  posted: unknown

  constructor() { FakeWorker.instances.push(this) }
  addEventListener(type: string, listener: (event: MessageEvent | ErrorEvent) => void) { this.listeners.set(type, listener) }
  removeEventListener(type: string) { this.listeners.delete(type) }
  postMessage(message: unknown) { this.posted = message }
  dispatch(type: string, data: unknown) { this.listeners.get(type)?.({ data } as MessageEvent) }
}

afterEach(() => { FakeWorker.instances = []; vi.unstubAllGlobals(); vi.restoreAllMocks() })

function box(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, bytes.length)
  bytes.set([...type].map(char => char.charCodeAt(0)), 4)
  bytes.set(payload, 8)
  return bytes
}

function heifWithDimensions(...dimensions: Array<[number, number]>): ArrayBuffer {
  const properties = dimensions.map(([width, height]) => {
    const data = new Uint8Array(12)
    const view = new DataView(data.buffer)
    view.setUint32(4, width)
    view.setUint32(8, height)
    return box('ispe', data)
  })
  const propertiesLength = properties.reduce((sum, property) => sum + property.length, 0)
  const propertyPayload = new Uint8Array(propertiesLength)
  let offset = 0
  for (const property of properties) { propertyPayload.set(property, offset); offset += property.length }
  const ipco = box('ipco', propertyPayload)
  const iprp = box('iprp', ipco)
  const metaPayload = new Uint8Array(4 + iprp.length)
  metaPayload.set(iprp, 4)
  return box('meta', metaPayload).buffer as ArrayBuffer
}

test.each([
  ['photo.HEIC', 'application/octet-stream', true],
  ['photo.heif', '', true],
  ['burst.heics', '', true],
  ['photo.jpg', 'image/heic', true],
  ['photo.jpg', 'image/heif-sequence', true],
  ['photo.jpg', 'image/jpeg', false],
])('recognizes HEIC/HEIF from extension or MIME (%s)', (name, mime, expected) => {
  expect(isHeicImage(name, mime)).toBe(expected)
})

test('reads every HEIF image extent before pixel decoding', () => {
  expect(findHeifImageDimensions(heifWithDimensions([4032, 3024], [160, 120])))
    .toEqual([{ width: 4032, height: 3024 }, { width: 160, height: 120 }])
  expect(findHeifImageDimensions(new ArrayBuffer(12))).toBeNull()
})

test('decodes to a local JPEG in a disposable worker and passes the requested edge limit', async () => {
  vi.stubGlobal('Worker', FakeWorker)
  const source = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/heic' })
  const task = convertHeicToJpeg(source, 4096)
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1))
  const worker = FakeWorker.instances[0]!
  expect(worker.posted).toEqual({ blob: source, maxEdge: 4096 })
  const jpeg = new Blob(['jpeg'], { type: 'image/jpeg' })
  worker.dispatch('message', { blob: jpeg, width: 2048, height: 1536 })
  await expect(task).resolves.toEqual({ blob: jpeg, width: 2048, height: 1536 })
  expect(worker.terminate).toHaveBeenCalledOnce()
})

test('terminates its decoder immediately on cancellation', async () => {
  vi.stubGlobal('Worker', FakeWorker)
  const controller = new AbortController()
  const task = convertHeicToJpeg(new Blob(['heic']), 256, controller.signal)
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1))
  const worker = FakeWorker.instances[0]!
  controller.abort()
  await expect(task).rejects.toMatchObject({ name: 'AbortError' })
  expect(worker.terminate).toHaveBeenCalledOnce()
})

test('rejects oversized decoder input before starting a worker', async () => {
  vi.stubGlobal('Worker', FakeWorker)
  const source = { size: HEIC_MAX_DECODE_BYTES + 1 } as Blob
  await expect(convertHeicToJpeg(source, 256)).rejects.toThrow('32 MiB')
  expect(FakeWorker.instances).toHaveLength(0)
})

test('creates a JPEG thumbnail for HEIC files even when the browser reports a generic MIME', async () => {
  vi.stubGlobal('Worker', FakeWorker)
  const source = { name: 'IMG_0012.HEIC', type: 'application/octet-stream', size: 128 } as File
  const task = generateThumbnail(source)
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1))
  const jpeg = new Blob([new Uint8Array(20).fill(7)], { type: 'image/jpeg' })
  FakeWorker.instances[0]!.dispatch('message', { blob: jpeg, width: 256, height: 192 })
  const thumbnail = await task
  expect(thumbnail).toMatchObject({ mime: 'image/jpeg', width: 256, height: 192 })
  expect([...thumbnail!.bytes]).toEqual(Array(20).fill(7))
  thumbnail!.bytes.fill(0)
})
