import { describe, expect, it } from 'vitest'
import type { DirectoryState, DriveEntry } from '../api/client'
import { planMoveSelection, relocatedMovePath } from './move-selection'

const file = (entryId: string, name = entryId): DriveEntry => ({ entryId, name, kind: 'file', fileId: entryId, manifestObjectId: entryId, size: 1 })
const folder = (entryId: string, childIndexId: string): DriveEntry => ({ entryId, name: entryId, kind: 'folder', childIndexId })
const directory = (indexId: string, entries: readonly DriveEntry[] = [], ancestors: readonly string[] = []): DirectoryState => ({ indexId, revision: 1, entries, path: ancestors.map((id) => ({ indexId: id, name: id })) })

describe('atomic cross-directory move planning', () => {
  it('rebuilds displayed paths when the viewed folder or an ancestor moves', () => {
    const target = directory('target', [], ['root'])
    const moving = [{ entry: folder('A', 'child'), parentIndexId: 'root' }]
    const direct = directory('child', [], ['root'])
    expect(relocatedMovePath(direct, target, moving)).toEqual([...target.path, { indexId: 'target', name: 'A' }])
    const nested = directory('nested', [], ['root', 'child'])
    expect(relocatedMovePath(nested, target, moving)).toEqual([...target.path, { indexId: 'target', name: 'A' }, nested.path[1]!])
    expect(relocatedMovePath(directory('unrelated'), target, moving)).toEqual([])
  })
  it('removes each source and appends all roots to one target without mutating inputs', () => {
    const a = directory('a', [file('one'), file('keep')]); const b = directory('b', [file('two')]); const target = directory('target')
    const plan = planMoveSelection([{ entry: a.entries[0]!, parentIndexId: 'a' }, { entry: b.entries[0]!, parentIndexId: 'b' }], new Map([['a', a], ['b', b]]), target)
    expect(plan.movedCount).toBe(2)
    expect(plan.changes.get('a')?.map((entry) => entry.name)).toEqual(['keep'])
    expect(plan.changes.get('b')).toEqual([])
    expect(plan.changes.get('target')?.map((entry) => entry.name)).toEqual(['one', 'two'])
    expect(a.entries).toHaveLength(2)
  })

  it.each([false, true])('deduplicates ancestor/descendant selections independent of order (%s)', (reverse) => {
    const parent = folder('parent', 'child'); const nested = file('nested')
    const root = directory('root', [parent]); const child = directory('child', [nested], ['root'])
    const selected = [{ entry: parent, parentIndexId: 'root' }, { entry: nested, parentIndexId: 'child' }]
    const plan = planMoveSelection(reverse ? selected.reverse() : selected, new Map([['root', root], ['child', child]]), directory('target'))
    expect(plan.movedCount).toBe(1)
    expect(plan.changes.has('child')).toBe(false)
    expect(plan.changes.get('target')).toEqual([parent])
  })

  it('keeps already-target items and moves the other sources only', () => {
    const a = directory('a', [file('one')]); const target = directory('target', [file('two')])
    const selections = [{ entry: a.entries[0]!, parentIndexId: 'a' }, { entry: target.entries[0]!, parentIndexId: 'target' }]
    expect(planMoveSelection(selections, new Map([['a', a], ['target', target]]), target).movedCount).toBe(1)
  })

  it('rejects NFC name collisions between sources before producing a plan', () => {
    const a = directory('a', [file('one', 'e\u0301')]); const b = directory('b', [file('two', 'é')])
    expect(() => planMoveSelection([{ entry: a.entries[0]!, parentIndexId: 'a' }, { entry: b.entries[0]!, parentIndexId: 'b' }], new Map([['a', a], ['b', b]]), directory('target'))).toThrow('同名')
  })

  it('rejects moves into the selected folder or a descendant', () => {
    const entry = folder('parent', 'child'); const source = directory('source', [entry])
    for (const target of [directory('child'), directory('descendant', [], ['root', 'child'])]) {
      expect(() => planMoveSelection([{ entry, parentIndexId: 'source' }], new Map([['source', source]]), target)).toThrow('自身')
    }
  })

  it('rejects stale selections and duplicate parent ownership', () => {
    const entry = file('one'); const a = directory('a', [entry]); const b = directory('b', [entry])
    expect(() => planMoveSelection([{ entry, parentIndexId: 'missing' }], new Map(), directory('target'))).toThrow('重新选择')
    expect(() => planMoveSelection([{ entry, parentIndexId: 'a' }, { entry, parentIndexId: 'b' }], new Map([['a', a], ['b', b]]), directory('target'))).toThrow('父目录')
  })

  it('rejects capacity overflow before changing any source', () => {
    const source = directory('a', [file('one')]); const target = directory('target', Array.from({ length: 5000 }, (_, index) => file(String(index))))
    expect(() => planMoveSelection([{ entry: source.entries[0]!, parentIndexId: 'a' }], new Map([['a', source]]), target)).toThrow('5000')
    expect(source.entries).toHaveLength(1)
  })
})
