import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { isDirectoryIndex, isFileManifest, isTrashIndex } from './client'
import type { DriveEntry } from './client'
import { isUploadResumeRecord } from '../uploads/resume'
import { parseStrictJson } from '../crypto/strict-json'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/client-payload-schemas-v1.json', import.meta.url), 'utf8')) as {
  directoryIndexes: Record<string, unknown>[]
  fileManifests: { entry: DriveEntry; manifest: Record<string, unknown> }[]
  trashIndex: Record<string, unknown>
  uploadResumeRecords: Record<string, unknown>[]
}

test('shared directory fixtures cover root, nested folders, optional timestamps, empty files, and WebP/JPEG references', () => {
  const [root, nested] = fixture.directoryIndexes
  expect(isDirectoryIndex(root, String(root?.indexId))).toBe(true)
  expect(isDirectoryIndex(nested, String(nested?.indexId))).toBe(true)
  expect(isDirectoryIndex(root, 'different-index-000001')).toBe(false)

  const entries = root?.entries as Record<string, unknown>[]
  expect(entries[0]).toMatchObject({ kind: 'folder', createdAt: 1791320400000 })
  expect(entries[1]?.thumbnail).toMatchObject({ mime: 'image/webp', width: 128, height: 64 })
  expect(entries[2]).toMatchObject({ size: 0, name: 'empty.bin' })
  expect(Object.hasOwn(entries[2]!, 'createdAt')).toBe(false)
  expect(Object.hasOwn(entries[2]!, 'originalModifiedAt')).toBe(false)
  const nestedFile = (nested?.entries as Record<string, unknown>[] | undefined)?.[0]
  expect(nestedFile?.thumbnail).toMatchObject({ mime: 'image/jpeg', keyVersion: 2 })

  const withUnknownKey = structuredClone(root!)
  withUnknownKey.unrecognized = true
  expect(isDirectoryIndex(withUnknownKey, String(root?.indexId))).toBe(false)
  const duplicateName = structuredClone(root!)
  const duplicateEntries = duplicateName.entries as Record<string, unknown>[]
  duplicateEntries[2] = { ...duplicateEntries[2], name: duplicateEntries[1]?.name }
  expect(isDirectoryIndex(duplicateName, String(root?.indexId))).toBe(false)
  const badTimestamp = structuredClone(root!)
  ;((badTimestamp.entries as Record<string, unknown>[])[0]!).createdAt = -1
  expect(isDirectoryIndex(badTimestamp, String(root?.indexId))).toBe(false)
})

test('shared manifest fixtures cover legacy schemas v1/v2, schema-v3 zero-byte and recorded non-default chunk layouts', () => {
  expect(fixture.fileManifests).toHaveLength(4)
  for (const item of fixture.fileManifests) expect(isFileManifest(item.manifest, item.entry), item.entry.name).toBe(true)
  expect(fixture.fileManifests[0]?.manifest).toMatchObject({ version: 1, chunks: [] })
  expect(fixture.fileManifests[1]?.manifest).toMatchObject({ version: 2, fileId: 'legacy-v2-file-id-01', size: 3, chunks: [{ plaintextSize: 3 }] })
  expect(fixture.fileManifests[2]?.manifest).toMatchObject({ version: 3, chunkSize: 8 * 1024 * 1024, chunkCount: 0, chunks: [] })
  expect(fixture.fileManifests[3]?.manifest).toMatchObject({ chunkSize: 2, chunkCount: 2 })

  const unknownKey = { ...fixture.fileManifests[2]!.manifest, unexpected: true }
  expect(isFileManifest(unknownKey, fixture.fileManifests[2]!.entry)).toBe(false)
  const wrongChunk = structuredClone(fixture.fileManifests[3]!.manifest)
  ;((wrongChunk.chunks as Record<string, unknown>[])[1]!).plaintextSize = 2
  expect(isFileManifest(wrongChunk, fixture.fileManifests[3]!.entry)).toBe(false)
  const wrongEntryIdentity = { ...fixture.fileManifests[2]!.entry, fileCryptoVersion: 1 as const }
  expect(isFileManifest(fixture.fileManifests[2]!.manifest, wrongEntryIdentity)).toBe(false)
})

test('shared trash fixture validates root identity, original path, item, and deletion time', () => {
  const id = String(fixture.trashIndex.indexId)
  expect(isTrashIndex(fixture.trashIndex, id)).toBe(true)
  expect(isTrashIndex(fixture.trashIndex, 'other-trash-index-0001')).toBe(false)

  const withUnknownKey = structuredClone(fixture.trashIndex)
  withUnknownKey.extra = true
  expect(isTrashIndex(withUnknownKey, id)).toBe(false)
  const invalidTime = structuredClone(fixture.trashIndex)
  ;((invalidTime.entries as Record<string, unknown>[])[0]!).deletedAt = 0
  expect(isTrashIndex(invalidTime, id)).toBe(false)
  const duplicateRoot = structuredClone(fixture.trashIndex)
  const entries = duplicateRoot.entries as Record<string, unknown>[]
  entries.push(structuredClone(entries[0]!))
  expect(isTrashIndex(duplicateRoot, id)).toBe(false)
  const invalidPath = structuredClone(fixture.trashIndex)
  const root = (invalidPath.entries as Record<string, unknown>[])[0]!
  ;((root.originalPath as Record<string, unknown>[])[0]!).unexpected = true
  expect(isTrashIndex(invalidPath, id)).toBe(false)
})

test('all four encrypted recovery payload generations have accepted fixtures and strict version boundaries', () => {
  expect(fixture.uploadResumeRecords.map((record) => record.version)).toEqual([1, 2, 3, 4])
  for (const record of fixture.uploadResumeRecords) expect(isUploadResumeRecord(record), `recovery v${record.version}`).toBe(true)

  for (const version of [0, 5, '1', null]) expect(isUploadResumeRecord({ ...fixture.uploadResumeRecords[0], version })).toBe(false)
  expect(isUploadResumeRecord({ ...fixture.uploadResumeRecords[0], unknownField: true })).toBe(false)
  expect(isUploadResumeRecord({ ...fixture.uploadResumeRecords[3], fileCryptoVersion: 3 })).toBe(false)
  expect(isUploadResumeRecord({ ...fixture.uploadResumeRecords[3], thumbnail: { reference: {}, ciphertext: 'AA==' } })).toBe(false)
})

test('encrypted plaintext fixture with escaped duplicate key is rejected before schema validation', () => {
  const duplicate = readFileSync(new URL('./fixtures/duplicate-directory-key.json.txt', import.meta.url), 'utf8')
  expect(() => parseStrictJson(duplicate)).toThrow(/duplicate/i)
})
