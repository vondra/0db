export type CoverageAnchor = {
  id: string
  stable_key: string
  origin: 'point' | 'station'
  network: string | null
  anchor_type: 'measurement' | 'official_map' | 'regression'
  tags: string[]
  pair_id: string | null
}

export type CoverageCell = { points: number; stations: number; networks: string[] }
export type CoverageByType = {
  measurement: CoverageCell
  official_map: CoverageCell
  regression: CoverageCell
}

export type FactorVocabulary = {
  tags: Record<string, { section?: string; unmodelled?: string; [key: string]: unknown }>
  derived: Record<string, unknown>
  interactions?: Array<{ a: string[]; b: string[]; why?: string; requires_ladder?: boolean }>
}

export function derivedCoverageTags(anchor: Record<string, any>, vocab: FactorVocabulary): string[]
export function normalizeCoverageAnchors(points: any[], snapshots: any[], vocab: FactorVocabulary): CoverageAnchor[]
export function summarizeFactorCoverage(anchors: CoverageAnchor[], vocab: FactorVocabulary): Map<string, CoverageByType>
export function summarizePriorityInteractions(
  anchors: CoverageAnchor[],
  vocab: FactorVocabulary,
): Array<{ interaction: NonNullable<FactorVocabulary['interactions']>[number]; hits: CoverageAnchor[] }>
