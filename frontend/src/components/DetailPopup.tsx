import { useEffect, useState } from 'react'
import { useMap, Source, Layer } from 'react-map-gl/maplibre'
import { ldenToColor } from '../utils/noise-colors'

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

interface Contributor {
  source_type: string
  osm_id: number | null
  name: string
  subtype: string
  distance_m: number
  metadata: Record<string, string | number>
  emission_db: number
  emission_bands: number[]
  baseline: PropagationBaseline
  terrain: { delta_m: number; is_double: boolean; attenuation_db: number }
  screening: { building_path_m: number; attenuation_db: number }
  vegetation: { forest_depth_m: number; attenuation_db: number }
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
  railway: { freight_corridor: 'Freight railway', passenger: 'Railway', tram: 'Tram', light_rail: 'Light rail', Rail: 'Railway', Tram: 'Tram', LightRail: 'Light rail', NarrowGauge: 'Narrow gauge', Funicular: 'Funicular' },
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

function AircraftDetail({ m }: { m: Record<string, string | number> }) {
  if (!m.v33) return null
  const bands = [
    { label: '>60 dB', key: 'disruptive', color: '#ef4444' },
    { label: '>45 dB', key: 'audible', color: '#f59e0b' },
    { label: '>30 dB', key: 'faint', color: '#6b7280' },
  ]
  return (
    <div className="mt-1 mb-1">
      {m.lmax_peak != null && (
        <div className="flex justify-between text-[11px] mb-1">
          <span>Peak Lmax</span>
          <span className="text-foreground font-bold">{Number(m.lmax_peak).toFixed(1)} dB</span>
        </div>
      )}
      <div className="flex justify-between text-[11px] mb-1">
        <span>Day/Evening/Night</span>
        <span>{Number(m.l_day).toFixed(1)}/{Number(m.l_evening).toFixed(1)}/{Number(m.l_night).toFixed(1)} dB</span>
      </div>
      <table className="w-full text-[10px] mt-1">
        <thead>
          <tr className="text-muted-foreground/60">
            <th className="text-left font-normal pb-0.5">Band</th>
            <th className="text-right font-normal pb-0.5">Flights/day</th>
            <th className="text-right font-normal pb-0.5">Avg alt</th>
            <th className="text-right font-normal pb-0.5">Top type</th>
          </tr>
        </thead>
        <tbody>
          {bands.map(b => {
            const fpd = Number(m[`${b.key}_flights_per_day`] || 0)
            if (fpd === 0) return null
            return (
              <tr key={b.key}>
                <td style={{ color: b.color }} className="font-medium">{b.label}</td>
                <td className="text-right">{fpd.toFixed(0)}</td>
                <td className="text-right">{Number(m[`${b.key}_avg_altitude_m`] || 0).toFixed(0)} m</td>
                <td className="text-right">{m[`${b.key}_top_aircraft`]}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ContributorRow({ c, onToggle }: { c: Contributor; onToggle?: (geometry: any | null) => void }) {
  const [expanded, setExpanded] = useState(false)
  const isAircraftV33 = c.source_type === 'aircraft' && c.metadata.v33
  const metaStr = isAircraftV33
    ? `${Number(c.metadata.flights_per_day || 0).toFixed(0)} flights/day`
    : Object.entries(c.metadata).map(([k, v]) => `${k}: ${v}`).join('  ')

  return (
    <div
      className="py-1.5 border-b border-border/50 last:border-b-0 cursor-pointer hover:bg-muted/30"
      onClick={(e) => { e.stopPropagation(); const next = !expanded; setExpanded(next); onToggle?.(next ? c.geometry : null) }}
    >
      <div className="flex items-baseline gap-1.5 text-xs">
        <span className="font-medium truncate flex-1" title={c.name || c.subtype}>
          {isAircraftV33 ? 'Aircraft' : c.name && c.name !== subtypeLabel(c.source_type, c.subtype) ? `${c.name} — ${subtypeLabel(c.source_type, c.subtype)}` : subtypeLabel(c.source_type, c.subtype)}
        </span>
        {!isAircraftV33 && <span className="text-muted-foreground/60 shrink-0">{formatDist(c.distance_m)}</span>}
        {isAircraftV33 && <span className="text-muted-foreground/60 shrink-0">{metaStr}</span>}
        <span className="font-bold shrink-0 ml-1" style={{ color: ldenToColor(c.received_lden) }}>
          {c.received_lden.toFixed(1)} dB
        </span>
        <span className="text-[10px] text-muted-foreground/40 shrink-0">{expanded ? '\u25B2' : '\u25BC'}</span>
      </div>

      {expanded && (
        <div className="mt-1 ml-5 text-[11px] leading-relaxed font-mono text-muted-foreground">
          {isAircraftV33 ? (
            <AircraftDetail m={c.metadata} />
          ) : (
            <div className="text-[10px] mb-1">{Object.entries(c.metadata).map(([k, v]) => `${k}: ${v}`).join('  ')}</div>
          )}

          {!isAircraftV33 && <>
            <div className="flex justify-between">
              <span>Emission</span>
              <span className="text-foreground">{c.emission_db.toFixed(1)} dB{c.source_type === 'road' || c.source_type === 'railway' ? '/m' : ''}</span>
            </div>
            <div className="flex justify-between">
              <span>Baseline</span>
              <span>{fmt(c.baseline.total_db)} dB</span>
            </div>
            <div className="flex justify-between">
              <span>Terrain {c.terrain.delta_m > 0 ? `\u03B4=${c.terrain.delta_m}m ${c.terrain.is_double ? 'dbl' : ''}` : ''}</span>
              <span className={c.terrain.attenuation_db < -0.5 ? '' : 'text-muted-foreground/40'}>{fmt(c.terrain.attenuation_db)} dB</span>
            </div>
            <div className="flex justify-between">
              <span>Screening {c.screening.building_path_m > 0 ? `${c.screening.building_path_m}m` : ''}</span>
              <span className={c.screening.attenuation_db < -0.5 ? '' : 'text-muted-foreground/40'}>{fmt(c.screening.attenuation_db)} dB</span>
            </div>
            <div className="flex justify-between">
              <span>Vegetation {c.vegetation.forest_depth_m > 0 ? `${c.vegetation.forest_depth_m}m` : ''}</span>
              <span className={c.vegetation.attenuation_db < -0.5 ? '' : 'text-muted-foreground/40'}>{fmt(c.vegetation.attenuation_db)} dB</span>
            </div>
          </>}

          {c.source_type !== 'aircraft' && c.received_bands && c.received_bands.length === 8 && c.received_bands.some(b => b !== 0) && (
            <div className="mt-1 text-[10px] text-muted-foreground/60">
              [{c.received_bands.map(b => Math.round(b)).join(' ')}]
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
  const sourceLines = data.sources
    .filter(s => s.lden != null)
    .map(s => `${SOURCE_LABELS[s.source_type] || s.source_type}: ${s.lden!.toFixed(1)} dB`)
    .join('\n')

  return (
    <div data-testid="detail-popup" role="dialog" className="px-2.5 pt-1 pb-2" onClick={(e) => e.stopPropagation()}>
      {data.total_lden != null ? (
        <>
          <div className="flex items-center justify-between mb-1">
            <span data-testid="noise-badge" className="text-2xl font-bold leading-none shrink-0" style={{ color: ldenToColor(data.total_lden) }} title={sourceLines}>
              {data.total_lden.toFixed(1)} dB
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
