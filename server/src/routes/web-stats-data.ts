// Read-only access layer over data/web-stats.sqlite for the /a/stats dashboard.
// Every query tolerates a missing/corrupt DB (dbAvailable:false — the page then
// serves the live strip only). The DB is opened per summary build and closed
// right after: open cost is ~1 ms, and a fresh handle always sees the
// aggregator's latest commit. `day` defaults to the latest day present
// (never the wall clock — the page must show the same numbers the DB holds).
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { REPO_ROOT } from '../runtime-paths.js'

export const WEB_STATS_SITE = '0db.app'

/** Resolved per call (never at import) so tests and ops can point WEB_STATS_DB
 *  at another file — including a missing one — without a process restart. */
function statsDbPath(): string {
  return process.env.WEB_STATS_DB
    ? resolve(process.env.WEB_STATS_DB)
    : resolve(REPO_ROOT, 'data', 'web-stats.sqlite')
}

export interface DayCounts {
  visitors: number
  requests: number
  botRequests: number
  pageLoads: number
  popupOpens: number
  searches: number
  isochrons: number
}

export interface DayTotalsRow {
  day: string
  visitors: number
  requests: number
  pageLoads: number
}

export interface CountryRow {
  code: string
  requests: number
  sharePct: number
}

export interface RefererRow {
  domain: string
  visits: number
  firstSeen: string
  isNew: boolean
}

export interface DeviceRow {
  device: string
  requests: number
  sharePct: number
}

export interface SearchTermRow {
  term: string
  searches: number
}

export interface PopupCellRow {
  lat: number
  lng: number
  opens: number
}

export interface StatsSummary {
  dbAvailable: boolean
  site: string
  day: string | null
  previousDay: string | null
  today: DayCounts | null
  previous: Pick<DayCounts, 'visitors' | 'popupOpens' | 'searches'> & { countries: number } | null
  countriesToday: number
  hoursToday: number[]
  hoursAvg7: number[]
  days: DayTotalsRow[]
  countries: CountryRow[]
  referers: RefererRow[]
  referersPrevious: { domain: string; visits: number }[]
  devices: DeviceRow[]
  searchTermsToday: SearchTermRow[]
  searchTermsWeek: SearchTermRow[]
  popupCells: PopupCellRow[]
  countryFirstSeen: Record<string, string>
  refererFirstSeen: Record<string, string>
  generatedAt: string
}

/** The DB-missing/empty shape — the page degrades to live-only on this. */
export function emptyStatsSummary(site: string): StatsSummary {
  return {
    dbAvailable: false,
    site,
    day: null,
    previousDay: null,
    today: null,
    previous: null,
    countriesToday: 0,
    hoursToday: Array(24).fill(0),
    hoursAvg7: Array(24).fill(0),
    days: [],
    countries: [],
    referers: [],
    referersPrevious: [],
    devices: [],
    searchTermsToday: [],
    searchTermsWeek: [],
    popupCells: [],
    countryFirstSeen: {},
    refererFirstSeen: {},
    generatedAt: new Date().toISOString(),
  }
}

/** Opens the aggregate DB strictly read-only; null = unavailable (page degrades). */
export function openStatsDb(dbPath: string = statsDbPath()): DatabaseSync | null {
  if (!existsSync(dbPath)) return null
  try {
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return null
  }
}

function dayCounts(db: DatabaseSync, site: string, day: string): DayCounts {
  const daily = db
    .prepare('SELECT visitors, requests, bot_requests, page_loads FROM daily_stats WHERE site = ? AND day = ?')
    .get(site, day) as { visitors: number; requests: number; bot_requests: number; page_loads: number } | undefined
  const apiRows = db
    .prepare('SELECT endpoint, requests FROM api_usage_stats WHERE site = ? AND day = ?')
    .all(site, day) as { endpoint: string; requests: number }[]
  const api = Object.fromEntries(apiRows.map((r) => [r.endpoint, r.requests]))
  return {
    visitors: daily?.visitors ?? 0,
    requests: daily?.requests ?? 0,
    botRequests: daily?.bot_requests ?? 0,
    pageLoads: daily?.page_loads ?? 0,
    popupOpens: api.popup_open ?? 0,
    searches: api.search ?? 0,
    isochrons: api.isochron ?? 0,
  }
}

function hourVector(db: DatabaseSync, site: string, days: string[]): number[] {
  const hours = Array(24).fill(0) as number[]
  if (days.length === 0) return hours
  const select = db.prepare('SELECT hour, requests FROM hour_stats WHERE site = ? AND day = ?')
  for (const day of days) {
    for (const row of select.all(site, day) as { hour: number; requests: number }[]) {
      hours[row.hour] += row.requests
    }
  }
  return hours
}

/** Calendar day `daysBack` before `day` (YYYY-MM-DD), for the NEW-badge window. */
export function shiftDay(day: string, daysBack: number): string {
  const shifted = new Date(`${day}T00:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() - daysBack)
  return shifted.toISOString().slice(0, 10)
}

export function readStatsSummary(
  db: DatabaseSync,
  site: string = WEB_STATS_SITE,
  requestedDay?: string,
): StatsSummary {
  const summary = emptyStatsSummary(site)
  summary.dbAvailable = true

  const latest = db
    .prepare('SELECT day FROM daily_stats WHERE site = ? ORDER BY day DESC LIMIT 1')
    .get(site) as { day: string } | undefined
  if (!latest && !requestedDay) return summary
  const day = requestedDay ?? latest!.day
  summary.day = day

  const previous = db
    .prepare('SELECT day FROM daily_stats WHERE site = ? AND day < ? ORDER BY day DESC LIMIT 1')
    .get(site, day) as { day: string } | undefined
  summary.previousDay = previous?.day ?? null

  summary.today = dayCounts(db, site, day)
  if (previous) {
    const previousCounts = dayCounts(db, site, previous.day)
    const previousCountries = db
      .prepare('SELECT COUNT(*) AS n FROM country_stats WHERE site = ? AND day = ?')
      .get(site, previous.day) as { n: number }
    summary.previous = {
      visitors: previousCounts.visitors,
      popupOpens: previousCounts.popupOpens,
      searches: previousCounts.searches,
      countries: previousCountries.n,
    }
    summary.referersPrevious = (
      db.prepare('SELECT referer, visits FROM referer_stats WHERE site = ? AND day = ?').all(site, previous.day) as
        { referer: string; visits: number }[]
    ).map((r) => ({ domain: r.referer, visits: r.visits }))
  }

  summary.days = (
    db
      .prepare('SELECT day, visitors, requests, page_loads FROM daily_stats WHERE site = ? ORDER BY day DESC LIMIT 30')
      .all(site) as { day: string; visitors: number; requests: number; page_loads: number }[]
  )
    .map((r) => ({ day: r.day, visitors: r.visitors, requests: r.requests, pageLoads: r.page_loads }))
    .reverse()

  const recentDays = summary.days.slice(-7).map((d) => d.day)
  summary.hoursToday = hourVector(db, site, [day])
  const weekHours = hourVector(db, site, recentDays)
  summary.hoursAvg7 = weekHours.map((total) => Math.round(total / Math.max(1, recentDays.length)))

  const countryRows = db
    .prepare('SELECT country, requests FROM country_stats WHERE site = ? AND day = ? ORDER BY requests DESC')
    .all(site, day) as { country: string; requests: number }[]
  const totalRequests = Math.max(1, summary.today.requests)
  summary.countries = countryRows.map((r) => ({
    code: r.country,
    requests: r.requests,
    sharePct: Math.round((r.requests / totalRequests) * 1000) / 10,
  }))
  summary.countriesToday = countryRows.length

  summary.countryFirstSeen = Object.fromEntries(
    (db.prepare('SELECT country, MIN(day) AS first FROM country_stats WHERE site = ? GROUP BY country').all(site) as
      { country: string; first: string }[]).map((r) => [r.country, r.first]),
  )
  summary.refererFirstSeen = Object.fromEntries(
    (db.prepare('SELECT referer, MIN(day) AS first FROM referer_stats WHERE site = ? GROUP BY referer').all(site) as
      { referer: string; first: string }[]).map((r) => [r.referer, r.first]),
  )

  const newCutoff = shiftDay(day, 6)
  summary.referers = (
    db.prepare('SELECT referer, visits FROM referer_stats WHERE site = ? AND day = ? ORDER BY visits DESC').all(site, day) as
      { referer: string; visits: number }[]
  ).map((r) => ({
    domain: r.referer,
    visits: r.visits,
    firstSeen: summary.refererFirstSeen[r.referer] ?? day,
    // Internal navigation + non-domains (direct, ip-literal) are never "someone wrote about us".
    isNew: r.referer !== site && r.referer !== 'direct' && r.referer !== 'ip-literal'
      && (summary.refererFirstSeen[r.referer] ?? day) >= newCutoff,
  }))

  summary.devices = (
    db.prepare('SELECT device, requests FROM device_stats WHERE site = ? AND day = ? ORDER BY requests DESC').all(site, day) as
      { device: string; requests: number }[]
  ).map((r) => ({ device: r.device, requests: r.requests, sharePct: Math.round((r.requests / totalRequests) * 1000) / 10 }))

  summary.searchTermsToday = db
    .prepare('SELECT term, searches FROM search_term_stats WHERE site = ? AND day = ? ORDER BY searches DESC, term LIMIT 50')
    .all(site, day) as { term: string; searches: number }[]
  if (recentDays.length > 0) {
    const weekTerms = new Map<string, number>()
    const select = db.prepare('SELECT term, searches FROM search_term_stats WHERE site = ? AND day = ?')
    for (const recentDay of recentDays) {
      for (const row of select.all(site, recentDay) as { term: string; searches: number }[]) {
        weekTerms.set(row.term, (weekTerms.get(row.term) ?? 0) + row.searches)
      }
    }
    summary.searchTermsWeek = [...weekTerms.entries()]
      .map(([term, searches]) => ({ term, searches }))
      .sort((a, b) => b.searches - a.searches || a.term.localeCompare(b.term))
      .slice(0, 50)
  }

  summary.popupCells = db
    .prepare('SELECT lat_cell AS lat, lng_cell AS lng, opens FROM popup_cell_stats WHERE site = ? AND day = ? ORDER BY opens DESC LIMIT 500')
    .all(site, day) as { lat: number; lng: number; opens: number }[]

  summary.generatedAt = new Date().toISOString()
  return summary
}
