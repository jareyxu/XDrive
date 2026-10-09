import { createStore } from 'zustand/vanilla'
import type { DriveEntry } from '../api/client'
import { updateEntrySelection, type SelectionAnchor } from './entry-selection'
import type { ZipSelection } from './zip-selection'

interface SelectionState {
  readonly focusedId: string
  readonly anchor: SelectionAnchor | null
  readonly selections: ReadonlyMap<string, ZipSelection>
}

// Per unlocked screen; snapshots can contain decrypted names/paths. Never
// persist, broadcast or expose this store through developer tools.
export class SelectionStore {
  #state = createStore<SelectionState>(() => ({ focusedId: '', anchor: null, selections: new Map() }))
  #active = false
  readonly store = { getState: this.#state.getState, getInitialState: this.#state.getInitialState, subscribe: this.#state.subscribe }
  open() { this.#active = true }
  close() {
    const state = this.#state.getState()
    if (!this.#active && !state.focusedId && !state.anchor && state.selections.size === 0) return
    this.#active = false
    this.#state.setState({ focusedId: '', anchor: null, selections: new Map() })
  }
  focus(focusedId: string) { if (this.#active) this.#state.setState({ focusedId }) }
  navigate() { if (this.#active) this.#state.setState({ focusedId: '', anchor: null }) }
  clear() { if (this.#active) this.#state.setState({ anchor: null, selections: new Map() }) }
  complete(confirmed: readonly ZipSelection[]) {
    if (!this.#active) return
    const current = this.#state.getState()
    const selections = new Map(current.selections)
    let anchor = current.anchor
    for (const snapshot of confirmed) {
      const id = snapshot.entry.entryId
      // A checkbox toggle or select-all creates a new snapshot, even for the
      // same ID. An older operation must not consume that newer interaction.
      if (selections.get(id) !== snapshot) continue
      selections.delete(id)
      if (anchor?.entryId === id && anchor.directoryId === snapshot.parentIndexId) anchor = null
    }
    if (selections.size !== current.selections.size) this.#state.setState({ selections, anchor })
  }
  select(entries: readonly DriveEntry[], directoryId: string, parentPath: ZipSelection['parentPath'], mode: 'toggle' | 'range' | 'all', targetId?: string) {
    if (!this.#active) return
    const current = this.#state.getState()
    const selections = updateEntrySelection(current.selections, entries, directoryId, parentPath, mode, targetId, current.anchor)
    if (selections === current.selections) return
    const anchor = mode === 'all' ? current.anchor : mode !== 'range' || !current.anchor || current.anchor.directoryId !== directoryId
      ? { directoryId, entryId: targetId! } : current.anchor
    this.#state.setState({ selections, anchor })
  }
  check(selection: ZipSelection, checked: boolean) {
    if (!this.#active) return
    const selections = new Map(this.#state.getState().selections)
    if (checked) selections.set(selection.entry.entryId, selection)
    else selections.delete(selection.entry.entryId)
    this.#state.setState({ selections, anchor: { directoryId: selection.parentIndexId, entryId: selection.entry.entryId } })
  }
}
