import type { Plugin } from 'vite'
import { buildSparsePDFWorker } from './worker-adapter.mjs'

const publicId = 'virtual:xdrive-pdf-worker'
const internalId = '\0' + publicId
const developmentPath = '/@xdrive/pdf.worker.mjs'

/** Emit the version-reviewed, local worker as an opaque asset, not page code. */
export function xdrivePDFWorker(): Plugin {
  let development = false
  let reference: string | undefined
  let source = ''
  return {
    name: 'xdrive-pdf-worker',
    configResolved(config) { development = config.command === 'serve' },
    buildStart() {
      // A dependency drift fails both development and release builds closed.
      source = buildSparsePDFWorker().source
      if (!development) reference = this.emitFile({ type: 'asset', name: 'pdf.worker-xdrive.mjs', source })
    },
    resolveId(id) { if (id === publicId) return internalId },
    load(id) {
      if (id !== internalId) return
      return development
        ? `export default ${JSON.stringify(developmentPath)}`
        : `export default import.meta.ROLLUP_FILE_URL_${reference}`
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== developmentPath) return next()
        if (!source) source = buildSparsePDFWorker().source
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        response.end(source)
      })
    },
  }
}
