/**
 * Audit: aircraft arrow stamp consistency across the whole H3R4 tree.
 *
 * The popup reader hard-fails (HTTP 500) when the `sample_days_by_class`
 * schema metadata disagrees across the arrows loaded for one point, when it
 * is missing, or when its arity ≠ 15 (`engine/source-reader/src/aircraft_v6/
 * mod.rs`, `emission/aircraft/npd/mod.rs`). That gate lives at READ time —
 * the 2026-07-18 partial re-extract left 371 stale cells and the world only
 * learned from a user popup 9 days later. This audit is the PUBLISH-time
 * twin: after any aircraft extraction run, every `airborne.arrow` /
 * `airport_traffic.arrow` in the tree must carry ONE well-formed stamp per
 * file kind, or the run fails loudly here, not in a popup.
 * (`cruise.arrow` carries no stamp by design — the reader's gate chains
 * airborne ∪ airport_traffic only.)
 *
 * Reads only each file's first MiB: the schema message (and with it the
 * stamp) always lives there — full-file reads would move ~315 GiB to extract
 * the same strings.
 *
 * Exit 0 = consistent. Exit 1 = mixed / missing / malformed stamps or zero
 * files found. Exit 3 = I/O damage (unreadable file, bad magic).
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/audit-aircraft-stamps.ts
 *   DATA_YEAR=2026 npx tsx pipeline/audit-aircraft-stamps.ts --quiet
 */

import { readdirSync, existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RecordBatchReader } from 'apache-arrow'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const H3R4_DIR = process.env.H3R4_DIR
  ? resolve(REPO_ROOT, process.env.H3R4_DIR) // env may be repo-relative (run-aircraft-extract.sh)
  : resolve(REPO_ROOT, `data/prepared/${YEAR}/h3r4`)
const KINDS = ['airborne.arrow', 'airport_traffic.arrow'] as const
const STAMP_KEY = 'sample_days_by_class'
const STAMP_ARITY = 15
const QUIET = process.argv.includes('--quiet')

/** Exact footer schema-metadata read (no batch decode, no size limits). */
async function stampOf(path: string): Promise<string | undefined> {
  const fh = await open(path, 'r')
  try {
    const reader = await RecordBatchReader.from(fh)
    await reader.open()
    const md: Map<string, string> | undefined = reader.schema?.metadata
    return md?.get(STAMP_KEY)
  } finally {
    await fh.close()
  }
}

async function main() {
  if (!existsSync(H3R4_DIR)) {
    console.error(`H3R4_DIR does not exist: ${H3R4_DIR}`)
    process.exit(3)
  }
  const hexes = readdirSync(H3R4_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  console.log(`Scanning ${hexes.length} hex dirs in ${H3R4_DIR}`)

  const present: Record<string, number> = {}
  const stampCells = new Map<string, string[]>() // ONE global stamp across both kinds (the reader chains them into one accumulator)
  const missingStamp: string[] = []
  const malformed: string[] = []
  let ioErrors = 0

  for (const [hi, hex] of hexes.entries()) {
    if (!QUIET && hi % 10000 === 0 && hi > 0) console.log(`  ${hi}/${hexes.length}…`)
    for (const kind of KINDS) {
      const p = resolve(H3R4_DIR, hex, kind)
      if (!existsSync(p)) continue
      present[kind] = (present[kind] ?? 0) + 1
      let stamp: string | undefined
      try {
        stamp = await stampOf(p)
      } catch (e) {
        console.error(`IO-ERROR ${hex}/${kind}: ${e}`)
        ioErrors++
        continue
      }
      if (stamp === undefined) {
        missingStamp.push(`${hex}/${kind}`)
        continue
      }
      if (stamp.split(',').length !== STAMP_ARITY) {
        malformed.push(`${hex}/${kind} arity=${stamp.split(',').length}`)
        continue
      }
      const cells = stampCells.get(stamp) ?? []
      cells.push(`${hex}/${kind}`)
      stampCells.set(stamp, cells)
    }
  }

  console.log(`\nFiles present: ${KINDS.map((k) => `${k}=${present[k] ?? 0}`).join(', ')}`)
  for (const kind of KINDS) {
    if ((present[kind] ?? 0) === 0) {
      console.error(`FAIL: zero ${kind} files found — wrong tree (${H3R4_DIR})?`)
      process.exit(1)
    }
  }
  if (missingStamp.length > 0) {
    console.error(`\nFAIL: ${missingStamp.length} files LACK the ${STAMP_KEY} stamp (first 10):`)
    for (const f of missingStamp.slice(0, 10)) console.error(`  ${f}`)
  }
  if (malformed.length > 0) {
    console.error(`\nFAIL: ${malformed.length} files with stamp arity ≠ ${STAMP_ARITY} (first 10):`)
    for (const f of malformed.slice(0, 10)) console.error(`  ${f}`)
  }

  const stampsSorted = [...stampCells.entries()].sort((a, b) => b[1].length - a[1].length)
  const mixed = stampCells.size > 1
  if (!mixed) {
    console.log(`stamps: OK (1 distinct global stamp)`)
  } else {
    console.error(`\nMIXED — ${stampCells.size} distinct global stamps:`)
    for (const [stamp, cells] of stampsSorted) {
      console.error(`  "${stamp}" × ${cells.length} files${cells.length <= 10 ? `: ${cells.join(', ')}` : ` (first 10: ${cells.slice(0, 10).join(', ')})`}`)
    }
  }

  if (ioErrors > 0) {
    console.error(`\n${ioErrors} unreadable files`)
    process.exit(3)
  }
  if (mixed || missingStamp.length > 0 || malformed.length > 0) {
    console.error('\nFAIL: aircraft stamps not publishable — re-extract / re-merge / restamp before publishing.')
    process.exit(1)
  }
  console.log('\nOK: aircraft stamps consistent worldwide')
}

main().catch((e) => { console.error(e); process.exit(3) })
