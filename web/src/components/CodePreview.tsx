import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { codeLanguage, codeLineRuns, indexCodeLines, type CodeHighlight } from '../media/text-preview'
import './TextPreview.css'

const pageLines = 10_000
export function CodePreview({ source, name, mime }: { source: string; name: string; mime: string }) {
  'use no memo'
  const index = useMemo(() => indexCodeLines(source), [source])
  const language = codeLanguage(name, mime)
  const [highlight, setHighlight] = useState<CodeHighlight | null>(null)
  const [status, setStatus] = useState('正在加载语法高亮…')
  const [page, setPage] = useState(0)
  const [lineInput, setLineInput] = useState('1')
  const pendingLine = useRef<number | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const count = Math.min(pageLines, index.count - page * pageLines)
  const virtualizer = useVirtualizer({ count, getScrollElement: () => viewport.current, estimateSize: () => 22, overscan: 6 })
  useEffect(() => {
    let worker: Worker
    try { worker = new Worker(new URL('../workers/code-highlight.worker.ts', import.meta.url), { type: 'module' }) }
    catch { setStatus('语法高亮不可用，已显示完整只读源码。'); return }
    let active = true
    const finish = (result: CodeHighlight | null) => {
      if (!active) return
      active = false
      clearTimeout(timeout)
      worker.terminate()
      setHighlight(result)
      setStatus(result ? `${language} · 只读` : '语法高亮未完成，已显示完整只读源码。')
    }
    const timeout = setTimeout(() => finish(null), 8_000)
    worker.onmessage = (event: MessageEvent<{ ok: boolean } & CodeHighlight>) => finish(event.data.ok ? event.data : null)
    worker.onerror = () => finish(null)
    worker.postMessage({ source, language })
    return () => { active = false; clearTimeout(timeout); worker.terminate() }
  }, [source, language])
  useLayoutEffect(() => {
    if (pendingLine.current !== null) {
      virtualizer.scrollToIndex(pendingLine.current, { align: 'start' })
      pendingLine.current = null
    }
  }, [page, virtualizer])
  const goToLine = (line: number) => {
    const target = Math.max(0, Math.min(index.count - 1, line))
    const nextPage = Math.floor(target / pageLines)
    setLineInput(String(target + 1))
    if (nextPage !== page) { pendingLine.current = target % pageLines; setPage(nextPage) }
    else virtualizer.scrollToIndex(target % pageLines, { align: 'start' })
    viewport.current?.focus()
  }
  return <section className="code-preview" aria-label="代码预览">
    <div className="code-preview-toolbar"><span role="status">{status}</span><span>{index.count.toLocaleString('zh-CN')} 行</span><form onSubmit={event => { event.preventDefault(); const line = Number(lineInput); if (Number.isInteger(line) && line >= 1 && line <= index.count) goToLine(line - 1) }}><label htmlFor="code-line-number">跳至行</label><input id="code-line-number" type="number" min="1" max={index.count} value={lineInput} onChange={event => setLineInput(event.target.value)} /><button type="submit">跳转</button></form>{index.count > pageLines && <><button type="button" disabled={!page} onClick={() => goToLine((page - 1) * pageLines)}>上一段</button><button type="button" disabled={(page + 1) * pageLines >= index.count} onClick={() => goToLine((page + 1) * pageLines)}>下一段</button></>}</div>
    <div className="code-lines" ref={viewport} role="region" aria-label="只读源码，使用方向键滚动，Home 和 End 跳转" tabIndex={0} onKeyDown={event => {
      if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); goToLine(event.key === 'Home' ? 0 : index.count - 1) }
    }}>
      <div className="code-line-space" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(item => {
          const lineNumber = page * pageLines + item.index
          const { start, end } = index.line(lineNumber)
          return <pre className="code-line" data-line-number={lineNumber + 1} key={item.key} style={{ transform: `translateY(${item.start}px)` }}><span className="code-line-number" aria-hidden="true">{lineNumber + 1}</span><code>{codeLineRuns(source, start, end, highlight).map((run, i) => <span className={run.className} key={i}>{run.text}</span>)}</code></pre>
        })}
      </div>
    </div>
  </section>
}
