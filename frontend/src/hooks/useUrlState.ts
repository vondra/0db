import { useCallback, useRef, useMemo } from 'react'
import { DEFAULT_BASEMAP, type BasemapId } from '../utils/basemaps'
import { HEATMAP_LAYERS } from '../components/HeatmapV3Overlay'

const DEFAULT_LAT = 49.8
const DEFAULT_LNG = 15.5
const DEFAULT_ZOOM = 8
const ALL_SOURCE_IDS = ['road', 'railway', 'aircraft', 'building', 'industrial']
export const ALL_PROPAGATION_IDS = ['terrain', 'screening', 'vegetation']
export const ALL_RASTER_OVERLAY_IDS = [
  ...HEATMAP_LAYERS,
  'dem',
  'building-height', // Overture building-height raster — distinct from the `building` noise layer
  'forest',
  'barriers',
]

export type SourceMode = 'off' | '0db' | 'end' | 'diff'

export interface UrlState {
  lat: number
  lng: number
  zoom: number
  layers: string[]
  sourceModes: Record<string, SourceMode>
  quietClusters: boolean
  quietThreshold: number
  detailPosition: { lat: number; lng: number } | null
  propagationDisabled: string[]
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

function parseHash(): UrlState {
  const hash = window.location.hash.slice(1)
  if (!hash) {
    return {
      lat: DEFAULT_LAT,
      lng: DEFAULT_LNG,
      zoom: DEFAULT_ZOOM,
      layers: [...ALL_SOURCE_IDS],
      sourceModes: {},
      quietClusters: false,
      quietThreshold: 35,
      detailPosition: null,
      propagationDisabled: [],
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

  const propagationDisabled = params.has('pd')
    ? params.get('pd')!.split(',').filter(id => ALL_PROPAGATION_IDS.includes(id)).sort()
    : []

  // Parse source modes: sm=road:shm,railway:diff
  // Single-diff invariant — only the first 'diff' wins; later diff entries coerced to '0db'.
  const sourceModes: Record<string, SourceMode> = {}
  const smParam = params.get('sm')
  if (smParam) {
    let diffSeen = false
    for (const entry of smParam.split(',')) {
      const [id, mode] = entry.split(':')
      if (!ALL_SOURCE_IDS.includes(id) || !['end', 'diff'].includes(mode)) continue
      if (mode === 'diff') {
        if (diffSeen) continue
        diffSeen = true
      }
      sourceModes[id] = mode as SourceMode
    }
  }

  const layers = params.has('layers')
    ? params.get('layers')!.split(',').filter(s => ALL_SOURCE_IDS.includes(s))
    : [...ALL_SOURCE_IDS]

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
    layers,
    sourceModes,
    quietClusters: params.get('qc') === '1',
    quietThreshold: params.has('qt') ? parseInt(params.get('qt')!, 10) : 35,
    detailPosition,
    basemap: (params.get('bm') as BasemapId) || DEFAULT_BASEMAP,
    propagationDisabled,
    rasterOverlays,
  }
}

export function buildHash(state: {
  lat: number
  lng: number
  zoom: number
  layers: Set<string>
  sourceModes?: Record<string, SourceMode>
  quietClusters: boolean
  quietThreshold?: number
  detailPosition?: { lat: number; lng: number } | null
  propagationDisabled?: string[]
  basemap?: BasemapId
  rasterOverlays?: Record<string, boolean>
}): string {
  const parts: string[] = [
    `lat=${state.lat.toFixed(4)}`,
    `lng=${state.lng.toFixed(4)}`,
    `z=${state.zoom.toFixed(2)}`,
  ]

  const allActive =
    state.layers.size === ALL_SOURCE_IDS.length &&
    ALL_SOURCE_IDS.every(s => state.layers.has(s))

  if (!allActive) {
    parts.push(`layers=${Array.from(state.layers).sort().join(',')}`)
  }

  if (state.quietClusters) {
    parts.push('qc=1')
    if (state.quietThreshold != null && state.quietThreshold !== 35) parts.push(`qt=${state.quietThreshold}`)
  }

  if (state.detailPosition) {
    parts.push(`d=${state.detailPosition.lat.toFixed(4)},${state.detailPosition.lng.toFixed(4)}`)
  }

  if (state.basemap && state.basemap !== DEFAULT_BASEMAP) {
    parts.push(`bm=${state.basemap}`)
  }

  // Source modes: only serialize non-default (non-0db) modes
  if (state.sourceModes) {
    const entries = Object.entries(state.sourceModes)
      .filter(([, mode]) => mode !== '0db' && mode !== 'off')
      .sort(([a], [b]) => a.localeCompare(b))
    if (entries.length > 0) {
      parts.push(`sm=${entries.map(([id, mode]) => `${id}:${mode}`).join(',')}`)
    }
  }

  const pd = state.propagationDisabled?.filter(id => ALL_PROPAGATION_IDS.includes(id)).sort() ?? []
  if (pd.length > 0) {
    parts.push(`pd=${pd.join(',')}`)
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
    layers: Set<string>
    sourceModes?: Record<string, SourceMode>
    quietClusters: boolean
    quietThreshold?: number
    detailPosition?: { lat: number; lng: number } | null
    propagationDisabled?: string[]
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
