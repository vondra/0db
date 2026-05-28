import { useEffect, useState } from 'react'
import { useMap, Source, Layer } from 'react-map-gl/maplibre'
import { ldenToColor } from '../utils/noise-colors'
import { MetricLabel, DataPoint } from './noise/noise-tooltips'
import { HoverText } from './ui/info-tip'
import { fmt, fmtDb, fmtDbValue, fmtFloat, fmtInt, fmtCompact, globeAdsbTraceHref, metersToKm, txtTable, unixToIsoDate, unixToIsoDateTimeUtc, type TableRow } from '../utils/formatters'
import { aircraftFlightTooltip, aircraftTooltip, classToAnchorTypecode, displayTypecode, parseProfileName } from '../utils/aircraft-types'
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
          <HoverText title={"Top flights by Lmax\n\nThe loudest individual ADS-B flights ranked by peak A-weighted Lmax at this point — interleaves both low-altitude airborne (approach / departure) events and high-altitude cruise overflights. Each row is one unique flight observation.\n\nThe `energy %` column is the flight's share of total Lden energy and is only computed for airborne entries; cruise rows show 0 because the bucket aggregates many real flights.\n\nUseful for diagnosing why noise is unexpectedly high — e.g. a single low-altitude night flight dominating total energy."}>
            Top flights
          </HoverText>
        ) : 'Top flights'}
      </div>
      <table className="w-full text-[10px] [&_th]:pl-2 [&_td]:pl-2 [&_:first-child]:pl-0">
        <thead>
          <tr className="text-muted-foreground/60 [&_th]:font-normal [&_th]:pb-0.5">
            <th className="text-right">
              {detailed ? <HoverText title={"Peak A-weighted SPL during this flyover.\n\nLooked up from per-class LAmax NPD tables — EASA ANP v2.3 LAmax curves where available, generated SEL−12 fallback otherwise (manual GA / helicopter profiles, ANP entries without LAmax). Informational display only — the Lden total uses SEL, not Lmax.\n\nFull Doc 29 Eq. 4-12 also applies ΔI / Λ per segment; we skip those (< 2 dB residual). See engine/noise-compute/SPEC.md §5.1."}>Lmax</HoverText> : 'Lmax'}
            </th>
            <th className="text-right">
              {detailed ? <HoverText title={"Closest Point of Approach — shortest 3D slant distance from the flight track to this receiver.\nComputed on the infinite line extension of the segment (Doc 29 §4.4.1).\nSmaller CPA = louder."}>CPA(km)</HoverText> : 'CPA(km)'}
            </th>
            <th className="text-right">
              {detailed ? <HoverText title={"Aircraft altitude above receiver at the closest point of approach.\nDerived from ADS-B barometric altitude minus receiver ground elevation.\nVery low values (<0.10 km) may indicate ADS-B altitude glitches."}>Alt(km)</HoverText> : 'Alt(km)'}
            </th>
            <th className="text-right">
              {detailed ? <HoverText title={`Date & period\n\n${PERIOD_TOOLTIP}`}>Date</HoverText> : 'Date'}
            </th>
            <th className="text-right">
              {detailed ? <HoverText title={"Aircraft type + identity. Cell shows the 4-letter ICAO designator (B738, A320, …) or 'Average NPD' if no real typecode was carried in ADS-B. Click to open the trace on globe.adsb.lol."}>Aircraft</HoverText> : 'Aircraft'}
            </th>
            <th className="text-right">
              {detailed ? <HoverText title={"Energy share (%)\n\nThis flight's contribution to total airborne Lden energy.\n100% = this single flight causes all airborne noise.\nEnergy is in linear (not dB) scale, so a flight with 90%\ndominates even if other flights have similar Lmax."}>%</HoverText> : '%'}
            </th>
          </tr>
        </thead>
        <tbody>
          {flights.map((f, i) => {
            const periodLetter = (PERIOD_LABELS[f.period] ?? '?').charAt(0)
            const periodColor = PERIOD_COLORS[f.period]
            const dateShort = f.date ? f.date.slice(5) : ''
            // Backend `aircraft_type` (extract-time ICAO typecode) is the
            // canonical source. Fall back to the profile-anchor name when
            // typecode metadata was missing or pre-v11 reader.
            const profileTypecode = parseProfileName(f.profile)
            const rawTypecode = f.aircraft_type && f.aircraft_type.length > 0
              ? f.aircraft_type
              : profileTypecode
            const typecodeDisplay = displayTypecode(rawTypecode)
            const isSynth = f.synthetic
            const icaoHex = f.icao_hex ? f.icao_hex.toUpperCase() : null
            const exactTime = f.start_unix != null ? unixToIsoDateTimeUtc(f.start_unix) : null
            const dateTooltip = exactTime
              ? `${exactTime} (flight start)\n${PERIOD_LABELS_DETAIL[f.period] ?? '?'}`
              : `${f.date}\n${PERIOD_LABELS_DETAIL[f.period] ?? '?'}`
            // `synthetic: isSynth` is the authoritative signal; the helper
            // only consults `icaoHex` as a fallback. Pass the raw hex —
            // helper handles the synth-suppression branch internally.
            const aircraftTooltipText = aircraftFlightTooltip({
              typecode: rawTypecode,
              callsign: f.callsign,
              icaoHex,
              synthetic: isSynth,
            })
            // `start_unix` is the flight's first ADS-B sample (≈ takeoff
            // UTC). globe.adsb.lol indexes traces by takeoff date, so an
            // overnight flight peaking after 00:00 UTC would deep-link to
            // the wrong day if we used `f.date` (peak overflight UTC date).
            const traceDate = f.start_unix != null
              ? unixToIsoDate(f.start_unix)
              : f.date
            const globeHref = icaoHex && !isSynth && traceDate
              ? globeAdsbTraceHref(icaoHex, traceDate)
              : null
            return (
              <tr key={i} className="[&_td]:text-right">
                <td className="font-medium">{f.lmax_db.toFixed(0)}&nbsp;dB</td>
                <td>{metersToKm(f.cpa_distance_m)}</td>
                <td>{metersToKm(f.altitude_m)}</td>
                <td className="whitespace-nowrap" style={periodColor ? { color: periodColor } : undefined}>
                  {detailed ? (
                    <HoverText title={dateTooltip}>
                      {dateShort} {periodLetter}
                    </HoverText>
                  ) : `${dateShort} ${periodLetter}`}
                </td>
                <td className="whitespace-nowrap">
                  <HoverText title={aircraftTooltipText}>
                    {globeHref ? (
                      <a href={globeHref} target="_blank" rel="noopener noreferrer" className="hover:underline">
                        {typecodeDisplay}
                      </a>
                    ) : (
                      typecodeDisplay
                    )}
                  </HoverText>
                </td>
                <td className="text-muted-foreground/60">{f.energy_pct.toFixed(0)}%</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

// Road traffic source / rail train source helpers live in shared.tsx so the
// same source-attribution wording is reused here and in the Noise segments
// tab (SegmentExpanded). The per-effect propagation tooltips differ by tab:
// ContributorRow uses `MetricLabel` default mode='public' (plain-language
// descriptions from `descriptionPublic`); SegmentExpanded uses inline
// HoverText with full technical detail (formulas, δ*, Rayleigh gate).

/** Pretty renderer for source-specific metadata (typed per discriminant). */
function MetadataRows({ c }: { c: Contributor }) {
  const m = c.metadata
  if (!m) return null

  if (m.kind === 'road') {
    const nomTotal = m.aadt_light_nominal + m.aadt_medium_nominal + m.aadt_heavy_nominal + m.aadt_moto_nominal
    const effTotal = m.aadt_light_effective + m.aadt_medium_effective + m.aadt_heavy_effective + m.aadt_moto_effective
    // Whole-road total after access/lane coefficients but BEFORE the one-way
    // split (which is a CNOSSOS per-line-source modeling artefact, not a real
    // traffic reduction). For a two-way road it equals effective; for a
    // dual-carriageway mapped as two OSM ways it sums both directions back.
    const onewayFactor = m.oneway ? 0.5 : 1.0
    const wholeRoadTotal = effTotal / onewayFactor
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
    const nomToEff = nomTotal > 0 ? effTotal / nomTotal : 1
    const accessLaneRatio = nomToEff / onewayFactor
    const hasAccessLane = Math.abs(accessLaneRatio - 1) > 0.01
    // Per-category whole-road (= effective / oneway_factor)
    const wholeLight = m.aadt_light_effective / onewayFactor
    const wholeMedium = m.aadt_medium_effective / onewayFactor
    const wholeHeavy = m.aadt_heavy_effective / onewayFactor
    const wholeMoto = m.aadt_moto_effective / onewayFactor
    const sourceLines = roadSourceDescription(m.traffic_source, m.provenance, m.road_class).split('\n')
    const trafficText = txtTable([
      ...sourceLines,
      '',
      'Whole road (both directions):',
      ...(wholeLight > 0 ? [['  Light', fmtInt(Math.round(wholeLight))] as [string, string]] : []),
      ...(wholeMedium > 0 ? [['  Medium', fmtInt(Math.round(wholeMedium))] as [string, string]] : []),
      ...(wholeHeavy > 0 ? [['  Heavy', fmtInt(Math.round(wholeHeavy))] as [string, string]] : []),
      ...(wholeMoto > 0 ? [['  Moto', fmtInt(Math.round(wholeMoto))] as [string, string]] : []),
      { sep: true },
      ['  Total', `${fmtInt(Math.round(wholeRoadTotal))}/day${isDefault ? '*' : ''}`] as [string, string],
      ...(isDefault ? ['', '* class default (no census match for this segment)'] : []),
      ...(hasAccessLane
        ? [
            '',
            'Nominal → whole-road adjustments:',
            ['  Nominal', `${fmtInt(Math.round(nomTotal))}/day`] as [string, string],
            ['  ', `× ${accessLaneRatio.toFixed(2)} access / lanes`] as [string, string],
            { sep: true },
            ['  Whole road', `${fmtInt(Math.round(wholeRoadTotal))}/day`] as [string, string],
          ]
        : []),
      ...(m.oneway
        ? [
            '',
            `One-way ÷ 2 → Lw input per OSM way: ${fmtInt(Math.round(effTotal))}/day`,
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
          <DataPoint title="Daily road traffic (both directions)" text={trafficText}>
            {`${fmtCompact(Math.round(wholeRoadTotal))}/day${isDefault ? '*' : ''}`}
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
    // Whole-line trains (pre-parallel-divisor split). For single-track line
    // equals effective; for a two-track line mapped as two parallel OSM ways
    // sums both tracks back into the full-line figure.
    const parallelDivisor = Math.max(1, m.parallel_divisor || 1)
    const wholeLineTrains = effTotal * parallelDivisor
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
    const paxEff = m.trains_passenger_effective
    const frtEff = m.trains_freight_effective
    const paxWhole = paxEff * parallelDivisor
    const frtWhole = frtEff * parallelDivisor
    const trainsText = txtTable([
      ...paxSrcLines,
      ...frtSrcLines,
      'Whole line (both directions):',
      ...(paxWhole > 0 ? [['  Passenger', fmtInt(Math.round(paxWhole))] as [string, string]] : []),
      ...(frtWhole > 0 ? [['  Freight', fmtInt(Math.round(frtWhole))] as [string, string]] : []),
      { sep: true },
      ['  Total', `${fmtInt(Math.round(wholeLineTrains))}/day${isDefault ? '*' : ''}`],
      ...(isDefault ? ['', '* class default (no timetable match)'] : []),
      ...(hasPerTrackDiscount || m.service
        ? [
            '',
            'Adjustments:',
            ['  Nominal', `${fmtInt(Math.round(nomTotal))}/day`] as [string, string],
            ...(m.service ? [['  ', '× 0.02 service track'] as [string, string]] : []),
            ...(m.parallel_divisor > 1 ? [['  ', `÷ ${m.parallel_divisor} parallel tracks (Lw per track)`] as [string, string]] : []),
            { sep: true },
            ['  Per track (Lw input)', `${fmtInt(Math.round(effTotal))}/day`] as [string, string],
          ]
        : []),
    ] as TableRow[], 18, 12)
    const segmentsText = txtTable([
      ['Microsegments', String(m.segment_count)],
      ['Total length', `${(m.total_length_m / 1000).toFixed(2)} km`],
      ['Closest point', `${Math.round(m.closest_distance_m)} m`],
      ['Dominant seg.', `#${m.dominant_segment_idx} (${Math.round(m.dominant_distance_m)} m)`],
      ...(m.bridge ? [['Bridge', 'yes'] as [string, string]] : []),
      '',
      'Metadata from loudest segment.',
    ], 18, 12)
    return (
      <>
        {lineRow(
          <MetricLabel term="speed" />,
          <DataPoint title="Speed at the energy-dominant (loudest) segment in this rail group — matches the road-popup pattern. Earlier this was the closest segment, which misrepresented audible traffic whenever a fast mainline sat farther than a quiet siding." text={speedText}>
            {m.speed_kmh.toFixed(0)} km/h
          </DataPoint>,
        )}
        {lineRow(
          <MetricLabel term="trains">Trains/day</MetricLabel>,
          <DataPoint title="Daily train count at the energy-dominant (loudest) segment, scaled to a whole-line estimate via that segment's parallel-track divisor. Earlier this was the closest segment — misleading whenever a busy mainline sat farther than a quiet siding." text={trainsText}>
            {`${fmtInt(Math.round(wholeLineTrains))}/day${isDefault ? '*' : ''}`}
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
    const total = (g.observed_movements_per_day ?? 0) + (g.modeled_movements_per_day ?? 0)
    const hasModeled = (g.modeled_movements_per_day ?? 0) > 0.01
    const arr = g.arrivals_per_day ?? 0
    const dep = g.departures_per_day ?? 0
    const gseTotal = (g.gse_per_day ?? [0, 0, 0]).reduce((s, v) => s + v, 0)
    const hasGse = gseTotal > 0.05
    const movementsText = txtTable([
      'Airport ground operations per day.',
      'Observed from ADS-B where visible; the',
      'rest comes from the airport-surface model.',
      '',
      ['Observed', `${fmtFloat(g.observed_movements_per_day)}/day`],
      ...(hasModeled ? [['Modeled', `${fmtFloat(g.modeled_movements_per_day)}/day`] as [string, string]] : []),
      { sep: true },
      ['Total', `${fmtFloat(total)}/day`],
      '',
      'Per direction (unique rotations, set-union dedup):',
      ['  Arrivals', `${fmtFloat(arr)}/day`],
      ['  Departures', `${fmtFloat(dep)}/day`],
      '',
      'Per class:',
      ['  Runway roll', `${fmtFloat((g.runway_roll.observed_movements_per_day ?? 0) + (g.runway_roll.modeled_movements_per_day ?? 0))}/day`],
      ['  Taxi', `${fmtFloat((g.taxi.observed_movements_per_day ?? 0) + (g.taxi.modeled_movements_per_day ?? 0))}/day`],
      ['  Apron', `${fmtFloat((g.apron_movement.observed_movements_per_day ?? 0) + (g.apron_movement.modeled_movements_per_day ?? 0))}/day`],
      ...(hasGse
        ? [
            '' as TableRow,
            'Ground support equipment:' as TableRow,
            ['  Light', `${fmtFloat((g.gse_per_day ?? [0, 0, 0])[0])}/day`] as [string, string],
            ['  Medium', `${fmtFloat((g.gse_per_day ?? [0, 0, 0])[1])}/day`] as [string, string],
            ['  Heavy', `${fmtFloat((g.gse_per_day ?? [0, 0, 0])[2])}/day`] as [string, string],
          ]
        : []),
    ] as TableRow[], 16, 12)
    return (
      <>
        {lineRow(
          'Ground movements',
          <DataPoint title="Airport ground ops per day" text={movementsText}>
            {`${total.toFixed(1)}/day`}
          </DataPoint>,
        )}
        {lineRow(
          'Arr / Dep',
          <DataPoint title="Unique rotations per direction" text={movementsText}>
            <span className="tabular-nums">{`${arr.toFixed(1)} / ${dep.toFixed(1)}/day`}</span>
          </DataPoint>,
        )}
        {hasGse && lineRow(
          'GSE',
          <DataPoint title="Ground support equipment events per day" text={movementsText}>
            <span className="tabular-nums">{`${gseTotal.toFixed(1)}/day`}</span>
          </DataPoint>,
        )}
      </>
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
        ['Day (07–19)', fmtDb(aircraftAirborne.periods.ld_db)],
        ['Evening (19–23)', fmtDb(aircraftAirborne.periods.le_db)],
        ['Night (23–07)', fmtDb(aircraftAirborne.periods.ln_db)],
        { sep: true },
        ['→ Final Lden', fmtDb(aircraftAirborne.periods.lden_db)],
      ], 14, 9)
    : txtTable([
        ['Free field', `${c.received_lden_free.toFixed(1)} dB`],
        ['Terrain', `${fmt(c.terrain_impact_db)} dB`],
        ['Screening', `${fmt(c.screening_impact_db)} dB`],
        ['Vegetation', `${fmt(c.vegetation_impact_db)} dB`],
        { sep: true },
        ['→ Final Lden', `${c.received_lden.toFixed(1)} dB`],
      ], 14, 9)

  // Engine truncates to top-3 (`PROFILE_MIX_TOP_N`) WITHOUT
  // renormalizing — shares stay absolute fractions of total
  // ground-ops received energy. When the top-3 leaves a material
  // tail (≥ 5 %), we render an "Other" entry so the chip sums to
  // ~100 % and users don't read 91 % + 6 % + 2 % as a bug.
  // /gg consensus (Gemini + DeepSeek + GPT-5.5).
  const profileMix = aircraftGroundOps?.profile_mix ?? []
  const profileMixPct = (share: number) => `${Math.round(share * 100)}%`
  const profileMixOther = profileMix.length === 0
    ? 0
    : Math.max(0, 1 - profileMix.reduce((s, e) => s + e.share, 0))
  const showOther = Math.round(profileMixOther * 100) >= 5
  const profileMixDisplay: Array<[string, string]> = [
    ...profileMix.map((e) => [displayTypecode(e.rep_typecode), profileMixPct(e.share)] as [string, string]),
    ...(showOther ? [['Other', profileMixPct(profileMixOther)] as [string, string]] : []),
  ]
  const profileMixSummary = profileMix.length === 0
    ? null
    : profileMixDisplay.map(([code, pct]) => `${code} ${pct}`).join(' · ')
  const profileMixText = profileMix.length === 0
    ? null
    : txtTable([
        'Top noise classes by',
        'received energy at this point.',
        '',
        ...profileMixDisplay,
        '',
        'Each class is anchored on a',
        'representative ICAO typecode.',
      ], 18, 8)

  const emissionText = (() => {
    const m = c.metadata
    if (m?.kind === 'aircraft' && m.variant === 'ground_ops' && m.ground_ops) {
      return txtTable([
        'Airport ground operations',
        'Runway roll + taxi + apron',
        '',
        ['Observed', `${fmtFloat(m.ground_ops.observed_movements_per_day)}/day`],
        ['Modeled', `${fmtFloat(m.ground_ops.modeled_movements_per_day)}/day`],
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
    // Ground-ops distance_m is 0 by design (the source surrounds the
    // receiver), so skip the placeholder "Distance: 0 m (closest)". The
    // A-weighted ΔL_A below is the real per-microsegment atmospheric effect.
    ...((aircraftGroundOps
      ? []
      : [['Distance', `${c.distance_m.toFixed(0)} m (closest)`], { sep: true }]) as TableRow[]),
    ['A-weighted ΔL_A', `${fmt(c.atmospheric_impact_db)} dB`],
    '',
    'ISO 9613-2 §7.2 atmospheric absorption',
    '(humid air, 15 °C, 70 % RH). Energy-',
    'weighted across all grouped segments —',
    "full_lden − no_atmospheric_lden.",
  ], 22, 14)

  const groundText = txtTable([
    // Ground ops are a distributed set of microsegments — no single
    // source-level G, so skip the placeholder "G at closest segment: 0.00".
    // The A-weighted ΔL_A below is the real energy-weighted ground effect.
    ...((aircraftGroundOps
      ? []
      : [[`G at closest segment`, c.baseline.ground_factor.toFixed(2)], { sep: true }]) as TableRow[]),
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
              {/* One total the end-user actually asks for: how many aircraft
                  were heard per day. Low airborne approach/departure events +
                  identified high-altitude cruise overflights, summed. The Lmax
                  bands below are the subset of this union crossing each
                  threshold, so they can never exceed it — the old airborne-only
                  headline sat BELOW the >30 dB band count and looked broken.
                  Helicopters are a subset of the airborne total, shown in
                  parentheses. (Dual-phase flights counted in both phases;
                  cruise is the identified-loud set, a lower bound.) */}
              {lineRow(
                <HoverText title={'Total aircraft + helicopter movements heard per day at this point: low airborne approach/departure events plus identified high-altitude cruise overflights, each real flight_id deduped per phase. The Lmax band counts below are the subset crossing each threshold, so they never exceed this total. Helicopters are a subset of the airborne movements (shown in parentheses). Caveats: a single flight crossing both low and high over this exact point is counted in both phases; cruise transits are the identified-loud set, so that part is a lower bound.'}>
                  Aircraft + heli (per day)
                </HoverText>,
                // toFixed(0) matches the band counts below: rounding is
                // monotonic and the total is ≥ every band exactly, so the
                // rounded total is ≥ every rounded band — the headline can
                // never visually read below a band row.
                `${(aircraftAirborne.observed_flights_per_day + aircraftAirborne.cruise_transits_per_day).toFixed(0)}` +
                  (aircraftAirborne.helicopter_flights_per_day >= 0.05
                    ? ` (${aircraftAirborne.helicopter_flights_per_day.toFixed(1)} heli)`
                    : ''),
              )}
              {aircraftAirborne.lmax_peak != null && lineRow('Peak Lmax', `${aircraftAirborne.lmax_peak.toFixed(1)} dB`)}
              {lineRow(
                'Day/Evening/Night',
                `${fmtDbValue(aircraftAirborne.periods.ld_db)}/${fmtDbValue(aircraftAirborne.periods.le_db)}/${fmtDbValue(aircraftAirborne.periods.ln_db)} dB`,
              )}
              <table className="w-full text-[10px] mt-1 [&_th]:pl-2 [&_td]:pl-2 [&_:first-child]:pl-0">
                <thead>
                  <tr className="text-muted-foreground/60 [&_th]:font-normal [&_th]:pb-0.5">
                    <th className="text-left">
                      <HoverText title={"Lmax threshold\n\nPer-event peak A-weighted SPL band looked up from per-class LAmax NPD tables (EASA ANP v2.3 where available, generated SEL−12 fallback for manual GA / helicopter profiles).\nA flight is counted in this band if its Lmax at this point exceeds the threshold."}>Lmax</HoverText>
                    </th>
                    <th className="text-right">
                      <HoverText title={"Observed flights per day\n\nSegments contributing to this Lmax band, divided by n_days from the ADS-B archive (currently 365)."}>Flights/day</HoverText>
                    </th>
                    <th className="text-right">
                      <HoverText title={"Mean aircraft altitude AMSL in this band.\nLow values indicate approach/departure traffic; high values indicate en-route cruise."}>Avg alt(km)</HoverText>
                    </th>
                    <th className="text-right">
                      <HoverText title={"Dominant aircraft type in this band — anchor typecode of the dominant noise class, e.g. B738. 'Average NPD' = the traffic-weighted energy-mean class (no per-typecode profile)."}>Aircraft</HoverText>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: '>60 dB', bucket: aircraftAirborne.disruptive, color: '#ef4444' },
                    { label: '>45 dB', bucket: aircraftAirborne.audible, color: '#f59e0b' },
                    { label: '>30 dB', bucket: aircraftAirborne.faint, color: '#6b7280' },
                  ].map(({ label, bucket, color }) => {
                    if (bucket.observed_events_per_day <= 0) return null
                    const anchor = classToAnchorTypecode(bucket.top_aircraft)
                    // `classToAnchorTypecode` already maps WING_FALLBACK → 'Average NPD',
                    // so the explicit re-mapping that used to live here is gone.
                    const anchorDisplay = anchor
                    return (
                      <tr key={label} className="[&_td]:text-right">
                        <td style={{ color }} className="font-medium !text-left">{label}</td>
                        <td>{bucket.observed_events_per_day.toFixed(0)}</td>
                        <td>{metersToKm(bucket.avg_altitude_m)}</td>
                        <td>
                          <HoverText title={aircraftTooltip(anchor, bucket.top_aircraft)}>
                            {anchorDisplay}
                          </HoverText>
                        </td>
                      </tr>
                    )
                  })}
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
              {profileMixSummary && profileMixText && lineRow(
                'Top types',
                <DataPoint title="Profile mix at receiver" text={profileMixText}>
                  <span className="tabular-nums">{profileMixSummary}</span>
                </DataPoint>,
              )}
              <div className="mt-1.5 mb-0.5 pt-1 border-t border-border/40">
                <div className="text-[9px] uppercase tracking-[0.08em] text-muted-foreground/70">
                  Sound path
                </div>
              </div>
              {/* Ground ops surround the receiver (distance_m = 0 by design),
                  so there's no meaningful single source-level geometric
                  divergence — the contributor baseline is a placeholder 0.
                  Per-microsegment divergence is shown in the Segments tab.
                  Suppress the row here rather than display a bogus "0.0 dB"
                  (the terrain / screening / vegetation / ground impacts below
                  are real, mirrored from the ground-ops metadata). */}
              {!aircraftGroundOps && lineRow(
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
                aircraftGroundOps ? 'Ground' : `Ground (G=${c.baseline.ground_factor.toFixed(1)})`,
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
    meta: NoiseComputeData['segments_meta']
  } | null>(null)
  const [loadingFull, setLoadingFull] = useState(false)
  // Reset augmented data whenever the user clicks a new point.
  useEffect(() => {
    setFullSegments(null)
    setLoadingFull(false)
  }, [data.h3_center[0], data.h3_center[1]])

  const displaySegments = fullSegments?.segments ?? data.segments ?? []
  const displayMeta = fullSegments?.meta ?? data.segments_meta ?? null
  const segmentsTotal = displayMeta?.total_count ?? displaySegments.length
  const hasSegmentsTab = segmentsTotal > 0
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
                  meta={displayMeta}
                  onHighlight={onHighlight}
                  onShowAll={handleShowAll}
                  loadingFull={loadingFull}
                />
              </div>
            )}
          </div>
          <TimingsOverlay timings={data.timings ?? null} />
        </>
      ) : (
        <div className="text-sm text-muted-foreground mt-1">No noise data computed for this location.</div>
      )}
    </div>
  )
}

function TimingsOverlay({ timings }: { timings: NoiseComputeData['timings'] }) {
  if (!timings) return null
  // Sort components by cost so the dominant bucket is visible at a glance.
  const rows: Array<[string, number]> = [
    ['road', timings.road_ms],
    ['rail', timings.rail_ms],
    ['building', timings.building_ms],
    ['industrial', timings.industrial_ms],
    ['ac airborne', timings.aircraft_airborne_ms],
    ['ac cruise', timings.aircraft_cruise_ms],
    ['ac ground', timings.aircraft_ground_ms],
    ['load', timings.load_ms],
    ['collect', timings.collect_ms],
  ]
  const total = rows.reduce((s, [, ms]) => s + ms, 0)
  const sorted = rows.sort((a, b) => b[1] - a[1])
  return (
    <div className="mt-2 pt-1.5 border-t border-border/30 text-[10px] font-mono text-muted-foreground/70 leading-tight">
      <div className="opacity-60 mb-0.5">⏱ popup-timing — Σ {total.toFixed(0)} ms (server, pre-JSON)</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0">
        {sorted.map(([k, ms]) => (
          <div key={k} className="flex justify-between">
            <span className="opacity-80">{k}</span>
            <span className="tabular-nums">{ms.toFixed(0)} ms</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export interface DetailPopupProps {
  detailPosition: { lat: number; lng: number } | null
  triggerPosition: { lat: number; lng: number } | null
  onDetailData?: (data: NoiseComputeData | null) => void
  onDetailPositionChange?: (pos: { lat: number; lng: number } | null) => void
  /// Fired when the noise fetch fails (non-abort). MVP-0: card stays
  /// open showing the position skeleton with an error message instead of
  /// silently unmounting via `onDetailPositionChange(null)` — Gemini
  /// /gg 2026-05-24 CRITICAL.
  onDetailError?: (message: string | null) => void
}

export default function DetailPopup({ detailPosition, triggerPosition, onDetailData, onDetailPositionChange, onDetailError }: DetailPopupProps) {
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
        // Keep `detailPosition` so the card stays open with a skeleton
        // → error state. Clearing position here (the pre-MVP-0 behavior)
        // unmounted the card and lost the user's clicked location.
        onDetailError?.(err instanceof Error ? err.message : String(err))
      })

    return () => controller.abort()
  }, [detailPosition, map, onDetailData, onDetailError])

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
