/**
 * Build the H3R4 → admin lookup table (`data/prepared/h3r4-admin.bin`).
 *
 * For every land H3R4 hex present in `data/prepared/{YEAR}/h3r4/`, assign
 * (continent, country, metro_city). Engine loads this binary at startup and
 * uses it to select per-country / per-city defaults in the hierarchical
 * traffic cascade (see `engine/noise-compute/src/defaults.rs`).
 *
 * Data sources:
 *   - Natural Earth 1:10 m Admin-0 Countries (GeoJSON from nvkelso's
 *     natural-earth-vector mirror, cached in scripts/cache/).
 *     Downloaded on first run, ~8 MB.
 *   - `scripts/h3-admin-metros.json` — hand-curated bboxes for ~30 metros.
 *
 * Geopolitical note (plan v5 /gg DeepSeek W4):
 * Natural Earth encodes a specific view of contested boundaries (Crimea,
 * Kashmir, Taiwan, ...). This is a documented project policy: hex-centroid
 * PIP is a best-effort approximation, regenerable from a different polygon
 * source without touching arrow data.
 *
 * Output binary format (little-endian):
 *   bytes 0-7:     magic "H3ADMIN1"
 *   bytes 8-11:    u32 count (number of entries)
 *   bytes 12..:    [u64 hex_id, u8 continent, u8 country, u16 city] × count
 *                  sorted ascending by hex_id.
 *
 * Usage:
 *   cd scripts && npm i    # one-time (needs tsx)
 *   DATA_YEAR=2025 npx tsx build-h3-admin.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cellToLatLng } from 'h3-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const YEAR = process.env.DATA_YEAR || '2025'
const CACHE_DIR = resolve(__dirname, 'cache')
const NE_GEOJSON = resolve(CACHE_DIR, 'ne_10m_admin_0_countries.geojson')
const NE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson'
const METROS_JSON = resolve(__dirname, 'h3-admin-metros.json')
const H3R4_DIR = resolve(__dirname, `../data/prepared/${YEAR}/h3r4`)
const OUTPUT_BIN = resolve(__dirname, '../data/prepared/h3r4-admin.bin')

// ─── Continent + country tables (mirrored in engine/noise-compute/src/admin.rs)

/**
 * Continent ids — mirror `engine/noise-compute/src/admin.rs::Continent`.
 * Natural Earth CONTINENT values fold into these:
 *   "Europe" → EU
 *   "North America" / "Central America" → NA
 *   "South America" → SA
 *   "Asia" → AS
 *   "Africa" → AF
 *   "Oceania" → OC
 *   "Seven seas (open ocean)" / "Antarctica" → UNKNOWN
 */
const CONTINENT_ID: Record<string, number> = {
  UNKNOWN: 0,
  EU: 1,
  NA: 2,
  SA: 3,
  AS: 4,
  AF: 5,
  OC: 6,
}

function continentIdFromNE(ne: string): number {
  switch (ne) {
    case 'Europe': return CONTINENT_ID.EU
    case 'North America': return CONTINENT_ID.NA
    case 'South America': return CONTINENT_ID.SA
    case 'Asia': return CONTINENT_ID.AS
    case 'Africa': return CONTINENT_ID.AF
    case 'Oceania': return CONTINENT_ID.OC
    default: return CONTINENT_ID.UNKNOWN
  }
}

// ─── Natural Earth loading ─────────────────────────────────────────────────

interface CountryFeature {
  iso: string          // ISO alpha-2 ("CZ", "BR", ...)
  continent: number    // continent id
  rings: number[][][]  // polygon rings: [ [[x,y],...], ... ] — MultiPolygon flattened
}

async function loadNaturalEarth(): Promise<CountryFeature[]> {
  if (!existsSync(NE_GEOJSON)) {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
    console.log(`Downloading Natural Earth countries from ${NE_URL}...`)
    const res = await fetch(NE_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    writeFileSync(NE_GEOJSON, bytes)
    console.log(`  cached ${(bytes.length / 1_000_000).toFixed(1)} MB to ${NE_GEOJSON}`)
  }

  const geojson = JSON.parse(readFileSync(NE_GEOJSON, 'utf-8'))
  const features: CountryFeature[] = []
  for (const f of geojson.features) {
    const iso: string = f.properties.ISO_A2_EH || f.properties.ISO_A2 || ''
    if (!iso || iso === '-99') continue  // NE uses "-99" for disputed
    const continent = continentIdFromNE(f.properties.CONTINENT)
    const geom = f.geometry
    const rings: number[][][] = []
    if (geom.type === 'Polygon') {
      // rings[0] = outer, rings[1..] = holes — we accept all as outer (simpler PIP, ignore holes)
      rings.push(geom.coordinates[0])
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) rings.push(poly[0])
    }
    features.push({ iso, continent, rings })
  }
  return features
}

// ─── Point-in-polygon (hand-rolled ray-casting) ────────────────────────────

/** Ray-cast PIP for a simple polygon (ring is [[lon, lat], ...]). */
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
      inside = !inside
    }
  }
  return inside
}

function pointInCountry(lon: number, lat: number, f: CountryFeature): boolean {
  for (const ring of f.rings) if (pointInRing(lon, lat, ring)) return true
  return false
}

// ─── Metros (polygon PIP, same as countries) ───────────────────────────────

interface Metro {
  id: number
  name: string
  country: string
  polygon: number[][]  // [[lon, lat], ...] — same format as Natural Earth rings
}

function loadMetros(): Metro[] {
  const raw = JSON.parse(readFileSync(METROS_JSON, 'utf-8'))
  return raw.metros as Metro[]
}

// ─── Hex enumeration ───────────────────────────────────────────────────────

/** All valid H3R4 hex directories in `data/prepared/{YEAR}/h3r4/`. */
function landHexes(): string[] {
  if (!existsSync(H3R4_DIR)) {
    throw new Error(`H3R4 dir not found: ${H3R4_DIR}`)
  }
  const entries = readdirSync(H3R4_DIR)
  // H3 res-4 id format: 15 hex chars. Layout: "84" (2) + 5 hex digits of
  // base-cell + direction path + "ffffffff" (8) padding for unused digits.
  return entries.filter((e) => /^84[0-9a-f]{5}ffffffff$/.test(e)).sort()
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('Loading Natural Earth country polygons...')
  const countries = await loadNaturalEarth()
  console.log(`  loaded ${countries.length} country features`)

  console.log('Loading metro list...')
  const metros = loadMetros()
  console.log(`  loaded ${metros.length} metros`)

  console.log('Enumerating land hexes from arrow data...')
  const hexes = landHexes()
  console.log(`  ${hexes.length} H3R4 land hexes`)

  console.log('Assigning admin per hex (centroid PIP)...')
  const t0 = Date.now()
  let processed = 0
  const records: {
    hexIdHigh: number
    hexIdLow: number
    hexStr: string
    continent: number
    iso: string        // two-letter or "" if unknown
    city: number       // 0 = none
  }[] = []

  for (const hexStr of hexes) {
    const [lat, lon] = cellToLatLng(hexStr)

    // Country lookup — first matching polygon wins. Iteration order follows
    // Natural Earth's feature list; border hexes pick up whichever country's
    // polygon ray-casts first. Documented as project policy in SPEC.md.
    let continent = CONTINENT_ID.UNKNOWN
    let iso = ''
    for (const f of countries) {
      if (pointInCountry(lon, lat, f)) {
        iso = f.iso
        continent = f.continent
        break
      }
    }

    // Metro lookup — same centroid-PIP rule as country. ~30 metros total; linear scan.
    let city = 0
    for (const m of metros) {
      if (pointInRing(lon, lat, m.polygon)) {
        city = m.id
        break
      }
    }

    // H3 id is a 64-bit integer represented as a 15-char hex string (60 bits,
    // top nibble is always 0). Parse via BigInt to sidestep JS's 32-bit bit
    // ops, then split to low/high u32 for little-endian writing.
    const hexIdBig = BigInt('0x' + hexStr)
    const hexIdLow = Number(hexIdBig & 0xffffffffn)
    const hexIdHigh = Number(hexIdBig >> 32n)

    records.push({ hexIdHigh, hexIdLow, hexStr, continent, iso, city })

    if (++processed % 10_000 === 0) {
      const dt = ((Date.now() - t0) / 1000).toFixed(0)
      console.log(`  [${dt}s] ${processed}/${hexes.length}`)
    }
  }
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(0)}s`)

  // Sort by hex id (lexicographic on 15-char hex == numeric on u64)
  records.sort((a, b) => a.hexStr.localeCompare(b.hexStr))

  // ─── Binary serialization ───────────────────────────────────────────────
  // Format: "H3ADMIN1" (8 bytes) + u32 count + records[count].
  // Each record: u64 hex_id + u8 continent + [u8; 2] iso + u16 city = 13 bytes.
  // ISO bytes are ASCII (A-Z); "\0\0" means unknown. No ID allocation needed —
  // defaults.rs can match on iso directly without a lookup table.
  const HEADER_SIZE = 8 + 4
  const RECORD_SIZE = 8 + 1 + 2 + 2
  const buf = Buffer.alloc(HEADER_SIZE + RECORD_SIZE * records.length)
  buf.write('H3ADMIN1', 0, 'ascii')
  buf.writeUInt32LE(records.length, 8)
  let off = HEADER_SIZE
  for (const r of records) {
    buf.writeUInt32LE(r.hexIdLow, off)
    buf.writeUInt32LE(r.hexIdHigh, off + 4)
    buf.writeUInt8(r.continent, off + 8)
    buf.writeUInt8(r.iso.charCodeAt(0) || 0, off + 9)
    buf.writeUInt8(r.iso.charCodeAt(1) || 0, off + 10)
    buf.writeUInt16LE(r.city, off + 11)
    off += RECORD_SIZE
  }

  writeFileSync(OUTPUT_BIN, buf)
  console.log(
    `✓ wrote ${OUTPUT_BIN} (${(buf.length / 1_000_000).toFixed(2)} MB, ${records.length} hexes)`,
  )

  // ─── Distribution summary ───────────────────────────────────────────────
  const byContinent = new Map<number, number>()
  const byIso = new Map<string, number>()
  let cityCount = 0
  for (const r of records) {
    byContinent.set(r.continent, (byContinent.get(r.continent) || 0) + 1)
    byIso.set(r.iso, (byIso.get(r.iso) || 0) + 1)
    if (r.city > 0) cityCount++
  }
  console.log('\nDistribution:')
  console.log(`  continents: ${[...byContinent.entries()].map(([c, n]) => `${c}=${n}`).join(', ')}`)
  console.log(`  unique countries: ${byIso.size - (byIso.has('') ? 1 : 0)}`)
  console.log(`  unknown country: ${byIso.get('') || 0} hexes`)
  console.log(`  in a metro: ${cityCount} hexes`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
