import { useState, useCallback } from 'react'
import Map, { NavigationControl } from 'react-map-gl/maplibre'
import HexLayer from './HexLayer'
import HexHoverTooltip from './HexHoverTooltip'
import FlyToLocation from './FlyToLocation'
import DetailPopup from './DetailPopup'
import QuietClustersLayer from './QuietClustersLayer'
import ContributorHighlight from './ContributorHighlight'
import IsochronLayer from './IsochronLayer'
import MapStateSync from './MapStateSync'
import { DEFAULT_BASEMAP, getBasemapStyle, type BasemapId } from '../utils/basemaps'
import type { HexFeature } from './HexLayer'
import type { SelectedLocation } from './FlyToLocation'
import type { NoiseComputeData } from './DetailPopup'
import 'maplibre-gl/dist/maplibre-gl.css'

interface MapViewProps {
  selectedLocation?: SelectedLocation | null
  initialCenter?: [number, number]
  initialZoom?: number
  activeSources?: Set<string>
  propagationFactors?: Record<string, boolean>
  basemap?: BasemapId
  onViewChange?: (lat: number, lng: number, zoom: number) => void
  onHexData?: (features: HexFeature[]) => void
  onDetailData?: (data: NoiseComputeData | null) => void
  onDetailPositionChange?: (pos: { lat: number; lng: number } | null) => void
  initialDetailPosition?: { lat: number; lng: number } | null
  onSelectedPointChange?: (point: { lat: number; lng: number } | null) => void
  hexData?: HexFeature[]
  quietClustersEnabled?: boolean
  quietThreshold?: number
  highlightGeometry?: any | null
  isochronGeojson?: GeoJSON.Feature | null
}

export default function MapView({
  selectedLocation, initialCenter, initialZoom, activeSources, propagationFactors,
  basemap, onViewChange, onHexData, onDetailData, onDetailPositionChange,
  initialDetailPosition, onSelectedPointChange,
  hexData, quietClustersEnabled, quietThreshold, highlightGeometry, isochronGeojson,
}: MapViewProps) {
  const center = initialCenter ?? [49.8, 15.5]
  const zoom = initialZoom ?? 8
  const bm = basemap ?? DEFAULT_BASEMAP
  const [flyToPos, setFlyToPos] = useState<{ lat: number; lng: number } | null>(null)

  const handleArrived = useCallback((pos: { lat: number; lng: number }) => {
    setFlyToPos(pos)
  }, [])

  return (
    <Map
      initialViewState={{
        latitude: center[0],
        longitude: center[1],
        zoom,
      }}
      style={{ width: '100%', height: '100%' }}
      mapStyle={getBasemapStyle(bm)}
      maxZoom={16}
      attributionControl={false}
    >
      <NavigationControl position="bottom-left" showCompass={false} />
      <HexLayer
        activeSources={activeSources}
        propagationFactors={propagationFactors}
        onHexData={onHexData}
        basemapId={bm}
      />
      <HexHoverTooltip activeSources={activeSources} propagationFactors={propagationFactors} />
      <QuietClustersLayer hexFeatures={hexData ?? []} enabled={quietClustersEnabled ?? false} threshold={quietThreshold ?? 35} />
      <ContributorHighlight geometry={highlightGeometry ?? null} />
      <IsochronLayer geojson={isochronGeojson ?? null} />
      <FlyToLocation location={selectedLocation ?? null} onArrived={handleArrived} />
      <DetailPopup
        triggerPosition={flyToPos}
        onDetailData={onDetailData}
        onDetailPositionChange={onDetailPositionChange}
        initialDetailPosition={initialDetailPosition}
        onSelectedPointChange={onSelectedPointChange}
      />
      {onViewChange && <MapStateSync onViewChange={onViewChange} />}
    </Map>
  )
}
