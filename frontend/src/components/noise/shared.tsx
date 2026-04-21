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
