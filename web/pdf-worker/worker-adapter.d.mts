export const PINNED_WORKER_SHA256: string
export function buildSparsePDFWorker(options?: { instrument?: boolean }): {
  source: string
  upstreamSha256: string
  sha256: string
}
