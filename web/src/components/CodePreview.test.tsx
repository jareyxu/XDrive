/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodePreview } from './CodePreview'

class TestWorker {
  static instances: TestWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { TestWorker.instances.push(this) }
}
beforeEach(() => { TestWorker.instances = []; vi.stubGlobal('Worker', TestWorker); vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
describe('code preview highlighter lifecycle', () => {
  it('sends only code/language to its dedicated worker, terminates on success, and keeps rendered output as text', () => {
    render(<CodePreview source="const secret = '<img>';" name="a.ts" mime="text/plain" />)
    const worker = TestWorker.instances[0]!
    expect(worker.postMessage).toHaveBeenCalledWith({ source: "const secret = '<img>';", language: 'typescript' })
    act(() => worker.onmessage?.({ data: { ok: true, ranges: new Uint32Array([0, 5, 0]), classes: ['hljs-keyword'] } } as MessageEvent))
    expect(screen.getByRole('status').textContent).toBe('typescript · 只读')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
  it('terminates on owner unmount and ignores late plaintext highlight results', () => {
    const rendered = render(<CodePreview source="const lateSecret = 7;" name="a.ts" mime="text/plain" />)
    const worker = TestWorker.instances[0]!, receive = worker.onmessage!
    rendered.unmount()
    expect(worker.terminate).toHaveBeenCalledOnce()
    act(() => receive({ data: { ok: true, ranges: new Uint32Array(), classes: [] } } as MessageEvent))
    expect(document.body.textContent).not.toContain('lateSecret')
  })
  it('enforces its eight-second work deadline and uses a stated read-only fallback', () => {
    render(<CodePreview source="const x = 1;" name="a.ts" mime="text/plain" />)
    act(() => vi.advanceTimersByTime(8_000))
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toContain('显示完整只读源码')
  })
  it('keeps the source viewer available if a browser refuses Worker creation', () => {
    vi.stubGlobal('Worker', class { constructor() { throw new DOMException('blocked', 'SecurityError') } })
    render(<CodePreview source="const x = 1;" name="a.ts" mime="text/plain" />)
    expect(screen.getByRole('status').textContent).toContain('高亮不可用')
    expect(screen.getByRole('region', { name: /只读源码/ })).not.toBeNull()
  })
})
