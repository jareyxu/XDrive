import { expect, test } from 'vitest'
import {
  enumerateDirectoryHandle,
  enumerateWebkitDirectoryEntry,
  readDroppedSelection,
  type DirectoryHandleLike,
  type FileHandleLike,
} from './folder-input'
import { folderPathOf } from './folder-path'
import { MAX_FOLDER_NESTING, parseFolderSelection } from './folder-selection'

type WebkitEntryFixture = Parameters<typeof enumerateWebkitDirectoryEntry>[0]

const fileHandle = (name: string, value = name): FileHandleLike => ({
  kind: 'file', name,
  getFile: async () => new File([value], name),
})

const directory = (name: string, entries: readonly (FileHandleLike | DirectoryHandleLike)[]): DirectoryHandleLike => ({
  kind: 'directory', name,
  async *values() { yield* entries },
})

const transfer = (items: readonly object[]): DataTransfer => ({
  items: items as unknown as DataTransferItemList,
  files: [] as unknown as FileList,
} as DataTransfer)

const dropItem = (options: {
  handle?: FileHandleLike | DirectoryHandleLike | null
  entry?: object | null
  file?: File | null
} = {}) => ({
  kind: 'file',
  getAsFileSystemHandle: async () => options.handle ?? null,
  webkitGetAsEntry: () => options.entry ?? null,
  getAsFile: () => options.file ?? null,
})

test('enumerates native directory handles without cloning file bytes and preserves relative paths', async () => {
  const root = directory('bundle', [directory('nested', [fileHandle('inside.txt', 'real bytes')]), fileHandle('top.txt')])
  const files = await enumerateDirectoryHandle(root)
  expect(files.map((file) => [folderPathOf(file, file.webkitRelativePath), file.name])).toEqual([
    ['bundle/nested/inside.txt', 'inside.txt'],
    ['bundle/top.txt', 'top.txt'],
  ])
  expect(new TextDecoder().decode(await files[0]!.arrayBuffer())).toBe('real bytes')
  const parsed = parseFolderSelection(files)
  expect(parsed.rootName).toBe('bundle')
  expect(parsed.children.get('bundle')?.get('nested')).toBe('folder')
})

function nestedHandleTree(depth: number, leaf = fileHandle('leaf.txt')): DirectoryHandleLike {
  let child: FileHandleLike | DirectoryHandleLike = leaf
  for (let index = depth - 1; index >= 0; index -= 1) child = directory(`d${index}`, [child])
  return directory('root', [child])
}

test('bounds native directory nesting and accepts the documented maximum', async () => {
  const files = await enumerateDirectoryHandle(nestedHandleTree(MAX_FOLDER_NESTING))
  expect(parseFolderSelection(files).records[0]?.segments).toHaveLength(MAX_FOLDER_NESTING + 2)
  let fileReads = 0
  const leaf: FileHandleLike = { kind: 'file', name: 'leaf.txt', getFile: async () => { fileReads += 1; return new File(['x'], 'leaf.txt') } }
  await expect(enumerateDirectoryHandle(nestedHandleTree(MAX_FOLDER_NESTING + 1, leaf))).rejects.toThrow(`嵌套超过 ${MAX_FOLDER_NESTING} 层`)
  expect(fileReads).toBe(0)
})

test('rejects a native directory over the per-directory child limit and honors cancellation', async () => {
  const oversized = directory('too-many', Array.from({ length: 5001 }, (_, index) => fileHandle(`f${index}.txt`)))
  await expect(enumerateDirectoryHandle(oversized)).rejects.toThrow('5000 个直接子项')
  const controller = new AbortController()
  controller.abort()
  await expect(enumerateDirectoryHandle(directory('cancelled', [fileHandle('a.txt')]), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

function emptyFolderTree(extraEntry: boolean): DirectoryHandleLike {
  return {
    kind: 'directory', name: 'root',
    async *values() {
      for (let branch = 0; branch < 5000; branch += 1) {
        yield {
          kind: 'directory' as const,
          name: `branch-${branch}`,
          async *values() {
            const children = branch === 4999 && extraEntry ? 100 : 99
            for (let child = 0; child < children; child += 1) {
              yield { kind: 'directory' as const, name: `empty-${branch}-${child}`, async *values() {} }
            }
          },
        }
      }
    },
  }
}

test('bounds a folder by total file and directory entries, including empty directory trees', async () => {
  // 5,000 branches plus 99 children each is exactly 500,000 entries.
  await expect(enumerateDirectoryHandle(emptyFolderTree(false))).resolves.toHaveLength(0)
  // Empty directories do not count toward the file-only limit, so this also
  // verifies that an otherwise unproductive tree stops at the total budget.
  await expect(enumerateDirectoryHandle(emptyFolderTree(true))).rejects.toThrow('500,000 个文件与目录项')
})

function webkitFile(name: string, value = name): WebkitEntryFixture {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(success: (file: File) => void) { success(new File([value], name)) },
  }
}

function webkitDirectory(name: string, batches: readonly (readonly WebkitEntryFixture[])[]): WebkitEntryFixture {
  let batch = 0
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => ({ readEntries(success: (entries: WebkitEntryFixture[]) => void) { success([...(batches[batch++] ?? [])]) } }),
  }
}

function nestedWebkitTree(depth: number, leaf = webkitFile('leaf.txt')): WebkitEntryFixture {
  let child = leaf
  for (let index = depth - 1; index >= 0; index -= 1) child = webkitDirectory(`d${index}`, [[child], []])
  return webkitDirectory('root', [[child], []])
}

test('bounds WebKit directory nesting and accepts the documented maximum', async () => {
  const files = await enumerateWebkitDirectoryEntry(nestedWebkitTree(MAX_FOLDER_NESTING))
  expect(parseFolderSelection(files).records[0]?.segments).toHaveLength(MAX_FOLDER_NESTING + 2)
  await expect(enumerateWebkitDirectoryEntry(nestedWebkitTree(MAX_FOLDER_NESTING + 1))).rejects.toThrow(`嵌套超过 ${MAX_FOLDER_NESTING} 层`)
})

test('enumerates WebKit directory entries in repeated batches, retaining nested paths', async () => {
  const nested = webkitDirectory('sub', [[webkitFile('a.txt', 'nested')], []])
  const root = webkitDirectory('bundle', [[nested, webkitFile('top.txt')], []])
  const files = await enumerateWebkitDirectoryEntry(root)
  expect(files.map((file) => folderPathOf(file, file.webkitRelativePath))).toEqual(['bundle/sub/a.txt', 'bundle/top.txt'])
  expect(new TextDecoder().decode(await files[0]!.arrayBuffer())).toBe('nested')
})

test('reads many synchronous WebKit batches without recursive stack growth', async () => {
  const batches = Array.from({ length: 1500 }, (_, index) => [webkitFile(`f${index}.txt`)]).concat([[]])
  const files = await enumerateWebkitDirectoryEntry(webkitDirectory('bundle', batches))
  expect(files).toHaveLength(1500)
})

test('reads a dropped native folder and leaves ordinary dropped files as a flat batch', async () => {
  const root = directory('bundle', [directory('sub', [fileHandle('inside.txt')])])
  const folder = await readDroppedSelection(transfer([dropItem({ handle: root })]))
  expect(folder.kind).toBe('folder')
  if (folder.kind === 'folder') expect(folderPathOf(folder.files[0]!, folder.files[0]!.webkitRelativePath)).toBe('bundle/sub/inside.txt')

  const flat = await readDroppedSelection(transfer([dropItem({ file: new File(['one'], 'one.txt') }), dropItem({ file: new File(['two'], 'two.txt') })]))
  expect(flat.kind).toBe('files')
  if (flat.kind === 'files') expect(flat.files.map((file) => file.name)).toEqual(['one.txt', 'two.txt'])
})

test('rejects oversized flat drops before calling browser file-handle APIs', async () => {
  let touched = 0
  const items = Array.from({ length: 5001 }, () => ({
    kind: 'file',
    getAsFileSystemHandle: async () => { touched += 1; return null },
    webkitGetAsEntry: () => null,
    getAsFile: () => null,
  }))
  await expect(readDroppedSelection(transfer(items))).rejects.toThrow('超过 5000 个文件或目录项')
  expect(touched).toBe(0)
})

test('uses WebKit entry fallback and refuses mixed or empty directory drops', async () => {
  const root = webkitDirectory('bundle', [[webkitFile('inside.txt')], []])
  const folder = await readDroppedSelection(transfer([dropItem({ entry: root })]))
  expect(folder.kind).toBe('folder')
  if (folder.kind === 'folder') expect(folderPathOf(folder.files[0]!, folder.files[0]!.webkitRelativePath)).toBe('bundle/inside.txt')

  await expect(readDroppedSelection(transfer([
    dropItem({ entry: root }),
    dropItem({ file: new File(['outside'], 'outside.txt') }),
  ]))).rejects.toThrow('请一次拖入一个文件夹')
  await expect(readDroppedSelection(transfer([dropItem({ handle: directory('empty', []) })]))).rejects.toThrow('浏览器不会提供空目录条目')
})
