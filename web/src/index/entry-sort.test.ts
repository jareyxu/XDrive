import { expect, test } from 'vitest'
import type { DriveEntry } from '../api/client'
import { formatEntryModifiedAt, gridKeyboardTarget, sortEntries, splitFileExtension } from './entry-sort'
const file = (name: string, size: number, modified?: number): DriveEntry => ({ entryId: name, kind: 'file', name, size, mime: name.endsWith('.png') ? 'image/png' : 'text/plain', originalModifiedAt: modified })
const entries: DriveEntry[] = [file('file10.txt', 10, 100), file('file2.txt', 20, 200), { entryId: 'folder', kind: 'folder', name: 'folder' }, file('old.png', 1)]
test.each(['name', 'size', 'type', 'modified'] as const)('folders remain first for %s in either direction without mutating inputs', by => {
 for (const descending of [false, true]) expect(sortEntries(entries, by, descending)[0]!.kind).toBe('folder')
 expect(entries[0]!.name).toBe('file10.txt')
})
test('numeric names, exact size and MIME sort are deterministic', () => {
 expect(sortEntries(entries, 'name', false).map(e => e.name)).toEqual(['folder', 'file2.txt', 'file10.txt', 'old.png'])
 expect(sortEntries(entries, 'size', false).map(e => e.size)).toEqual([undefined, 1, 10, 20])
 expect(sortEntries(entries, 'type', false)[1]!.mime).toBe('image/png')
})
test('missing original timestamps remain last without fabricated dates in both directions', () => {
 expect(sortEntries(entries, 'modified', false).map(e => e.name)).toEqual(['folder', 'file10.txt', 'file2.txt', 'old.png'])
 expect(sortEntries(entries, 'modified', true).map(e => e.name)).toEqual(['folder', 'file2.txt', 'file10.txt', 'old.png'])
})
test('extensions remain separate while dotfiles and trailing dots remain intact', () => {
 expect(splitFileExtension('文件.long.tar.gz')).toEqual({ stem: '文件.long.tar', extension: '.gz' })
 for (const name of ['.env', 'folder', 'ending.']) expect(splitFileExtension(name)).toEqual({ stem: name, extension: '' })
})
test('original modification timestamps are formatted locally and absent/invalid values stay unknown', () => {
 expect(formatEntryModifiedAt(Date.UTC(2026, 0, 15, 12))).toContain('2026')
 for (const value of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(formatEntryModifiedAt(value)).toBe('未知')
})
test('grid navigation follows column count, clamps edges and ignores unrelated keys', () => {
 expect(gridKeyboardTarget('ArrowDown', 1, 5000, 3, 4)).toBe(4)
 expect(gridKeyboardTarget('PageDown', 1, 5000, 3, 4)).toBe(13)
 expect(gridKeyboardTarget('ArrowUp', 1, 5000, 3, 4)).toBe(0)
 expect(gridKeyboardTarget('End', 1, 5000, 3, 4)).toBe(4999)
 expect(gridKeyboardTarget('ArrowRight', 4999, 5000, 3, 4)).toBe(4999)
 expect(gridKeyboardTarget('Enter', 1, 5000, 3, 4)).toBeNull()
 expect(gridKeyboardTarget('End', 1, 0, 3, 4)).toBeNull()
})
