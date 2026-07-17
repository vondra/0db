/**
 * Fail-closed contract of requireAdminIso: country-dependent enrichment must
 * not run against a missing/empty admin table (it would stamp WORLD defaults
 * planet-wide without an error — /gg Codex CRITICAL, 2026-07).
 *
 * Run: `npx tsx --test pipeline/lib/admin-iso.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readAdminIso, requireAdminIso } from './admin-iso.js'

function adminBin(records: Array<{ hex: bigint; iso: string }>): Buffer {
  const buf = Buffer.alloc(12 + 13 * records.length)
  buf.write('H3ADMIN1', 0, 'latin1')
  buf.writeUInt32LE(records.length, 8)
  records.forEach((r, i) => {
    const off = 12 + i * 13
    buf.writeBigUInt64LE(r.hex, off)
    buf[off + 8] = 1 // continent
    buf[off + 9] = r.iso.charCodeAt(0)
    buf[off + 10] = r.iso.charCodeAt(1)
  })
  return buf
}

test('readAdminIso stays lenient (diagnostics), requireAdminIso validates hard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-iso-'))
  try {
    const missing = join(dir, 'nope.bin')
    assert.equal(readAdminIso(missing).size, 0, 'lenient reader: empty map')
    assert.throws(() => requireAdminIso(missing), /h3r4-admin\.bin missing/)

    // Bad magic (foreign/corrupt file) must not half-load.
    const badMagic = join(dir, 'bad-magic.bin')
    writeFileSync(badMagic, Buffer.alloc(12 + 13))
    assert.throws(() => requireAdminIso(badMagic), /bad magic/)

    // Header declares more records than the file holds → truncated.
    const truncated = join(dir, 'truncated.bin')
    const t = adminBin([{ hex: 0x841e309ffffffffn, iso: 'CZ' }])
    t.writeUInt32LE(5, 8)
    writeFileSync(truncated, t)
    assert.throws(() => requireAdminIso(truncated), /truncated/)

    // Valid header, zero records → as useless as missing.
    const empty = join(dir, 'empty.bin')
    writeFileSync(empty, adminBin([]))
    assert.throws(() => requireAdminIso(empty), /no country records/)

    // One valid record → strict reader returns it.
    const one = join(dir, 'one.bin')
    writeFileSync(one, adminBin([{ hex: 0x841e309ffffffffn, iso: 'CZ' }]))
    assert.equal(requireAdminIso(one).get('841e309ffffffff'), 'CZ')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
