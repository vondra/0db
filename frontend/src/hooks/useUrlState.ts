import { useCallback, useRef, useMemo } from 'react'
import { DEFAULT_BASEMAP, type BasemapId } from '../utils/basemaps'
import { HEATMAP_LAYERS } from '../components/HeatmapV3Overlay'

const DEFAULT_LAT = 49.8
const DEFAULT_LNG = 15.5
const DEFAULT_ZOOM = 8
export const ALL_RASTER_OVERLAY_IDS = [
  ...HEATMAP_LAYERS,
  'dem',
  'building-height', // Overture building-height raster — distinct from the `building` noise layer
  'forest',
  'barriers',
]

export interface UrlState {
  lat: number
  lng: number
  zoom: number
  quietClusters: boolean
  quietThreshold: number
  detailPosition: { lat: number; lng: number } | null
  basemap: BasemapId
  rasterOverlays: Record<string, boolean>
}

export const EMPTY_RASTER_OVERLAYS: Record<string, boolean> = Object.fromEntries(
  ALL_RASTER_OVERLAY_IDS.map(id => [id, false]),
)

// Default view: all seven noise layers on (advanced rasters off). With every
// layer on, MapView fetches the single precomputed `total` tile rather than
// summing seven — the fast path ~80% of visitors get without touching the UI.
export const DEFAULT_RASTER_OVERLAYS: Record<string, boolean> = {
  ...EMPTY_RASTER_OVERLAYS,
  ...Object.fromEntries(HEATMAP_LAYERS.map(id => [id, true])),
}

// Quiet-zone threshold, clamped to the slider's 40–65 dB range. A malformed
// `qt` (NaN) would otherwise make `byte > maxByte` always false downstream and
// paint every non-NO_DATA pixel as quiet.
function parseQuietThreshold(raw: string | null): number {
  const n = raw == null ? NaN : parseInt(raw, 10)
  return Number.isFinite(n) ? Math.min(65, Math.max(40, n)) : 55
}

function parseHash(): UrlState {
  const hash = window.location.hash.slice(1)
  if (!hash) {
    return {
      lat: DEFAULT_LAT,
      lng: DEFAULT_LNG,
      zoom: DEFAULT_ZOOM,
      quietClusters: false,
      quietThreshold: 55,
      detailPosition: null,
      basemap: DEFAULT_BASEMAP,
      rasterOverlays: { ...DEFAULT_RASTER_OVERLAYS },
    }
  }

  const params = new URLSearchParams(hash)

  let detailPosition: { lat: number; lng: number } | null = null
  const dParam = params.get('d')
  if (dParam) {
    const parts = dParam.split(',')
    if (parts.length === 2) {
      const dlat = parseFloat(parts[0])
      const dlng = parseFloat(parts[1])
      if (Number.isFinite(dlat) && Number.isFinite(dlng)) {
        detailPosition = { lat: dlat, lng: dlng }
      }
    }
  }

  // `ro` lists exactly the active overlays; its absence means the default view
  // (all seven layers on). An explicit empty `ro=` therefore means "all off".
  const rasterOverlays: Record<string, boolean> = params.has('ro')
    ? { ...EMPTY_RASTER_OVERLAYS }
    : { ...DEFAULT_RASTER_OVERLAYS }
  if (params.has('ro')) {
    for (const id of params.get('ro')!.split(',')) {
      if (ALL_RASTER_OVERLAY_IDS.includes(id)) rasterOverlays[id] = true
    }
  }

  const parsedLat = parseFloat(params.get('lat') || '')
  const parsedLng = parseFloat(params.get('lng') || '')
  const parsedZoom = parseFloat(params.get('z') || '')

  return {
    lat: Number.isFinite(parsedLat) ? parsedLat : DEFAULT_LAT,
    lng: Number.isFinite(parsedLng) ? parsedLng : DEFAULT_LNG,
    zoom: Number.isFinite(parsedZoom) ? parsedZoom : DEFAULT_ZOOM,
    quietClusters: params.get('qc') === '1',
    quietThreshold: parseQuietThreshold(params.get('qt')),
    detailPosition,
    basemap: (params.get('bm') as BasemapId) || DEFAULT_BASEMAP,
    rasterOverlays,
  }
}

export function buildHash(state: {
  lat: number
  lng: number
  zoom: number
  quietClusters: boolean
  quietThreshold?: number
  detailPosition?: { lat: number; lng: number } | null
  basemap?: BasemapId
  rasterOverlays?: Record<string, boolean>
}): string {
  const parts: string[] = [
    `lat=${state.lat.toFixed(4)}`,
    `lng=${state.lng.toFixed(4)}`,
    `z=${state.zoom.toFixed(2)}`,
  ]

  if (state.quietClusters) {
    parts.push('qc=1')
    if (state.quietThreshold != null && state.quietThreshold !== 55) parts.push(`qt=${state.quietThreshold}`)
  }

  if (state.detailPosition) {
    parts.push(`d=${state.detailPosition.lat.toFixed(4)},${state.detailPosition.lng.toFixed(4)}`)
  }

  if (state.basemap && state.basemap !== DEFAULT_BASEMAP) {
    parts.push(`bm=${state.basemap}`)
  }

  if (state.rasterOverlays) {
    const active = ALL_RASTER_OVERLAY_IDS.filter(id => state.rasterOverlays![id])
    // Omit `ro` for the default view (all seven layers on, advanced off) so a
    // bare link opens the default; serialize the exact set otherwise (including
    // the empty "all off" set as `ro=`).
    const isDefault = ALL_RASTER_OVERLAY_IDS.every(id => !!state.rasterOverlays![id] === !!DEFAULT_RASTER_OVERLAYS[id])
    if (!isDefault) {
      parts.push(`ro=${active.join(',')}`)
    }
  }

  return '#' + parts.join('&')
}

export function useUrlState() {
  const initial = useMemo(() => parseHash(), [])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateUrl = useCallback((state: {
    lat: number
    lng: number
    zoom: number
    quietClusters: boolean
    quietThreshold?: number
    detailPosition?: { lat: number; lng: number } | null
    basemap?: BasemapId
    rasterOverlays?: Record<string, boolean>
  }) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      if (window.location.pathname.startsWith('/about')) return
      const hash = buildHash(state)
      window.history.replaceState(null, '', hash)
    }, 300)
  }, [])

  return { initial, updateUrl }
}
