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

interface NoisePeriodsData {
  ld_db: number
  le_db: number
  ln_db: number
  lden_db: number
}

interface TerrainBreakdownData {
  delta_m: number
  is_double: boolean
  attenuation_db: number
  profile_points: number
}

interface ScreeningBreakdownData {
  building_path_m: number
  attenuation_db: number
  obstacle: ScreeningObstacleTrace | null
}

interface VegetationBreakdownData {
  forest_depth_m: number
  attenuation_db: number
  sampled_path_m: number
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
  traffic_source: 'matched_external' | 'estimated_service_tree' | 'default_by_class'
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

interface AircraftEventBandStats {
  observed_events_per_day: number
  avg_altitude_m: number
  top_aircraft: string
}

interface AircraftAirborneDetail {
  periods: NoisePeriodsData
  observed_flights_per_day: number
  helicopter_flights_per_day: number
  lmax_peak: number | null
  faint: AircraftEventBandStats
  audible: AircraftEventBandStats
  disruptive: AircraftEventBandStats
}

interface AircraftGroundOpsClassDetail {
  periods: NoisePeriodsData
  observed_movements_per_day: number
  modeled_movements_per_day: number
}

interface AircraftGroundOpsDetail {
  periods: NoisePeriodsData
  periods_free: NoisePeriodsData
  observed_movements_per_day: number
  modeled_movements_per_day: number
  distance_m: number
  emission_db: number
  received_bands: number[]
  runway_roll: AircraftGroundOpsClassDetail
  taxi: AircraftGroundOpsClassDetail
  apron_movement: AircraftGroundOpsClassDetail
  baseline: PropagationBaseline
  terrain: TerrainBreakdownData
  screening: ScreeningBreakdownData
  vegetation: VegetationBreakdownData
}

interface AircraftBandData {
  airborne: AircraftAirborneDetail
  ground_ops: AircraftGroundOpsDetail
}

interface AircraftMetadata {
  kind: 'aircraft'
  variant: 'airborne' | 'ground_ops'
  airport_name?: string | null
  airport_key?: string | null
  airborne?: AircraftAirborneDetail | null
  ground_ops?: AircraftGroundOpsDetail | null
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

function roadTrafficSourceLabel(source: RoadMetadata['traffic_source'], roadClass: string): string {
  if (source === 'matched_external') return 'matched traffic dataset'
  if (source === 'estimated_service_tree') return 'estimated local traffic'
  return `default ${roadClass}`
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
  const airborne = d.airborne
  const groundOps = d.ground_ops
  const bands: Array<{ label: string; key: 'disruptive' | 'audible' | 'faint'; color: string; descr: string }> = [
    { label: '>60 dB', key: 'disruptive', color: '#ef4444', descr: 'disruptive — clearly audible indoor with windows open, may interrupt sleep / conversation' },
    { label: '>45 dB', key: 'audible', color: '#f59e0b', descr: 'audible — clearly hearable outdoor in quiet rural background' },
    { label: '>30 dB', key: 'faint', color: '#6b7280', descr: 'faint — at the edge of perception, only noticeable in very quiet conditions' },
  ]
  const movementRows: Array<{ label: string; data: AircraftGroundOpsClassDetail }> = [
    { label: 'Runway roll', data: groundOps.runway_roll },
    { label: 'Taxi', data: groundOps.taxi },
    { label: 'Apron movement', data: groundOps.apron_movement },
  ]

  const peakLmaxText = airborne.lmax_peak != null
    ? txtTable([
        ['Peak Lmax', `${airborne.lmax_peak.toFixed(1)} dB`],
        '',
        'Single-event maximum noise level',
        'across observed ADS-B flights',
        'at this point.',
        'Doc 29 NPD interpolation from the',
        'closest point of approach (CPA),',
        'with installation + atmospheric',
        'corrections. Ground ops are not',
        'part of this peak metric.',
      ], 18, 12)
    : ''

  function bandText(b: typeof bands[number], fpd: number, alt: number, top: string) {
    return txtTable([
      ['Band threshold', `Lmax > ${b.label.replace('>', '').trim()}`],
      ['Observed events/day', fpd.toFixed(1)],
      ['Avg altitude', `${alt.toFixed(0)} m`],
      ['Top aircraft', top],
      '',
      b.descr,
      '',
      'Observed events/day = unique ADS-B',
      'flight events whose peak Lmax',
      `exceeds ${b.label.trim()}, divided by`,
      'dataset days.',
      'Avg altitude = mean CPA altitude',
      'across those flights. Top aircraft',
      'is the most common Doc 29 profile.',
    ], 18, 14)
  }

  return (
    <div className="mt-1 mb-1">
      <div className="text-[11px] font-medium mb-1">Aircraft - airborne</div>
      <div className="flex justify-between text-[11px] mb-1">
        <HoverText title={"Observed flights/day\n\nUnique airborne ADS-B flight events that contribute at this point, normalized by dataset day count."}>
          Observed flights/day
        </HoverText>
        <HoverText
          title={txtTable([
            ['Observed flights/day', airborne.observed_flights_per_day.toFixed(1)],
            ['Helicopters/day', airborne.helicopter_flights_per_day.toFixed(1)],
            '',
            'Airborne section uses observed',
            'ADS-B flight events only.',
          ], 20, 12)}
          className="text-foreground no-underline"
        >
          {airborne.observed_flights_per_day.toFixed(1)}
        </HoverText>
      </div>
      {airborne.lmax_peak != null && (
        <div className="flex justify-between text-[11px] mb-1">
          <HoverText title={"Peak Lmax\n\nLoudest single airborne event among observed ADS-B flights at this point."}>
            Peak Lmax
          </HoverText>
          <HoverText title={peakLmaxText} className="text-foreground font-bold no-underline">
            {airborne.lmax_peak.toFixed(1)} dB
          </HoverText>
        </div>
      )}
      <div className="flex justify-between text-[11px] mb-1">
        <HoverText title={"Day / Evening / Night\n\nAirborne Doc 29 model over standard EU END periods (07–19, 19–23, 23–07)."}>
          Day/Evening/Night
        </HoverText>
        <HoverText
          title={txtTable([
            ['Day (07–19)', `${airborne.periods.ld_db.toFixed(1)} dB`],
            ['Evening (19–23)', `${airborne.periods.le_db.toFixed(1)} dB`],
            ['Night (23–07)', `${airborne.periods.ln_db.toFixed(1)} dB`],
            ['Lden', `${airborne.periods.lden_db.toFixed(1)} dB`],
          ], 18, 12)}
          className="text-foreground no-underline"
        >
          {airborne.periods.ld_db.toFixed(1)}/{airborne.periods.le_db.toFixed(1)}/{airborne.periods.ln_db.toFixed(1)} dB
        </HoverText>
      </div>
      <table className="w-full text-[10px] mt-1">
        <thead>
          <tr className="text-muted-foreground/60">
            <th className="text-left font-normal pb-0.5">
              <HoverText title={"Band\n\nClassification of observed ADS-B flight\nevents by single-event Lmax peak:\n>60 dB disruptive, >45 dB audible,\n>30 dB faint. Each observed flight is\ncounted in ALL bands its Lmax exceeds."}>Band</HoverText>
            </th>
            <th className="text-right font-normal pb-0.5">
              <HoverText title={"Observed airborne events/day\n\nNumber of unique observed ADS-B flights whose peak Lmax falls above the band threshold, divided by the dataset day count."}>Observed/day</HoverText>
            </th>
            <th className="text-right font-normal pb-0.5">
              <HoverText title={"Average altitude\n\nMean above-ground altitude at the\nclosest point of approach (CPA) for\nobserved ADS-B flights in this band."}>Avg alt</HoverText>
            </th>
            <th className="text-right font-normal pb-0.5">
              <HoverText title={"Top aircraft type\n\nMost common Doc 29 profile (B738, A320,\nA321, Widebody, Turboprop, BizJet,\nLightGA, etc.) among observed ADS-B\nflights in this band."}>Top type</HoverText>
            </th>
          </tr>
        </thead>
        <tbody>
          {bands.map(b => {
            const bucket = airborne[b.key]
            const fpd = bucket.observed_events_per_day
            if (fpd === 0) return null
            const alt = bucket.avg_altitude_m
            const top = bucket.top_aircraft
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

      <div className="text-[11px] font-medium mt-3 mb-1">Aircraft - ground ops</div>
      <div className="flex justify-between text-[11px] mb-1">
        <HoverText title={"Observed movements/day\n\nObserved ground movements from ADS-B tracks on runway, taxiway or apron near this point."}>
          Observed movements/day
        </HoverText>
        <HoverText className="text-foreground no-underline" title={"Observed ground movements/day from ADS-B tracks."}>
          {groundOps.observed_movements_per_day.toFixed(1)}
        </HoverText>
      </div>
      <div className="flex justify-between text-[11px] mb-1">
        <HoverText title={"Modeled movements/day\n\nSynthetic airport ground movements added where observed taxi or runway-roll coverage is incomplete."}>
          Modeled movements/day
        </HoverText>
        <HoverText className="text-foreground no-underline" title={"Synthetic ground movements/day added by the airport ground-ops model."}>
          {groundOps.modeled_movements_per_day.toFixed(1)}
        </HoverText>
      </div>
      <div className="flex justify-between text-[11px] mb-1">
        <HoverText title={"Day / Evening / Night\n\nGround ops propagated as line sources with terrain, screening and vegetation path effects."}>
          Day/Evening/Night
        </HoverText>
        <HoverText
          className="text-foreground no-underline"
          title={txtTable([
            ['Day (07–19)', `${groundOps.periods.ld_db.toFixed(1)} dB`],
            ['Evening (19–23)', `${groundOps.periods.le_db.toFixed(1)} dB`],
            ['Night (23–07)', `${groundOps.periods.ln_db.toFixed(1)} dB`],
            ['Lden', `${groundOps.periods.lden_db.toFixed(1)} dB`],
          ], 18, 12)}
        >
          {groundOps.periods.ld_db.toFixed(1)}/{groundOps.periods.le_db.toFixed(1)}/{groundOps.periods.ln_db.toFixed(1)} dB
        </HoverText>
      </div>
      <table className="w-full text-[10px] mt-1">
        <thead>
          <tr className="text-muted-foreground/60">
            <th className="text-left font-normal pb-0.5">Class</th>
            <th className="text-right font-normal pb-0.5">Observed/day</th>
            <th className="text-right font-normal pb-0.5">Modeled/day</th>
            <th className="text-right font-normal pb-0.5">Lden</th>
          </tr>
        </thead>
        <tbody>
          {movementRows.map(row => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td className="text-right">{row.data.observed_movements_per_day.toFixed(1)}</td>
              <td className="text-right">{row.data.modeled_movements_per_day.toFixed(1)}</td>
              <td className="text-right">{Number.isFinite(row.data.periods.lden_db) ? `${row.data.periods.lden_db.toFixed(1)} dB` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-[10px] mt-2 space-y-0.5 text-muted-foreground/80">
        {lineRow('Baseline attenuation', `${fmt(groundOps.baseline.total_db)} dB`, true)}
        {lineRow('Terrain', `${fmt(groundOps.terrain.attenuation_db)} dB`, true)}
        {lineRow('Screening', `${fmt(groundOps.screening.attenuation_db)} dB`, true)}
        {lineRow('Vegetation', `${fmt(groundOps.vegetation.attenuation_db)} dB`, true)}
      </div>
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

function formatBandArray(bands: number[]): string {
  return `[${bands.map(b => Number.isFinite(b) ? Math.round(b).toString() : '—').join(' ')}]`
}

function baselineTooltip(baseline: PropagationBaseline): string {
  return txtTable([
    ['Geometric divergence', `${fmt(baseline.geometric_db)} dB`],
    ['Atmospheric absorption', `${fmt(baseline.atmospheric_db)} dB`],
    [`Ground effect G=${baseline.ground_factor.toFixed(1)}`, `${fmt(baseline.ground_db)} dB`],
    { sep: true },
    ['Total', `${fmt(baseline.total_db)} dB`],
  ])
}

function terrainTooltip(terrain: TerrainBreakdownData): string {
  return terrain.delta_m > 0
    ? txtTable([
        ['Path difference δ', `${terrain.delta_m.toFixed(2)} m`],
        ['Diffraction', terrain.is_double ? 'double edge' : 'single edge'],
        ['DEM points', String(terrain.profile_points)],
        { sep: true },
        ['Attenuation', `${fmt(terrain.attenuation_db)} dB`],
      ], 18, 14)
    : txtTable([
        'No terrain obstruction.',
        '',
        'Path stayed clear in DEM profile.',
      ], 18, 12)
}

function screeningTooltip(screening: ScreeningBreakdownData): string {
  const rows: Array<[string, string] | { sep: true } | string> = []
  if (screening.obstacle && screening.obstacle.kind !== 'none') {
    rows.push(
      ['Obstacle kind', screening.obstacle.kind],
      ['Height', `${screening.obstacle.height_m.toFixed(1)} m`],
      ['Position', `${(screening.obstacle.t * 100).toFixed(0)}% of path`],
      ['Above LoS', `${screening.obstacle.screen_h_m.toFixed(1)} m`],
      ['Fresnel δ', `${screening.obstacle.delta_m.toFixed(2)} m`],
    )
  } else {
    rows.push(['Obstacle', 'none on path'])
  }
  rows.push({ sep: true }, ['Aggregate attenuation', `${fmt(screening.attenuation_db)} dB`])
  return txtTable(rows, 18, 14)
}

function vegetationTooltip(vegetation: VegetationBreakdownData): string {
  return vegetation.sampled_path_m > 0
    ? txtTable([
        ['Forest depth', `${vegetation.forest_depth_m.toFixed(0)} m`],
        ['Path sampled', `${vegetation.sampled_path_m.toFixed(0)} m`],
        { sep: true },
        ['Attenuation', `${fmt(vegetation.attenuation_db)} dB`],
      ], 18, 14)
    : 'Vegetation skipped'
}

function AircraftAirborneRow({ d }: { d: AircraftBandData }) {
  const [expanded, setExpanded] = useState(false)
  const airborne = d.airborne
  const ldenBreakdownText = txtTable([
    ['Day (07–19)', `${airborne.periods.ld_db.toFixed(1)} dB`],
    ['Evening (19–23)', `${airborne.periods.le_db.toFixed(1)} dB`],
    ['Night (23–07)', `${airborne.periods.ln_db.toFixed(1)} dB`],
    { sep: true },
    ['→ Final Lden', `${airborne.periods.lden_db.toFixed(1)} dB`],
  ], 14, 9)
  const bands: Array<{ label: string; bucket: AircraftEventBandStats; color: string }> = [
    { label: '>60 dB', bucket: airborne.disruptive, color: '#ef4444' },
    { label: '>45 dB', bucket: airborne.audible, color: '#f59e0b' },
    { label: '>30 dB', bucket: airborne.faint, color: '#6b7280' },
  ]

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={(e) => {
          e.stopPropagation()
          setExpanded(!expanded)
        }}
        className="w-full py-1.5 text-left cursor-pointer hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <div className="flex items-baseline gap-1.5 text-xs px-0">
          <span className="font-medium truncate flex-1">Aircraft - airborne</span>
          <span className="text-muted-foreground/60 shrink-0 text-[10px]">
            {airborne.observed_flights_per_day.toFixed(0)} flights/day
          </span>
          <span
            className="font-bold shrink-0 ml-1"
            style={{ color: ldenToColor(airborne.periods.lden_db) }}
          >
            <DataPoint title="Airborne aircraft Lden" text={ldenBreakdownText}>
              {airborne.periods.lden_db.toFixed(1)} dB
            </DataPoint>
          </span>
          <span className="text-[10px] text-muted-foreground/40 shrink-0">
            {expanded ? '\u25B2' : '\u25BC'}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="mt-1 ml-5 mb-1 text-[11px] leading-relaxed font-mono text-muted-foreground">
          {lineRow('Observed flights/day', airborne.observed_flights_per_day.toFixed(1))}
          {lineRow('Helicopters/day', airborne.helicopter_flights_per_day.toFixed(1))}
          {airborne.lmax_peak != null && lineRow('Peak Lmax', `${airborne.lmax_peak.toFixed(1)} dB`)}
          {lineRow('Day/Evening/Night', `${airborne.periods.ld_db.toFixed(1)}/${airborne.periods.le_db.toFixed(1)}/${airborne.periods.ln_db.toFixed(1)} dB`)}
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
              {bands.map(({ label, bucket, color }) => (
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
        </div>
      )}
    </div>
  )
}

function AircraftGroundOpsRow({ d }: { d: AircraftBandData }) {
  const [expanded, setExpanded] = useState(false)
  const ground = d.ground_ops
  const movementSummary = ground.observed_movements_per_day + ground.modeled_movements_per_day
  const ldenBreakdownText = txtTable([
    ['Free field', `${ground.periods_free.lden_db.toFixed(1)} dB`],
    ['Terrain', `${fmt(ground.terrain.attenuation_db)} dB`],
    ['Screening', `${fmt(ground.screening.attenuation_db)} dB`],
    ['Vegetation', `${fmt(ground.vegetation.attenuation_db)} dB`],
    { sep: true },
    ['→ Final Lden', `${ground.periods.lden_db.toFixed(1)} dB`],
  ], 14, 9)
  const emissionText = txtTable([
    'Airport ground-ops line source',
    'Observed + modeled runway/taxi/apron',
    '',
    { sep: true },
    ['Total', `${ground.emission_db.toFixed(1)} dB`],
  ], 18, 12)

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={(e) => {
          e.stopPropagation()
          setExpanded(!expanded)
        }}
        className="w-full py-1.5 text-left cursor-pointer hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <div className="flex items-baseline gap-1.5 text-xs px-0">
          <span className="font-medium truncate flex-1">Aircraft - ground ops</span>
          <span className="text-muted-foreground/60 shrink-0">{formatDist(ground.distance_m)}</span>
          <span className="text-muted-foreground/60 shrink-0 text-[10px]">
            {movementSummary.toFixed(0)} moves/day
          </span>
          <span
            className="font-bold shrink-0 ml-1"
            style={{ color: ldenToColor(ground.periods.lden_db) }}
          >
            <DataPoint title="Aircraft ground-ops Lden breakdown" text={ldenBreakdownText}>
              {ground.periods.lden_db.toFixed(1)} dB
            </DataPoint>
          </span>
          <span className="text-[10px] text-muted-foreground/40 shrink-0">
            {expanded ? '\u25B2' : '\u25BC'}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="mt-1 ml-5 mb-1 text-[11px] leading-relaxed font-mono text-muted-foreground">
          {lineRow('Observed movements/day', ground.observed_movements_per_day.toFixed(1))}
          {lineRow('Modeled movements/day', ground.modeled_movements_per_day.toFixed(1))}
          {lineRow('Runway roll', `${ground.runway_roll.observed_movements_per_day.toFixed(1)} obs + ${ground.runway_roll.modeled_movements_per_day.toFixed(1)} model`)}
          {lineRow('Taxi', `${ground.taxi.observed_movements_per_day.toFixed(1)} obs + ${ground.taxi.modeled_movements_per_day.toFixed(1)} model`)}
          {lineRow('Apron movement', `${ground.apron_movement.observed_movements_per_day.toFixed(1)} obs + ${ground.apron_movement.modeled_movements_per_day.toFixed(1)} model`)}
          {lineRow(
            <MetricLabel term="emission" />,
            <DataPoint title="Ground-ops source emission" text={emissionText}>
              {ground.emission_db.toFixed(1)} dB
            </DataPoint>,
          )}
          <div className="mt-1.5 mb-0.5 pt-1 border-t border-border/40">
            <div className="text-[9px] uppercase tracking-[0.08em] text-muted-foreground/70">
              Sound path
            </div>
          </div>
          {lineRow(
            <MetricLabel term="baseline" />,
            <DataPoint title="Baseline propagation breakdown" text={baselineTooltip(ground.baseline)}>
              {fmt(ground.baseline.total_db)} dB
            </DataPoint>,
          )}
          {lineRow(
            <MetricLabel term="terrain" />,
            <DataPoint title="Terrain diffraction" text={terrainTooltip(ground.terrain)}>
              <span className={ground.terrain.attenuation_db < -0.5 ? '' : 'text-muted-foreground/40'}>
                {fmt(ground.terrain.attenuation_db)} dB
              </span>
            </DataPoint>,
          )}
          {lineRow(
            <MetricLabel term="screening" />,
            <DataPoint title="Screening obstacle" text={screeningTooltip(ground.screening)}>
              <span className={ground.screening.attenuation_db < -0.5 ? '' : 'text-muted-foreground/40'}>
                {fmt(ground.screening.attenuation_db)} dB
              </span>
            </DataPoint>,
          )}
          {lineRow(
            <MetricLabel term="vegetation" />,
            <DataPoint title="Vegetation attenuation" text={vegetationTooltip(ground.vegetation)}>
              <span className={ground.vegetation.attenuation_db < -0.5 ? '' : 'text-muted-foreground/40'}>
                {fmt(ground.vegetation.attenuation_db)} dB
              </span>
            </DataPoint>,
          )}
          <div className="mt-1 text-[10px] text-muted-foreground/60">
            <MetricLabel term="per_band">
              {formatBandArray(ground.received_bands)}
            </MetricLabel>
          </div>
        </div>
      )}
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
      ['Source', roadTrafficSourceLabel(m.traffic_source, m.road_class)],
      ...(m.traffic_source === 'estimated_service_tree'
        ? [['', 'service-tree model'] as [string, string]]
        : []),
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

  if (m.kind === 'aircraft') {
    if (m.variant !== 'ground_ops' || !m.ground_ops) return null
    const g = m.ground_ops
    return (
      <>
        {lineRow('Observed movements/day', g.observed_movements_per_day.toFixed(1))}
        {lineRow('Modeled movements/day', g.modeled_movements_per_day.toFixed(1))}
        {lineRow(
          'Runway roll',
          `${g.runway_roll.observed_movements_per_day.toFixed(1)} obs + ${g.runway_roll.modeled_movements_per_day.toFixed(1)} model`,
        )}
        {lineRow(
          'Taxi',
          `${g.taxi.observed_movements_per_day.toFixed(1)} obs + ${g.taxi.modeled_movements_per_day.toFixed(1)} model`,
        )}
        {lineRow(
          'Apron movement',
          `${g.apron_movement.observed_movements_per_day.toFixed(1)} obs + ${g.apron_movement.modeled_movements_per_day.toFixed(1)} model`,
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
    if (m.kind === 'aircraft' && m.variant === 'airborne' && m.airborne) {
      const flights = m.airborne.observed_flights_per_day
      return flights > 0 ? `${flights.toFixed(flights >= 10 ? 0 : 1)} flights/day` : null
    }
    if (m.kind === 'aircraft' && m.variant === 'ground_ops' && m.ground_ops) {
      const moves = m.ground_ops.observed_movements_per_day + m.ground_ops.modeled_movements_per_day
      return moves > 0 ? `${moves.toFixed(moves >= 10 ? 0 : 1)} moves/day` : null
    }
    return null
  })()

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
        ['Terrain', `${fmt(c.terrain.attenuation_db)} dB`],
        ['Screening', `${fmt(c.screening.attenuation_db)} dB`],
        ['Vegetation', `${fmt(c.vegetation.attenuation_db)} dB`],
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
              ? (c.name || (aircraftAirborne ? 'Airborne aircraft' : 'Ground operations'))
              : (c.name || subtypeLabel(c.source_type, c.subtype))}
          </span>
          {(!isAircraft || aircraftGroundOps) && (
            <span className="text-muted-foreground/60 shrink-0">{formatDist(c.distance_m)}</span>
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
          {/* Source type + activity summary — hidden from collapsed row */}
          {!isAircraft && c.name && (
            <div className="text-muted-foreground/60 mb-0.5">{subtypeLabel(c.source_type, c.subtype)}</div>
          )}
          {tier1Summary && (
            <div className="text-muted-foreground/60 mb-0.5">{tier1Summary}</div>
          )}
          {aircraftAirborne ? (
            <>
              {lineRow('Observed flights/day', aircraftAirborne.observed_flights_per_day.toFixed(1))}
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
