import { expect, test, vi } from 'vitest'
import { parseFileSelection, validateFolderMerge } from './folder-selection'
import { collectFolderConflicts, planFolderConflictChoices, plannedFolderSelection } from './folder-conflicts'
import type { ConflictEntry } from './folder-conflicts'
import type { MergeDirectory } from './folder-selection'
const file = (name: string) => ({ name, size: 123, webkitRelativePath: '' })
const old = (name: string): ConflictEntry => ({ name, entryId: name, kind: 'file', fileId: `file-${name}` })
const directory = (entries: readonly ConflictEntry[] = []): MergeDirectory => ({ indexId: 'destination', path: [], entries })

test('flat selection preserves original references, NFC, spaces and case without a wrapper directory', async () => {
  const selected = [file(' Cafe\u0301.txt '), file('A.txt'), file('a.txt')]
  const selection = parseFileSelection(selected), destination = directory(), load = vi.fn()
  expect(selection.rootName).toBe('')
  expect([...selection.children.keys()]).toEqual([''])
  expect(selection.records.map((record) => record.segments)).toContainEqual([' Café.txt '])
  expect(selection.records.every((record) => selected.includes(record.file))).toBe(true)
  expect((await validateFolderMerge(selection, destination, load)).get('')).toBe(destination)
  expect(load).not.toHaveBeenCalled()
})
test('duplicate normalized names and unsafe names or nonflat picker paths reject before remote reads', () => {
  expect(() => parseFileSelection([file('Café.txt'), file('Cafe\u0301.txt')])).toThrow('重复')
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'bad\u0000', 'bad\u001f']) expect(() => parseFileSelection([file(name)])).toThrow('无效')
  expect(() => parseFileSelection([{ ...file('a.txt'), webkitRelativePath: 'r/a.txt' }])).toThrow('文件夹路径')
  expect(() => parseFileSelection([])).toThrow('请选择')
})
test('flat decisions preserve identity and allocate generated names around all selected originals', async () => {
  const selection = parseFileSelection(['a.txt', 'a (1).txt', 'b.txt', 'c.txt'].map(file)), destination = directory(['a.txt', 'b.txt', 'c.txt'].map(old))
  const dirs = await validateFolderMerge(selection, destination, vi.fn(), undefined, false)
  expect(collectFolderConflicts(selection, dirs).map((item) => item.path)).toEqual(['a.txt', 'b.txt', 'c.txt'])
  const plan = planFolderConflictChoices(selection, dirs, new Map([['a.txt', 'keep-both'], ['b.txt', 'skip'], ['c.txt', 'overwrite']]))
  expect(plan.records.find((record) => record.sourcePath === 'a.txt')).toMatchObject({ targetName: 'a (2).txt', segments: ['a.txt'] })
  expect(plan.records.find((record) => record.sourcePath === 'c.txt')?.expected?.entryId).toBe('c.txt')
  expect(plan.skippedPaths).toEqual(['b.txt'])
  const planned = plannedFolderSelection(plan.records)
  expect(planned.rootName).toBe('')
  expect(planned.records.every((record) => record.segments.length === 1)).toBe(true)
})
test('5000 flat files are accepted, larger selection and generated union overflow are rejected', async () => {
  const entries = Array.from({ length: 5000 }, (_, index) => old(`f${index}`))
  expect(parseFileSelection(entries.map((entry) => file(entry.name))).records.length).toBe(5000)
  expect(() => parseFileSelection([...entries.map((entry) => file(entry.name)), file('new')])).toThrow('5000')
  const selection = parseFileSelection([file('f0')]), destination = directory(entries)
  const dirs = await validateFolderMerge(selection, destination, vi.fn(), undefined, false)
  const keep = planFolderConflictChoices(selection, dirs, new Map([['f0', 'keep-both']]))
  await expect(validateFolderMerge(plannedFolderSelection(keep.records), destination, vi.fn())).rejects.toThrow('5000')
  const overwrite = planFolderConflictChoices(selection, dirs, new Map([['f0', 'overwrite']]))
  await expect(validateFolderMerge(plannedFolderSelection(overwrite.records), destination, vi.fn())).resolves.toBeDefined()
})
