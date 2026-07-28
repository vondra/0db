import { useEffect, useState } from 'react'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { useMap } from 'react-map-gl/maplibre'
import { attachPinTapGuard } from '../lib/property-click-guard'
import { useTileBuild, buildKey } from '../lib/tile-urls'
import { sampleNoiseAt } from '../lib/stay-noise'
import { paletteRgb } from '../lib/heatmap-palette'

export interface StayFilters {
  enabled: boolean
  stayType: 'all' | 'hotel' | 'rental'
}

export interface Stay {
  id: string
  name: string
  lat: number
  lng: number
  thumbnail: string | null
  rating: { value: number | null; count: number | null; stars: number | null }
  capacity: { guests: number | null; bedrooms: number | null }
  freeCancellation: boolean
  price: { total: number; perNight: number } | null
  url: string
  /** Nights the quoted price covers (from the server's default stay window). */
  nights: number
  /** Total Lden sampled from the heatmap tiles; null where nothing is computed. */
  noise: number | null
}

interface StayLayerProps {
  filters: StayFilters
  onStaySelect?: (stay: Stay | null) => void
}

// Below this zoom a viewport exceeds the server's bbox cap and pins would be
// unreadably dense anyway — the layer stays empty until the user zooms in.
const MIN_ZOOM = 11
// Mirror of the server's bucket grid (see server/src/routes/stay.ts) so
// panning within a cell reuses the browser/server cache instead of minting
// new URLs.
const GRID_DEG = 0.05
const NO_NOISE_GREY: [number, number, number] = [148, 163, 184]

type StayResponse = {
  listings: Omit<Stay, 'noise' | 'nights'>[]
  meta: { nights: number }
}

// Live listings are viewport-scoped; the cache holds the in-flight promise
// (not just the settled result) so overlapping moveends for the same bucket
// share one request instead of double-hitting the server's upstream budget.
const fetchCache = new Map<string, { at: number; promise: Promise<Stay[]> }>()
const FETCH_TTL_MS = 10 * 60 * 1000
const FETCH_CACHE_MAX = 40

// The epsilon keeps grid-boundary values in place — bare floor(50.05/0.05)
// lands on 1000.999…, snapping a whole cell too far (mirrors the server).
const snap = (v: number, up: boolean) => {
  const q = v / GRID_DEG
  return ((up ? Math.ceil(q - 1e-9) : Math.floor(q + 1e-9)) * GRID_DEG).toFixed(2)
}

export function formatPerNight(amount: number): string {
  return `€${amount}`
}

function loadStays(url: string, build: Parameters<typeof sampleNoiseAt>[0]): Promise<Stay[]> {
  // The joined noise values depend on the tile build, so a manifest flip must
  // not serve samples decoded from the previous generation for a whole TTL.
  const key = `${url}|${buildKey(build, ['total'])}`
  let entry = fetchCache.get(key)
  if (!entry || Date.now() - entry.at >= FETCH_TTL_MS) {
    const promise = (async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`stay ${res.status}`)
      const data: StayResponse = await res.json()
      const noise = await sampleNoiseAt(build, data.listings)
      return data.listings.map((l, i): Stay => ({ ...l, noise: noise[i], nights: data.meta.nights }))
    })()
    entry = { at: Date.now(), promise }
    fetchCache.delete(key) // re-insert so a refreshed bucket is newest for eviction
    fetchCache.set(key, entry)
    // A failed bucket must not poison the cache for its whole TTL.
    promise.catch(() => { if (fetchCache.get(key) === entry) fetchCache.delete(key) })
    while (fetchCache.size > FETCH_CACHE_MAX) fetchCache.delete(fetchCache.keys().next().value!)
  }
  return entry.promise
}

/**
 * Bookable stays (hotels + vacation rentals via Stay22) as price pills over
 * dB-coloured dots. Same overlay contract as RealEstateLayer: mounts AFTER
 * the heatmap so pins sit above it, and stamps the shared click guard so the
 * noise popup skips pin clicks. Unlike the static CZ property set this is a
 * live worldwide feed — listings are fetched per viewport bucket and each
 * pin's dB is sampled client-side from the already-decoded heatmap tiles.
 */
export default function StayLayer({ filters, onStaySelect }: StayLayerProps) {
  const { current: mapRef } = useMap()
  const build = useTileBuild()
  const [overlay, setOverlay] = useState<MapboxOverlay | null>(null)
  const [stays, setStays] = useState<Stay[]>([])
  const [view, setView] = useState<{ w: number; s: number; e: number; n: number; z: number } | null>(null)

  useEffect(() => {
    if (!mapRef) return
    const map = mapRef.getMap()
    const o = new MapboxOverlay({ interleaved: false, layers: [] })
    map.addControl(o)
    setOverlay(o)
    return () => { map.removeControl(o); setOverlay(null) }
  }, [mapRef])

  // Track the viewport so fetches re-derive as the map moves.
  useEffect(() => {
    if (!mapRef || !filters.enabled) { onStaySelect?.(null); setStays([]); return }
    const map = mapRef.getMap()
    const update = () => {
      const b = map.getBounds()
      setView({ w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth(), z: map.getZoom() })
    }
    update()
    map.on('moveend', update)
    return () => { map.off('moveend', update) }
  }, [mapRef, filters.enabled, onStaySelect])

  // Stamp the click guard from a cheap CPU hit-test against the loaded pins —
  // see attachPinTapGuard for why this must not go through deck's pick.
  useEffect(() => {
    if (!mapRef || !filters.enabled || stays.length === 0) return
    const map = mapRef.getMap()
    return attachPinTapGuard(map.getCanvas(), (x, y) => {
      for (const s of stays) {
        const p = map.project([s.lng, s.lat])
        const dx = x - p.x
        const dy = y - p.y
        if (dx * dx + dy * dy <= 49) return true // dot: 5 px radius + 1.5 stroke + slack
        // Price pill above the dot: text box at pixel offset [0,-16].
        if (s.price != null &&
            Math.abs(dx) <= 7 + 3.5 * formatPerNight(s.price.perNight).length &&
            dy >= -26 && dy <= -6) return true
      }
      return false
    })
  }, [mapRef, filters.enabled, stays])

  // Fetch the viewport bucket, then join each listing's dB from the tiles.
  useEffect(() => {
    if (!filters.enabled || !build || !view || view.z < MIN_ZOOM) { setStays([]); return }
    const bbox = {
      swlat: snap(view.s, false), swlng: snap(view.w, false),
      nelat: snap(view.n, true), nelng: snap(view.e, true),
    }
    // Mirror of the server's span cap — an ultrawide viewport at min zoom can
    // exceed it, and skipping beats a guaranteed 400 on every moveend.
    if (+bbox.nelat - +bbox.swlat > 1.5 || +bbox.nelng - +bbox.swlng > 1.5) { setStays([]); return }
    const params = new URLSearchParams(bbox)
    if (filters.stayType !== 'all') params.set('type', filters.stayType)

    let cancelled = false
    loadStays(`/api/stay?${params}`, build)
      .then(loaded => { if (!cancelled) setStays(loaded) })
      .catch(() => { /* keep previous pins; the next moveend retries */ })
    return () => { cancelled = true }
  }, [filters.enabled, filters.stayType, build, view])

  // Rebuild deck layers only when a fetch lands or the zoom gate flips —
  // deck clips off-screen points for free, so no per-pan re-filtering.
  const gateOpen = filters.enabled && view != null && view.z >= MIN_ZOOM
  useEffect(() => {
    if (!overlay) return
    overlay.setProps({ layers: gateOpen && stays.length > 0 ? makeLayers(stays, onStaySelect) : [] })
  }, [overlay, stays, gateOpen, onStaySelect])

  return null
}

function makeLayers(data: Stay[], onSelect?: (s: Stay | null) => void) {
  const dbColor = (s: Stay): [number, number, number] =>
    s.noise != null ? paletteRgb(s.noise) : NO_NOISE_GREY
  // No guard stamp here — attachPinTapGuard already stamped in the pointerup
  // task (deck's click pick may lag frames behind).
  const onClick = (info: { object?: unknown }) => {
    if (!info.object) return
    onSelect?.(info.object as Stay)
  }
  return [
    new ScatterplotLayer<Stay>({
      id: 'stays-dots',
      data,
      getPosition: (s) => [s.lng, s.lat],
      getFillColor: dbColor,
      getLineColor: [255, 255, 255],
      stroked: true,
      radiusUnits: 'pixels',
      getRadius: 5,
      radiusMinPixels: 4,
      radiusMaxPixels: 7,
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 90],
      onClick,
    }),
    // Airbnb-style price pill above the dot; the border repeats the dot's dB
    // colour so price and noise read together at a glance.
    new TextLayer<Stay>({
      id: 'stays-price',
      data: data.filter(s => s.price),
      getPosition: (s) => [s.lng, s.lat],
      getText: (s) => formatPerNight(s.price!.perNight),
      getPixelOffset: [0, -16],
      getSize: 12,
      fontFamily: 'system-ui, sans-serif',
      fontWeight: 600,
      characterSet: 'auto',
      getColor: [15, 23, 42, 255],
      background: true,
      getBackgroundColor: [255, 255, 255, 235],
      getBorderColor: (s) => [...dbColor(s), 255] as [number, number, number, number],
      getBorderWidth: 1.5,
      backgroundPadding: [6, 3, 6, 3],
      pickable: true,
      onClick,
    }),
  ]
}
