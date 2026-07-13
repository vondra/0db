import assert from 'node:assert/strict'
import test from 'node:test'
import { buildApp } from './app.js'

const ready = async () => ({ ready: true as const, failed: [], errors: {} })

test('cluster routes: absent unless enabled, then PUBLIC read-only (owner "pust ho" 2026-07-13)', async (t) => {
  const publicApp = await buildApp({ readinessCheck: ready, enableClusterRoutes: false })
  t.after(async () => publicApp.close())
  assert.equal(publicApp.hasRoute({ method: 'GET', url: '/cluster' }), false)
  assert.equal(publicApp.hasRoute({ method: 'GET', url: '/api/cluster/status' }), false)

  const withCluster = await buildApp({ readinessCheck: ready, enableClusterRoutes: true })
  t.after(async () => withCluster.close())
  assert.equal(withCluster.hasRoute({ method: 'GET', url: '/cluster' }), true)

  // The loopback guard was removed (owner call): a proxied public request now
  // reaches the read-only dashboard instead of a 404.
  const proxiedPublic = await withCluster.inject({
    method: 'GET',
    url: '/api/cluster/status',
    remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-for': '203.0.113.20' },
  })
  assert.equal(proxiedPublic.statusCode, 200)
})

test('noindex is an explicit deployment property', async (t) => {
  const app = await buildApp({ readinessCheck: ready, noIndex: true })
  t.after(async () => app.close())
  const response = await app.inject('/api/live')
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow, noarchive')
})

test('responses expose one process-coherence token for long model runs', async (t) => {
  const app = await buildApp({ readinessCheck: ready })
  t.after(async () => app.close())
  const live = await app.inject('/api/live')
  const missing = await app.inject('/does-not-exist')
  assert.match(String(live.headers['x-0db-instance']), /^[0-9a-f-]{36}$/)
  assert.equal(missing.headers['x-0db-instance'], live.headers['x-0db-instance'])
})
