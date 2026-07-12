import assert from 'node:assert/strict'
import test from 'node:test'
import { buildApp } from './app.js'

const ready = async () => ({ ready: true as const, failed: [], errors: {} })

test('cluster routes have a secure default and require loopback when enabled', async (t) => {
  const publicApp = await buildApp({ readinessCheck: ready, enableClusterRoutes: false })
  t.after(async () => publicApp.close())
  assert.equal(publicApp.hasRoute({ method: 'GET', url: '/cluster' }), false)
  assert.equal(publicApp.hasRoute({ method: 'GET', url: '/api/cluster/status' }), false)

  const internalApp = await buildApp({ readinessCheck: ready, enableClusterRoutes: true })
  t.after(async () => internalApp.close())
  assert.equal(internalApp.hasRoute({ method: 'GET', url: '/cluster' }), true)

  const proxiedPublic = await internalApp.inject({
    method: 'GET',
    url: '/api/cluster/status',
    remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-for': '203.0.113.20' },
  })
  assert.equal(proxiedPublic.statusCode, 404)
})

test('noindex is an explicit deployment property', async (t) => {
  const app = await buildApp({ readinessCheck: ready, noIndex: true })
  t.after(async () => app.close())
  const response = await app.inject('/api/live')
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow, noarchive')
})
