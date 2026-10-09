export function testUsesHTTPS(): boolean
export function startTLSProxy(upstreamURL: string | URL, port?: number): Promise<{
  baseURL: string
  close(): Promise<void>
}>
