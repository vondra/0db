/**
 * Pure aggregation core for pipeline/web-stats.ts — turns one Caddy JSON
 * access record into anonymized per-day counters. No I/O lives here so the
 * classification rules stay unit-testable; the caller owns log reading,
 * SQLite writes and state. PRIVACY CONTRACT: the client IP may touch only
 * the in-memory VisitorSketch (irreversible HLL registers) and the GeoIP
 * lookup — it must never reach a returned counter, key, or term.
 */
import { createHash } from 'node:crypto'

/** Rare search queries can be personal addresses — only counts at/above
 *  this k-anonymity threshold may be persisted (applied per site+day+run). */
export const SEARCH_TERM_MIN_COUNT = 3

/** Uptime monitors and scanners carry browser-looking UA suffixes, so the
 *  match must stay substring-based rather than a token allowlist. */
export const BOT_UA_PATTERN =
  /bot|spider|crawl|slurp|curl|wget|python-requests|headless|scanner/i

/** Our own tooling pulls tiles through the public CDN with the default
 *  undress node fetch UA (65k requests on 2026-07-17 alone) — that is self
 *  traffic, not visitorship. Matched exactly so real UAs mentioning "node"
 *  stay unaffected. */
export function isSelfScriptUa(ua: string): boolean {
  return ua.trim().toLowerCase() === 'node'
}

const TILE_PATH_PATTERN = /^\/api\/tiles\/[^/]+\/[^/]+\/(\d{1,2})\/\d+\/\d+\.bin$/

/** 2048 registers (11 index bits): linear counting keeps the distinct-IP
 *  error near 1% at site scale (thousands of visitors/day). */
const SKETCH_REGISTER_COUNT = 2048
const SKETCH_RANK_BITS = 53 // 64-bit hash prefix minus the 11 index bits

/**
 * HLL sketch over sha256(client_ip) — mergeable by register-wise max, so
 * re-processing the same log bytes is a no-op and a UTC day split across
 * two nightly runs still counts each IP once. Registers hold only hash
 * run-lengths; the IPs themselves are unrecoverable, which is what makes
 * persisting the sketch anonymous.
 */
export class VisitorSketch {
  readonly registers: Uint8Array

  constructor(serialized?: Uint8Array) {
    this.registers =
      serialized && serialized.length === SKETCH_REGISTER_COUNT
        ? new Uint8Array(serialized)
        : new Uint8Array(SKETCH_REGISTER_COUNT)
  }

  addVisitor(ip: string): void {
    const bits = createHash('sha256').update(ip).digest().readBigUInt64BE(0)
    const index = Number(bits >> BigInt(SKETCH_RANK_BITS))
    let remaining = bits & ((1n << BigInt(SKETCH_RANK_BITS)) - 1n)
    let rank = 1
    let probe = 1n << BigInt(SKETCH_RANK_BITS - 1)
    while (rank <= SKETCH_RANK_BITS && (remaining & probe) === 0n) {
      rank += 1
      probe >>= 1n
    }
    if (rank > this.registers[index]) this.registers[index] = rank
  }

  mergeFrom(serialized: Uint8Array): void {
    const other = new VisitorSketch(serialized)
    for (let i = 0; i < SKETCH_REGISTER_COUNT; i += 1) {
      if (other.registers[i] > this.registers[i]) this.registers[i] = other.registers[i]
    }
  }

  estimate(): number {
    let zeros = 0
    let harmonicSum = 0
    for (const register of this.registers) {
      if (register === 0) zeros += 1
      harmonicSum += 2 ** -register
    }
    if (zeros > 0) {
      return Math.round(SKETCH_REGISTER_COUNT * Math.log(SKETCH_REGISTER_COUNT / zeros))
    }
    const alpha = 0.7213 / (1 + 1.079 / SKETCH_REGISTER_COUNT)
    return Math.round((alpha * SKETCH_REGISTER_COUNT ** 2) / harmonicSum)
  }

  serialize(): Buffer {
    return Buffer.from(this.registers)
  }
}

/** Per-(site, day) counters for one run; maps stay in memory until the
 *  caller flushes them to SQLite and drops the whole accumulator. */
export class DayAccumulator {
  readonly sketch = new VisitorSketch()
  requests = 0
  botRequests = 0
  pageLoads = 0
  readonly countries = new Map<string, number>()
  readonly browsers = new Map<string, number>()
  readonly oses = new Map<string, number>()
  readonly devices = new Map<string, number>()
  readonly languages = new Map<string, number>()
  readonly hours = new Map<number, number>()
  readonly referers = new Map<string, number>()
  readonly apiUsage = new Map<string, number>()
  readonly popupCells = new Map<string, number>() // key "lat,lng" at 0.01°
  readonly searchTerms = new Map<string, number>()
  readonly zooms = new Map<number, number>()
}

export function bump<T>(map: Map<T, number>, key: T): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

export function parseBrowserFamily(ua: string): string {
  if (/edg(a|ios)?\//i.test(ua)) return 'Edge' // before Chrome: Edg carries "Chrome/"
  if (/opr\/|opera/i.test(ua)) return 'Opera'
  if (/firefox|fxios/i.test(ua)) return 'Firefox'
  if (/chrome|crios|chromium/i.test(ua)) return 'Chrome'
  if (/safari/i.test(ua)) return 'Safari'
  return ua ? 'other' : 'unknown'
}

export function parseOsFamily(ua: string): string {
  if (/windows/i.test(ua)) return 'Windows'
  if (/android/i.test(ua)) return 'Android' // before Linux: Android carries "Linux"
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS'
  if (/mac os x|macintosh/i.test(ua)) return 'macOS'
  if (/linux/i.test(ua)) return 'Linux'
  return ua ? 'other' : 'unknown'
}

export function parseDeviceClass(ua: string): string {
  return /mobi|android|iphone|ipad|ipod/i.test(ua) ? 'mobile' : 'desktop'
}

export function parsePrimaryLanguage(acceptLanguage: string): string {
  const token = acceptLanguage.split(',')[0]?.split(';')[0]?.trim().toLowerCase() ?? ''
  const language = token.split('-')[0] ?? ''
  return /^[a-z]{2,3}$/.test(language) ? language : 'unknown'
}

export function parseRefererDomain(referer: string): string {
  if (!referer) return 'direct'
  try {
    let host = new URL(referer).hostname.toLowerCase()
    if (host.startsWith('www.')) host = host.slice(4)
    // A bare-IP Referer carries no domain information, and the no-IP
    // persistence contract covers every output — bucket it away.
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) return 'ip-literal'
    return host || 'direct'
  } catch {
    return 'direct'
  }
}

interface CaddyRecordLike {
  ts: number
  status: number
  size: number
  request: {
    client_ip?: string
    remote_ip?: string
    method?: string
    uri?: string
    headers?: Record<string, string[]>
  }
}

function asCaddyRecord(value: unknown): CaddyRecordLike | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.ts !== 'number' || typeof record.status !== 'number') return null
  if (typeof record.request !== 'object' || record.request === null) return null
  const size = typeof record.size === 'number' ? record.size : 0
  return { ...(record as object), size } as CaddyRecordLike
}

function firstHeader(headers: Record<string, string[]> | undefined, name: string): string {
  if (!headers) return ''
  const wanted = name.toLowerCase()
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return values?.[0] ?? ''
  }
  return ''
}

export type ClassifyOutcome = 'counted' | 'aborted' | 'bot' | 'malformed'

/** Fold one parsed log line into the accumulator of its UTC day. */
export function aggregateAccessRecord(
  value: unknown,
  day: DayAccumulator,
  geoipCountry: (ip: string) => string,
): ClassifyOutcome {
  const record = asCaddyRecord(value)
  if (!record) return 'malformed'
  // status 0 + size 0 = the client hung up before Caddy answered.
  if (record.status === 0 && record.size === 0) return 'aborted'

  const request = record.request
  const ua = firstHeader(request.headers, 'User-Agent')
  if (BOT_UA_PATTERN.test(ua) || isSelfScriptUa(ua)) {
    day.botRequests += 1
    return 'bot'
  }

  day.requests += 1
  // t.0db.app is proxied through Cloudflare, so client_ip there is the CF
  // edge (geo-labeled e.g. "SE"), not the visitor — CF forwards the real
  // address in Cf-Connecting-Ip. Direct vhosts send no such header.
  const ip = firstHeader(request.headers, 'Cf-Connecting-Ip')
    || request.client_ip || request.remote_ip || ''
  if (ip) {
    day.sketch.addVisitor(ip)
    bump(day.countries, geoipCountry(ip))
  } else {
    bump(day.countries, '??')
  }
  bump(day.hours, new Date(record.ts * 1000).getUTCHours())
  bump(day.browsers, parseBrowserFamily(ua))
  bump(day.oses, parseOsFamily(ua))
  bump(day.devices, parseDeviceClass(ua))
  bump(day.languages, parsePrimaryLanguage(firstHeader(request.headers, 'Accept-Language')))

  const uri = request.uri ?? ''
  const queryIndex = uri.indexOf('?')
  const path = queryIndex < 0 ? uri : uri.slice(0, queryIndex)
  const query = queryIndex < 0 ? null : new URLSearchParams(uri.slice(queryIndex + 1))

  if (request.method === 'GET' && path === '/') {
    day.pageLoads += 1
    bump(day.referers, parseRefererDomain(firstHeader(request.headers, 'Referer')))
    return 'counted'
  }

  if (path === '/api/noise-onfly-v2') {
    bump(day.apiUsage, 'popup_open')
    const lat = Number(query?.get('lat'))
    const lng = Number(query?.get('lng'))
    if (query && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      // Math.round first so -0.004 and +0.001 share the canonical "0.00" key.
      const cellKey = `${(Math.round(lat * 100) / 100).toFixed(2)},${(Math.round(lng * 100) / 100).toFixed(2)}`
      bump(day.popupCells, cellKey)
      if (query.get('full') === '1') bump(day.apiUsage, 'popup_open_full')
    }
  } else if (path === '/api/search') {
    bump(day.apiUsage, 'search')
    const term = (query?.get('q') ?? '').trim().toLowerCase().slice(0, 120)
    if (term) bump(day.searchTerms, term)
  } else if (path === '/api/isochron') {
    bump(day.apiUsage, 'isochron')
  } else if (path === '/api/reverse') {
    bump(day.apiUsage, 'reverse')
  } else {
    const tile = TILE_PATH_PATTERN.exec(path)
    if (tile) bump(day.zooms, Number(tile[1]))
  }
  return 'counted'
}
