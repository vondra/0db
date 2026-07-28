/**
 * Hex-level tests for createHexCountryResolver (lib/hex-country.ts) — the
 * writer-path resolver consumed by service-tree. Complements
 * admin-at.test.ts (point-level): these pin the INTERIOR/BORDER decision,
 * because the 2026-07 /gg M2 review showed the point suite can be green
 * while the consumer regresses (an enclave hex classified interior never
 * calls AdminAt; a border sliver through a hex corner fools k=1 centroid
 * agreement).
 *
 * Hermetic: the resolver reads a SYNTHETIC H3ADMIN1 bin written to tmp by
 * this test (the live bin is gitignored data). CGAZ is still required
 * (network test, same as admin-at.test.ts).
 *
 * Run: `cd pipeline && npx tsx --test lib/hex-country.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latLngToCell } from 'h3-js'
import { createHexCountryResolver } from './hex-country.js'

function h3u(hex: string): bigint {
  return BigInt(`0x${hex}`)
}

/** Minimal H3ADMIN1 writer: header (8 B magic) + u32 count + 13 B records. */
function writeSyntheticBin(rows: Array<[string, number, string, number]>): string {
  const buf = Buffer.alloc(12 + rows.length * 13)
  buf.write('H3ADMIN1', 0, 'latin1')
  buf.writeUInt32LE(rows.length, 8)
  rows.forEach(([hex, continent, iso2, city], i) => {
    const off = 12 + i * 13
    buf.writeBigUInt64LE(h3u(hex), off)
    buf.writeUInt8(continent, off + 8)
    buf.writeUInt8(iso2.charCodeAt(0), off + 9)
    buf.writeUInt8(iso2.charCodeAt(1), off + 10)
    buf.writeUInt16LE(city, off + 11)
  })
  const dir = mkdtempSync(join(tmpdir(), 'hex-country-test-'))
  const p = join(dir, 'admin.bin')
  writeFileSync(p, buf)
  return p
}

const VATICAN_HEX = latLngToCell(41.9029, 12.4534, 4)
const SANMARINO_HEX = latLngToCell(43.9424, 12.4578, 4)
const MONACO_HEX = latLngToCell(43.7384, 7.4246, 4)
const LI_HEX = latLngToCell(47.166, 9.512, 4)

const binPath = writeSyntheticBin([
  [VATICAN_HEX, 1, 'IT', 0],
  [SANMARINO_HEX, 1, 'IT', 0],
  [MONACO_HEX, 1, 'FR', 0],
  [LI_HEX, 1, 'CH', 0],
])
const resolver = createHexCountryResolver(binPath)

test('enclave hexes classify border and resolve the enclave country', () => {
  assert.equal(resolver.isBorderHex(VATICAN_HEX), true, 'Vatican hex')
  assert.equal(resolver.isoAt(VATICAN_HEX, 41.9029, 12.4534), 'VA')
  assert.equal(resolver.isBorderHex(SANMARINO_HEX), true, 'San Marino hex')
  assert.equal(resolver.isoAt(SANMARINO_HEX, 43.9424, 12.4578), 'SM')
  assert.equal(resolver.isBorderHex(MONACO_HEX), true, 'Monaco hex')
  assert.equal(resolver.isoAt(MONACO_HEX, 43.7384, 7.4246), 'MC')
})

test('a hex whose land is only partly CH (Liechtenstein sliver) is border', () => {
  assert.equal(resolver.isBorderHex(LI_HEX), true, 'LI/CH sliver hex')
  assert.equal(resolver.isoAt(LI_HEX, 47.166, 9.512), 'LI')
})

test('own-undefined hexes resolve via AdminAt (disputed + islands)', () => {
  assert.equal(resolver.isoAt(latLngToCell(-51.7, -59.0, 4), -51.7, -59.0), 'FK')
  assert.equal(resolver.isoAt(latLngToCell(35.2, 79.5, 4), 35.2, 79.5), 'CN')
  assert.equal(resolver.isoAt(latLngToCell(9.6, 28.4, 4), 9.6, 28.4), 'SD')
  assert.equal(resolver.isoAt(latLngToCell(9.705, 100.017, 4), 9.705, 100.017), 'TH', 'Koh Phangan')
  assert.equal(resolver.isoAt(latLngToCell(1.352, 103.82, 4), 1.352, 103.82), 'SG')
})
