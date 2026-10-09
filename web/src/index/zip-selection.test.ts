import { describe, expect, it, vi } from 'vitest'
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js'
import type { DriveEntry } from '../api/client'
import { planZipSelection, type ZipSelection } from './zip-selection'

const file = (id: string, name = `${id}.txt`, size = 3): DriveEntry => ({ entryId: id, kind: 'file', name, size, fileId: id, manifestObjectId: `manifest-${id}`, manifestSha256: '0'.repeat(64) })
const folder = (id: string, name = id): DriveEntry => ({ entryId: id, kind: 'folder', name, childIndexId: `index-${id}` })
const select = (entry: DriveEntry, parentIndexId = 'root'): ZipSelection => ({ entry, parentIndexId })

describe('ZIP selection planning', () => {
  it('budgets archive-wide ZIP64 records and actual local library output including Unicode paths', async () => {
    for (const entries of [[file('zero', 'a.txt', 0)], [file('unicode', '中文🦊.txt', 3)], Array.from({length:40}, (_,i) => file(String(i)))]) {
      const plan = await planZipSelection(entries.map(entry => select(entry)), async () => [])
      const writer = new ZipWriter(new Uint8ArrayWriter(), {zip64:true,level:0,useWebWorkers:false,useCompressionStream:false})
      for (const entry of entries) await writer.add(entry.name, new Uint8ArrayReader(new Uint8Array(entry.size!)), {zip64:true,level:0,useWebWorkers:false,useCompressionStream:false})
      const bytes = await writer.close(undefined,{zip64:true})
      expect(plan.estimatedArchiveBytes).toBeGreaterThanOrEqual(bytes.byteLength)
    }
  })
  it('deduplicates selected descendants in any order and reads each folder once', async () => {
    const parent = folder('parent'), nested = folder('nested'), child = file('child')
    const read = vi.fn(async (id: string) => id === 'index-parent' ? [nested, child] : [file('deep')])
    const result = await planZipSelection([select(child, 'index-parent'), select(nested, 'index-parent'), select(parent), select(parent)], read)
    expect(result.items.map((item) => item.path)).toEqual(['parent/', 'parent/nested/', 'parent/nested/deep.txt', 'parent/child.txt'])
    expect(read).toHaveBeenCalledTimes(2)
    expect(result.totalPlaintextBytes).toBe(6)
    expect(result.estimatedArchiveBytes).toBeGreaterThan(6 + 4 * 256)
  })

  it('keeps independent files and empty folders across source directories', async () => {
    const result = await planZipSelection([select(file('one'), 'source-a'), select(folder('empty'), 'source-b')], async () => [])
    expect(result.items.map((item) => item.path)).toEqual(['one.txt', 'empty/'])
  })

  it.each([['report', 'report'], ['Report.txt', 'report.txt'], ['é.txt', 'e\u0301.txt']])('rejects portable root collisions %s / %s', async (first, second) => {
    await expect(planZipSelection([select(file('one', first), 'a'), select(file('two', second), 'b')], async () => [])).rejects.toThrow(/冲突/)
  })

  it('rejects a file and folder sharing the same archive path', async () => {
    await expect(planZipSelection([select(file('one', 'report')), select(folder('two', 'report'))], async () => [])).rejects.toThrow(/冲突/)
  })

  it('rejects references with conflicting parents', async () => {
    await expect(planZipSelection([select(file('one'), 'a'), select(file('one'), 'b')], async () => [])).rejects.toThrow(/重复目录项/)
  })

  it('rejects cycles before overlap removal', async () => {
    const a = folder('a'), b = folder('b')
    await expect(planZipSelection([select(a, 'index-b')], async (id) => id === 'index-a' ? [b] : [a])).rejects.toThrow(/循环/)
  })

  it('rejects duplicate child index ownership', async () => {
    await expect(planZipSelection([select(folder('a')), select({ ...folder('b'), childIndexId: 'index-a' })], async () => [])).rejects.toThrow(/重复文件夹/)
  })

  it('rejects duplicate or inconsistent directory entries instead of hiding them as overlap', async () => {
    await expect(planZipSelection([select(folder('a'))], async () => [file('one'), file('one')])).rejects.toThrow(/重复目录项/)
    await expect(planZipSelection([select(folder('a')), select(file('one'), 'index-a')], async () => [file('one', 'changed.txt')])).rejects.toThrow(/不一致/)
  })

  it('rejects unsafe paths and archive size overflow', async () => {
    await expect(planZipSelection([select(file('a', '../secret'))], async () => [])).rejects.toThrow(/路径/)
    await expect(planZipSelection([select(file('a', 'long'.repeat(20_000)))], async () => [])).rejects.toThrow(/长度/)
    await expect(planZipSelection([select(file('a', 'a', Number.MAX_SAFE_INTEGER))], async () => [])).rejects.toThrow(/安全范围/)
  })

  it('stops traversal after cancellation without emitting a partial plan', async () => {
    const controller = new AbortController()
    await expect(planZipSelection([select(folder('a'))], async () => { controller.abort(); return [file('one')] }, controller.signal)).rejects.toThrow(/abort/i)
    controller.abort()
    const read = vi.fn(async () => [])
    await expect(planZipSelection([select(folder('a'))], read, controller.signal)).rejects.toThrow(/abort/i)
    expect(read).not.toHaveBeenCalled()
  })
})
