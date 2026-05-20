import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Source, Layer, useMap } from 'react-map-gl/maplibre'
import type { SourceMode } from '../hooks/useUrlState'

const TILE_SIZE = 64
const CELL_STEP_DEG = 1 / 3600
const TILE_CACHE_MAX = 256
const MIN_ZOOM = 14

const DATA_LAYERS = ['dem', 'building', 'forest'] as const
type DataLayer = (typeof DATA_LAYERS)[number]

// Heatmap-v2 aircraft uses its own tile grid (Mercator z=6..15, 256×256
// cells per tile, 3 × i16 per cell). It coexists with the 1-arc-second
// raster overlays handled by `DATA_LAYERS` — the hover query runs in
// parallel and folds an "Aircraft Lden" row into the same tooltip.
const HEATMAP_V2_TILE_SIZE = 256
const HEATMAP_V2_NUM_PERIODS = 3
const HEATMAP_V2_MIN_ZOOM = 6
const HEATMAP_V2_MAX_ZOOM = 15

interface CellInspectorLayerProps {
  rasterOverlays: Record<string, boolean>
  sourceModes?: Record<string, SourceMode>
}

type TileEntry = ArrayBuffer | 'loading' | 'failed'

/**
 * Hover tooltip that shows the raw raster-cell values (DEM elevation /
 * Overture building height / WorldCover forest flag) of the 1°/3600 cell
 * under the cursor. Active only while at least one Advanced overlay is on
 * AND every noise-source layer is off — otherwise the popup takes priority.
 */
export default function CellInspectorLayer({
  rasterOverlays,
  sourceModes,
}: CellInspectorLayerProps) {
  const { current: mapRef } = useMap()
  const tileCache = useRef<Map<string, TileEntry>>(new Map())
  const [hover, setHover] = useState<{
    lat: number
    lng: number
    clientX: number
    clientY: number
    zoom: number
  } | null>(null)
  const [tileEpoch, setTileEpoch] = useState(0)

  const activeLayers: DataLayer[] = useMemo(
    () => DATA_LAYERS.filter(id => rasterOverlays[id]),
    [rasterOverlays],
  )
  const aircraftV2Active = !!rasterOverlays['aircraft-v2']

  const allSourcesOff = useMemo(
    () => Object.values(sourceModes ?? {}).every(m => m === 'off' || m == null),
    [sourceModes],
  )

  // Aircraft-v2 keeps the tooltip alive even though aircraft sourceMode
  // is non-off — the v2 raster IS the aircraft display now (Decision
  // #13), and the existing CNOSSOS-raster cell inspector defers to the
  // popup when other sources are on. Heatmap value lookup is purely
  // tile-data, no popup contention.
  const enabled =
    (activeLayers.length > 0 && allSourcesOff) || aircraftV2Active

  useEffect(() => {
    if (!enabled || !mapRef) {
      setHover(null)
      return
    }
    const map = mapRef.getMap()
    const onMove = (e: maplibregl.MapMouseEvent) => {
      const zoom = map.getZoom()
      if (zoom < MIN_ZOOM) { setHover(null); return }
      setHover({
        lat: e.lngLat.lat,
        lng: e.lngLat.lng,
        clientX: e.point.x,
        clientY: e.point.y,
        zoom,
      })
    }
    const onLeave = () => setHover(null)
    map.on('mousemove', onMove)
    map.on('mouseout', onLeave)
    map.on('dragstart', onLeave)
    return () => {
      map.off('mousemove', onMove)
      map.off('mouseout', onLeave)
      map.off('dragstart', onLeave)
    }
  }, [mapRef, enabled])

  // Raster cells are centered on integer multiples of 1/3600° (the sample
  // grid positions), so `Math.round` snaps the hover point to the nearest
  // cell-center — NOT `Math.floor`, which would offset the outline by half
  // a cell and straddle four real cells.
  const cellI = hover ? Math.round(hover.lat / CELL_STEP_DEG) : 0
  const cellJ = hover ? Math.round(hover.lng / CELL_STEP_DEG) : 0
  const cellCenterLat = cellI * CELL_STEP_DEG
  const cellCenterLon = cellJ * CELL_STEP_DEG

  // Kick off tile fetches at the CELL CENTER (not the raw hover position)
  // so every point inside the outline reads from the same raster sample.
  const dataZ = hover ? clamp(Math.floor(hover.zoom), MIN_ZOOM, 16) : MIN_ZOOM
  const heatmapZ = hover
    ? clamp(Math.floor(hover.zoom), HEATMAP_V2_MIN_ZOOM, HEATMAP_V2_MAX_ZOOM)
    : HEATMAP_V2_MAX_ZOOM
  useEffect(() => {
    if (!hover) return
    const { x, y } = lngLatToTile(cellCenterLon, cellCenterLat, dataZ)
    for (const layer of activeLayers) {
      ensureTileFetched(layer, dataZ, x, y, tileCache.current, () =>
        setTileEpoch(e => e + 1),
      )
    }
    if (aircraftV2Active) {
      const { x: hx, y: hy } = lngLatToTile(cellCenterLon, cellCenterLat, heatmapZ)
      ensureTileFetched('aircraft-v2', heatmapZ, hx, hy, tileCache.current, () =>
        setTileEpoch(e => e + 1),
      )
    }
  }, [hover, dataZ, activeLayers, cellCenterLat, cellCenterLon, aircraftV2Active, heatmapZ])

  const values = useMemo(() => {
    if (!hover) return null
    const { x, y } = lngLatToTile(cellCenterLon, cellCenterLat, dataZ)
    const out: Partial<Record<DataLayer, number | null>> & { aircraftLden?: number | null } = {}
    for (const layer of activeLayers) {
      out[layer] = readCellValue(
        layer, dataZ, cellCenterLat, cellCenterLon, x, y, tileCache.current,
      )
    }
    if (aircraftV2Active) {
      const { x: hx, y: hy } = lngLatToTile(cellCenterLon, cellCenterLat, heatmapZ)
      out.aircraftLden = readHeatmapV2Lden(
        heatmapZ, cellCenterLat, cellCenterLon, hx, hy, tileCache.current,
      )
    }
    return out
    // tileEpoch re-reads cached entries once a background fetch lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, dataZ, heatmapZ, activeLayers, cellCenterLat, cellCenterLon, aircraftV2Active, tileEpoch])

  // Memoise the cell outline on cell identity so MapLibre only rebuilds the
  // polygon when the cursor crosses into a new cell.
  const cellKey = hover ? `${cellI}:${cellJ}` : null
  const outline = useMemo(() => {
    if (!hover) return null
    const half = CELL_STEP_DEG / 2
    const lat0 = cellCenterLat - half
    const lon0 = cellCenterLon - half
    const lat1 = cellCenterLat + half
    const lon1 = cellCenterLon + half
    return {
      type: 'FeatureCollection' as const,
      features: [{
        type: 'Feature' as const,
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]],
        },
        properties: {},
      }],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellKey])

  if (!enabled || !hover || !outline || !values) return null

  return (
    <>
      <Source id="cell-inspector-outline" type="geojson" data={outline}>
        <Layer
          id="cell-inspector-outline-line"
          type="line"
          paint={{ 'line-color': 'rgba(0,0,0,0.65)', 'line-width': 1 }}
        />
        <Layer
          id="cell-inspector-outline-fill"
          type="fill"
          paint={{ 'fill-color': 'rgba(255,255,255,0.12)' }}
        />
      </Source>
      <div
        style={{
          position: 'fixed',
          left: hover.clientX + 14,
          top: hover.clientY + 14,
          pointerEvents: 'none',
          zIndex: 1002,
        }}
        className="rounded-md bg-zinc-900/95 text-zinc-50 border border-zinc-700/60 shadow-xl px-2 py-1 font-mono text-[11px] leading-snug"
      >
        {renderLines(values)}
      </div>
    </>
  )
}

const TOOLTIP_ROWS: Array<{
  key: DataLayer
  label: string
  fmt: (v: number) => string
}> = [
  { key: 'dem', label: 'Elevation', fmt: v => `${Math.round(v)} m` },
  { key: 'building', label: 'Building', fmt: v => v > 0 ? `${v} m` : 'none' },
  { key: 'forest', label: 'Forest', fmt: v => v > 0 ? 'yes' : 'no' },
]

function renderLines(
  values: Partial<Record<DataLayer, number | null>> & { aircraftLden?: number | null },
): ReactNode {
  const rows: ReactNode[] = []
  if ('aircraftLden' in values) {
    const v = values.aircraftLden
    rows.push(
      <div key="aircraft-v2">
        Aircraft Lden: {v == null ? '…' : Number.isFinite(v) ? `${v.toFixed(1)} dB` : '—'}
      </div>,
    )
  }
  for (const row of TOOLTIP_ROWS) {
    if (!(row.key in values)) continue
    const v = values[row.key]
    rows.push(
      <div key={row.key}>
        {row.label}: {v == null ? '…' : row.fmt(v)}
      </div>,
    )
  }
  return rows
}

function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z)
  const latRad = (lat * Math.PI) / 180
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
  }
}

function tileBbox(z: number, x: number, y: number) {
  const n = Math.pow(2, z)
  return {
    lonWest: (x / n) * 360 - 180,
    lonEast: ((x + 1) / n) * 360 - 180,
    latNorth: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
    latSouth: (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI,
  }
}

function ensureTileFetched(
  layer: DataLayer | 'aircraft-v2',
  z: number,
  x: number,
  y: number,
  cache: Map<string, TileEntry>,
  onLoaded: () => void,
): void {
  const key = `${layer}/${z}/${x}/${y}`
  if (cache.has(key)) return
  cache.set(key, 'loading')
  promoteLru(cache, key)
  const url = layer === 'aircraft-v2'
    ? `/api/heatmap-v2-cells/aircraft/${z}/${x}/${y}.bin`
    : `/api/raster-data/${layer}/${z}/${x}/${y}.bin`
  fetch(url)
    .then(res => {
      if (!res.ok) throw new Error(`status ${res.status}`)
      return res.arrayBuffer()
    })
    .then(buf => { cache.set(key, buf); promoteLru(cache, key); onLoaded() })
    .catch(() => { cache.set(key, 'failed'); onLoaded() })
}

function readCellValue(
  layer: DataLayer,
  z: number,
  lat: number,
  lng: number,
  tileX: number,
  tileY: number,
  cache: Map<string, TileEntry>,
): number | null {
  const entry = cache.get(`${layer}/${z}/${tileX}/${tileY}`)
  if (!entry || entry === 'loading' || entry === 'failed') return null
  const { lonWest, lonEast, latNorth, latSouth } = tileBbox(z, tileX, tileY)
  const mercYNorth = Math.log(Math.tan(Math.PI / 4 + (latNorth * Math.PI) / 360))
  const mercYSouth = Math.log(Math.tan(Math.PI / 4 + (latSouth * Math.PI) / 360))
  const mercY = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  const fracY = (mercY - mercYNorth) / (mercYSouth - mercYNorth)
  const py = clamp(Math.floor(fracY * TILE_SIZE), 0, TILE_SIZE - 1)
  const fracX = (lng - lonWest) / (lonEast - lonWest)
  const px = clamp(Math.floor(fracX * TILE_SIZE), 0, TILE_SIZE - 1)
  const idx = py * TILE_SIZE + px
  if (layer === 'dem') return new DataView(entry).getInt16(idx * 2, false)
  return new Uint8Array(entry)[idx]
}

const SILENCE_I16 = -32768

/// Read the per-cell Lday/Leve/Lnight i16×10 from a heatmap-v2 cell
/// tile and combine into Lden using the EU directive's standard
/// 12/4/8 h period weights with +5 dB evening / +10 dB night penalties.
/// Returns `null` when the tile is still loading, `NEG_INFINITY`-stand-in
/// for silence — caller renders both as "—" / "…".
function readHeatmapV2Lden(
  z: number,
  lat: number,
  lng: number,
  tileX: number,
  tileY: number,
  cache: Map<string, TileEntry>,
): number | null {
  const entry = cache.get(`aircraft-v2/${z}/${tileX}/${tileY}`)
  if (!entry || entry === 'loading' || entry === 'failed') return null
  const { lonWest, lonEast, latNorth, latSouth } = tileBbox(z, tileX, tileY)
  const mercYNorth = Math.log(Math.tan(Math.PI / 4 + (latNorth * Math.PI) / 360))
  const mercYSouth = Math.log(Math.tan(Math.PI / 4 + (latSouth * Math.PI) / 360))
  const mercY = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  const fracY = (mercY - mercYNorth) / (mercYSouth - mercYNorth)
  const py = clamp(Math.floor(fracY * HEATMAP_V2_TILE_SIZE), 0, HEATMAP_V2_TILE_SIZE - 1)
  const fracX = (lng - lonWest) / (lonEast - lonWest)
  const px = clamp(Math.floor(fracX * HEATMAP_V2_TILE_SIZE), 0, HEATMAP_V2_TILE_SIZE - 1)
  const base = (py * HEATMAP_V2_TILE_SIZE + px) * HEATMAP_V2_NUM_PERIODS
  const view = new DataView(entry)
  const lday = view.getInt16(base * 2, true)
  const leve = view.getInt16((base + 1) * 2, true)
  const lnight = view.getInt16((base + 2) * 2, true)
  const eDay = lday === SILENCE_I16 ? 0 : Math.pow(10, lday / 100)
  // Stored values are dB×10 — apply +5 / +10 penalties before the
  // 10^(·/10) energy conversion. `(leve + 50) / 100` = `(L/10 + 5) / 10`.
  const eEve = leve === SILENCE_I16 ? 0 : Math.pow(10, (leve + 50) / 100)
  const eNi = lnight === SILENCE_I16 ? 0 : Math.pow(10, (lnight + 100) / 100)
  const sum = 12 * eDay + 4 * eEve + 8 * eNi
  return sum <= 0 ? -Infinity : 10 * Math.log10(sum / 24)
}

function promoteLru(cache: Map<string, TileEntry>, key: string): void {
  const v = cache.get(key)
  if (v === undefined) return
  cache.delete(key)
  cache.set(key, v)
  while (cache.size > TILE_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
