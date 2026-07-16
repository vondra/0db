/**
 * Driver-level tests for `enrichRailwaysByGraphWalk` (rail-walk-enrich.ts).
 * `rail-graph.ts`/`rail-graph-metrics.ts` already lock the pure topology and
 * routing invariants (T-junction healing, Dijkstra, ambiguity, parallel
 * spread, the 2026-07-16 Step-B quarantine ellipse) — these tests exercise
 * the I/O DRIVER built on top: cross-hex stitching, the enableDestructive
 * gate, quarantine-gated retract/silent withholding, the bleed-gate
 * retract arm (item 1: explicit `bleedGate`, never `countryGate`), and the
 * rail-stops sidecar.
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

// ── (d) a DISCONNECTED pair takes endpoint-radius BALLS around both snapped
// ends (item 4 review round: its trains exist, the graph is broken between
// the stations — an empty ellipse would hand live lines to the silent
// residual). Both tiny components here sit entirely inside the pair's own
// bound (~292 km, from the ~116 km chord), so silent and retract are fully
// withheld — see rail-graph-metrics.test.ts for the ball's outer limit and
// the ambiguous-only ellipse. ───────────────────────────────────────────────

test('a disconnected pair\'s endpoint balls withhold silent+retract near both stations — stamps only, and the taxonomy/km numbers are exact', async () => {
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
  assert.equal(stats.silentStamped, 0, 'both tiny components sit entirely inside the endpoint balls — no silent even though otherwise eligible')
  assert.equal(stats.retracted, 0, 'row2 legacy stamp survives — it sits inside E\'s ball')
  assert.equal(stats.walk.failures.disconnected, 1)
  assert.equal(stats.walk.failedComponentCount, 2, 'both endpoints\' components are flagged (stats only now)')

  const expectedKm = (segLengthM(rowEF) + segLengthM(rowFG) + segLengthM(rowFH) + segLengthM(rowPQ)) / 1000
  assert.ok(
    Math.abs(stats.perComponentFailedKm - expectedKm) < 1e-6,
    `perComponentFailedKm ${stats.perComponentFailedKm} ~= ${expectedKm} (deprecated comparison figure)`,
  )
  assert.ok(
    Math.abs(stats.quarantinedKm - expectedKm) < 1e-6,
    `quarantinedKm ${stats.quarantinedKm} ~= ${expectedKm} — the endpoint balls sweep both tiny components in full here`,
  )

  const c = readCols(resolve(h3r4Dir, HEX_A, 'railways.arrow'))
  assert.equal(c.src(0), 0, 'row0 (E-F) unstamped baseline, untouched')
  assert.equal(c.src(1), 0, 'row1 (F-G) unstamped baseline, untouched')
  assert.equal(c.src(2), 999, 'row2 (F-H) legacy stamp survives untouched — a live-but-unroutable line must not go silent at 2+1/day')
  assert.equal(c.pax(2), 15)
  assert.equal(c.frt(2), 3)
})

// ── (d2) an AMBIGUOUS pair (the ONE failure kind that takes the
// admissible-path ellipse — item 4 + review round) withholds silent inside
// that region but not on a dead-end tail past the distA+distB bound —
// exactly the property `failedComponents` could never express, since the
// whole component would have withheld silent everywhere. ────────────────────

test('an ambiguous pair\'s admissible-path ellipse withholds silent inside it — a dead-end tail past the sum bound still gets silently stamped', async () => {
  const h3r4Dir = freshScopeDir('quarantine-ellipse-vs-far-branch')
  // Same geometry as rail-graph-metrics.test.ts's ellipse test: two disjoint
  // similar-length corridors A-N-B / A-S-B (~7.49 km each; chord ~7.16 km ->
  // bound ~19.89 km) fail 'ambiguous'; A also anchors a two-hop dead-end tail
  // running WEST, opposite B. tail1 qualifies through its A endpoint
  // (distA 0 + distB ~7.49 km <= bound); tail2's endpoints both bust the sum
  // (~21.5 km) — OUTSIDE the ellipse, silent applies there.
  const rowAN = { startLat: 50.000, startLon: 14.000, endLat: 50.010, endLon: 14.050 }
  const rowNB = { startLat: 50.010, startLon: 14.050, endLat: 50.000, endLon: 14.100 }
  const rowAS = { startLat: 50.000, startLon: 14.000, endLat: 49.990, endLon: 14.050 }
  const rowSB = { startLat: 49.990, startLon: 14.050, endLat: 50.000, endLon: 14.100 }
  const rowTail1 = { startLat: 50.000, startLon: 14.000, endLat: 50.000, endLon: 13.902 }
  const rowTail2 = { startLat: 50.000, startLon: 13.902, endLat: 50.000, endLon: 13.804 }
  putHex(h3r4Dir, HEX_A, [rowAN, rowNB, rowAS, rowSB, rowTail1, rowTail2])

  const stats = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    pairs: [{ fromLat: 50.000, fromLon: 14.000, toLat: 50.000, toLon: 14.100, pax: 5, frt: 0 }],
    sourceId: STAMP_ID,
    silentResidual: { sourceId: GLOBAL_GTFS_ID, pax: 2, frt: 1 },
    retractSafe: true,
    enableDestructive: true,
    sidecar: { scope: 'quarantine-ellipse-vs-far-branch-scope', extractFingerprint: 'fp-far', feeds: [] },
  })

  assert.equal(stats.walk.failures.ambiguous, 1)
  assert.equal(stats.silentStamped, 1, 'only rowTail2 (outside the ellipse) is silent-eligible — the OLD component-wide gate would have withheld it too')

  const c = readCols(resolve(h3r4Dir, HEX_A, 'railways.arrow'))
  assert.equal(c.src(0), 0, 'row0 (A-N) — an admissible corridor, inside the ellipse')
  assert.equal(c.src(1), 0, 'row1 (N-B) — inside the ellipse')
  assert.equal(c.src(2), 0, 'row2 (A-S) — the competing corridor, inside the ellipse')
  assert.equal(c.src(3), 0, 'row3 (S-B) — inside the ellipse')
  assert.equal(c.src(4), 0, 'row4 (tail1) — qualifies through its A endpoint (min over the edge\'s two endpoints)')
  assert.equal(c.src(5), GLOBAL_GTFS_ID, 'row5 (tail2) — OUTSIDE the ellipse: silent applies even though it shares a component with the failed pair')
})

// ── (e) bleed-gate retract arm (item 1): requires enableDestructive=true, ───
// but bypasses retractSafe/quarantine health WITHIN a destructive run
// (2026-07-16 /gg review item 3 — `enableDestructive` gates the retract
// object as a WHOLE). The arm runs ONLY when an explicit `bleedGate` is
// provided — a nationally-owned id (CZ) passes its own country gate here.

test('bleed retract (explicit bleedGate): fires when enableDestructive=true even with retractSafe=false; a straddler survives', async () => {
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
    bleedGate: gate, // nationally-owned id: its own country gate IS the union of its legitimate territory
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

test('shared-id contract (item 1): countryGate WITHOUT bleedGate never disowns an out-of-gate row — the bleed arm is OFF and the ordinary arm is testimony-bound', async () => {
  // The order-destroying bug this pins: a per-country europe run (CH) whose
  // bbox overlaps a neighbour (southern DE) must NOT disown the SHARED
  // GLOBAL_GTFS_TRANSIT rows the neighbour's own run legitimately stamped —
  // neither via a bleed arm keyed off its own countryGate (bleed is off
  // without an explicit bleedGate) nor via the ordinary retractSafe arm (a
  // run's feeds testify only about the territory inside its countryGate).
  const h3r4Dir = freshScopeDir('shared-id-no-bleed')
  const gate = (_lat: number, lon: number) => lon < 14.05 // "domestic" = west of 14.05
  putHex(h3r4Dir, HEX_A, [
    { startLat: 50.200, startLon: 15.000, endLat: 50.200, endLon: 15.001, sourceId: 999, pax: 20, frt: 4 }, // row0: wholly foreign — a NEIGHBOUR's legitimate stamp under the shared id
    { startLat: 50.201, startLon: 14.000, endLat: 50.201, endLon: 14.001, sourceId: 999, pax: 30, frt: 6 }, // row1: domestic stale stamp — ordinary retract still applies
  ])

  const stats = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    pairs: [], // this run's walk claims nothing — both rows are retract candidates on paper
    sourceId: STAMP_ID,
    countryGate: gate,
    // NO bleedGate — the per-country europe mode contract.
    retract: { sourceIds: [999] },
    retractSafe: true, // even a provably complete snapshot must not reach across the border
    enableDestructive: true,
    sidecar: { scope: 'shared-id-no-bleed-scope', extractFingerprint: 'fp-shared', feeds: [] },
  })

  assert.equal(stats.retracted, 1, 'ONLY the domestic stale row is disowned')
  assert.equal(stats.skippedForeign, 1, 'the foreign row is never offered to match either')

  const c = readCols(resolve(h3r4Dir, HEX_A, 'railways.arrow'))
  assert.equal(c.src(0), 999, 'out-of-gate row of the shared id SURVIVES — foreign healing belongs to the union-gated world mode / heal-rail-country-bleed.ts')
  assert.equal(c.pax(0), 20)
  assert.equal(c.frt(0), 4)
  assert.equal(c.src(1), 0, 'domestic stale row is disowned on ordinary quarantine-free terms — the testimony guard does not blunt in-gate healing')
  assert.equal(c.pax(1), 0)
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
    bleedGate: gate, // even an explicit bleed gate must stay inert in stamp-only
    retract: { sourceIds: [999] },
    retractSafe: true,
    enableDestructive: false, // stamp-only: retract must be entirely suppressed, incl. the bleed + service-arm heals
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

// ── (h) an unlocalized pair quarantines only its own chord vicinity — NOT the
// whole run, and not by component either (2026-07-16 Step-B refinement
// replaced the old global silent-residual suppression: it quarantined every
// clean row in a run behind one unrelated stray pair). ──────────────────────

test('an unlocalized pair (neither end snaps) quarantines only stampable segments within 5 km of its own straight chord — a row far from the chord still gets silently stamped', async () => {
  const h3r4Dir = freshScopeDir('unlocalized-chord-vicinity')
  putHex(h3r4Dir, HEX_A, [
    { startLat: 10.010, startLon: 10.000, endLat: 10.011, endLon: 10.000 }, // row0 — sits ON the pair's own chord, INSIDE the 5 km quarantine radius
    { startLat: 55.000, startLon: 19.000, endLat: 55.001, endLon: 19.000 }, // row1 — thousands of km from the chord, untouched
  ])

  const stats = await enrichRailwaysByGraphWalk({
    h3r4Dir,
    bbox: BBOX,
    // Neither end of this pair is anywhere near either row's own nodes —
    // unlocalizable (both ends fail to snap).
    pairs: [{ fromLat: 10.000, fromLon: 10.000, toLat: 11.000, toLon: 10.000, pax: 5, frt: 0 }],
    sourceId: STAMP_ID,
    silentResidual: { sourceId: GLOBAL_GTFS_ID, pax: 2, frt: 1 },
    retractSafe: true,
    enableDestructive: true,
    sidecar: { scope: 'unlocalized-chord-scope', extractFingerprint: 'fp-h', feeds: [] },
  })

  assert.equal(stats.walk.unlocalizedPairs, 1)
  assert.equal(stats.walk.failedComponentCount, 0, 'nothing snapped — no component to blame either')
  assert.equal(stats.silentStamped, 1, 'only row1 (far from the chord) is silent-eligible — row0 sits inside the 5 km quarantine vicinity')

  const c = readCols(resolve(h3r4Dir, HEX_A, 'railways.arrow'))
  assert.equal(c.src(0), 0, 'row0 quarantined by chord vicinity — stays unstamped')
  assert.equal(c.src(1), GLOBAL_GTFS_ID, 'row1 far from the chord — silently stamped like any other clean row, NOT suppressed by the unrelated unlocalized pair')
})
