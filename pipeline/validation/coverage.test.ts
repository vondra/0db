import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCoverageAnchors,
  summarizeFactorCoverage,
  summarizePriorityInteractions,
  type FactorVocabulary,
} from './coverage.mjs'

const vocab: FactorVocabulary = {
  tags: {
    mot_free: { section: 'road_source' },
    count_measured: { section: 'road_provenance' },
    primary_urban: { section: 'road_source' },
    rail_count_measured: { section: 'rail_provenance' },
    ic_corridor: { section: 'rail_source' },
    pedestrian_zone: { section: 'settlement_source' },
    dense_urban: { section: 'receiver_context' },
    street_canyon: { section: 'propagation_obstacle' },
  },
  derived: {
    metric_period_split: '',
    receiver_nmt_pole: '',
    receiver_free_field: '',
    coord_uncertainty_lt50m: '',
    total_ambient: '',
  },
  interactions: [
    { a: ['street_canyon'], b: ['primary_urban'], why: 'station interaction' },
    { a: ['count_measured'], b: ['primary_urban'], why: 'road count only' },
  ],
}

const points = [{
  id: 'curated-road',
  anchor_type: 'official_map',
  tags: ['mot_free'],
  commensurability: {},
}]

const snapshots = [{
  network: 'city-one', year: 2025, anchor_type: 'measurement', tags: ['dense_urban'],
  commensurability: {
    metric_variant: 'period_split', dominance: 'total_ambient',
    receiver_convention: 'nmt_pole', coord_uncertainty_m: 15,
  },
  stations: [
    { station_id: 'a', tags: ['pedestrian_zone', 'street_canyon', 'primary_urban'] },
    { station_id: 'b', commensurability: { receiver_convention: 'free_field' } },
  ],
}, {
  network: 'city-two', year: 2025, anchor_type: 'measurement', tags: ['dense_urban'],
  commensurability: {
    metric_variant: 'period_split', dominance: 'total_ambient',
    receiver_convention: 'nmt_pole', coord_uncertainty_m: 15,
  },
  stations: [{ station_id: 'c' }],
}, {
  network: 'rail-one', year: 2025, anchor_type: 'measurement', tags: ['rail_count_measured', 'ic_corridor'],
  commensurability: {},
  stations: [{ station_id: 'r1' }],
}]

test('network anchors inherit snapshot tags and add station + derived tags', () => {
  const anchors = normalizeCoverageAnchors(points, snapshots, vocab)
  const station = anchors.find(anchor => anchor.id === 'network/city-one/2025/a')!
  assert.deepEqual(station.tags.sort(), [
    'coord_uncertainty_lt50m', 'dense_urban', 'metric_period_split',
    'pedestrian_zone', 'primary_urban', 'receiver_nmt_pole',
    'street_canyon', 'total_ambient',
  ].sort())
  assert.equal(station.origin, 'station')
  assert.equal(station.network, 'city-one')
  const partialOverride = anchors.find(anchor => anchor.id === 'network/city-one/2025/b')!
  assert.ok(partialOverride.tags.includes('metric_period_split'), 'snapshot metric default survives partial override')
  assert.ok(partialOverride.tags.includes('receiver_free_field'))
  assert.ok(!partialOverride.tags.includes('receiver_nmt_pole'))
})

test('coverage separates curated points, station count and distinct networks', () => {
  const anchors = normalizeCoverageAnchors(points, snapshots, vocab)
  const summary = summarizeFactorCoverage(anchors, vocab)
  assert.deepEqual(summary.get('dense_urban')!.measurement, {
    points: 0, stations: 3, networks: ['city-one', 'city-two'],
  })
  assert.deepEqual(summary.get('mot_free')!.official_map, {
    points: 1, stations: 0, networks: [],
  })
  assert.deepEqual(summary.get('rail_count_measured')!.measurement, {
    points: 0, stations: 1, networks: ['rail-one'],
  })
})

test('priority interactions may be covered by a station without conflating rail and road counts', () => {
  const anchors = normalizeCoverageAnchors(points, snapshots, vocab)
  const interactions = summarizePriorityInteractions(anchors, vocab)
  assert.deepEqual(interactions[0].hits.map(hit => hit.id), ['network/city-one/2025/a'])
  assert.deepEqual(interactions[1].hits, [], 'rail_count_measured must not satisfy the road count_measured interaction')
})

test('unknown point, snapshot and station tags fail loud', () => {
  assert.throws(
    () => normalizeCoverageAnchors([{ ...points[0], tags: ['typo'] }], [], vocab),
    /unknown factor tag "typo"/,
  )
  assert.throws(
    () => normalizeCoverageAnchors([], [{ ...snapshots[0], tags: ['typo'] }], vocab),
    /unknown factor tag "typo"/,
  )
  const badStation = structuredClone(snapshots[0])
  badStation.stations[0] = { ...badStation.stations[0], tags: ['typo'] }
  assert.throws(() => normalizeCoverageAnchors([], [badStation], vocab), /unknown factor tag "typo"/)
})
