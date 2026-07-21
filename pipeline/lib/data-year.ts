import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Dataset year — ONE source of truth: the DATA_YEAR env var overrides, else
// the committed ./DATA_YEAR file at the repo root. Enrichment scripts import
// this instead of hardcoding a year fallback (a bare `npx tsx pipeline/…`
// then always tracks the committed year).
export const DATA_YEAR: string =
  process.env.DATA_YEAR ||
  JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'scripts', 'dataset-year.json'), 'utf-8')).current_year
