import assert from 'node:assert/strict'
import test from 'node:test'
import { buildApp } from './app.js'

const ready = async () => ({ ready: true as const, failed: [], errors: {} })

test('cluster dashboard: absent unless enabled, else under the /a/ admin prefix (Caddy basic_auth gates the edge)', async (t) => {
  const publicApp = await buildApp({ readinessCheck: ready, enableClusterRoutes: false })
  t.after(async () => publicApp.close())
  assert.equal(publicApp.hasRoute({ method: 'GET', url: '/a/cluster' }), false)
  assert.equal(publicApp.hasRoute({ method: 'GET', url: '/a/api/cluster/status' }), false)

  const withCluster = await buildApp({ readinessCheck: ready, enableClusterRoutes: true })
  t.after(async () => withCluster.close())
  assert.equal(withCluster.hasRoute({ method: 'GET', url: '/a/cluster' }), true)

  // No Fastify-level IP guard — access control is the Caddy basic_auth on
  // dev.0db.app/a/* (see /etc/caddy/Caddyfile). A reachable request (the shell
  // TUI over loopback, or an authed proxied client) reaches the route regardless
  // of the forwarded public IP. cachedStatus() warms in the background, so a
  // fresh server answers 200 (warm) or 503 (still warming) — both prove the route
  // is REACHED, never a 404/guard. (Asserting 200 alone is a warming race.)
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
