import { expect, test, vi } from 'vitest'
import { isValidFileName, MAX_FOLDER_NESTING, parseFolderSelection, validateFolderMerge } from './folder-selection'
import type { FolderSource, MergeDirectory } from './folder-selection'
const file = (path: string): FolderSource => ({ name: path.split('/').at(-1)!, webkitRelativePath: path })
const directory = (indexId: string, entries: MergeDirectory['entries'] = []): MergeDirectory => ({ indexId, entries, path: [] })
test('preserves spaces and case while normalizing Unicode paths', () => {
  const plan = parseFolderSelection([file(' root /Cafe\u0301/ a.txt '), file(' root /A.txt'), file(' root /a.txt')])
  expect(plan.rootName).toBe(' root ')
  expect(plan.records.some((item) => item.segments.join('/') === ' root /Café/ a.txt ')).toBe(true)
  expect(plan.children.get(' root ')?.size).toBe(3)
  expect(isValidFileName(' a.txt ')).toBe(true)
})
test('rejects duplicates after NFC and file/folder ambiguity before any writes', () => {
  expect(() => parseFolderSelection([file('r/Café.txt'), file('r/Cafe\u0301.txt')])).toThrow('重复')
  expect(() => parseFolderSelection([file('r/a'), file('r/a/b.txt')])).toThrow('同时表示')
  expect(() => parseFolderSelection([file('r/a/b.txt'), file('r/a')])).toThrow('同时表示')
  expect(() => parseFolderSelection([{ name: 'different.txt', webkitRelativePath: 'r/a.txt' }])).toThrow('不一致')
})
test.each(['r/../a.txt', 'r//a.txt', '/r/a.txt', 'r/./a.txt', 'r/bad\u0000.txt', 'r/a\\b.txt'])('rejects unsafe path %s', (path) => {
  expect(() => parseFolderSelection([file(path)])).toThrow()
})
test('accepts the maximum directory nesting and rejects the next level', () => {
  const atLimit = `root/${Array.from({ length: MAX_FOLDER_NESTING }, (_, index) => `d${index}`).join('/')}/leaf.txt`
  const overLimit = `root/${Array.from({ length: MAX_FOLDER_NESTING + 1 }, (_, index) => `d${index}`).join('/')}/leaf.txt`
  expect(parseFolderSelection([file(atLimit)]).records[0]?.segments).toHaveLength(MAX_FOLDER_NESTING + 2)
  expect(() => parseFolderSelection([file(overLimit)])).toThrow(`嵌套超过 ${MAX_FOLDER_NESTING} 层`)
})
test('rejects different selected roots and preserves original File references', () => {
  const original = file('r/a.txt')
  expect(parseFolderSelection([original]).records[0]!.file).toBe(original)
  expect(() => parseFolderSelection([original, file('other/b.txt')])).toThrow('一个')
})
test('5000 direct children accepted, 5001 rejected including selected folders', () => {
  const files = Array.from({ length: 5000 }, (_, index) => file(`r/f${index}.txt`))
  expect(parseFolderSelection(files).children.get('r')?.size).toBe(5000)
  expect(() => parseFolderSelection([...files, file('r/new/b.txt')])).toThrow('5000')
})
test('file-count cap rejects before reading paths, exact cap is accepted as a valid 50-directory tree', () => {
  const unread = { get name(): string { throw new Error('must not read') }, get webkitRelativePath(): string { throw new Error('must not read') } }
  expect(() => parseFolderSelection(Array.from({ length: 250001 }, () => unread))).toThrow('250,000')
  const files = Array.from({ length: 250000 }, (_, index) => file(`r/d${Math.floor(index / 5000)}/f${index % 5000}.txt`))
  const result = parseFolderSelection(files)
  expect(result.records.length).toBe(250000)
  expect(result.children.get('r')?.size).toBe(50)
  expect(result.children.get('r/d49')?.size).toBe(5000)
}, 20_000)
test('checks existing plus incoming names without double counting replacements', async () => {
  const existing = Array.from({ length: 4999 }, (_, index) => ({ name: `f${index}.txt`, kind: 'file' as const }))
  const target = directory('dest', [{ name: 'r', kind: 'folder', childIndexId: 'root' }])
  const load = vi.fn(async () => directory('root', existing))
  const snapshots = await validateFolderMerge(parseFolderSelection([file('r/f0.txt'), file('r/new.txt')]), target, load)
  expect(snapshots.get('r')?.entries).toBe(existing)
  await expect(validateFolderMerge(parseFolderSelection([file('r/new.txt'), file('r/another.txt')]), target, load)).rejects.toThrow('5000')
  expect(load).toHaveBeenCalled()
})
test('preflights nested existing directories and catches a later structural conflict', async () => {
  const target = directory('dest', [{ name: 'r', kind: 'folder', childIndexId: 'root' }])
  const load = vi.fn(async (id: string) => id === 'root'
    ? directory('root', [{ name: 'nested', kind: 'folder', childIndexId: 'nested-id' }])
    : directory('nested-id', [{ name: 'block', kind: 'file' }]))
  await expect(validateFolderMerge(parseFolderSelection([file('r/valid.txt'), file('r/nested/block/next.txt')]), target, load)).rejects.toThrow('现有文件')
  expect(load.mock.calls.map((call) => call[0])).toEqual(['root', 'nested-id'])
})
test('new subtree needs no reads and full destination rejects creating root', async () => {
  const load = vi.fn(async () => directory('unexpected'))
  const plan = parseFolderSelection([file('r/a/b.txt')])
  await validateFolderMerge(plan, directory('dest'), load)
  expect(load).not.toHaveBeenCalled()
  const full = directory('dest', Array.from({ length: 5000 }, (_, index) => ({ name: `f${index}`, kind: 'file' as const })))
  await expect(validateFolderMerge(plan, full, load)).rejects.toThrow('5000')
})
test('aborted preflight does not enumerate remote folders', async () => {
  const controller = new AbortController(); controller.abort()
  const load = vi.fn(async () => directory('unexpected'))
  await expect(validateFolderMerge(parseFolderSelection([file('r/a.txt')]), directory('dest'), load, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(load).not.toHaveBeenCalled()
})
