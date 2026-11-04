import type { DriveEntry } from '../api/client'
import { isHeicImage } from './heic'
import { textPreviewKind } from './text-preview'

/** Match the preview dispatch order, including SVG's safe code preview. */
export function mediaPreviewKind(entry: DriveEntry): 'image' | 'video' | null {
  if (entry.kind !== 'file') return null
  const mime = entry.mime ?? ''
  if (mime === 'application/pdf' || entry.name.split('.').at(-1)?.toLowerCase() === 'pdf') return null
  if (mime.startsWith('video/')) return 'video'
  if (textPreviewKind(entry.name, mime)) return null
  return mime.startsWith('image/') || isHeicImage(entry.name, mime) ? 'image' : null
}

export function previewNeighbors(entries: readonly DriveEntry[], currentId: string) {
  const media = entries.filter(entry => mediaPreviewKind(entry) !== null)
  const index = media.findIndex(entry => entry.entryId === currentId)
  return { previous: index > 0 ? media[index - 1] : undefined, next: index >= 0 ? media[index + 1] : undefined }
}

export function previewArrowDirection(event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; defaultPrevented: boolean; nativeEvent: { isComposing: boolean }; target: EventTarget | null }): 'previous' | 'next' | null {
  if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
  if (event.target instanceof Element && event.target.closest('input, textarea, select, video, audio, [contenteditable]:not([contenteditable="false"]), [role="slider"]')) return null
  return event.key === 'ArrowLeft' ? 'previous' : event.key === 'ArrowRight' ? 'next' : null
}
