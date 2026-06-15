/**
 * Enrich CZ roads.arrow with ŘSD traffic census data (AADT per vehicle class).
 *
 * Downloads from ŘSD ArcGIS REST API, caches locally, matches to OSM roads
 * by ref tag + proximity, adds aadt_* columns + source_id to Arrow.
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-roads-cz.ts
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-roads-cz.ts --force-download
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-roads-cz.ts --enrich-only
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { SOURCE_ID_CZ_RSD_SCITANI } from './lib/source-ids.generated.js'
import { pointToPolylineDist } from './lib/spatial.js'
import { shouldOverwrite } from './lib/provenance.js'
import { writeRoadAadt, iterateCountryHexes } from './lib/roads-arrow.js'
import { makeCoastalCountryGate } from './lib/country-polygon.js'

const MY_SOURCE_ID = SOURCE_ID_CZ_RSD_SCITANI

const YEAR = process.env.DATA_YEAR || '2026'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/cz`)
const CACHE_FILE = resolve(CACHE_DIR, 'rsd-scitani.json')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

// ŘSD ArcGIS REST — ScitaniDopravy MapServer layer 3
// Must use spatial bbox in S-JTSK (EPSG:5514), where=1=1 returns 400.
const RSD_BASE = 'https://geoportal.rsd.cz/arcgis/rest/services/ScitaniDopravy/MapServer/3/query'
const CZ_BBOX_SJTSK = { xmin: -900000, ymin: -1300000, xmax: -400000, ymax: -900000 }
const PAGE_SIZE = 2000

// ── Types ──

// ŘSD class → CNOSSOS-EU category (Annex II, Dir (EU) 2015/996, amended Reg. 2021/1226):
//   cat1 light  = cars + light commercial ≤3.5 t  → O + LN
//   cat2 medium = 2-axle medium trucks + buses    → SN + A (+ TR/TRP tractors, closest bucket)
//   cat3 heavy  = 3+ axle / artic / semitrailer / artic bus → TN + TNP + SNP + NSN + AK
//   cat4 PTW    = M
interface CensusSection {
  ref: string           // normalized road ref
  aadt_light: number
  aadt_medium: number
  aadt_heavy: number
  aadt_moto: number
  coords: [number, number][]   // section polyline as [lon, lat] vertices (matched per-segment, not by centroid)
}

// ── Step 1: Download ŘSD census ──

async function downloadCensus(): Promise<any[]> {
  if (!forceDownload && existsSync(CACHE_FILE) && !enrichOnly) {
    console.log(`  Using cached data: ${CACHE_FILE}`)
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
  }
  if (enrichOnly) {
    if (!existsSync(CACHE_FILE)) {
      console.error('ERROR: --enrich-only but no cached data found')
      process.exit(1)
    }
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
  }

  console.log('  Downloading from ŘSD ArcGIS...')
  const geomParam = encodeURIComponent(JSON.stringify(CZ_BBOX_SJTSK))
  const allFeatures: any[] = []
  let offset = 0

  while (true) {
    const url = `${RSD_BASE}?geometry=${geomParam}&geometryType=esriGeometryEnvelope` +
      `&inSR=5514&outFields=*&resultRecordCount=${PAGE_SIZE}&resultOffset=${offset}` +
      `&f=json&outSR=4326`

    const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
    if (!res.ok) throw new Error(`ŘSD API error: ${res.status}`)
    const data = await res.json()

    if (!data.features || data.features.length === 0) break
    allFeatures.push(...data.features)
    console.log(`    fetched ${allFeatures.length} sections (offset=${offset})`)

    if (data.features.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(CACHE_FILE, JSON.stringify(allFeatures))
  console.log(`  Cached ${allFeatures.length} sections to ${CACHE_FILE}`)
  return allFeatures
}

// ── Step 2: Parse + normalize ──

/** Un-surveyed (all-zero) census sections skipped by parseCensus — reported once. */
let zeroSections = 0

function parseCensus(features: any[]): Map<string, CensusSection[]> {
  const byRef = new Map<string, CensusSection[]>()

  for (const f of features) {
    const a = f.attributes
    if (!a) continue

    const ref = normalizeRsdRef(String(a.PSILNICE || ''), String(a.PKOD_R || ''))
    if (!ref) continue

    const pts = (f.geometry?.paths || []).flat()
    if (!pts.length) continue

    const section: CensusSection = {
      ref,
      aadt_light: (a.O || 0) + (a.LN || 0),
      aadt_medium: (a.SN || 0) + (a.A || 0) + (a.TR || 0) + (a.TRP || 0),
      aadt_heavy: (a.TN || 0) + (a.TNP || 0) + (a.SNP || 0) + (a.NSN || 0) + (a.AK || 0),
      aadt_moto: a.M || 0,
      coords: pts as [number, number][],
    }

    // GPR publishes un-surveyed III-class sections with all-zero counts.
    // Writing those zeros + the source stamp silently mutes real roads that
    // would otherwise get class defaults (2026-06 audit R7: 44.6k segments).
    if (section.aadt_light + section.aadt_medium + section.aadt_heavy + section.aadt_moto === 0) {
      zeroSections++
      continue
    }

    if (!byRef.has(ref)) byRef.set(ref, [])
    byRef.get(ref)!.push(section)
  }

  return byRef
}

// ── Step 3: Enrich Arrow files ──

// Generous box around Czechia (+~0.3 deg halo) so the hex scan skips the rest of
// the planet — ŘSD refs only match CZ hexes (otherwise the loader reads every
// roads.arrow on Earth, ~40 min vs the ~112 CZ R4 cells). [minLat,minLon,maxLat,maxLon]
const CZ_HEX_BBOX: [number, number, number, number] = [48.2, 11.7, 51.4, 19.2]

async function enrichHexes(censusByRef: Map<string, CensusSection[]>): Promise<void> {
  // Czech road numbers repeat across the border (Slovak I/49 continues CZ I/49)
  // and the 10 km proximity cap doesn't stop a match just across the line — the
  // 2026-06 audit R9 found ~1k Slovak/Polish segments carrying ŘSD AADT. Same
  // gate pattern as enrich-roads-pl.ts; created here because makeCoastalCountryGate
  // may download+convert the CGAZ boundary file on first use.
  const inCzechia = makeCoastalCountryGate('CZ')
  const hexDirs = iterateCountryHexes(H3R4_DIR, CZ_HEX_BBOX)

  let totalRoads = 0
  let totalMatched = 0
  let hexesUpdated = 0
  const matchByClass = new Map<number, { matched: number; total: number }>()

  for (const hexId of hexDirs) {
    const r = await writeRoadAadt(
      resolve(H3R4_DIR, hexId, 'roads.arrow'),
      (row) => {
        let cls = matchByClass.get(row.roadClass)
        if (!cls) { cls = { matched: 0, total: 0 }; matchByClass.set(row.roadClass, cls) }
        cls.total++

        // Fast-exit before the expensive ref-match when a higher-priority dataset
        // already owns the row (writeRoadAadt re-checks the gate — this only saves work).
        if (!shouldOverwrite(row.existingSourceId, MY_SOURCE_ID)) return null

        // Ref match is MANDATORY — no proximity-only fallback.
        if (!row.ref) return null
        if (!inCzechia(row.midLat, row.midLon)) return null
        const normalized = normalizeOsmRef(row.ref)
        if (!normalized) return null
        const candidates = censusByRef.get(normalized)
        if (!candidates || candidates.length === 0) return null

        // Pick the section whose LINE is closest to the segment midpoint
        // (point-to-polyline, not centroid → the boundary lands at the real
        // junction, not the perpendicular bisector of two centroids).
        let best = candidates[0]
        let bestDist = pointToPolylineDist(row.midLat, row.midLon, best.coords)
        for (let j = 1; j < candidates.length; j++) {
          const d = pointToPolylineDist(row.midLat, row.midLon, candidates[j].coords)
          if (d < bestDist) { best = candidates[j]; bestDist = d }
        }
        if (bestDist > 10_000) return null // avoid wrong matches on same-numbered roads far away

        // Do NOT halve for oneway — ŘSD = bidirectional total; the engine applies
        // oneway_factor=0.5. (The priority gate + atomic write live in writeRoadAadt.)
        return {
          light: best.aadt_light, medium: best.aadt_medium,
          heavy: best.aadt_heavy, moto: best.aadt_moto, sourceId: MY_SOURCE_ID,
        }
      },
      (row) => { matchByClass.get(row.roadClass)!.matched++ },
    )
    totalRoads += r.rows
    totalMatched += r.matched
    if (r.updated) hexesUpdated++
  }

  console.log(`\n=== Results ===`)
  console.log(`  ${totalMatched} / ${totalRoads} segments matched (${(totalMatched / totalRoads * 100).toFixed(1)}%)`)
  console.log(`  ${hexesUpdated} / ${hexDirs.length} hexes updated`)
  console.log(`\n  Per road class:`)
  for (const [cls, stats] of [...matchByClass.entries()].sort((a, b) => a[0] - b[0])) {
    const names = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'living_st']
    const pct = stats.total > 0 ? (stats.matched / stats.total * 100).toFixed(1) : '0.0'
    console.log(`    ${(names[cls] || `class_${cls}`).padEnd(12)} ${stats.matched} / ${stats.total} (${pct}%)`)
  }
}

// ── Helpers ──

/** Normalize ŘSD road ref: PSILNICE + PKOD_R → canonical form */
function normalizeRsdRef(psilnice: string, pkodR: string): string {
  const p = psilnice.trim()
  if (!p) return ''
  if (/^D\d+/.test(p)) return p          // D1, D5 → keep as-is
  const num = p.replace(/\D/g, '')
  if (!num) return p
  // PKOD_R: 1=motorway, 5=expressway → prefix D
  if (pkodR === '1' || pkodR === '5') return `D${num}`
  return num
}

/** Normalize OSM ref: "I/34" → "34", "D1" → "D1", "E50" → skip */
function normalizeOsmRef(ref: string): string {
  const r = ref.trim()
  if (/^D\d/.test(r)) return r             // D1, D5 → keep
  if (/^E\d/.test(r)) return ''             // E-roads → skip (international numbering)
  // Strip Roman numeral prefix: "I/34" → "34", "II/150" → "150"
  const m = r.match(/^[IV]+\/(\d+)/)
  if (m) return m[1]
  // Plain number
  const num = r.replace(/\D/g, '')
  return num || ''
}

/** Flat-earth distance in meters */
// ── Main ──

async function main() {
  console.log(`=== CZ Road Traffic Enrichment (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  const features = await downloadCensus()
  console.log(`\n  Parsing ${features.length} census sections...`)
  const censusByRef = parseCensus(features)
  console.log(`  ${censusByRef.size} unique road refs (${zeroSections} un-surveyed all-zero sections skipped)\n`)

  await enrichHexes(censusByRef)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
