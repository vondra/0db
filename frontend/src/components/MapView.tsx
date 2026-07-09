import { useState, useCallback, useEffect, useMemo } from 'react'
import Map, { NavigationControl } from 'react-map-gl/maplibre'
import type { StyleSpecification } from 'maplibre-gl'
import FlyToLocation from './FlyToLocation'
import DetailPopup from './DetailPopup'
import QuietZonesLayer from './QuietZonesLayer'
import RealEstateLayer from './RealEstateLayer'
import ValidationLayer, { type ValidationSelection } from './ValidationLayer'
import IsochronLayer from './IsochronLayer'
import RasterOverlayLayer from './RasterOverlayLayer'
import HeatmapOverlay, { HEATMAP_LAYERS } from './HeatmapOverlay'
import HoverTooltip from './HoverTooltip'
import CellInspectorLayer from './CellInspectorLayer'
import MapStateSync from './MapStateSync'
import { DEFAULT_BASEMAP, loadBasemapStyle, type BasemapId } from '../utils/basemaps'
import { QUIET_THRESHOLD_DEFAULT } from '../hooks/useUrlState'
import type { SelectedLocation } from './FlyToLocation'
import type { NoiseComputeData } from '../types/noise'
import 'maplibre-gl/dist/maplibre-gl.css'

interface MapViewProps {
  selectedLocation?: SelectedLocation | null
  initialCenter?: [number, number]
  initialZoom?: number
  basemap?: BasemapId
  onViewChange?: (lat: number, lng: number, zoom: number) => void
  onDetailData?: (data: NoiseComputeData | null) => void
  onDetailPositionChange?: (pos: { lat: number; lng: number } | null) => void
  onDetailError?: (message: string | null) => void
  detailPosition?: { lat: number; lng: number } | null
  quietClustersEnabled?: boolean
  quietThreshold?: number
  highlightGeometry?: any | null
  isochronGeojson?: GeoJSON.Feature | null
  realEstateFilters?: import('./RealEstateLayer').RealEstateFilters
  onPropertySelect?: (property: import('./RealEstateLayer').Property | null) => void
  rasterOverlays?: Record<string, boolean>
  validationEnabled?: boolean
  onValidationSelect?: (selection: ValidationSelection) => void
}

export default function MapView({
  selectedLocation, initialCenter, initialZoom,
  basemap, onViewChange, onDetailData, onDetailPositionChange, onDetailError, detailPosition,
  quietClustersEnabled, quietThreshold, highlightGeometry, isochronGeojson, realEstateFilters, onPropertySelect, rasterOverlays,
  validationEnabled, onValidationSelect,
}: MapViewProps) {
  const center = initialCenter ?? [49.8, 15.5]
  const zoom = initialZoom ?? 8
  const bm = basemap ?? DEFAULT_BASEMAP
  const [flyToPos, setFlyToPos] = useState<{ lat: number; lng: number } | null>(null)
  const [mapStyle, setMapStyle] = useState<string | StyleSpecification | null>(null)

  const handleArrived = useCallback((pos: { lat: number; lng: number }) => {
    setFlyToPos(pos)
  }, [])

  const activeHeatmapSources = useMemo(() => {
    const active = HEATMAP_LAYERS.filter(s => !!rasterOverlays?.[s])
    // All seven on → fetch the single precomputed `total` tile (one fetch, no
    // client-side sum); any subset → fetch + energy-sum those layers.
    return active.length === HEATMAP_LAYERS.length ? (['total'] as const) : active
  }, [rasterOverlays])

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
      <RasterOverlayLayer visibleLayers={rasterOverlays ?? {}} />
      {/* Highlight rides on the same deck.gl canvas as the heatmap so
          it always draws above the HM3 tiles. A separate MapLibre
          Source/Layer would sit under the non-interleaved deck canvas
          and disappear whenever any heatmap was active. */}
      <HeatmapOverlay
        sources={activeHeatmapSources}
        highlightGeometry={highlightGeometry ?? null}
      />
      <QuietZonesLayer enabled={quietClustersEnabled ?? false} threshold={quietThreshold ?? QUIET_THRESHOLD_DEFAULT} />
      {/* After the heatmap + quiet overlays so the property markers (their own
          deck overlay) stack on top rather than being hidden under the heatmap. */}
      {realEstateFilters && <RealEstateLayer filters={realEstateFilters} onPropertySelect={onPropertySelect} />}
      {/* Validation anchors above every data overlay — a dot click also lands
          the ordinary map click, so the noise popup opens for the same spot
          (measured next to modelled is the point). Mounted only with `val=1`
          so ordinary visitors never pay for the extra overlay. */}
      {validationEnabled && <ValidationLayer onSelect={onValidationSelect} />}
      <HoverTooltip sources={activeHeatmapSources} />
      <CellInspectorLayer rasterOverlays={rasterOverlays ?? {}} />
      <IsochronLayer geojson={isochronGeojson ?? null} />
      <FlyToLocation location={selectedLocation ?? null} onArrived={handleArrived} />
      <DetailPopup
        detailPosition={detailPosition ?? null}
        triggerPosition={flyToPos}
        onDetailData={onDetailData}
        onDetailPositionChange={onDetailPositionChange}
        onDetailError={onDetailError}
      />
      {onViewChange && <MapStateSync onViewChange={onViewChange} />}
    </Map>
  )
}
