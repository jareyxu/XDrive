import { expect, test, vi } from 'vitest'
import { collectFolderConflicts, conflictIdentity, folderConflictSignature, planFolderConflictChoices, plannedFolderSelection } from './folder-conflicts'
import { parseFolderSelection, validateFolderMerge } from './folder-selection'
import type { ConflictEntry, FolderConflictAction } from './folder-conflicts'
import type { MergeDirectory } from './folder-selection'
const file = (path: string) => ({ name: path.split('/').at(-1)!, webkitRelativePath: path, size: 123 })
const existing = (name: string, id = name): ConflictEntry => ({ entryId: id, kind: 'file', name, fileId: `file-${id}`, size: 12, manifestSha256: 'a'.repeat(64) })
const directory = (entries: readonly ConflictEntry[]): MergeDirectory => ({ indexId: 'root', path: [], entries })
test('mixed decisions skip, preserve exact replacement identity and allocate around selected originals', () => {
  const selection = parseFolderSelection([file('r/a.txt'), file('r/a (1).txt'), file('r/b.txt'), file('r/c.txt')])
  const old = [existing('a.txt'), existing('b.txt'), existing('c.txt')]
  const dirs = new Map([['r', directory(old)]])
  const choices = new Map<string, FolderConflictAction>([['r/a.txt', 'keep-both'], ['r/b.txt', 'skip'], ['r/c.txt', 'overwrite']])
  const plan = planFolderConflictChoices(selection, dirs, choices)
  expect(plan.skippedPaths).toEqual(['r/b.txt'])
  expect(plan.records.find((item) => item.sourcePath === 'r/a.txt')).toMatchObject({ targetName: 'a (2).txt', expected: null })
  expect(plan.records.find((item) => item.sourcePath === 'r/c.txt')?.expected).toBe(old[2])
  expect(plan.records.find((item) => item.sourcePath === 'r/a (1).txt')?.file).toBe(selection.records.find((item) => item.file.name === 'a (1).txt')?.file)
  expect(old.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt', 'c.txt'])
})
test('conflicts across nested directories carry relative path and old/new size', () => {
  const selection = parseFolderSelection([file('r/x/a'), file('r/y/a')])
  const dirs = new Map([['r/x', directory([existing('a', 'x')])], ['r/y', directory([existing('a', 'y')])]])
  expect(collectFolderConflicts(selection, dirs).map((item) => [item.path, item.existing.entryId, item.incomingSize])).toEqual([['r/x/a', 'x', 123], ['r/y/a', 'y', 123]])
  const old = collectFolderConflicts(selection, dirs)
  dirs.set('r/y', directory([existing('a', 'changed')]))
  expect(folderConflictSignature(collectFolderConflicts(selection, dirs))).not.toBe(folderConflictSignature(old))
  expect(conflictIdentity({ ...existing('a'), manifestSha256: 'b'.repeat(64) })).not.toBe(conflictIdentity(existing('a')))
})
test('folder identity binds its child index and leaf folder choices plan skip, keep-both or subtree replacement', async () => {
  const selection = parseFolderSelection([file('r/a.txt')])
  const folder: ConflictEntry = { entryId: 'folder', kind: 'folder', name: 'a.txt', childIndexId: 'child' }
  const dirs = new Map([['r', directory([folder])]])
  expect(conflictIdentity(folder)).not.toBe(conflictIdentity({ ...folder, childIndexId: 'changed' }))
  expect(planFolderConflictChoices(selection, dirs, new Map([['r/a.txt', 'skip']])).records).toEqual([])
  const keep = planFolderConflictChoices(selection, dirs, new Map([['r/a.txt', 'keep-both']]))
  expect(keep.records[0]).toMatchObject({ targetName: 'a (1).txt', expected: null })
  const overwrite = planFolderConflictChoices(selection, dirs, new Map([['r/a.txt', 'overwrite']]))
  expect(overwrite.records[0]?.expected).toBe(folder)
  const destination: MergeDirectory = { indexId: 'dest', path: [], entries: [{ name: 'r', kind: 'folder', childIndexId: 'root' }] }
  await expect(validateFolderMerge(selection, destination, async () => directory([folder]))).rejects.toThrow('文件夹')
  await expect(validateFolderMerge(selection, destination, async () => directory([folder]), undefined, true, true)).resolves.toBeDefined()
})
test('an incoming folder colliding with an existing file summarizes descendants and plans skip, keep-both or atomic replacement', async () => {
  const selection = parseFolderSelection([file('r/sub/a.txt'), file('r/sub/b.txt')])
  const rootFolder: ConflictEntry = { entryId: 'root-folder', kind: 'folder', name: 'r', childIndexId: 'r-index' }
  const blocker = existing('sub', 'blocker')
  const destination = directory([rootFolder])
  const dirs = new Map<string, MergeDirectory | null>([['', destination], ['r', directory([blocker])]])
  const conflicts = collectFolderConflicts(selection, dirs)
  expect(conflicts).toMatchObject([{ path: 'r/sub', incomingKind: 'folder', incomingSize: 246, incomingFileCount: 2, existing: blocker }])

  const skip = planFolderConflictChoices(selection, dirs, new Map([['r/sub', 'skip']]))
  expect(skip.records).toEqual([])
  expect(skip.skippedPaths).toEqual(['r/sub/a.txt', 'r/sub/b.txt'])

  const keep = planFolderConflictChoices(selection, dirs, new Map([['r/sub', 'keep-both']]))
  expect(keep.records.map((item) => item.segments)).toEqual([['r', 'sub (1)', 'a.txt'], ['r', 'sub (1)', 'b.txt']])
  expect(plannedFolderSelection(keep.records).children.get('r')?.has('sub (1)')).toBe(true)

  const overwrite = planFolderConflictChoices(selection, dirs, new Map([['r/sub', 'overwrite']]))
  expect(overwrite.folderReplacements).toEqual([{ path: 'r/sub', expected: blocker }])
  expect(overwrite.records.map((item) => item.segments)).toEqual([['r', 'sub', 'a.txt'], ['r', 'sub', 'b.txt']])
  await expect(validateFolderMerge(selection, destination, async () => directory([blocker]), undefined, false)).rejects.toThrow('文件')
  await expect(validateFolderMerge(selection, destination, async () => directory([blocker]), undefined, false, true)).resolves.toBeDefined()
})
test('a selected folder root is checked against the containing directory', async () => {
  const selection = parseFolderSelection([file('bundle/a.txt')])
  const blocker = existing('bundle')
  const destination = directory([blocker])
  const dirs = await validateFolderMerge(selection, destination, vi.fn(), undefined, false, true)
  expect(collectFolderConflicts(selection, dirs)).toMatchObject([{ path: 'bundle', incomingKind: 'folder', existing: blocker }])
})
test('rejects missing, stale, extra or invalid decisions', () => {
  const selection = parseFolderSelection([file('r/a')]), dirs = new Map([['r', directory([existing('a')])]])
  for (const choices of [new Map(), new Map([['r/b', 'skip']]), new Map([['r/a', 'surprise']]), new Map([['r/a', 'skip'], ['r/b', 'skip']])]) {
    expect(() => planFolderConflictChoices(selection, dirs, choices as ReadonlyMap<string, FolderConflictAction>)).toThrow('不一致')
  }
})
test('keeping both preserves extension and dotfile spelling', () => {
  const selection = parseFolderSelection([file('r/archive.tar.gz'), file('r/.env')])
  const dirs = new Map([['r', directory([existing('archive.tar.gz'), existing('.env')])]])
  const plan = planFolderConflictChoices(selection, dirs, new Map([['r/archive.tar.gz', 'keep-both'], ['r/.env', 'keep-both']]))
  expect(plan.records.map((item) => item.targetName).sort()).toEqual(['.env (1)', 'archive.tar (1).gz'])
})
test('all skipped records produce no planned directories', () => {
  const selection = parseFolderSelection([file('r/a')]), dirs = new Map([['r', directory([existing('a')])]])
  expect(planFolderConflictChoices(selection, dirs, new Map([['r/a', 'skip']])).records).toEqual([])
})
test('chosen names are included in final union capacity and skip does not add an entry', async () => {
  const entries = Array.from({ length: 5000 }, (_, index) => existing(`f${index}`))
  const destination: MergeDirectory = { indexId: 'dest', path: [], entries: [{ kind: 'folder', name: 'r', childIndexId: 'root' }] }
  const selection = parseFolderSelection([file('r/f0')]), dirs = new Map([['r', directory(entries)]])
  const load = async () => directory(entries)
  const keep = planFolderConflictChoices(selection, dirs, new Map([['r/f0', 'keep-both']]))
  await expect(validateFolderMerge(plannedFolderSelection(keep.records), destination, load)).rejects.toThrow('5000')
  const overwrite = planFolderConflictChoices(selection, dirs, new Map([['r/f0', 'overwrite']]))
  await expect(validateFolderMerge(plannedFolderSelection(overwrite.records), destination, load)).resolves.toBeDefined()
})
