import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useMap, Source, Layer } from 'react-map-gl/maplibre'
import { latLngToCell } from 'h3-js'

export interface RealEstateFilters {
  enabled: boolean
  propertyType: 'all' | 'land' | 'house'
  listingType: 'all' | 'buy' | 'rent'
  maxNoise: number
}

export interface Property {
  id: string
  title: string
  price: number
  currency: string
  lat: number
  lng: number
  area: number | null
  type: string
  listing: string
  url: string
  photo: string | null
  noise: number | null
  updated: string
}

type MarkerCategory = 'land-buy' | 'land-rent' | 'house-buy' | 'house-rent'

const ICON_COLORS: Record<'buy' | 'rent', string> = {
  buy:  '#2563eb',
  rent: '#f59e0b',
}

function getCategory(p: { type: string; listing: string }): MarkerCategory {
  const t = p.type === 'land' ? 'land' : 'house'
  const l = p.listing === 'rent' ? 'rent' : 'buy'
  return `${t}-${l}` as MarkerCategory
}

function createMarkerSvg(category: MarkerCategory): string {
  const isRent = category.endsWith('-rent')
  const isLand = category.startsWith('land-')
  const iconColor = isRent ? ICON_COLORS.rent : ICON_COLORS.buy
  const pin = 'M16 38 C16 38 3 24 3 14 A13 13 0 0 1 29 14 C29 24 16 38 16 38 Z'
  const innerIcon = isLand
    ? `<rect x="10" y="9" width="12" height="10" rx="1" fill="none" stroke="${iconColor}" stroke-width="1.8" stroke-linejoin="round"/><line x1="13" y1="9" x2="13" y2="5" stroke="${iconColor}" stroke-width="1.8" stroke-linecap="round"/>`
    : `<path d="M9 18 L9 13 L16 7 L23 13 L23 18 Z" fill="none" stroke="${iconColor}" stroke-width="1.8" stroke-linejoin="round"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40">
    <path d="${pin}" fill="white" stroke="#999" stroke-width="1.5"/>
    ${innerIcon}
  </svg>`
}

interface RealEstateLayerProps {
  filters: RealEstateFilters
  onPropertySelect?: (property: Property | null) => void
}

const hexCache = new Map<string, Property[]>()

function getVisibleH3R4Hexes(bounds: { west: number; south: number; east: number; north: number }): string[] {
  const hexes = new Set<string>()
  const STEPS = 4
  const latStep = (bounds.north - bounds.south) / STEPS
  const lngStep = (bounds.east - bounds.west) / STEPS
  for (let i = 0; i <= STEPS; i++) {
    for (let j = 0; j <= STEPS; j++) {
      try { hexes.add(latLngToCell(bounds.south + i * latStep, bounds.west + j * lngStep, 4)) } catch {}
    }
  }
  return [...hexes]
}

export default function RealEstateLayer({ filters, onPropertySelect }: RealEstateLayerProps) {
  const { current: map } = useMap()
  const [properties, setProperties] = useState<Property[]>([])
  const fetchIdRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const iconsLoaded = useRef(false)

  // Load SVG pin markers into MapLibre (re-load on basemap switch)
  useEffect(() => {
    if (!map) return
    const categories: MarkerCategory[] = ['land-buy', 'land-rent', 'house-buy', 'house-rent']

    const loadIcons = () => {
      let loaded = 0
      for (const cat of categories) {
        const img = new Image(32, 40)
        img.onload = () => {
          try {
            if (map.hasImage(cat)) map.removeImage(cat)
            map.addImage(cat, img)
          } catch {}
          if (++loaded === categories.length) iconsLoaded.current = true
        }
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(createMarkerSvg(cat))
      }
    }

    const m = map.getMap()
    const onStyleLoad = () => { iconsLoaded.current = false; loadIcons() }
    if (m.isStyleLoaded()) loadIcons()
    m.on('style.load', onStyleLoad)
    return () => { m.off('style.load', onStyleLoad) }
  }, [map])

  // Fetch from H3R4 JSON files
  const fetchProperties = useCallback(async () => {
    if (!map || !filters.enabled) { setProperties([]); return }

    const id = ++fetchIdRef.current
    const bounds = map.getBounds()
    const hexes = getVisibleH3R4Hexes({
      west: bounds.getWest(), south: bounds.getSouth(),
      east: bounds.getEast(), north: bounds.getNorth(),
    })

    const results: Property[] = []
    await Promise.all(hexes.map(async (hex) => {
      if (hexCache.has(hex)) { results.push(...hexCache.get(hex)!); return }
      try {
        const res = await fetch(`/api/h3r4/${hex}/real-estate/index.json`)
        if (!res.ok) { hexCache.set(hex, []); return }
        const data: Property[] = await res.json()
        hexCache.set(hex, data)
        results.push(...data)
      } catch { hexCache.set(hex, []) }
    }))

    if (id !== fetchIdRef.current) return
    setProperties(results)
  }, [map, filters.enabled])

  const debouncedFetch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(fetchProperties, 400)
  }, [fetchProperties])

  useEffect(() => {
    if (!map) return
    if (filters.enabled) fetchProperties()
    else { setProperties([]); onPropertySelect?.(null) }
    map.on('moveend', debouncedFetch)
    return () => {
      map.off('moveend', debouncedFetch)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [map, filters.enabled, fetchProperties, debouncedFetch])

  // Client-side filter + categorize
  const geojson = useMemo<GeoJSON.FeatureCollection | null>(() => {
    const filtered = properties.filter(p => {
      if (filters.propertyType !== 'all' && p.type !== filters.propertyType) return false
      if (filters.listingType !== 'all' && p.listing !== filters.listingType) return false
      if (filters.maxNoise > 0 && p.noise != null && p.noise > filters.maxNoise) return false
      return true
    })
    if (filtered.length === 0) return null
    return {
      type: 'FeatureCollection',
      features: filtered.map(p => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
        properties: { ...p, _category: getCategory(p) },
      })),
    }
  }, [properties, filters])

  // Click + hover
  useEffect(() => {
    if (!map || !filters.enabled) return

    const onPropertyClick = (e: any) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['property-icons'] })
      if (features.length > 0) {
        const p = features[0].properties as any
        onPropertySelect?.({
          id: p.id, title: p.title, price: p.price, currency: p.currency,
          lat: p.lat, lng: p.lng, area: p.area, type: p.type, listing: p.listing,
          url: p.url, photo: p.photo, noise: p.noise, updated: p.updated,
        })
      }
    }

    const onMapClick = (e: any) => {
      if ((e.originalEvent.target as HTMLElement).closest('[data-side-panel]')) return
      const hits = map.queryRenderedFeatures(e.point, { layers: ['property-icons'] })
      if (hits.length === 0) onPropertySelect?.(null)
    }

    const onEnter = () => { map.getCanvas().style.cursor = 'pointer' }
    const onLeave = () => { map.getCanvas().style.cursor = '' }

    map.on('click', 'property-icons', onPropertyClick)
    map.on('click', onMapClick)
    map.on('mouseenter', 'property-icons', onEnter)
    map.on('mouseleave', 'property-icons', onLeave)

    return () => {
      map.off('click', 'property-icons', onPropertyClick)
      map.off('click', onMapClick)
      map.off('mouseenter', 'property-icons', onEnter)
      map.off('mouseleave', 'property-icons', onLeave)
    }
  }, [map, filters.enabled, onPropertySelect])

  if (!filters.enabled || !geojson) return null

  return (
    <Source id="real-estate" type="geojson" data={geojson}>
      <Layer
        id="property-icons"
        type="symbol"
        layout={{
          'icon-image': ['get', '_category'],
          'icon-size': 1,
          'icon-allow-overlap': true,
          'icon-anchor': 'bottom',
        }}
      />
    </Source>
  )
}
