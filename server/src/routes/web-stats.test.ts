import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import Fastify from 'fastify'
import { readStatsSummary } from './web-stats-data.js'
import { buildInsights } from './web-stats-insights.js'
import { describeAgent, scanLogLines } from './web-stats-live.js'

const SITE = 'quietmap.org'

function makeTempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'web-stats-test-'))
  const path = join(dir, 'stats.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE daily_stats (site TEXT, day TEXT, visitors INT, requests INT, bot_requests INT, page_loads INT, PRIMARY KEY (site, day));
    CREATE TABLE country_stats (site TEXT, day TEXT, country TEXT, requests INT, PRIMARY KEY (site, day, country));
    CREATE TABLE hour_stats (site TEXT, day TEXT, hour INT, requests INT, PRIMARY KEY (site, day, hour));
    CREATE TABLE referer_stats (site TEXT, day TEXT, referer TEXT, visits INT, PRIMARY KEY (site, day, referer));
    CREATE TABLE device_stats (site TEXT, day TEXT, device TEXT, requests INT, PRIMARY KEY (site, day, device));
    CREATE TABLE api_usage_stats (site TEXT, day TEXT, endpoint TEXT, requests INT, PRIMARY KEY (site, day, endpoint));
    CREATE TABLE search_term_stats (site TEXT, day TEXT, term TEXT, searches INT, PRIMARY KEY (site, day, term));
    CREATE TABLE popup_cell_stats (site TEXT, day TEXT, lat_cell REAL, lng_cell REAL, opens INT, PRIMARY KEY (site, day, lat_cell, lng_cell));
  `)
  const run = (sql: string, ...params: (string | number)[]) => db.prepare(sql).run(...params)
  run('INSERT INTO daily_stats VALUES (?, ?, ?, ?, ?, ?)', SITE, '2026-07-18', 50, 1000, 500, 300)
  run('INSERT INTO daily_stats VALUES (?, ?, ?, ?, ?, ?)', SITE, '2026-07-19', 70, 1400, 700, 350)
  run('INSERT INTO country_stats VALUES (?, ?, ?, ?)', SITE, '2026-07-18', 'CZ', 400)
  run('INSERT INTO country_stats VALUES (?, ?, ?, ?)', SITE, '2026-07-19', 'CZ', 600)
  run('INSERT INTO country_stats VALUES (?, ?, ?, ?)', SITE, '2026-07-19', 'JP', 100)
  run('INSERT INTO hour_stats VALUES (?, ?, ?, ?)', SITE, '2026-07-19', 13, 300)
  run('INSERT INTO hour_stats VALUES (?, ?, ?, ?)', SITE, '2026-07-18', 13, 150)
  run('INSERT INTO referer_stats VALUES (?, ?, ?, ?)', SITE, '2026-07-18', 'direct', 200)
  run('INSERT INTO referer_stats VALUES (?, ?, ?, ?)', SITE, '2026-07-19', 'direct', 250)
  run('INSERT INTO referer_stats VALUES (?, ?, ?, ?)', SITE, '2026-07-19', 'seznam.cz', 9)
  run('INSERT INTO device_stats VALUES (?, ?, ?, ?)', SITE, '2026-07-19', 'mobile', 800)
  run('INSERT INTO device_stats VALUES (?, ?, ?, ?)', SITE, '2026-07-19', 'desktop', 600)
  run('INSERT INTO api_usage_stats VALUES (?, ?, ?, ?)', SITE, '2026-07-19', 'popup_open', 12)
  run('INSERT INTO api_usage_stats VALUES (?, ?, ?, ?)', SITE, '2026-07-19', 'search', 7)
  run('INSERT INTO search_term_stats VALUES (?, ?, ?, ?)', SITE, '2026-07-19', 'berlin', 4)
  run('INSERT INTO popup_cell_stats VALUES (?, ?, ?, ?, ?)', SITE, '2026-07-19', 50.09, 14.4, 5)
  db.close()
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('readStatsSummary computes today + previous + dimensions from the aggregate DB', () => {
  const { path, cleanup } = makeTempDb()
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    const summary = readStatsSummary(db, SITE)
    db.close()
    assert.equal(summary.dbAvailable, true)
    assert.equal(summary.day, '2026-07-19')
    assert.equal(summary.previousDay, '2026-07-18')
    assert.deepEqual(summary.today, {
      visitors: 70, requests: 1400, botRequests: 700, pageLoads: 350,
      popupOpens: 12, searches: 7, isochrons: 0,
    })
    assert.deepEqual(summary.previous, { visitors: 50, popupOpens: 0, searches: 0, countries: 1 })
    assert.equal(summary.countriesToday, 2)
    assert.equal(summary.countries[0].code, 'CZ')
    assert.equal(summary.hoursToday[13], 300)
    assert.equal(summary.hoursAvg7[13], 225) // AVG over the two days present
    assert.equal(summary.countryFirstSeen.JP, '2026-07-19')
    const seznam = summary.referers.find((r) => r.domain === 'seznam.cz')
    assert.equal(seznam?.isNew, true)
    assert.deepEqual(summary.referersPrevious, [{ domain: 'direct', visits: 200 }])
    // node:sqlite rows carry a null prototype — compare via JSON round-trip.
    assert.deepEqual(JSON.parse(JSON.stringify(summary.popupCells)), [{ lat: 50.09, lng: 14.4, opens: 5 }])
    assert.equal(summary.searchTermsToday[0].term, 'berlin')
    // A day with no rows still answers sanely.
    const db2 = new DatabaseSync(path, { readOnly: true })
    const missing = readStatsSummary(db2, SITE, '2020-01-01')
    db2.close()
    assert.equal(missing.day, '2020-01-01')
    assert.equal(missing.today?.visitors, 0)
  } finally {
    cleanup()
  }
})

function caddyLine(over: {
  ts: number; ip?: string; ua?: string; uri?: string; method?: string; referer?: string; status?: number
}): string {
  return JSON.stringify({
    ts: over.ts,
    status: over.status ?? 200,
    size: 100,
    request: {
      client_ip: over.ip ?? '203.0.113.7',
      method: over.method ?? 'GET',
      uri: over.uri ?? '/',
      headers: {
        'User-Agent': [over.ua ?? 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0'],
        ...(over.referer ? { Referer: [over.referer] } : {}),
      },
    },
  })
}

test('scanLogLines classifies human events anonymously and builds today slices', () => {
  const dayStart = Date.UTC(2026, 6, 19)
  const now = dayStart + 20 * 3600_000
  const geoip = (ip: string) => (ip === '203.0.113.7' ? 'CZ' : 'JP')
  const lines = [
    caddyLine({ ts: (now - 60_000) / 1000, ip: '203.0.113.7', uri: '/' }), // online, page load
    caddyLine({ ts: (now - 30_000) / 1000, ip: '198.51.100.9', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1', uri: '/api/noise-onfly-v2?lat=50.087&lng=14.421' }),
    caddyLine({ ts: (now - 20_000) / 1000, ip: '203.0.113.7', uri: '/api/search?q=secret+home+address' }),
    caddyLine({ ts: (now - 10_000) / 1000, ip: '203.0.113.7', ua: 'Googlebot/2.1', uri: '/' }), // bot: excluded everywhere
    caddyLine({ ts: (now - 10 * 60_000) / 1000, ip: '192.0.2.44', ua: 'Better Uptime Bot Mozilla/5.0', uri: '/' }), // monitor bot
    caddyLine({ ts: (dayStart - 3600_000) / 1000, ip: '203.0.113.7', uri: '/' }), // yesterday: not in today slice
    'not json at all',
  ]
  const scan = scanLogLines(lines, geoip, now, dayStart)
  assert.equal(scan.onlineNow, 2) // two distinct non-bot IPs in the last 5 min
  assert.equal(scan.events.length, 4) // today's 3 + yesterday's page load (the feed is not day-bounded; bots skipped)
  const actions = scan.events.map((e) => e.action)
  assert.deepEqual(actions, ['page load', 'popup open', 'search', 'page load'])
  // No IP and no live search term may leak into any event.
  const serialized = JSON.stringify(scan.events)
  assert.doesNotMatch(serialized, /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/)
  assert.doesNotMatch(serialized, /secret|address/i)
  assert.equal(scan.events[1].country, 'JP')
  assert.equal(scan.events[1].agent, 'Safari · iPhone')
  // Today slice: CZ has 2 requests (page load + search), JP 1 popup open.
  assert.equal(scan.byCountry.CZ.requests, 2)
  assert.equal(scan.byCountry.CZ.visitors, 1)
  assert.equal(scan.byCountry.CZ.searches, 1)
  assert.equal(scan.byCountry.JP.popupOpens, 1)
  assert.deepEqual(scan.byCountry.JP.cells, [{ lat: 50.09, lng: 14.42, opens: 1 }])
  assert.equal(scan.byCountry.JP.devicePopups.mobile, 1)
  assert.equal(scan.deviceRates?.mobile.visitors, 1)
  assert.equal(scan.deviceRates?.mobile.popups, 1)
})

test('describeAgent names browser · platform', () => {
  assert.equal(describeAgent('Mozilla/5.0 (Windows NT 10.0) Edg/120.0 Chrome/120.0'), 'Edge · Windows')
  assert.equal(describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1'), 'Safari · iPhone')
  assert.equal(describeAgent(''), 'unknown · unknown')
})

test('buildInsights emits numbered one-liners, max five', () => {
  const insights = buildInsights({
    today: '2026-07-19',
    previousDay: '2026-07-18',
    selfDomain: SITE,
    countryFirstSeen: { CZ: '2026-07-15', JP: '2026-07-19' },
    countryNames: { CZ: 'Czechia', JP: 'Japan' },
    referersToday: [{ domain: 'seznam.cz', visits: 9 }, { domain: 'direct', visits: 250 }],
    referersPrevious: [{ domain: 'seznam.cz', visits: 3 }, { domain: 'direct', visits: 200 }],
    refererFirstSeen: { 'seznam.cz': '2026-07-16', direct: '2026-07-15' },
    topPopupCell: { lat: 50.09, lng: 14.4, opens: 5 },
    deviceRates: { mobile: { visitors: 20, popups: 8 }, desktop: { visitors: 30, popups: 2 } },
  })
  assert.ok(insights.length <= 5)
  assert.match(insights.find((i) => i.id === 'first-country')?.text ?? '', /Japan/)
  // seznam.cz first seen 2026-07-16 → within the 6-day NEW window → new-referer wins over spike.
  assert.match(insights.find((i) => i.id === 'new-referer')?.text ?? '', /seznam\.cz.*9 visits/)
  assert.match(insights.find((i) => i.id === 'top-cell')?.text ?? '', /50\.09, 14\.40.*5 popup/)
  assert.match(insights.find((i) => i.id === 'device-popup-rate')?.text ?? '', /Mobile popup rate is 6× desktop/)
  // No data → no lines.
  assert.deepEqual(buildInsights({
    today: null, previousDay: null, selfDomain: SITE, countryFirstSeen: {}, countryNames: {},
    referersToday: [], referersPrevious: [], refererFirstSeen: {}, topPopupCell: null, deviceRates: null,
  }), [])
  // The site's own domain never produces a referer insight.
  assert.deepEqual(buildInsights({
    today: '2026-07-19', previousDay: '2026-07-18', selfDomain: SITE, countryFirstSeen: {}, countryNames: {},
    referersToday: [{ domain: SITE, visits: 30 }], referersPrevious: [], refererFirstSeen: { [SITE]: '2026-07-19' },
    topPopupCell: null, deviceRates: null,
  }), [])
})

test('routes serve the page and a DB-missing summary without a 5xx', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'web-stats-routes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  process.env.WEB_STATS_DB = join(dir, 'absent.sqlite')
  const { webStatsRoutes } = await import('./web-stats.js')
  const app = Fastify()
  await app.register(webStatsRoutes, { prefix: '/a' })
  t.after(() => app.close())

  const page = await app.inject('/a/stats')
  assert.equal(page.statusCode, 200)
  assert.match(page.headers['content-type'] ?? '', /text\/html/)
  assert.match(page.body, /Quiet Map/)

  const summary = await app.inject('/a/api/stats/summary')
  assert.equal(summary.statusCode, 200)
  const body = summary.json()
  assert.equal(body.dbAvailable, false)
  assert.equal(body.slice, null)
  assert.deepEqual(body.insights, [])

  const filtered = await app.inject('/a/api/stats/summary?country=CZ')
  assert.equal(filtered.statusCode, 200)
  assert.equal(filtered.json().filter.country, 'CZ')

  const live = await app.inject('/a/api/stats/live')
  assert.equal(live.statusCode, 200)
  const liveBody = live.json()
  assert.equal(typeof liveBody.ok, 'boolean')
  if (liveBody.ok) {
    assert.doesNotMatch(JSON.stringify(liveBody.events), /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/)
  }
})
