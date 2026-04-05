import { useEffect, useState, useCallback, useRef } from 'react'
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

interface RealEstateLayerProps {
  filters: RealEstateFilters
  onPropertySelect?: (property: Property | null) => void
}

// Cache fetched H3R4 hex data
const hexCache = new Map<string, Property[]>()

function getVisibleH3R4Hexes(bounds: { west: number; south: number; east: number; north: number }): string[] {
  const hexes = new Set<string>()
  const STEPS = 4
  const latStep = (bounds.north - bounds.south) / STEPS
  const lngStep = (bounds.east - bounds.west) / STEPS

  for (let i = 0; i <= STEPS; i++) {
    for (let j = 0; j <= STEPS; j++) {
      try {
        const hex = latLngToCell(bounds.south + i * latStep, bounds.west + j * lngStep, 4)
        hexes.add(hex)
      } catch { /* out of bounds */ }
    }
  }
  return [...hexes]
}

export default function RealEstateLayer({ filters, onPropertySelect }: RealEstateLayerProps) {
  const { current: map } = useMap()
  const [properties, setProperties] = useState<Property[]>([])
  const fetchIdRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchProperties = useCallback(async () => {
    if (!map || !filters.enabled) {
      setProperties([])
      return
    }

    const id = ++fetchIdRef.current
    const bounds = map.getBounds()
    const hexes = getVisibleH3R4Hexes({
      west: bounds.getWest(), south: bounds.getSouth(),
      east: bounds.getEast(), north: bounds.getNorth(),
    })

    const results: Property[] = []
    await Promise.all(hexes.map(async (hex) => {
      if (hexCache.has(hex)) {
        results.push(...hexCache.get(hex)!)
        return
      }
      try {
        const res = await fetch(`/api/h3r4/${hex}/properties.json`)
        if (!res.ok) { hexCache.set(hex, []); return }
        const data: Property[] = await res.json()
        hexCache.set(hex, data)
        results.push(...data)
      } catch {
        hexCache.set(hex, [])
      }
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
    else setProperties([])

    map.on('moveend', debouncedFetch)
    return () => {
      map.off('moveend', debouncedFetch)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [map, filters.enabled, fetchProperties, debouncedFetch])

  // Client-side filtering
  const filtered = properties.filter(p => {
    if (filters.propertyType !== 'all' && p.type !== filters.propertyType) return false
    if (filters.listingType !== 'all' && p.listing !== filters.listingType) return false
    if (filters.maxNoise > 0 && p.noise != null && p.noise > filters.maxNoise) return false
    return true
  })

  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: filtered.map(p => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      properties: { ...p, _color: p.listing === 'rent' ? '#f59e0b' : '#2563eb' },
    })),
  }

  // Handle click on property marker
  useEffect(() => {
    if (!map || !filters.enabled) return
    const onClick = (e: any) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['property-circles'] })
      if (features.length > 0) {
        const p = features[0].properties as any
        onPropertySelect?.({
          id: p.id, title: p.title, price: p.price, currency: p.currency,
          lat: p.lat, lng: p.lng, area: p.area, type: p.type, listing: p.listing,
          url: p.url, photo: p.photo, noise: p.noise, updated: p.updated,
        })
      }
    }
    map.on('click', onClick)
    return () => { map.off('click', onClick) }
  }, [map, filters.enabled, onPropertySelect])

  if (!filters.enabled || filtered.length === 0) return null

  return (
    <Source id="properties" type="geojson" data={geojson}>
      <Layer
        id="property-circles"
        type="circle"
        paint={{
          'circle-radius': 6,
          'circle-color': ['get', '_color'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
          'circle-opacity': 0.9,
        }}
      />
    </Source>
  )
}
