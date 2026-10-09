import { afterEach, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ drift: false }))
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return {
    ...original,
    readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
      const result = original.readFileSync(...args)
      if (fault.drift && String(args[0]).endsWith('/pdfjs-dist/legacy/build/pdf.worker.mjs')) {
        return String(result) + '\n// Unexpected dependency revision\n'
      }
      return result
    },
  }
})
import { buildSparsePDFWorker } from '../../pdf-worker/worker-adapter.mjs'

afterEach(() => { fault.drift = false })

it('fails the release generator closed on actual upstream source drift before adaptation', () => {
  fault.drift = true
  expect(() => buildSparsePDFWorker()).toThrow('PDF.js worker source drift')
  fault.drift = false
  expect(buildSparsePDFWorker().source).toContain('class SparseChunkedStream extends BaseStream')
})
