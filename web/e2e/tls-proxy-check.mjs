import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { request } from 'node:https'
import test from 'node:test'
import { startTLSProxy } from './tls-proxy.mjs'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

function send(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, options, async (response) => {
      try {
        const buffers = []
        for await (const data of response) buffers.push(data)
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(buffers) })
      } catch (error) { reject(error) }
    })
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

test('TLS proxy rejects non-loopback upstreams and invalid ports', async () => {
  for (const url of ['https://127.0.0.1', 'http://example.invalid', 'http://user@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1?key=value']) {
    await assert.rejects(startTLSProxy(url), TypeError)
  }
  await assert.rejects(startTLSProxy('http://127.0.0.1', -1), RangeError)
})

test('TLS relay preserves bodies, Host/Origin, Range and Secure cookie without changing trust', async () => {
  const body = Buffer.alloc(1024 * 1024 + 19, 37)
  let received
  const backend = createServer(async (incoming, reply) => {
    const buffers = []
    for await (const chunk of incoming) buffers.push(chunk)
    received = { headers: incoming.headers, body: Buffer.concat(buffers) }
    reply.writeHead(206, { 'set-cookie': 'fixture=value; Path=/; Secure; HttpOnly; SameSite=Strict', 'cache-control': 'no-store', 'content-range': 'bytes 0-3/8' })
    reply.end(Buffer.from([1, 2, 3, 4]))
  })
  const proxy = await startTLSProxy(await listen(backend))
  try {
    await assert.rejects(send(proxy.baseURL), /self.signed certificate/iu)
    const reply = await send(proxy.baseURL, { rejectUnauthorized: false, method: 'POST', headers: { origin: proxy.baseURL, cookie: 'fixture=value', range: 'bytes=0-3', 'content-length': body.length } }, body)
    assert.equal(reply.status, 206)
    assert.deepEqual(reply.body, Buffer.from([1, 2, 3, 4]))
    assert.equal(reply.headers['content-range'], 'bytes 0-3/8')
    assert.equal(reply.headers['cache-control'], 'no-store')
    assert.match(reply.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Strict/u)
    assert.equal(received.headers.host, new URL(proxy.baseURL).host)
    assert.equal(received.headers.origin, proxy.baseURL)
    assert.equal(received.headers.cookie, 'fixture=value')
    assert.equal(received.headers.range, 'bytes=0-3')
    assert.equal(received.headers['x-forwarded-proto'], 'https')
    assert.deepEqual(received.body, body)
  } finally {
    await proxy.close()
    await proxy.close()
    await new Promise((resolve) => backend.close(resolve))
  }
})

test('closing TLS owner terminates a stalled stream and upstream response', async () => {
  let replyClosed
  const backend = createServer((_incoming, reply) => {
    replyClosed = once(reply, 'close', { signal: AbortSignal.timeout(3000) })
    reply.writeHead(200, { 'cache-control': 'no-store' })
    reply.write('first')
    const tick = setInterval(() => reply.write(Buffer.alloc(1024)), 10)
    reply.on('close', () => clearInterval(tick))
  })
  const proxy = await startTLSProxy(await listen(backend))
  const client = request(proxy.baseURL, { rejectUnauthorized: false })
  client.on('error', () => {})
  const responseReady = once(client, 'response')
  client.end()
  try {
    const [response] = await responseReady
    response.on('error', () => {})
    response.pause()
    await proxy.close()
    await replyClosed
  } finally {
    client.destroy()
    await proxy.close()
    await new Promise((resolve) => backend.close(resolve))
  }
})
