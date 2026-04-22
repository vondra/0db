import type { ReactNode } from 'react'

// Vocabulary shared across Sources (ContributorRow) and Segments
// (SegmentRow) tabs in the noise detail popup. Kept in one place so the
// two views stay visually consistent.

export const SOURCE_LABELS: Record<string, string> = {
  road: 'Roads',
  railway: 'Railways',
  aircraft: 'Aircraft',
  aircraft_ground: 'Aircraft (ground)',
  aircraft_airborne: 'Aircraft (airborne)',
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
    residential_multi: 'Apartment building',
    residential_single: 'House',
    commercial: 'Commercial / retail',
    warehouse: 'Warehouse',
    education: 'School / kindergarten',
    healthcare: 'Hospital / clinic',
    worship: 'Church',
    public: 'Public building',
    hospitality: 'Restaurant / bar',
    garage: 'Garage / parking',
    farm: 'Farm building',
    default: 'Building',
  },
  aircraft: { mixed: 'Aircraft', aircraft: 'Aircraft' },
}

export function subtypeLabel(sourceType: string, subtype: string): string {
  return SUBTYPE_LABELS[sourceType]?.[subtype] || subtype.replace(/_/g, ' ')
}

export function formatDist(m: number): string {
  if (m === 0) return 'overhead'
  if (m < 1000) return `${m} m`
  return `${(m / 1000).toFixed(1)} km`
}

export function lineRow(label: ReactNode, value: ReactNode, muted?: boolean) {
  return (
    <div className={`flex justify-between ${muted ? 'text-muted-foreground/40' : ''}`}>
      <span>{label}</span>
      <span className={muted ? '' : 'text-foreground'}>{value}</span>
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

/** Tooltip explaining the CNOSSOS day/evening/night convention plus the
 * engine's TZ approximation (fixed UTC+1, no DST — see
 * `engine/adsb-to-h3r4/src/segment.rs::period_from_timestamp`). */
export const PERIOD_TOOLTIP =
  'CNOSSOS-EU period buckets:\n' +
  '  Day      07:00–19:00\n' +
  '  Evening  19:00–23:00 (+5 dB penalty)\n' +
  '  Night    23:00–07:00 (+10 dB penalty)\n\n' +
  'Aircraft periods are approximate: the engine applies a fixed\n' +
  'UTC+1 offset for all flights worldwide and does not switch to\n' +
  'CEST during DST (acceptable error band ≤ 1 h). Road/rail traffic\n' +
  'periods come from CNOSSOS day/evening/night percentages, not raw\n' +
  'timestamps, so DST does not apply there.'

/** Shared palette for source/receiver/obstacle markers across noise SVG diagrams. */
export const DIAGRAM_COLORS = {
  source: '#2563eb',
  receiver: '#dc2626',
  terrain: '#8a6a3d',
  forest: '#3f7a3d',
  apex: '#16a34a',
} as const

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
