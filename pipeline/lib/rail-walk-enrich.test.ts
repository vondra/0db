/**
 * Driver-level tests for `enrichRailwaysByGraphWalk` (rail-walk-enrich.ts).
 * `rail-graph.ts`/`rail-graph-metrics.ts` already lock the pure topology and
 * routing invariants (T-junction healing, Dijkstra, ambiguity, parallel
 * spread) — these tests exercise the I/O DRIVER built on top: cross-hex
 * stitching, the enableDestructive gate, per-component retract/silent
 * withholding, the country-bleed retract arm, and the rail-stops sidecar.
 *
 * Two real H3 res-4 cells (SPEC reference hexes) are used as directory names
 * so `iterateCountryHexes`'s `cellToLatLng` validity check passes; the
 * segment coordinates inside each fixture are independent of the hex's own
 * geometry (as in production, a hex's `railways.arrow` may hold any segment
 * assigned to it).
 *
 * Run: `cd pipeline && npx tsx --test lib/rail-walk-enrich.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  Table, vectorFromArray, tableFromIPC, tableToIPC,
  Float64, Float32, Int32, Uint8, Uint16, Utf8,
} from 'apache-arrow'
import { enrichRailwaysByGraphWalk } from './rail-walk-enrich.js'

// cz-szcd-gtfs (national-measured) and global-gtfs-transit (continental-measured) —
// both registered `layer: 'railways'` sources (see enrichment-datasets.ts), so
// writeRailTrains's registry-membership check accepts them.
const STAMP_ID = 110
const GLOBAL_GTFS_ID = 100

// Reference hexes (CLAUDE.md "Reference hexes"): Dobříš ~49.865,13.960; Ruzyně
// ~50.141,14.424. Only their VALIDITY as H3 res-4 cells + centroid-in-bbox
// matters here — fixture segment coordinates are chosen independently below.
const HEX_A = '841e309ffffffff'
const HEX_B = '841e355ffffffff'
const BBOX: readonly [number, number, number, number] = [49.0, 13.0, 51.0, 15.0]

const TMP = mkdtempSync(join(tmpdir(), 'rail-walk-enrich-test-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

/** `${TMP}/<name>/prepared/<year>/h3r4` — mirrors the real
 *  `data/prepared/{year}/h3r4` shape so the sidecar's year-from-parent-dir
 *  derivation resolves to a distinctive, assertable value. */
function freshScopeDir(name: string, year = '2099'): string {
  const dir = join(TMP, name, 'prepared', year, 'h3r4')
  mkdirSync(dir, { recursive: true })
  return dir
}

interface FixtureRow {
  startLat: number
  startLon: number
  endLat: number
  endLon: number
  railType?: number
  usage?: number
  service?: number
  name?: string
  ref?: string
  sourceId?: number
  pax?: number
  frt?: number
  divisor?: number
}

/** Flat-earth length (metres) — same formula family as spatial.ts's
 *  flatDist, used only to populate/cross-check the fixture's `length_m`. */
function segLengthM(r: Pick<FixtureRow, 'startLat' | 'startLon' | 'endLat' | 'endLon'>): number {
  const dLat = (r.endLat - r.startLat) * 110_540
  const dLon = (r.endLon - r.startLon) * 111_320 * Math.cos(((r.startLat + r.endLat) / 2) * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLon * dLon)
}

/** A minimal railways.arrow: only the columns rail-walk-enrich.ts and
 *  writeRailTrains actually read (see write_railways.rs for the FULL engine
 *  schema — segment_idx/maxspeed/electrified/gauge/bridge/tunnel/highspeed
 *  are irrelevant to either reader and omitted). */
function writeRailwaysArrowFixture(path: string, rows: FixtureRow[]): void {
  const idx = [...rows.keys()]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous Vector record
  const cols: Record<string, any> = {
    osm_id: vectorFromArray(idx.map(i => 800_000 + i), new Float64()),
    start_lat: vectorFromArray(rows.map(r => r.startLat), new Float64()),
    start_lon: vectorFromArray(rows.map(r => r.startLon), new Float64()),
    end_lat: vectorFromArray(rows.map(r => r.endLat), new Float64()),
    end_lon: vectorFromArray(rows.map(r => r.endLon), new Float64()),
    length_m: vectorFromArray(rows.map(r => segLengthM(r)), new Float32()),
    rail_type: vectorFromArray(rows.map(r => r.railType ?? 0), new Uint8()),
    usage: vectorFromArray(rows.map(r => r.usage ?? 0), new Uint8()),
    name: vectorFromArray(rows.map(r => r.name ?? ''), new Utf8()),
    ref: vectorFromArray(rows.map(r => r.ref ?? ''), new Utf8()),
    service: vectorFromArray(rows.map(r => r.service ?? 0), new Uint8()),
    source_id: vectorFromArray(rows.map(r => r.sourceId ?? 0), new Uint16()),
    trains_passenger: vectorFromArray(rows.map(r => r.pax ?? 0), new Int32()),
    trains_freight: vectorFromArray(rows.map(r => r.frt ?? 0), new Int32()),
    parallel_divisor: vectorFromArray(rows.map(r => r.divisor ?? 1), new Uint8()),
  }
  const table = new Table(cols)
  writeFileSync(path, Buffer.from(tableToIPC(table, 'file')))
}

function putHex(h3r4Dir: string, hexId: string, rows: FixtureRow[]): string {
  const dir = resolve(h3r4Dir, hexId)
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, 'railways.arrow')
  writeRailwaysArrowFixture(path, rows)
  return path
}

function readCols(path: string) {
  const t = tableFromIPC(readFileSync(path))
  return {
    pax: (i: number) => t.getChild('trains_passenger')!.get(i) as number,
    frt: (i: number) => t.getChild('trains_freight')!.get(i) as number,
    src: (i: number) => t.getChild('source_id')!.get(i) as number,
    div: (i: number) => t.getChild('parallel_divisor')!.get(i) as number,
  }
}

// ── (a) two-hex scope: a line crossing the hex boundary, both directions sum ─

test('two-hex scope: line crosses the hex boundary, walk stitches across it, both directions sum, stamps land in both files', async () => {
  const h3r4Dir = freshScopeDir('two-hex')
  putHex(h3r4Dir, HEX_A, [
    { startLat: 50.000, startLon: 14.000, endLat: 50.001, endLon: 14.000 }, // row0: A -> mid1
    { startLat: 50.001, startLon: 14.000, endLat: 50.002, endLon: 14.000 }, // row1: mid1 -> border (shared coord with hex B)
  ])
  putHex(h3r4Dir, HEX_B, [
    { startLat: 50.002, startLon: 14.000, endLat: 50.003, endLon: 14.000 }, // row0: border -> mid2
    { startLat: 50.003, startLon: 14.000, endLat: 50.004, endLon: 14.000 }, // row1: mid2 -> C
  ])

  const stats = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    pairs: [
      { fromLat: 50.000, fromLon: 14.000, toLat: 50.004, toLon: 14.000, pax: 16, frt: 0 },
      { fromLat: 50.004, fromLon: 14.000, toLat: 50.000, toLon: 14.000, pax: 16, frt: 0 }, // reverse direction — must SUM
    ],
    sourceId: STAMP_ID,
    retractSafe: true,
    enableDestructive: false,
    sidecar: { scope: 'two-hex-scope', extractFingerprint: 'fp-a', feeds: ['feedA'] },
  })

  assert.equal(stats.hexes, 2)
  assert.equal(stats.rows, 4)
  assert.equal(stats.stamped, 4, 'all four segments sit on the one shortest path')
  assert.equal(stats.walk.pairsTotal, 1, 'both directions collapse into ONE canonical pair')
  assert.equal(stats.walk.pairsWalked, 1)

  for (const hexId of [HEX_A, HEX_B]) {
    const c = readCols(resolve(h3r4Dir, hexId, 'railways.arrow'))
    for (let i = 0; i < 2; i++) {
      assert.equal(c.pax(i), 32, `${hexId} row ${i} pax summed both directions`)
      assert.equal(c.frt(i), 0)
      assert.equal(c.src(i), STAMP_ID)
    }
  }

  assert.notEqual(stats.sidecarPath, '')
  assert.ok(existsSync(stats.sidecarPath))
  const sidecar = JSON.parse(readFileSync(stats.sidecarPath, 'utf8'))
  assert.equal(sidecar.version, 1)
  assert.equal(sidecar.year, '2099')
  assert.equal(sidecar.scope, 'two-hex-scope')
  assert.deepEqual(sidecar.feeds, ['feedA'])
  assert.equal(sidecar.stops.length, 2, 'both station endpoints, deduped at 4dp')
})

// ── (b) enableDestructive=false: walk stamps (incl. their divisor) land, ────
// retract/silent stay suppressed (2026-07-16 /gg review item 3: divisor
// rides with the atomic write in EVERY mode — "stamp-only" means no retract,
// no silent, never "no divisor").

test('enableDestructive=false: walk stamps land WITH their own divisor; retract/silent stay suppressed', async () => {
  const h3r4Dir = freshScopeDir('no-destructive')
  putHex(h3r4Dir, HEX_A, [
    { startLat: 50.100, startLon: 14.100, endLat: 50.101, endLon: 14.100, divisor: 9 }, // row0 A-B — walked
    { startLat: 50.101, startLon: 14.100, endLat: 50.101, endLon: 14.101, sourceId: 999, pax: 50, frt: 5, divisor: 3 }, // row1 B-D spur, legacy stamp under a retract id
    { startLat: 50.101, startLon: 14.100, endLat: 50.102, endLon: 14.100, divisor: 9 }, // row2 B-C — walked
  ])

  const stats = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    pairs: [{ fromLat: 50.100, fromLon: 14.100, toLat: 50.102, toLon: 14.100, pax: 10, frt: 2 }],
    sourceId: STAMP_ID,
    silentResidual: { sourceId: GLOBAL_GTFS_ID, pax: 2, frt: 1 },
    retract: { sourceIds: [999] },
    retractSafe: true,
    enableDestructive: false, // <- under test
    sidecar: { scope: 'no-destructive-scope', extractFingerprint: 'fp-b', feeds: [] },
  })

  assert.equal(stats.stamped, 2, 'row0 + row2 walked (A-B-C is the only path)')
  assert.equal(stats.silentStamped, 0, 'silent suppressed by enableDestructive=false')
  assert.equal(stats.retracted, 0, 'retract suppressed by enableDestructive=false — no RailRetract object is even built (no countryGate bleed either)')

  const c = readCols(resolve(h3r4Dir, HEX_A, 'railways.arrow'))
  assert.equal(c.src(1), 999, 'legacy stamp untouched')
  assert.equal(c.pax(1), 50)
  assert.equal(c.frt(1), 5)
  assert.equal(c.div(1), 3, 'untouched row keeps its pre-existing divisor byte-for-byte')
  // Divisor rides with the walk stamp in the SAME atomic write regardless of
  // enableDestructive — row0/row2 move from their pre-seeded 9 down to the
  // walk's true divisor (1, no parallel siblings on this simple line) as
  // PART OF the match's own return value, not a separate opt-in pass.
  assert.equal(c.div(0), 1)
  assert.equal(c.div(2), 1)
})

// ── (c) enableDestructive=true, failure-free component ──────────────────────

test('enableDestructive=true + failure-free component: silent residual on the unwalked spur, retract disowns an unreachable legacy stamp, divisor rides with EVERY accepted match (walk AND silent)', async () => {
  const h3r4Dir = freshScopeDir('destructive-clean')
  putHex(h3r4Dir, HEX_A, [
    { startLat: 52.000, startLon: 16.000, endLat: 52.001, endLon: 16.000, divisor: 9 }, // row0 E-F — walked
    { startLat: 52.001, startLon: 16.000, endLat: 52.002, endLon: 16.000, divisor: 9 }, // row1 F-G — walked
    { startLat: 52.001, startLon: 16.000, endLat: 52.001, endLon: 16.001, divisor: 7 }, // row2 F-H spur — unwalked, same failure-free component, NO parallel sibling
    { startLat: 52.010, startLon: 16.010, endLat: 52.011, endLon: 16.010, railType: 1, sourceId: 999, pax: 77, frt: 3, divisor: 4 }, // row3 tram, legacy stamp, outside the graph entirely
  ])

  const stats = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    pairs: [{ fromLat: 52.000, fromLon: 16.000, toLat: 52.002, toLon: 16.000, pax: 10, frt: 2 }],
    sourceId: STAMP_ID,
    silentResidual: { sourceId: GLOBAL_GTFS_ID, pax: 2, frt: 1 },
    retract: { sourceIds: [999] },
    retractSafe: true,
    enableDestructive: true,
    sidecar: { scope: 'destructive-clean-scope', extractFingerprint: 'fp-c', feeds: ['feedC'] },
  })

  assert.equal(stats.stamped, 2, 'row0 + row1 walked')
  assert.equal(stats.silentStamped, 1, 'row2 (unwalked mainline spur, failure-free component)')
  assert.equal(stats.retracted, 1, 'row3 (tram, legacy id, no graph component to withhold on)')

  const c = readCols(resolve(h3r4Dir, HEX_A, 'railways.arrow'))
  assert.equal(c.pax(0), 10); assert.equal(c.frt(0), 2); assert.equal(c.src(0), STAMP_ID)
  assert.equal(c.pax(1), 10); assert.equal(c.frt(1), 2); assert.equal(c.src(1), STAMP_ID)
  assert.equal(c.pax(2), 2); assert.equal(c.frt(2), 1); assert.equal(c.src(2), GLOBAL_GTFS_ID)
  assert.equal(c.pax(3), 0); assert.equal(c.frt(3), 0); assert.equal(c.src(3), 0, 'tram disowned, nothing reclaims it')

  // Divisor: row0/row1 (walked) move from the pre-seeded 9 down to the walk's
  // true divisor (1, no parallel siblings here) as part of the atomic write.
  // row2 (SILENT-stamped, previously "untouched" under the old separate-pass
  // design — the very bug this fix closes) ALSO moves to its true divisor —
  // here 1, since it's a lone spur with no sibling in divisorBySegmentKey
  // either, so its stale pre-seeded 7 is corrected rather than left stale.
  // row3 (retracted) is reset to 1 by writeRailTrains's own divisor-void-on-
  // retract invariant.
  assert.equal(c.div(0), 1)
  assert.equal(c.div(1), 1)
  assert.equal(c.div(2), 1, 'silent-stamped row is corrected too — no sibling recorded for this lone spur, so it rides at divisor 1, not its stale pre-seeded 7')
  assert.equal(c.div(3), 1)
})

// ── (d) a failed pair withholds silent+retract for its WHOLE component ──────

test('component with a failed pair: no silent, no retract there — stamps only, and the taxonomy/km numbers are exact', async () => {
  const h3r4Dir = freshScopeDir('failed-component')
  const rowEF = { startLat: 52.100, startLon: 16.100, endLat: 52.101, endLon: 16.100 } // row0
  const rowFG = { startLat: 52.101, startLon: 16.100, endLat: 52.102, endLon: 16.100 } // row1
  const rowFH = { startLat: 52.101, startLon: 16.100, endLat: 52.101, endLon: 16.101, sourceId: 999, pax: 15, frt: 3 } // row2 spur, legacy stamp
  const rowPQ = { startLat: 53.000, startLon: 17.000, endLat: 53.001, endLon: 17.000 } // row3 — a SEPARATE, disconnected component
  putHex(h3r4Dir, HEX_A, [rowEF, rowFG, rowFH, rowPQ])

  const stats = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    // E (component 1) to Q (component 2): both snap, but no path connects them — 'disconnected'.
    pairs: [{ fromLat: 52.100, fromLon: 16.100, toLat: 53.001, toLon: 17.000, pax: 5, frt: 1 }],
    sourceId: STAMP_ID,
    silentResidual: { sourceId: GLOBAL_GTFS_ID, pax: 2, frt: 1 },
    retract: { sourceIds: [999] },
    retractSafe: true,
    enableDestructive: true,
    sidecar: { scope: 'failed-component-scope', extractFingerprint: 'fp-d', feeds: [] },
  })

  assert.equal(stats.stamped, 0, 'the only pair failed — nothing walked')
  assert.equal(stats.silentStamped, 0, 'component 1 is flagged failed — no silent even though otherwise eligible')
  assert.equal(stats.retracted, 0, 'row2 legacy stamp survives — its component is flagged failed')
  assert.equal(stats.walk.failures.disconnected, 1)
  assert.equal(stats.walk.failedComponentCount, 2, 'both endpoints\' components are flagged')

  const expectedKm = (segLengthM(rowEF) + segLengthM(rowFG) + segLengthM(rowFH) + segLengthM(rowPQ)) / 1000
  assert.ok(
    Math.abs(stats.perComponentFailedKm - expectedKm) < 1e-6,
    `perComponentFailedKm ${stats.perComponentFailedKm} ~= ${expectedKm}`,
  )

  const c = readCols(resolve(h3r4Dir, HEX_A, 'railways.arrow'))
  assert.equal(c.src(0), 0, 'row0 (E-F) unstamped baseline, untouched')
  assert.equal(c.src(1), 0, 'row1 (F-G) unstamped baseline, untouched')
  assert.equal(c.src(2), 999, 'row2 (F-H) legacy stamp survives untouched')
  assert.equal(c.pax(2), 15)
  assert.equal(c.frt(2), 3)
})

// ── (e) country-bleed retract arm: requires enableDestructive=true, but ─────
// bypasses retractSafe/component health WITHIN a destructive run (2026-07-16
// /gg review item 3 — `enableDestructive` now gates the retract object as a
// WHOLE; the old design let the bleed arm fire even in stamp-only, silently
// mutating data in a mode documented as inspection-safe).

test('country-bleed retract: fires when enableDestructive=true even with retractSafe=false; a straddler survives', async () => {
  const h3r4Dir = freshScopeDir('country-bleed')
  const gate = (_lat: number, lon: number) => lon < 14.05 // "domestic" = west of 14.05
  putHex(h3r4Dir, HEX_A, [
    { startLat: 50.200, startLon: 15.000, endLat: 50.200, endLon: 15.001, sourceId: 999, pax: 20, frt: 4 }, // row0: wholly foreign
    { startLat: 50.201, startLon: 14.040, endLat: 50.201, endLon: 15.000, sourceId: 999, pax: 25, frt: 5 }, // row1: straddler (start domestic)
  ])

  const stats = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    pairs: [],
    sourceId: STAMP_ID,
    countryGate: gate,
    retract: { sourceIds: [999] },
    retractSafe: false, // deliberately false — the bleed arm must fire anyway (WITHIN a destructive run)
    enableDestructive: true,
    sidecar: { scope: 'country-bleed-scope', extractFingerprint: 'fp-e', feeds: [] },
  })

  assert.equal(stats.retracted, 1, 'only the wholly-foreign row is disowned')
  assert.equal(stats.skippedForeign, 1, 'row0 never offered to match; row1 straddler is claimable (R9 semantics)')

  const c = readCols(resolve(h3r4Dir, HEX_A, 'railways.arrow'))
  assert.equal(c.src(0), 0, 'wholly-foreign row disowned')
  assert.equal(c.pax(0), 0)
  assert.equal(c.frt(0), 0)
  assert.equal(c.src(1), 999, 'straddler survives — geometry does not condemn it')
  assert.equal(c.pax(1), 25)
})

test('stamp-only (enableDestructive=false): retract is entirely suppressed — foreign-owned and service rows both survive untouched', async () => {
  // The old design let TWO arms inside writeRailTrains mutate data regardless
  // of enableDestructive: the country-bleed heal (row0 here) and the
  // always-on service-arm auto-heal (row1, now reclassified as a siding while
  // still owned by the retract id — writeRailTrains disowns such rows
  // UNCONDITIONALLY whenever a RailRetract object exists, `when` notwithstanding).
  // Both must now survive in stamp-only, since no RailRetract object is even
  // constructed — country-bleed healing there is deferred to
  // heal-rail-country-bleed.ts or the next destructive run.
  const h3r4Dir = freshScopeDir('stamp-only-no-mutate')
  const gate = (_lat: number, lon: number) => lon < 14.05 // "domestic" = west of 14.05
  putHex(h3r4Dir, HEX_A, [
    { startLat: 50.200, startLon: 15.000, endLat: 50.200, endLon: 15.001, sourceId: 999, pax: 20, frt: 4 }, // row0: wholly foreign, owned by a retract id
    { startLat: 50.201, startLon: 14.040, endLat: 50.201, endLon: 14.041, service: 2, sourceId: 999, pax: 30, frt: 6 }, // row1: domestic but now a siding, owned by the SAME retract id
  ])

  const stats = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    pairs: [],
    sourceId: STAMP_ID,
    countryGate: gate,
    retract: { sourceIds: [999] },
    retractSafe: true,
    enableDestructive: false, // stamp-only: retract must be entirely suppressed, incl. the country-bleed + service-arm heals
    sidecar: { scope: 'stamp-only-scope', extractFingerprint: 'fp-f', feeds: [] },
  })

  assert.equal(stats.retracted, 0, 'no RailRetract object is even passed to the writer in stamp-only mode')

  const c = readCols(resolve(h3r4Dir, HEX_A, 'railways.arrow'))
  assert.equal(c.src(0), 999, 'wholly-foreign row survives — country-bleed healing is deferred to heal-rail-country-bleed.ts in stamp-only')
  assert.equal(c.pax(0), 20)
  assert.equal(c.src(1), 999, 'now-service row survives — the always-on service-arm heal is also suppressed in stamp-only')
  assert.equal(c.pax(1), 30)
})

// ── (f) sidecar: never-cache-empty ──────────────────────────────────────────

test('sidecar: not written when zero pair endpoints snap onto the graph', async () => {
  const h3r4Dir = freshScopeDir('sidecar-empty')
  putHex(h3r4Dir, HEX_A, [
    { startLat: 50.300, startLon: 14.300, endLat: 50.301, endLon: 14.300 },
  ])

  const stats = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    pairs: [{ fromLat: 10.0, fromLon: 10.0, toLat: 10.001, toLon: 10.0, pax: 5, frt: 0 }], // nowhere near the graph
    sourceId: STAMP_ID,
    retractSafe: true,
    enableDestructive: false,
    sidecar: { scope: 'empty-scope', extractFingerprint: 'fp-empty', feeds: [] },
  })

  assert.equal(stats.walk.failures.snapFailed, 1)
  assert.equal(stats.sidecarPath, '', 'never-cache-empty: no stops snapped')
  assert.ok(!existsSync(resolve(h3r4Dir, '..', 'rail-stops', 'empty-scope.json')))
})

test('sidecar: a STALE sidecar from an earlier run triggers a loud warning when THIS run snaps zero stops, and is left in place untouched', async (t) => {
  const h3r4Dir = freshScopeDir('sidecar-stale')
  putHex(h3r4Dir, HEX_A, [
    { startLat: 50.400, startLon: 14.400, endLat: 50.401, endLon: 14.400 },
  ])

  // First run: a real pair snaps and writes the sidecar.
  const first = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    pairs: [{ fromLat: 50.400, fromLon: 14.400, toLat: 50.401, toLon: 14.400, pax: 5, frt: 0 }],
    sourceId: STAMP_ID,
    retractSafe: true,
    enableDestructive: false,
    sidecar: { scope: 'stale-scope', extractFingerprint: 'fp-stale-1', feeds: ['feedX'] },
  })
  assert.notEqual(first.sidecarPath, '')
  const sidecarBefore = readFileSync(first.sidecarPath, 'utf8')

  // Second run, SAME scope: this pair snaps onto nothing (e.g. a re-run
  // against a shrunk `pairs` list) — zero stops THIS time, yet the earlier
  // sidecar file from the first run still exists on disk.
  const errors: string[] = []
  t.mock.method(console, 'error', (msg: string) => { errors.push(String(msg)) })

  const second = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    pairs: [{ fromLat: 10.0, fromLon: 10.0, toLat: 10.001, toLon: 10.0, pax: 5, frt: 0 }], // nowhere near the graph
    sourceId: STAMP_ID,
    retractSafe: true,
    enableDestructive: false,
    sidecar: { scope: 'stale-scope', extractFingerprint: 'fp-stale-2', feeds: ['feedX'] },
  })

  assert.equal(second.sidecarPath, '', 'never-cache-empty: this run itself still writes nothing')
  assert.ok(errors.some((e) => e.includes('STALE')), 'a loud warning names the stale sidecar')
  assert.ok(existsSync(first.sidecarPath), 'the earlier sidecar file is NOT deleted')
  assert.equal(readFileSync(first.sidecarPath, 'utf8'), sidecarBefore, 'and is left byte-identical — additive evidence, never auto-invalidated here')
})

// ── (g) silent residual: divisor rides from the graph's own lateral spread ──
// (2026-07-16 /gg review item 3 — the fix for the "silent divisor loss" bug:
// a silent-stamped row with a parallel sibling must render at its true
// divided count, not the engine's undivided default.)

test('silent residual: a sibling-bearing pair of rows (never walked) both get divisor 2 from the graph\'s own lateral spread', async () => {
  const h3r4Dir = freshScopeDir('silent-divisor-siblings')
  const east = 18.000 + 8 / (111_320 * Math.cos(54 * Math.PI / 180)) // ~8 m east — genuine double-track spacing
  putHex(h3r4Dir, HEX_A, [
    { startLat: 54.000, startLon: 18.000, endLat: 54.001, endLon: 18.000 }, // row0
    { startLat: 54.000, startLon: east, endLat: 54.001, endLon: east },     // row1 — lateral sibling of row0
  ])

  const stats = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    pairs: [], // neither row is ever walked
    sourceId: STAMP_ID,
    silentResidual: { sourceId: GLOBAL_GTFS_ID, pax: 2, frt: 1 },
    retractSafe: true,
    enableDestructive: true,
    sidecar: { scope: 'silent-divisor-siblings-scope', extractFingerprint: 'fp-g', feeds: [] },
  })

  assert.equal(stats.stamped, 0, 'nothing walked — pairs is empty')
  assert.equal(stats.silentStamped, 2, 'both rows are eligible — nothing ever failed, so every component is failure-free')

  const c = readCols(resolve(h3r4Dir, HEX_A, 'railways.arrow'))
  assert.equal(c.src(0), GLOBAL_GTFS_ID); assert.equal(c.pax(0), 2); assert.equal(c.frt(0), 1)
  assert.equal(c.src(1), GLOBAL_GTFS_ID); assert.equal(c.pax(1), 2); assert.equal(c.frt(1), 1)
  assert.equal(c.div(0), 2, 'divisor comes from divisorBySegmentKey — recorded for sibling-bearing rows independent of whether the WALK ever stamped them')
  assert.equal(c.div(1), 2)
})

test('second identical run over unchanged silent-eligible siblings is a byte-no-op (divisor preserved, not re-touched)', async () => {
  const h3r4Dir = freshScopeDir('idempotent-silent-rerun')
  const east = 18.000 + 8 / (111_320 * Math.cos(54 * Math.PI / 180))
  putHex(h3r4Dir, HEX_A, [
    { startLat: 54.000, startLon: 18.000, endLat: 54.001, endLon: 18.000 },
    { startLat: 54.000, startLon: east, endLat: 54.001, endLon: east },
  ])
  const path = resolve(h3r4Dir, HEX_A, 'railways.arrow')

  const opts = {
    h3r4Dir, bbox: BBOX, pairs: [],
    sourceId: STAMP_ID,
    silentResidual: { sourceId: GLOBAL_GTFS_ID, pax: 2, frt: 1 },
    retractSafe: true,
    enableDestructive: true,
    sidecar: { scope: 'idempotent-silent-scope', extractFingerprint: 'fp-idem', feeds: [] },
  }

  const stats1 = await enrichRailwaysByGraphWalk(opts)
  assert.equal(stats1.silentStamped, 2)
  const afterFirstRun = readFileSync(path)

  const stats2 = await enrichRailwaysByGraphWalk(opts)
  assert.equal(stats2.silentStamped, 2, 'accepted-ness contract: still counts as a match even though nothing changed')
  const afterSecondRun = readFileSync(path)
  assert.deepEqual(afterSecondRun, afterFirstRun, 'byte-identical re-run: divisor + stamp already correct, no rewrite')
})

// ── (h) unlocalized pairs suppress the silent residual GLOBALLY, not per-
// component (2026-07-16 /gg review item 4) ─────────────────────────────────

test('a globally unlocalized pair (neither end snaps) suppresses the silent residual for the WHOLE run, even on an otherwise-clean component', async () => {
  const h3r4Dir = freshScopeDir('unlocalized-suppresses-silent')
  putHex(h3r4Dir, HEX_A, [
    { startLat: 55.000, startLon: 19.000, endLat: 55.001, endLon: 19.000 }, // row0 — its own component is never individually flagged
  ])

  const stats = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    // Neither end of this pair is anywhere near the graph — unlocalizable.
    pairs: [{ fromLat: 10.000, fromLon: 10.000, toLat: 11.000, toLon: 10.000, pax: 5, frt: 0 }],
    sourceId: STAMP_ID,
    silentResidual: { sourceId: GLOBAL_GTFS_ID, pax: 2, frt: 1 },
    retractSafe: true,
    enableDestructive: true,
    sidecar: { scope: 'unlocalized-scope', extractFingerprint: 'fp-h', feeds: [] },
  })

  assert.equal(stats.walk.unlocalizedPairs, 1)
  assert.equal(stats.walk.failedComponentCount, 0, 'row0\'s own component is never individually flagged failed')
  assert.equal(stats.silentStamped, 0, 'silent is suppressed GLOBALLY by the unlocalized pair, not per-component')

  const c = readCols(resolve(h3r4Dir, HEX_A, 'railways.arrow'))
  assert.equal(c.src(0), 0, 'row0 stays unstamped — an unlocatable pair could have belonged to its component')
})
