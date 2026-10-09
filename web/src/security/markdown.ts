import DOMPurify from 'dompurify'
import { Marked } from 'marked'

const escapeHTML = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[char]!)
const markdown = new Marked({ async: false, gfm: true, renderer: {
  html: token => escapeHTML(token.text),
  image: token => `<span class="markdown-image-placeholder" role="note">图片已阻止：${escapeHTML(token.text || '图片')}</span>`,
  checkbox: token => `<span aria-label="${token.checked ? '已完成' : '未完成'}">${token.checked ? '☑' : '☐'}</span>`,
} })

export function renderSafeMarkdown(source: string): string {
  const html = markdown.parse(source, { async: false })
  const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'del', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'span'], ALLOWED_ATTR: ['href', 'title', 'class', 'role', 'aria-label'] })
  const template = document.createElement('template')
  template.innerHTML = clean
  template.content.querySelectorAll('a[href]').forEach((anchor) => {
    try {
      const destination = new URL(anchor.getAttribute('href') ?? '', window.location.origin)
      if (!['https:', 'http:'].includes(destination.protocol)) { anchor.removeAttribute('href'); return }
      anchor.setAttribute('target', '_blank')
      anchor.setAttribute('rel', 'noopener noreferrer')
      anchor.setAttribute('referrerpolicy', 'no-referrer')
    } catch { anchor.removeAttribute('href') }
  })
  return template.innerHTML
}
