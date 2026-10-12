import { useSyncExternalStore } from 'react'
import { deleteSystemWallpaper, fetchSystemWallpaper, SYSTEM_WALLPAPER_MAX_BYTES, uploadSystemWallpaper } from '../api/client'

export const MAX_WALLPAPER_BYTES = SYSTEM_WALLPAPER_MAX_BYTES
export const WALLPAPER_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const

interface WallpaperSnapshot {
  readonly ready: boolean
  readonly url: string | null
}

let snapshot: WallpaperSnapshot = Object.freeze({ ready: false, url: null })
let currentURL: string | null = null
const listeners = new Set<() => void>()
let initialization: Promise<void> | null = null
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('xdrive-wallpaper-v1')

function publish(blob: Blob | null): void {
  if (currentURL) URL.revokeObjectURL(currentURL)
  currentURL = blob ? URL.createObjectURL(blob) : null
  if (currentURL) document.documentElement.style.setProperty('--xdrive-wallpaper-image', `url("${currentURL}")`)
  else document.documentElement.style.removeProperty('--xdrive-wallpaper-image')
  snapshot = Object.freeze({ ready: true, url: currentURL })
  for (const listener of listeners) listener()
}

export function initializeWallpaper(): Promise<void> {
  initialization ??= refreshWallpaper().catch(() => publish(null))
  return initialization
}

export async function refreshWallpaper(): Promise<void> {
  const blob = await fetchSystemWallpaper()
  publish(blob && isSupportedWallpaper(blob) ? blob : null)
}

export function useWallpaper(): WallpaperSnapshot {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener) },
    () => snapshot,
  )
}

export function isSupportedWallpaper(file: Blob): boolean {
  return WALLPAPER_TYPES.includes(file.type as typeof WALLPAPER_TYPES[number]) && file.size > 0 && file.size <= MAX_WALLPAPER_BYTES
}

export async function saveWallpaper(file: File): Promise<void> {
  if (!isSupportedWallpaper(file)) throw new Error('请选择不超过 10 MiB 的 JPG、PNG、WebP 或 AVIF 图片。')
  await uploadSystemWallpaper(file)
  publish(file)
  channel?.postMessage('changed')
}

export async function clearWallpaper(): Promise<void> {
  await deleteSystemWallpaper()
  publish(null)
  channel?.postMessage('changed')
}

if (channel) channel.onmessage = () => { void refreshWallpaper().catch(() => undefined) }

function refreshWallpaperWhenVisible(): void {
  if (document.visibilityState === 'visible') void refreshWallpaper().catch(() => undefined)
}

window.addEventListener('focus', refreshWallpaperWhenVisible)
document.addEventListener('visibilitychange', refreshWallpaperWhenVisible)
