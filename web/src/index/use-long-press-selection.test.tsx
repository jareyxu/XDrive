// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { PointerEvent } from 'react'
import { useLongPressSelection } from './use-long-press-selection'
beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers() })
const event = (changes = {}) => ({ pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 20, clientY: 20, target: document.createElement('button'), ...changes }) as unknown as PointerEvent<HTMLElement>
test('long press activates once, consumes its follow-up click and does not suppress the next intentional touch', () => {
 const activate = vi.fn(), view = renderHook(() => useLongPressSelection('dir', activate))
 view.result.current.down(event(), 'one'); act(() => vi.advanceTimersByTime(500)); expect(activate).toHaveBeenCalledExactlyOnceWith('one')
 expect(view.result.current.touchContext('one')).toBe(true)
 view.result.current.up(event()); expect(view.result.current.consumeClick('one')).toBe(true); expect(view.result.current.consumeClick('one')).toBe(false)
 view.result.current.down(event(), 'one'); view.result.current.up(event()); expect(view.result.current.consumeClick('one')).toBe(false)
})
test('normal tap, moved/scrolling touch, cancelled pointer, mouse and nonprimary touch never select later', () => {
 const activate = vi.fn(), view = renderHook(() => useLongPressSelection('dir', activate))
 view.result.current.down(event(), 'one'); act(() => vi.advanceTimersByTime(100)); view.result.current.up(event())
 view.result.current.down(event(), 'two'); view.result.current.move(event({ clientY: 31 }))
 view.result.current.down(event(), 'three'); view.result.current.cancel()
 view.result.current.down(event(), 'blur'); window.dispatchEvent(new Event('blur'))
 view.result.current.down(event({ pointerType: 'mouse' }), 'four'); view.result.current.down(event({ isPrimary: false }), 'five')
 act(() => vi.advanceTimersByTime(1000)); expect(activate).not.toHaveBeenCalled()
})
test('checkbox and action controls keep native input semantics', () => {
 const activate = vi.fn(), view = renderHook(() => useLongPressSelection('dir', activate))
 const input = document.createElement('input'); view.result.current.down(event({ target: input }), 'one')
 const button = document.createElement('button'); button.className = 'entry-card-more'; view.result.current.down(event({ target: button }), 'two')
 act(() => vi.advanceTimersByTime(1000)); expect(activate).not.toHaveBeenCalled()
})
test('latest callback is used; directory change and unmount destroy pending timers and suppression', () => {
 const old = vi.fn(), current = vi.fn()
 const view = renderHook(({ context, callback }) => useLongPressSelection(context, callback), { initialProps: { context: 'dir', callback: old } })
 view.result.current.down(event(), 'one'); view.rerender({ context: 'dir', callback: current }); act(() => vi.advanceTimersByTime(500)); expect(old).not.toHaveBeenCalled(); expect(current).toHaveBeenCalledExactlyOnceWith('one')
 view.result.current.up(event()); view.rerender({ context: 'other', callback: current }); expect(view.result.current.consumeClick('one')).toBe(false)
 view.result.current.down(event(), 'two'); view.rerender({ context: 'third', callback: current }); act(() => vi.advanceTimersByTime(500)); expect(current).toHaveBeenCalledTimes(1)
 view.result.current.down(event(), 'three'); view.unmount(); act(() => vi.advanceTimersByTime(500)); expect(current).toHaveBeenCalledTimes(1)
})
