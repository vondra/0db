// Small display helpers shared by DetailPopup. Kept pure — no React, no IO.

/** Formats a signed dB value; always prefixes + for positive numbers. */
export function fmt(v: number): string {
  return v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)
}

/**
 * Lden-style dB value that may be null. Engine emits `f64::NEG_INFINITY`
 * for silent periods (no energy) and serde_json maps non-finite floats to
 * JSON `null`, so any `NoisePeriodsData` field may arrive null at runtime
 * even though the TS type says `number`. Renders "—" for null/undefined,
 * otherwise `12.3 dB`.
 */
export function fmtDb(v: number | null | undefined): string {
  return v == null ? '—' : `${v.toFixed(1)} dB`
}

/** Same null handling as fmtDb but returns just the number — for composing
 *  multi-value strings like "12.3/—/8.7 dB" without unit round-tripping. */
export function fmtDbValue(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(1)
}

/** Generic float formatter that renders "—" for null/undefined. The Rust
 *  side serializes non-finite f64 (e.g. NaN, ±Infinity from divisions over
 *  empty datasets) to JSON null, so any per-flight or per-period count
 *  field can arrive null even when typed `number`. */
export function fmtFloat(v: number | null | undefined, digits = 1): string {
  return v == null ? '—' : v.toFixed(digits)
}

/** Rounds to integer and formats with thousands separators. */
export function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('en-US')
}

/** Compact number formatting: 12 345 → "12k", 1 234 567 → "1.2M". */
export function fmtCompact(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  return Math.round(v).toString()
}

/** "123 m" below 1 km, "1.2 km" above. */
export function formatCpa(m: number): string {
  return m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(1)} km`
}

/** Meters → kilometers, fixed digits, no unit suffix. Use when the unit
 * lives in the column header to keep cell width minimal. */
export function metersToKm(m: number, digits = 2): string {
  return (m / 1000).toFixed(digits)
}

/**
 * Build a 2-column table-like text block for native title= tooltips.
 * Renders with monospace columns: label padded, value right-aligned.
 * Use \n joins for multi-line. Uses U+2500 box-drawing character for separators.
 */
export type TableRow = readonly [string, string] | { sep: true } | string

export function txtTable(rows: TableRow[], labelWidth = 22, valueWidth = 11): string {
  return rows
    .map(r => {
      if (typeof r === 'string') return r
      if ('sep' in r) return '─'.repeat(labelWidth) + '  ' + '─'.repeat(valueWidth)
      const [label, value] = r
      return label.padEnd(labelWidth) + '  ' + value.padStart(valueWidth)
    })
    .join('\n')
}
