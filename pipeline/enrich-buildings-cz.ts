/**
 * Enrich CZ buildings.arrow with RÚIAN data (floor count + building use type).
 *
 * Downloads VFR zakladni per municipality from ČÚZK, extracts StavebniObjekt
 * fields (PocetPodlazi, ZpusobVyuzitiKod, centroid GPS), spatial-joins to
 * buildings.arrow, fills missing floors and refines building_type.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-buildings-cz.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-buildings-cz.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Uint8, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite } from './lib/provenance.js'

const MY_SOURCE_ID = SOURCE_ID_CZ_RUIAN_VFR
import proj4 from 'proj4'
import { SOURCE_ID_CZ_RUIAN_VFR } from './lib/source-ids.generated.js'

// Define S-JTSK (EPSG:5514) projection
proj4.defs('EPSG:5514', '+proj=krovak +lat_0=49.5 +lon_0=24.83333333333333 +alpha=30.28813975277778 +k=0.9999 +x_0=0 +y_0=0 +ellps=bessel +towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56 +units=m +no_defs')

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/cz`)
const CACHE_FILE = resolve(CACHE_DIR, 'ruian-buildings.json')

const enrichOnly = process.argv.includes('--enrich-only')
const forceDownload = process.argv.includes('--force-download')

const ATOM_URL = 'https://atom.cuzk.cz/RUIAN-S-Z-U/RUIAN-S-Z-U.xml'
const CONCURRENCY = 20

// RÚIAN ZpusobVyuzitiKod → our building_type mapping
const RUIAN_TO_BUILDING_TYPE: Record<number, number> = {
  6: 0,   // bytový dům → residential
  7: 0,   // rodinný dům → residential
  8: 0,   // rekreační → residential
  9: 9,   // shromažďovací → public
  10: 1,  // obchod → commercial
  11: 6,  // ubytovací → hotel
  12: 2,  // výroba/sklad → warehouse/industrial
  13: 8,  // zemědělská → farm
  14: 1,  // administrativa → commercial
  15: 9,  // občanská vybavenost → public (includes schools, hospitals)
  16: 2,  // technické vybavení → warehouse
  17: 7,  // doprava → garage
  18: 7,  // garáž → garage
  19: 0,  // jiná → default residential
  20: 1,  // víceúčelová → commercial
  21: 8,  // skleník → farm
  2: 8,   // zemědělská usedlost → farm
}

/** S-JTSK (EPSG:5514) → WGS84 via proj4. Input: [Y, X] both negative. */
function sjtskToWgs84(y: number, x: number): [number, number] {
  const [lon, lat] = proj4('EPSG:5514', 'EPSG:4326', [y, x])
  return [lat, lon]
}

interface RuianBuilding {
  lat: number
  lon: number
  floors: number
  useCode: number
}

// ── Step 1: Download RÚIAN per municipality ──

async function downloadRuian(): Promise<RuianBuilding[]> {
  if (!forceDownload && existsSync(CACHE_FILE)) {
    console.log(`  Using cached RÚIAN data: ${CACHE_FILE}`)
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
  }
  if (enrichOnly) {
    if (!existsSync(CACHE_FILE)) { console.error('ERROR: --enrich-only but no cache'); process.exit(1) }
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
  }

  mkdirSync(CACHE_DIR, { recursive: true })

  // Get municipality list: download state-level RÚIAN CSV for municipality codes
  console.log('  Getting municipality list...')

  // Use WFS GetFeature to get all municipality codes (lightweight query)
  // Alternative: hardcoded list from RÚIAN state VFR (municipality codes don't change often)
  // For now: use the state-level VFR which has Obec list
  const stateUrl = 'https://vdp.cuzk.gov.cz/vymenny_format/soucasna/20260331_ST_UZSZ.xml.zip'
  const stateRes = await fetch(stateUrl, { signal: AbortSignal.timeout(120000) })
  if (!stateRes.ok) throw new Error(`State VFR download failed: ${stateRes.status}`)

  const stateBuf = Buffer.from(await stateRes.arrayBuffer())
  const stateZip = resolve(CACHE_DIR, 'state-vfr.zip')
  writeFileSync(stateZip, stateBuf)
  console.log(`  State VFR: ${(stateBuf.length / 1e6).toFixed(1)} MB`)

  // Extract municipality codes from state VFR
  const { execSync } = await import('node:child_process')
  const stateXml = execSync(`unzip -p "${stateZip}"`, { maxBuffer: 500 * 1024 * 1024, timeout: 30000 }).toString()
  const obecRegex = /<obi:Kod>(\d{6})<\/obi:Kod>/g
  const municipalityCodes = new Set<string>()
  let mc
  while ((mc = obecRegex.exec(stateXml)) !== null) {
    municipalityCodes.add(mc[1])
  }

  const DATE_PREFIX = '20260331' // VFR publication date
  const municipalities = [...municipalityCodes].map(code => ({
    url: `https://vdp.cuzk.gov.cz/vymenny_format/soucasna/${DATE_PREFIX}_OB_${code}_UZSZ.xml.zip`,
    code,
  }))
  console.log(`  ${municipalities.length} municipalities found`)

  // Download and parse in batches
  const { execSync: exec } = await import('node:child_process')
  const { unlinkSync } = await import('node:fs')
  const allBuildings: RuianBuilding[] = []
  let processed = 0
  let errors = 0

  for (let i = 0; i < municipalities.length; i += CONCURRENCY) {
    const batch = municipalities.slice(i, i + CONCURRENCY)

    // Fetch all ZIPs in parallel
    const fetches = await Promise.allSettled(
      batch.map(async ({ url, code }) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
        if (!res.ok) return { code, buf: null }
        const buf = Buffer.from(await res.arrayBuffer())
        return { code, buf }
      })
    )

    // Parse sequentially (unzip is CPU-bound)
    for (const r of fetches) {
      if (r.status !== 'fulfilled' || !r.value.buf) { errors++; continue }
      const { code, buf } = r.value
      if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) { errors++; continue }

      try {
        // Skip very large municipalities (Praha, Brno) — XML > 500 MB causes OOM
        if (buf.length > 20 * 1024 * 1024) {
          if (errors < 5) console.log(`    SKIP ${code}: ZIP ${(buf.length/1e6).toFixed(0)} MB (too large)`)
          continue
        }
        const tmpZip = `/tmp/ruian_${code}.zip`
        writeFileSync(tmpZip, buf)
        exec(`unzip -o -q "${tmpZip}" -d /tmp/ruian_extract_${code}`, { timeout: 30000 })
        const xmlFiles = readdirSync(`/tmp/ruian_extract_${code}`).filter(f => f.endsWith('.xml'))
        for (const xf of xmlFiles) {
          const xml = readFileSync(`/tmp/ruian_extract_${code}/${xf}`, 'utf-8')
          const buildings = parseBuildingsFromVfr(xml)
          allBuildings.push(...buildings)
        }
        exec(`rm -rf /tmp/ruian_extract_${code} "${tmpZip}"`, { timeout: 5000 })
      } catch (e: any) {
        if (errors < 3) console.log(`    ERROR ${code}: ${e.message?.substring(0, 100)}`)
        errors++
        try { exec(`rm -rf /tmp/ruian_extract_${code} /tmp/ruian_${code}.zip`, { timeout: 5000 }) } catch {}
      }
    }

    processed += batch.length
    if (processed % 500 === 0 || processed === municipalities.length) {
      console.log(`    ${processed}/${municipalities.length} municipalities, ${allBuildings.length.toLocaleString()} buildings, ${errors} errors`)
    }
  }

  console.log(`  Total: ${allBuildings.length} buildings from RÚIAN`)
  writeFileSync(CACHE_FILE, JSON.stringify(allBuildings))
  return allBuildings
}

function parseBuildingsFromVfr(xml: string): RuianBuilding[] {
  const buildings: RuianBuilding[] = []
  // Match each StavebniObjekt block
  const soRegex = /<vf:StavebniObjekt[^>]*>([\s\S]*?)<\/vf:StavebniObjekt>/g
  let m
  while ((m = soRegex.exec(xml)) !== null) {
    const block = m[1]

    const floorsMatch = block.match(/<soi:PocetPodlazi>(\d+)</)
    const useMatch = block.match(/<soi:ZpusobVyuzitiKod>(\d+)</)
    const posMatch = block.match(/<gml:pos>([^<]+)</)

    if (!posMatch) continue

    const [yStr, xStr] = posMatch[1].trim().split(/\s+/)
    const [lat, lon] = sjtskToWgs84(parseFloat(yStr), parseFloat(xStr))

    if (lat < 48 || lat > 52 || lon < 11 || lon > 19) continue // outside CZ

    buildings.push({
      lat, lon,
      floors: floorsMatch ? parseInt(floorsMatch[1]) : 0,
      useCode: useMatch ? parseInt(useMatch[1]) : 0,
    })
  }
  return buildings
}

// ── Step 2: Enrich buildings.arrow ──

function enrichHexes(ruianBuildings: RuianBuilding[]): void {
  // Build spatial index: 0.01° grid (~1km cells) for fast lookup
  const grid = new Map<string, RuianBuilding[]>()
  for (const b of ruianBuildings) {
    const key = `${Math.floor(b.lat * 100)}_${Math.floor(b.lon * 100)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(b)
  }
  console.log(`  Spatial grid: ${grid.size} cells`)

  const hexDirs = readdirSync(H3R4_DIR).filter(d =>
    d.length === 15 && d.endsWith('ffffffff'))

  let totalBuildings = 0, totalEnriched = 0, floorsAdded = 0, typeRefined = 0, hexesUpdated = 0

  for (const hexId of hexDirs) {
    const bldPath = resolve(H3R4_DIR, hexId, 'buildings.arrow')
    if (!existsSync(bldPath)) continue

    const buf = readFileSync(bldPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue
    totalBuildings += n

    const clat = table.getChild('centroid_lat')!
    const clon = table.getChild('centroid_lon')!
    const existingFloors = table.getChild('floors')
    const existingType = table.getChild('building_type')
    const existingSourceId = table.getChild('source_id')

    // New columns (copy existing, override where RÚIAN has data)
    const newFloors = new Uint8Array(n)
    const newType = new Uint8Array(n)
    const newDatasetId = new Uint16Array(n)
    let hexEnriched = 0

    for (let i = 0; i < n; i++) {
      const lat = clat.get(i) as number
      const lon = clon.get(i) as number
      const curFloors = existingFloors ? (existingFloors.get(i) as number) : 0
      const curType = existingType ? (existingType.get(i) as number) : 0
      const curDatasetId = existingSourceId ? (existingSourceId.get(i) as number) : 0
      newFloors[i] = curFloors
      newType[i] = curType
      newDatasetId[i] = curDatasetId

      // Priority gate: skip if a higher-priority dataset owns this row.
      if (!shouldOverwrite(curDatasetId, MY_SOURCE_ID)) continue

      // Find nearest RÚIAN building within 30m
      const gridKey = `${Math.floor(lat * 100)}_${Math.floor(lon * 100)}`
      let bestDist = 30 // 30m max
      let bestRuian: RuianBuilding | null = null

      // Check 3x3 grid cells
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = `${Math.floor(lat * 100) + dy}_${Math.floor(lon * 100) + dx}`
          const cell = grid.get(k)
          if (!cell) continue
          for (const rb of cell) {
            const d = flatDist(lat, lon, rb.lat, rb.lon)
            if (d < bestDist) { bestDist = d; bestRuian = rb }
          }
        }
      }

      if (bestRuian) {
        hexEnriched++
        newDatasetId[i] = MY_SOURCE_ID
        // Fill floors if missing in OSM
        if (curFloors === 0 && bestRuian.floors > 0) {
          newFloors[i] = Math.min(bestRuian.floors, 255)
          floorsAdded++
        }
        // Refine building type from RÚIAN (more precise than OSM)
        if (bestRuian.useCode > 0) {
          const mappedType = RUIAN_TO_BUILDING_TYPE[bestRuian.useCode]
          if (mappedType !== undefined) {
            newType[i] = mappedType
            if (mappedType !== curType) typeRefined++
          }
        }
      }
    }

    if (hexEnriched === 0) continue
    totalEnriched += hexEnriched

    // Copy all columns + overwrite floors, building_type, dataset_id
    const columns: Record<string, any> = {}
    for (const field of table.schema.fields) {
      if (field.name === 'floors') continue
      if (field.name === 'building_type') continue
      if (field.name === 'source_id') continue
      columns[field.name] = table.getChild(field.name)!
    }
    columns['floors'] = vectorFromArray(newFloors, new Uint8())
    columns['building_type'] = vectorFromArray(newType, new Uint8())
    columns['source_id'] = vectorFromArray(newDatasetId, new Uint16())

    const newTable = makeTable(columns)
    writeFileSync(bldPath, Buffer.from(tableToIPC(newTable, 'file')))
    hexesUpdated++
  }

  console.log(`\n=== Results ===`)
  console.log(`  ${totalEnriched} / ${totalBuildings} buildings matched to RÚIAN (${(totalEnriched / totalBuildings * 100).toFixed(1)}%)`)
  console.log(`  ${floorsAdded} floors added (were missing in OSM)`)
  console.log(`  ${typeRefined} building types refined from RÚIAN`)
  console.log(`  ${hexesUpdated} / ${hexDirs.length} hexes updated`)
}

function flatDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  const dx = (lon2 - lon1) * 111320 * cosLat
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}

// ── Main ──

async function main() {
  console.log(`=== CZ Building Enrichment — RÚIAN (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  const buildings = await downloadRuian()
  console.log(`\n  RÚIAN buildings: ${buildings.length.toLocaleString()}`)
  console.log(`  Enriching buildings.arrow files...`)
  enrichHexes(buildings)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
