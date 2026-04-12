/**
 * Service-tree AADT enrichment for residential roads.
 *
 * Builds a road graph per H3R4 hex, finds leaf branches (dead-end residential
 * chains), counts nearby building dwellings, and computes AADT from dwelling
 * count instead of the flat default (500 veh/day).
 *
 * Only modifies: road_class >= 5 AND traffic_source == 0 AND on a leaf branch.
 * Sets traffic_source = 2 (heuristic estimate).
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-service-tree.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-service-tree.ts --prefix 841e309
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const PREFIX = process.argv.includes('--prefix') ? process.argv[process.argv.indexOf('--prefix') + 1] : ''

const GRID_CELL = 0.0005       // building grid cell size in degrees (~55m at equator)
const MAX_BUFFER_M = 50        // building search radius in meters
const MAX_BRANCH_LENGTH_M = 5000   // 5km per leaf branch — skip obviously misclassified long roads
const TRIPS_PER_DWELLING = 6
const MIN_AADT = 20

// Vehicle split matching engine defaults for residential (480/5/10/5 ≈ 96/1/2/1)
const SPLIT_LIGHT = 0.96
const SPLIT_MEDIUM = 0.01
const SPLIT_HEAVY = 0.02
const SPLIT_MOTO = 0.01

// ---------- Geometry ----------

function flatDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  const dx = (lon2 - lon1) * 111320 * cosLat
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}

function pointToSegmentDist(pLat: number, pLon: number, aLat: number, aLon: number, bLat: number, bLon: number): number {
  const cosLat = Math.cos(pLat * Math.PI / 180)
  const px = pLon * 111320 * cosLat, py = pLat * 110540
  const ax = aLon * 111320 * cosLat, ay = aLat * 110540
  const bx = bLon * 111320 * cosLat, by = bLat * 110540
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-6) return flatDist(pLat, pLon, aLat, aLon)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx, cy = ay + t * dy
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy))
}

// ---------- Helpers ----------

function nodeKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)}_${lon.toFixed(5)}`
}

function gridKey(lat: number, lon: number): string {
  return `${Math.floor(lat / GRID_CELL)}_${Math.floor(lon / GRID_CELL)}`
}

function estimateDwellings(buildingType: number, floors: number, areaMr2: number | null): number {
  const area = areaMr2 ?? 100
  // Check building_type FIRST, then floors
  if (buildingType === 1) return Math.min(Math.ceil(area / 50), 200)   // commercial
  if (buildingType === 2) return Math.min(Math.ceil(area / 100), 200)  // industrial
  if (buildingType === 7) return 1                                     // garage
  if (buildingType === 8) return Math.min(Math.ceil(area / 100), 200)  // farm
  // Residential (type 0) or anything else
  if (floors > 0) return Math.min(Math.max(1, Math.floor(floors * area / 80)), 200)
  return 1
}

function computeAADT(dwellings: number): { light: number; medium: number; heavy: number; moto: number } {
  const total = Math.max(dwellings * TRIPS_PER_DWELLING, MIN_AADT)
  const medium = Math.round(total * SPLIT_MEDIUM)
  const heavy = Math.round(total * SPLIT_HEAVY)
  const moto = Math.round(total * SPLIT_MOTO)
  const light = total - medium - heavy - moto // remainder to light, guarantees exact sum
  return { light, medium, heavy, moto }
}

// ---------- Graph ----------

interface GraphNode {
  degree: number           // total degree (all road classes)
  eligibleEdges: number[]  // segment indices that are eligible (residential, traffic_source==0)
}

function buildGraph(table: any) {
  const n = table.numRows
  const startLat = table.getChild('start_lat')!
  const startLon = table.getChild('start_lon')!
  const endLat = table.getChild('end_lat')!
  const endLon = table.getChild('end_lon')!
  const roadClass = table.getChild('road_class')!
  const existingSrc = table.getChild('traffic_source')

  const nodes = new Map<string, GraphNode>()
  const segToNodes: [string, string][] = new Array(n)
  const eligible = new Uint8Array(n) // 1 = eligible for enrichment

  function getOrCreate(key: string): GraphNode {
    let nd = nodes.get(key)
    if (!nd) { nd = { degree: 0, eligibleEdges: [] }; nodes.set(key, nd) }
    return nd
  }

  for (let i = 0; i < n; i++) {
    const sKey = nodeKey(startLat.get(i) as number, startLon.get(i) as number)
    const eKey = nodeKey(endLat.get(i) as number, endLon.get(i) as number)
    segToNodes[i] = [sKey, eKey]

    const sNode = getOrCreate(sKey)
    const eNode = getOrCreate(eKey)
    // All segments contribute to degree
    sNode.degree++
    eNode.degree++

    const cls = (roadClass.get(i) as number) ?? 5
    const src = (existingSrc?.get(i) as number) ?? 0
    if (cls >= 5 && src === 0) {
      eligible[i] = 1
      sNode.eligibleEdges.push(i)
      eNode.eligibleEdges.push(i)
    }
  }

  return { nodes, segToNodes, eligible }
}

// ---------- Connected components ----------

interface Component {
  segments: number[]        // segment indices
  rootNodes: Set<string>    // nodes connecting to non-residential network
}

function findComponents(
  nodes: Map<string, GraphNode>,
  segToNodes: [string, string][],
  eligible: Uint8Array
): Component[] {
  const visited = new Set<number>() // visited segment indices
  const components: Component[] = []

  for (let i = 0; i < eligible.length; i++) {
    if (!eligible[i] || visited.has(i)) continue

    // BFS from segment i
    const comp: Component = { segments: [], rootNodes: new Set() }
    const queue: number[] = [i]
    visited.add(i)

    while (queue.length > 0) {
      const seg = queue.shift()!
      comp.segments.push(seg)

      const [sKey, eKey] = segToNodes[seg]
      for (const nk of [sKey, eKey]) {
        const node = nodes.get(nk)!
        // A root node has connections to non-eligible roads (degree > eligible edges count at this node)
        const eligibleDegree = node.eligibleEdges.length
        if (node.degree > eligibleDegree) {
          comp.rootNodes.add(nk)
        }
        // Traverse to adjacent eligible segments
        for (const adj of node.eligibleEdges) {
          if (!visited.has(adj)) {
            visited.add(adj)
            queue.push(adj)
          }
        }
      }
    }

    components.push(comp)
  }

  return components
}

// ---------- Building spatial grid ----------

interface BuildingGrid {
  grid: Map<string, number[]>
  lats: Float64Array
  lons: Float64Array
  types: Uint8Array
  floors: Uint8Array
  areas: (number | null)[]
}

function buildBuildingGrid(table: any): BuildingGrid {
  const n = table.numRows
  const latCol = table.getChild('centroid_lat')!
  const lonCol = table.getChild('centroid_lon')!
  const typeCol = table.getChild('building_type')!
  const floorCol = table.getChild('floors')!
  const areaCol = table.getChild('area_m2')

  const lats = new Float64Array(n)
  const lons = new Float64Array(n)
  const types = new Uint8Array(n)
  const flrs = new Uint8Array(n)
  const areas: (number | null)[] = new Array(n)
  const grid = new Map<string, number[]>()

  for (let i = 0; i < n; i++) {
    const lat = latCol.get(i) as number
    const lon = lonCol.get(i) as number
    lats[i] = lat
    lons[i] = lon
    types[i] = (typeCol.get(i) as number) ?? 0
    flrs[i] = (floorCol.get(i) as number) ?? 0
    const a = areaCol?.get(i)
    areas[i] = a != null ? a as number : null

    const key = gridKey(lat, lon)
    let list = grid.get(key)
    if (!list) { list = []; grid.set(key, list) }
    list.push(i)
  }

  return { grid, lats, lons, types, floors: flrs, areas }
}


// ---------- Leaf branch finding within a component ----------

interface LeafBranch {
  segments: number[]
  lengthM: number
}

function findLeafBranches(
  comp: Component,
  nodes: Map<string, GraphNode>,
  segToNodes: [string, string][],
  lengthCol: any
): LeafBranch[] {
  const branches: LeafBranch[] = []

  // Build component-local adjacency: node -> eligible edges within this component
  const localAdj = new Map<string, number[]>()
  for (const seg of comp.segments) {
    const [sKey, eKey] = segToNodes[seg]
    for (const nk of [sKey, eKey]) {
      let list = localAdj.get(nk)
      if (!list) { list = []; localAdj.set(nk, list) }
      list.push(seg)
    }
  }

  // Find dead-end nodes: degree 1 in the FULL graph AND connected to an eligible edge
  const deadEnds: string[] = []
  for (const [nk, edges] of localAdj) {
    const fullNode = nodes.get(nk)!
    if (fullNode.degree === 1 && edges.length === 1) {
      deadEnds.push(nk)
    }
  }

  // Walk from each dead-end through degree-2 (in local adj) nodes
  // until hitting a node with 3+ local edges (internal junction) or a root node
  for (const start of deadEnds) {
    const branch: number[] = []
    let totalLen = 0
    let current = start
    let prevSeg = -1

    while (true) {
      const edges = localAdj.get(current)!
      const nextSeg = edges.find(e => e !== prevSeg)
      if (nextSeg === undefined) break

      branch.push(nextSeg)
      totalLen += (lengthCol.get(nextSeg) as number) ?? 0
      if (totalLen > MAX_BRANCH_LENGTH_M) break

      const [sKey, eKey] = segToNodes[nextSeg]
      const nextNode = (sKey === current) ? eKey : sKey
      prevSeg = nextSeg
      current = nextNode

      const nextEdges = localAdj.get(current)
      if (!nextEdges || nextEdges.length !== 2) break
      const fullNode = nodes.get(current)!
      if (fullNode.degree > nextEdges.length) break
    }

    if (branch.length > 0) {
      branches.push({ segments: branch, lengthM: totalLen })
    }
  }

  // Detect pure loop cul-de-sacs: components with NO dead-ends where all
  // segments form a loop attached to the main network. Mixed components
  // (dead-ends + loops) keep their loops at the default AADT.
  if (deadEnds.length === 0 && comp.segments.length > 0) {
    let totalLen = 0
    for (const seg of comp.segments) totalLen += (lengthCol.get(seg) as number) ?? 0
    if (totalLen <= MAX_BRANCH_LENGTH_M) {
      branches.push({ segments: [...comp.segments], lengthM: totalLen })
    }
  }

  return branches
}

// ---------- Count dwellings for a set of segments ----------

function countBranchDwellings(
  segments: number[],
  startLat: any, startLon: any, endLat: any, endLon: any,
  bg: BuildingGrid
): number {
  const seen = new Set<number>()
  let totalDwellings = 0

  // Compute representative latitude for grid search radius
  let sumLat = 0
  for (const seg of segments) sumLat += startLat.get(seg) as number
  const avgLat = sumLat / segments.length
  const lonCells = Math.ceil(MAX_BUFFER_M / (111320 * GRID_CELL * Math.cos(avgLat * Math.PI / 180)))
  const latCells = Math.ceil(MAX_BUFFER_M / (110540 * GRID_CELL))

  for (const seg of segments) {
    const sLat = startLat.get(seg) as number
    const sLon = startLon.get(seg) as number
    const eLat = endLat.get(seg) as number
    const eLon = endLon.get(seg) as number

    const minLat = Math.min(sLat, eLat)
    const maxLat = Math.max(sLat, eLat)
    const minLon = Math.min(sLon, eLon)
    const maxLon = Math.max(sLon, eLon)

    const gMinLat = Math.floor(minLat / GRID_CELL) - latCells
    const gMaxLat = Math.floor(maxLat / GRID_CELL) + latCells
    const gMinLon = Math.floor(minLon / GRID_CELL) - lonCells
    const gMaxLon = Math.floor(maxLon / GRID_CELL) + lonCells

    for (let gLat = gMinLat; gLat <= gMaxLat; gLat++) {
      for (let gLon = gMinLon; gLon <= gMaxLon; gLon++) {
        const key = `${gLat}_${gLon}`
        const buildings = bg.grid.get(key)
        if (!buildings) continue
        for (const bi of buildings) {
          if (seen.has(bi)) continue
          const dist = pointToSegmentDist(bg.lats[bi], bg.lons[bi], sLat, sLon, eLat, eLon)
          if (dist <= MAX_BUFFER_M) {
            seen.add(bi)
            totalDwellings += estimateDwellings(bg.types[bi], bg.floors[bi], bg.areas[bi])
          }
        }
      }
    }
  }

  return totalDwellings
}

// ---------- Process one hex ----------

function processHex(hexId: string): { enriched: number; totalResidential: number; compStats: { dwellings: number; aadtTotal: number; segments: number }[] } | null {
  const roadsPath = resolve(H3R4_DIR, hexId, 'roads.arrow')
  const buildingsPath = resolve(H3R4_DIR, hexId, 'buildings.arrow')
  if (!existsSync(roadsPath) || !existsSync(buildingsPath)) return null

  const roadTable = tableFromIPC(readFileSync(roadsPath))
  const n = roadTable.numRows
  if (n === 0) return null

  const buildingTable = tableFromIPC(readFileSync(buildingsPath))
  if (buildingTable.numRows === 0) return null

  // Build graph
  const { nodes, segToNodes, eligible } = buildGraph(roadTable)

  // Count eligible segments
  let eligibleCount = 0
  for (let i = 0; i < n; i++) if (eligible[i]) eligibleCount++
  if (eligibleCount === 0) return null

  // Find connected components
  const components = findComponents(nodes, segToNodes, eligible)
  if (components.length === 0) return null

  // Build building spatial grid
  const bg = buildBuildingGrid(buildingTable)

  // Get column refs
  const startLat = roadTable.getChild('start_lat')!
  const startLon = roadTable.getChild('start_lon')!
  const endLat = roadTable.getChild('end_lat')!
  const endLon = roadTable.getChild('end_lon')!
  const lengthCol = roadTable.getChild('length_m')!

  // For each component, find leaf branches and compute per-branch AADT
  // Segments on multiple branches get summed dwellings
  const segDwellings = new Map<number, number>()
  const compStats: { dwellings: number; aadtTotal: number; segments: number }[] = []

  for (const comp of components) {
    // Small components (all segments form a simple dead-end chain): treat as one branch
    const branches = findLeafBranches(comp, nodes, segToNodes, lengthCol)

    if (branches.length === 0) {
      // No dead-ends — this is a through-residential component, skip
      continue
    }

    for (const branch of branches) {
      const dwellings = countBranchDwellings(branch.segments, startLat, startLon, endLat, endLon, bg)
      for (const seg of branch.segments) {
        segDwellings.set(seg, (segDwellings.get(seg) ?? 0) + dwellings)
      }
      const aadt = computeAADT(dwellings)
      const aadtTotal = aadt.light + aadt.medium + aadt.heavy + aadt.moto
      compStats.push({ dwellings, aadtTotal, segments: branch.segments.length })
    }
  }

  // Convert dwellings to AADT per segment
  const segAADT = new Map<number, { light: number; medium: number; heavy: number; moto: number }>()
  for (const [seg, dw] of segDwellings) {
    segAADT.set(seg, computeAADT(dw))
  }

  if (segAADT.size === 0) return null

  // Write back — EC pattern: copy existing values first
  const existingSource = roadTable.getChild('traffic_source')
  const existingLight = roadTable.getChild('aadt_light')
  const existingMed = roadTable.getChild('aadt_medium')
  const existingHvy = roadTable.getChild('aadt_heavy')
  const existingMoto = roadTable.getChild('aadt_moto')

  const trafficSource = new Uint8Array(n)
  const aadtLight = new Int32Array(n)
  const aadtMedium = new Int32Array(n)
  const aadtHeavy = new Int32Array(n)
  const aadtMoto = new Int32Array(n)

  for (let i = 0; i < n; i++) {
    trafficSource[i] = (existingSource?.get(i) as number) ?? 0
    aadtLight[i] = (existingLight?.get(i) as number) ?? 0
    aadtMedium[i] = (existingMed?.get(i) as number) ?? 0
    aadtHeavy[i] = (existingHvy?.get(i) as number) ?? 0
    aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
  }

  let enriched = 0
  for (const [seg, aadt] of segAADT) {
    aadtLight[seg] = aadt.light
    aadtMedium[seg] = aadt.medium
    aadtHeavy[seg] = aadt.heavy
    aadtMoto[seg] = aadt.moto
    trafficSource[seg] = 2
    enriched++
  }

  // Build new table
  const columns: Record<string, any> = {}
  for (const field of roadTable.schema.fields) {
    if (['traffic_source', 'aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto'].includes(field.name)) continue
    columns[field.name] = roadTable.getChild(field.name)!
  }
  columns['traffic_source'] = vectorFromArray(trafficSource, new Uint8())
  columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
  columns['aadt_medium'] = vectorFromArray(aadtMedium, new Int32())
  columns['aadt_heavy'] = vectorFromArray(aadtHeavy, new Int32())
  columns['aadt_moto'] = vectorFromArray(aadtMoto, new Int32())
  const newTable = makeTable(columns)
  writeFileSync(roadsPath, Buffer.from(tableToIPC(newTable, 'file')))

  return { enriched, totalResidential: eligibleCount, compStats }
}

// ---------- Main ----------

function main() {
  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  const hexDirs = readdirSync(H3R4_DIR).filter(d => {
    if (d.startsWith('.')) return false
    if (PREFIX && !d.startsWith(PREFIX)) return false
    return true
  })

  console.log(`Service-tree AADT enrichment`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Hexes: ${hexDirs.length}${PREFIX ? ` (prefix: ${PREFIX})` : ''}`)

  const startTime = Date.now()
  let lastProgress = startTime
  let hexesProcessed = 0
  let hexesEnriched = 0
  let totalSegmentsEnriched = 0
  let totalResidential = 0

  // AADT distribution
  const allAadts: { aadt: number; dwellings: number; segments: number; hex: string }[] = []

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hexId = hexDirs[hi]
    const result = processHex(hexId)

    if (result) {
      hexesEnriched++
      totalSegmentsEnriched += result.enriched
      totalResidential += result.totalResidential
      for (const cs of result.compStats) {
        allAadts.push({ aadt: cs.aadtTotal, dwellings: cs.dwellings, segments: cs.segments, hex: hexId })
      }
    }
    hexesProcessed++

    const now = Date.now()
    if (now - lastProgress >= 10_000) {
      lastProgress = now
      const elapsed = ((now - startTime) / 1000).toFixed(0)
      process.stdout.write(`\r  [${elapsed}s] ${hexesProcessed}/${hexDirs.length} hexes, ${hexesEnriched} enriched, ${totalSegmentsEnriched} segments`)
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n\n=== Results (${elapsed}s) ===`)
  console.log(`  Hexes: ${hexesProcessed} processed, ${hexesEnriched} enriched`)
  console.log(`  Segments: ${totalSegmentsEnriched} enriched / ${totalResidential} eligible residential`)
  if (totalResidential > 0) {
    console.log(`  Coverage: ${(totalSegmentsEnriched / totalResidential * 100).toFixed(1)}%`)
  }

  if (allAadts.length > 0) {
    // Distribution histogram
    const buckets = [20, 50, 100, 200, 500, 1000]
    const counts = new Array(buckets.length + 1).fill(0)
    for (const a of allAadts) {
      let placed = false
      for (let b = 0; b < buckets.length; b++) {
        if (a.aadt <= buckets[b]) { counts[b]++; placed = true; break }
      }
      if (!placed) counts[buckets.length]++
    }
    console.log(`\n  AADT distribution (${allAadts.length} components):`)
    for (let b = 0; b < buckets.length; b++) {
      const lo = b === 0 ? 0 : buckets[b - 1] + 1
      console.log(`    ${String(lo).padStart(5)}-${String(buckets[b]).padStart(5)}: ${counts[b]}`)
    }
    console.log(`    ${String(buckets[buckets.length - 1] + 1).padStart(5)}+     : ${counts[buckets.length]}`)

    // Top 20 lowest
    allAadts.sort((a, b) => a.aadt - b.aadt)
    console.log(`\n  Top 20 lowest AADT:`)
    for (const a of allAadts.slice(0, 20)) {
      console.log(`    AADT ${String(a.aadt).padStart(5)} | ${String(a.dwellings).padStart(4)} dwellings | ${String(a.segments).padStart(4)} segs | ${a.hex}`)
    }

    // Top 20 highest
    console.log(`\n  Top 20 highest AADT:`)
    for (const a of allAadts.slice(-20).reverse()) {
      console.log(`    AADT ${String(a.aadt).padStart(5)} | ${String(a.dwellings).padStart(4)} dwellings | ${String(a.segments).padStart(4)} segs | ${a.hex}`)
    }
  }
}

main()
