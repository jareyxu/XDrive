import type { Preferences } from '../preferences/preferences'

export interface TransferCapabilities { uploadConcurrency: number; downloadConcurrency: number }
export const FALLBACK_CAPABILITIES: TransferCapabilities = { uploadConcurrency: 4, downloadConcurrency: 4 }
// Ciphertext, plaintext, the output copy and crypto scratch per 8 MiB chunk.
export const DOWNLOAD_CHUNK_BUDGET_MIB = 32

export function transferCeilings(preferences: Pick<Preferences, 'uploadConcurrency' | 'downloadConcurrency' | 'downloadMemoryMiB'>, server: TransferCapabilities = FALLBACK_CAPABILITIES) {
  const bufferSlots = Math.max(1, Math.floor((preferences.downloadMemoryMiB ?? 64) / DOWNLOAD_CHUNK_BUDGET_MIB))
  return {
    upload: Math.min(8, preferences.uploadConcurrency, server.uploadConcurrency),
    download: Math.min(8, preferences.downloadConcurrency ?? 4, server.downloadConcurrency, bufferSlots),
    bufferSlots,
  }
}

export function recommendedDownloadMemory(concurrency: number): number {
  return [64, 128, 256].find(size => size >= concurrency * DOWNLOAD_CHUNK_BUDGET_MIB) ?? 256
}
