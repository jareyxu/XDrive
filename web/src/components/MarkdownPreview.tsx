import { useMemo, useState } from 'react'
import { renderSafeMarkdown } from '../security/markdown'
import './TextPreview.css'

export function MarkdownPreview({ source }: { source: string }) {
  const [showSource, setShowSource] = useState(false)
  const html = useMemo(() => renderSafeMarkdown(source), [source])
  return <section aria-label="Markdown 预览"><div className="preview-mode"><button type="button" onClick={() => setShowSource(false)} aria-pressed={!showSource}>阅读</button><button type="button" onClick={() => setShowSource(true)} aria-pressed={showSource}>源码</button></div>{showSource ? <pre className="preview-text">{source}</pre> : <article className="preview-markdown" dangerouslySetInnerHTML={{ __html: html }} />}</section>
}
