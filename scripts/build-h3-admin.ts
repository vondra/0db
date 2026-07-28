/**
 * Build the H3R4 → admin lookup table (`data/prepared/h3r4-admin.bin`).
 *
 * For every land H3R4 hex present in `data/prepared/{YEAR}/h3r4/`, assign
 * (continent, country, metro_city). Engine loads this binary at startup and
 * uses it to select per-country / per-city defaults in the hierarchical
 * traffic cascade (see `engine/noise-compute/src/defaults.rs`).
 *
 * Resolution (plan M2 §1 — ONE polygon authority): AdminAt, the global CGAZ
 * point resolver (`pipeline/lib/admin-at.ts`). Natural Earth is RETIRED — its
 * generalization mis-assigned multi-km border salients (Hlučínsko; see
 * pipeline/lib/country-polygon.ts) and its centroid-only rule left every
 * sea-centroid coastal/island hex UNKNOWN (the Koh Phangan WORLD-defaults
 * defect). Per hex:
 *
 *   1. centroid PIP via adminAt;
 *   2. if undefined (centroid over water), 37-point interior sampling
 *      (centroid + 6 vertices + 6 edge midpoints + 24 inner points,
 *      antimeridian-safe interpolation) and the MAX-SHARE ISO wins — never
 *      first-hit, so a mostly-Thai island hex can no longer fall to WORLD
 *      because a sample clipped a neighbour's polygon first;
 *   3. still undefined → true ocean hex (e.g. a lighthouse building): iso
 *      "\0\0", continent UNKNOWN.
 *
 * Metros: centroid PIP via cityAt, gated by the RESOLVED country (a metro
 * rectangle assigns only when the hex's country matches the metro's own).
 *
 * Geopolitical note: CGAZ ADM0 encodes its own view of contested boundaries
 * (US-DoS disputed-area codes carry no ISO identity). The project
 * policy-maps the three road-bearing groups to their administering country
 * (pipeline/lib/admin-at.ts DISPUTED_SHAPEGROUP_ISO: Falklands → FK, Aksai
 * Chin → CN, Abyei → SD); any other disputed land stays UNKNOWN. This is a
 * documented project policy: the assignment is a best-effort approximation,
 * regenerable without touching arrow data.
 *
 * Output binary format (little-endian, byte-identical to the NE era):
 *   bytes 0-7:     magic "H3ADMIN1"
 *   bytes 8-11:    u32 count (number of entries)
 *   bytes 12..:    [u64 hex_id, u8 continent, u8 country, u16 city] × count
 *                  sorted ascending by hex_id.
 *
 * Usage:
 *   cd scripts && npm i    # one-time (needs tsx)
 *   DATA_YEAR=2026 npx tsx build-h3-admin.ts [--out /tmp/h3r4-admin.v2.bin]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cellToLatLng, cellToBoundary } from 'h3-js'
import { adminAt, antimeridianLerp, cityAt, continentForIso } from '../pipeline/lib/admin-at.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const YEAR = process.env.DATA_YEAR || JSON.parse(readFileSync(resolve(__dirname, 'dataset-year.json'), 'utf8')).current_year
const H3R4_DIR = resolve(__dirname, `../data/prepared/${YEAR}/h3r4`)
const outIdx = process.argv.indexOf('--out')
const OUTPUT_BIN = outIdx !== -1
  ? resolve(process.argv[outIdx + 1])
  : resolve(__dirname, '../data/prepared/h3r4-admin.bin')

// ─── Continent ids (mirror engine/noise-compute/src/admin.rs::Continent) ────

const CONTINENT_ID = {
  UNKNOWN: 0,
  Europe: 1,
  NorthAmerica: 2,
  SouthAmerica: 3,
  Asia: 4,
  Africa: 5,
  Oceania: 6,
} as Record<string, number>

function continentIdForIso(iso: string): number {
  return CONTINENT_ID[continentForIso(iso) ?? ''] ?? CONTINENT_ID.UNKNOWN
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

// ─── Interior sampling (sea-centroid hexes) ────────────────────────────────

/** 37 sample points across the hex: centroid + 6 vertices + 6 edge midpoints
 *  + 24 inner points (⅓/⅔ along centroid→vertex and centroid→edge-midpoint).
 *  The 12 res-4 PENTAGON cells yield 31 (5 vertices). Longitudes interpolate
 *  the short way around the globe (hexes centred near ±180° have vertices on
 *  both sides — naive averaging would sample ~0°). */
function hexSamples(hexStr: string): [number, number][] {
  const [cLat, cLon] = cellToLatLng(hexStr)
  const boundary = cellToBoundary(hexStr) // [[lat, lon] × 6, ×5 for pentagons]
  const n = boundary.length
  const pts: [number, number][] = [[cLat, cLon]]
  const edgeMids: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const [vLat, vLon] = boundary[i]
    const [nLat, nLon] = boundary[(i + 1) % n]
    pts.push([vLat, vLon])
    const mid = antimeridianLerp(vLat, vLon, nLat, nLon, 0.5)
    edgeMids.push(mid)
    pts.push(mid)
  }
  for (let i = 0; i < n; i++) {
    const [vLat, vLon] = boundary[i]
    for (const t of [1 / 3, 2 / 3]) pts.push(antimeridianLerp(cLat, cLon, vLat, vLon, t))
    const [mLat, mLon] = edgeMids[i]
    for (const t of [1 / 3, 2 / 3]) pts.push(antimeridianLerp(cLat, cLon, mLat, mLon, t))
  }
  return pts // 1 + n + n + 2n + 2n (n = 6 → 37, n = 5 → 31)
}

/** Max-share ISO over the interior samples; undefined when no sample resolves
 *  (true ocean). Ties break lexicographically — deterministic; real coastal
 *  hexes have a clear winner. */
function maxShareIso(hexStr: string): string | undefined {
  const shares = new Map<string, number>()
  for (const [sLat, sLon] of hexSamples(hexStr)) {
    const iso = adminAt(sLat, sLon).iso2
    if (iso !== undefined) shares.set(iso, (shares.get(iso) ?? 0) + 1)
  }
  let best: string | undefined
  let bestN = 0
  for (const [iso, n] of [...shares.entries()].sort()) {
    if (n > bestN) {
      best = iso
      bestN = n
    }
  }
  return best
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('Enumerating land hexes from arrow data...')
  const hexes = landHexes()
  console.log(`  ${hexes.length} H3R4 land hexes`)

  console.log('Assigning admin per hex (AdminAt centroid, max-share fallback)...')
  const t0 = Date.now()
  let processed = 0
  let centroidResolved = 0
  let sampledResolved = 0
  const stillUnknown: string[] = []
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

    let iso = adminAt(lat, lon).iso2
    if (iso !== undefined) {
      centroidResolved++
    } else {
      iso = maxShareIso(hexStr)
      if (iso !== undefined) sampledResolved++
      else stillUnknown.push(hexStr)
    }
    const continent = iso !== undefined ? continentIdForIso(iso) : CONTINENT_ID.UNKNOWN
    const city = cityAt(lat, lon, iso)

    // H3 id is a 64-bit integer represented as a 15-char hex string (60 bits,
    // top nibble is always 0). Parse via BigInt to sidestep JS's 32-bit bit
    // ops, then split to low/high u32 for little-endian writing.
    const hexIdBig = BigInt('0x' + hexStr)
    const hexIdLow = Number(hexIdBig & 0xffffffffn)
    const hexIdHigh = Number(hexIdBig >> 32n)

    records.push({ hexIdHigh, hexIdLow, hexStr, continent, iso: iso ?? '', city })

    if (++processed % 10_000 === 0) {
      const dt = ((Date.now() - t0) / 1000).toFixed(0)
      console.log(`  [${dt}s] ${processed}/${hexes.length}`)
    }
  }
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  console.log(`  centroid-resolved: ${centroidResolved}, sample-resolved: ${sampledResolved}, still UNKNOWN: ${stillUnknown.length}`)
  if (stillUnknown.length > 0) {
    console.log(`  UNKNOWN hexes (first 50): ${stillUnknown.slice(0, 50).join(' ')}`)
  }

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
