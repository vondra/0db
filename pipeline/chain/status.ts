//! chain/status.ts — the world-chain run STATUS CONTRACT (#31.6).
//!
//! One `status.json` is written into the run's log dir (and rewritten after
//! every step, so a crashed run still leaves an honest partial record). It is
//! the machine-readable answer to "did this chain run produce data safe to
//! sync / repaint?" — consumed READ-ONLY by:
//!   - the gate-before-sync/repaint decision (never sync off a run whose gate
//!     had ioErrors or whose completeness fell short), and
//!   - the 0db-codex stage-waiter (owns the trigger; reads this, never writes
//!     the chain). This module is the SSOT of the shape; the schema is stable.
//!
//! COMPLETENESS (the #31.6 core): a step that consumes a multi-part feed
//! declares its floor in the manifest (`expectMinInputs`) and REPORTS what it
//! actually loaded via a stdout marker the runner parses:
//!   QM_COMPLETENESS {"actual":2,"state":"partial","detail":"2/36 cities"}
//! `state` ∈ complete | partial | empty-valid | missing. `empty-valid` is a
//! feed that loaded and is legitimately empty (a country with no plants) —
//! distinct from `missing` (file absent) and `partial` (loaded a fragment).
//! The chain gate FAILS a run with any `partial`/`missing` on a floored step
//! (au-vic stamped 369,248 segs from a partial feed and passed — never again).

import { writeFileSync, renameSync } from 'node:fs'

/** Completeness verdict for one feed-consuming step. `expected` is the
 *  manifest floor (0 when the step declares none); `actual` is what the
 *  enricher reported loading. */
export interface StepCompleteness {
  expected: number
  actual: number
  state: 'complete' | 'partial' | 'empty-valid' | 'missing'
  detail?: string
}

/** The runner's per-step record. `completeness` is null for steps that
 *  consume no declared multi-part feed (most national censuses). */
export interface StepStatus {
  id: string
  phase: string
  status: 'done' | 'failed' | 'skipped'
  durationMs: number
  lastLine?: string
  skipReason?: string
  completeness?: StepCompleteness | null
}

/** The gate step's machine verdict, lifted to the top level so a consumer
 *  never has to parse the auditor summary itself. `ioErrors > 0` OR
 *  `newAboveBaseline > 0` means NOT safe to sync/repaint; `total` is the raw
 *  census (large and expected until a world baseline is sealed). */
export interface GateStatus {
  ioErrors: number
  total: number
  newAboveBaseline: number | null
  verdict: 'pass' | 'violations-vs-baseline' | 'census-no-baseline' | 'fail'
}

export interface ChainStatus {
  runId: string
  dataYear: string
  scope: string
  startedAt: string
  finishedAt: string | null
  /** running while in flight; complete = every runnable step done + gate not
   *  failed; failed = a step or the gate failed (the chain returned nonzero). */
  outcome: 'running' | 'complete' | 'failed'
  gate: GateStatus | null
  /** True iff outcome=complete AND gate.ioErrors=0 AND no floored step is
   *  partial/missing. The ONE field a sync/repaint trigger reads. (Whether
   *  NEW violations above a sealed baseline also block is the consumer's
   *  policy — see gate.newAboveBaseline.) */
  safeToSync: boolean
  steps: StepStatus[]
}

const MARKER = 'QM_COMPLETENESS'

/** Parse the LAST `QM_COMPLETENESS {json}` marker a step printed (enrichers
 *  emit one line; the last wins if re-emitted). Returns null when absent or
 *  unparsable — a step that reports nothing has no completeness claim. */
export function parseCompletenessMarker(logText: string): Omit<StepCompleteness, 'expected'> | null {
  let found: Omit<StepCompleteness, 'expected'> | null = null
  for (const line of logText.split('\n')) {
    const i = line.indexOf(MARKER)
    if (i < 0) continue
    try {
      const obj = JSON.parse(line.slice(i + MARKER.length).trim())
      if (typeof obj.actual === 'number' && typeof obj.state === 'string') {
        found = { actual: obj.actual, state: obj.state, detail: obj.detail }
      }
    } catch {
      /* a line that merely mentions the marker word but isn't one — skip */
    }
  }
  return found
}

/** A floored step is unsafe when it loaded short of its floor or its feed was
 *  missing — the #31.6 no-implicit-partial-stamp rule. `empty-valid` and
 *  `complete` are safe; a null completeness (no declared feed) is safe. */
export function stepIsComplete(s: StepStatus): boolean {
  const c = s.completeness
  if (!c) return true
  return c.state === 'complete' || c.state === 'empty-valid'
}

/** Atomic write (tmp + rename) so a reader never sees a half-written file. */
export function writeChainStatus(path: string, status: ChainStatus): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n')
  renameSync(tmp, path)
}
