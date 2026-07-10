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
import { Field, RecordBatch, Schema, Table, tableFromIPC, tableToIPC } from 'apache-arrow'
import { shouldOverwrite } from './sources.js'

/** Schema-metadata key of the per-batch bbox list written by the extractors
 *  (engine/arrow-batching). Valid ONLY while batch boundaries and row count
 *  match what the extractor wrote — see preserveArrowShape. */
const QM_BATCH_BBOXES_KEY = 'qm_batch_bboxes'

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
    const normalized = preserveArrowShape(input, output)
    await fs.writeFile(tmpPath, Buffer.from(tableToIPC(normalized, 'file')))
    await fs.rename(tmpPath, arrowPath)
  } finally {
    await releaseLock(lockPath)
  }
}

/**
 * Re-impose the INPUT file's schema metadata, per-field flags and — when the
 * row count is unchanged — record-batch boundaries on the callback's output.
 *
 * Callbacks rebuild tables via bare `makeTable()`, which silently drops schema
 * metadata (bricking contract-gated files: `buildings_contract` aborts the
 * heatmap loader) and collapses record batches (invalidating the extractors'
 * `qm_batch_bboxes` popup-pruning metadata). Centralized HERE so no enricher
 * can forget it — the same class of fix `buildings-arrow.ts` carries locally.
 * A callback that deliberately sets metadata still wins (output keys override
 * input keys).
 *
 * `qm_batch_bboxes` is kept ONLY when row count AND final batch count match
 * the input — bboxes describe exact row/batch positions, so any reshape makes
 * them stale, and a stale value must be deleted, never carried (the reader's
 * count-guard would miss a same-count-different-rows lie).
 */
function preserveArrowShape(input: Table, output: Table): Table {
  const metadata = new Map(input.schema.metadata)
  for (const [k, v] of output.schema.metadata) metadata.set(k, v)

  const fields = output.schema.fields.map(f => {
    const orig = input.schema.fields.find(o => o.name === f.name)
    return orig ? new Field(f.name, f.type, orig.nullable, orig.metadata) : f
  })

  // Restore the input's batch boundaries when the callback reshaped them
  // (value-only patches keep row order, so the original chunking is exact).
  // Boundary equality must compare per-batch ROW COUNTS, not just the batch
  // count — same-count-different-boundaries would silently misalign the
  // bbox↔batch mapping (Gemini /gg 2026-07-10).
  const boundariesMatch = (batches: readonly RecordBatch[]): boolean =>
    batches.length === input.batches.length &&
    input.batches.every((b, i) => b.numRows === batches[i].numRows)

  let batches = output.batches
  if (output.numRows === input.numRows && input.batches.length > 1 && !boundariesMatch(batches)) {
    const resliced: RecordBatch[] = []
    let offset = 0
    for (const b of input.batches) {
      const part = output.slice(offset, offset + b.numRows)
      if (part.batches.length !== 1) { resliced.length = 0; break }
      resliced.push(part.batches[0])
      offset += b.numRows
    }
    if (resliced.length === input.batches.length) batches = resliced
  }

  const shapePreserved = output.numRows === input.numRows && boundariesMatch(batches)
  if (!shapePreserved) metadata.delete(QM_BATCH_BBOXES_KEY)

  const schema = new Schema(fields, metadata)
  return new Table(schema, batches.map(b => new RecordBatch(schema, b.data)))
}

