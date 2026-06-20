/**
 * Write-side helpers for dataset provenance on enrichment scripts.
 *
 * All enrichment layers (roads, railways, buildings, industrial) now live in
 * per-hex Arrow files:
 *  - `shouldOverwrite()` / `updateRow()` gate the whole-row update (payload + id together).
 *  - `withArrowWrite()` wraps read-modify-write with `flock + tmp + rename`.
 *
 * Callers declare their dataset id at the top of the script and pass the helper
 * a callback that writes the value columns only if the helper decided to overwrite.
 */

import { promises as fs } from 'node:fs'
import { tableFromIPC, tableToIPC, type Table } from 'apache-arrow'
import { shouldOverwrite } from './sources.js'

// Overwrite decision (re-exported from sources.ts for a stable call site)

/**
 * Gate for enricher writes. Returns true if `selfId` should win over the
 * row's current `existingId`. See `./sources.ts::shouldOverwrite` for the
 * full rule list (provenance rank → year → id tiebreaks, with idempotent
 * and empty-slot early returns).
 *
 * Kept here as a re-export so existing callers
 * (`import { shouldOverwrite } from './lib/provenance.js'`) are unchanged.
 */
export { shouldOverwrite }

/**
 * Gates a row update: writes payload + provenance atomically only if self wins.
 * Returns true if the row was updated.
 *
 * Usage:
 *   updateRow(existingIdCol[i], MY_ID, () => {
 *     aadtLight[i] = newLight;
 *     trafficSource[i] = 1;
 *     existingIdCol[i] = MY_ID;
 *   });
 */
export function updateRow(
  existingId: number,
  selfId: number,
  writePayload: () => void,
): boolean {
  if (!shouldOverwrite(existingId, selfId)) return false
  writePayload()
  return true
}

// Concurrent-safe write wrappers

/** Best-effort advisory lock using O_CREAT|O_EXCL on `{path}.lock`. */
async function acquireLock(lockPath: string, timeoutMs = 5 * 60_000): Promise<void> {
  const start = Date.now()
  const pid = `${process.pid}-${Date.now()}`
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.writeFile(lockPath, pid, { flag: 'wx' })
      return
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Lock held — back off 100–400 ms with jitter.
      await new Promise(r => setTimeout(r, 100 + Math.random() * 300))
    }
  }
  throw new Error(`acquireLock timeout on ${lockPath} after ${timeoutMs} ms`)
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath)
  } catch {
    /* best-effort */
  }
}

/**
 * Read Arrow file → mutate via callback → atomic replace.
 * The callback receives the parsed `Table`; returns the updated table to write.
 * **Returning the SAME `Table` reference signals "no change" — the file is left
 * byte-for-byte untouched** (no re-serialize, no rename). This keeps no-op hexes
 * bit-identical, which the refactor-verification relies on; callers that genuinely
 * changed a row must return a freshly-built `Table`.
 */
export async function withArrowWrite(
  arrowPath: string,
  fn: (table: Table) => Table | Promise<Table>,
): Promise<void> {
  const lockPath = `${arrowPath}.lock`
  const tmpPath = `${arrowPath}.tmp`
  await acquireLock(lockPath)
  try {
    const bytes = await fs.readFile(arrowPath)
    const input = tableFromIPC(bytes)
    const output = await fn(input)
    if (output === input) return   // no-op: nothing changed → leave the file untouched
    await fs.writeFile(tmpPath, Buffer.from(tableToIPC(output, 'file')))
    await fs.rename(tmpPath, arrowPath)
  } finally {
    await releaseLock(lockPath)
  }
}

