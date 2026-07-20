import assert from 'node:assert/strict'
import test from 'node:test'
import { buildApp, clusterRoutesEnabled } from './app.js'

const ready = async () => ({ ready: true as const, failed: [], errors: {} })

test('a public distribution without the ops module skips cluster routes cleanly', async (t) => {
  // The ops dashboard module (fleet supervision) is not part of the public
  // distribution; the server must still boot and simply not register /a/*.
  const app = await buildApp({ readinessCheck: ready, enableClusterRoutes: true })
  t.after(async () => app.close())
  assert.equal(app.hasRoute({ method: 'GET', url: '/a/cluster' }), false)
  const res = await app.inject('/a/cluster')
  assert.equal(res.statusCode, 404)
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
