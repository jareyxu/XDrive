import { describe, expect, it } from 'vitest'
import type { DirectoryState, DriveEntry } from '../api/client'
import { assessMoveDrop, selectedMoveRoots } from './move-drop'
import type { ZipSelection } from './zip-selection'

const file = (id: string, name = id): DriveEntry => ({ entryId: id, name, kind: 'file' })
const folder = (id: string, childIndexId: string, name = id): DriveEntry => ({ entryId: id, name, kind: 'folder', childIndexId })
const choose = (entry: DriveEntry, parentIndexId: string, parentPath: ZipSelection['parentPath'] = []): ZipSelection => ({ entry, parentIndexId, parentPath })
const target = (indexId: string, entries: readonly DriveEntry[] = [], path: DirectoryState['path'] = []): DirectoryState => ({ indexId, revision: 1, entries, path })

describe('folder drop preflight', () => {
 it('coalesces selected descendants under the selected folder and keeps disjoint selections', () => {
  const tree = folder('tree-entry', 'tree-index', 'tree')
  const child = file('child-entry')
  const selected = [choose(child, 'tree-index', [{ indexId: 'root', name: 'tree' }]), choose(tree, 'root'), choose(file('separate'), 'root')]
  expect(selectedMoveRoots(selected).map(item => item.entry.entryId)).toEqual(['tree-entry', 'separate'])
  expect(assessMoveDrop(target('destination'), selected)).toEqual({ state: 'allowed', count: 2 })
 })

 it('rejects folder cycles, direct child overflow, and normalized name collisions', () => {
  const parent = folder('parent-entry', 'parent-index')
  const selection = choose(parent, 'root')
  expect(assessMoveDrop(target('parent-index'), [selection]).state).toBe('cycle')
  expect(assessMoveDrop(target('descendant', [], [{ indexId: 'parent-index', name: 'parent' }]), [selection]).state).toBe('cycle')
  expect(assessMoveDrop(target('target', Array.from({ length: 5000 }, (_, index) => file(`item-${index}`))), [choose(file('new'), 'root')]).state).toBe('full')
  expect(assessMoveDrop(target('target', [file('existing', 'é')]), [choose(file('new', 'e\u0301'), 'root')]).state).toBe('conflict')
 })

 it('reports selections already in the target without proposing a mutation', () => {
  expect(assessMoveDrop(target('target'), [choose(file('same'), 'target')])).toEqual({ state: 'same', message: '所选项目已在此文件夹中。' })
 })
})
