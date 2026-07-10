/**
 * Import Czech real estate listings from Bezrealitky.cz → one properties.json.
 *
 * Source history: Sreality.cz's v2 API died with their 2026 site redesign AND
 * their 2026-04 terms now prohibit database extraction outright — dropped for
 * good (research 2026-07-10). Bezrealitky serves complete listing JSON in the
 * server-rendered __NEXT_DATA__ Apollo cache, no auth, and its terms carry no
 * scraping ban; same land+house scope as before.
 *
 * Noise is sampled from the published z12 `total` HM3 raster (the live
 * heatmap). Output: data/prepared/{DATA_YEAR}/properties/properties.json
 * + photos/, served at /api/properties. No H3 / h3-js.
 *
 * Usage:
 *   npx tsx import-properties.ts
 */

import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DATA_YEAR } from './lib/data-year.js'

const RATE_LIMIT_MS = 1200
const PHOTO_RATE_MS = 300
// Properties + photos live under one year-based dir, served at /api/properties.
const PROPERTIES_DIR = resolve(import.meta.dirname, '..', 'data', 'prepared', DATA_YEAR, 'properties')
const PHOTOS_DIR = resolve(PROPERTIES_DIR, 'photos')
// Noise sampled from the published `total` heatmap over HTTP — the same
// immutable pmtiles build the map serves (build-id from /api/tiles-manifest),
// so listings and the visible heatmap can never disagree. Ported 2026-07-10
// from the retired pre-512 loose z13 tree.
const TILE_SERVER = process.env.PROPERTIES_TILE_SERVER || 'http://localhost:8531'
const PER_PAGE = 60
const MAX_PAGES = 500

interface RawListing {
  id: string
  title: string
  price: number
  lat: number
  lng: number
  area: number | null
  type: string
  listing: string
  url: string
  photo: string | null
  source: string
}

interface Property {
  id: string
  lat: number
  lng: number
  type: string
  listing: string
  price: number
  currency: string
  area: number | null
  title: string
  url: string
  photo: string | null
  noise: number | null
  updated: string
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ── Bezrealitky ──

const BEZREALITKY_QUERIES: [string, string, string, string][] = [
  // [estateType, offerType, our property type, our listing kind] — same
  // land+house scope the map always had (About: "Focus: land plots").
  ['POZEMEK', 'PRODEJ', 'land', 'buy'],
  ['POZEMEK', 'PRONAJEM', 'land', 'rent'],
  ['DUM', 'PRODEJ', 'house', 'buy'],
  ['DUM', 'PRONAJEM', 'house', 'rent'],
]

const BR_PAGE_SIZE = 15 // fixed by their search page

interface BrAdvert {
  id: string
  uri: string
  price: number | null
  currency: string | null
  surface: number | null
  surfaceLand: number | null
  gps: { lat: number; lng: number } | null
  mainImage: { __ref: string } | null
  [localeKeyed: string]: unknown
}

/** Pull one search page's __NEXT_DATA__ Apollo cache. Returns the adverts,
 *  the Image cache (photo URLs) and totalCount for pagination. */
async function fetchBezrealitkyPage(
  estateType: string,
  offerType: string,
  page: number,
): Promise<{ adverts: BrAdvert[]; images: Map<string, string>; total: number }> {
  const url = `https://www.bezrealitky.com/search?currency=CZK&estateType=${estateType}&offerType=${offerType}&page=${page}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) 0db.app/1.0 noise-map' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)
  if (!m) throw new Error('__NEXT_DATA__ missing — site layout drift')
  const cache = JSON.parse(m[1])?.props?.pageProps?.apolloCache ?? {}

  const images = new Map<string, string>()
  for (const [key, value] of Object.entries(cache)) {
    if (!key.startsWith('Image:')) continue
    const v = value as Record<string, unknown>
    const thumb = v['url({"filter":"RECORD_THUMB"})'] ?? v['url({"filter":"RECORD_MAIN"})']
    if (typeof thumb === 'string') images.set(key, thumb)
  }
  const adverts = Object.entries(cache)
    .filter(([k]) => k.startsWith('Advert:'))
    .map(([, v]) => v as BrAdvert)

  let total = 0
  const root = (cache.ROOT_QUERY ?? {}) as Record<string, { totalCount?: number }>
  for (const [key, value] of Object.entries(root)) {
    // Match OUR list query (full pagination shape), not the sidebar teasers.
    if (key.startsWith('listAdverts') && key.includes('"offset"') && value?.totalCount != null) {
      total = value.totalCount
      break
    }
  }
  return { adverts, images, total }
}

async function fetchBezrealitky(): Promise<RawListing[]> {
  const listings: RawListing[] = []

  for (const [estateType, offerType, propertyType, listingType] of BEZREALITKY_QUERIES) {
    console.log(`  Fetching Bezrealitky ${estateType} ${offerType}...`)
    let page = 1
    let pages = 1
    while (page <= Math.min(pages, MAX_PAGES)) {
      try {
        const { adverts, images, total } = await fetchBezrealitkyPage(estateType, offerType, page)
        if (page === 1) {
          pages = Math.ceil(total / BR_PAGE_SIZE)
          console.log(`    Total: ${total}, ${pages} pages`)
        }
        for (const a of adverts) {
          if (!a.gps || a.price == null) continue
          const addressEn = a['address({"locale":"EN"})']
          const title = typeof addressEn === 'string' && addressEn
            ? addressEn
            : a.uri.replace(/^\d+-nabidka-/, '').replaceAll('-', ' ')
          listings.push({
            id: `bezrealitky-${a.id}`,
            title,
            price: a.price,
            lat: a.gps.lat,
            lng: a.gps.lng,
            area: a.surfaceLand ?? a.surface ?? null,
            type: propertyType,
            listing: listingType,
            url: `https://www.bezrealitky.cz/nemovitosti-byty-domy/${a.uri}`,
            photo: (a.mainImage && images.get(a.mainImage.__ref)) || null,
            source: 'bezrealitky',
          })
        }
      } catch (err) {
        console.log(`    Error page ${page}: ${err instanceof Error ? err.message : err}`)
      }
      page++
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
    }
  }

  return listings
}

// ── Photo download (into the properties photos dir) ──

async function downloadPhotos(listings: RawListing[]): Promise<number> {
  mkdirSync(PHOTOS_DIR, { recursive: true })
  let downloaded = 0, skipped = 0, failed = 0

  for (const l of listings) {
    if (!l.photo) continue
    const dest = resolve(PHOTOS_DIR, `${l.id}.jpg`)
    if (existsSync(dest)) { skipped++; continue }

    try {
      const res = await fetch(l.photo, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
          'Accept': 'image/*',
        },
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > 1000) { writeFileSync(dest, buf); downloaded++ }
        else failed++
      } else failed++
    } catch { failed++ }

    if ((downloaded + failed) % 500 === 0 && downloaded > 0) {
      console.log(`    ${downloaded} downloaded, ${skipped} cached, ${failed} failed`)
    }
    await sleep(PHOTO_RATE_MS)
  }

  console.log(`  Photos: ${downloaded} new, ${skipped} cached, ${failed} failed`)
  return downloaded
}

// ── Noise from the published `total` heatmap (512@z12, HM3 v3, HTTP) ──

const TILE_PX = 512
const TILE_Z = 12
const NO_DATA = 255
let tileBuild: string | null = null
const totalTileCache = new Map<string, Uint8Array | null>()

/** Resolve the published tile generation once; FATAL when nothing is
 *  published — a silent miss would stamp every listing noise=null. */
async function resolveTileBuild(): Promise<string> {
  const res = await fetch(`${TILE_SERVER}/api/tiles-manifest`)
  if (!res.ok) throw new Error(`tiles-manifest: HTTP ${res.status} on ${TILE_SERVER}`)
  const manifest = (await res.json()) as { build?: string }
  if (!manifest.build) throw new Error('tiles-manifest has no build — publish tiles first (tile-store-pack)')
  return manifest.build
}

/** Fetch + decode one z12 `total` HM3 v3 tile (512² cells; 255 = no data).
 *  The server sends Content-Encoding: br — Node's fetch decompresses
 *  transparently, so we only validate the 6-byte header. Any format drift
 *  bails to null (those listings get noise=null) rather than mis-sampling. */
async function loadTotalTile(tx: number, ty: number): Promise<Uint8Array | null> {
  const key = `${tx}/${ty}`
  const cached = totalTileCache.get(key)
  if (cached !== undefined) return cached
  const bail = () => { totalTileCache.set(key, null); return null }
  let buf: ArrayBuffer
  try {
    const res = await fetch(`${TILE_SERVER}/api/tiles/${tileBuild}/total/${TILE_Z}/${tx}/${ty}.bin`)
    if (res.status === 204) return bail()
    if (!res.ok) return bail()
    buf = await res.arrayBuffer()
  } catch {
    return bail()
  }
  const bytes = new Uint8Array(buf)
  if (bytes.length !== 6 + TILE_PX * TILE_PX) return bail()
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'HM3 ' || bytes[4] !== 3) return bail()
  const cells = bytes.subarray(6)
  totalTileCache.set(key, cells)
  return cells
}

/** Total Lden (dB) at a point, or null beyond computed coverage. Web-Mercator
 *  z12/512px tile math mirrors the renderer + the heatmap hover tooltip. */
async function sampleTotalLden(lat: number, lng: number): Promise<number | null> {
  const n = 2 ** TILE_Z
  const latRad = (lat * Math.PI) / 180
  const merc = Math.log(Math.tan(latRad) + 1 / Math.cos(latRad))
  const xFloat = ((lng + 180) / 360) * n
  const yFloat = ((1 - merc / Math.PI) / 2) * n
  const tx = Math.floor(xFloat)
  const ty = Math.floor(yFloat)
  const cells = await loadTotalTile(tx, ty)
  if (!cells) return null
  const px = Math.min(TILE_PX - 1, Math.floor((xFloat - tx) * TILE_PX))
  const py = Math.min(TILE_PX - 1, Math.floor((yFloat - ty) * TILE_PX))
  const byte = cells[py * TILE_PX + px]
  return byte === NO_DATA ? null : byte / 2
}

// ── Write one properties.json ──

async function writePropertiesJson(listings: RawListing[]): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  let withNoise = 0

  const props: Property[] = []
  for (const l of listings) {
    const noise = await sampleTotalLden(l.lat, l.lng)
    if (noise !== null) withNoise++
    const localPhoto = resolve(PHOTOS_DIR, `${l.id}.jpg`)
    const photo = existsSync(localPhoto) ? `/api/properties/photos/${l.id}.jpg` : l.photo
    props.push({
      id: l.id, lat: l.lat, lng: l.lng, type: l.type, listing: l.listing,
      price: l.price, currency: 'CZK', area: l.area, title: l.title,
      url: l.url, photo, noise, updated: today,
    })
  }

  mkdirSync(PROPERTIES_DIR, { recursive: true })
  writeFileSync(resolve(PROPERTIES_DIR, 'properties.json'), JSON.stringify(props))
  console.log(`  Written: ${props.length} properties`)
  console.log(`  Noise sampled: ${withNoise}/${listings.length} (${listings.length ? (withNoise / listings.length * 100).toFixed(0) : 0}%)`)
}

// ── Main ──

async function main(): Promise<void> {
  console.log('=== Property Import (CZ / Bezrealitky) ===\n')
  // Resolve the published tile build up front — refusing to run beats
  // silently stamping every listing with noise=null.
  try {
    tileBuild = await resolveTileBuild()
    console.log(`  Noise source: ${TILE_SERVER} build ${tileBuild} (total @ z${TILE_Z})`)
  } catch (err) {
    console.error(`FATAL: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  const listings = await fetchBezrealitky()

  const seen = new Set<string>()
  const deduped = listings.filter(l => {
    if (seen.has(l.id)) return false
    seen.add(l.id)
    return true
  })
  console.log(`  Deduped: ${listings.length} → ${deduped.length}`)
  if (deduped.length === 0) { console.log('No listings.'); return }

  // Photos first so the JSON can point at the local copies that landed.
  console.log('\n  Downloading photos...')
  await downloadPhotos(deduped)

  console.log('\n  Writing properties.json...')
  await writePropertiesJson(deduped)

  console.log('\n=== Done ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
