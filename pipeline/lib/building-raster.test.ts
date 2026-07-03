/**
 * Focused tests for lib/building-raster.ts (task #15).
 * Run: `npx tsx --test pipeline/lib/building-raster.test.ts`
 *
 * Uses a synthetic 11×11 u8 tile (side is derived from file size, same as the
 * engine's RawTile::load) so the tests pin the north-row-0 orientation, window
 * counting, tile-edge clamping and the missing-tile → null/unknown contract
 * without needing the real 13 MB rasters.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BuildingRasterSampler,
  BUILT_UP_UNKNOWN,
  BUILT_UP_RURAL,
  BUILT_UP_URBAN,
  BUILT_UP_MIN_BUILT_PIXELS,
} from './building-raster.ts'

const SIDE = 11 // synthetic tile: 11×11 px over 1°×1° → max index 10

/** Synthetic tile N10E020 (covers lat 10..11, lon 20..21):
 *  - single building pixel at row 1, col 5  (NORTH strip, lat ≈ 10.9)
 *  - 3×3 building block rows 4-6 × cols 4-6 (tile centre, lat ≈ 10.5, lon ≈ 20.5)
 *  - southern half otherwise empty. */
function writeSyntheticTile(dir: string) {
  const buf = Buffer.alloc(SIDE * SIDE, 0)
  buf[1 * SIDE + 5] = 12
  for (let r = 4; r <= 6; r++) for (let c = 4; c <= 6; c++) buf[r * SIDE + c] = 7
  writeFileSync(join(dir, 'N10E020.raw'), buf)
}

test('building-raster sampler', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'building-raster-test-'))
  writeSyntheticTile(dir)
  const sampler = new BuildingRasterSampler(dir)

  await t.test('tile naming uses the SW corner (floor), S/W for negatives', () => {
    assert.equal(BuildingRasterSampler.tileNameFor(49.78, 14.17), 'N49E014')
    assert.equal(BuildingRasterSampler.tileNameFor(53.928, -1.387), 'N53W002')
    assert.equal(BuildingRasterSampler.tileNameFor(-1.5, -0.5), 'S02W001')
  })

  await t.test('row 0 = NORTH edge: the row-1 pixel sits at lat≈10.9, not 10.1', () => {
    // fracLat 0.9 → row round((1-0.9)*10) = 1; col round(0.5*10) = 5.
    assert.equal(sampler.builtPixelCount(10.9, 20.5, 0), 1)
    // Flipped-orientation reading (lat 10.1 → row 9) must see nothing.
    assert.equal(sampler.builtPixelCount(10.1, 20.5, 0), 0)
  })

  await t.test('window counts built pixels around the midpoint', () => {
    assert.equal(sampler.builtPixelCount(10.5, 20.5, 0), 1) // centre of the 3×3 block
    assert.equal(sampler.builtPixelCount(10.5, 20.5, 1), 9) // whole block
    assert.equal(sampler.builtPixelCount(10.5, 20.5, 4), 10) // block + the north pixel
  })

  await t.test('window clamps at tile edges (no wrap, no crash)', () => {
    // NW corner (row 0, col 0): radius 2 window is clamped to 3×3 in-tile px.
    assert.equal(sampler.builtPixelCount(10.999, 20.001, 2), 0)
    // Near-north point: clamped window still reaches the row-1 pixel.
    assert.equal(sampler.builtPixelCount(10.999, 20.5, 2), 1)
  })

  await t.test('missing tile → null count → BUILT_UP_UNKNOWN', () => {
    assert.equal(sampler.builtPixelCount(11.5, 20.5, 3), null) // N11E020 absent
    assert.equal(sampler.classifyBuiltUp(11.5, 20.5), BUILT_UP_UNKNOWN)
  })

  await t.test('classifyBuiltUp applies the calibrated threshold', () => {
    // The 11×11 tile fits inside one calibrated window (radius 8 ≥ tile), so
    // every in-tile point sees all 10 built px ≥ threshold → urban…
    assert.ok(BUILT_UP_MIN_BUILT_PIXELS <= 10, 'synthetic tile must satisfy the threshold')
    assert.equal(sampler.classifyBuiltUp(10.5, 20.5), BUILT_UP_URBAN)
    // …and an all-empty tile is rural everywhere.
    const emptyDir = mkdtempSync(join(tmpdir(), 'building-raster-test-'))
    writeFileSync(join(emptyDir, 'N10E020.raw'), Buffer.alloc(SIDE * SIDE, 0))
    const emptySampler = new BuildingRasterSampler(emptyDir)
    assert.equal(emptySampler.classifyBuiltUp(10.5, 20.5), BUILT_UP_RURAL)
    rmSync(emptyDir, { recursive: true, force: true })
  })

  await t.test('non-square file is treated as missing', () => {
    const badDir = mkdtempSync(join(tmpdir(), 'building-raster-test-'))
    writeFileSync(join(badDir, 'N10E020.raw'), Buffer.alloc(SIDE * SIDE + 1, 1))
    const badSampler = new BuildingRasterSampler(badDir)
    assert.equal(badSampler.builtPixelCount(10.5, 20.5, 1), null)
    rmSync(badDir, { recursive: true, force: true })
  })

  rmSync(dir, { recursive: true, force: true })
})
