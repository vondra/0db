import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { requireLoopback } from './internal-access.js'

test('loopback guard does not run an internal handler for a proxied public request', async (t) => {
  const app = Fastify({ trustProxy: ['127.0.0.1', '::1'] })
  t.after(async () => app.close())
  let handlerCalls = 0
  app.get('/internal', { onRequest: requireLoopback }, async () => {
    handlerCalls++
    return { private: true }
  })

  const response = await app.inject({
    method: 'GET',
    url: '/internal',
    remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-for': '203.0.113.20' },
  })

  assert.equal(response.statusCode, 404)
  assert.equal(handlerCalls, 0)

  const loopbackResponse = await app.inject({
    method: 'GET',
    url: '/internal',
    remoteAddress: '127.0.0.1',
  })
  assert.equal(loopbackResponse.statusCode, 200)
  assert.equal(handlerCalls, 1)
})
