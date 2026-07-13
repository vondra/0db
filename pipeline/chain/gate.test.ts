/**
 * gate.ts — cheap baseline identity checks that must run before the expensive
 * invariant auditor.
 *
 * Run: `cd pipeline && npx tsx --test chain/gate.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baselinePreflightProblem, validateBaselineIdentity, type GateBaseline } from './gate.js'

const BASELINE: GateBaseline = {
  dataYear: '2026',
  scope: 'country:CZ',
  createdAt: '2026-07-11T13:36:03.696Z',
  fingerprints: {},
}

test('validateBaselineIdentity accepts only the exact year and scope', () => {
  const result = validateBaselineIdentity(BASELINE, '2026', 'country:CZ')
  assert.equal(result.valid, true)
  if (result.valid) assert.equal(result.baseline, BASELINE)
})

test('validateBaselineIdentity fails closed for unusable or mismatched baselines', () => {
  const cases: Array<{ name: string; baseline: unknown; year: string; scope: string; contains: string }> = [
    { name: 'missing', baseline: null, year: '2026', scope: 'country:CZ', contains: 'NO baseline' },
    { name: 'invalid v2 shape', baseline: {}, year: '2026', scope: 'country:CZ', contains: 'fingerprint format v2' },
    { name: 'array fingerprints', baseline: { ...BASELINE, fingerprints: [] }, year: '2026', scope: 'country:CZ', contains: 'fingerprint format v2' },
    { name: 'invalid count', baseline: { ...BASELINE, fingerprints: { broken: 0 } }, year: '2026', scope: 'country:CZ', contains: 'fingerprint format v2' },
    { name: 'invalid createdAt', baseline: { ...BASELINE, createdAt: 'not-a-date' }, year: '2026', scope: 'country:CZ', contains: 'fingerprint format v2' },
    { name: 'wrong year', baseline: BASELINE, year: '2027', scope: 'country:CZ', contains: 'DATA_YEAR 2026' },
    { name: 'wrong scope', baseline: BASELINE, year: '2026', scope: 'world', contains: "scope 'country:CZ'" },
  ]

  for (const c of cases) {
    const result = validateBaselineIdentity(c.baseline, c.year, c.scope)
    assert.equal(result.valid, false, c.name)
    if (!result.valid) assert.match(result.lines.join('\n'), new RegExp(c.contains), c.name)
  }
})

test('baseline preflight preserves census only when the baseline is absent', () => {
  assert.equal(baselinePreflightProblem(null, '2026', 'world'), null, 'missing baseline keeps census path')
  assert.equal(baselinePreflightProblem(BASELINE, '2026', 'country:CZ'), null, 'matching baseline runs gate')
  assert.match(
    baselinePreflightProblem(BASELINE, '2026', 'world')?.join('\n') ?? '',
    /baseline is for scope 'country:CZ'/,
  )
})
