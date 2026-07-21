import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Dataset year — ONE source of truth: the DATA_YEAR env var (set via .env /
// systemd) overrides, else the committed scripts/dataset-year.json config.
// Never hardcode a year fallback in route files; import this instead.
export const DATA_YEAR: string =
  process.env.DATA_YEAR ||
  JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'scripts', 'dataset-year.json'), 'utf-8')).current_year
