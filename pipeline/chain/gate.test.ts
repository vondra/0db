/**
 * gate.ts — cheap baseline identity checks that must run before the expensive
 * invariant auditor.
 *
 * Run: `cd pipeline && npx tsx --test chain/gate.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  baselinePreflightProblem, validateBaselineIdentity, resolveGateBaseline, scopeBaselineSlug,
  type GateBaseline,
} from './gate.js'

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

test('scopeBaselineSlug replaces only the scope-kind separator', () => {
  assert.equal(scopeBaselineSlug('country:CZ'), 'country-CZ')
  assert.equal(scopeBaselineSlug('world'), 'world')
  assert.equal(scopeBaselineSlug('bbox:49.7,13.9,50.4,15.0'), 'bbox-49.7,13.9,50.4,15.0')
})

test('resolveGateBaseline: present per-scope file is read and returned (per-scope roundtrip)', () => {
  const perScope = JSON.stringify(BASELINE)
  const result = resolveGateBaseline(perScope)
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.baseline, BASELINE)
})

test('resolveGateBaseline: absent per-scope file is a clean census (no baseline) — cross-scope isolation is now structural', () => {
  // A CZ per-scope baseline is simply not found for a DE run: each scope
  // reads its OWN file (`{dataYear}.{scopeBaselineSlug(scope)}.json`, distinct
  // by construction — see the 'scopeBaselineSlug' test above), so there is no
  // shared file two scopes could ever leak through. This function only ever
  // sees the ONE file run.ts already resolved for the caller's own scope.
  const result = resolveGateBaseline(null)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.baseline, null)
  // Sanity: the "no baseline" result stays census for any scope's preflight.
  assert.equal(baselinePreflightProblem(result.ok ? result.baseline : 'unreachable', '2026', 'country:DE'), null)
})

test('resolveGateBaseline: unparsable per-scope JSON fails closed, never silently "no baseline"', () => {
  const bad = resolveGateBaseline('{not json')
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.lines.join('\n'), /per-scope gate baseline is unparsable/)
})
