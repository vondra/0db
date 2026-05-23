import { useState, useCallback, useEffect, useMemo } from 'react'
import Map, { NavigationControl } from 'react-map-gl/maplibre'
import type { StyleSpecification } from 'maplibre-gl'
import HexLayer from './HexLayer'
import HexHoverTooltip from './HexHoverTooltip'
import FlyToLocation from './FlyToLocation'
import DetailPopup from './DetailPopup'
import QuietClustersLayer from './QuietClustersLayer'
import RealEstateLayer from './RealEstateLayer'
import IsochronLayer from './IsochronLayer'
import RasterOverlayLayer from './RasterOverlayLayer'
import HeatmapV3Overlay, { AIRCRAFT_LAYER_SOURCES } from './HeatmapV3Overlay'
import HeatmapV3HoverTooltip from './HeatmapV3HoverTooltip'
import CellInspectorLayer from './CellInspectorLayer'
import MapStateSync from './MapStateSync'
import { DEFAULT_BASEMAP, loadBasemapStyle, type BasemapId } from '../utils/basemaps'
import type { QuietHex, QuietHexUpdate } from './HexLayer'
import type { SelectedLocation } from './FlyToLocation'
import type { NoiseComputeData } from '../types/noise'
import type { SourceMode } from '../hooks/useUrlState'
import 'maplibre-gl/dist/maplibre-gl.css'

interface MapViewProps {
  selectedLocation?: SelectedLocation | null
  initialCenter?: [number, number]
  initialZoom?: number
  sourceModes?: Record<string, SourceMode>
  propagationFactors?: Record<string, boolean>
  basemap?: BasemapId
  onViewChange?: (lat: number, lng: number, zoom: number) => void
  onQuietHexUpdate?: (update: QuietHexUpdate) => void
  onDetailData?: (data: NoiseComputeData | null) => void
  onDetailPositionChange?: (pos: { lat: number; lng: number } | null) => void
  detailPosition?: { lat: number; lng: number } | null
  quietHexData?: QuietHex[]
  quietVisible?: boolean
  quietDataRes?: number | null
  quietClustersEnabled?: boolean
  quietThreshold?: number
  highlightGeometry?: any | null
  isochronGeojson?: GeoJSON.Feature | null
  realEstateFilters?: import('./RealEstateLayer').RealEstateFilters
  onPropertySelect?: (property: import('./RealEstateLayer').Property | null) => void
  rasterOverlays?: Record<string, boolean>
}

export default function MapView({
  selectedLocation, initialCenter, initialZoom, sourceModes, propagationFactors,
  basemap, onViewChange, onQuietHexUpdate, onDetailData, onDetailPositionChange, detailPosition,
  quietHexData, quietVisible, quietDataRes, quietClustersEnabled, quietThreshold, highlightGeometry, isochronGeojson, realEstateFilters, onPropertySelect, rasterOverlays,
}: MapViewProps) {
  const center = initialCenter ?? [49.8, 15.5]
  const zoom = initialZoom ?? 8
  const bm = basemap ?? DEFAULT_BASEMAP
  const [flyToPos, setFlyToPos] = useState<{ lat: number; lng: number } | null>(null)
  const [mapStyle, setMapStyle] = useState<string | StyleSpecification | null>(null)

  const handleArrived = useCallback((pos: { lat: number; lng: number }) => {
    setFlyToPos(pos)
  }, [])

  const activeAircraftSources = useMemo(
    () => AIRCRAFT_LAYER_SOURCES.filter(s => !!rasterOverlays?.[s]),
    [rasterOverlays],
  )

  useEffect(() => {
    let cancelled = false
    void loadBasemapStyle(bm).then((style) => {
      if (!cancelled) setMapStyle(style)
    })
    return () => {
      cancelled = true
    }
  }, [bm])

  if (!mapStyle) {
    return <div className="h-full w-full bg-[#fafaf8]" />
  }

  return (
    <Map
      initialViewState={{
        latitude: center[0],
        longitude: center[1],
        zoom,
      }}
      style={{ width: '100%', height: '100%' }}
      mapStyle={mapStyle}
      fadeDuration={0}
      maxZoom={16}
      attributionControl={false}
      // Defaults (deceleration 2500, maxSpeed 1400) give ~1.25 s inertia on a medium
      // flick — too sluggish. 4000 / 1100 lands around ~780 ms, between the default
      // and a Google-Maps-snappy feel.
      dragPan={{ deceleration: 4000, maxSpeed: 1100 }}
    >
      <NavigationControl position="bottom-left" showCompass={false} />
      <HexLayer
        sourceModes={sourceModes}
        propagationFactors={propagationFactors}
        onQuietHexUpdate={onQuietHexUpdate}
        basemapId={bm}
        quietClustersEnabled={quietClustersEnabled}
      />
      <HexHoverTooltip />
      <QuietClustersLayer
        hexData={quietHexData ?? []}
        enabled={(quietClustersEnabled ?? false) && (quietVisible ?? false) && quietDataRes !== null}
        threshold={quietThreshold ?? 35}
      />
      {realEstateFilters && <RealEstateLayer filters={realEstateFilters} onPropertySelect={onPropertySelect} />}
      <RasterOverlayLayer visibleLayers={rasterOverlays ?? {}} />
      {/* Highlight rides on the same deck.gl canvas as the heatmap so
          it always draws above the HM3 tiles. A separate MapLibre
          Source/Layer would sit under the non-interleaved deck canvas
          and disappear whenever any heatmap was active. */}
      <HeatmapV3Overlay
        sources={activeAircraftSources}
        highlightGeometry={highlightGeometry ?? null}
      />
      <HeatmapV3HoverTooltip sources={activeAircraftSources} />
      <CellInspectorLayer rasterOverlays={rasterOverlays ?? {}} sourceModes={sourceModes} />
      <IsochronLayer geojson={isochronGeojson ?? null} />
      <FlyToLocation location={selectedLocation ?? null} onArrived={handleArrived} />
      <DetailPopup
        detailPosition={detailPosition ?? null}
        triggerPosition={flyToPos}
        onDetailData={onDetailData}
        onDetailPositionChange={onDetailPositionChange}
      />
      {onViewChange && <MapStateSync onViewChange={onViewChange} />}
    </Map>
  )
}
