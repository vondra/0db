/**
 * chain/status.ts — the #31.6 status contract. Pins the marker parser
 * (enricher → runner), the floored-step completeness rule, and the atomic
 * writer's shape (the read-only contract the 0db-codex stage-waiter builds on).
 *
 * Run: `cd pipeline && npx tsx --test chain/status.test.ts`
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseCompletenessMarker, stepIsComplete, plannedCompletenessSatisfied, writeChainStatus,
  type ChainStatus, type StepStatus, type FlooredPlanStep,
} from './status.js'

const TMP = mkdtempSync(join(tmpdir(), 'chain-status-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

test('parseCompletenessMarker: reads the marker, last-emitted wins', () => {
  const log = [
    'some enricher noise',
    'QM_COMPLETENESS {"actual":2,"state":"partial","detail":"2/36 cities"}',
    'more noise',
    'QM_COMPLETENESS {"actual":36,"state":"complete"}',
  ].join('\n')
  assert.deepEqual(parseCompletenessMarker(log), { actual: 36, state: 'complete', detail: undefined })
})

test('parseCompletenessMarker: absent → null; malformed → skipped, not thrown', () => {
  assert.equal(parseCompletenessMarker('no marker here\njust logs'), null)
  // a line mentioning the word but not a valid marker must not throw
  assert.equal(parseCompletenessMarker('QM_COMPLETENESS not-json'), null)
  assert.equal(parseCompletenessMarker('QM_COMPLETENESS {"state":"partial"}'), null) // missing actual
})

test('stepIsComplete: runner is SSOT — count met for floored, unfloored always safe', () => {
  const base = { id: 'x', phase: 'global-priors', status: 'done', durationMs: 1 } as const
  assert.equal(stepIsComplete({ ...base }), true, 'no floor → safe')
  assert.equal(stepIsComplete({ ...base, completeness: { expected: 36, actual: 36, state: 'complete' } }), true)
  assert.equal(stepIsComplete({ ...base, completeness: { expected: 0, actual: 0, state: 'empty-valid' } }), true, 'unfloored empty-valid safe')
  assert.equal(stepIsComplete({ ...base, completeness: { expected: 36, actual: 2, state: 'partial' } }), false)
  assert.equal(stepIsComplete({ ...base, completeness: { expected: 23, actual: 0, state: 'missing' } }), false)
  // numeric SSOT: a producer's 'complete' with actual<expected is NOT trusted
  assert.equal(stepIsComplete({ ...base, completeness: { expected: 36, actual: 2, state: 'complete' } }), false, 'lying complete')
  // a fixed catalog cannot pass as empty-valid with 0 loaded
  assert.equal(stepIsComplete({ ...base, completeness: { expected: 36, actual: 0, state: 'empty-valid' } }), false, 'floored empty-valid')
  // a stray marker on a non-floored (expected 0) step never fails the run
  assert.equal(stepIsComplete({ ...base, completeness: { expected: 0, actual: 0, state: 'partial' } }), true, 'unfloored partial ignored')
})

test('plannedCompletenessSatisfied: whole-plan certificate (resume/phase/skip/count)', () => {
  const plan: FlooredPlanStep[] = [{ id: 'roads-europe' }, { id: 'railway-europe' }]
  const done = (id: string, actual: number, expected: number): StepStatus => ({
    id, phase: 'global-priors', status: 'done', durationMs: 1,
    completeness: { expected, actual, state: actual >= expected ? 'complete' : 'partial' },
  })
  // both floored steps ran and met their floor → certified
  assert.equal(plannedCompletenessSatisfied(plan, [done('roads-europe', 36, 36), done('railway-europe', 23, 23)]), true)
  // one loaded short → not certified
  assert.equal(plannedCompletenessSatisfied(plan, [done('roads-europe', 36, 36), done('railway-europe', 22, 23)]), false)
  // a --from resume / --phase subset never ran railway-europe → unverifiable → not certified
  assert.equal(plannedCompletenessSatisfied(plan, [done('roads-europe', 36, 36)]), false)
  // input-missing skip (cache absent) → not certified
  const planMissing: FlooredPlanStep[] = [{ id: 'roads-europe' }, { id: 'railway-europe', skipKind: 'input-missing' }]
  assert.equal(plannedCompletenessSatisfied(planMissing, [done('roads-europe', 36, 36),
    { id: 'railway-europe', phase: 'global-priors', status: 'skipped', durationMs: 0 }]), false)
  // not-applicable skip (irrelevant to scope) → does NOT block
  const planNA: FlooredPlanStep[] = [{ id: 'roads-europe' }, { id: 'railway-europe', skipKind: 'not-applicable' }]
  assert.equal(plannedCompletenessSatisfied(planNA, [done('roads-europe', 36, 36)]), true)
  // a floored step that ran but carries NO completeness record → not certified
  // (belt against a completenessFor that stopped synthesizing 'missing')
  assert.equal(plannedCompletenessSatisfied([{ id: 'roads-europe' }],
    [{ id: 'roads-europe', phase: 'global-priors', status: 'done', durationMs: 1, completeness: null }]), false)
})

test('writeChainStatus: atomic round-trip, shape preserved', () => {
  const steps: StepStatus[] = [
    { id: 'roads-europe', phase: 'global-priors', status: 'done', durationMs: 12000, completeness: { expected: 36, actual: 2, state: 'partial', detail: '2/36' } },
    { id: 'roads-cz', phase: 'national', status: 'done', durationMs: 3000, completeness: null },
  ]
  const status: ChainStatus = {
    runId: 'test-run', dataYear: '2026', scope: 'world',
    startedAt: '2026-07-13T00:00:00.000Z', finishedAt: '2026-07-13T02:00:00.000Z',
    outcome: 'complete',
    gate: { ioErrors: 0, total: 1440499, newAboveBaseline: null, verdict: 'census-no-baseline' },
    safeToSync: false, // a partial floored step makes it unsafe
    steps,
  }
  const path = join(TMP, 'status.json')
  writeChainStatus(path, status)
  const back = JSON.parse(readFileSync(path, 'utf-8')) as ChainStatus
  assert.deepEqual(back, status)
  assert.equal(back.steps[0].completeness?.state, 'partial')
  assert.equal(back.gate?.verdict, 'census-no-baseline')
})
