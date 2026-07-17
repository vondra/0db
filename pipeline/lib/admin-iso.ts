/** Reader for prepared/h3r4-admin.bin — res-4 hex → ISO2 country (the engine's
 *  own receiver-country approximation), shared by the discontinuity auditor and
 *  the enrichment-status report. */

import { existsSync, readFileSync } from 'node:fs'

/** bytes 0-7 magic, 8-11 u32 LE count, then 13-byte records
 *  [u64 hex LE, u8 continent, 2×u8 ISO chars, u16 city LE] — mirrors
 *  engine admin.rs::load and scripts/build-h3-admin.ts. */
const ADMIN_MAGIC = 'H3ADMIN1'
const HEADER_BYTES = 12
const RECORD_BYTES = 13

function parseRecords(b: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  const n = (b.length - HEADER_BYTES) / RECORD_BYTES
  for (let i = 0; i < n; i++) {
    const off = HEADER_BYTES + i * RECORD_BYTES
    const hex = b.readBigUInt64LE(off).toString(16)
    const c1 = b[off + 9]
    const c2 = b[off + 10]
    if (c1 === 0) continue
    out.set(hex, String.fromCharCode(c1, c2))
  }
  return out
}

/** Lenient reader for diagnostics: hex → ISO2, empty map when the file is
 *  missing. Enrichment writers must use requireAdminIso instead. */
export function readAdminIso(binPath: string): Map<string, string> {
  if (!existsSync(binPath)) return new Map()
  return parseRecords(readFileSync(binPath))
}

/** Strict variant for enrichers whose OUTPUT depends on the country lookup
 *  (service-tree national vehicle mix / trip rates). readAdminIso's silent
 *  empty-map fallback is fine for diagnostics, but an enricher running with
 *  it would stamp WORLD defaults over the whole planet without any error —
 *  exactly what happened when the extract built the admin table after the
 *  road passes (/gg Codex CRITICAL). Validates magic + declared count +
 *  exact length (a truncated or foreign file must not half-load), mirroring
 *  the checks engine admin.rs::load performs. Throws with the regeneration
 *  command. */
export function requireAdminIso(binPath: string): Map<string, string> {
  const regen = `Regenerate it: cd scripts && DATA_YEAR=<year> npm run build:h3-admin`
  if (!existsSync(binPath)) {
    throw new Error(`h3r4-admin.bin missing at ${binPath} — country-dependent enrichment must not silently fall back to WORLD defaults. ${regen}`)
  }
  const b = readFileSync(binPath)
  if (b.length < HEADER_BYTES || b.toString('latin1', 0, 8) !== ADMIN_MAGIC) {
    throw new Error(`h3r4-admin.bin at ${binPath} has a bad magic header (corrupt or foreign file). ${regen}`)
  }
  const declared = b.readUInt32LE(8)
  if (b.length !== HEADER_BYTES + declared * RECORD_BYTES) {
    throw new Error(`h3r4-admin.bin at ${binPath} is truncated: header declares ${declared} records but the file holds ${(b.length - HEADER_BYTES) / RECORD_BYTES}. ${regen}`)
  }
  const map = parseRecords(b)
  if (map.size === 0) {
    throw new Error(`h3r4-admin.bin at ${binPath} contains no country records. ${regen}`)
  }
  return map
}
