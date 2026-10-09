import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ActiveTransfer, TransferPhase } from './transfer-types'

interface TransferState { readonly tasks: readonly ActiveTransfer[] }
export type TransferUpdate = Partial<Pick<ActiveTransfer, 'phase' | 'completedBytes' | 'totalBytes' | 'detail'>>
export type TerminalTransferPhase = Extract<TransferPhase, 'completed' | 'failed' | 'cancelled'>
type Scheduler = (callback: () => void) => () => void
interface Removal { cancel: () => void; readonly epoch: number }
const scheduleRemoval: Scheduler = callback => {
  const timer = globalThis.setTimeout(callback, 8000)
  return () => globalThis.clearTimeout(timer)
}

// Construct per unlocked screen. No singleton, persist/devtools middleware,
// keys, File/Blob values or controllers in the observable snapshot.
export class TransferStore {
  #state = createStore<TransferState>(() => ({ tasks: [] }))
  #controllers = new Map<string, AbortController>()
  #removals = new Map<string, Removal>()
  #active = false
  #epoch = 0
  #schedule: Scheduler
  readonly store: Pick<StoreApi<TransferState>, 'getState' | 'getInitialState' | 'subscribe'>

  constructor(schedule: Scheduler = scheduleRemoval) {
    this.#schedule = schedule
    this.store = {
      getState: this.#state.getState,
      getInitialState: this.#state.getInitialState,
      subscribe: this.#state.subscribe,
    }
  }
  open() {
    if (this.#active) return
    this.#active = true; this.#epoch += 1
  }
  close() {
    if (!this.#active && this.#controllers.size === 0 && this.#removals.size === 0 && this.#state.getState().tasks.length === 0) return
    this.#active = false; this.#epoch += 1
    const controllers = [...this.#controllers.values()]
    this.#controllers.clear()
    this.#removals.forEach(removal => removal.cancel()); this.#removals.clear()
    // Drop names before abort listeners run; those listeners cannot republish.
    this.#state.setState({ tasks: [] })
    controllers.forEach(controller => controller.abort())
  }
  begin(task: ActiveTransfer, controller: AbortController): boolean {
    if (!this.#active || controller.signal.aborted) return false
    const epoch = this.#epoch
    const previous = this.#controllers.get(task.id)
    this.#clearRemoval(task.id)
    this.#controllers.set(task.id, controller)
    if (previous && previous !== controller) previous.abort()
    // Abort listeners can close/reopen or replace the task synchronously.
    if (!this.#owns(task.id, controller) || this.#epoch !== epoch || controller.signal.aborted) {
      if (this.#controllers.get(task.id) === controller) this.#controllers.delete(task.id)
      return false
    }
    this.#state.setState(current => ({ tasks: [...current.tasks.filter(item => item.id !== task.id), { ...task }] }))
    return this.#owns(task.id, controller) && this.#epoch === epoch && !controller.signal.aborted
  }
  update(id: string, controller: AbortController, update: TransferUpdate): boolean {
    if (!this.#owns(id, controller) || controller.signal.aborted) return false
    this.#state.setState(current => ({ tasks: current.tasks.map(task => task.id === id ? { ...task, ...update } : task) }))
    return true
  }
  finish(id: string, controller: AbortController, phase: TerminalTransferPhase, detail?: string): boolean {
    if (!this.#owns(id, controller)) return false
    this.#controllers.delete(id)
    this.#clearRemoval(id)
    const removal: Removal = { cancel: () => {}, epoch: this.#epoch }
    this.#removals.set(id, removal)
    removal.cancel = this.#schedule(() => {
      if (!this.#active || this.#epoch !== removal.epoch || this.#removals.get(id) !== removal) return
      this.#removals.delete(id)
      this.#state.setState(current => ({ tasks: current.tasks.filter(task => task.id !== id) }))
    })
    this.#state.setState(current => ({ tasks: current.tasks.map(task => task.id === id ? { ...task, phase, ...(detail ? { detail } : {}) } : task) }))
    return true
  }
  cancel(id: string): boolean {
    if (!this.#active) return false
    const controller = this.#controllers.get(id)
    if (!controller) return false
    controller.abort()
    // The producer reports its actual outcome; cancellation is not fake success.
    return true
  }
  #owns(id: string, controller: AbortController) {
    return this.#active && this.#controllers.get(id) === controller
  }
  #clearRemoval(id: string) {
    this.#removals.get(id)?.cancel(); this.#removals.delete(id)
  }
}
