// Types for cohort-client.mjs (shape mirrors snapshot-loader.d.mts).
export type ModelCohort = {
  schema_version: 1
  cohort_id: string
  cache_ttl_ms: number
  runtime_sha256: string
  prepared_sha256: string
}

export function validateModelCohort(value: unknown, label: string): ModelCohort

export function fetchModelCohort(opts: {
  server: string
  timeoutMs: number
  label: string
  onResponse?: (response: Response, label: string) => void
}): Promise<ModelCohort>
