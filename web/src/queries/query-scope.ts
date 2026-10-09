import { QueryClient } from '@tanstack/react-query'
import { createContext, useContext } from 'react'

// Imperative lifetime, like QueryClient; these fields are not rendered state.
export class QueryOwner {
  #active = false
  #epoch = 0
  #usageRevision: number | null = null
  open() { this.#active = true; this.#epoch += 1; this.#usageRevision = null }
  close() { this.#active = false; this.#epoch += 1 }
  capture() { this.assert(this.#epoch); return this.#epoch }
  assert(epoch: number) {
    if (!this.#active || this.#epoch !== epoch) throw new DOMException('Unlocked query owner ended', 'AbortError')
  }
  observeUsageRevision(revision: number) {
    this.capture()
    const changed = this.#usageRevision !== null && this.#usageRevision !== revision
    this.#usageRevision = revision
    return changed
  }
  assertUsageRevision(revision: number, epoch: number) {
    this.assert(epoch)
    if (this.#usageRevision !== revision) throw new DOMException('Storage revision superseded', 'AbortError')
  }
}
export const OwnerContext = createContext<QueryOwner | null>(null)
export function useUnlockedQueryOwner() {
  const owner = useContext(OwnerContext)
  if (!owner) throw new Error('Server queries require an unlocked owner')
  return owner
}
export function createUnlockedQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: {
    retry: false,
    gcTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    networkMode: 'always',
  } } })
}
