// Live + recent-window views over the Caddy JSON access log for /a/stats.
// PRIVACY CONTRACT (same as pipeline/lib/web-stats-aggregates.ts, mirrored
// here because the immutable server release compiles only server/src): the
// client IP touches only in-memory distinct-sets and the GeoIP lookup within
// one scan call; it is never persisted, never returned, and never reachable
// from an endpoint response. Live search TERMS are deliberately not read —
// only the k>=3 aggregates from the DB may show terms.
// Reads are bounded tails via `sudo -n tail -c N` (root-owned log, user
// vondra has passwordless sudo): ~1 MB for the live strip, ~8 MB for the
// today-window slices (at current traffic 16 MB covers >2 days, so 8 MB
// safely spans today). Both scans are promise-memoized so concurrent
// pollers share one sudo read.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { Reader, type CityResponse } from 'mmdb-lib'
import { DEFAULT_GEOIP_DB_PATH } from './initial-view.js'

const ACCESS_LOG_PATH = '/var/log/caddy/0db.app.access.log'
const LIVE_TAIL_BYTES = 1 << 20
const WINDOW_TAIL_BYTES = 8 << 20
const ONLINE_WINDOW_MS = 5 * 60_000
const LIVE_CACHE_MS = 8_000
const WINDOW_CACHE_MS = 60_000
const EXEC_TIMEOUT_MS = 10_000
const MAX_EVENTS = 20

/** Aggregator pattern + uptime robots that carry browser-looking UAs. */
const BOT_UA_PATTERN =
  /bot|spider|crawl|slurp|curl|wget|python-requests|headless|scanner|better\s?stack|uptime/i

export interface LiveEvent {
  ts: number
  country: string
  agent: string
  action: string
}

export interface CountrySlice {
  visitors: number
  requests: number
  pageLoads: number
  popupOpens: number
  searches: number
  hours: number[]
  referers: Record<string, number>
  devices: Record<string, number>
  devicePopups: Record<string, number>
  deviceSearches: Record<string, number>
  cells: { lat: number; lng: number; opens: number }[]
}

export interface LogScan {
  ok: boolean
  error?: string
  lines: number
  fromTs: number | null
  toTs: number | null
  onlineNow: number | null
  events: LiveEvent[]
  byCountry: Record<string, CountrySlice>
  deviceRates: { mobile: { visitors: number; popups: number }; desktop: { visitors: number; popups: number } } | null
}

type GeoipCountry = (ip: string) => string

let geoipReaderPromise: Promise<Reader<CityResponse> | null> | undefined

/** Lazily loads the optional GeoIP DB once; null = every country '??'. */
function geoipReader(): Promise<Reader<CityResponse> | null> {
  geoipReaderPromise ??= readFile(DEFAULT_GEOIP_DB_PATH)
    .then((buffer) => new Reader<CityResponse>(buffer))
    .catch(() => null)
  return geoipReaderPromise
}

/** "Chrome · Windows" style one-liner; platform naming matches the Devices table. */
export function describeAgent(ua: string): string {
  let browser = 'other'
  if (/edg(a|ios)?\//i.test(ua)) browser = 'Edge'
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera'
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox'
  else if (/chrome|crios|chromium/i.test(ua)) browser = 'Chrome'
  else if (/safari/i.test(ua)) browser = 'Safari'
  else if (!ua) browser = 'unknown'
  let platform = 'other'
  if (/iphone/i.test(ua)) platform = 'iPhone'
  else if (/ipad/i.test(ua)) platform = 'iPad'
  else if (/android/i.test(ua)) platform = 'Android'
  else if (/windows/i.test(ua)) platform = 'Windows'
  else if (/mac os x|macintosh/i.test(ua)) platform = 'macOS'
  else if (/linux/i.test(ua)) platform = 'Linux'
  else if (!ua) platform = 'unknown'
  return `${browser} · ${platform}`
}

function deviceClass(ua: string): string {
  return /mobi|android|iphone|ipad|ipod/i.test(ua) ? 'mobile' : 'desktop'
}

function firstHeader(headers: Record<string, string[]> | undefined, name: string): string {
  if (!headers) return ''
  const wanted = name.toLowerCase()
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return values?.[0] ?? ''
  }
  return ''
}

const TILE_PATH_PATTERN = /^\/api\/tiles\/[^/]+\/[^/]+\/(\d{1,2})\/\d+\/\d+\.bin$/

/** Maps a request path to a feed action; null = not feed-worthy (assets, data). */
function classifyAction(method: string, path: string): string | null {
  if (method === 'GET' && path === '/') return 'page load'
  if (path === '/api/noise-onfly-v2') return 'popup open'
  if (path === '/api/search') return 'search'
  if (path === '/api/isochron') return 'isochron'
  if (path === '/api/reverse') return 'reverse'
  if (TILE_PATH_PATTERN.test(path)) return 'tile view'
  return null
}

interface MutableSlice {
  visitorIps: Set<string>
  requests: number
  pageLoads: number
  popupOpens: number
  searches: number
  hours: number[]
  referers: Map<string, number>
  devices: Map<string, number>
  devicePopups: Map<string, number>
  deviceSearches: Map<string, number>
  cells: Map<string, number>
}

function newSlice(): MutableSlice {
  return {
    visitorIps: new Set(),
    requests: 0,
    pageLoads: 0,
    popupOpens: 0,
    searches: 0,
    hours: Array(24).fill(0) as number[],
    referers: new Map(),
    devices: new Map(),
    devicePopups: new Map(),
    deviceSearches: new Map(),
    cells: new Map(),
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

/**
 * Pure parse core (unit-tested without sudo): folds complete log lines into
 * the live feed + today-window slices. `dayStartMs` is the current UTC
 * midnight — slices mean "today so far", never a rolling 24 h.
 */
export function scanLogLines(
  lines: string[],
  geoip: GeoipCountry,
  nowMs: number,
  dayStartMs: number,
): Omit<LogScan, 'ok'> {
  const onlineIps = new Set<string>()
  const events: LiveEvent[] = []
  const slices = new Map<string, MutableSlice>()
  const deviceVisitors: Record<string, Set<string>> = { mobile: new Set(), desktop: new Set() }
  const devicePopups: Record<string, number> = { mobile: 0, desktop: 0 }
  let parsedLines = 0
  let fromTs: number | null = null
  let toTs: number | null = null

  for (const line of lines) {
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const record = parsed as {
      ts?: number
      status?: number
      size?: number
      request?: {
        client_ip?: string
        remote_ip?: string
        method?: string
        uri?: string
        headers?: Record<string, string[]>
      }
    }
    if (typeof record.ts !== 'number' || !record.request) continue
    // status 0 + size 0 = the client hung up before Caddy answered.
    if (record.status === 0 && record.size === 0) continue
    parsedLines += 1
    const tsMs = record.ts * 1000
    if (fromTs === null || tsMs < fromTs) fromTs = tsMs
    if (toTs === null || tsMs > toTs) toTs = tsMs

    const ua = firstHeader(record.request.headers, 'User-Agent')
    if (BOT_UA_PATTERN.test(ua)) continue
    const ip = record.request.client_ip ?? record.request.remote_ip ?? ''
    if (!ip) continue

    if (tsMs >= nowMs - ONLINE_WINDOW_MS) onlineIps.add(ip)

    const queryIndex = (record.request.uri ?? '').indexOf('?')
    const rawUri = record.request.uri ?? ''
    const path = queryIndex < 0 ? rawUri : rawUri.slice(0, queryIndex)
    const action = classifyAction(record.request.method ?? '', path)
    if (action) {
      events.push({ ts: Math.round(tsMs), country: geoip(ip), agent: describeAgent(ua), action })
    }

    if (tsMs >= dayStartMs) {
      const country = geoip(ip)
      let slice = slices.get(country)
      if (!slice) {
        slice = newSlice()
        slices.set(country, slice)
      }
      slice.visitorIps.add(ip)
      slice.requests += 1
      slice.hours[new Date(tsMs).getUTCHours()] += 1
      const device = deviceClass(ua)
      bump(slice.devices, device)
      deviceVisitors[device].add(ip)
      if (action === 'page load') {
        slice.pageLoads += 1
        const referer = firstHeader(record.request.headers, 'Referer')
        bump(slice.referers, referer ? safeRefererHost(referer) : 'direct')
      } else if (action === 'popup open') {
        slice.popupOpens += 1
        devicePopups[device] += 1
        bump(slice.devicePopups, device)
        const query = queryIndex < 0 ? null : new URLSearchParams(rawUri.slice(queryIndex + 1))
        const lat = Number(query?.get('lat'))
        const lng = Number(query?.get('lng'))
        if (query && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          bump(slice.cells, `${(Math.round(lat * 100) / 100).toFixed(2)},${(Math.round(lng * 100) / 100).toFixed(2)}`)
        }
      } else if (action === 'search') {
        slice.searches += 1
        bump(slice.deviceSearches, device)
      }
    }
  }

  const byCountry: Record<string, CountrySlice> = {}
  for (const [country, slice] of slices) {
    byCountry[country] = {
      visitors: slice.visitorIps.size,
      requests: slice.requests,
      pageLoads: slice.pageLoads,
      popupOpens: slice.popupOpens,
      searches: slice.searches,
      hours: slice.hours,
      referers: Object.fromEntries([...slice.referers].sort((a, b) => b[1] - a[1])),
      devices: Object.fromEntries([...slice.devices].sort((a, b) => b[1] - a[1])),
      devicePopups: Object.fromEntries(slice.devicePopups),
      deviceSearches: Object.fromEntries(slice.deviceSearches),
      cells: [...slice.cells]
        .map(([key, opens]) => {
          const [lat, lng] = key.split(',').map(Number)
          return { lat, lng, opens }
        })
        .sort((a, b) => b.opens - a.opens),
    }
  }

  return {
    lines: parsedLines,
    fromTs,
    toTs,
    onlineNow: onlineIps.size,
    events: events.slice(-MAX_EVENTS),
    byCountry,
    deviceRates: {
      mobile: { visitors: deviceVisitors.mobile.size, popups: devicePopups.mobile },
      desktop: { visitors: deviceVisitors.desktop.size, popups: devicePopups.desktop },
    },
  }
}

function safeRefererHost(referer: string): string {
  try {
    let host = new URL(referer).hostname.toLowerCase()
    if (host.startsWith('www.')) host = host.slice(4)
    // Bare-IP referers carry no domain information; bucketed, never shown raw.
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) return 'ip-literal'
    return host || 'direct'
  } catch {
    return 'direct'
  }
}

function readLogTail(bytes: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'sudo',
      ['-n', 'tail', '-c', String(bytes), ACCESS_LOG_PATH],
      { maxBuffer: bytes + (1 << 20), timeout: EXEC_TIMEOUT_MS },
      (error, stdout) => (error ? reject(error) : resolvePromise(stdout)),
    )
  })
}

async function scanAccessLog(bytes: number): Promise<LogScan> {
  const nowMs = Date.now()
  const todayUtc = new Date(nowMs)
  todayUtc.setUTCHours(0, 0, 0, 0)
  try {
    const text = await readLogTail(bytes)
    // tail -c cuts mid-line: drop everything up to the first newline.
    const firstNewline = text.indexOf('\n')
    const complete = firstNewline < 0 ? '' : text.slice(firstNewline + 1)
    const reader = await geoipReader()
    const geoip: GeoipCountry = (ip) => {
      if (!reader) return '??'
      try {
        return reader.get(ip)?.country?.iso_code ?? '??'
      } catch {
        return '??'
      }
    }
    return { ok: true, ...scanLogLines(complete.split('\n'), geoip, nowMs, todayUtc.getTime()) }
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message.split('\n')[0],
      lines: 0,
      fromTs: null,
      toTs: null,
      onlineNow: null,
      events: [],
      byCountry: {},
      deviceRates: null,
    }
  }
}

function memoizedScan(bytes: number, ttlMs: number): () => Promise<LogScan> {
  let cached: { ts: number; promise: Promise<LogScan> } | null = null
  return () => {
    if (cached && Date.now() - cached.ts < ttlMs) return cached.promise
    const promise = scanAccessLog(bytes)
    cached = { ts: Date.now(), promise }
    // A rejected scan must not be served from cache forever after a fixed sudo.
    promise.catch(() => {
      if (cached?.promise === promise) cached = null
    })
    return promise
  }
}

/** Live strip view (online-now + feed): ~1 MB tail, memoized for 8 s. */
export const liveScan = memoizedScan(LIVE_TAIL_BYTES, LIVE_CACHE_MS)

/** Today-window slices (country filter, device rates): ~8 MB tail, 60 s. */
export const windowScan = memoizedScan(WINDOW_TAIL_BYTES, WINDOW_CACHE_MS)
