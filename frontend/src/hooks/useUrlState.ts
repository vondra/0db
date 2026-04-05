import { useCallback, useRef, useMemo } from 'react'
import { DEFAULT_BASEMAP, type BasemapId } from '../utils/basemaps'

const DEFAULT_LAT = 49.8
const DEFAULT_LNG = 15.5
const DEFAULT_ZOOM = 8
const ALL_SOURCE_IDS = ['road', 'railway', 'aircraft', 'building', 'industrial']
export const ALL_PROPAGATION_IDS = ['terrain', 'screening', 'vegetation']

export interface UrlState {
  lat: number
  lng: number
  zoom: number
  layers: string[]
  quietClusters: boolean
  quietThreshold: number
  detailPosition: { lat: number; lng: number } | null
  propagationDisabled: string[]
  basemap: BasemapId
}

function parseHash(): UrlState {
  const hash = window.location.hash.slice(1)
  if (!hash) {
    return {
      lat: DEFAULT_LAT,
      lng: DEFAULT_LNG,
      zoom: DEFAULT_ZOOM,
      layers: [...ALL_SOURCE_IDS],
      quietClusters: false,
      quietThreshold: 35,
      detailPosition: null,
      propagationDisabled: [],
      basemap: DEFAULT_BASEMAP,
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

  return {
    lat: parseFloat(params.get('lat') || '') || DEFAULT_LAT,
    lng: parseFloat(params.get('lng') || '') || DEFAULT_LNG,
    zoom: parseFloat(params.get('z') || '') || DEFAULT_ZOOM,
    layers: params.has('layers')
      ? params.get('layers')!.split(',').filter(s => ALL_SOURCE_IDS.includes(s))
      : [...ALL_SOURCE_IDS],
    quietClusters: params.get('qc') === '1',
    quietThreshold: params.has('qt') ? parseInt(params.get('qt')!, 10) : 35,
    detailPosition,
    basemap: (params.get('bm') as BasemapId) || DEFAULT_BASEMAP,
    propagationDisabled,
  }
}

export function buildHash(state: {
  lat: number
  lng: number
  zoom: number
  layers: Set<string>
  quietClusters: boolean
  quietThreshold?: number
  detailPosition?: { lat: number; lng: number } | null
  propagationDisabled?: string[]
  basemap?: BasemapId
}): string {
  const parts: string[] = [
    `lat=${state.lat.toFixed(4)}`,
    `lng=${state.lng.toFixed(4)}`,
    `z=${state.zoom.toFixed(1)}`,
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

  const pd = state.propagationDisabled?.filter(id => ALL_PROPAGATION_IDS.includes(id)).sort() ?? []
  if (pd.length > 0) {
    parts.push(`pd=${pd.join(',')}`)
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
    quietClusters: boolean
    quietThreshold?: number
    detailPosition?: { lat: number; lng: number } | null
    propagationDisabled?: string[]
    basemap?: BasemapId
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
