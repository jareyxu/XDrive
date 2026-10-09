import { MutationCoordinator } from './mutation-coordinator'
import type { OwnershipStore } from './mutation-coordinator'

const ownership: OwnershipStore = {
  claim: (scope, owner, takeover = false) => ownerTransaction(scope, owner, 'claim', takeover),
  owns: (scope, owner) => ownerTransaction(scope, owner, 'owns'),
  release: async (scope, owner) => { await ownerTransaction(scope, owner, 'release') },
}
function ownerTransaction(scope: string, owner: string, action: 'claim' | 'owns' | 'release', takeover = false): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open('xdrive-writer-v1', 1)
    opening.onupgradeneeded = () => { opening.result.createObjectStore('owners', { keyPath: 'scope' }) }
    opening.onerror = () => reject(opening.error)
    let abandoned = false
    opening.onblocked = () => { abandoned = true; reject(new TypeError('无法打开标签页写入登记。')) }
    opening.onsuccess = () => {
      const database = opening.result
      if (abandoned) { database.close(); return }
      database.onversionchange = () => database.close()
      const transaction = database.transaction('owners', action === 'owns' ? 'readonly' : 'readwrite')
      const store = transaction.objectStore('owners')
      const request = store.get(scope)
      let result = false
      request.onsuccess = () => {
        const row: unknown = request.result
        if (row !== undefined && (!row || typeof row !== 'object' || (row as { scope?: unknown }).scope !== scope || typeof (row as { owner?: unknown }).owner !== 'string')) { transaction.abort(); return }
        const prior = row as { owner: string } | undefined
        result = prior?.owner === owner
        if (action === 'claim' && (!prior || result || takeover)) { store.put({ scope, owner }); result = true }
        if (action === 'release' && result) store.delete(scope)
      }
      transaction.oncomplete = () => { database.close(); resolve(result) }
      transaction.onabort = () => { database.close(); reject(transaction.error ?? new TypeError('标签页写入登记事务失败。')) }
      transaction.onerror = () => { database.close(); reject(transaction.error ?? new TypeError('标签页写入登记不可用。')) }
    }
  })
}
const channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('xdrive-mutations-v1') : null
export const browserMutations = new MutationCoordinator({
  ownerId: () => crypto.randomUUID(),
  ownership,
  lock: typeof navigator !== 'undefined' && navigator.locks ? async (name, signal, operation) => navigator.locks.request(name, { mode: 'exclusive', signal }, operation) : undefined,
  broadcast: (message) => channel?.postMessage(message),
})
if (channel) channel.onmessage = (event) => browserMutations.receive(event.data)
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => browserMutations.reset())
