import { useEffect, useState } from 'react'
import { useMap, Source, Layer } from 'react-map-gl/maplibre'
import { ldenToColor } from '../utils/noise-colors'
import { MetricLabel, DataPoint } from './noise/noise-tooltips'
import { HoverText } from './ui/info-tip'
import { fmt, fmtInt, fmtCompact, formatCpa, txtTable, type TableRow } from '../utils/formatters'
import { formatDist, lineRow, railTrainSourceLine, roadSourceDescription, SOURCE_LABELS, subtypeLabel } from './noise/shared'
import { SegmentList } from './noise/SegmentList'
import { TabStrip, type PopupTab } from './noise/TabStrip'
import type {
  AircraftTopFlight,
  AircraftMetadata,
  Contributor,
  NoiseComputeData,
} from '../types/noise'

// ── Shared constants ──

import { PERIOD_LABELS, PERIOD_LABELS_DETAIL, PERIOD_TOOLTIP } from './noise/shared'

const PERIOD_COLORS: Record<number, string | undefined> = { 2: '#818cf8', 1: '#f59e0b' }

function TopFlightsTable({ flights, detailed }: { flights: AircraftTopFlight[]; detailed?: boolean }) {
  if (!flights.length) return null
  return (
    <>
      <div className="font-medium mt-2 mb-0.5 text-foreground/70 text-[10px]">
        {detailed ? (
          <HoverText title={"Top flights by energy\n\nThe loudest individual ADS-B flights ranked by their share of total airborne Lden energy at this point. Each row is one unique flight observation.\n\nUseful for diagnosing why noise is unexpectedly high — e.g. a single low-altitude night flight dominating total energy."}>
            Top flights
          </HoverText>
        ) : 'Top flights'}
      </div>
      <table className="w-full text-[10px]">
        <thead>
          <tr className="text-muted-foreground/60">
            <th className="text-left font-normal pb-0.5">#</th>
            <th className="text-right font-normal pb-0.5">
              {detailed ? <HoverText title={"Lmax (dB)\n\nPeak single-event maximum sound level for this flight at this point.\nComputed as SEL − 12 dB (typical exposure duration correction).\nHigher Lmax = louder individual flyover."}>Lmax</HoverText> : 'Lmax'}
            </th>
            <th className="text-right font-normal pb-0.5">
              {detailed ? <HoverText title={"CPA distance (m)\n\nClosest Point of Approach — the shortest 3D slant distance from the flight track to this receiver point.\nComputed on the infinite line extension of the segment (Doc 29 §4.4.1).\nSmaller CPA = louder."}>CPA</HoverText> : 'CPA'}
            </th>
            <th className="text-right font-normal pb-0.5">
              {detailed ? <HoverText title={"Altitude (m)\n\nAircraft altitude above receiver at the closest point of approach.\nDerived from ADS-B barometric altitude minus receiver ground elevation.\nVery low values (<100 m) may indicate ADS-B altitude glitches."}>Alt</HoverText> : 'Alt'}
            </th>
            <th className="text-right font-normal pb-0.5">
              {detailed ? <HoverText title={`Date & period\n\n${PERIOD_TOOLTIP}`}>Date</HoverText> : 'Date'}
            </th>
            <th className="text-right font-normal pb-0.5">
              {detailed ? <HoverText title={"Aircraft type\n\nDoc 29 NPD profile category assigned during ADS-B processing:\n  B738 = Boeing 737 family\n  A320/A321 = Airbus narrowbody\n  Widebody = large twin-aisle\n  Turboprop = propeller transport\n  BizJet = business jet\n  LightGA = light GA + rotorcraft\n  Generic = unclassified"}>Type</HoverText> : 'Type'}
            </th>
            <th className="text-right font-normal pb-0.5">
              {detailed ? <HoverText title={"Energy share (%)\n\nThis flight's contribution to total airborne Lden energy.\n100% = this single flight causes all airborne noise.\nEnergy is in linear (not dB) scale, so a flight with 90%\ndominates even if other flights have similar Lmax."}>%</HoverText> : '%'}
            </th>
          </tr>
        </thead>
        <tbody>
          {flights.map((f, i) => {
            const periodLabel = PERIOD_LABELS[f.period] ?? '?'
            const periodColor = PERIOD_COLORS[f.period]
            const dateShort = f.date ? f.date.slice(5) : ''
            return (
              <tr key={i}>
                <td>{i + 1}</td>
                <td className="text-right font-medium">{f.lmax_db.toFixed(0)}</td>
                <td className="text-right">{formatCpa(f.cpa_distance_m)}</td>
                <td className="text-right">{f.altitude_m.toFixed(0)} m</td>
                <td className="text-right" style={periodColor ? { color: periodColor } : undefined}>
                  {detailed ? (
                    <HoverText title={`${f.date}\n${PERIOD_LABELS_DETAIL[f.period] ?? '?'}`}>
                      {dateShort} {periodLabel}
                    </HoverText>
                  ) : `${dateShort} ${periodLabel}`}
                </td>
                <td className="text-right">{f.profile}</td>
                <td className="text-right text-muted-foreground/60">{f.energy_pct.toFixed(0)}%</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

// Road traffic source / rail train source helpers live in shared.tsx so the
// same tooltip wording is used by both the Noise sources tab (here) and
// the Noise segments tab (SegmentExpanded).

/** Pretty renderer for source-specific metadata (typed per discriminant). */
function MetadataRows({ c }: { c: Contributor }) {
  const m = c.metadata
  if (!m) return null

  if (m.kind === 'road') {
    const nomTotal = m.aadt_light_nominal + m.aadt_medium_nominal + m.aadt_heavy_nominal + m.aadt_moto_nominal
    const effTotal = m.aadt_light_effective + m.aadt_medium_effective + m.aadt_heavy_effective + m.aadt_moto_effective
    const isDefault = m.traffic_source === 'default_by_class'
    const hasSpeedRange = m.speed_min_kmh < m.speed_max_kmh
    const speedText = txtTable([
      ['Source', m.speed_source.replace(/_/g, ' ')],
      ['Posted maxspeed', m.speed_posted_kmh > 0 ? `${m.speed_posted_kmh} km/h` : '— (none)'],
      ['Class default', m.road_class],
      { sep: true },
      ['Dominant seg.', `${m.speed_kmh.toFixed(0)} km/h`],
      ...(hasSpeedRange ? [['Range (group)', `${m.speed_min_kmh.toFixed(0)}–${m.speed_max_kmh.toFixed(0)} km/h`] as [string, string]] : []),
      '',
      'Values from the loudest segment.',
      ...(hasSpeedRange ? ['Speed varies across grouped segments.'] : []),
    ], 18, 12)
    const effRatio = nomTotal > 0 ? effTotal / nomTotal : 1
    const hasPerWayDiscount = Math.abs(effRatio - 1) > 0.01
    const knownOneway = m.oneway ? 0.5 : 1.0
    const residualRatio = effRatio / knownOneway
    const hasResidual = Math.abs(residualRatio - 1) > 0.01
    const sourceLines = roadSourceDescription(m.traffic_source, m.provenance, m.road_class).split('\n')
    const trafficText = txtTable([
      ...sourceLines,
      '',
      'Daily traffic (road total, both directions):',
      ...(m.aadt_light_nominal > 0 ? [['  Light', fmtInt(Math.round(m.aadt_light_nominal))] as [string, string]] : []),
      ...(m.aadt_medium_nominal > 0 ? [['  Medium', fmtInt(Math.round(m.aadt_medium_nominal))] as [string, string]] : []),
      ...(m.aadt_heavy_nominal > 0 ? [['  Heavy', fmtInt(Math.round(m.aadt_heavy_nominal))] as [string, string]] : []),
      ...(m.aadt_moto_nominal > 0 ? [['  Moto', fmtInt(Math.round(m.aadt_moto_nominal))] as [string, string]] : []),
      { sep: true },
      ['  Total', `${fmtInt(Math.round(nomTotal))}/day${isDefault ? '*' : ''}`] as [string, string],
      ...(isDefault ? ['', '* class default (no census match for this segment)'] : []),
      ...(hasPerWayDiscount
        ? [
            '',
            'Engine models per OSM way:',
            ['  Per way', `${fmtInt(Math.round(effTotal))}/day`] as [string, string],
            ...(m.oneway ? [['  ', '× 0.50 one-way split'] as [string, string]] : []),
            ...(hasResidual ? [['  ', `× ${residualRatio.toFixed(2)} access / lanes`] as [string, string]] : []),
          ]
        : []),
      '',
      `(dominant segment, ${Math.round(m.dominant_distance_m)} m away)`,
    ] as TableRow[], 18, 12)
    const segmentsText = txtTable([
      ['Microsegments', String(m.segment_count)],
      ['Total length', `${(m.total_length_m / 1000).toFixed(2)} km`],
      ['Closest point', `${Math.round(m.closest_distance_m)} m`],
      ['Dominant seg.', `#${m.dominant_segment_idx} (${Math.round(m.dominant_distance_m)} m)`],
      ...(m.bridge_count > 0 ? [['Bridge segments', String(m.bridge_count)] as [string, string]] : []),
      '',
      'Grouped by ref + name + class.',
      'Metadata from loudest segment.',
    ], 18, 12)
    const hasMixedOneway = m.oneway_segment_count > 0 && m.twoway_segment_count > 0
    const surfaceText = txtTable([
      ['Type', m.surface],
      ['Rolling correction', `${fmt(m.surface_corr_db)} dB`],
      ['Lanes', String(m.lanes)],
      ['Oneway', m.oneway ? 'yes' : 'no'],
      ...(hasMixedOneway ? [
        '',
        `Group: ${m.oneway_segment_count} oneway + ${m.twoway_segment_count} two-way segs`,
      ] : []),
    ], 18, 12)
    return (
      <>
        {lineRow(
          <MetricLabel term="speed" />,
          <DataPoint title="Speed used in CNOSSOS emission" text={speedText}>
            {hasSpeedRange ? `${m.speed_min_kmh.toFixed(0)}–${m.speed_max_kmh.toFixed(0)}` : m.speed_kmh.toFixed(0)} km/h
          </DataPoint>,
        )}
        {lineRow(
          <MetricLabel term="aadt">Traffic</MetricLabel>,
          <DataPoint title="CNOSSOS vehicle flow" text={trafficText}>
            {`${fmtCompact(Math.round(nomTotal))}/day${isDefault ? '*' : ''}`}
          </DataPoint>,
        )}
        {lineRow(
          <MetricLabel term="segments">Segments</MetricLabel>,
          <DataPoint title="Road aggregation" text={segmentsText}>
            {m.segment_count} · {(m.total_length_m / 1000).toFixed(1)} km
          </DataPoint>,
        )}
        {lineRow(
          <MetricLabel term="surface">Surface</MetricLabel>,
          <DataPoint title="CNOSSOS surface correction" text={surfaceText}>
            {m.surface}
          </DataPoint>,
        )}
      </>
    )
  }

  if (m.kind === 'rail') {
    const effTotal = m.trains_passenger_effective + m.trains_freight_effective
    const rawTotal = m.trains_passenger_raw + m.trains_freight_raw
    const nomTotal = rawTotal > 0 ? rawTotal : effTotal
    const isDefault = m.trains_passenger_source === 'default_by_type'
      && m.trains_freight_source === 'default_by_type'
    const speedText = txtTable([
      ['Source', m.speed_source.replace(/_/g, ' ')],
      ['Posted maxspeed', m.maxspeed_posted_kmh > 0 ? `${m.maxspeed_posted_kmh} km/h` : '— (none)'],
      ['Rail type', m.rail_type],
      ['Usage', m.usage],
      ...(m.highspeed ? [['Highspeed flag', 'yes (default 300)'] as [string, string]] : []),
      { sep: true },
      ['Effective', `${m.speed_kmh.toFixed(0)} km/h`],
    ], 18, 14)
    const trackRatio = nomTotal > 0 ? effTotal / nomTotal : 1
    const hasPerTrackDiscount = Math.abs(trackRatio - 1) > 0.01
    const paxSrcLines = m.trains_passenger_raw > 0
      ? [
          'Passenger source:',
          ...railTrainSourceLine(m.trains_passenger_source, m.provenance, m.rail_type).split('\n').map(l => '  ' + l),
          '',
        ]
      : []
    const frtSrcLines = m.trains_freight_raw > 0
      ? [
          'Freight source:',
          ...railTrainSourceLine(m.trains_freight_source, m.provenance, m.rail_type).split('\n').map(l => '  ' + l),
          '',
        ]
      : []
    const paxCount = m.trains_passenger_raw > 0 ? m.trains_passenger_raw : m.trains_passenger_effective
    const frtCount = m.trains_freight_raw > 0 ? m.trains_freight_raw : m.trains_freight_effective
    const trainsText = txtTable([
      ...paxSrcLines,
      ...frtSrcLines,
      'Daily trains (full line, both directions):',
      ...(paxCount > 0 ? [['  Passenger', fmtInt(Math.round(paxCount))] as [string, string]] : []),
      ...(frtCount > 0 ? [['  Freight', fmtInt(Math.round(frtCount))] as [string, string]] : []),
      { sep: true },
      ['  Total', `${fmtInt(Math.round(nomTotal))}/day${isDefault ? '*' : ''}`],
      ...(isDefault ? ['', '* class default (no timetable match)'] : []),
      ...(hasPerTrackDiscount
        ? [
            '',
            'Engine models per track:',
            ['  Per track', `${fmtInt(Math.round(effTotal))}/day`] as [string, string],
            ...(m.service ? [['  ', '× 0.02 service track'] as [string, string]] : []),
            ...(m.parallel_divisor > 1 ? [['  ', `÷ ${m.parallel_divisor} parallel tracks`] as [string, string]] : []),
          ]
        : []),
    ] as TableRow[], 18, 12)
    const segmentsText = txtTable([
      ['Microsegments', String(m.segment_count)],
      ['Total length', `${(m.total_length_m / 1000).toFixed(2)} km`],
      ...(m.bridge ? [['Bridge', 'yes'] as [string, string]] : []),
    ], 18, 12)
    return (
      <>
        {lineRow(
          <MetricLabel term="speed" />,
          <DataPoint title="Speed used in CNOSSOS rail emission" text={speedText}>
            {m.speed_kmh.toFixed(0)} km/h
          </DataPoint>,
        )}
        {lineRow(
          <MetricLabel term="trains">Trains/day</MetricLabel>,
          <DataPoint title="Daily train count" text={trainsText}>
            {`${fmtInt(Math.round(nomTotal))}/day${isDefault ? '*' : ''}`}
          </DataPoint>,
        )}
        {lineRow(
          <MetricLabel term="segments">Segments</MetricLabel>,
          <DataPoint title="Rail aggregation" text={segmentsText}>
            {m.segment_count} · {(m.total_length_m / 1000).toFixed(1)} km
          </DataPoint>,
        )}
      </>
    )
  }

  if (m.kind === 'building') {
    const buildingText = txtTable([
      ['Type', m.building_type],
      ['Height', `${m.height_m.toFixed(1)} m`],
      ...(m.floors > 0 ? [['Floors', String(m.floors)] as [string, string]] : []),
      ...(m.area_m2 > 0 ? [['Footprint', `${Math.round(m.area_m2).toLocaleString()} m²`] as [string, string]] : []),
      ...(m.address ? ['', `Address: ${m.address}`] : []),
    ], 14, 20)
    return lineRow(
      'Building',
      <DataPoint title="Building metadata" text={buildingText}>
        {m.building_type} · {m.height_m.toFixed(0)} m{m.floors > 0 ? ` · ${m.floors} fl.` : ''}
      </DataPoint>,
    )
  }

  if (m.kind === 'industrial') {
    const hasDetail = m.nace || m.grid_point_count > 0
    const siteText = txtTable([
      ['Type', m.source_type.replace(/_/g, ' ')],
      ...(m.area_m2 > 0 ? [['Area', `${Math.round(m.area_m2).toLocaleString()} m²`] as [string, string]] : []),
      ...(m.nace ? [['NACE', m.nace] as [string, string]] : []),
      ...(m.grid_point_count > 0 ? [['Grid points', String(m.grid_point_count)] as [string, string]] : []),
      ...(m.grid_point_count > 1
        ? ['', 'Large sites discretized into an H3 grid.', 'Each point carries Lw − 10·log₁₀(N).']
        : []),
    ], 16, 16)
    const summary = m.area_m2 > 0
      ? `${Math.round(m.area_m2).toLocaleString()} m²`
      : m.source_type.replace(/_/g, ' ')
    if (!hasDetail && !(m.area_m2 > 0)) return null
    return lineRow(
      'Industrial',
      <DataPoint title="Industrial site metadata" text={siteText}>
        {summary}
      </DataPoint>,
    )
  }

  if (m.kind === 'aircraft') {
    if (m.variant !== 'ground_ops' || !m.ground_ops) return null
    const g = m.ground_ops
    const total = g.observed_movements_per_day + g.modeled_movements_per_day
    const hasModeled = g.modeled_movements_per_day > 0.01
    const movementsText = txtTable([
      'Airport ground operations per day.',
      'Observed from ADS-B where visible; the',
      'rest comes from the airport-surface model.',
      '',
      ['Observed', `${g.observed_movements_per_day.toFixed(1)}/day`],
      ...(hasModeled ? [['Modeled', `${g.modeled_movements_per_day.toFixed(1)}/day`] as [string, string]] : []),
      { sep: true },
      ['Total', `${total.toFixed(1)}/day`],
      '',
      'Per class:',
      ['  Runway roll', `${(g.runway_roll.observed_movements_per_day + g.runway_roll.modeled_movements_per_day).toFixed(1)}/day`],
      ['  Taxi', `${(g.taxi.observed_movements_per_day + g.taxi.modeled_movements_per_day).toFixed(1)}/day`],
      ['  Apron', `${(g.apron_movement.observed_movements_per_day + g.apron_movement.modeled_movements_per_day).toFixed(1)}/day`],
    ] as TableRow[], 16, 12)
    return lineRow(
      'Ground movements',
      <DataPoint title="Airport ground ops per day" text={movementsText}>
        {`${total.toFixed(1)}/day`}
      </DataPoint>,
    )
  }

  return null
}

function ContributorRow({ c, onToggle }: { c: Contributor; onToggle?: (geometry: any | null) => void }) {
  const [expanded, setExpanded] = useState(false)
  const isAircraft = c.metadata?.kind === 'aircraft'
  const aircraftMeta = isAircraft ? (c.metadata as AircraftMetadata) : null
  const aircraftAirborne = aircraftMeta?.variant === 'airborne' ? (aircraftMeta.airborne ?? null) : null
  const aircraftGroundOps = aircraftMeta?.variant === 'ground_ops' ? (aircraftMeta.ground_ops ?? null) : null

  const ldenBreakdownText = aircraftAirborne
    ? txtTable([
        ['Day (07–19)', `${aircraftAirborne.periods.ld_db.toFixed(1)} dB`],
        ['Evening (19–23)', `${aircraftAirborne.periods.le_db.toFixed(1)} dB`],
        ['Night (23–07)', `${aircraftAirborne.periods.ln_db.toFixed(1)} dB`],
        { sep: true },
        ['→ Final Lden', `${aircraftAirborne.periods.lden_db.toFixed(1)} dB`],
      ], 14, 9)
    : txtTable([
        ['Free field', `${c.received_lden_free.toFixed(1)} dB`],
        ['Terrain', `${fmt(c.terrain_impact_db)} dB`],
        ['Screening', `${fmt(c.screening_impact_db)} dB`],
        ['Vegetation', `${fmt(c.vegetation_impact_db)} dB`],
        { sep: true },
        ['→ Final Lden', `${c.received_lden.toFixed(1)} dB`],
      ], 14, 9)

  const emissionText = (() => {
    const m = c.metadata
    if (m?.kind === 'aircraft' && m.variant === 'ground_ops' && m.ground_ops) {
      return txtTable([
        'Airport ground operations',
        'Runway roll + taxi + apron',
        '',
        ['Observed', `${m.ground_ops.observed_movements_per_day.toFixed(1)}/day`],
        ['Modeled', `${m.ground_ops.modeled_movements_per_day.toFixed(1)}/day`],
        { sep: true },
        ['Line source', `${c.emission_db.toFixed(1)} dB`],
      ], 18, 14)
    }
    if (m?.kind === 'road') {
      return txtTable([
        'CNOSSOS-EU rolling + propulsion',
        'Speed-dependent vehicle coefficients',
        '',
        ['Speed', `${m.speed_kmh.toFixed(0)} km/h`],
        ['Surface', m.surface],
        ['Vehicle classes', 'L · M · H · Moto'],
        { sep: true },
        ['Line source', `${c.emission_db.toFixed(1)} dB/m`],
      ], 18, 14)
    }
    if (m?.kind === 'rail') {
      return txtTable([
        'CNOSSOS-EU Annex IV (RMR)',
        'Rolling + traction model',
        '',
        ['Speed', `${m.speed_kmh.toFixed(0)} km/h`],
        ['Trains', `${fmtInt(m.trains_passenger_effective + m.trains_freight_effective)}/day`],
        { sep: true },
        ['Line source', `${c.emission_db.toFixed(1)} dB/m`],
      ], 18, 14)
    }
    return txtTable([
      'Point source Lw',
      'Summed over all sub-points',
      '',
      { sep: true },
      ['Total', `${c.emission_db.toFixed(1)} dB`],
    ], 18, 12)
  })()

  const baselineText = txtTable([
    ['Geometric divergence', `${fmt(c.baseline.geometric_db)} dB`],
    [`Ground factor G`, c.baseline.ground_factor.toFixed(2)],
    '',
    'Divergence is closest-segment only. For',
    'the energy-weighted effect across all',
    'grouped segments, see the per-effect',
    'rows below (A-weighted ΔL_A).',
  ], 22, 14)

  const atmosphericText = txtTable([
    ['Distance', `${c.distance_m.toFixed(0)} m (closest)`],
    { sep: true },
    ['A-weighted ΔL_A', `${fmt(c.atmospheric_impact_db)} dB`],
    '',
    'ISO 9613-2 §7.2 atmospheric absorption',
    '(humid air, 15 °C, 70 % RH). Energy-',
    'weighted across all grouped segments —',
    "full_lden − no_atmospheric_lden.",
  ], 22, 14)

  const groundText = txtTable([
    [`G at closest segment`, c.baseline.ground_factor.toFixed(2)],
    { sep: true },
    ['A-weighted ΔL_A', `${fmt(c.ground_impact_db)} dB`],
    '',
    'ISO 9613-2 §7.3 ground effect.',
    'Signed: over soft ground at 63/125 Hz,',
    'CF[i] < 0 — ground BOOSTS LF energy, so',
    'no_ground can be quieter than full',
    '(positive ΔL_A means ground added dB).',
  ], 22, 14)

  const terrainText = c.terrain.delta_m > 0
    ? txtTable([
        ['Path difference δ', `${c.terrain.delta_m.toFixed(2)} m`],
        ['Diffraction', c.terrain.is_double ? 'double edge' : 'single edge'],
        ['DEM points', String(c.terrain.profile_points)],
        ['Cadence', 'bilateral 30/60/120/240 m'],
        { sep: true },
        ['A-weighted ΔL_A', `${fmt(c.terrain_impact_db)} dB`],
        '',
        'ISO 9613-2 §7.3 + C₃ frequency term',
        'Copernicus GLO-30 DEM (30 m raster).',
        'Unified bilateral sampler — SPEC §3.5a.',
      ], 18, 14)
    : txtTable([
        'No terrain obstruction.',
        '',
        'Unified bilateral sampler scanned the',
        'full path (30/60/120/240 m cadence,',
        'dense near source + receiver); no',
        'sample sits above the line of sight.',
      ], 18, 12)

  const screeningText = (() => {
    const rows: Array<[string, string] | { sep: true } | string> = []
    rows.push('At closest segment:')
    if (c.screening.obstacle && c.screening.obstacle.kind !== 'none') {
      rows.push(
        ['  Obstacle kind', c.screening.obstacle.kind],
        ['  Height', `${c.screening.obstacle.height_m.toFixed(1)} m`],
        ['  Position', `${(c.screening.obstacle.t * 100).toFixed(0)}% of path`],
        ['  Above LoS', `${c.screening.obstacle.screen_h_m.toFixed(1)} m`],
        ['  Fresnel δ', `${c.screening.obstacle.delta_m.toFixed(2)} m`],
        ['  Samples scanned', `${c.screening.obstacle.samples_taken} @ ${c.screening.obstacle.step_m.toFixed(0)} m`],
      )
    } else {
      rows.push(
        ['  Obstacle', 'none on path'],
        ['  Samples scanned', `${c.screening.obstacle?.samples_taken ?? 0} @ ${c.screening.obstacle?.step_m?.toFixed(0) ?? '–'} m`],
      )
    }
    if (c.metadata && (c.metadata.kind === 'road' || c.metadata.kind === 'rail') && c.metadata.segment_count > 1) {
      rows.push('', `Across all ${c.metadata.segment_count} segments:`)
      if (c.metadata.obstacle_segment_count > 0) {
        rows.push(
          ['  With obstacle', `${c.metadata.obstacle_segment_count}/${c.metadata.segment_count}`],
          ['  Avg height', `${c.metadata.obstacle_avg_height_m.toFixed(1)} m`],
          ['  Max height', `${c.metadata.obstacle_max_height_m.toFixed(1)} m`],
          ['  Tallest at segment', `#${c.metadata.obstacle_max_segment_idx}`],
        )
      } else {
        rows.push(['  With obstacle', '0 (all clear)'])
      }
    }
    rows.push({ sep: true }, ['A-weighted ΔL_A', `${fmt(c.screening_impact_db)} dB`])
    rows.push('', 'Overture 30 m building raster,', 'sampled via unified bilateral path', 'profile (SPEC §3.5a).')
    return txtTable(rows, 22, 14)
  })()

  const vegetationText = c.vegetation.sampled_path_m > 0
    ? txtTable([
        ['Forest depth', `${c.vegetation.forest_depth_m.toFixed(0)} m`],
        ['Path sampled', `${c.vegetation.sampled_path_m.toFixed(0)} m`],
        { sep: true },
        ['A-weighted ΔL_A', `${fmt(c.vegetation_impact_db)} dB`],
        '',
        'WorldCover 30 m raster, sampled via',
        'unified bilateral path profile; forest',
        'runs <10 m discarded (ISO 9613-2 §A.2.2,',
        'capped 200 m). SPEC §3.5a.',
      ], 18, 14)
    : "Vegetation skipped\n(segment beyond model's applicable distance)."

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={(e) => {
          e.stopPropagation()
          const next = !expanded
          setExpanded(next)
          onToggle?.(next ? c.geometry : null)
        }}
        className="w-full py-1.5 text-left cursor-pointer hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <div className="flex items-baseline gap-1.5 text-xs px-0">
          <span className="font-medium truncate flex-1">
            {isAircraft
              ? (c.name || (aircraftAirborne ? 'Airborne aircraft' : 'Ground operations'))
              : (c.name || subtypeLabel(c.source_type, c.subtype))}
          </span>
          {(!isAircraft || aircraftGroundOps) ? (
            <span className="text-muted-foreground/60 shrink-0 w-14 text-right tabular-nums">
              {formatDist(c.distance_m)}
            </span>
          ) : (
            <span className="shrink-0 w-14" aria-hidden="true" />
          )}
          <span
            className="font-bold shrink-0 w-14 text-right tabular-nums"
            style={{ color: ldenToColor(c.received_lden) }}
          >
            <DataPoint title="Lden breakdown" text={ldenBreakdownText}>
              {c.received_lden.toFixed(1)} dB
            </DataPoint>
          </span>
          <span className="text-[10px] text-muted-foreground/40 shrink-0">
            {expanded ? '\u25B2' : '\u25BC'}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="mt-1 ml-2 mr-4 mb-1 text-[11px] leading-relaxed font-mono text-muted-foreground">
          {/* Source type — hidden from collapsed row. Traffic / Trains /
              Flights counts are rendered by MetadataRows below, so no
              separate "48 veh/day" line here. */}
          {!isAircraft && c.name && (
            <div className="text-muted-foreground/60 mb-0.5">{subtypeLabel(c.source_type, c.subtype)}</div>
          )}
          {aircraftAirborne ? (
            <>
              {lineRow('Helicopters/day', aircraftAirborne.helicopter_flights_per_day.toFixed(1))}
              {aircraftAirborne.lmax_peak != null && lineRow('Peak Lmax', `${aircraftAirborne.lmax_peak.toFixed(1)} dB`)}
              {lineRow(
                'Day/Evening/Night',
                `${aircraftAirborne.periods.ld_db.toFixed(1)}/${aircraftAirborne.periods.le_db.toFixed(1)}/${aircraftAirborne.periods.ln_db.toFixed(1)} dB`,
              )}
              <table className="w-full text-[10px] mt-1">
                <thead>
                  <tr className="text-muted-foreground/60">
                    <th className="text-left font-normal pb-0.5">Band</th>
                    <th className="text-right font-normal pb-0.5">Events/day</th>
                    <th className="text-right font-normal pb-0.5">Avg alt</th>
                    <th className="text-right font-normal pb-0.5">Top type</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: '>60 dB', bucket: aircraftAirborne.disruptive, color: '#ef4444' },
                    { label: '>45 dB', bucket: aircraftAirborne.audible, color: '#f59e0b' },
                    { label: '>30 dB', bucket: aircraftAirborne.faint, color: '#6b7280' },
                  ].map(({ label, bucket, color }) => (
                    bucket.observed_events_per_day > 0 ? (
                      <tr key={label}>
                        <td style={{ color }} className="font-medium">{label}</td>
                        <td className="text-right">{bucket.observed_events_per_day.toFixed(0)}</td>
                        <td className="text-right">{bucket.avg_altitude_m.toFixed(0)} m</td>
                        <td className="text-right">{bucket.top_aircraft}</td>
                      </tr>
                    ) : null
                  ))}
                </tbody>
              </table>
              {aircraftAirborne.top_flights && <TopFlightsTable flights={aircraftAirborne.top_flights} detailed />}
            </>
          ) : (
            <>
              <MetadataRows c={c} />
              {lineRow(
                <MetricLabel term="emission" />,
                <DataPoint title="CNOSSOS-EU line-source emission" text={emissionText}>
                  {c.emission_db.toFixed(1)} dB
                </DataPoint>,
              )}
              <div className="mt-1.5 mb-0.5 pt-1 border-t border-border/40">
                <div className="text-[9px] uppercase tracking-[0.08em] text-muted-foreground/70">
                  Sound path
                </div>
              </div>
              {lineRow(
                <MetricLabel term="baseline" />,
                <DataPoint title="Baseline propagation breakdown" text={baselineText}>
                  {fmt(c.baseline.geometric_db)} dB
                </DataPoint>,
              )}
              {lineRow(
                'Atmospheric',
                <DataPoint title="Atmospheric absorption (A-weighted)" text={atmosphericText}>
                  <span className={c.atmospheric_impact_db < -0.05 ? '' : 'text-muted-foreground/40'}>
                    {fmt(c.atmospheric_impact_db)} dB
                  </span>
                </DataPoint>,
              )}
              {lineRow(
                `Ground (G=${c.baseline.ground_factor.toFixed(1)})`,
                <DataPoint title="Ground effect (signed A-weighted ΔL_A)" text={groundText}>
                  <span className={Math.abs(c.ground_impact_db) < 0.05 ? 'text-muted-foreground/40' : ''}>
                    {fmt(c.ground_impact_db)} dB
                  </span>
                </DataPoint>,
              )}
              {lineRow(
                <MetricLabel term="terrain" />,
                <DataPoint title="Terrain diffraction" text={terrainText}>
                  <span className={c.terrain_impact_db < -0.5 ? '' : 'text-muted-foreground/40'}>
                    {fmt(c.terrain_impact_db)} dB
                  </span>
                </DataPoint>,
              )}
              {lineRow(
                <MetricLabel term="screening" />,
                <DataPoint title="Screening obstacle" text={screeningText}>
                  <span className={c.screening_impact_db < -0.5 ? '' : 'text-muted-foreground/40'}>
                    {fmt(c.screening_impact_db)} dB
                  </span>
                </DataPoint>,
              )}
              {lineRow(
                <MetricLabel term="vegetation" />,
                <DataPoint title="Vegetation attenuation" text={vegetationText}>
                  <span className={c.vegetation_impact_db < -0.5 ? '' : 'text-muted-foreground/40'}>
                    {fmt(c.vegetation_impact_db)} dB
                  </span>
                </DataPoint>,
              )}
            </>
          )}

          {!aircraftAirborne && c.received_bands && c.received_bands.length === 8 && c.received_bands.some(b => b !== 0) && (
            <div className="mt-1 text-[10px] text-muted-foreground/60">
              <MetricLabel term="per_band">
                [{c.received_bands.map(b => Math.round(b)).join(' ')}]
              </MetricLabel>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export interface NoiseDetailContentProps {
  data: NoiseComputeData
  onHighlight?: (geometry: any | null) => void
  maxSources?: number
}

export function NoiseDetailContent({ data, onHighlight, maxSources }: NoiseDetailContentProps) {
  // Hide silence-sentinel values (sources with no audible contribution at this point).
  // The Rust engine returns periods even for empty source classes; their Lden falls
  // to ~−113 dB (silence) which is meaningless to display in the breakdown.
  const totalLdenText = data.total_lden != null
    ? txtTable([
        ...data.sources
          .filter(s => s.lden != null && s.lden > 0)
          .map(s => [SOURCE_LABELS[s.source_type] ?? s.source_type, `${s.lden!.toFixed(1)} dB`] as [string, string]),
        { sep: true },
        ['Total Lden', `${data.total_lden.toFixed(1)} dB`],
      ], 14, 9)
    : ''

  const [tab, setTab] = useState<PopupTab>('sources')
  const [fullSegments, setFullSegments] = useState<{
    segments: NoiseComputeData['segments']
    airborne: NoiseComputeData['airborne_traces']
    meta: NoiseComputeData['segments_meta']
  } | null>(null)
  const [loadingFull, setLoadingFull] = useState(false)
  // Reset augmented data whenever the user clicks a new point.
  useEffect(() => {
    setFullSegments(null)
    setLoadingFull(false)
  }, [data.h3_center[0], data.h3_center[1]])

  const displaySegments = fullSegments?.segments ?? data.segments ?? []
  const displayAirborne = fullSegments?.airborne ?? data.airborne_traces ?? []
  const displayMeta = fullSegments?.meta ?? data.segments_meta ?? null
  const segmentsTotal = displayMeta?.total_count ?? displaySegments.length
  const hasSegmentsTab = segmentsTotal > 0 || displayAirborne.length > 0
  const showSegments = tab === 'segments' && hasSegmentsTab

  const handleShowAll = async () => {
    if (loadingFull) return
    setLoadingFull(true)
    try {
      const [lat, lng] = data.h3_center
      const r = await fetch(`/api/noise-onfly-v2?lat=${lat}&lng=${lng}&full=1`)
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`)
      const next = (await r.json()) as NoiseComputeData
      setFullSegments({
        segments: next.segments ?? [],
        airborne: next.airborne_traces ?? [],
        meta: next.segments_meta ?? null,
      })
    } finally {
      setLoadingFull(false)
    }
  }

  return (
    <div data-testid="detail-popup" role="dialog" className="px-2.5 pt-1 pb-2" onClick={(e) => e.stopPropagation()}>
      {data.total_lden != null ? (
        <>
          <div className="flex items-center justify-between mb-1">
            <span
              data-testid="noise-badge"
              className="text-2xl font-bold leading-none shrink-0"
              style={{ color: ldenToColor(data.total_lden) }}
            >
              <DataPoint title="Total Lden — energy sum across all sources" text={totalLdenText}>
                {data.total_lden.toFixed(1)} dB
              </DataPoint>
            </span>
            <div className="text-right pr-6">
              <div className="text-xs text-muted-foreground/60 font-mono leading-tight">
                {data.h3_center[0].toFixed(4)}, {data.h3_center[1].toFixed(4)}
              </div>
              {data.elevation_m > 0 && (
                <div className="text-xs text-muted-foreground/60 font-mono leading-tight">{Math.round(data.elevation_m)} m a.s.l.</div>
              )}
            </div>
          </div>
          {hasSegmentsTab ? (
            <TabStrip
              active={tab}
              sourceCount={data.top_contributors.length}
              segmentCount={segmentsTotal}
              onChange={setTab}
            />
          ) : (
            <div className="border-b border-border pb-0.5 mb-0.5">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Noise sources ({data.top_contributors.length})
              </span>
            </div>
          )}
          <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 400px)' }}>
            {/* Both tabs stay mounted so per-row state (expanded) survives tab switches. */}
            <div style={{ display: showSegments ? 'none' : 'block' }}>
              {(maxSources ? data.top_contributors.slice(0, maxSources) : data.top_contributors).map((c, i) => (
                <ContributorRow key={`${c.source_type}-${c.osm_id}-${i}`} c={c} onToggle={onHighlight} />
              ))}
              {data.other_sources_lden !== null && Number.isFinite(data.other_sources_lden) && (
                <div className="flex items-baseline gap-1.5 px-0 py-1.5 border-t border-border/40 text-xs italic text-muted-foreground/70">
                  <span className="truncate flex-1">Other sources</span>
                  {/* Distance-column placeholder — keeps dB aligned with contributor rows above. */}
                  <span className="shrink-0 w-14" aria-hidden="true" />
                  <span className="shrink-0 w-14 text-right tabular-nums">
                    {data.other_sources_lden.toFixed(1)} dB
                  </span>
                  {/* Chevron-sized spacer so the right edge matches contributor rows. */}
                  <span aria-hidden="true" className="text-[10px] shrink-0 invisible">▼</span>
                </div>
              )}
            </div>
            {hasSegmentsTab && (
              <div style={{ display: showSegments ? 'block' : 'none' }}>
                <SegmentList
                  segments={displaySegments}
                  airborne={displayAirborne}
                  meta={displayMeta}
                  receiverLatLon={data.h3_center}
                  onHighlight={onHighlight}
                  onShowAll={handleShowAll}
                  loadingFull={loadingFull}
                />
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="text-sm text-muted-foreground mt-1">No noise data computed for this location.</div>
      )}
    </div>
  )
}

interface DetailPopupProps {
  detailPosition: { lat: number; lng: number } | null
  triggerPosition: { lat: number; lng: number } | null
  onDetailData?: (data: NoiseComputeData | null) => void
  onDetailPositionChange?: (pos: { lat: number; lng: number } | null) => void
}

export default function DetailPopup({ detailPosition, triggerPosition, onDetailData, onDetailPositionChange }: DetailPopupProps) {
  const { current: map } = useMap()

  useEffect(() => {
    if (!map) return
    let dragStart: { x: number; y: number } | null = null

    const onMouseDown = (e: any) => {
      dragStart = { x: e.originalEvent.clientX, y: e.originalEvent.clientY }
    }

    const onClick = (e: any) => {
      if (dragStart) {
        const dx = e.originalEvent.clientX - dragStart.x
        const dy = e.originalEvent.clientY - dragStart.y
        if (Math.sqrt(dx * dx + dy * dy) > 5) return
      }
      if ((e.originalEvent.target as HTMLElement).closest('.maplibregl-popup')) return

      onDetailPositionChange?.({ lat: e.lngLat.lat, lng: e.lngLat.lng })
    }

    map.on('mousedown', onMouseDown)
    map.on('click', onClick)
    return () => {
      map.off('mousedown', onMouseDown)
      map.off('click', onClick)
    }
  }, [map, onDetailPositionChange])

  useEffect(() => {
    if (triggerPosition) onDetailPositionChange?.(triggerPosition)
  }, [triggerPosition, onDetailPositionChange])

  useEffect(() => {
    if (!detailPosition || !map) return

    const controller = new AbortController()
    fetch(`/api/noise-onfly-v2?lat=${detailPosition.lat}&lng=${detailPosition.lng}`, { signal: controller.signal })
      .then(res => { if (!res.ok) throw new Error(`API ${res.status}`); return res.json() })
      .then((data: NoiseComputeData) => onDetailData?.(data))
      .catch(err => {
        if (err.name === 'AbortError') return
        console.error(err)
        // Clear stale selection so UI doesn't stick on a failed point.
        onDetailData?.(null)
        onDetailPositionChange?.(null)
      })

    return () => controller.abort()
  }, [detailPosition, map, onDetailData, onDetailPositionChange])

  return (
    <>
      {detailPosition && (
        <Source id="clicked-point" type="geojson" data={{
          type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [detailPosition.lng, detailPosition.lat] }
        }}>
          <Layer id="clicked-point-marker" type="circle" paint={{
            'circle-radius': 6, 'circle-color': '#3b82f6', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
          }} />
        </Source>
      )}
    </>
  )
}
