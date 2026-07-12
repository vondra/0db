// Runtime paths derived from one stable anchor. `src/` and compiled `dist/`
// occupy the same depth below server/, so these resolve identically in both
// execution modes.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DATA_YEAR } from './data-year.js'

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const bundledSourceReader = resolve(import.meta.dirname, 'native/libsource_reader.so')
export const SOURCE_READER_PATH = existsSync(bundledSourceReader) ? bundledSourceReader : resolve(
  REPO_ROOT,
  'engine/source-reader/target/release/libsource_reader.so',
)
export const H3R4_DIR = process.env.H3R4_DIR
  ? resolve(process.env.H3R4_DIR)
  : resolve(REPO_ROOT, 'data', 'prepared', DATA_YEAR, 'h3r4')
