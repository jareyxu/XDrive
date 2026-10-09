export type WriterState = 'locks' | 'fallback-writer' | 'fallback-reader' | 'unavailable'
export interface OwnershipStore {
  claim(scope: string, owner: string, takeover?: boolean): Promise<boolean>
  owns(scope: string, owner: string): Promise<boolean>
  release(scope: string, owner: string): Promise<void>
}
export interface CoordinationMessage { kind: 'invalidate' | 'owner-change'; scope: string }
interface Dependencies {
  ownerId(): string
  ownership: OwnershipStore
  lock?: (name: string, signal: AbortSignal, operation: () => Promise<unknown>) => Promise<unknown>
  broadcast?: (message: CoordinationMessage) => void
}
const opaque = /^[A-Za-z0-9_-]{16,64}$/u
export function parseCoordinationMessage(value: unknown): CoordinationMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== 2 || (row.kind !== 'invalidate' && row.kind !== 'owner-change') || typeof row.scope !== 'string' || !opaque.test(row.scope)) return null
  return { kind: row.kind, scope: row.scope }
}

export class MutationCoordinator {
  private owner: string
  private epoch = 0
  private tail: Promise<unknown> = Promise.resolve()
  private active: { scope: string; signal: AbortSignal } | null = null
  private lifecycle = new AbortController()
  private scopes = new Set<string>()
  private state: WriterState
  private listeners = new Set<(state: WriterState) => void>()
  private invalidations = new Set<(scope: string) => void>()
  private readonly dependencies: Dependencies
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies
    this.owner = dependencies.ownerId()
    this.state = dependencies.lock ? 'locks' : 'fallback-reader'
  }
  getState(): WriterState { return this.state }
  subscribe(listener: (state: WriterState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  subscribeInvalidation(listener: (scope: string) => void): () => void {
    this.invalidations.add(listener)
    return () => { this.invalidations.delete(listener) }
  }
  private setState(state: WriterState): void {
    if (this.state === state) return
    this.state = state
    this.listeners.forEach((listener) => listener(state))
  }
  invalidate(scope: string): void {
    if (!opaque.test(scope)) throw new TypeError("invalid mutation scope")
    this.dependencies.broadcast?.({ kind: "invalidate", scope })
  }
  receive(value: unknown): void {
    const message = parseCoordinationMessage(value)
    if (!message) return
    if (message.kind === 'invalidate') this.invalidations.forEach((listener) => listener(message.scope))
    // Ownership notifications never grant authority. Every write checks IDB.
    if (message.kind === 'owner-change' && !this.dependencies.lock) {
      const epoch = this.epoch
      void this.dependencies.ownership.owns(message.scope, this.owner).then((owned) => {
        if (epoch === this.epoch && !owned && this.scopes.has(message.scope)) {
          this.lifecycle.abort()
          this.lifecycle = new AbortController()
          this.epoch += 1
          this.setState('fallback-reader')
        }
      }).catch(() => { this.setState('unavailable') })
    }
  }
  async prepare(scope: string, takeover = false): Promise<WriterState> {
    if (!opaque.test(scope)) throw new TypeError('invalid mutation scope')
    if (this.dependencies.lock) return 'locks'
    const epoch = this.epoch
    const owner = this.owner
    try {
      const owned = await this.dependencies.ownership.claim(scope, owner, takeover)
      if (epoch !== this.epoch) {
        if (owned) await this.dependencies.ownership.release(scope, owner)
        throw new DOMException('Writer context expired', 'AbortError')
      }
      this.scopes.add(scope)
      this.setState(owned ? 'fallback-writer' : 'fallback-reader')
      if (owned) this.dependencies.broadcast?.({ kind: 'owner-change', scope })
    } catch (error) {
      if (epoch === this.epoch) this.setState('unavailable')
      throw error
    }
    return this.state
  }
  async guard(scope: string): Promise<AbortSignal> {
    const active = this.active
    if (!active || active.scope !== scope) throw new TypeError('写操作必须通过本标签页的修改队列。')
    active.signal.throwIfAborted()
    if (!this.dependencies.lock && !(await this.dependencies.ownership.owns(scope, this.owner))) {
      this.setState('fallback-reader')
      throw new TypeError('此标签页处于只读模式。请关闭其他标签页后接管写入。')
    }
    active.signal.throwIfAborted()
    return active.signal
  }
  async run<T>(scope: string, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!opaque.test(scope)) throw new TypeError('invalid mutation scope')
    const epoch = this.epoch
    const combined = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal
    combined.throwIfAborted()
    const previous = this.tail
    const result = previous.catch(() => undefined).then(async () => {
      combined.throwIfAborted()
      if (epoch !== this.epoch) throw new DOMException('Writer context expired', 'AbortError')
      const execute = async (): Promise<T> => {
        combined.throwIfAborted()
        if (!this.dependencies.lock && await this.prepare(scope) !== 'fallback-writer') throw new TypeError('此标签页处于只读模式。请关闭其他标签页后接管写入。')
        this.active = { scope, signal: combined }
        try {
          const value = await operation(combined)
          this.dependencies.broadcast?.({ kind: 'invalidate', scope })
          return value
        } finally { this.active = null }
      }
      return this.dependencies.lock
        ? await this.dependencies.lock(`xdrive:mutation:v1:${scope}`, combined, execute) as T
        : await execute()
    })
    this.tail = result.catch(() => undefined)
    // Cancel waiting UI promptly; the queued callback still checks its signal.
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(combined.reason ?? new DOMException('Aborted', 'AbortError'))
      combined.addEventListener('abort', abort, { once: true })
      void result.then(resolve, reject).finally(() => combined.removeEventListener('abort', abort))
    })
  }
  reset(): void {
    const owner = this.owner
    const scopes = [...this.scopes]
    this.epoch += 1
    this.lifecycle.abort()
    this.lifecycle = new AbortController()
    this.owner = this.dependencies.ownerId()
    this.scopes.clear()
    for (const scope of scopes) void this.dependencies.ownership.release(scope, owner).then(() => {
      this.dependencies.broadcast?.({ kind: 'owner-change', scope })
    }).catch(() => undefined)
    this.setState(this.dependencies.lock ? 'locks' : 'fallback-reader')
  }
}
