/**
 * Import Czech real estate listings from Sreality.cz → one properties.json.
 *
 * Noise is sampled from the z13 `total` HM3 raster (the live heatmap), not the
 * deprecated H3 tiles. Output: data/prepared/{DATA_YEAR}/properties/properties.json
 * + photos/, served at /api/properties. No H3 / h3-js.
 *
 * Usage:
 *   npx tsx import-properties.ts
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decompress } from 'fzstd'

const RATE_LIMIT_MS = 1200
const PHOTO_RATE_MS = 300
const DATA_YEAR = process.env.DATA_YEAR || '2026'
// Properties + photos live under one year-based dir, served at /api/properties.
const PROPERTIES_DIR = resolve(import.meta.dirname, '..', 'data', 'prepared', DATA_YEAR, 'properties')
const PHOTOS_DIR = resolve(PROPERTIES_DIR, 'photos')
// Noise sampled from the z13 `total` HM3 raster (the live heatmap).
const TOTAL_Z13_DIR = resolve(import.meta.dirname, '..', 'data', 'tiles', DATA_YEAR, 'heatmap-v3', 'total', '13')
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

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': '0db.app/1.0 noise-map' },
    signal: AbortSignal.timeout(30000),
  })
  return res.json()
}

// ── Sreality ──

const SREALITY_URL_SLUGS: Record<number, string> = {
  18: 'komercni', 19: 'bydleni', 20: 'pole', 21: 'les', 22: 'louka', 23: 'zahrada',
  33: 'chata', 35: 'pamatka', 37: 'rodinny', 39: 'vila', 40: 'na-klic', 43: 'chalupa', 44: 'zemedelska-usedlost',
}
const SREALITY_MAIN_SLUG: Record<number, string> = { 2: 'dum', 3: 'pozemek' }
const SREALITY_TYPE_SLUG: Record<number, string> = { 1: 'prodej', 2: 'pronajem' }

const SREALITY_QUERIES: [number, number, string, string][] = [
  [3, 1, 'land', 'buy'],
  [3, 2, 'land', 'rent'],
  [2, 1, 'house', 'buy'],
  [2, 2, 'house', 'rent'],
]

async function fetchSreality(): Promise<RawListing[]> {
  const listings: RawListing[] = []

  for (const [mainCb, typeCb, propertyType, listingType] of SREALITY_QUERIES) {
    const mainSlug = SREALITY_MAIN_SLUG[mainCb]
    const typeSlug = SREALITY_TYPE_SLUG[typeCb]
    let page = 1
    let total = 0

    console.log(`  Fetching Sreality ${mainSlug} ${typeSlug}...`)

    while (page <= MAX_PAGES) {
      const url = `https://www.sreality.cz/api/cs/v2/estates?category_main_cb=${mainCb}&category_type_cb=${typeCb}&per_page=${PER_PAGE}&page=${page}`
      try {
        const data = await fetchJson(url)
        if (page === 1) {
          total = data.result_size || 0
          console.log(`    Total: ${total}, ~${Math.ceil(total / PER_PAGE)} pages`)
        }

        const estates = data._embedded?.estates || []
        if (estates.length === 0) break

        for (const e of estates) {
          const gps = e.gps
          if (!gps?.lat || !gps?.lon) continue

          const subCb = e.seo?.category_sub_cb
          const urlSlug = SREALITY_URL_SLUGS[subCb] || 'bydleni'

          let photoUrl: string | null = null
          const imgs = e._links?.images
          if (Array.isArray(imgs) && imgs.length > 0) {
            const href = imgs[0].href
            if (href) photoUrl = href.replace(/\?.*$/, '') + '?fl=res,400,300,3|jpg,80'
          }

          listings.push({
            id: `sreality-${e.hash_id}`,
            title: e.name || (propertyType === 'land' ? 'Pozemek' : 'Dům'),
            price: e.price || 0,
            lat: gps.lat,
            lng: gps.lon,
            area: (() => { const m = e.name?.match(/(\d[\d\s]*)\s*m²/); return m ? parseInt(m[1].replace(/\s/g, '')) : null })(),
            type: propertyType,
            listing: listingType,
            url: `https://www.sreality.cz/detail/${typeSlug}/${mainSlug}/${urlSlug}/${e.seo?.locality || 'cz'}/${e.hash_id}`,
            photo: photoUrl,
            source: 'sreality',
          })
        }

        if (page % 50 === 0) console.log(`    Page ${page}/${Math.ceil(total / PER_PAGE)} — ${listings.length} total`)
        page++
        await sleep(RATE_LIMIT_MS)
      } catch (err: any) {
        console.error(`    Error page ${page}: ${err.message}`)
        if (page > 3) break
        await sleep(5000)
        page++
      }
    }
  }

  console.log(`  Sreality: ${listings.length} listings`)
  return listings
}

// ── Photo download (into the properties photos dir) ──

async function downloadPhotos(listings: RawListing[]): Promise<number> {
  let cookie = ''
  try {
    const res = await fetch('https://www.sreality.cz/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
    })
    cookie = (res.headers.getSetCookie?.() || []).map((c: string) => c.split(';')[0]).join('; ')
  } catch {}

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
          'Referer': 'https://www.sreality.cz/',
          'Cookie': cookie,
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

// ── Noise from the z13 `total` HM3 raster ──

const TILE_PX = 256
const NO_DATA = 255
const totalTileCache = new Map<string, Uint8Array | null>()

/** Decode one z13 `total` HM3 tile to its 256×256 cell bytes (255 = no data). */
function loadTotalTile(tx: number, ty: number): Uint8Array | null {
  const key = `${tx}/${ty}`
  const cached = totalTileCache.get(key)
  if (cached !== undefined) return cached

  const path = resolve(TOTAL_Z13_DIR, String(tx), `${ty}.bin`)
  if (!existsSync(path)) { totalTileCache.set(key, null); return null }

  // Bail (tile -> null, those properties get noise=null) on any format drift
  // rather than silently mis-sampling, mirroring the frontend HM3 decoder.
  const bail = () => { totalTileCache.set(key, null); return null }
  const buf = readFileSync(path)
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'HM3 ') return bail()
  if (buf.readUInt8(4) !== 1 || buf.readUInt16LE(8) !== TILE_PX || buf.readUInt8(11) !== 1) return bail()
  const isDense = (buf.readUInt8(7) & 1) !== 0
  const payloadLen = buf.readUInt32LE(16)
  const body = decompress(new Uint8Array(buf.buffer, buf.byteOffset + 20, payloadLen))

  const cells = new Uint8Array(TILE_PX * TILE_PX).fill(NO_DATA)
  if (isDense) {
    if (body.length < TILE_PX * TILE_PX) return bail()
    cells.set(body.subarray(0, TILE_PX * TILE_PX))
  } else {
    if (body.length < 32) return bail()
    const mask = body.subarray(0, 32)
    let off = 32
    for (let py = 0; py < TILE_PX; py++) {
      if ((mask[py >> 3] & (1 << (py & 7))) === 0) continue
      if (off + TILE_PX > body.length) return bail()
      cells.set(body.subarray(off, off + TILE_PX), py * TILE_PX)
      off += TILE_PX
    }
  }
  totalTileCache.set(key, cells)
  return cells
}

/** Total Lden (dB) at a point, or null beyond computed coverage. Web-Mercator
 *  z13 tile math mirrors the renderer + the heatmap hover tooltip. */
function sampleTotalLden(lat: number, lng: number): number | null {
  const n = 2 ** 13
  const latRad = (lat * Math.PI) / 180
  const merc = Math.log(Math.tan(latRad) + 1 / Math.cos(latRad))
  const xFloat = ((lng + 180) / 360) * n
  const yFloat = ((1 - merc / Math.PI) / 2) * n
  const tx = Math.floor(xFloat)
  const ty = Math.floor(yFloat)
  const cells = loadTotalTile(tx, ty)
  if (!cells) return null
  const px = Math.min(TILE_PX - 1, Math.floor((xFloat - tx) * TILE_PX))
  const py = Math.min(TILE_PX - 1, Math.floor((yFloat - ty) * TILE_PX))
  const byte = cells[py * TILE_PX + px]
  return byte === NO_DATA ? null : byte / 2
}

// ── Write one properties.json ──

function writePropertiesJson(listings: RawListing[]): void {
  const today = new Date().toISOString().slice(0, 10)
  let withNoise = 0

  const props: Property[] = listings.map((l) => {
    const noise = sampleTotalLden(l.lat, l.lng)
    if (noise !== null) withNoise++
    const localPhoto = resolve(PHOTOS_DIR, `${l.id}.jpg`)
    const photo = existsSync(localPhoto) ? `/api/properties/photos/${l.id}.jpg` : l.photo
    return {
      id: l.id, lat: l.lat, lng: l.lng, type: l.type, listing: l.listing,
      price: l.price, currency: 'CZK', area: l.area, title: l.title,
      url: l.url, photo, noise, updated: today,
    }
  })

  mkdirSync(PROPERTIES_DIR, { recursive: true })
  writeFileSync(resolve(PROPERTIES_DIR, 'properties.json'), JSON.stringify(props))
  console.log(`  Written: ${props.length} properties`)
  console.log(`  Noise sampled: ${withNoise}/${listings.length} (${listings.length ? (withNoise / listings.length * 100).toFixed(0) : 0}%)`)
}

// ── Main ──

async function main(): Promise<void> {
  console.log('=== Property Import (CZ) ===\n')

  const listings = await fetchSreality()

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
  writePropertiesJson(deduped)

  console.log('\n=== Done ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
