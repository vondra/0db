/**
 * Import Czech real estate properties from Sreality.cz → H3R4 partitioned JSON.
 *
 * No PostgreSQL — writes properties.json into data/prepared/h3r4/{hex}/.
 * Noise levels looked up from pre-computed .bin tiles.
 *
 * Usage:
 *   npx tsx import-properties.ts
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { latLngToCell, cellToParent } from 'h3-js'

const RATE_LIMIT_MS = 1200
const PHOTO_RATE_MS = 300
// Photos are written directly into h3r4/{hex}/real-estate/ alongside index.json
const H3R4_DIR = resolve(import.meta.dirname, '../data/prepared/h3r4')
const TILES_DIR = resolve(import.meta.dirname, '../data/tiles/h3-tiles')
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

const SREALITY_SUB_TYPES: Record<number, string> = {
  18: 'komerční', 19: 'stavební', 20: 'pole', 21: 'les', 22: 'louka', 23: 'zahrada',
  33: 'chata', 35: 'památka', 37: 'rodinný dům', 39: 'vila', 40: 'na klíč', 43: 'chalupa', 44: 'usedlost',
}
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

// ── Photo download (into H3R4 hex dirs) ──

async function downloadPhotos(listings: RawListing[], hexMap: Map<string, string>): Promise<number> {
  let cookie = ''
  try {
    const res = await fetch('https://www.sreality.cz/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
    })
    cookie = (res.headers.getSetCookie?.() || []).map((c: string) => c.split(';')[0]).join('; ')
  } catch {}

  let downloaded = 0, skipped = 0, failed = 0

  for (const l of listings) {
    if (!l.photo) continue
    const hex = hexMap.get(l.id)
    if (!hex) continue

    const dir = resolve(H3R4_DIR, hex, 'real-estate')
    mkdirSync(dir, { recursive: true })
    const filename = `${l.id}.jpg`
    if (existsSync(resolve(dir, filename))) { skipped++; continue }

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
        if (buf.length > 1000) {
          writeFileSync(resolve(dir, filename), buf)
          downloaded++
        } else failed++
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

// ── Noise lookup from .bin tiles ──

const MAGIC = Buffer.from('H3N1', 'ascii')
const tileCache = new Map<string, { hexes: BigInt64Array; lden: Int16Array } | null>()

function loadTile(filePath: string): { hexes: BigInt64Array; lden: Int16Array } | null {
  if (tileCache.has(filePath)) return tileCache.get(filePath)!
  if (!existsSync(filePath)) { tileCache.set(filePath, null); return null }

  const buf = readFileSync(filePath)
  if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'H3N1') { tileCache.set(filePath, null); return null }

  const count = buf.readUInt32LE(4)
  const hexes = new BigInt64Array(count)
  const lden = new Int16Array(count)
  for (let i = 0; i < count; i++) {
    hexes[i] = buf.readBigUInt64LE(8 + i * 8)
    lden[i] = buf.readInt16LE(8 + count * 8 + i * 2)
  }
  tileCache.set(filePath, { hexes, lden })
  return { hexes, lden }
}

function lookupNoise(lat: number, lng: number): number | null {
  // Convert to H3 res-11, find partition (res-5 parent)
  let h3_11: string
  try { h3_11 = latLngToCell(lat, lng, 11) } catch { return null }

  const h3bi = BigInt('0x' + h3_11)

  const parent5 = cellToParent(h3_11, 5)
  const tilePath = resolve(TILES_DIR, 'r11', 'total', `${parent5}.bin`)
  const tile = loadTile(tilePath)
  if (!tile) return null

  // Binary search (BigInt64Array values compared as BigInt)
  let lo = 0, hi = tile.hexes.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const v = tile.hexes[mid]
    if (v === h3bi) return tile.lden[mid] / 10
    if (v < h3bi) lo = mid + 1
    else hi = mid - 1
  }
  return null
}

// ── Partition into H3R4 files ──

function writeProperties(listings: RawListing[]): { hexMap: Map<string, string> } {
  const today = new Date().toISOString().slice(0, 10)
  const hexMap = new Map<string, string>() // listing id → hex
  const groups = new Map<string, Property[]>()
  let withNoise = 0

  for (const l of listings) {
    let hex: string
    try { hex = latLngToCell(l.lat, l.lng, 4) } catch { continue }
    hexMap.set(l.id, hex)

    const noise = lookupNoise(l.lat, l.lng)
    if (noise !== null) withNoise++

    // Photo URL: local file in properties/ subdir, or external fallback
    const filename = `${l.id}.jpg`
    const localDir = resolve(H3R4_DIR, hex, 'real-estate')
    const hasLocal = existsSync(resolve(localDir, filename))
    const photo = hasLocal ? `/api/h3r4/${hex}/real-estate/${filename}` : l.photo

    const prop: Property = {
      id: l.id, lat: l.lat, lng: l.lng, type: l.type, listing: l.listing,
      price: l.price, currency: 'CZK', area: l.area, title: l.title,
      url: l.url, photo, noise, updated: today,
    }

    let group = groups.get(hex)
    if (!group) { group = []; groups.set(hex, group) }
    group.push(prop)
  }

  // Write index.json per hex
  let totalWritten = 0
  for (const [hex, props] of groups) {
    const dir = resolve(H3R4_DIR, hex, 'real-estate')
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, 'index.json'), JSON.stringify(props))
    totalWritten += props.length
  }

  console.log(`  Written: ${totalWritten} properties across ${groups.size} hexes`)
  console.log(`  Noise lookup: ${withNoise}/${listings.length} (${(withNoise / listings.length * 100).toFixed(0)}%)`)
  return { hexMap }
}

// ── Main ──

async function main(): Promise<void> {
  console.log('=== Property Import (CZ) ===\n')

  const listings = await fetchSreality()

  // Deduplicate
  const seen = new Set<string>()
  const deduped = listings.filter(l => {
    if (seen.has(l.id)) return false
    seen.add(l.id)
    return true
  })
  console.log(`  Deduped: ${listings.length} → ${deduped.length}`)

  if (deduped.length === 0) { console.log('No listings.'); return }

  // Noise lookup + partition + write index.json
  console.log('\n  Writing H3R4 properties...')
  const { hexMap } = writeProperties(deduped)

  // Download photos into h3r4/{hex}/real-estate/
  console.log('\n  Downloading photos...')
  await downloadPhotos(deduped, hexMap)

  // Re-write index.json with updated photo paths (local photos now exist)
  console.log('\n  Updating photo paths...')
  writeProperties(deduped)

  console.log('\n=== Done ===')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
