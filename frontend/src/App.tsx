import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react'
import { Tooltip } from '@base-ui/react/tooltip'
import MapView from './components/MapView'
import SearchBar from './components/SearchBar'
import IsochronPanel from './components/IsochronPanel'
import ControlCard from './components/ControlCard'
import DetailCard from './components/DetailCard'
import LayersPanel from './components/LayersPanel'
import MobileDetailSheet from './components/MobileDetailSheet'
import BasemapBar from './components/BasemapBar'
import PropertyCard from './components/PropertyCard'
import FloatingCard from './components/FloatingCard'
import { useUrlState, EMPTY_RASTER_OVERLAYS, QUIET_THRESHOLD_DEFAULT } from './hooks/useUrlState'
import type { SelectedLocation } from './components/FlyToLocation'
import type { RealEstateFilters, Property } from './components/RealEstateLayer'
import type { NoiseComputeData } from './types/noise'
import { DEFAULT_BASEMAP, type BasemapId } from './utils/basemaps'

const AboutPage = lazy(() => import('./components/AboutPage'))

export default function App() {
  // Route split: /about and the map app must not share one component instance,
  // or the early return would skip MapApp's hooks on the next render and break
  // React's hook order (Rules-of-Hooks). Keep all map state inside MapApp.
  if (window.location.pathname.startsWith('/about')) {
    return (
      <Suspense fallback={<div className="h-screen w-screen bg-[#fafaf8]" />}>
        <AboutPage />
      </Suspense>
    )
  }
  return <MapApp />
}

function MapApp() {
  const { initial, updateUrl } = useUrlState()

  const [selectedLocation, setSelectedLocation] = useState<SelectedLocation | null>(null)
  const [layersOpen, setLayersOpen] = useState(false)
  const [isochronActive, setIsochronActive] = useState(false)
  const [isochronGeojson, setIsochronGeojson] = useState<GeoJSON.Feature | null>(null)
  const [detailPosition, setDetailPosition] = useState<{ lat: number; lng: number } | null>(initial.detailPosition)
  const [noiseDetailData, setNoiseDetailData] = useState<NoiseComputeData | null>(null)
  // MVP-0: card opens skeleton-immediate-on-click; error path keeps the
  // position so user sees the failure context instead of card vanishing.
  const [noiseDetailError, setNoiseDetailError] = useState<string | null>(null)
  const [highlightGeometry, setHighlightGeometry] = useState<any | null>(null)
  const [quietClustersEnabled, setQuietClustersEnabled] = useState(initial.quietClusters)
  const [quietThreshold, setQuietThreshold] = useState(initial.quietThreshold ?? QUIET_THRESHOLD_DEFAULT)
  const [basemap, setBasemap] = useState<BasemapId>(initial.basemap ?? DEFAULT_BASEMAP)
  const [realEstateFilters, setRealEstateFilters] = useState<RealEstateFilters>({
    enabled: false, propertyType: 'all', listingType: 'all', maxNoise: 60,
  })
  const [selectedProperty, setSelectedProperty] = useState<Property | null>(null)
  const [rasterOverlays, setRasterOverlays] = useState<Record<string, boolean>>(
    initial.rasterOverlays ?? { ...EMPTY_RASTER_OVERLAYS },
  )
  const rasterOverlaysRef = useRef(rasterOverlays)
  rasterOverlaysRef.current = rasterOverlays

  const mapViewRef = useRef({ lat: initial.lat, lng: initial.lng, zoom: initial.zoom })
  const quietClustersRef = useRef(quietClustersEnabled)
  const quietThresholdRef = useRef(quietThreshold)
  const basemapRef = useRef(basemap)

  // Pre-warm the lazy popup-body chunk the instant a point is clicked, so it
  // downloads concurrently with the ~1.5 s noise compute instead of after it
  // (gg: codex+agy — React.lazy only fetches when the component first renders,
  // which is after data arrives; this overlaps the network with the compute).
  useEffect(() => {
    if (detailPosition) void import('./components/NoiseDetailContent')
  }, [detailPosition])

  const syncUrl = useCallback((overrides?: Partial<{
    quietClusters: boolean
    quietThreshold: number
    lat: number
    lng: number
    zoom: number
    detailPosition: { lat: number; lng: number } | null
    basemap: BasemapId
    rasterOverlays: Record<string, boolean>
  }>) => {
    const v = mapViewRef.current
    updateUrl({
      lat: overrides?.lat ?? v.lat,
      lng: overrides?.lng ?? v.lng,
      zoom: overrides?.zoom ?? v.zoom,
      quietClusters: overrides?.quietClusters ?? quietClustersRef.current,
      quietThreshold: overrides?.quietThreshold ?? quietThresholdRef.current,
      detailPosition: overrides?.detailPosition ?? null,
      basemap: overrides?.basemap ?? basemapRef.current,
      rasterOverlays: overrides?.rasterOverlays ?? rasterOverlaysRef.current,
    })
  }, [updateUrl])

  const handleRasterOverlaysChange = useCallback((next: Record<string, boolean>) => {
    setRasterOverlays(next)
    rasterOverlaysRef.current = next
    syncUrl({ rasterOverlays: next })
  }, [syncUrl])

  const handleViewChange = useCallback((lat: number, lng: number, zoom: number) => {
    mapViewRef.current = { lat, lng, zoom }
    syncUrl({ lat, lng, zoom })
  }, [syncUrl])

  const handleQuietClustersChange = useCallback((enabled: boolean) => {
    setQuietClustersEnabled(enabled)
    quietClustersRef.current = enabled
    syncUrl({ quietClusters: enabled })
  }, [syncUrl])

  const handleQuietThresholdChange = useCallback((threshold: number) => {
    setQuietThreshold(threshold)
    quietThresholdRef.current = threshold
    syncUrl({ quietThreshold: threshold })
  }, [syncUrl])

  const handleDetailPositionChange = useCallback((pos: { lat: number; lng: number } | null) => {
    setDetailPosition(pos)
    // Fresh click: clear stale data + error so the new skeleton renders
    // for the new position (Codex /gg 2026-05-24 WARNING — position-match
    // gating in the card is the back-stop).
    if (pos) {
      setNoiseDetailData(null)
      setNoiseDetailError(null)
    }
    syncUrl({ detailPosition: pos })
  }, [syncUrl])

  const handleDetailData = useCallback((d: NoiseComputeData | null) => {
    setNoiseDetailData(d)
    if (d) {
      setNoiseDetailError(null)
    } else {
      // Backend returned valid-but-empty (no R4 coverage, all-silent point).
      // Surface as an error so the skeleton stops spinning forever —
      // Gemini /gg #82 WARNING. NoiseDetailContent's own
      // "No noise data computed" path renders only after `data` is set
      // with total_lden=null; an outright null payload bypasses it.
      setNoiseDetailError('No data available for this location')
    }
  }, [])

  const handleDetailError = useCallback((msg: string | null) => {
    setNoiseDetailError(msg)
  }, [])

  const handleNoiseClose = useCallback(() => {
    setNoiseDetailData(null)
    setNoiseDetailError(null)
    setHighlightGeometry(null)
    handleDetailPositionChange(null)
  }, [handleDetailPositionChange])

  const handleIsochronGo = useCallback(async (req: { lat: number; lng: number; time: number; modes: string[] }) => {
    try {
      const url = `/api/isochron?lat=${req.lat}&lng=${req.lng}&time=${req.time}&modes=${req.modes.join(',')}`
      const res = await fetch(url)
      if (!res.ok) throw new Error('Isochron fetch failed')
      setIsochronGeojson(await res.json())
    } catch (err) {
      console.error('Isochron error:', err)
      setIsochronGeojson(null)
    }
  }, [])

  const handleBasemapChange = useCallback((id: BasemapId) => {
    setBasemap(id)
    basemapRef.current = id
    syncUrl({ basemap: id })
  }, [syncUrl])

  return (
    <Tooltip.Provider>
    <div className="relative h-screen w-screen overflow-hidden">
      <SearchBar
        onSelect={setSelectedLocation}
        onIsochronToggle={() => setIsochronActive(prev => !prev)}
        isochronActive={isochronActive}
        onSearchInput={() => setIsochronActive(false)}
        mapCenter={mapViewRef.current}
      />

      <IsochronPanel
        location={selectedLocation ? { lat: Number(selectedLocation.lat), lng: Number(selectedLocation.lon) } : null}
        onGo={handleIsochronGo}
        active={isochronActive}
      />

      {/* UI overlays */}
      <div className="absolute inset-0 z-[1002] pointer-events-none">
        <div className="hidden md:flex absolute top-3 right-3 flex-col gap-2 w-[320px]">
          <div className="pointer-events-auto">
            <ControlCard
              quietClustersEnabled={quietClustersEnabled}
              onQuietClustersChange={handleQuietClustersChange}
              quietThreshold={quietThreshold}
              onQuietThresholdChange={handleQuietThresholdChange}
              realEstateFilters={realEstateFilters}
              onRealEstateChange={setRealEstateFilters}
              rasterOverlays={rasterOverlays}
              onRasterOverlayChange={handleRasterOverlaysChange}
            />
          </div>
          <div className="pointer-events-auto">
            <DetailCard
              noiseData={noiseDetailData}
              position={detailPosition}
              error={noiseDetailError}
              onNoiseClose={handleNoiseClose}
              onHighlight={setHighlightGeometry}
            />
          </div>
          {selectedProperty && (
            <div className="pointer-events-auto">
              <FloatingCard>
                <PropertyCard
                  property={selectedProperty}
                  onClose={() => setSelectedProperty(null)}
                />
              </FloatingCard>
            </div>
          )}
        </div>

        <div className="pointer-events-auto">
          <BasemapBar basemap={basemap} onBasemapChange={handleBasemapChange} />
        </div>
      </div>

      <MapView
        selectedLocation={selectedLocation}
        initialCenter={[initial.lat, initial.lng]}
        initialZoom={initial.zoom}
        basemap={basemap}
        isochronGeojson={isochronGeojson}
        onViewChange={handleViewChange}
        onDetailData={handleDetailData}
        onDetailPositionChange={handleDetailPositionChange}
        onDetailError={handleDetailError}
        detailPosition={detailPosition}
        quietClustersEnabled={quietClustersEnabled}
        quietThreshold={quietThreshold}
        highlightGeometry={highlightGeometry}
        realEstateFilters={realEstateFilters}
        onPropertySelect={setSelectedProperty}
        rasterOverlays={rasterOverlays}
      />

      {/* Mobile: layers toggle button */}
      {!layersOpen && (
        <button
          onClick={() => { setLayersOpen(true); setNoiseDetailData(null); handleDetailPositionChange(null) }}
          className="fixed bottom-[16px] right-[10px] z-[1003] flex h-11 w-11 items-center justify-center rounded-lg bg-white md:hidden"
          style={{ boxShadow: '0 0 0 2px rgba(0,0,0,.1)' }}
          aria-label="Toggle layers panel"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2" />
            <polyline points="2 17 12 22 22 17" />
            <polyline points="2 12 12 17 22 12" />
          </svg>
        </button>
      )}

      {/* Mobile: layers panel (bottom sheet) */}
      <div className="md:hidden">
        <LayersPanel
          open={layersOpen}
          onClose={() => setLayersOpen(false)}
          quietClustersEnabled={quietClustersEnabled}
          onQuietClustersChange={handleQuietClustersChange}
          quietThreshold={quietThreshold}
          onQuietThresholdChange={handleQuietThresholdChange}
          realEstateFilters={realEstateFilters}
          onRealEstateChange={setRealEstateFilters}
          rasterOverlays={rasterOverlays}
          onRasterOverlayChange={handleRasterOverlaysChange}
        />
      </div>

      {/* Mobile: detail sheet */}
      <a
        href="/about"
        className="hidden md:block fixed bottom-1.5 right-2 z-[1001] px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground bg-white/80 rounded shadow-sm"
      >
        About 0db.app
      </a>

      <MobileDetailSheet
        data={noiseDetailData}
        position={detailPosition}
        error={noiseDetailError}
        onClose={() => { setNoiseDetailData(null); setNoiseDetailError(null); handleDetailPositionChange(null) }}
        onHighlight={setHighlightGeometry}
      />
    </div>
    </Tooltip.Provider>
  )
}
