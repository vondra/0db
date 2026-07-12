import assert from 'node:assert/strict'
import test from 'node:test'
import { buildApp } from '../app.js'
import { validationDeltaCompatibilityError, validationLastrunCompatibilityError } from './validation-view.js'

const ready = async () => ({ ready: true as const, failed: [], errors: {} })
const identity = {
  status: 'complete' as const,
  identity_complete: true,
  data_year: '2026',
  prepared_revision: 'prepared-2026',
  build: {
    schema_version: 1 as const,
    git_commit: '0123456789abcdef0123456789abcdef01234567',
    git_dirty: false,
    built_at: '2026-07-12T00:00:00.000Z',
    native_source_reader_sha256: 'ab'.repeat(32),
  },
}

test('validation API loads only approved snapshots and exposes explicit comparison semantics', async (t) => {
  const app = await buildApp({ readinessCheck: ready })
  t.after(async () => app.close())
  const response = await app.inject('/api/validation/points')
  assert.equal(response.statusCode, 200)
  const payload = response.json() as {
    networks: Array<{
      network: string
      comparison_mode: string
      comparison_tolerance_db: number | null
      comparison_tolerance_basis: string | null
      measured_metric_field: string
      model_metric_field: string
      stations: Array<Record<string, unknown>>
    }>
  }
  assert.deepEqual(payload.networks.map(network => network.network), [
    'barcelona-xarxa-soroll', 'dublin-sonitus', 'eba-laermmonitoring', 'zrh-nmt',
  ])
  assert.ok(payload.networks.every(network => network.network !== 'bruitparif-rumeur'))
  for (const network of payload.networks) {
    assert.ok(['two_sided', 'upper_bound', 'trend_only'].includes(network.comparison_mode))
    assert.ok(network.measured_metric_field)
    assert.ok(network.model_metric_field)
    assert.ok(network.stations.every(station => station.measured_metric_field === network.measured_metric_field))
  }
  const barcelona = payload.networks[0]
  assert.equal(barcelona.comparison_mode, 'upper_bound')
  assert.equal(barcelona.comparison_tolerance_db, 2)
  assert.ok(barcelona.comparison_tolerance_basis)
  assert.equal(barcelona.stations[0].measured_value, barcelona.stations[0].lden)
})

test('public validation view rejects stale or holdout-revealing delta artifacts', () => {
  const snapshot = {
    network: 'test-network', year: 2026,
    comparison_mode: 'upper_bound' as const, comparison_tolerance_db: 2,
    comparison_tolerance_basis: 'Diagnostic allowance.',
    measured_metric_field: 'lden', model_metric_field: 'lden',
    stations: [{ station_id: 'one', lden: 50 }],
  }
  const context = {
    currentServerIdentity: identity,
    holdoutManifestSha256: '11'.repeat(32),
    snapshotSha256: '22'.repeat(32),
    partitionById: new Map([['one', 'development_exposed' as const]]),
  }
  const artifact = {
    schema_version: 1,
    network: 'test-network', year: 2026, generated_at: '2026-07-12T00:00:00.000Z',
    server: 'http://localhost:8520', trend_only: false, evaluate_holdout: false,
    server_identity: identity,
    holdout_manifest_sha256: context.holdoutManifestSha256,
    snapshot_sha256: context.snapshotSha256,
    comparison_mode: 'upper_bound', comparison_tolerance_db: 2,
    comparison_tolerance_basis: 'Diagnostic allowance.',
    measured_metric_field: 'lden', model_metric_field: 'lden',
    rows: [{
      station_id: 'one', measured_metric_field: 'lden', model_metric_field: 'lden',
      partition: 'development_exposed', measured_value: 50, model_value: 51,
      model: { lden: 51, ld: null, le: null, ln: null }, dominant_source: 'road',
      delta_db: 1, delta_lden: 1, verdict: 'within_bound',
    }],
  }
  assert.equal(validationDeltaCompatibilityError(artifact, snapshot, context), null)
  assert.match(validationDeltaCompatibilityError({ ...artifact, schema_version: undefined }, snapshot, context)!, /schema_version/)
  assert.match(validationDeltaCompatibilityError({ ...artifact, comparison_mode: 'two_sided' }, snapshot, context)!, /comparison_mode/)
  assert.match(validationDeltaCompatibilityError({ ...artifact, evaluate_holdout: true }, snapshot, context)!, /holdout evaluation/)
  assert.match(validationDeltaCompatibilityError({ ...artifact, snapshot_sha256: 'wrong' }, snapshot, context)!, /content hash/)
  const wrongMeasured = structuredClone(artifact)
  wrongMeasured.rows[0].measured_value = 999
  assert.match(validationDeltaCompatibilityError(wrongMeasured, snapshot, context)!, /measured value differs/)

  const holdoutContext = { ...context, partitionById: new Map([['one', 'holdout' as const]]) }
  const redactedHoldout = { ...artifact, rows: [{
    ...artifact.rows[0], partition: 'holdout', verdict: 'holdout_withheld',
    model: { lden: null, ld: null, le: null, ln: null }, model_value: null,
    dominant_source: null, delta_db: null, delta_lden: null,
  }] }
  assert.equal(validationDeltaCompatibilityError(redactedHoldout, snapshot, holdoutContext), null)
  const leakedHoldout = { ...redactedHoldout, rows: [{
    ...redactedHoldout.rows[0],
    model: { ...redactedHoldout.rows[0].model, lden: 77 },
  }] }
  assert.match(validationDeltaCompatibilityError(leakedHoldout, snapshot, holdoutContext)!, /exposes a holdout/)
  assert.match(validationDeltaCompatibilityError(redactedHoldout, snapshot, context)!, /partition differs/)
})

test('public validation view accepts only server-attributed, redacted gate runs', () => {
  const context = {
    currentServerIdentity: identity,
    holdoutManifestSha256: '11'.repeat(32),
    fixturesSha256: '33'.repeat(32),
    partitionById: new Map([['future', 'holdout' as const]]),
  }
  const run = {
    schema_version: 1, server: 'http://localhost:8520', commit: identity.build.git_commit,
    timestamp: '2026-07-12T00:01:00.000Z', data_year: 2026, server_identity: identity,
    fixtures_sha256: context.fixturesSha256,
    holdout_manifest_sha256: context.holdoutManifestSha256,
    evaluate_holdout: false,
    results: [{ id: 'future', partition: 'holdout', status: 'WITHHELD', value: null, drift: null, ext: null }],
  }
  assert.equal(validationLastrunCompatibilityError(run, context), null)
  assert.match(validationLastrunCompatibilityError({ ...run, commit: 'wrong' }, context)!, /commit differs/)
  assert.match(validationLastrunCompatibilityError({ ...run, evaluate_holdout: true }, context)!, /holdout evaluation/)
  const exposed = { ...run, results: [{ ...run.results[0], status: 'OK', value: 42 }] }
  assert.match(validationLastrunCompatibilityError(exposed, context)!, /exposes a holdout/)
  const sideChannel = { ...run, results: [{ ...run.results[0], drift: 1, ext: { delta: 1, side: 'above' } }] }
  assert.match(validationLastrunCompatibilityError(sideChannel, context)!, /exposes a holdout/)
  const relabelled = { ...run, results: [{ ...run.results[0], partition: 'development' }] }
  assert.match(validationLastrunCompatibilityError(relabelled, context)!, /partition differs/)

  const developmentContext = { ...context, partitionById: new Map([['future', 'development' as const]]) }
  const invalidDevelopment = {
    ...run,
    results: [{ id: 'future', partition: 'development', status: 'OK', value: '/secret', drift: { bad: true }, ext: '/bad' }],
  }
  assert.match(validationLastrunCompatibilityError(invalidDevelopment, developmentContext)!, /invalid value/)

  const incompleteContext = {
    ...context,
    currentServerIdentity: { ...identity, status: 'incomplete' as const, identity_complete: false, prepared_revision: null },
  }
  assert.match(validationLastrunCompatibilityError(run, incompleteContext)!, /prepared-data identity is incomplete/)
})
