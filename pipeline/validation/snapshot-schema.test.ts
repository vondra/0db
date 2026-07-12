import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT, validateSnapshot, type Snapshot } from './lib.ts'
import { loadApprovedSnapshots, validateApprovedSnapshotIdentity } from './snapshot-loader.mjs'

function readSnapshots(): Map<string, Snapshot> {
  const out = new Map<string, Snapshot>()
  for (const { file, path, snapshot } of loadApprovedSnapshots(REPO_ROOT)) {
    validateSnapshot(snapshot, path)
    out.set(file, snapshot)
  }
  return out
}

const expected = {
  'barcelona-xarxa-soroll.2025.json': { network: 'barcelona-xarxa-soroll', country: 'ES', count: 154, comparison: 'upper_bound', tolerance: 2 },
  'dublin-sonitus.2025.json': { network: 'dublin-sonitus', country: 'IE', count: 14, comparison: 'upper_bound', tolerance: 2 },
  'eba-laermmonitoring.2023.json': { network: 'eba-laermmonitoring', country: 'DE', count: 19, comparison: 'trend_only', tolerance: null },
  'zrh-nmt.2024.json': { network: 'zrh-nmt', country: 'CH', count: 4, comparison: 'trend_only', tolerance: null },
} as const

test('all committed validation snapshots satisfy the explicit schema', () => {
  const snapshots = readSnapshots()
  assert.deepEqual([...snapshots.keys()], Object.keys(expected))
  for (const [file, want] of Object.entries(expected)) {
    const snapshot = snapshots.get(file)!
    assert.equal(snapshot.schema_version, 2)
    assert.equal(snapshot.network, want.network)
    assert.equal(snapshot.country_code, want.country)
    assert.equal(snapshot.anchor_type, 'measurement')
    assert.equal(snapshot.comparison_mode, want.comparison)
    assert.equal(snapshot.comparison_tolerance_db, want.tolerance)
    assert.equal(snapshot.comparison_tolerance_basis === null, snapshot.comparison_mode === 'trend_only')
    assert.ok(snapshot.measured_metric_field)
    assert.ok(snapshot.model_metric_field)
    assert.equal(snapshot.stations.length, want.count)
  }
})

test('approved manifest is the only snapshot discovery path', () => {
  assert.deepEqual([...readSnapshots().keys()], Object.keys(expected))
  assert.ok(![...readSnapshots().keys()].some(file => file.startsWith('bruitparif-')))
})

test('network factor tags are conservative and vocabulary-backed', () => {
  const snapshots = readSnapshots()
  const barcelona = snapshots.get('barcelona-xarxa-soroll.2025.json')!
  assert.deepEqual(barcelona.tags, ['dense_urban'])
  const pedestrian = barcelona.stations.filter(st => st.tags?.includes('pedestrian_zone'))
  assert.equal(pedestrian.length, 10)
  assert.ok(pedestrian.every(st => st.font === 'ZONA DE VIANANTS'))

  const eba = snapshots.get('eba-laermmonitoring.2023.json')!
  assert.deepEqual(eba.tags, ['near', 'rail_count_measured'])
  assert.deepEqual(snapshots.get('dublin-sonitus.2025.json')!.tags, [])
  assert.deepEqual(snapshots.get('zrh-nmt.2024.json')!.tags, [])
})

test('Dublin replacement instruments do not double-weight one receiver site', () => {
  const dublin = readSnapshots().get('dublin-sonitus.2025.json')!
  assert.ok(dublin.stations.some(station => station.station_id === '10.1.1.1'))
  assert.ok(!dublin.stations.some(station => station.station_id === '01528'))
  assert.ok(dublin.stations.some(station => station.station_id === '10.1.1.7'))
  assert.ok(!dublin.stations.some(station => station.station_id === '01534'))
})

test('schema rejects inferred or contradictory comparison semantics', () => {
  const source = readSnapshots().get('barcelona-xarxa-soroll.2025.json')!
  const missingMode = structuredClone(source) as unknown as Record<string, unknown>
  delete missingMode.comparison_mode
  assert.throws(() => validateSnapshot(missingMode), /unknown comparison_mode/)

  const twoSidedAmbient = structuredClone(source)
  twoSidedAmbient.comparison_mode = 'two_sided'
  assert.throws(() => validateSnapshot(twoSidedAmbient), /total_ambient cannot use a two_sided comparison/)

  const upperNearSource = structuredClone(source)
  upperNearSource.commensurability.dominance = 'near_source'
  assert.throws(() => validateSnapshot(upperNearSource), /upper_bound requires/)

  const trendWithTolerance = structuredClone(source)
  trendWithTolerance.comparison_mode = 'trend_only'
  assert.throws(() => validateSnapshot(trendWithTolerance), /trend_only requires comparison_tolerance_db=null/)

  const unknownTag = structuredClone(source)
  unknownTag.stations[0].tags = ['not_in_the_factor_catalog']
  assert.throws(() => validateSnapshot(unknownTag), /unknown factor tag/)

  const fakeCountry = structuredClone(source)
  fakeCountry.country_code = 'ZZ'
  assert.throws(() => validateSnapshot(fakeCountry), /real ISO alpha-2/)

  const unsafeNetwork = structuredClone(source)
  unsafeNetwork.network = '../escape'
  assert.throws(() => validateSnapshot(unsafeNetwork), /lowercase hyphenated slug/)

  const unsafeStation = structuredClone(source)
  unsafeStation.stations[0].station_id = 'nested/station'
  assert.throws(() => validateSnapshot(unsafeStation), /without '\/' or NUL/)

  const nonCanonicalTimestamp = structuredClone(source)
  nonCanonicalTimestamp.fetched_at = '2026-07-12'
  assert.throws(() => validateSnapshot(nonCanonicalTimestamp), /canonical UTC ISO instant/)

  const fakeMetric = structuredClone(source)
  fakeMetric.commensurability.metric_variant = 'invented_metric'
  assert.throws(() => validateSnapshot(fakeMetric), /unknown commensurability.metric_variant/)

  const fakeReceiver = structuredClone(source)
  fakeReceiver.commensurability.receiver_convention = 'lamp_post'
  assert.throws(() => validateSnapshot(fakeReceiver), /unknown commensurability.receiver_convention/)

  const missingMeasured = structuredClone(source)
  delete missingMeasured.stations[0].lden
  assert.throws(() => validateSnapshot(missingMeasured), /measured metric lden must be finite/)

  const missingPeriod = structuredClone(source)
  delete missingPeriod.stations[0].ln
  assert.throws(() => validateSnapshot(missingPeriod), /measured metric ln must be finite/)

  const inconsistentLden = structuredClone(source)
  inconsistentLden.stations[0].lden = 1
  assert.throws(() => validateSnapshot(inconsistentLden), /inconsistent with the period_split/)

  const incompatiblePrimaryMetric = structuredClone(source)
  incompatiblePrimaryMetric.measured_metric_field = 'laeq_24h'
  incompatiblePrimaryMetric.stations[0].laeq_24h = incompatiblePrimaryMetric.stations[0].lden
  assert.throws(() => validateSnapshot(incompatiblePrimaryMetric), /matching END measured\/model metric fields/)

  const shortCoverage = structuredClone(source)
  shortCoverage.stations[0].months_covered = 8
  assert.throws(() => validateSnapshot(shortCoverage), /months_covered in 9\.\.12/)

  const partialOverride = structuredClone(source)
  partialOverride.stations[0].commensurability = { coord_uncertainty_m: 20 }
  assert.doesNotThrow(() => validateSnapshot(partialOverride), 'partial override must merge network defaults')

  const nonComparableOverride = structuredClone(source)
  nonComparableOverride.stations[0].commensurability = { metric_variant: 'laeq_windows' }
  assert.throws(() => validateSnapshot(nonComparableOverride), /effective band-capable metric_variant/)

  const validTwoSided = structuredClone(source)
  validTwoSided.comparison_mode = 'two_sided'
  validTwoSided.commensurability.dominance = 'near_source'
  validTwoSided.comparison_tolerance_basis = 'Independent source dominance and measurement uncertainty.'
  assert.doesNotThrow(() => validateSnapshot(validTwoSided))
})

test('approved loader requires filename and payload identity to agree', () => {
  const source = readSnapshots().get('dublin-sonitus.2025.json')!
  assert.doesNotThrow(() => validateApprovedSnapshotIdentity(source, 'dublin-sonitus.2025.json'))
  assert.throws(
    () => validateApprovedSnapshotIdentity(source, 'other-network.2025.json'),
    /filename and snapshot network\/year disagree/,
  )
})

test('EBA committed registry reproduces every approved trackside receiver', () => {
  const eba = readSnapshots().get('eba-laermmonitoring.2023.json')!
  const registry = JSON.parse(readFileSync(resolve(REPO_ROOT, 'pipeline/validation/eba-stations.json'), 'utf8')) as {
    stations: Record<string, { lat: number; lng: number; town_centroid: unknown; snap: unknown }>
  }
  assert.equal(Object.keys(registry.stations).length, eba.stations.length)
  for (const station of eba.stations) {
    const frozen = registry.stations[station.station_id]
    assert.ok(frozen, station.station_id)
    assert.equal(frozen.lat, station.lat)
    assert.equal(frozen.lng, station.lng)
    assert.deepEqual(frozen.town_centroid, station.town_centroid)
    assert.deepEqual(frozen.snap, station.snap)
  }
})

const payloadFields: Record<string, string[]> = {
  'barcelona-xarxa-soroll.2025.json': ['station_id', 'name', 'lat', 'lng', 'ld', 'le', 'ln', 'lden', 'months_covered', 'coverage_pct'],
  'dublin-sonitus.2025.json': ['station_id', 'name', 'lat', 'lng', 'ld', 'le', 'ln', 'lden', 'months_covered', 'coverage_pct'],
  'eba-laermmonitoring.2023.json': ['station_id', 'name', 'lat', 'lng', 'laeq_24h', 'laeq_tag_0622', 'laeq_nacht_2206', 'trains_per_day', 'freight_trains_per_day', 'trains_night', 'mean_speed_kmh', 'mean_train_length_m'],
  'zrh-nmt.2024.json': ['station_id', 'name', 'lat', 'lng', 'laeq_tag_0622'],
}

const payloadSha256: Record<string, string> = {
  'barcelona-xarxa-soroll.2025.json': '56228b9ca7fae304697395c4ace799763a26b151e9bd82afd3bcc3c07786f513',
  'dublin-sonitus.2025.json': 'cd72ec4c81a5f67a8b43e7e758f3b21af3624004e35519af0102dfebfdf12451',
  'eba-laermmonitoring.2023.json': 'e9945f0e5f2acc18706a00483edb44f62ee6e1b8f51f1730314486c27ca1f8d2',
  'zrh-nmt.2024.json': '8593f8304902247e3a96021a1e551c8cfce86ba4e050a9ae38aa0bc36e82fbdc',
}

test('approved station payloads and coordinates stay pinned after reviewed deduplication', () => {
  for (const [file, snapshot] of readSnapshots()) {
    const fields = payloadFields[file]
    const payload = snapshot.stations.map(station =>
      Object.fromEntries(fields.map(field => [field, station[field]])),
    )
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    assert.equal(digest, payloadSha256[file], file)
  }
})
