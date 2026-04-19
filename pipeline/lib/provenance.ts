/**
 * Write-side helpers for dataset provenance on enrichment scripts.
 *
 * Two storage paths:
 *  - Arrow files (roads, railways, buildings, industrial):
 *    - `shouldOverwrite()` / `updateRow()` gate the whole-row update (payload + id together).
 *    - `withArrowWrite()` wraps read-modify-write with `flock + tmp + rename`.
 *  - `nace-lookup.json` side-file (industrial):
 *    - `withNaceLookupLock()` is a BATCH wrapper: lock once, read once, apply N decisions
 *      in memory, write once, unlock. Per-row flock would be O(N) I/O.
 *
 * Callers declare their dataset id at the top of the script and pass the helper
 * a callback that writes the value columns only if the helper decided to overwrite.
 */

import { promises as fs } from 'node:fs'
import { tableFromIPC, tableToIPC, type Table } from 'apache-arrow'
import { DATASETS_BY_ID } from './enrichment-datasets.js'

// ═══════════════════════════════════════════════════════════════════════════
// Priority-based overwrite decision
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns true if `selfId` should win over the `existingId` already in this row.
 *
 * Rules (in order):
 *   - empty slot (existing=0) → overwrite
 *   - idempotent re-run (existing=self) → overwrite (safe — same data source)
 *   - unknown id in registry → overwrite (defensive: treat as legacy)
 *   - strict priority comparison
 *   - tie on priority → higher id wins (deterministic, order-independent)
 */
export function shouldOverwrite(existingId: number, selfId: number): boolean {
  if (existingId === 0 || existingId === selfId) return true
  const existing = DATASETS_BY_ID.get(existingId)
  const self = DATASETS_BY_ID.get(selfId)
  if (!existing || !self) return true
  if (self.priority !== existing.priority) return self.priority > existing.priority
  return self.id > existing.id
}

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

// ═══════════════════════════════════════════════════════════════════════════
// Concurrent-safe write wrappers
// ═══════════════════════════════════════════════════════════════════════════

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
 * If the callback returns the same `Table` reference, a fresh `tableToIPC` is
 * still emitted (Arrow has no in-place mutation — arrays are rebuilt externally).
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
    await fs.writeFile(tmpPath, Buffer.from(tableToIPC(output, 'file')))
    await fs.rename(tmpPath, arrowPath)
  } finally {
    await releaseLock(lockPath)
  }
}

/**
 * Industrial side-file wrapper. Acquires the lock ONCE for the whole script body,
 * hands the mutable lookup dictionary to the callback, writes + releases at end.
 * The caller iterates its own records inside `fn` and mutates `lookup` freely;
 * there is no per-entry helper because that would force O(N) file I/O.
 *
 * The caller is responsible for deciding per entry via `shouldOverwrite()` against
 * the entry's existing `dataset_id` (see usage examples in the plan §3).
 */
export async function withNaceLookupLock<T = void>(
  lookupPath: string,
  fn: (lookup: Record<string, Record<string, unknown>>) => Promise<T> | T,
): Promise<T> {
  const lockPath = `${lookupPath}.lock`
  const tmpPath = `${lookupPath}.tmp`
  await acquireLock(lockPath)
  try {
    let parsed: Record<string, Record<string, unknown>>
    try {
      const raw = await fs.readFile(lookupPath, 'utf8')
      parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        parsed = {}
      } else {
        throw err
      }
    }
    const result = await fn(parsed)
    await fs.writeFile(tmpPath, JSON.stringify(parsed, null, 2))
    await fs.rename(tmpPath, lookupPath)
    return result
  } finally {
    await releaseLock(lockPath)
  }
}
