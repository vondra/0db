import type { FastifyInstance } from 'fastify'
import { EXPENSIVE_ROUTE_RATE_LIMIT } from '../rate-limit.js'

// Live proxy to Stay22's Direct Travel API (bookable hotels + vacation
// rentals with affiliate links). Their terms forbid cold-storing listing
// data, so results live only in a short in-memory cache (55 min, their
// recommended TTL). The keyless demo tier allows 5 requests/min — viewport
// queries are snapped to a coarse grid so panning reuses cache entries, and
// a global token bucket throttles upstream calls; when the budget is spent
// a bucket serves its stale copy rather than erroring.
const STAY22_URL = 'https://api.stay22.com/v2/accommodations'
// Demo affiliate id until the owner's Stay22 Hub account exists; the env var
// then switches attribution without a code change.
const AID = process.env.STAY22_AID || 'stay22'
const CACHE_TTL_MS = 55 * 60 * 1000
// Expired entries may still be served when the upstream budget is spent or
// the upstream is down — but a quote older than this is worse than an empty
// map (prices drift, listings close).
const STALE_MAX_MS = 6 * 60 * 60 * 1000
const CACHE_MAX = 300
const UPSTREAM_PER_MIN = 4 // demo tier is 5/min; keep one in reserve (fixed window, no burst)
const GRID_DEG = 0.05      // bbox snap (~5.5 km lat) — pan within a cell = cache hit
// Refuse country-scale boxes. Sized so the widest sane viewport at the
// client's minimum zoom (~4300 css px at z11, plus snap growth) still fits —
// a tighter cap silently blanked the layer on ultrawide monitors.
const MAX_SPAN_DEG = 1.5
// One page must hold every H3 representative (see pickPrecision) — if the two
// ever drift, cluster=top silently page-truncates to a spatially biased subset.
const PAGE_SIZE = 100

interface SlimStay {
  id: string
  name: string
  lat: number
  lng: number
  thumbnail: string | null
  rating: { value: number | null; count: number | null; stars: number | null }
  capacity: { guests: number | null; bedrooms: number | null }
  freeCancellation: boolean
  price: { total: number; perNight: number } | null
  url: string
}
interface StayPayload {
  listings: SlimStay[]
  meta: { checkin: string; checkout: string; nights: number; currency: string; stale?: boolean }
}

const cache = new Map<string, { at: number; payload: StayPayload }>()
// Single-flight: concurrent requests for one bucket share one upstream call
// (and one token) instead of racing past the completed-entry cache.
const inflight = new Map<string, Promise<StayPayload>>()

// Sliding-window call log, not a token bucket: a bucket with refill lets a
// full burst plus refills reach 2× the cap inside one 60 s window, which
// would trip Stay22's own limiter.
const upstreamCalls: number[] = []
function takeToken(): boolean {
  const now = Date.now()
  while (upstreamCalls.length > 0 && upstreamCalls[0] <= now - 60_000) upstreamCalls.shift()
  if (upstreamCalls.length >= UPSTREAM_PER_MIN) return false
  upstreamCalls.push(now)
  return true
}

// A stable near-future stay (4 weeks out, 2 nights) so prices are real and
// comparable across pins; the dates sit in the cache key, so entries roll
// over naturally at midnight.
const CHECKIN_OFFSET_DAYS = 28
const NIGHTS = 2
function defaultDates(): { checkin: string; checkout: string; nights: number } {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  return { checkin: day(CHECKIN_OFFSET_DAYS), checkout: day(CHECKIN_OFFSET_DAYS + NIGHTS), nights: NIGHTS }
}

// The epsilon keeps grid-boundary values in place — bare floor(50.05/0.05)
// lands on 1000.999…, snapping a whole cell too far and doubling the box.
// Mirrored in frontend/src/components/StayLayer.tsx so client URLs land on
// the same buckets — keep the two in sync.
export const snap = (v: number, up: boolean) => {
  const q = v / GRID_DEG
  return ((up ? Math.ceil(q - 1e-9) : Math.floor(q + 1e-9)) * GRID_DEG).toFixed(2)
}

// Average H3 hex areas (km²) for resolutions r4..r10. r4 exists so even the
// largest allowed box at the equator (~27,700 km²) stays under one page —
// r5 alone would need ~110 cells there and silently truncate.
const H3_AREA_KM2: [number, number][] = [[4, 1770.3], [5, 252.9], [6, 36.13], [7, 5.161], [8, 0.7373], [9, 0.1053], [10, 0.01505]]

// Finest H3 resolution whose cell count over the bbox still fits one page —
// then `cluster=top` returns EVERY cell's best-rated stay and coverage is
// uniform; a finer grid would page-truncate to an arbitrary spatial subset.
export function pickPrecision(swlat: number, swlng: number, nelat: number, nelng: number): number {
  const midLat = ((swlat + nelat) / 2) * (Math.PI / 180)
  const areaKm2 = (nelat - swlat) * 111 * (nelng - swlng) * 111 * Math.cos(midLat)
  let res = H3_AREA_KM2[0][0]
  for (const [r, hex] of H3_AREA_KM2) if (areaKm2 / hex <= PAGE_SIZE) res = r
  return res
}

// Upstream strings that reach the client as href/src must be https — a
// poisoned `javascript:` link would execute on click (React escapes text,
// not URL schemes).
const httpsOnly = (v: unknown): string | null =>
  typeof v === 'string' && v.startsWith('https://') ? v : null

// The client renders and computes with these — a stray string from upstream
// (e.g. "8.9") would throw in the card's toFixed.
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function slim(result: any, nights: number): SlimStay | null {
  const lat = result?.location?.coordinates?.lat
  const lng = result?.location?.coordinates?.lng
  const url = httpsOnly(result?.url)
  if (typeof lat !== 'number' || typeof lng !== 'number' || !url || !result?.name) return null
  // The cheapest supplier drives the shown price; per-supplier detail is not
  // exposed — the card's single CTA is the aggregated roam link.
  const totals = Object.values(result.suppliers ?? {})
    .map((s: any) => num(s?.price?.total))
    .filter((t): t is number => t != null)
  const cheapest = totals.length > 0 ? Math.min(...totals) : null
  return {
    id: String(result.id),
    name: result.name,
    lat,
    lng,
    thumbnail: httpsOnly(result.media?.thumbnail),
    rating: {
      value: num(result.rating?.value),
      count: num(result.rating?.count),
      stars: num(result.rating?.hotelStars),
    },
    capacity: {
      guests: num(result.capacity?.guests),
      bedrooms: num(result.capacity?.bedrooms),
    },
    freeCancellation: result.policies?.freeCancellation === true,
    price: cheapest != null ? { total: cheapest, perNight: Math.round(cheapest / nights) } : null,
    url,
  }
}

export async function stayRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stay', { config: { rateLimit: EXPENSIVE_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const swlat = parseFloat(q.swlat ?? '')
    const swlng = parseFloat(q.swlng ?? '')
    const nelat = parseFloat(q.nelat ?? '')
    const nelng = parseFloat(q.nelng ?? '')
    if (![swlat, swlng, nelat, nelng].every(Number.isFinite) || nelat <= swlat || nelng <= swlng) {
      return reply.code(400).send({ error: 'invalid bbox' })
    }
    if (nelat - swlat > MAX_SPAN_DEG || nelng - swlng > MAX_SPAN_DEG) {
      return reply.code(400).send({ error: 'bbox too large' })
    }
    const type = q.type === 'hotel' || q.type === 'rental' ? q.type : null

    const dates = defaultDates()
    const bbox = { swlat: snap(swlat, false), swlng: snap(swlng, false), nelat: snap(nelat, true), nelng: snap(nelng, true) }
    const key = `${bbox.swlat},${bbox.swlng},${bbox.nelat},${bbox.nelng}|${type ?? 'all'}|${dates.checkin}`

    // Success responses only — an explicit max-age on a 429/502 would let
    // shared caches (Cloudflare) pin the error for 5 minutes.
    const sendOk = (payload: StayPayload) =>
      reply.header('Cache-Control', 'public, max-age=300').send(payload)

    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return sendOk(hit.payload)
    const stale = hit && Date.now() - hit.at < STALE_MAX_MS
      ? { ...hit.payload, meta: { ...hit.payload.meta, stale: true } }
      : null

    let pending = inflight.get(key)
    if (!pending) {
      if (!takeToken()) {
        // Out of demo budget: a stale copy beats an error, an empty map beats a 500.
        if (stale) return sendOk(stale)
        return reply.code(429).header('Retry-After', '15').send({ error: 'rate limited' })
      }

      const params = new URLSearchParams({
        ...bbox,
        checkin: dates.checkin,
        checkout: dates.checkout,
        pageSize: String(PAGE_SIZE),
        currency: 'eur',
        // One best-rated stay per H3 cell, spread across the viewport — a flat
        // list caps at one page of results that cluster wherever the city is
        // densest and leaves the rest of the screen empty.
        cluster: 'top',
        precision: String(pickPrecision(parseFloat(bbox.swlat), parseFloat(bbox.swlng), parseFloat(bbox.nelat), parseFloat(bbox.nelng))),
        aid: AID,
        campaign: '0db',
      })
      if (type) params.set('type', type)

      pending = (async () => {
        const res = await fetch(`${STAY22_URL}?${params}`, { signal: AbortSignal.timeout(12_000) })
        if (!res.ok) throw new Error(`stay22 ${res.status}`)
        const data: any = await res.json()
        const listings = ((data?.results ?? []) as any[])
          .slice(0, PAGE_SIZE) // never trust upstream to honour its own cap
          .map(r => slim(r, dates.nights))
          .filter((s): s is SlimStay => s !== null)
        const payload: StayPayload = { listings, meta: { ...dates, currency: 'EUR' } }
        cache.delete(key) // re-insert so a refreshed bucket is newest for eviction
        cache.set(key, { at: Date.now(), payload })
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
        return payload
      })()
      inflight.set(key, pending)
      void pending.catch(() => {}).finally(() => inflight.delete(key))
    }

    try {
      return sendOk(await pending)
    } catch (err) {
      request.log.warn({ err }, 'stay22 fetch failed')
      if (stale) return sendOk(stale)
      return reply.code(502).send({ error: 'upstream unavailable' })
    }
  })
}
