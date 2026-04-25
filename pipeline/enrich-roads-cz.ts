/**
 * Enrich CZ roads.arrow with ŘSD traffic census data (AADT per vehicle class).
 *
 * Downloads from ŘSD ArcGIS REST API, caches locally, matches to OSM roads
 * by ref tag + proximity, adds aadt_* columns + source_id to Arrow.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-cz.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-cz.ts --force-download
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-cz.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite } from './lib/provenance.js'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { SOURCE_ID_CZ_RSD_SCITANI } from './lib/source-ids.generated.js'
import { flatDist } from './lib/spatial.js'

const MY_SOURCE_ID = SOURCE_ID_CZ_RSD_SCITANI

const YEAR = process.env.DATA_YEAR || '2025'
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

interface CensusSection {
  ref: string           // normalized road ref
  aadt_light: number    // O (passenger cars)
  aadt_medium: number   // NSN + A + AK (light trucks + buses)
  aadt_heavy: number    // TN + TNP + SN + SNP (heavy trucks) + AK (articulated buses, 3+ axles)
  aadt_moto: number     // M (motorcycles)
  lat: number
  lon: number
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
      aadt_light: a.O || 0,
      aadt_medium: (a.NSN || 0) + (a.A || 0),
      // AK (articulated buses) → heavy under CNOSSOS (3+ axles)
      aadt_heavy: (a.TN || 0) + (a.TNP || 0) + (a.SN || 0) + (a.SNP || 0) + (a.AK || 0),
      aadt_moto: a.M || 0,
      lat: pts.reduce((s: number, p: number[]) => s + p[1], 0) / pts.length,
      lon: pts.reduce((s: number, p: number[]) => s + p[0], 0) / pts.length,
    }

    if (!byRef.has(ref)) byRef.set(ref, [])
    byRef.get(ref)!.push(section)
  }

  return byRef
}

// ── Step 3: Enrich Arrow files ──

function enrichHexes(censusByRef: Map<string, CensusSection[]>): void {
  const hexDirs = readdirSync(H3R4_DIR).filter(d =>
    d.length === 15 && d.endsWith('ffffffff'))

  let totalRoads = 0
  let totalMatched = 0
  let hexesUpdated = 0
  const matchByClass = new Map<number, { matched: number; total: number }>()

  for (const hexId of hexDirs) {
    const roadsPath = resolve(H3R4_DIR, hexId, 'roads.arrow')
    if (!existsSync(roadsPath)) continue

    const buf = readFileSync(roadsPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue
    totalRoads += n

    const refCol = table.getChild('ref')
    const startLat = table.getChild('start_lat')!
    const startLon = table.getChild('start_lon')!
    const endLat = table.getChild('end_lat')!
    const endLon = table.getChild('end_lon')!
    const roadClassCol = table.getChild('road_class')

    // Seed output columns from existing Arrow state; priority rule decides per row.
    const existingAadtLight = table.getChild('aadt_light')
    const existingAadtMedium = table.getChild('aadt_medium')
    const existingAadtHeavy = table.getChild('aadt_heavy')
    const existingAadtMoto = table.getChild('aadt_moto')
    const existingSourceId = table.getChild('source_id')

    const aadtLight = new Int32Array(n)
    const aadtMedium = new Int32Array(n)
    const aadtHeavy = new Int32Array(n)
    const aadtMoto = new Int32Array(n)
    const sourceId = new Uint16Array(n)

    for (let i = 0; i < n; i++) {
      aadtLight[i] = existingAadtLight ? (existingAadtLight.get(i) as number) ?? 0 : 0
      aadtMedium[i] = existingAadtMedium ? (existingAadtMedium.get(i) as number) ?? 0 : 0
      aadtHeavy[i] = existingAadtHeavy ? (existingAadtHeavy.get(i) as number) ?? 0 : 0
      aadtMoto[i] = existingAadtMoto ? (existingAadtMoto.get(i) as number) ?? 0 : 0
      sourceId[i] = existingSourceId ? (existingSourceId.get(i) as number) ?? 0 : 0
    }

    let hexMatched = 0

    for (let i = 0; i < n; i++) {
      const roadClass = roadClassCol ? (roadClassCol.get(i) as number) : 5
      if (!matchByClass.has(roadClass)) matchByClass.set(roadClass, { matched: 0, total: 0 })
      matchByClass.get(roadClass)!.total++

      // Priority gate: if a higher-priority dataset already owns this row, leave it.
      if (!shouldOverwrite(sourceId[i], MY_SOURCE_ID)) continue

      // Ref match is MANDATORY — no proximity-only fallback
      const osmRef = refCol ? (refCol.get(i) as string | null) : null
      if (!osmRef) continue

      const normalized = normalizeOsmRef(osmRef)
      if (!normalized) continue

      const candidates = censusByRef.get(normalized)
      if (!candidates || candidates.length === 0) continue

      // Pick closest census section by centroid distance
      const midLat = ((startLat.get(i) as number) + (endLat.get(i) as number)) / 2
      const midLon = ((startLon.get(i) as number) + (endLon.get(i) as number)) / 2

      let best = candidates[0]
      let bestDist = flatDist(midLat, midLon, best.lat, best.lon)
      for (let j = 1; j < candidates.length; j++) {
        const d = flatDist(midLat, midLon, candidates[j].lat, candidates[j].lon)
        if (d < bestDist) { best = candidates[j]; bestDist = d }
      }

      // Max 10km — avoid wrong matches on same-numbered roads far away
      if (bestDist > 10_000) continue

      // Whole-row atomic write — payload + dataset_id together.
      // Do NOT halve for oneway — ŘSD = bidirectional total,
      // pipeline-worker already applies oneway_factor=0.5 (arrow.rs:81)
      aadtLight[i] = best.aadt_light
      aadtMedium[i] = best.aadt_medium
      aadtHeavy[i] = best.aadt_heavy
      aadtMoto[i] = best.aadt_moto
      sourceId[i] = MY_SOURCE_ID
      hexMatched++
      matchByClass.get(roadClass)!.matched++
    }

    if (hexMatched === 0) continue

    // Copy ALL existing columns by iterating schema (don't hardcode column list)
    const columns: Record<string, any> = {}
    for (const field of table.schema.fields) {
      columns[field.name] = table.getChild(field.name)!
    }

    // Add enrichment columns (overwrite if already present from previous run)
    columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
    columns['aadt_medium'] = vectorFromArray(aadtMedium, new Int32())
    columns['aadt_heavy'] = vectorFromArray(aadtHeavy, new Int32())
    columns['aadt_moto'] = vectorFromArray(aadtMoto, new Int32())
    columns['source_id'] = vectorFromArray(sourceId, new Uint16())

    const newTable = makeTable(columns)
    // MUST use 'file' format — Rust FileReader requires ARROW1 magic bytes.
    // Default stream format = enriched data silently lost.
    writeFileSync(roadsPath, Buffer.from(tableToIPC(newTable, 'file')))
    totalMatched += hexMatched
    hexesUpdated++
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
  console.log(`  ${censusByRef.size} unique road refs\n`)

  enrichHexes(censusByRef)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
