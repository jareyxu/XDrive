export const IDLE_LOCK_MILLISECONDS = 10 * 60_000
export type IdleLockTask = 'upload' | 'download' | 'zip' | 'video'
interface Clock {
  wall(): number
  monotonic(): number
  schedule(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>
  cancel(timer: ReturnType<typeof setTimeout>): void
}
const browserClock: Clock = {
  wall: () => Date.now(), monotonic: () => performance.now(),
  schedule: (callback, milliseconds) => setTimeout(callback, milliseconds), cancel: (timer) => clearTimeout(timer),
}

/** Contains no key, file, password or decrypted metadata. */
export class IdleLock {
  private readonly lock: () => void
  private readonly clock: Clock
  private wall = 0
  private monotonic = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private closed = false
  private readonly holds = new Set<object>()
  constructor(lock: () => void, clock: Clock = browserClock) { this.lock = lock; this.clock = clock; this.restart() }
  private elapsed(): number { return Math.max(0, this.clock.wall() - this.wall, this.clock.monotonic() - this.monotonic) }
  private clearTimer(): void {
    this.generation += 1
    if (this.timer !== undefined) this.clock.cancel(this.timer)
    this.timer = undefined
  }
  private schedule(): void {
    this.clearTimer()
    if (this.closed || this.holds.size) return
    const generation = this.generation
    this.timer = this.clock.schedule(() => { if (generation === this.generation) this.check() }, Math.max(0, IDLE_LOCK_MILLISECONDS - this.elapsed()))
  }
  private restart(): void {
    this.wall = this.clock.wall(); this.monotonic = this.clock.monotonic(); this.schedule()
  }
  /** Check before applying new activity, so background expiry cannot be hidden. */
  check(): boolean {
    if (this.closed) return true
    if (this.holds.size) return false
    if (this.elapsed() >= IDLE_LOCK_MILLISECONDS) { this.dispose(); this.lock(); return true }
    this.schedule(); return false
  }
  activity(): boolean {
    if (this.check()) return false
    if (!this.holds.size) this.restart()
    return true
  }
  hold(kind: IdleLockTask): () => void {
    if (!['upload', 'download', 'zip', 'video'].includes(kind)) throw new TypeError('invalid automatic-lock task')
    if (this.check()) throw new DOMException('Vault idle context expired', 'AbortError')
    const token = {}
    this.holds.add(token); this.clearTimer()
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds.delete(token)
      if (!this.closed && !this.holds.size) this.restart()
    }
  }
  dispose(): void { this.closed = true; this.holds.clear(); this.clearTimer() }
}
