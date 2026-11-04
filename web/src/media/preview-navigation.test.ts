// @vitest-environment jsdom
import { expect, test } from 'vitest'
import type { DriveEntry } from '../api/client'
import { mediaPreviewKind, previewNeighbors, previewArrowDirection } from './preview-navigation'
const file = (name: string, mime: string): DriveEntry => ({ entryId: name, kind: 'file', name, mime })
test('follows displayed order across images and videos, skipping other previews and folders', () => {
  const image = file('z.jpg', 'image/jpeg'), video = file('a.mp4', 'video/mp4'), heic = file('b.HEIC', '')
  const entries = [image, file('code.svg', 'image/svg+xml'), file('notes.txt', 'text/plain'), { ...image, entryId: 'folder', kind: 'folder' as const }, video, heic]
  expect(previewNeighbors(entries, image.entryId)).toEqual({ previous: undefined, next: video })
  expect(previewNeighbors(entries, video.entryId)).toEqual({ previous: image, next: heic })
  expect(previewNeighbors(entries, heic.entryId)).toEqual({ previous: video, next: undefined })
  expect(mediaPreviewKind(heic)).toBe('image')
  expect(mediaPreviewKind(file('document.pdf', 'image/jpeg'))).toBeNull()
})
test('missing, empty and single-item navigation never wraps or selects a wrong item', () => {
  const image = file('a.jpg', 'image/jpeg')
  for (const entries of [[], [image]]) expect(previewNeighbors(entries, 'missing')).toEqual({ previous: undefined, next: undefined })
  expect(previewNeighbors([image], image.entryId)).toEqual({ previous: undefined, next: undefined })
})
const event = (target: EventTarget | null = null) => ({ key: 'ArrowRight', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, nativeEvent: { isComposing: false }, target })
test('arrow shortcuts preserve editing, video seeking, slider and modified keys', () => {
  expect(previewArrowDirection(event())).toBe('next')
  expect(previewArrowDirection({ ...event(), key: 'ArrowLeft' })).toBe('previous')
  for (const tag of ['input', 'textarea', 'select', 'video', 'audio']) expect(previewArrowDirection(event(document.createElement(tag)))).toBeNull()
  const editable = document.createElement('div'); editable.contentEditable = 'true'; editable.setAttribute('contenteditable', 'true')
  expect(previewArrowDirection(event(editable))).toBeNull()
  for (const property of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'defaultPrevented']) expect(previewArrowDirection({ ...event(), [property]: true })).toBeNull()
  expect(previewArrowDirection({ ...event(), key: 'Escape' })).toBeNull()
})
