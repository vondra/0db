import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Dataset year — ONE source of truth: the DATA_YEAR env var (set via .env /
// systemd) overrides, else the committed ./DATA_YEAR file at the repo root.
// Never hardcode a year fallback in route files; import this instead.
export const DATA_YEAR: string =
  process.env.DATA_YEAR ||
  readFileSync(resolve(import.meta.dirname, '..', '..', 'DATA_YEAR'), 'utf-8').trim()
