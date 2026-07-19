import assert from 'node:assert/strict'
import test from 'node:test'
import { buildApp, clusterRoutesEnabled } from './app.js'

const ready = async () => ({ ready: true as const, failed: [], errors: {} })

test('cluster dashboard: absent unless enabled, else under the /a/ admin prefix (Caddy basic_auth gates the edge)', async (t) => {
  const publicApp = await buildApp({ readinessCheck: ready, enableClusterRoutes: false })
  t.after(async () => publicApp.close())
  assert.equal(publicApp.hasRoute({ method: 'GET', url: '/a/cluster' }), false)
  assert.equal(publicApp.hasRoute({ method: 'GET', url: '/a/api/cluster/status' }), false)

  const withCluster = await buildApp({ readinessCheck: ready, enableClusterRoutes: true })
  t.after(async () => withCluster.close())
  assert.equal(withCluster.hasRoute({ method: 'GET', url: '/a/cluster' }), true)
  assert.equal(withCluster.hasRoute({ method: 'GET', url: '/a/api/cluster/worker-log' }), true)

  // Two-layer access control: Caddy basic_auth at the edge + requireLocalPeer here.
  // A request whose SOCKET peer is loopback (Caddy proxies from localhost; the shell TUI)
  // reaches the route regardless of the forwarded public IP. cachedStatus() warms in the
  // background, so a fresh server answers 200 (warm) or 503 (warming) — both prove REACHED
  // (asserting 200 alone is a warming race).
  const reached = await withCluster.inject({
    method: 'GET',
    url: '/a/api/cluster/status',
    remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-for': '203.0.113.20' },
  })
  assert.ok(
    reached.statusCode === 200 || reached.statusCode === 503,
    `dashboard route must respond (200 warm / 503 warming), got ${reached.statusCode}`,
  )

  // A DIRECT hit on the public port (non-loopback socket, bypassing Caddy + basic_auth)
  // is 404'd by requireLocalPeer — the raw port can't leak box IPs / costs.
  const direct = await withCluster.inject({ method: 'GET', url: '/a/api/cluster/status', remoteAddress: '203.0.113.20' })
  assert.equal(direct.statusCode, 404)
})

test('cluster dashboard defaults on for a named dev checkout and explicit configuration wins', () => {
  assert.equal(clusterRoutesEnabled({ TILE_ENV: 'dev2' }), true)
  assert.equal(clusterRoutesEnabled({ TILE_ENV: 'prod' }), false)
  assert.equal(clusterRoutesEnabled({ TILE_ENV: 'dev3', ENABLE_CLUSTER_ROUTES: '0' }), false)
  assert.equal(clusterRoutesEnabled({ TILE_ENV: 'prod', ENABLE_CLUSTER_ROUTES: '1' }), true)
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
