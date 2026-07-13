export type ComparisonVerdict = 'above' | 'within_bound' | 'below' | 'unattributable' | 'trend_only' | 'error'
export type ComparisonResult = { delta_db: number | null; verdict: ComparisonVerdict }

/** Explicit model-vs-measurement comparison for reports and artifact readers. */
export function classifyComparison(
  mode: 'two_sided' | 'upper_bound' | 'trend_only',
  toleranceDb: number | null,
  measured: number | null | undefined,
  model: number | null | undefined,
): ComparisonResult {
  if (typeof measured !== 'number' || !Number.isFinite(measured)
    || typeof model !== 'number' || !Number.isFinite(model)) return { delta_db: null, verdict: 'error' }
  if (mode === 'trend_only') return { delta_db: null, verdict: 'trend_only' }
  if (typeof toleranceDb !== 'number' || !Number.isFinite(toleranceDb) || toleranceDb < 0) {
    throw new Error(`${mode} comparison requires a non-negative tolerance`)
  }
  const delta = Math.round((model - measured) * 1e12) / 1e12
  if (delta > toleranceDb) return { delta_db: delta, verdict: 'above' }
  if (delta >= -toleranceDb) return { delta_db: delta, verdict: 'within_bound' }
  return { delta_db: delta, verdict: mode === 'upper_bound' ? 'unattributable' : 'below' }
}
