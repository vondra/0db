/** Reader for prepared/h3r4-admin.bin — res-4 hex → ISO2 country (the engine's
 *  own receiver-country approximation), shared by the discontinuity auditor and
 *  the enrichment-status report. */

import { existsSync, readFileSync } from 'node:fs'

/** hex(u64 as hex-string, lowercase, no padding trim issues) → ISO2. Record
 *  layout mirrors engine admin.rs::load: 12-byte header, then 13-byte records
 *  [u64 hex LE, u8 continent, 2×u8 ISO chars, u16 city LE]. */
export function readAdminIso(binPath: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(binPath)) return out
  const b = readFileSync(binPath)
  const n = (b.length - 12) / 13
  for (let i = 0; i < n; i++) {
    const off = 12 + i * 13
    const hex = b.readBigUInt64LE(off).toString(16)
    const c1 = b[off + 9]
    const c2 = b[off + 10]
    if (c1 === 0) continue
    out.set(hex, String.fromCharCode(c1, c2))
  }
  return out
}
