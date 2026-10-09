export interface RevisionObservation {
  readonly kind: 'config' | 'vault' | 'metadata'
  readonly revision: number
  readonly metadataId?: string
}

export interface RollbackFinding extends RevisionObservation {
  readonly maximumSeen: number
}

const databaseName = 'xdrive-revisions-v1'
const storeName = 'maxima'
const opaqueId = /^[A-Za-z0-9_-]{16,64}$/u

export async function observeRevisionBaseline(vaultId: string, observations: readonly RevisionObservation[]): Promise<RollbackFinding | null> {
  return writeMaxima(vaultId, observations, true)
}

export async function recordRevisionMaxima(vaultId: string, observations: readonly RevisionObservation[]): Promise<void> {
  await writeMaxima(vaultId, observations, false)
}

async function writeMaxima(vaultId: string, observations: readonly RevisionObservation[], detectRollback: boolean): Promise<RollbackFinding | null> {
  const keys = observations.map((observation) => keyFor(vaultId, observation))
  if (new Set(keys).size !== keys.length) throw new TypeError('duplicate revision observation')
  if (keys.length === 0) return null
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const prior: number[] = Array.from({ length: keys.length }, () => 0)
    let remaining = keys.length
    let finding: RollbackFinding | null = null
    transaction.oncomplete = () => { database.close(); resolve(finding) }
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('revision baseline transaction aborted')) }
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('revision baseline transaction failed')) }
    keys.forEach((key, index) => {
      const request = store.get(key)
      request.onsuccess = () => {
        const row: unknown = request.result
        if (row !== undefined && !validRow(row, key)) { transaction.abort(); return }
        prior[index] = row === undefined ? 0 : (row as { revision: number }).revision
        remaining -= 1
        if (remaining !== 0) return
        for (let current = 0; current < observations.length; current += 1) {
          const observation = observations[current]!
          if (detectRollback && observation.revision < prior[current]!) {
            finding = { ...observation, maximumSeen: prior[current]! }
            return
          }
        }
        observations.forEach((observation, current) => {
          if (observation.revision > prior[current]!) store.put({ key: keys[current], revision: observation.revision })
        })
      }
    })
  })
}

export async function replaceRevisionBaseline(vaultId: string, observations: readonly RevisionObservation[]): Promise<void> {
  const keys = observations.map((observation) => keyFor(vaultId, observation))
  if (new Set(keys).size !== keys.length) throw new TypeError('duplicate revision observation')
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const lower = `${vaultId}:`
    const upper = `${vaultId}:\uffff`
    let request: IDBRequest<IDBValidKey[]>
    try { request = store.getAllKeys(IDBKeyRange.bound(lower, upper)) }
    catch (error) { transaction.abort(); database.close(); reject(error); return }
    request.onsuccess = () => {
      for (const key of request.result) store.delete(key)
      observations.forEach((observation, index) => store.put({ key: keys[index], revision: observation.revision }))
    }
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('revision baseline reset aborted')) }
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('revision baseline reset failed')) }
  })
}

function keyFor(vaultId: string, observation: RevisionObservation): string {
  if (!opaqueId.test(vaultId) || !Number.isSafeInteger(observation.revision) || observation.revision < 0) throw new TypeError('invalid revision baseline value')
  if (observation.kind === 'metadata') {
    if (!observation.metadataId || !opaqueId.test(observation.metadataId)) throw new TypeError('invalid metadata baseline ID')
    return `${vaultId}:metadata:${observation.metadataId}`
  }
  if (observation.metadataId !== undefined) throw new TypeError('unexpected metadata baseline ID')
  return `${vaultId}:${observation.kind}`
}

function validRow(value: unknown, key: string): value is { key: string; revision: number } {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).length === 2 && row.key === key && Number.isSafeInteger(row.revision) && Number(row.revision) >= 0
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: 'key' }) }
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result) }
    request.onerror = () => reject(request.error)
    request.onblocked = () => { blocked = true; reject(new Error('revision baseline storage is blocked')) }
  })
}
