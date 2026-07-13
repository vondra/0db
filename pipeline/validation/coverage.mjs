/**
 * Pure validation-coverage core shared by the offline report and unit tests.
 * It performs no file/network I/O: callers supply parsed world fixtures,
 * committed network snapshots and the factor vocabulary.
 */
const ANCHOR_TYPES = ['measurement', 'official_map', 'regression']

function authoredTags(tags, label, vocab) {
  if (!Array.isArray(tags)) throw new Error(`${label}: tags must be an array`)
  const seen = new Set()
  for (const tag of tags) {
    if (typeof tag !== 'string' || !Object.hasOwn(vocab.tags ?? {}, tag)) {
      throw new Error(`${label}: unknown factor tag ${JSON.stringify(tag)}`)
    }
    if (seen.has(tag)) throw new Error(`${label}: duplicate factor tag ${JSON.stringify(tag)}`)
    seen.add(tag)
  }
  return tags
}

/** Derived commensurability tags (catalog §11), never authored by adapters. */
export function derivedCoverageTags(anchor, vocab) {
  const tags = []
  const c = anchor.commensurability ?? {}
  const mv = c.metric_variant
  if (mv === 'lden' || mv === 'lden_band') tags.push('metric_lden')
  if (mv === 'ldn_dnl') tags.push('metric_ldn_dnl')
  if (mv === 'cnel') tags.push('metric_cnel')
  if (mv === 'period_split') tags.push('metric_period_split')
  if (anchor.metric_field === 'ln') tags.push('metric_ln_only')
  const rc = c.receiver_convention
  if (rc === 'facade') tags.push('receiver_facade')
  if (rc === 'free_field') tags.push('receiver_free_field')
  if (rc === 'roof') tags.push('receiver_roof')
  if (rc === 'nmt_pole') tags.push('receiver_nmt_pole')
  const cu = c.coord_uncertainty_m
  if (Number.isFinite(cu)) tags.push(cu < 50 ? 'coord_uncertainty_lt50m' : cu < 300 ? 'coord_uncertainty_lt300m' : 'coord_uncertainty_gt300m')
  if (c.dominance === 'total_ambient') tags.push('total_ambient')
  if (c.dominance === 'event_classified') tags.push('event_classified')

  for (const tag of tags) {
    if (!Object.hasOwn(vocab.derived ?? {}, tag)) {
      throw new Error(`factor vocabulary missing derived tag ${JSON.stringify(tag)}`)
    }
  }
  return tags
}

function normalizeAnchor({ id, origin, network = null, anchorType, tags, pairId = null }) {
  if (!ANCHOR_TYPES.includes(anchorType)) throw new Error(`${id}: unknown anchor_type ${JSON.stringify(anchorType)}`)
  return {
    id,
    origin,
    network,
    anchor_type: anchorType,
    tags: [...new Set(tags)],
    pair_id: pairId,
  }
}

/**
 * Flatten curated points and network stations into one coverage population.
 * Snapshot tags are inherited by every station, station tags are additive,
 * and derived commensurability tags come from the snapshot defaults.
 */
export function normalizeCoverageAnchors(points, snapshots, vocab) {
  if (!Array.isArray(points)) throw new Error('world points must be an array')
  if (!Array.isArray(snapshots)) throw new Error('network snapshots must be an array')
  const anchors = []

  for (const point of points) {
    const label = `fixture ${point?.id ?? '(missing id)'}`
    if (!point || typeof point !== 'object' || typeof point.id !== 'string') throw new Error(`${label}: invalid fixture`)
    const tags = authoredTags(point.tags, label, vocab)
    anchors.push(normalizeAnchor({
      id: point.id,
      origin: 'point',
      anchorType: point.anchor_type,
      tags: [...tags, ...derivedCoverageTags(point, vocab)],
      pairId: typeof point.pair_id === 'string' ? point.pair_id : null,
    }))
  }

  for (const snapshot of snapshots) {
    const snapshotLabel = `snapshot ${snapshot?.network ?? '(missing network)'}.${snapshot?.year ?? '(missing year)'}`
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.network !== 'string' || !Number.isInteger(snapshot.year)) {
      throw new Error(`${snapshotLabel}: invalid snapshot identity`)
    }
    if (!Array.isArray(snapshot.stations)) throw new Error(`${snapshotLabel}: stations must be an array`)
    const inherited = authoredTags(snapshot.tags, snapshotLabel, vocab)
    for (const station of snapshot.stations) {
      const stationLabel = `${snapshotLabel}/${station?.station_id ?? '(missing station)'}`
      if (!station || typeof station !== 'object' || typeof station.station_id !== 'string') throw new Error(`${stationLabel}: invalid station`)
      const stationTags = station.tags == null ? [] : authoredTags(station.tags, stationLabel, vocab)
      anchors.push(normalizeAnchor({
        id: `network/${snapshot.network}/${snapshot.year}/${station.station_id}`,
        origin: 'station',
        network: snapshot.network,
        anchorType: snapshot.anchor_type,
        tags: [...inherited, ...stationTags, ...derivedCoverageTags({
          commensurability: { ...snapshot.commensurability, ...(station.commensurability ?? {}) },
          metric_field: snapshot.measured_metric_field,
        }, vocab)],
        pairId: typeof station.pair_id === 'string' ? station.pair_id : null,
      }))
    }
  }
  return anchors
}

function emptyCell() {
  return { points: 0, stations: 0, networks: [] }
}

/** Counts points, stations and distinct station networks for every factor. */
export function summarizeFactorCoverage(anchors, vocab) {
  const summary = new Map()
  for (const tag of Object.keys(vocab.tags ?? {})) {
    summary.set(tag, {
      measurement: emptyCell(),
      official_map: emptyCell(),
      regression: emptyCell(),
    })
  }
  for (const anchor of anchors) {
    for (const tag of anchor.tags) {
      // Derived tags have their own report section and do not live in tags.
      if (!summary.has(tag)) continue
      const cell = summary.get(tag)[anchor.anchor_type]
      if (anchor.origin === 'station') {
        cell.stations++
        if (anchor.network != null && !cell.networks.includes(anchor.network)) cell.networks.push(anchor.network)
      } else {
        cell.points++
      }
    }
  }
  for (const byType of summary.values()) {
    for (const cell of Object.values(byType)) cell.networks.sort()
  }
  return summary
}

/** Same population as main effects: a network station may satisfy an interaction. */
export function summarizePriorityInteractions(anchors, vocab) {
  const pairCounts = new Map()
  for (const anchor of anchors) {
    if (anchor.pair_id) pairCounts.set(anchor.pair_id, (pairCounts.get(anchor.pair_id) ?? 0) + 1)
  }
  return (vocab.interactions ?? []).map(interaction => {
    for (const tag of [...interaction.a, ...interaction.b]) {
      if (!Object.hasOwn(vocab.tags ?? {}, tag) && !Object.hasOwn(vocab.derived ?? {}, tag)) {
        throw new Error(`priority interaction references unknown factor tag ${JSON.stringify(tag)}`)
      }
    }
    const hits = anchors.filter(anchor => {
      const tags = new Set(anchor.tags)
      const aHit = interaction.a.some(tag => tags.has(tag))
      const bHit = interaction.b.length === 0 || interaction.b.some(tag => tags.has(tag))
      const ladderOk = !interaction.requires_ladder || (anchor.pair_id != null && (pairCounts.get(anchor.pair_id) ?? 0) >= 3)
      return aHit && bHit && ladderOk
    })
    return { interaction, hits }
  })
}
