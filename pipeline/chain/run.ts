//! R8.1 chain runner — ONE command that re-enriches everything after a fresh
//! OSM planet extract, in manifest order, with the invariant auditor as the
//! acceptance gate. Steps are SPAWNED (never imported — several enrichers run
//! main() on import) sequentially per phase; the chain stops on the first
//! failure and prints a `--from` resume hint.
//!
//! Usage (from pipeline/):
//!   npx tsx chain/run.ts --scope country:CZ --dry-run          # print the plan
//!   npx tsx chain/run.ts --scope country:CZ                    # run everything
//!   npx tsx chain/run.ts --scope bbox:49.7,13.9,50.4,15.0 --phase heuristics
//!   npx tsx chain/run.ts --scope world --from roads-service-tree --plan ../logs/chain/<runId>/plan.json
//!   npx tsx chain/run.ts --inventory                           # survivability table
//!   npx tsx chain/run.ts --scope country:CZ --update-gate-baseline
//!
//! Gate semantics (chain/gate.ts): the auditor emits machine outputs
//! (--ndjson per-violation fingerprints + --summary-json totals); run.ts diffs
//! the fingerprint MULTISET against pipeline/chain/gate-baseline.json — any
//! fingerprint above its baseline count FAILS the chain, resolved ones are
//! noted. The baseline is keyed to DATA_YEAR + exact scope (mismatch = hard
//! fail); crash/signal/exit-3/unparsable output always fail — never "resolved".
//! --update-gate-baseline re-baselines after an intentional heal (review the
//! diff before committing the new file).
//!
//! Completeness (#31.6): a feed step declares expectMinInputs (36 EU cities,
//! 23 GTFS feeds) and prints a QM_COMPLETENESS marker. safeToSync is TRUE only
//! when every floored plan step is not-applicable to the scope or ran-and-met
//! its floor (plannedCompletenessSatisfied) — a --from resume / --phase subset
//! that skipped a floored step certifies FALSE, never blind-true. A WORLD run
//! also FAILS (exit 1) on a short/absent floored step; --allow-partial downgrades
//! that to a warning (dev / narrow scope) but can never make safeToSync true.

import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DATA_YEAR as YEAR } from '../lib/data-year.js'
import { parseScope, type ResolvedScope } from './scope.js'
import { buildPlan, PHASES, PIPELINE_DIR, REPO_ROOT, type Phase, type PlanStep } from './manifest.js'
import { gateVerdict, buildBaseline, type GateVerdict } from './gate.js'
import { runInventory } from './inventory.js'
import {
  writeChainStatus, parseCompletenessMarker, plannedCompletenessSatisfied, stepIsComplete,
  type ChainStatus, type StepStatus, type GateStatus, type FlooredPlanStep,
} from './status.js'

const BASELINE_PATH = resolve(import.meta.dirname, 'gate-baseline.json')
const TSX_BIN = resolve(PIPELINE_DIR, 'node_modules', '.bin', 'tsx')

// ── strict argv (a typo like --dry-rnu must never start a live chain) ────────

const USAGE =
  'Usage: npx tsx chain/run.ts --scope country:CC|bbox:S,W,N,E|world [--phase <name>|all] [--dry-run]\n' +
  '                            [--from <stepId> --plan <plan.json>] [--assume-fresh-extract]\n' +
  '                            [--allow-partial] [--update-gate-baseline] | --inventory'

interface CliOptions {
  scope: string | null
  phase: string
  from: string | null
  plan: string | null
  dryRun: boolean
  inventory: boolean
  updateGateBaseline: boolean
  assumeFreshExtract: boolean
  allowPartial: boolean
}

function parseCliArgs(argv: string[]): CliOptions | null {
  const opts: CliOptions = {
    scope: null, phase: 'all', from: null, plan: null,
    dryRun: false, inventory: false, updateGateBaseline: false, assumeFreshExtract: false,
    allowPartial: false,
  }
  const valueFlags: Record<string, (v: string) => void> = {
    '--scope': (v) => (opts.scope = v),
    '--phase': (v) => (opts.phase = v),
    '--from': (v) => (opts.from = v),
    '--plan': (v) => (opts.plan = v),
  }
  const boolFlags: Record<string, () => void> = {
    '--dry-run': () => (opts.dryRun = true),
    '--inventory': () => (opts.inventory = true),
    '--update-gate-baseline': () => (opts.updateGateBaseline = true),
    '--assume-fresh-extract': () => (opts.assumeFreshExtract = true),
    // #31.6: a world run FAILS when a floored step (expectMinInputs) loaded short
    // or its cache was missing — no partial feed ships as a clean, sync-safe run.
    // --allow-partial downgrades that to a warning (status.json still records
    // safeToSync=false) for dev / narrow-scope work; NEVER pass before a world
    // repaint. It can turn a failing exit into 0 but can NEVER make safeToSync true.
    '--allow-partial': () => (opts.allowPartial = true),
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (valueFlags[a]) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) {
        console.error(`${a} needs a value\n${USAGE}`)
        return null
      }
      valueFlags[a](v)
      i++
    } else if (boolFlags[a]) {
      boolFlags[a]()
    } else {
      console.error(`unknown argument '${a}'\n${USAGE}`)
      return null
    }
  }
  return opts
}

const now = () => new Date().toISOString().slice(11, 19)
const log = (msg: string) => console.log(`[${now()}] ${msg}`)

// ── child environment ────────────────────────────────────────────────────────

/** Ambient control vars a forgotten shell export must NEVER leak into a chain
 *  step: SHARD=0/96 silently shrinks built-up/service-tree/continuity/rail-
 *  parallel to 1/96 of the scope with exit 0 (/gg Codex CRITICAL). *_BBOX
 *  covers RU_BBOX and any future sibling. Only step.env may set these. */
const SCRUBBED_ENV_VARS = ['SHARD', 'START_INDEX', 'DEBUG_OSM_ID'] as const

function scrubbedChildEnv(stepEnv: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of SCRUBBED_ENV_VARS) delete env[k]
  for (const k of Object.keys(env)) if (k.endsWith('_BBOX')) delete env[k]
  return {
    ...env,
    DATA_YEAR: YEAR,
    // ES Catastro (~30M buildings) and other national caches OOM at the
    // default heap — same lift as pipeline/bench/rerun-measured.sh.
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=8192',
    ...stepEnv,
  }
}

// ── step execution ───────────────────────────────────────────────────────────

interface StepResult {
  /** Exit code; null when the child died on a signal — callers must treat
   *  null/signal as CRASH, never as exit-1 semantics (SIGKILL/OOM must not
   *  read as "auditor reported violations"). */
  code: number | null
  signal: NodeJS.Signals | null
  lastLine: string
}

/** Spawn one step, streaming stdout+stderr to a per-step log file. Deliberately
 *  spawn + pipe, NOT execFile: steps run for hours and print MBs of progress —
 *  we need the full log on DISK (post-mortem) with bounded runner memory, and
 *  execFile's maxBuffer either truncates or OOMs exactly when it matters. */
function runStep(step: PlanStep, logPath: string): Promise<StepResult> {
  return new Promise((res) => {
    const child = spawn(TSX_BIN, [step.script, ...step.args], {
      cwd: PIPELINE_DIR,
      env: scrubbedChildEnv(step.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const sink = createWriteStream(logPath)
    let lastLine = ''
    const eat = (buf: Buffer, isOut: boolean) => {
      sink.write(buf)
      if (!isOut) return
      for (const line of buf.toString('utf8').split('\n')) {
        const t = line.trim()
        if (t.length > 0) lastLine = t.slice(0, 200)
      }
    }
    child.stdout.on('data', (b: Buffer) => eat(b, true))
    child.stderr.on('data', (b: Buffer) => eat(b, false))
    child.on('error', (err) => {
      // spawn failure (e.g. node_modules/.bin/tsx missing) — no 'close' follows.
      sink.end()
      res({ code: 127, signal: null, lastLine: `spawn failed: ${err.message}` })
    })
    child.on('close', (code, signal) => {
      // Resolve only AFTER the log stream has fully flushed — completenessFor
      // reads this file synchronously right after, and a QM_COMPLETENESS marker
      // still buffered would be misread as 'missing' (a spurious completeness
      // failure on a genuinely complete run). #31.6 /gg.
      sink.end(() => res({ code, signal, lastLine }))
    })
  })
}

const stepCrashed = (r: StepResult): boolean => r.signal !== null || r.code === null
const describeExit = (r: StepResult): string => (stepCrashed(r) ? `signal=${r.signal ?? 'unknown'}` : `exit=${r.code}`)

// ── resume plan digest ───────────────────────────────────────────────────────

/** Digest of the RESOLVED plan (ids + scripts + args). --from refuses to slice
 *  a plan that no longer matches the failed run's — a manifest edit between
 *  fail and resume could otherwise silently skip a new prerequisite step. */
function planDigest(steps: PlanStep[]): string {
  const resolved = steps.map((s) => ({ id: s.id, script: s.script, args: s.args }))
  return createHash('sha256').update(JSON.stringify(resolved)).digest('hex').slice(0, 16)
}

interface PlanFile {
  digest: string
  dataYear: string
  scope: string
  phase: string
  createdAt: string
  steps: Array<{ id: string; script: string; args: readonly string[] }>
}

// ── gate plumbing ────────────────────────────────────────────────────────────

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Run the auditor step with machine-output plumbing appended; verdict via
 *  chain/gate.ts. Also used by --update-gate-baseline (which then consumes the
 *  same ndjson/summary files). */
async function runGateStep(
  gate: PlanStep,
  logDir: string,
): Promise<{ r: StepResult; ndjsonText: string | null; summaryText: string | null; logPath: string }> {
  const ndjsonPath = resolve(logDir, 'gate-invariants.ndjson')
  const summaryPath = resolve(logDir, 'gate-invariants.summary.json')
  const logPath = resolve(logDir, 'gate-invariants.log')
  // No IO flag on purpose: the auditor is fail-closed by DEFAULT (exit 3 on
  // unreadable arrow / broken extract schema; --lenient-io is the exploratory
  // opt-out a gate must never pass) — gate.ts hard-fails exit 3 either way.
  const plumbed: PlanStep = {
    ...gate,
    args: [...gate.args, '--ndjson', ndjsonPath, '--summary-json', summaryPath],
  }
  log(`gate: ${plumbed.script} ${plumbed.args.join(' ')}`)
  const r = await runStep(plumbed, logPath)
  return { r, ndjsonText: readFileOrNull(ndjsonPath), summaryText: readFileOrNull(summaryPath), logPath }
}

function gateVerdictForRun(
  r: StepResult,
  ndjsonText: string | null,
  summaryText: string | null,
  scope: ResolvedScope,
): GateVerdict {
  let baseline: unknown = null
  const baselineText = readFileOrNull(BASELINE_PATH)
  if (baselineText !== null) {
    try {
      baseline = JSON.parse(baselineText)
    } catch {
      return { pass: false, lines: ['gate-baseline.json is unparsable — fix or regenerate with --update-gate-baseline'] }
    }
  }
  return gateVerdict({
    code: r.code,
    signal: r.signal,
    ndjsonText,
    summaryText,
    baseline,
    dataYear: YEAR,
    scope: scope.canonical,
  })
}

/** Lift the gate step's machine verdict into the status contract (#31.6).
 *  `census-no-baseline` (exit 1 with ioErrors=0 and no baseline sealed FOR
 *  THIS SCOPE) is NOT a data fault — a world run today has only the CZ
 *  baseline, so its 1.44M census is expected, not a regression. */
function buildGateStatus(summaryText: string | null, pass: boolean, scope: ResolvedScope): GateStatus {
  let ioErrors = 1, total = 0
  try {
    const s = JSON.parse(summaryText ?? '{}')
    ioErrors = typeof s.ioErrors === 'number' ? s.ioErrors : 1
    total = typeof s.total === 'number' ? s.total : 0
  } catch {
    return { ioErrors: 1, total: 0, newAboveBaseline: null, verdict: 'fail' }
  }
  let baselineForScope = false
  const bt = readFileOrNull(BASELINE_PATH)
  if (bt !== null) {
    try { baselineForScope = (JSON.parse(bt) as { scope?: string }).scope === scope.canonical } catch { /* unparsable */ }
  }
  const verdict: GateStatus['verdict'] = pass
    ? 'pass'
    : baselineForScope ? 'fail' : (ioErrors === 0 ? 'census-no-baseline' : 'fail')
  return { ioErrors, total, newAboveBaseline: baselineForScope ? (pass ? 0 : null) : null, verdict }
}

// ── plan printing ────────────────────────────────────────────────────────────

function printPlan(scope: ResolvedScope, steps: PlanStep[], excluded: number): void {
  console.log(`=== enrichment chain plan — scope ${scope.label}, DATA_YEAR ${YEAR} ===`)
  const runnable = steps.filter((s) => !s.skipReason).length
  console.log(`${steps.length} steps in plan (${runnable} runnable, ${steps.length - runnable} skipped), ${excluded} national/city steps excluded by scope\n`)
  let i = 0
  let phase: Phase | '' = ''
  for (const s of steps) {
    if (s.phase !== phase) {
      phase = s.phase
      console.log(`── phase: ${phase} ${'─'.repeat(Math.max(0, 58 - phase.length))}`)
    }
    i++
    const idx = String(i).padStart(3)
    if (s.skipReason) {
      console.log(`${idx}. SKIP ${s.id} — ${s.skipReason}`)
    } else {
      console.log(`${idx}. ${s.id}  →  npx tsx ${s.script}${s.args.length ? ' ' + s.args.join(' ') : ''}`)
    }
    console.log(`      ${s.notes}`)
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const opts = parseCliArgs(process.argv.slice(2))
  if (opts === null) return 2
  if (opts.inventory) return runInventory()

  if (!opts.scope) {
    console.error(USAGE)
    return 2
  }
  const scope = parseScope(opts.scope)
  if (opts.phase !== 'all' && !PHASES.includes(opts.phase as Phase)) {
    console.error(`unknown --phase '${opts.phase}' — expected one of: ${PHASES.join(', ')}, all`)
    return 2
  }
  const { steps: builtSteps, excludedByScope } = buildPlan(scope)
  const allSteps = opts.assumeFreshExtract
    ? builtSteps.map((s) =>
        s.skipIf === 'ran-by-extract-tail' && !s.skipReason
          ? { ...s, skipReason: '--assume-fresh-extract: the osm-to-h3r4.sh tail just ran it (marker ran-by-extract-tail)' }
          : s,
      )
    : builtSteps
  let steps = opts.phase === 'all' ? allSteps : allSteps.filter((s) => s.phase === opts.phase)
  const digest = planDigest(steps)

  if (opts.from) {
    // Resume is only safe against the SAME resolved plan: require the failed
    // run's plan.json and match its digest + identity before slicing.
    if (!opts.plan) {
      console.error(`--from needs --plan <plan.json> (printed in the failed run's resume hint; logs/chain/<runId>/plan.json)`)
      return 2
    }
    let plan: PlanFile
    try {
      plan = JSON.parse(readFileSync(opts.plan, 'utf8')) as PlanFile
    } catch (err) {
      console.error(`--plan '${opts.plan}' unreadable/unparsable: ${err instanceof Error ? err.message : err}`)
      return 2
    }
    const mismatches: string[] = []
    if (plan.dataYear !== YEAR) mismatches.push(`DATA_YEAR ${plan.dataYear} vs ${YEAR}`)
    if (plan.scope !== scope.canonical) mismatches.push(`scope '${plan.scope}' vs '${scope.canonical}'`)
    if (plan.phase !== opts.phase) mismatches.push(`phase '${plan.phase}' vs '${opts.phase}'`)
    if (plan.digest !== digest) mismatches.push(`plan digest ${plan.digest} vs ${digest} (manifest/scope resolution changed since the failed run)`)
    if (mismatches.length > 0) {
      console.error(`--from refused — resumed plan does not match:\n  ${mismatches.join('\n  ')}\nRe-run WITHOUT --from to execute the current plan from the start.`)
      return 2
    }
    const at = steps.findIndex((s) => s.id === opts.from)
    if (at < 0) {
      console.error(`--from '${opts.from}' is not in the resolved plan (${steps.length} steps) — run --dry-run to list ids`)
      return 2
    }
    log(`RESUME: plan digest ${digest} verified; skipping ${at} step(s) before ${opts.from}`)
    steps = steps.slice(at)
  }

  if (opts.dryRun) {
    printPlan(scope, steps, excludedByScope)
    return 0
  }

  const runId = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const logDir = resolve(REPO_ROOT, 'logs', 'chain', runId)
  mkdirSync(logDir, { recursive: true })

  if (opts.updateGateBaseline) {
    const gate = allSteps.find((s) => s.phase === 'gate')!
    const { r, ndjsonText, summaryText } = await runGateStep(gate, logDir)
    if (stepCrashed(r) || (r.code !== 0 && r.code !== 1)) {
      log(`auditor ${describeExit(r)} — crash/usage/IO-error, no baseline written`)
      return 1
    }
    try {
      const baseline = buildBaseline(YEAR, scope.canonical, ndjsonText ?? '', summaryText ?? '{}')
      writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
      const total = Object.values(baseline.fingerprints).reduce((a, b) => a + b, 0)
      log(`baseline written: ${BASELINE_PATH} (${total} violation(s), ${Object.keys(baseline.fingerprints).length} fingerprints, scope ${baseline.scope}, DATA_YEAR ${baseline.dataYear})`)
      return 0
    } catch (err) {
      log(`auditor machine output inconsistent — no baseline written: ${err instanceof Error ? err.message : err}`)
      return 1
    }
  }

  // ── execute ────────────────────────────────────────────────────────────────
  const planPath = resolve(logDir, 'plan.json')
  const planFile: PlanFile = {
    digest,
    dataYear: YEAR,
    scope: scope.canonical,
    phase: opts.phase,
    createdAt: new Date().toISOString(),
    steps: steps.map((s) => ({ id: s.id, script: s.script, args: s.args })),
  }
  writeFileSync(planPath, JSON.stringify(planFile, null, 2) + '\n')
  const resumeHint = (stepId: string) =>
    `DATA_YEAR=${YEAR} npx tsx chain/run.ts --scope ${opts.scope} --phase ${opts.phase} --from ${stepId} --plan ${planPath}` +
    (opts.assumeFreshExtract ? ' --assume-fresh-extract' : '')

  log(`chain run ${runId} — scope ${scope.label}, DATA_YEAR ${YEAR}, logs ${logDir}`)
  log(`plan digest ${digest} (${planPath})`)
  log(`${steps.length} steps (${steps.filter((s) => !s.skipReason).length} runnable); reminder: do NOT run gen:sources while this is in flight`)

  // #31.6 status contract: rewritten after every step so a crashed run still
  // leaves an honest partial record. See chain/status.ts (the schema SSOT,
  // consumed read-only by the gate-before-sync / repaint trigger).
  const statusPath = resolve(logDir, 'status.json')
  const startedAt = new Date().toISOString()
  const statusSteps: StepStatus[] = []
  let gateStatus: GateStatus | null = null
  // Certify over the FULL resolved plan (allSteps), not the possibly-sliced
  // `steps` this session runs — a --from resume / --phase subset must not let a
  // floored step it skipped certify blind-safe (#31.6 /gg CRITICAL).
  const flooredPlan: FlooredPlanStep[] = allSteps
    .filter((s) => (s.expectMinInputs ?? 0) > 0)
    .map((s) => ({ id: s.id, skipKind: s.skipKind }))
  const flush = (outcome: ChainStatus['outcome']): void => {
    const status: ChainStatus = {
      runId, dataYear: YEAR, scope: scope.canonical, startedAt,
      finishedAt: outcome === 'running' ? null : new Date().toISOString(),
      outcome, gate: gateStatus,
      safeToSync: outcome === 'complete' && (gateStatus?.ioErrors ?? 1) === 0 && plannedCompletenessSatisfied(flooredPlan, statusSteps),
      steps: statusSteps,
    }
    writeChainStatus(statusPath, status)
  }
  // The floored-step completeness for a step comes from its own log's
  // QM_COMPLETENESS marker; expected floor is the manifest's (0 until declared).
  const completenessFor = (step: PlanStep, logPath: string): StepStatus['completeness'] => {
    const expected = step.expectMinInputs ?? 0
    let marker: ReturnType<typeof parseCompletenessMarker> = null
    try { marker = parseCompletenessMarker(readFileSync(logPath, 'utf-8')) } catch { /* no log */ }
    if (!marker) return expected > 0 ? { expected, actual: 0, state: 'missing', detail: 'no completeness marker emitted' } : null
    return { expected, actual: marker.actual, state: marker.state, detail: marker.detail }
  }
  flush('running')

  for (const step of steps) {
    if (step.skipReason) {
      log(`SKIP ${step.id} — ${step.skipReason}`)
      statusSteps.push({ id: step.id, phase: step.phase, status: 'skipped', durationMs: 0, skipReason: step.skipReason })
      flush('running')
      continue
    }
    const t0 = Date.now()

    if (step.phase === 'gate') {
      // #31.6 completeness enforcement — BEFORE the (expensive) auditor. A FRESH
      // FULL WORLD run whose floored steps loaded short or whose cache was missing
      // must FAIL, not certify a partial feed as a clean run — the exit code, not
      // just safeToSync, enforces it (the chain "enforces, not notes"). Scoped to
      // a fresh full world run: a --from resume ran the floored steps in an earlier
      // session (its data may be complete, so it must not be blocked — it records
      // safeToSync=false but exits 0), a --phase subset never claimed to, and a
      // narrow scope's global feed may be legitimately irrelevant. --allow-partial
      // downgrades even the fresh-full-world fail to a warning (safeToSync stays
      // false regardless).
      const isFreshFullWorld = scope.kind === 'world' && opts.phase === 'all' && opts.from === null
      if (isFreshFullWorld && !plannedCompletenessSatisfied(flooredPlan, statusSteps)) {
        for (const ps of flooredPlan) {
          const s = statusSteps.find((x) => x.id === ps.id)
          if (ps.skipKind === 'not-applicable' || (s?.status === 'done' && stepIsComplete(s))) continue
          const c = s?.completeness
          const detail = s ? `${c?.actual ?? '?'}/${c?.expected ?? '?'} (${s.status})` : 'not run this session'
          log(`  INCOMPLETE ${ps.id}: ${detail}${ps.skipKind === 'input-missing' ? ' — cache missing' : ''}`)
        }
        if (!opts.allowPartial) {
          log(`FAILED completeness — a floored step is short/absent; data NOT safe to gate/sync/repaint (pass --allow-partial to override for dev)`)
          flush('failed')
          return 1
        }
        log(`  --allow-partial: completeness gap TOLERATED (dev only — safeToSync stays false, NEVER repaint off this run)`)
      }
      const { r, ndjsonText, summaryText, logPath } = await runGateStep(step, logDir)
      const dt = ((Date.now() - t0) / 1000).toFixed(1)
      const verdict = gateVerdictForRun(r, ndjsonText, summaryText, scope)
      gateStatus = buildGateStatus(summaryText, verdict.pass, scope)
      for (const line of verdict.lines) log(`  gate: ${line}`)
      statusSteps.push({ id: step.id, phase: step.phase, status: verdict.pass ? 'done' : 'failed', durationMs: Date.now() - t0 })
      if (!verdict.pass) {
        log(`FAILED ${step.id} after ${dt}s — log: ${logPath}`)
        flush('failed')
        return 1
      }
      log(`DONE ${step.id} in ${dt}s (gate passed)`)
      flush('running')
      continue
    }

    log(`START ${step.id}  (${step.script}${step.args.length ? ' ' + step.args.join(' ') : ''})`)
    const logPath = resolve(logDir, `${step.id}.log`)
    const r = await runStep(step, logPath)
    const dt = ((Date.now() - t0) / 1000).toFixed(1)
    if (stepCrashed(r) || r.code !== 0) {
      log(`FAILED ${step.id} ${describeExit(r)} after ${dt}s — log: ${logPath}`)
      log(`resume after fixing with: ${resumeHint(step.id)}`)
      statusSteps.push({ id: step.id, phase: step.phase, status: 'failed', durationMs: Date.now() - t0, lastLine: r.lastLine, completeness: completenessFor(step, logPath) })
      flush('failed')
      return 1
    }
    statusSteps.push({ id: step.id, phase: step.phase, status: 'done', durationMs: Date.now() - t0, lastLine: r.lastLine, completeness: completenessFor(step, logPath) })
    flush('running')
    log(`DONE ${step.id} in ${dt}s${r.lastLine ? ` — ${r.lastLine}` : ''}`)
  }
  flush('complete')
  log(`chain complete — status ${statusPath}`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('Error:', err)
    process.exit(1)
  },
)
