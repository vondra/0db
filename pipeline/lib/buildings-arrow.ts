/**
 * The ONE place building enrichment is written — the buildings analogue of
 * `roads-arrow.ts::writeRoadAadt`. Centralizes the rewrite plumbing both
 * `enrich-buildings-{cz,es}.ts` hand-rolled, and closes the two settlement-v2
 * deploy blockers from the /gg phase-2 review:
 *
 *  1. METADATA: buildings.arrow v2 carries the per-file `buildings_contract`
 *     stamp (`osm-extract::finalize`, Convention-B) that the heatmap loader
 *     fail-loud asserts (`heatmap-aircraft::schema_check::
 *     read_surface_arrow_for_r4_with_contract`). A bare `makeTable()` rebuild
 *     drops ALL schema + per-field metadata, so one enrichment run would brick
 *     every touched hex for the next world build. This writer rebuilds the
 *     table under the ORIGINAL schema metadata, field metadata and nullable
 *     flags — correct for v1 arrows too (their empty metadata round-trips).
 *
 *  2. SPECIFICITY: the v2 POI join writes building_type 10-13 (SILENT/HOUSE/
 *     FOOD_RETAIL/HOSPITALITY — `noise-compute::emission::settlement`), each
 *     strictly more specific than any national cadastre's coarse 0-9 mapping
 *     (RÚIAN "rodinný dům" → 0 residential would clobber HOUSE=11). The writer
 *     refuses coarse-over-specific type downgrades; floors from the same match
 *     still apply.
 */

import { Field, RecordBatch, Schema, Table, makeTable, vectorFromArray, Uint8, Uint16 } from 'apache-arrow'
import { shouldOverwrite, withArrowWrite } from './provenance.js'

/** Highest building_type class id shipped by the engine — 13 = HOSPITALITY
 *  (settlement v2 phase 2; `noise-compute::emission::settlement`). A class id
 *  never moves once shipped, so anything above this is a write bug. */
export const MAX_BUILDING_TYPE = 13

/** v2 POI-join classes (10 SILENT, 11 HOUSE, 12 FOOD_RETAIL, 13 HOSPITALITY).
 *  More specific than the coarse 0-9 set — never downgraded by enrichment. */
export const V2_SPECIFIC_TYPE_MIN = 10

/** What one matched cadastre/census record may change on a building row.
 *  Omitted fields keep their current value — an enricher only ever touches
 *  the fields it owns. */
export interface BuildingPatch {
  floors?: number
  buildingType?: number
  sourceId: number
}

/** Read-only view of one building row, handed to the match callback. */
export interface BuildingRow {
  osmId: number | null
  lat: number
  lon: number
  floors: number
  buildingType: number
  /** Fast-exit hint, same contract as `RoadRow.existingSourceId` — the writer
   *  re-applies the priority gate, this only saves matching work. */
  existingSourceId: number
}

export interface WriteBuildingsResult {
  rows: number
  matched: number
  /** Matches whose buildingType would have downgraded a v2 POI-join class
   *  (10-13) to a coarse one — the type part was dropped, floors still applied. */
  typeDowngradesBlocked: number
  updated: boolean
}

/**
 * Seed-from-existing → run `match` per row → apply behind the `shouldOverwrite`
 * priority gate → rebuild ONLY floors/building_type/source_id (all other
 * columns copied verbatim) → atomic 'file'-format write via `withArrowWrite`,
 * preserving schema metadata, per-field metadata and nullable flags. Returns
 * the original table unchanged when nothing matched, so the file stays
 * byte-identical.
 */
export async function writeBuildingEnrichment(
  arrowPath: string,
  match: (row: BuildingRow, i: number) => BuildingPatch | null,
  onApplied?: (row: BuildingRow, i: number, applied: BuildingPatch) => void,
): Promise<WriteBuildingsResult> {
  const result: WriteBuildingsResult = { rows: 0, matched: 0, typeDowngradesBlocked: 0, updated: false }

  await withArrowWrite(arrowPath, (table: Table): Table => {
    const n = table.numRows
    result.rows = n
    if (n === 0) return table

    const clat = table.getChild('centroid_lat')
    const clon = table.getChild('centroid_lon')
    if (!clat || !clon) return table // malformed hex — never touch

    const osmIdCol = table.getChild('osm_id')
    const exFloors = table.getChild('floors')
    const exType = table.getChild('building_type')
    const exSrc = table.getChild('source_id')

    const floors = new Uint8Array(n)
    const btype = new Uint8Array(n)
    const src = new Uint16Array(n)
    for (let i = 0; i < n; i++) {
      floors[i] = (exFloors?.get(i) as number) ?? 0
      btype[i] = (exType?.get(i) as number) ?? 0
      src[i] = (exSrc?.get(i) as number) ?? 0
    }

    let any = false
    for (let i = 0; i < n; i++) {
      const row: BuildingRow = {
        osmId: osmIdCol ? Number(osmIdCol.get(i)) : null,
        lat: clat.get(i) as number,
        lon: clon.get(i) as number,
        floors: floors[i],
        buildingType: btype[i],
        existingSourceId: src[i],
      }
      const m = match(row, i)
      if (!m) continue
      // Fail loud on a malformed patch — TypedArrays silently coerce
      // undefined/NaN to 0, exactly how the IT/SA road zeros slipped through.
      if (
        (m.floors !== undefined && (!Number.isInteger(m.floors) || m.floors < 0 || m.floors > 255)) ||
        (m.buildingType !== undefined &&
          (!Number.isInteger(m.buildingType) || m.buildingType < 0 || m.buildingType > MAX_BUILDING_TYPE)) ||
        !Number.isInteger(m.sourceId) || m.sourceId <= 0
      ) {
        throw new Error(`writeBuildingEnrichment: invalid patch at row ${i} in ${arrowPath}: ${JSON.stringify(m)}`)
      }
      if (!shouldOverwrite(src[i], m.sourceId)) continue // priority gate OWNED here

      // Specificity gate: a coarse class never overwrites a v2 POI-join class.
      let applyType = m.buildingType !== undefined && m.buildingType !== btype[i]
      if (applyType && btype[i] >= V2_SPECIFIC_TYPE_MIN && m.buildingType! < V2_SPECIFIC_TYPE_MIN) {
        applyType = false
        result.typeDowngradesBlocked++
      }
      const applyFloors = m.floors !== undefined && m.floors !== floors[i]
      if (!applyFloors && !applyType) continue // nothing left to write — don't stamp

      if (applyFloors) floors[i] = m.floors!
      if (applyType) btype[i] = m.buildingType!
      src[i] = m.sourceId
      result.matched++
      any = true
      // Report the EFFECTIVE patch — a specificity-blocked type or an
      // unchanged floors value must not show up in caller statistics.
      onApplied?.(row, i, {
        floors: applyFloors ? m.floors : undefined,
        buildingType: applyType ? m.buildingType : undefined,
        sourceId: m.sourceId,
      })
    }
    if (!any) return table // no change → withArrowWrite leaves bytes untouched
    result.updated = true

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- apache-arrow's
    // makeTable/vectorFromArray overloads don't model TypedArray cleanly; same
    // accepted wart as roads-arrow.ts (tsx, no typecheck gate).
    const cols: Record<string, any> = {}
    for (const f of table.schema.fields) {
      if (['floors', 'building_type', 'source_id'].includes(f.name)) continue
      cols[f.name] = table.getChild(f.name)!
    }
    cols['floors'] = vectorFromArray(floors, new Uint8())
    cols['building_type'] = vectorFromArray(btype, new Uint8())
    cols['source_id'] = vectorFromArray(src, new Uint16())

    // makeTable infers a bare schema; rebuild it under the ORIGINAL metadata
    // (the v2 `buildings_contract` stamp lives there), per-field metadata and
    // nullable flags, so the file the heatmap loader gates on round-trips.
    // Batches must be re-bound to the preserved schema — the Table ctor
    // rejects batches whose inner schema differs (makeTable marks copied
    // vectors nullable even when the source field was non-null).
    const fresh = makeTable(cols)
    const fields = fresh.schema.fields.map(f => {
      const orig = table.schema.fields.find(o => o.name === f.name)
      return orig ? new Field(f.name, f.type, orig.nullable, orig.metadata) : f
    })
    const schema = new Schema(fields, table.schema.metadata)
    return new Table(schema, fresh.batches.map(b => new RecordBatch(schema, b.data)))
  })

  return result
}
