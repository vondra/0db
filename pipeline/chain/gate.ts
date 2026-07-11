//! Chain gate verdict — pure logic over the auditor's MACHINE outputs
//! (--ndjson + --summary-json), separated from run.ts so it is importable by
//! tests (run.ts executes main() on import). The gate is a fingerprint
//! MULTISET diff against pipeline/chain/gate-baseline.json: any fingerprint
//! whose count exceeds the baseline fails the chain (new damage); fingerprints
//! present only in the baseline are reported as resolved. Counting per
//! rule|source alone is lossy — 1 336 old offenders could vanish while 1 200
//! new ones appear in the same bucket and a count diff would pass (/gg Codex
//! CRITICAL) — hence per-row fingerprints.
//!
//! Fail-closed by construction: a signal/null exit, an unexpected exit code,
//! a missing/unparsable summary or NDJSON file, an NDJSON line count that
//! disagrees with the summary grand total, or a baseline written for a
//! different DATA_YEAR/scope are all hard FAILs — never "all resolved".

/** v2 baseline — keyed to the exact run identity. `fingerprints` is a
 *  multiset: fingerprint string → occurrence count. */
export interface GateBaseline {
  dataYear: string
  /** ResolvedScope.canonical of the run that wrote the baseline ("country:CZ"). */
  scope: string
  createdAt: string
  fingerprints: Record<string, number>
}

/** One --ndjson line as the auditor emits it (extra fields like `detail` are
 *  carried but not part of the fingerprint). */
export interface ViolationLine {
  rule: string
  source: string
  hex: string
  osm_id: number | null
  row: number
  lat5: string
  lon5: string
}

/** Machine summary written by the auditor's --summary-json. */
export interface AuditorSummary {
  dataYear: string
  total: number
  counts: Record<string, number>
  ioErrors: number
}

/** Stable per-violation fingerprint — the multiset element. Field set pinned
 *  by the 2026-07-11 /gg consensus: rule|source|hex|osm_id|row|lat5|lon5. */
export function fingerprintOf(v: ViolationLine): string {
  return `${v.rule}|${v.source}|${v.hex}|${v.osm_id ?? '-'}|${v.row}|${v.lat5}|${v.lon5}`
}

/** Parse NDJSON into a fingerprint multiset. Throws on any unparsable line —
 *  a truncated file must fail the gate, not shrink the violation set. */
export function parseNdjsonFingerprints(text: string): { fingerprints: Map<string, number>; lineCount: number } {
  const fingerprints = new Map<string, number>()
  let lineCount = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let v: ViolationLine
    try {
      v = JSON.parse(line) as ViolationLine
    } catch {
      throw new Error(`unparsable NDJSON line ${lineCount + 1}: ${line.slice(0, 120)}`)
    }
    if (typeof v.rule !== 'string' || typeof v.source !== 'string' || typeof v.hex !== 'string') {
      throw new Error(`NDJSON line ${lineCount + 1} missing fingerprint fields: ${line.slice(0, 120)}`)
    }
    lineCount++
    const fp = fingerprintOf(v)
    fingerprints.set(fp, (fingerprints.get(fp) ?? 0) + 1)
  }
  return { fingerprints, lineCount }
}

export function parseSummary(text: string): AuditorSummary {
  const s = JSON.parse(text) as AuditorSummary
  if (typeof s.total !== 'number' || typeof s.counts !== 'object' || s.counts === null) {
    throw new Error('summary JSON missing total/counts')
  }
  return s
}

export interface GateVerdict {
  pass: boolean
  lines: string[]
}

export interface GateInputs {
  /** Child exit code (null on signal) and signal, straight from spawn. */
  code: number | null
  signal: NodeJS.Signals | null
  /** Raw file contents; null = file missing/unreadable. */
  ndjsonText: string | null
  summaryText: string | null
  /** Parsed gate-baseline.json; null = no baseline file. */
  baseline: unknown
  dataYear: string
  /** ResolvedScope.canonical of THIS run. */
  scope: string
}

function isBaselineV2(b: unknown): b is GateBaseline {
  return (
    typeof b === 'object' && b !== null &&
    typeof (b as GateBaseline).dataYear === 'string' &&
    typeof (b as GateBaseline).scope === 'string' &&
    typeof (b as GateBaseline).fingerprints === 'object' && (b as GateBaseline).fingerprints !== null
  )
}

const fail = (lines: string[]): GateVerdict => ({ pass: false, lines })

/** Parse + cross-check the auditor machine outputs. Returns the fingerprint
 *  multiset or a FAIL verdict (never both). */
export function readMachineOutputs(
  inputs: Pick<GateInputs, 'ndjsonText' | 'summaryText'>,
): { fingerprints: Map<string, number>; summary: AuditorSummary } | GateVerdict {
  if (inputs.summaryText === null) return fail(['auditor --summary-json file missing — treating as crash, FAIL'])
  if (inputs.ndjsonText === null) return fail(['auditor --ndjson file missing — treating as crash, FAIL'])
  let summary: AuditorSummary
  try {
    summary = parseSummary(inputs.summaryText)
  } catch (err) {
    return fail([`auditor summary unparsable (${err instanceof Error ? err.message : err}) — FAIL`])
  }
  let parsed: { fingerprints: Map<string, number>; lineCount: number }
  try {
    parsed = parseNdjsonFingerprints(inputs.ndjsonText)
  } catch (err) {
    return fail([`auditor NDJSON unparsable (${err instanceof Error ? err.message : err}) — FAIL`])
  }
  if (parsed.lineCount !== summary.total) {
    return fail([
      `auditor output inconsistent: ${parsed.lineCount} NDJSON line(s) vs summary grand total ${summary.total} — truncated output, FAIL`,
    ])
  }
  return { fingerprints: parsed.fingerprints, summary }
}

/** The gate: crash-safe exit handling + multiset fingerprint diff. */
export function gateVerdict(inputs: GateInputs): GateVerdict {
  if (inputs.signal !== null || inputs.code === null) {
    return fail([`auditor killed by signal ${inputs.signal ?? '(unknown)'} — crash, not a violation report; FAIL`])
  }
  if (inputs.code === 3) {
    return fail(['auditor exit 3: operational I/O error (unreadable arrow / broken extract schema) — not baselineable; FAIL'])
  }
  if (inputs.code !== 0 && inputs.code !== 1) {
    return fail([`auditor exited ${inputs.code} (usage/crash — not a violation report); FAIL`])
  }

  const machine = readMachineOutputs(inputs)
  if ('pass' in machine) return machine
  const { fingerprints, summary } = machine

  if (inputs.code === 0) {
    if (summary.total !== 0) return fail([`auditor exited 0 but summary reports ${summary.total} violation(s) — inconsistent, FAIL`])
    return { pass: true, lines: ['gate CLEAN — no invariant violations'] }
  }

  // exit 1 — violations present; diff the multiset against the baseline.
  if (summary.total === 0) return fail(['auditor exited 1 but reported 0 violations — inconsistent, FAIL'])
  if (inputs.baseline === null) {
    return fail([
      'violations found and NO baseline exists (pipeline/chain/gate-baseline.json)',
      'create one from the current pre-existing state: --update-gate-baseline (review before trusting)',
    ])
  }
  if (!isBaselineV2(inputs.baseline)) {
    return fail(['gate-baseline.json is not fingerprint format v2 — regenerate with --update-gate-baseline for this scope'])
  }
  const baseline = inputs.baseline
  if (baseline.dataYear !== inputs.dataYear) {
    return fail([`baseline is for DATA_YEAR ${baseline.dataYear}, this run is ${inputs.dataYear} — mismatch always fails; re-baseline deliberately`])
  }
  if (baseline.scope !== inputs.scope) {
    return fail([`baseline is for scope '${baseline.scope}', this run is '${inputs.scope}' — a baseline never transfers between scopes`])
  }

  const lines: string[] = []
  let newTotal = 0
  const newFps: Array<[string, number]> = []
  for (const [fp, cur] of fingerprints) {
    const base = baseline.fingerprints[fp] ?? 0
    if (cur > base) {
      newTotal += cur - base
      newFps.push([fp, cur - base])
    }
  }
  let resolvedTotal = 0
  for (const [fp, base] of Object.entries(baseline.fingerprints)) {
    const cur = fingerprints.get(fp) ?? 0
    if (base > cur) resolvedTotal += base - cur
  }

  if (newTotal > 0) {
    lines.push(`${newTotal} NEW violation(s) not in the baseline — FAIL`)
    for (const [fp, extra] of newFps.slice(0, 20)) lines.push(`  NEW ${extra > 1 ? `×${extra} ` : ''}${fp}`)
    if (newFps.length > 20) lines.push(`  … and ${newFps.length - 20} more new fingerprints`)
    if (resolvedTotal > 0) lines.push(`(${resolvedTotal} baseline violation(s) also resolved — moot until the new ones are fixed)`)
    return { pass: false, lines }
  }
  lines.push(`all ${summary.total} violation(s) are pre-existing (baseline ${baseline.scope}, ${baseline.createdAt}) — pass with warning`)
  if (resolvedTotal > 0) lines.push(`note: ${resolvedTotal} baseline violation(s) RESOLVED — refresh via --update-gate-baseline when intentional`)
  return { pass: true, lines }
}

/** Build a v2 baseline from a finished auditor run's machine outputs. Throws
 *  when the outputs are inconsistent (never write a baseline off a crash). */
export function buildBaseline(dataYear: string, scope: string, ndjsonText: string, summaryText: string): GateBaseline {
  const machine = readMachineOutputs({ ndjsonText, summaryText })
  if ('pass' in machine) throw new Error(machine.lines.join('; '))
  return {
    dataYear,
    scope,
    createdAt: new Date().toISOString(),
    fingerprints: Object.fromEntries([...machine.fingerprints.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  }
}
