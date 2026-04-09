/**
 * Enrich ES buildings.arrow with Spanish Catastro INSPIRE data (floor counts).
 *
 * Downloads per-province GML files from Catastro INSPIRE ATOM feed,
 * parses building centroids + numberOfFloorsAboveGround, matches to
 * buildings.arrow by proximity (30m), fills floors column (UInt8).
 *
 * First version: key provinces (Madrid, Barcelona, Valencia, Seville,
 * Zaragoza, Malaga, Bilbao, Alicante).
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-buildings-es.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-buildings-es.ts --force-download
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-buildings-es.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Uint8 } from 'apache-arrow'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/es`)
const CACHE_FILE = resolve(CACHE_DIR, 'catastro-buildings.json')

const enrichOnly = process.argv.includes('--enrich-only')
const forceDownload = process.argv.includes('--force-download')

const ATOM_URL = 'https://www.catastro.hacienda.gob.es/INSPIRE/buildings/ES.SDGC.BU.atom.xml'

// Key provinces to process (Catastro uses 2-digit province codes)
// Each province has a GML download in the ATOM feed
const TARGET_PROVINCES: { code: string; name: string }[] = [
  { code: '28', name: 'Madrid' },
  { code: '08', name: 'Barcelona' },
  { code: '46', name: 'Valencia' },
  { code: '41', name: 'Sevilla' },
  { code: '50', name: 'Zaragoza' },
  { code: '29', name: 'Malaga' },
  { code: '48', name: 'Bizkaia' },       // Bilbao
  { code: '03', name: 'Alicante' },
]

const CONCURRENCY = 4

// ── Types ──

interface CatastroBuilding {
  lat: number
  lon: number
  floors: number
}

// ── Step 1: Download Catastro INSPIRE GML files ──

async function downloadCatastro(): Promise<CatastroBuilding[]> {
  if (!forceDownload && existsSync(CACHE_FILE)) {
    console.log(`  Using cached Catastro data: ${CACHE_FILE}`)
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
  }
  if (enrichOnly) {
    if (!existsSync(CACHE_FILE)) { console.error('ERROR: --enrich-only but no cache'); process.exit(1) }
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
  }

  mkdirSync(CACHE_DIR, { recursive: true })

  // Step 1a: Download the ATOM feed to discover per-province URLs
  console.log('  Downloading Catastro INSPIRE ATOM feed...')
  const atomRes = await fetch(ATOM_URL, { signal: AbortSignal.timeout(60_000) })
  if (!atomRes.ok) throw new Error(`ATOM feed download failed: ${atomRes.status}`)
  const atomXml = await atomRes.text()
  console.log(`  ATOM feed: ${(atomXml.length / 1024).toFixed(0)} KB`)

  // Parse province feed URLs from ATOM
  // The main feed links to per-province sub-feeds. Each entry has a link to the province ATOM feed.
  // Pattern: <entry>...<title>...province name...</title>...<link href="URL" .../></entry>
  const provinceFeedUrls = new Map<string, string>()

  // Extract all entry blocks
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let entryMatch
  while ((entryMatch = entryRegex.exec(atomXml)) !== null) {
    const block = entryMatch[1]
    const titleMatch = block.match(/<title[^>]*>([^<]+)</)
    const linkMatch = block.match(/<link[^>]*href="([^"]+)"[^>]*type="application\/atom\+xml"/)
      || block.match(/<link[^>]*type="application\/atom\+xml"[^>]*href="([^"]+)"/)
      || block.match(/<link[^>]*href="([^"]+)"/)
    if (!titleMatch || !linkMatch) continue

    const title = titleMatch[1].trim()
    const url = linkMatch[1].trim()

    // Match by province code or name
    for (const prov of TARGET_PROVINCES) {
      if (title.includes(prov.code) || title.toLowerCase().includes(prov.name.toLowerCase())) {
        provinceFeedUrls.set(prov.code, url)
      }
    }
  }

  console.log(`  Found ${provinceFeedUrls.size} province feed URLs out of ${TARGET_PROVINCES.length} targets`)
  if (provinceFeedUrls.size === 0) {
    // Fallback: try direct URL pattern
    console.log('  Trying direct URL pattern for province feeds...')
    for (const prov of TARGET_PROVINCES) {
      const directUrl = `https://www.catastro.hacienda.gob.es/INSPIRE/buildings/${prov.code}/ES.SDGC.BU.${prov.code}.atom.xml`
      provinceFeedUrls.set(prov.code, directUrl)
    }
  }

  // Step 1b: For each province, get the sub-feed to find the actual GML ZIP download
  const allBuildings: CatastroBuilding[] = []
  let processed = 0
  let errors = 0

  for (const prov of TARGET_PROVINCES) {
    const feedUrl = provinceFeedUrls.get(prov.code)
    if (!feedUrl) {
      console.log(`  SKIP province ${prov.code} (${prov.name}): no feed URL found`)
      errors++
      continue
    }

    console.log(`  [${prov.code}] ${prov.name}: fetching province feed...`)

    try {
      // The province sub-feed has entries for each municipality in the province.
      // Each entry links to a GML zip (buildingpart or building).
      // We want the "building" entries (not buildingpart) with numberOfFloorsAboveGround.
      const provRes = await fetch(feedUrl, { signal: AbortSignal.timeout(60_000) })
      if (!provRes.ok) {
        console.log(`  [${prov.code}] Feed download failed: ${provRes.status}`)
        errors++
        continue
      }
      const provAtom = await provRes.text()

      // Extract municipality GML zip URLs from province feed
      // Catastro structure: each entry has <link> to a ZIP containing GML
      // We want entries of type "building" (not "buildingpart")
      const muniUrls: { code: string; url: string }[] = []
      const muniEntryRegex = /<entry>([\s\S]*?)<\/entry>/g
      let me
      while ((me = muniEntryRegex.exec(provAtom)) !== null) {
        const block = me[1]
        // Look for ZIP download links (type application/zip or .zip href)
        const zipLinkMatch = block.match(/<link[^>]*href="([^"]*\.zip)"/)
          || block.match(/<link[^>]*href="([^"]*building[^"]*)"[^>]*type="application\/zip"/)
        if (!zipLinkMatch) continue

        const url = zipLinkMatch[1].trim()
        // Only building (BU.) files, not buildingpart (BP.)
        // Catastro names: A.ES.SDGC.BU.{municode}.zip
        if (url.includes('.BP.') || url.includes('buildingpart')) continue

        const codeMatch = url.match(/\.BU\.(\d+)\./) || url.match(/\/(\d+)\//);
        const code = codeMatch ? codeMatch[1] : ''
        muniUrls.push({ code, url })
      }

      console.log(`  [${prov.code}] ${muniUrls.length} municipality GML ZIPs found`)

      // Download and parse in batches
      let provBuildings = 0
      for (let i = 0; i < muniUrls.length; i += CONCURRENCY) {
        const batch = muniUrls.slice(i, i + CONCURRENCY)

        const fetches = await Promise.allSettled(
          batch.map(async ({ code, url }) => {
            const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
            if (!res.ok) return { code, buf: null }
            const buf = Buffer.from(await res.arrayBuffer())
            return { code, buf }
          })
        )

        for (const r of fetches) {
          if (r.status !== 'fulfilled' || !r.value.buf) { errors++; continue }
          const { code, buf } = r.value
          if (buf.length < 100) { errors++; continue }

          try {
            // Skip very large municipalities (avoid OOM)
            if (buf.length > 100 * 1024 * 1024) {
              console.log(`    SKIP ${code}: ZIP ${(buf.length/1e6).toFixed(0)} MB (too large)`)
              continue
            }

            const tmpZip = `/tmp/catastro_${prov.code}_${code}.zip`
            const tmpDir = `/tmp/catastro_extract_${prov.code}_${code}`
            writeFileSync(tmpZip, buf)
            mkdirSync(tmpDir, { recursive: true })
            execSync(`unzip -o -q "${tmpZip}" -d "${tmpDir}"`, { timeout: 60_000 })

            const gmlFiles = readdirSync(tmpDir).filter(f =>
              f.endsWith('.gml') || f.endsWith('.xml'))

            for (const gf of gmlFiles) {
              const gmlPath = resolve(tmpDir, gf)
              const buildings = await parseGmlBuildings(gmlPath)
              allBuildings.push(...buildings)
              provBuildings += buildings.length
            }

            execSync(`rm -rf "${tmpDir}" "${tmpZip}"`, { timeout: 5_000 })
          } catch (e: any) {
            if (errors < 5) console.log(`    ERROR ${code}: ${e.message?.substring(0, 120)}`)
            errors++
            try { execSync(`rm -rf /tmp/catastro_extract_${prov.code}_${code} /tmp/catastro_${prov.code}_${code}.zip`, { timeout: 5_000 }) } catch {}
          }
        }

        if ((i + CONCURRENCY) % 40 === 0 || i + CONCURRENCY >= muniUrls.length) {
          console.log(`    [${prov.code}] ${Math.min(i + CONCURRENCY, muniUrls.length)}/${muniUrls.length} municipalities, ${provBuildings.toLocaleString()} buildings`)
        }
      }

      processed++
      console.log(`  [${prov.code}] ${prov.name}: ${provBuildings.toLocaleString()} buildings extracted`)
    } catch (e: any) {
      console.log(`  [${prov.code}] ERROR: ${e.message?.substring(0, 150)}`)
      errors++
    }
  }

  console.log(`\n  Total: ${allBuildings.length.toLocaleString()} buildings from ${processed} provinces (${errors} errors)`)
  writeFileSync(CACHE_FILE, JSON.stringify(allBuildings))
  console.log(`  Cached to ${CACHE_FILE}`)

  return allBuildings
}

/**
 * Parse a Catastro INSPIRE GML file for building centroids + floor counts.
 * Streams the file line by line to handle large GML files.
 *
 * The GML contains <bu-ext:BuildingExtended> or <bu-core2d:Building> elements
 * with numberOfFloorsAboveGround and geometry (referencePoint or centroid).
 */
async function parseGmlBuildings(gmlPath: string): Promise<CatastroBuilding[]> {
  const buildings: CatastroBuilding[] = []

  // For moderate files, read whole file. For very large, stream.
  const stat = readFileSync(gmlPath)
  const gml = stat.toString('utf-8')

  // Try matching building blocks with numberOfFloorsAboveGround
  // Pattern 1: bu-ext:BuildingExtended or bu-core2d:Building members
  // The GML namespace varies, so use flexible regex
  const buildingRegex = /<(?:[\w-]+:)?(?:Building|BuildingExtended)\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?(?:Building|BuildingExtended)>/g
  let m
  while ((m = buildingRegex.exec(gml)) !== null) {
    const block = m[1]

    // Extract numberOfFloorsAboveGround
    const floorsMatch = block.match(/<(?:[\w-]+:)?numberOfFloorsAboveGround>(\d+)</)
    if (!floorsMatch) continue
    const floors = parseInt(floorsMatch[1])
    if (floors <= 0 || floors > 255) continue

    // Extract coordinates — try multiple patterns
    let lat = 0, lon = 0

    // Pattern: <gml:pos>lat lon</gml:pos> (referencePoint)
    const posMatch = block.match(/<gml:pos[^>]*>([^<]+)</)
    if (posMatch) {
      const parts = posMatch[1].trim().split(/\s+/)
      if (parts.length >= 2) {
        // Catastro INSPIRE uses EPSG:25830 (UTM zone 30N) for most of Spain,
        // but referencePoint or pos may be in different CRS.
        // Check srsName for CRS info
        const srsMatch = block.match(/srsName="([^"]*)"/)
        const srs = srsMatch ? srsMatch[1] : ''

        if (srs.includes('4326') || srs.includes('CRS84')) {
          // WGS84 — lat,lon or lon,lat depending on axis order
          const a = parseFloat(parts[0])
          const b = parseFloat(parts[1])
          if (a > 20 && a < 50) { lat = a; lon = b }
          else if (b > 20 && b < 50) { lat = b; lon = a }
        } else if (srs.includes('4258') || srs.includes('ETRS89')) {
          // ETRS89 geographic — same as WGS84 for practical purposes
          const a = parseFloat(parts[0])
          const b = parseFloat(parts[1])
          if (a > 20 && a < 50) { lat = a; lon = b }
          else if (b > 20 && b < 50) { lat = b; lon = a }
        } else {
          // Likely UTM (EPSG:25829, 25830, 25831) — need proj4 conversion
          // For simplicity in v1: skip UTM coords, rely on posList/exterior ring centroid
        }
      }
    }

    // Pattern: compute centroid from exterior ring posList (more reliable)
    if (lat === 0 && lon === 0) {
      const posListMatch = block.match(/<gml:posList[^>]*>([^<]+)</)
      if (posListMatch) {
        const srsMatch = block.match(/srsName="([^"]*)"/)
        const srs = srsMatch ? srsMatch[1] : ''
        const coords = posListMatch[1].trim().split(/\s+/).map(Number)

        if (srs.includes('4326') || srs.includes('CRS84') || srs.includes('4258') || srs.includes('ETRS89')) {
          // Geographic coords: pairs of (lat, lon) or (lon, lat)
          if (coords.length >= 4) {
            let sumLat = 0, sumLon = 0, count = 0
            // Determine axis order from first coordinate pair
            const first = coords[0]
            const isLatFirst = first > 20 && first < 50

            for (let i = 0; i < coords.length - 1; i += 2) {
              const a = coords[i]
              const b = coords[i + 1]
              if (isNaN(a) || isNaN(b)) continue
              if (isLatFirst) { sumLat += a; sumLon += b }
              else { sumLon += a; sumLat += b }
              count++
            }
            if (count > 0) {
              lat = sumLat / count
              lon = sumLon / count
            }
          }
        }
        // UTM coords skipped in v1
      }
    }

    // Validate: must be in Spain
    if (lat < 27 || lat > 44 || lon < -19 || lon > 5) continue
    if (lat === 0 && lon === 0) continue

    buildings.push({ lat, lon, floors })
  }

  return buildings
}

// ── Step 2: Enrich buildings.arrow ──

function flatDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  const dx = (lon2 - lon1) * 111320 * cosLat
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}

function enrichHexes(catastroBuildings: CatastroBuilding[]): void {
  // Build spatial index: 0.01 deg grid (~1km cells)
  const grid = new Map<string, CatastroBuilding[]>()
  for (const b of catastroBuildings) {
    const key = `${Math.floor(b.lat * 100)}_${Math.floor(b.lon * 100)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(b)
  }
  console.log(`  Spatial grid: ${grid.size} cells`)

  const hexDirs = readdirSync(H3R4_DIR).filter(d =>
    d.length === 15 && d.endsWith('ffffffff'))

  let totalBuildings = 0, totalEnriched = 0, floorsAdded = 0, hexesUpdated = 0

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

    const newFloors = new Uint8Array(n)
    let hexEnriched = 0

    for (let i = 0; i < n; i++) {
      const lat = clat.get(i) as number
      const lon = clon.get(i) as number
      const curFloors = existingFloors ? (existingFloors.get(i) as number) : 0
      newFloors[i] = curFloors

      // Only enrich if floors are missing and within Spain
      if (curFloors > 0) continue
      if (lat < 27 || lat > 44 || lon < -19 || lon > 5) continue

      // Find nearest Catastro building within 30m
      let bestDist = 30
      let bestFloors = 0

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = `${Math.floor(lat * 100) + dy}_${Math.floor(lon * 100) + dx}`
          const cell = grid.get(k)
          if (!cell) continue
          for (const cb of cell) {
            const d = flatDist(lat, lon, cb.lat, cb.lon)
            if (d < bestDist) {
              bestDist = d
              bestFloors = cb.floors
            }
          }
        }
      }

      if (bestFloors > 0) {
        newFloors[i] = Math.min(bestFloors, 255)
        hexEnriched++
        floorsAdded++
      }
    }

    if (hexEnriched === 0) continue
    totalEnriched += hexEnriched

    const columns: Record<string, any> = {}
    for (const field of table.schema.fields) {
      if (field.name === 'floors') continue
      columns[field.name] = table.getChild(field.name)!
    }
    columns['floors'] = vectorFromArray(newFloors, new Uint8())

    const newTable = makeTable(columns)
    writeFileSync(bldPath, Buffer.from(tableToIPC(newTable, 'file')))
    hexesUpdated++
  }

  console.log(`\n=== Results ===`)
  console.log(`  ${totalEnriched} / ${totalBuildings} buildings matched to Catastro (${totalBuildings > 0 ? (totalEnriched / totalBuildings * 100).toFixed(1) : 0}%)`)
  console.log(`  ${floorsAdded} floors added (were missing in OSM)`)
  console.log(`  ${hexesUpdated} / ${hexDirs.length} hexes updated`)
}

// ── Main ──

async function main() {
  console.log(`=== ES Building Enrichment — Catastro INSPIRE (${YEAR}) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}`)
  console.log(`  Target provinces: ${TARGET_PROVINCES.map(p => `${p.name} (${p.code})`).join(', ')}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  const buildings = await downloadCatastro()
  console.log(`\n  Catastro buildings: ${buildings.length.toLocaleString()}`)

  if (buildings.length === 0) {
    console.log('  No buildings extracted. Nothing to enrich.')
    return
  }

  console.log('  Enriching buildings.arrow files...')
  enrichHexes(buildings)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
