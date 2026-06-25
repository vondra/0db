import type { ReactNode } from 'react'
import type { DatasetProvenance } from '../../types/noise'

// Vocabulary shared across Sources (ContributorRow) and Segments
// (SegmentRow) tabs in the noise detail popup. Kept in one place so the
// two views stay visually consistent.

export const SOURCE_LABELS: Record<string, string> = {
  road: 'Roads',
  railway: 'Railways',
  aircraft: 'Aircraft',
  aircraft_ground: 'Aircraft (ground)',
  aircraft_airborne: 'Aircraft (airborne)',
  aircraft_cruise: 'Aircraft (cruise)',
  industrial: 'Industrial',
  building: 'Buildings',
}

const SUBTYPE_LABELS: Record<string, Record<string, string>> = {
  road: {
    motorway: 'Motorway',
    trunk: 'Trunk road',
    primary: 'Primary road',
    secondary: 'Secondary road',
    tertiary: 'Tertiary road',
    residential: 'Local road',
    living_street: 'Living street',
  },
  railway: {
    freight_corridor: 'Freight railway',
    passenger: 'Railway',
    tram: 'Tram',
    light_rail: 'Light rail',
    rail: 'Railway',
    narrow_gauge: 'Narrow gauge',
    funicular: 'Funicular',
    Rail: 'Railway',
    Tram: 'Tram',
    LightRail: 'Light rail',
    NarrowGauge: 'Narrow gauge',
    Funicular: 'Funicular',
    'Rail (bridge)': 'Railway (bridge)',
    'Tram (bridge)': 'Tram (bridge)',
    'LightRail (bridge)': 'Light rail (bridge)',
    'NarrowGauge (bridge)': 'Narrow gauge (bridge)',
  },
  industrial: {
    industrial_area: 'Industrial area',
    quarry: 'Quarry',
    farm: 'Farm',
    factory: 'Factory',
    wastewater: 'Wastewater plant',
    wind_turbine: 'Wind turbine',
  },
  building: {
    // Keys ARE the backend names (source_names.rs::building_type_name) — keep in
    // sync. Leisure sport areas fold into the building layer, so their names live
    // here too (one source of truth for every building-layer label).
    residential_multi: 'Apartments',
    residential_house: 'House',
    commercial: 'Commercial / office',
    food_retail: 'Shop / supermarket',
    restaurant_bar: 'Restaurant / bar',
    warehouse: 'Warehouse / factory',
    education: 'School',
    healthcare: 'Hospital / clinic',
    worship: 'Church',
    hotel: 'Hotel',
    garage: 'Garage / parking',
    farm: 'Farm',
    public: 'Public building',
    silent: 'Building',
    padel_court: 'Padel court',
    tennis_court: 'Tennis court',
    ball_court: 'Ball court',
    playground: 'Playground',
    swimming_pool: 'Swimming pool',
    outdoor_seating: 'Outdoor seating',
    stadium: 'Stadium',
    sports_pitch: 'Sports pitch',
    default: 'Building',
  },
  aircraft: { mixed: 'Aircraft', aircraft: 'Aircraft' },
}

export function subtypeLabel(sourceType: string, subtype: string): string {
  return SUBTYPE_LABELS[sourceType]?.[subtype] || subtype.replace(/_/g, ' ')
}

const LINE_SOURCE_KINDS = new Set(['road', 'railway', 'aircraft_ground'])

/** True for sources modelled as line sources (Lw expressed as per-meter
 * density L'w in dB(A)/m). Point sources (building / industrial) and
 * airborne aircraft (Doc 29 SEL) return false. */
export function isLineSourceKind(kind: string): boolean {
  return LINE_SOURCE_KINDS.has(kind)
}

/** GeoJSON convention is `[lon, lat]`; backend polylines and hex
 * boundaries arrive as `[lat, lon]` tuples — flip in one place. */
export function flipLatLon([lat, lon]: [number, number]): [number, number] {
  return [lon, lat]
}

export function formatDist(m: number): string {
  if (m === 0) return 'overhead'
  if (m < 1000) return `${m} m`
  return `${(m / 1000).toFixed(1)} km`
}

export function lineRow(label: ReactNode, value: ReactNode, muted?: boolean) {
  return (
    <div className={`flex justify-between gap-3 ${muted ? 'text-muted-foreground/40' : ''}`}>
      <span className="shrink-0">{label}</span>
      <span className={`text-right ${muted ? '' : 'text-foreground'}`}>{value}</span>
    </div>
  )
}

export const PERIOD_LABELS = ['Day', 'Evening', 'Night'] as const

/** Full label with hours for tables / tooltips. */
export const PERIOD_LABELS_DETAIL = [
  'Day (07–19)',
  'Evening (19–23)',
  'Night (23–07)',
] as const

/** Tooltip explaining the CNOSSOS day/evening/night convention.
 * Aircraft periods come from the segment midpoint via IANA timezone + DST
 * (see `engine/aircraft-extract/src/period.rs::period_from_timestamp`). */
export const PERIOD_TOOLTIP =
  'CNOSSOS-EU period buckets (local wall-clock time):\n' +
  '  Day      07:00–19:00\n' +
  '  Evening  19:00–23:00 (+5 dB penalty)\n' +
  '  Night    23:00–07:00 (+10 dB penalty)\n\n' +
  'Aircraft: each segment is classified from its midpoint lat/lon\n' +
  'via the IANA timezone at that coordinate (DST-aware). Road/rail\n' +
  'periods come from CNOSSOS day/evening/night percentages of daily\n' +
  'flow, not per-vehicle timestamps.'

/** Shared palette for source/receiver/obstacle markers across noise SVG diagrams. */
export const DIAGRAM_COLORS = {
  source: '#2563eb',
  receiver: '#dc2626',
  terrain: '#8a6a3d',
  forest: '#3f7a3d',
  apex: '#16a34a',
} as const

/** Unicode subscripts for diffraction-edge labels E₁ / E₂ / E₃. CNOSSOS
 * multi-edge diffraction caps N at 3 (SPEC §3.5); beyond that the caller
 * falls back to base-10 digits. Shared by `PathProfileDiagram` (SVG
 * apex markers) and `SegmentExpanded` (edges-detail tooltip). */
export const EDGE_SUBSCRIPTS = ['₁', '₂', '₃'] as const

// ── Provenance helpers — one unified "Source:" description shared by the
// Noise-sources and Noise-segments tabs so wording stays identical. The
// segments tab uses the same tooltip text as its parent contributor; only
// the granularity differs (per-segment vs grouped-segment aggregates).

export type RoadTrafficSource =
  | 'matched_external'
  | 'estimated_service_tree'
  | 'default_by_class'

export type RailTrainSource = 'arrow' | 'default_by_type'

export function formatProv(p: DatasetProvenance | null | undefined): string {
  if (!p) return ''
  const parts: string[] = [p.name]
  if (p.year != null) parts.push(`(${p.year})`)
  if (p.license) parts.push(`· ${p.license}`)
  return parts.join(' ')
}

/** Road traffic source block. Lines stay ≤ 50 chars so they never wrap in
 * the 28 rem tooltip. Pattern: "Source:" headline, optional URL, one tiny
 * parenthetical method hint. No deep indent, no wrapping. */
export function roadSourceDescription(
  trafficSource: RoadTrafficSource,
  provenance: DatasetProvenance | null | undefined,
  roadClass: string,
): string {
  if (trafficSource === 'matched_external' && provenance) {
    const url = provenance.url ? `\n  ${provenance.url}` : ''
    return (
      `Source: ${formatProv(provenance)}${url}\n` +
      `  (measured AADT per OSM way)`
    )
  }
  if (trafficSource === 'estimated_service_tree') {
    // The "heuristic" tier covers two datasets: the service-tree (local roads,
    // trips accumulated from buildings) and the continuity-fill (major roads,
    // a measured neighbour's AADT carried along the same road). Name whichever
    // it actually is via the dataset; both are estimates, not measurements.
    const name = provenance ? formatProv(provenance) : 'Service-tree heuristic'
    return (
      `Source: ${name} — ${roadClass} class\n` +
      `  (estimated AADT, not a direct measurement)`
    )
  }
  return (
    `Source: CNOSSOS Annex II default — ${roadClass} class\n` +
    `  (no enrichment data in this area)`
  )
}

/** Rail train source block for one category. Same ≤ 50 chars rule. */
export function railTrainSourceLine(
  source: RailTrainSource,
  provenance: DatasetProvenance | null | undefined,
  railType: string,
): string {
  if (source === 'arrow' && provenance) {
    const url = provenance.url ? `\n  ${provenance.url}` : ''
    return (
      `${formatProv(provenance)}${url}\n` +
      `  (measured daily count per OSM way)`
    )
  }
  return (
    `CNOSSOS Annex IV default — ${railType}\n` +
    `  (no enrichment data)`
  )
}

/**
 * GeoJSON LineString from two lat/lon pairs (input order [lat, lon]). Used to
 * highlight a segment's or flight's geometry on the map; output coordinate
 * order is [lon, lat] to match GeoJSON conventions.
 */
export function lineStringFromLatLon(
  start: readonly [number, number],
  end: readonly [number, number],
): { type: 'LineString'; coordinates: [number, number][] } {
  return {
    type: 'LineString',
    coordinates: [
      [start[1], start[0]],
      [end[1], end[0]],
    ],
  }
}
