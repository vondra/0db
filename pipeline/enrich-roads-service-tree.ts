/**
 * Service-tree AADT enrichment for residential roads (v2: flow accumulation).
 *
 * Assigns each building to its nearest eligible segment, then uses multi-source
 * Dijkstra from root nodes (where residential meets higher-class roads) to orient
 * traffic flow. Accumulates trips bottom-up from leaves toward roots — dead-end
 * streets get only their local buildings, collector roads accumulate sub-branches.
 *
 * Only modifies: road_class in [5..9] (local roads) AND traffic_source == 0.
 * Excludes motorway_link / trunk_link / primary_link (10/11/12) — those carry
 * highway flow that residential accumulation drastically undercounts.
 * Sets traffic_source = 2 (heuristic estimate).
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-service-tree.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-service-tree.ts --prefix 841e309
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'

const MY_DATASET_ID = DATASETS_BY_KEY.get('service-tree-heuristic')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const PREFIX = process.argv.includes('--prefix') ? process.argv[process.argv.indexOf('--prefix') + 1] : ''

const GRID_CELL = 0.0005       // building grid cell size in degrees (~55m at equator)
const MAX_BUFFER_M = 50        // building search radius in meters
const TRIPS_PER_DWELLING = 6
const MIN_AADT = 20

// Vehicle split matching engine defaults for residential (480/5/10/5 ≈ 96/1/2/1)
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
  if (buildingType === 1) return Math.min(Math.ceil(area / 50), 200)
  if (buildingType === 2) return Math.min(Math.ceil(area / 100), 200)
  if (buildingType === 7) return 1
  if (buildingType === 8) return Math.min(Math.ceil(area / 100), 200)
  if (floors > 0) return Math.min(Math.max(1, Math.floor(floors * area / 80)), 200)
  return 1
}

function splitAADT(totalTrips: number): { light: number; medium: number; heavy: number; moto: number } {
  const total = Math.max(totalTrips, MIN_AADT)
  const medium = Math.round(total * SPLIT_MEDIUM)
  const heavy = Math.round(total * SPLIT_HEAVY)
  const moto = Math.round(total * SPLIT_MOTO)
  const light = total - medium - heavy - moto
  return { light, medium, heavy, moto }
}

// ---------- Min-heap for Dijkstra ----------

class MinHeap {
  private data: { dist: number; node: string }[] = []

  push(dist: number, node: string) {
    this.data.push({ dist, node })
    let i = this.data.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.data[p].dist <= this.data[i].dist) break
      ;[this.data[p], this.data[i]] = [this.data[i], this.data[p]]
      i = p
    }
  }

  pop(): { dist: number; node: string } {
    const top = this.data[0]
    const last = this.data.pop()!
    if (this.data.length > 0) {
      this.data[0] = last
      let i = 0
      while (true) {
        let smallest = i
        const l = 2 * i + 1, r = 2 * i + 2
        if (l < this.data.length && this.data[l].dist < this.data[smallest].dist) smallest = l
        if (r < this.data.length && this.data[r].dist < this.data[smallest].dist) smallest = r
        if (smallest === i) break
        ;[this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]]
        i = smallest
      }
    }
    return top
  }

  get size() { return this.data.length }
}

// ---------- Graph ----------

interface GraphNode {
  degree: number
  eligibleEdges: number[]
}

function buildGraph(table: any) {
  const n = table.numRows
  const startLat = table.getChild('start_lat')!
  const startLon = table.getChild('start_lon')!
  const endLat = table.getChild('end_lat')!
  const endLon = table.getChild('end_lon')!
  const roadClass = table.getChild('road_class')!
  const existingDatasetId = table.getChild('roads_dataset_id')

  const nodes = new Map<string, GraphNode>()
  const segToNodes: [string, string][] = new Array(n)
  const eligible = new Uint8Array(n)

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
    sNode.degree++
    eNode.degree++

    const cls = (roadClass.get(i) as number) ?? 5
    const existingId = existingDatasetId ? (existingDatasetId.get(i) as number) ?? 0 : 0
    // Only local roads (residential, living_street, service, track, unclassified)
    // and only where this heuristic can overwrite the row (empty slot or lower-
    // priority dataset). service-tree priority is low (10).
    //
    // Excludes motorway_link / trunk_link / primary_link (codes 10-12). Those
    // carry highway-derived traffic — flow accumulation from local residential
    // dwellings undercounts them by ~100× (a GC-1 on-ramp got 20/day here vs
    // 6000/day from the class-default 20 % mainline heuristic that kicks in
    // when traffic_source stays 0).
    if (cls >= 5 && cls <= 9 && shouldOverwrite(existingId, MY_DATASET_ID)) {
      eligible[i] = 1
      sNode.eligibleEdges.push(i)
      eNode.eligibleEdges.push(i)
    }
  }

  return { nodes, segToNodes, eligible }
}

// ---------- Connected components ----------

interface Component {
  segments: number[]
  rootNodes: Set<string>
}

function findComponents(
  nodes: Map<string, GraphNode>,
  segToNodes: [string, string][],
  eligible: Uint8Array
): Component[] {
  const visited = new Set<number>()
  const components: Component[] = []

  for (let i = 0; i < eligible.length; i++) {
    if (!eligible[i] || visited.has(i)) continue

    const comp: Component = { segments: [], rootNodes: new Set() }
    const queue: number[] = [i]
    visited.add(i)

    while (queue.length > 0) {
      const seg = queue.shift()!
      comp.segments.push(seg)

      const [sKey, eKey] = segToNodes[seg]
      for (const nk of [sKey, eKey]) {
        const node = nodes.get(nk)!
        if (node.degree > node.eligibleEdges.length) {
          comp.rootNodes.add(nk)
        }
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

// ---------- Flow accumulation per component ----------

function flowAccumulate(
  comp: Component,
  nodes: Map<string, GraphNode>,
  segToNodes: [string, string][],
  startLat: any, startLon: any, endLat: any, endLon: any,
  lengthCol: any,
  bg: BuildingGrid
): Map<number, number> {
  // Build component-local adjacency
  const localAdj = new Map<string, number[]>()
  const compNodes = new Set<string>()
  for (const seg of comp.segments) {
    const [sKey, eKey] = segToNodes[seg]
    for (const nk of [sKey, eKey]) {
      compNodes.add(nk)
      let list = localAdj.get(nk)
      if (!list) { list = []; localAdj.set(nk, list) }
      list.push(seg)
    }
  }

  // --- Step 1: Assign buildings to nearest segment (once per building) ---
  const bestSeg = new Map<number, number>()
  const bestDist = new Map<number, number>()

  let sumLat = 0, segCount = 0
  for (const seg of comp.segments) { sumLat += startLat.get(seg) as number; segCount++ }
  const avgLat = sumLat / segCount
  const lonCells = Math.ceil(MAX_BUFFER_M / (111320 * GRID_CELL * Math.cos(avgLat * Math.PI / 180)))
  const latCells = Math.ceil(MAX_BUFFER_M / (110540 * GRID_CELL))

  for (const seg of comp.segments) {
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
          const dist = pointToSegmentDist(bg.lats[bi], bg.lons[bi], sLat, sLon, eLat, eLon)
          if (dist <= MAX_BUFFER_M && dist < (bestDist.get(bi) ?? Infinity)) {
            bestDist.set(bi, dist)
            bestSeg.set(bi, seg)
          }
        }
      }
    }
  }

  // Compute local trips per segment
  const segFlow = new Map<number, number>()
  for (const seg of comp.segments) segFlow.set(seg, 0)
  for (const [bi, seg] of bestSeg) {
    const dw = estimateDwellings(bg.types[bi], bg.floors[bi], bg.areas[bi])
    segFlow.set(seg, segFlow.get(seg)! + dw * TRIPS_PER_DWELLING)
  }

  // --- Step 2: Multi-source Dijkstra from root nodes ---
  const dist = new Map<string, number>()
  const downSeg = new Map<string, number>()
  for (const nk of compNodes) dist.set(nk, Infinity)

  const roots = comp.rootNodes
  if (roots.size === 0) {
    // Isolated: pick highest-degree node as pseudo-root
    let best = '', bestDeg = -1
    for (const nk of compNodes) {
      const d = localAdj.get(nk)!.length
      if (d > bestDeg) { bestDeg = d; best = nk }
    }
    roots.add(best)
  }

  const pq = new MinHeap()
  for (const r of roots) { dist.set(r, 0); pq.push(0, r) }

  while (pq.size > 0) {
    const { dist: d, node: u } = pq.pop()
    if (d > dist.get(u)!) continue

    const edges = localAdj.get(u)
    if (!edges) continue
    for (const seg of edges) {
      const [sKey, eKey] = segToNodes[seg]
      const v = (sKey === u) ? eKey : sKey
      const len = Math.max(1, (lengthCol.get(seg) as number) ?? 1)
      const newDist = dist.get(u)! + len
      if (newDist < dist.get(v)!) {
        dist.set(v, newDist)
        downSeg.set(v, seg)
        pq.push(newDist, v)
      }
    }
  }

  // --- Step 3: Bottom-up accumulation ---
  const sortedNodes = Array.from(compNodes).sort((a, b) => dist.get(b)! - dist.get(a)!)

  for (const u of sortedNodes) {
    // Sum flow arriving at u from upstream segments (where u is the "lower" end)
    let inflow = 0
    const edges = localAdj.get(u)
    if (!edges) continue
    for (const seg of edges) {
      const [sKey, eKey] = segToNodes[seg]
      const other = (sKey === u) ? eKey : sKey
      // This segment flows toward u if u is closer to root (lower dist)
      if (dist.get(other)! > dist.get(u)!) {
        inflow += segFlow.get(seg)!
      }
    }

    // Push inflow into the downstream segment
    const dSeg = downSeg.get(u)
    if (dSeg !== undefined) {
      segFlow.set(dSeg, segFlow.get(dSeg)! + inflow)
    }
  }

  return segFlow
}

// ---------- Process one hex ----------

function processHex(hexId: string): { enriched: number; totalResidential: number } | null {
  const roadsPath = resolve(H3R4_DIR, hexId, 'roads.arrow')
  const buildingsPath = resolve(H3R4_DIR, hexId, 'buildings.arrow')
  if (!existsSync(roadsPath) || !existsSync(buildingsPath)) return null

  const roadTable = tableFromIPC(readFileSync(roadsPath))
  const n = roadTable.numRows
  if (n === 0) return null

  const buildingTable = tableFromIPC(readFileSync(buildingsPath))
  if (buildingTable.numRows === 0) return null

  const { nodes, segToNodes, eligible } = buildGraph(roadTable)

  let eligibleCount = 0
  for (let i = 0; i < n; i++) if (eligible[i]) eligibleCount++
  if (eligibleCount === 0) return null

  const components = findComponents(nodes, segToNodes, eligible)
  if (components.length === 0) return null

  const bg = buildBuildingGrid(buildingTable)
  const startLat = roadTable.getChild('start_lat')!
  const startLon = roadTable.getChild('start_lon')!
  const endLat = roadTable.getChild('end_lat')!
  const endLon = roadTable.getChild('end_lon')!
  const lengthCol = roadTable.getChild('length_m')!

  // Flow accumulation per component
  const segAADT = new Map<number, { light: number; medium: number; heavy: number; moto: number }>()

  for (const comp of components) {
    const segFlow = flowAccumulate(comp, nodes, segToNodes, startLat, startLon, endLat, endLon, lengthCol, bg)
    for (const [seg, trips] of segFlow) {
      segAADT.set(seg, splitAADT(trips))
    }
  }

  if (segAADT.size === 0) return null

  // Write back — EC pattern: copy existing values first
  const existingSource = roadTable.getChild('traffic_source')
  const existingLight = roadTable.getChild('aadt_light')
  const existingMed = roadTable.getChild('aadt_medium')
  const existingHvy = roadTable.getChild('aadt_heavy')
  const existingMoto = roadTable.getChild('aadt_moto')
  const existingDatasetId = roadTable.getChild('roads_dataset_id')

  const trafficSource = new Uint8Array(n)
  const aadtLight = new Int32Array(n)
  const aadtMedium = new Int32Array(n)
  const aadtHeavy = new Int32Array(n)
  const aadtMoto = new Int32Array(n)
  const datasetId = new Uint16Array(n)

  for (let i = 0; i < n; i++) {
    trafficSource[i] = (existingSource?.get(i) as number) ?? 0
    aadtLight[i] = (existingLight?.get(i) as number) ?? 0
    aadtMedium[i] = (existingMed?.get(i) as number) ?? 0
    aadtHeavy[i] = (existingHvy?.get(i) as number) ?? 0
    aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
    datasetId[i] = existingDatasetId ? (existingDatasetId.get(i) as number) ?? 0 : 0
  }

  let enriched = 0
  for (const [seg, aadt] of segAADT) {
    // Eligibility was already gated via shouldOverwrite() in buildGraph().
    // Whole-row atomic write — payload + dataset_id together.
    if (!shouldOverwrite(datasetId[seg], MY_DATASET_ID)) continue
    aadtLight[seg] = aadt.light
    aadtMedium[seg] = aadt.medium
    aadtHeavy[seg] = aadt.heavy
    aadtMoto[seg] = aadt.moto
    trafficSource[seg] = 2
    datasetId[seg] = MY_DATASET_ID
    enriched++
  }

  const columns: Record<string, any> = {}
  for (const field of roadTable.schema.fields) {
    if (['traffic_source', 'aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto', 'roads_dataset_id'].includes(field.name)) continue
    columns[field.name] = roadTable.getChild(field.name)!
  }
  columns['traffic_source'] = vectorFromArray(trafficSource, new Uint8())
  columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
  columns['aadt_medium'] = vectorFromArray(aadtMedium, new Int32())
  columns['aadt_heavy'] = vectorFromArray(aadtHeavy, new Int32())
  columns['aadt_moto'] = vectorFromArray(aadtMoto, new Int32())
  columns['roads_dataset_id'] = vectorFromArray(datasetId, new Uint16())
  const newTable = makeTable(columns)
  writeFileSync(roadsPath, Buffer.from(tableToIPC(newTable, 'file')))

  return { enriched, totalResidential: eligibleCount }
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

  console.log(`Service-tree AADT enrichment (v2: flow accumulation)`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Hexes: ${hexDirs.length}${PREFIX ? ` (prefix: ${PREFIX})` : ''}`)

  const startTime = Date.now()
  let lastProgress = startTime
  let hexesProcessed = 0
  let hexesEnriched = 0
  let totalSegmentsEnriched = 0
  let totalResidential = 0

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hexId = hexDirs[hi]
    const result = processHex(hexId)

    if (result) {
      hexesEnriched++
      totalSegmentsEnriched += result.enriched
      totalResidential += result.totalResidential
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
}

main()
