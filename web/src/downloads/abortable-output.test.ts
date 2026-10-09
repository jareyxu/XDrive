import { describe, expect, it, vi } from 'vitest'
import { openAbortableOutput } from './abortable-output'

describe('abortable download output', () => {
  it('rejects the producer while a slow sink is still writing and does not enqueue another write', async () => {
    let finish!: () => void
    const abort = vi.fn(), write = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const destination = new WritableStream<Uint8Array>({ write, abort })
    const owner = new AbortController()
    const output = openAbortableOutput(destination, owner.signal)
    const writer = output.stream.getWriter()
    const pending = writer.write(new Uint8Array([1, 2]))
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    owner.abort()
    await expect(pending).rejects.toThrow(/abort/i)
    await expect(writer.write(new Uint8Array([3]))).rejects.toThrow(/abort/i)
    output.dispose()
    expect(destination.locked).toBe(false)
    expect(abort).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1))
    expect(write).toHaveBeenCalledTimes(1)
    writer.releaseLock()
  })

  it('honors backpressure and closes a successful output once', async () => {
    const chunks: number[] = [], close = vi.fn()
    const destination = new WritableStream<Uint8Array>({ write(chunk) { chunks.push(...chunk) }, close })
    const owner = new AbortController()
    const output = openAbortableOutput(destination, owner.signal)
    const writer = output.stream.getWriter()
    await writer.write(new Uint8Array([4]))
    await writer.close()
    output.dispose()
    owner.abort()
    expect(chunks).toEqual([4])
    expect(close).toHaveBeenCalledTimes(1)
    expect(destination.locked).toBe(false)
    writer.releaseLock()
  })

  it('does not write when the owner was already cancelled', async () => {
    const write = vi.fn(), abort = vi.fn()
    const owner = new AbortController(); owner.abort()
    const output = openAbortableOutput(new WritableStream<Uint8Array>({ write, abort }), owner.signal)
    const writer = output.stream.getWriter()
    await expect(writer.write(new Uint8Array([1]))).rejects.toThrow(/abort/i)
    output.dispose(); writer.releaseLock()
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1))
    expect(write).not.toHaveBeenCalled()
  })

  it('releases the producer when cancellation arrives during a stalled close', async () => {
    let finish!: () => void
    const close = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const destination = new WritableStream<Uint8Array>({ close })
    const owner = new AbortController()
    const output = openAbortableOutput(destination, owner.signal)
    const writer = output.stream.getWriter()
    const closing = writer.close()
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    owner.abort()
    await expect(closing).rejects.toThrow(/abort/i)
    output.dispose(); writer.releaseLock()
    expect(destination.locked).toBe(false)
    finish()
  })
})
