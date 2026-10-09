/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { renderSafeMarkdown } from './markdown'

describe('safe Markdown preview', () => {
  it('removes executable markup, embedded remote media, and unsafe links', () => {
    const html = renderSafeMarkdown([
      '# Notes',
      '<script>window.compromised = true</script>',
      '<img src="https://tracker.example/pixel">',
      '[bad](javascript:alert(1))',
      '[external](https://example.com/docs)',
    ].join('\n\n'))
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    expect(parsed.querySelector('script, img, iframe, video')).toBeNull()
    expect(parsed.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(parsed.querySelector('a[href="https://example.com/docs"]')?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(parsed.querySelector('h1')?.textContent).toBe('Notes')
  })
  it('keeps external images as inert escaped placeholders, task states and reading content', () => {
    const html = renderSafeMarkdown('![<img onerror=alert(1)>](https://tracker.test/pixel)\n\n- [x] Done\n- [ ] Pending\n\n`<script>`')
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    expect(parsed.querySelector('img, script, input')).toBeNull()
    expect(parsed.querySelector('.markdown-image-placeholder')?.textContent).toContain('图片已阻止')
    expect(parsed.querySelector('[aria-label="已完成"]')).not.toBeNull()
    expect(parsed.querySelector('[aria-label="未完成"]')).not.toBeNull()
    expect(parsed.querySelector('code')?.textContent).toBe('<script>')
  })
  it('disables raw HTML and disallows executable, local-file and data navigation', () => {
    const html = renderSafeMarkdown('<svg onload="alert(1)"><a href="https://tracker.test">raw</a></svg>\n\n[script](javascript:alert(1)) [file](file:///secret) [data](data:text/html,evil) [mail](mailto:x@test) [external](https://example.com/)')
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    expect(parsed.querySelector('svg, img, script')).toBeNull()
    expect([...parsed.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))).toEqual(['https://example.com/'])
    const link = parsed.querySelector('a[href]')!
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })
})
