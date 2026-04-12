import { useEffect, useState, type ReactNode } from 'react'
import { useMap, Source, Layer } from 'react-map-gl/maplibre'
import { ldenToColor } from '../utils/noise-colors'
import { MetricLabel, DataPoint } from './noise/noise-tooltips'
import { HoverText } from './ui/info-tip'

// ── Types matching /api/noise-onfly-v2 response ──

interface SourceSummary {
  source_type: string
  lden: number | null
  lden_free: number | null
  segment_count: number
  displayed_count: number
}

interface PropagationBaseline {
  geometric_db: number
  atmospheric_db: number
  ground_factor: number
  ground_db: number
  total_db: number
}

interface ScreeningObstacleTrace {
  kind: 'building' | 'barrier' | 'none'
  height_m: number
  t: number
  screen_h_m: number
  delta_m: number
  samples_taken: number
  step_m: number
}

interface RoadMetadata {
  kind: 'road'
  aadt_light_raw: number
  aadt_medium_raw: number
  aadt_heavy_raw: number
  aadt_moto_raw: number
  traffic_source: 'census' | 'default_by_class'
  speed_posted_kmh: number
  aadt_light_effective: number
  aadt_medium_effective: number
  aadt_heavy_effective: number
  aadt_moto_effective: number
  speed_kmh: number
  speed_source: 'osm_posted' | 'default_by_class' | 'roundabout_cap'
  road_class: string
  surface: string
  surface_corr_db: number
  lanes: number
  oneway: boolean
  dominant_segment_idx: number
  dominant_distance_m: number
  closest_distance_m: number
  speed_min_kmh: number
  speed_max_kmh: number
  oneway_segment_count: number
  twoway_segment_count: number
  segment_count: number
  total_length_m: number
  bridge_count: number
  obstacle_segment_count: number
  obstacle_avg_height_m: number
  obstacle_max_height_m: number
  obstacle_max_segment_idx: number
}

interface RailMetadata {
  kind: 'rail'
  trains_passenger_raw: number
  trains_freight_raw: number
  trains_passenger_source: 'arrow' | 'default_by_type'
  trains_freight_source: 'arrow' | 'default_by_type'
  maxspeed_posted_kmh: number
  trains_passenger_effective: number
  trains_freight_effective: number
  speed_kmh: number
  speed_source: 'osm_maxspeed' | 'highspeed_default' | 'type_default'
  rail_type: string
  usage: string
  service: boolean
  highspeed: boolean
  parallel_divisor: number
  bridge: boolean
  segment_count: number
  total_length_m: number
  obstacle_segment_count: number
  obstacle_avg_height_m: number
  obstacle_max_height_m: number
  obstacle_max_segment_idx: number
}

interface BuildingMetadata {
  kind: 'building'
  height_m: number
  floors: number
  area_m2: number
  building_type: string
  address: string
}

interface IndustrialMetadata {
  kind: 'industrial'
  area_m2: number
  source_type: string
  nace: string | null
  grid_point_count: number
}

interface AircraftBandData {
  l_day: number
  l_evening: number
  l_night: number
  lmax_peak: number | null
  flights_per_day: number
  helicopter_flights_per_day: number
  faint_flights_per_day: number
  faint_avg_altitude_m: number
  faint_top_aircraft: string
  audible_flights_per_day: number
  audible_avg_altitude_m: number
  audible_top_aircraft: string
  disruptive_flights_per_day: number
  disruptive_avg_altitude_m: number
  disruptive_top_aircraft: string
}

interface AircraftMetadata {
  kind: 'aircraft'
  band_data: AircraftBandData
}

type SourceMetadata =
  | RoadMetadata
  | RailMetadata
  | BuildingMetadata
  | IndustrialMetadata
  | AircraftMetadata

interface Contributor {
  source_type: string
  osm_id: number | null
  name: string
  subtype: string
  distance_m: number
  metadata: SourceMetadata | null
  emission_db: number
  emission_bands: number[]
  baseline: PropagationBaseline
  terrain: { delta_m: number; is_double: boolean; attenuation_db: number; profile_points: number }
  screening: { building_path_m: number; attenuation_db: number; obstacle: ScreeningObstacleTrace | null }
  vegetation: { forest_depth_m: number; attenuation_db: number; sampled_path_m: number }
  received_lden: number
  received_lden_free: number
  received_bands: number[]
  geometry: any | null
}

export interface NoiseComputeData {
  h3_index: string
  h3_center: [number, number]
  elevation_m: number
  total_lden: number | null
  total_lden_free: number | null
  sources: SourceSummary[]
  top_contributors: Contributor[]
  compute_time_ms: number
}

export type { Contributor, SourceSummary }

const SOURCE_LABELS: Record<string, string> = {
  road: 'Roads', railway: 'Railways', aircraft: 'Aircraft',
  industrial: 'Industrial', building: 'Buildings',
}

const SUBTYPE_LABELS: Record<string, Record<string, string>> = {
  road: { motorway: 'Motorway', trunk: 'Trunk road', primary: 'Primary road', secondary: 'Secondary road', tertiary: 'Tertiary road', residential: 'Local road', living_street: 'Living street' },
  railway: { freight_corridor: 'Freight railway', passenger: 'Railway', tram: 'Tram', light_rail: 'Light rail', Rail: 'Railway', Tram: 'Tram', LightRail: 'Light rail', NarrowGauge: 'Narrow gauge', Funicular: 'Funicular', 'Rail (bridge)': 'Railway (bridge)', 'Tram (bridge)': 'Tram (bridge)', 'LightRail (bridge)': 'Light rail (bridge)', 'NarrowGauge (bridge)': 'Narrow gauge (bridge)' },
  industrial: { industrial_area: 'Industrial area', quarry: 'Quarry', farm: 'Farm', factory: 'Factory', wastewater: 'Wastewater plant', wind_turbine: 'Wind turbine' },
  building: { residential_multi: 'Apartment building', residential_single: 'House', commercial: 'Commercial / retail', warehouse: 'Warehouse', education: 'School / kindergarten', healthcare: 'Hospital / clinic', worship: 'Church', public: 'Public building', hospitality: 'Restaurant / bar', garage: 'Garage / parking', farm: 'Farm building', default: 'Building' },
  aircraft: { mixed: 'Aircraft', aircraft: 'Aircraft' },
}

function subtypeLabel(sourceType: string, subtype: string): string {
  return SUBTYPE_LABELS[sourceType]?.[subtype] || subtype.replace(/_/g, ' ')
}

function formatDist(m: number): string {
  if (m === 0) return 'overhead'
  if (m < 1000) return `${m} m`
  return `${(m / 1000).toFixed(1)} km`
}

function fmt(v: number): string {
  return v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)
}

function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('en-US')
}

function fmtCompact(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  return Math.round(v).toString()
}

/**
 * Build a 2-column table-like text block for native title= tooltips.
 * Renders with monospace columns: label padded, value right-aligned.
 * Use \n joins for multi-line. Uses U+2500 box-drawing character for separators.
 */
function txtTable(rows: Array<[string, string] | { sep: true } | string>, labelWidth = 22, valueWidth = 11): string {
  return rows
    .map(r => {
      if (typeof r === 'string') return r
      if ('sep' in r) return '─'.repeat(labelWidth) + '  ' + '─'.repeat(valueWidth)
      const [label, value] = r
      return label.padEnd(labelWidth) + '  ' + value.padStart(valueWidth)
    })
    .join('\n')
}

function AircraftDetail({ d }: { d: AircraftBandData }) {
  const bands: Array<{ label: string; key: 'disruptive' | 'audible' | 'faint'; color: string; descr: string }> = [
    { label: '>60 dB', key: 'disruptive', color: '#ef4444', descr: 'disruptive — clearly audible indoor with windows open, may interrupt sleep / conversation' },
    { label: '>45 dB', key: 'audible', color: '#f59e0b', descr: 'audible — clearly hearable outdoor in quiet rural background' },
    { label: '>30 dB', key: 'faint', color: '#6b7280', descr: 'faint — at the edge of perception, only noticeable in very quiet conditions' },
  ]

  const peakLmaxText = d.lmax_peak != null
    ? txtTable([
        ['Peak Lmax', `${d.lmax_peak.toFixed(1)} dB`],
        '',
        'Single-event maximum noise level',
        'across all flights at this point.',
        'Doc 29 NPD interpolation from the',
        'closest point of approach (CPA),',
        'with installation + atmospheric',
        'corrections. Slant distance + speed',
        'enter the Lmax curve.',
      ], 18, 12)
    : ''

  const periodText = txtTable([
    ['Day (07–19)', `${d.l_day.toFixed(1)} dB`],
    ['Evening (19–23)', `${d.l_evening.toFixed(1)} dB`],
    ['Night (23–07)', `${d.l_night.toFixed(1)} dB`],
    '',
    'Period Leq from Doc 29 SEL energies,',
    'normalized over the dataset days.',
    'Lden = 10·log10[(12·10^(Ld/10) +',
    '4·10^((Le+5)/10) + 8·10^((Ln+10)/10))/24]',
    '(EU END 2002/49/EC).',
  ], 18, 12)

  function bandText(b: typeof bands[number], fpd: number, alt: number, top: string) {
    return txtTable([
      ['Band threshold', `Lmax > ${b.label.replace('>', '').trim()}`],
      ['Flights/day', fpd.toFixed(1)],
      ['Avg altitude', `${alt.toFixed(0)} m`],
      ['Top aircraft', top],
      '',
      b.descr,
      '',
      'Flights/day = unique flight count',
      `whose peak Lmax exceeds ${b.label.trim()},`,
      'divided by dataset days.',
      'Avg altitude = mean CPA altitude',
      'across those flights. Top aircraft',
      'is the most common Doc 29 profile.',
    ], 18, 14)
  }

  return (
    <div className="mt-1 mb-1">
      {d.lmax_peak != null && (
        <div className="flex justify-between text-[11px] mb-1">
          <HoverText title={"Peak Lmax\n\nLoudest single-event level among all\nflights observed at this point.\nMeasured per Doc 29 NPD curves at CPA."}>
            Peak Lmax
          </HoverText>
          <HoverText title={peakLmaxText} className="text-foreground font-bold no-underline">
            {d.lmax_peak.toFixed(1)} dB
          </HoverText>
        </div>
      )}
      <div className="flex justify-between text-[11px] mb-1">
        <HoverText title={"Day / Evening / Night\n\nTime-weighted average noise level over\nstandard EU END periods (07–19, 19–23,\n23–07). Each is the integrated SEL\nenergy normalized to period seconds."}>
          Day/Evening/Night
        </HoverText>
        <HoverText title={periodText} className="text-foreground no-underline">
          {d.l_day.toFixed(1)}/{d.l_evening.toFixed(1)}/{d.l_night.toFixed(1)} dB
        </HoverText>
      </div>
      <table className="w-full text-[10px] mt-1">
        <thead>
          <tr className="text-muted-foreground/60">
            <th className="text-left font-normal pb-0.5">
              <HoverText title={"Band\n\nClassification by single-event Lmax peak:\n>60 dB disruptive, >45 dB audible,\n>30 dB faint. Each flight is counted in\nALL bands its Lmax exceeds."}>Band</HoverText>
            </th>
            <th className="text-right font-normal pb-0.5">
              <HoverText title={"Flights/day\n\nNumber of unique flights whose peak\nLmax falls above the band threshold,\ndivided by the dataset day count."}>Flights/day</HoverText>
            </th>
            <th className="text-right font-normal pb-0.5">
              <HoverText title={"Average altitude\n\nMean above-ground altitude at the\nclosest point of approach (CPA) for\nflights in this band."}>Avg alt</HoverText>
            </th>
            <th className="text-right font-normal pb-0.5">
              <HoverText title={"Top aircraft type\n\nMost common Doc 29 profile (B738, A320,\nA321, Widebody, Turboprop, BizJet,\nLightGA, etc.) among flights in this band."}>Top type</HoverText>
            </th>
          </tr>
        </thead>
        <tbody>
          {bands.map(b => {
            const fpd = d[`${b.key}_flights_per_day`]
            if (fpd === 0) return null
            const alt = d[`${b.key}_avg_altitude_m`]
            const top = d[`${b.key}_top_aircraft`]
            return (
              <tr key={b.key}>
                <td style={{ color: b.color }} className="font-medium">
                  <HoverText title={bandText(b, fpd, alt, top)} className="no-underline" >
                    {b.label}
                  </HoverText>
                </td>
                <td className="text-right">
                  <HoverText title={bandText(b, fpd, alt, top)} className="no-underline">{fpd.toFixed(0)}</HoverText>
                </td>
                <td className="text-right">
                  <HoverText title={bandText(b, fpd, alt, top)} className="no-underline">{alt.toFixed(0)} m</HoverText>
                </td>
                <td className="text-right">
                  <HoverText title={bandText(b, fpd, alt, top)} className="no-underline">{top}</HoverText>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function lineRow(label: ReactNode, value: ReactNode, muted?: boolean) {
  return (
    <div className={`flex justify-between ${muted ? 'text-muted-foreground/40' : ''}`}>
      <span>{label}</span>
      <span className={muted ? '' : 'text-foreground'}>{value}</span>
    </div>
  )
}

/** Pretty renderer for source-specific metadata (typed per discriminant). */
function MetadataRows({ c }: { c: Contributor }) {
  const m = c.metadata
  if (!m) return null

  if (m.kind === 'road') {
    const effTotal = m.aadt_light_effective + m.aadt_medium_effective + m.aadt_heavy_effective + m.aadt_moto_effective
    const rawTotal = m.aadt_light_raw + m.aadt_medium_raw + m.aadt_heavy_raw + m.aadt_moto_raw
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
    const trafficText = txtTable([
      ['Source', m.traffic_source === 'census' ? 'CZ ŘSD 2020' : `default ${m.road_class}`],
      '',
      'Raw daily (from Arrow):',
      ['  Light', fmtInt(m.aadt_light_raw)],
      ['  Medium', fmtInt(m.aadt_medium_raw)],
      ['  Heavy', fmtInt(m.aadt_heavy_raw)],
      ['  Moto', fmtInt(m.aadt_moto_raw)],
      ['  Total raw', `${fmtInt(rawTotal)}/day`],
      '',
      'Effective (post oneway/access/lanes):',
      ['  Light', fmtInt(m.aadt_light_effective)],
      ['  Medium', fmtInt(m.aadt_medium_effective)],
      ['  Heavy', fmtInt(m.aadt_heavy_effective)],
      ['  Moto', fmtInt(m.aadt_moto_effective)],
      { sep: true },
      ['  Total effective', `${fmtInt(effTotal)}/day`],
      '',
      `(at dominant segment, ${Math.round(m.dominant_distance_m)} m away)`,
    ], 18, 12)
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
            {fmtCompact(effTotal)}/day
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
    const speedText = txtTable([
      ['Source', m.speed_source.replace(/_/g, ' ')],
      ['Posted maxspeed', m.maxspeed_posted_kmh > 0 ? `${m.maxspeed_posted_kmh} km/h` : '— (none)'],
      ['Rail type', m.rail_type],
      ['Usage', m.usage],
      ...(m.highspeed ? [['Highspeed flag', 'yes (default 300)'] as [string, string]] : []),
      { sep: true },
      ['Effective', `${m.speed_kmh.toFixed(0)} km/h`],
    ], 18, 14)
    const trainsText = txtTable([
      'Passenger trains:',
      ['  Raw', fmtInt(m.trains_passenger_raw)],
      ['  Effective', fmtInt(m.trains_passenger_effective)],
      ['  Source', m.trains_passenger_source === 'arrow' ? 'CZPTT' : 'default'],
      '',
      'Freight trains:',
      ['  Raw', fmtInt(m.trains_freight_raw)],
      ['  Effective', fmtInt(m.trains_freight_effective)],
      ['  Source', m.trains_freight_source === 'arrow' ? 'E-PRTR' : 'default'],
      '',
      ...(m.service ? ['Service track: ×0.02 factor applied'] : []),
      ...(m.parallel_divisor > 1 ? [`Parallel divisor: ÷${m.parallel_divisor}`] : []),
      ...(m.service || m.parallel_divisor > 1 ? [''] : []),
      { sep: true },
      ['Total effective', `${fmtInt(effTotal)}/day`],
    ], 18, 12)
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
            {fmtInt(effTotal)}/day
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
    return lineRow(
      'Building',
      <span>{m.building_type} · {m.height_m.toFixed(0)} m{m.floors > 0 ? ` · ${m.floors} floors` : ''}</span>,
    )
  }

  if (m.kind === 'industrial') {
    // No 'Industrial industrial_area' duplicate — the row title (subtypeLabel) already says the type.
    // Show only structured metadata that adds info.
    return (
      <>
        {m.area_m2 > 0 && lineRow('Area', `${Math.round(m.area_m2).toLocaleString()} m²`)}
        {m.nace && lineRow('NACE', m.nace)}
        {m.grid_point_count > 0 && lineRow('Grid points', String(m.grid_point_count))}
      </>
    )
  }

  return null
}

function ContributorRow({ c, onToggle }: { c: Contributor; onToggle?: (geometry: any | null) => void }) {
  const [expanded, setExpanded] = useState(false)
  const isAircraft = c.metadata?.kind === 'aircraft'
  const aircraftBand = isAircraft ? (c.metadata as AircraftMetadata).band_data : null

  // Tier 1 summary chip: AADT for roads, trains for rails, flights for aircraft
  const tier1Summary: string | null = (() => {
    const m = c.metadata
    if (!m) return null
    if (m.kind === 'road') {
      const eff = m.aadt_light_effective + m.aadt_medium_effective + m.aadt_heavy_effective + m.aadt_moto_effective
      return eff > 0 ? `${fmtCompact(eff)} veh/day` : null
    }
    if (m.kind === 'rail') {
      const eff = m.trains_passenger_effective + m.trains_freight_effective
      return eff > 0 ? `${fmtInt(eff)} trains/day` : null
    }
    if (m.kind === 'aircraft') {
      return `${m.band_data.flights_per_day.toFixed(0)} flights/day`
    }
    return null
  })()

  const ldenBreakdownText = txtTable([
    ['Free field', `${c.received_lden_free.toFixed(1)} dB`],
    ['Terrain', `${fmt(c.terrain.attenuation_db)} dB`],
    ['Screening', `${fmt(c.screening.attenuation_db)} dB`],
    ['Vegetation', `${fmt(c.vegetation.attenuation_db)} dB`],
    { sep: true },
    ['→ Final Lden', `${c.received_lden.toFixed(1)} dB`],
  ], 14, 9)

  const emissionText = (() => {
    const m = c.metadata
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
    ['Atmospheric absorption', `${fmt(c.baseline.atmospheric_db)} dB`],
    [`Ground effect G=${c.baseline.ground_factor.toFixed(1)}`, `${fmt(c.baseline.ground_db)} dB`],
    { sep: true },
    ['Total', `${fmt(c.baseline.total_db)} dB`],
  ])

  const terrainText = c.terrain.delta_m > 0
    ? txtTable([
        ['Path difference δ', `${c.terrain.delta_m.toFixed(2)} m`],
        ['Diffraction', c.terrain.is_double ? 'double edge' : 'single edge'],
        ['DEM points', String(c.terrain.profile_points)],
        ['Cadence', '30/92/184 m'],
        { sep: true },
        ['Attenuation', `${fmt(c.terrain.attenuation_db)} dB`],
        '',
        'ISO 9613-2 §7.3 + C₃ frequency term',
        'Copernicus GLO-30 DEM (30 m raster).',
      ], 18, 14)
    : txtTable([
        'No terrain obstruction.',
        '',
        '5-point fast LOS check at',
        '25/50/75 % of path — all clear,',
        'so terrain skipped.',
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
    rows.push({ sep: true }, ['Aggregate attenuation', `${fmt(c.screening.attenuation_db)} dB`])
    rows.push('', '30 m building raster, 1D nearest', 'sample (no lateral search).')
    return txtTable(rows, 22, 14)
  })()

  const vegetationText = c.vegetation.sampled_path_m > 0
    ? txtTable([
        ['Forest depth', `${c.vegetation.forest_depth_m.toFixed(0)} m`],
        ['Path sampled', `${c.vegetation.sampled_path_m.toFixed(0)} m`],
        { sep: true },
        ['Attenuation', `${fmt(c.vegetation.attenuation_db)} dB`],
        '',
        'WorldCover 30 m raster.',
        'Contiguous >10 m sections only.',
        'ISO 9613-2 §A.2.2 (capped 200 m).',
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
              ? 'Aircraft'
              : c.name && c.name !== subtypeLabel(c.source_type, c.subtype)
                ? `${c.name} — ${subtypeLabel(c.source_type, c.subtype)}`
                : subtypeLabel(c.source_type, c.subtype)}
          </span>
          {!isAircraft && (
            <span className="text-muted-foreground/60 shrink-0">{formatDist(c.distance_m)}</span>
          )}
          {tier1Summary && (
            <span className="text-muted-foreground/60 shrink-0 text-[10px]">{tier1Summary}</span>
          )}
          <span
            className="font-bold shrink-0 ml-1"
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
        <div className="mt-1 ml-5 mb-1 text-[11px] leading-relaxed font-mono text-muted-foreground">
          {isAircraft && aircraftBand ? (
            <AircraftDetail d={aircraftBand} />
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
                  {fmt(c.baseline.total_db)} dB
                </DataPoint>,
              )}
              {lineRow(
                <MetricLabel term="terrain" />,
                <DataPoint title="Terrain diffraction" text={terrainText}>
                  <span className={c.terrain.attenuation_db < -0.5 ? '' : 'text-muted-foreground/40'}>
                    {fmt(c.terrain.attenuation_db)} dB
                  </span>
                </DataPoint>,
              )}
              {lineRow(
                <MetricLabel term="screening" />,
                <DataPoint title="Screening obstacle" text={screeningText}>
                  <span className={c.screening.attenuation_db < -0.5 ? '' : 'text-muted-foreground/40'}>
                    {fmt(c.screening.attenuation_db)} dB
                  </span>
                </DataPoint>,
              )}
              {lineRow(
                <MetricLabel term="vegetation" />,
                <DataPoint title="Vegetation attenuation" text={vegetationText}>
                  <span className={c.vegetation.attenuation_db < -0.5 ? '' : 'text-muted-foreground/40'}>
                    {fmt(c.vegetation.attenuation_db)} dB
                  </span>
                </DataPoint>,
              )}
            </>
          )}

          {!isAircraft && c.received_bands && c.received_bands.length === 8 && c.received_bands.some(b => b !== 0) && (
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
            <div className="text-right">
              <div className="text-xs text-muted-foreground/60 font-mono leading-tight">
                {data.h3_center[0].toFixed(4)}, {data.h3_center[1].toFixed(4)}
              </div>
              {data.elevation_m > 0 && (
                <div className="text-xs text-muted-foreground/60 font-mono leading-tight">{Math.round(data.elevation_m)} m a.s.l.</div>
              )}
            </div>
          </div>
          <div className="border-b border-border pb-0.5 mb-0.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Noise sources ({data.top_contributors.length})
            </span>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 400px)' }}>
            {(maxSources ? data.top_contributors.slice(0, maxSources) : data.top_contributors).map((c, i) => (
              <ContributorRow key={`${c.source_type}-${c.osm_id}-${i}`} c={c} onToggle={onHighlight} />
            ))}
          </div>
        </>
      ) : (
        <div className="text-sm text-muted-foreground mt-1">No noise data computed for this location.</div>
      )}
    </div>
  )
}

interface DetailPopupProps {
  triggerPosition: { lat: number; lng: number } | null
  onDetailData?: (data: NoiseComputeData | null) => void
  onDetailPositionChange?: (pos: { lat: number; lng: number } | null) => void
  initialDetailPosition?: { lat: number; lng: number } | null
  onSelectedPointChange?: (point: { lat: number; lng: number } | null) => void
}

export default function DetailPopup({ triggerPosition, onDetailData, onDetailPositionChange, initialDetailPosition, onSelectedPointChange }: DetailPopupProps) {
  const { current: map } = useMap()
  const [activePos, setActivePos] = useState<{ lat: number; lng: number } | null>(initialDetailPosition ?? null)

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

      const pos = { lat: e.lngLat.lat, lng: e.lngLat.lng }
      setActivePos(pos)
      onDetailPositionChange?.(pos)
    }

    map.on('mousedown', onMouseDown)
    map.on('click', onClick)
    return () => {
      map.off('mousedown', onMouseDown)
      map.off('click', onClick)
    }
  }, [map, onDetailPositionChange])

  useEffect(() => {
    if (triggerPosition) {
      setActivePos(triggerPosition)
      onDetailPositionChange?.(triggerPosition)
    }
  }, [triggerPosition, onDetailPositionChange])

  useEffect(() => {
    if (!activePos || !map) return
    onSelectedPointChange?.(activePos)

    const controller = new AbortController()
    fetch(`/api/noise-onfly-v2?lat=${activePos.lat}&lng=${activePos.lng}`, { signal: controller.signal })
      .then(res => { if (!res.ok) throw new Error(`API ${res.status}`); return res.json() })
      .then((data: NoiseComputeData) => onDetailData?.(data))
      .catch(err => { if (err.name !== 'AbortError') console.error(err) })

    return () => controller.abort()
  }, [activePos, map, onDetailData])

  return (
    <>
      {activePos && (
        <Source id="clicked-point" type="geojson" data={{
          type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [activePos.lng, activePos.lat] }
        }}>
          <Layer id="clicked-point-marker" type="circle" paint={{
            'circle-radius': 6, 'circle-color': '#3b82f6', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
          }} />
        </Source>
      )}
    </>
  )
}
