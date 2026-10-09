// Test-only TLS termination. The application still sees its normal loopback
// proxy deployment, with its original authentication, headers and bytes.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function forwardedHeaders(headers) {
  const blocked = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
  for (const token of String(headers.connection ?? '').split(',')) blocked.add(token.trim().toLowerCase())
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())))
}

export function testUsesHTTPS() {
  return process.env.XDRIVE_E2E_BROWSER === 'webkit' || process.env.XDRIVE_E2E_BROWSER === 'firefox' || process.env.XDRIVE_E2E_HTTPS === '1'
}

export async function startTLSProxy(upstreamURL, port = 0) {
  const upstream = new URL(upstreamURL)
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new TypeError('TLS test upstream must be an HTTP IPv4 loopback origin')
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('invalid TLS test port')
  const root = mkdtempSync(join(tmpdir(), 'xdrive-test-tls-'))
  let server
  const sockets = new Set()
  try {
    const key = join(root, 'key.pem'), cert = join(root, 'cert.pem')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' })
    server = createServer({ key: readFileSync(key), cert: readFileSync(cert), minVersion: 'TLSv1.2' }, (incoming, response) => {
      const outgoing = request({ hostname: upstream.hostname, port: upstream.port, method: incoming.method, path: incoming.url, headers: { ...forwardedHeaders(incoming.headers), 'x-forwarded-proto': 'https' } }, (reply) => {
        response.writeHead(reply.statusCode ?? 502, forwardedHeaders(reply.headers))
        reply.on('error', () => response.destroy())
        reply.pipe(response)
      })
      outgoing.on('error', () => {
        if (response.headersSent) response.destroy()
        else response.writeHead(502, { 'cache-control': 'no-store' }).end()
      })
      incoming.on('aborted', () => outgoing.destroy())
      incoming.on('error', () => outgoing.destroy())
      response.on('close', () => { if (!response.writableFinished) outgoing.destroy() })
      incoming.pipe(outgoing)
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TLS test listener unavailable')
    let closed
    return {
      baseURL: `https://127.0.0.1:${address.port}`,
      close: () => closed ??= (async () => {
        const stopped = new Promise((resolve) => server.close(resolve))
        for (const socket of sockets) socket.destroy()
        await stopped
        rmSync(root, { recursive: true, force: true })
      })(),
    }
  } catch (error) {
    for (const socket of sockets) socket.destroy()
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proxy = await startTLSProxy(process.env.XDRIVE_E2E_TLS_UPSTREAM ?? 'http://127.0.0.1:8787', Number(process.env.XDRIVE_E2E_TLS_PORT ?? '8788'))
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void proxy.close().then(() => process.exit(0)) })
  console.log(`XDrive test TLS proxy listening at ${proxy.baseURL}`)
}
