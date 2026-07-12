import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyComparison } from './comparison.ts'

test('two-sided comparison reports positive and negative actionable errors', () => {
  assert.deepEqual(classifyComparison('two_sided', 2, 50, 54), { delta_db: 4, verdict: 'above' })
  assert.deepEqual(classifyComparison('two_sided', 2, 50, 46), { delta_db: -4, verdict: 'below' })
})

test('exact tolerance boundaries remain within the declared bound', () => {
  assert.deepEqual(classifyComparison('two_sided', 2, 50, 52), { delta_db: 2, verdict: 'within_bound' })
  assert.deepEqual(classifyComparison('two_sided', 2, 50, 48), { delta_db: -2, verdict: 'within_bound' })
  assert.deepEqual(classifyComparison('upper_bound', 2, 50, 52), { delta_db: 2, verdict: 'within_bound' })
  assert.deepEqual(classifyComparison('upper_bound', 2, 50, 47.9), { delta_db: -2.1, verdict: 'unattributable' })
})

test('classification uses the unrounded delta at a tolerance boundary', () => {
  assert.deepEqual(classifyComparison('two_sided', 2, 50, 52.04), { delta_db: 2.04, verdict: 'above' })
  assert.deepEqual(classifyComparison('two_sided', 2, 50, 47.96), { delta_db: -2.04, verdict: 'below' })
  assert.deepEqual(classifyComparison('upper_bound', 2, 50, 52.04), { delta_db: 2.04, verdict: 'above' })
  assert.deepEqual(classifyComparison('upper_bound', 2, 2.4, 4.4), { delta_db: 2, verdict: 'within_bound' })
})

test('missing non-trend measurements are errors, never silently trend-only', () => {
  assert.deepEqual(classifyComparison('two_sided', 2, null, 50), { delta_db: null, verdict: 'error' })
  assert.deepEqual(classifyComparison('upper_bound', 2, undefined, 50), { delta_db: null, verdict: 'error' })
  assert.deepEqual(classifyComparison('trend_only', null, 60, 55), { delta_db: null, verdict: 'trend_only' })
})
