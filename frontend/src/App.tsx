import { useState, useCallback, useRef, lazy, Suspense } from 'react'
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
import { useUrlState, EMPTY_RASTER_OVERLAYS, type SourceMode } from './hooks/useUrlState'
import type { SelectedLocation } from './components/FlyToLocation'
import type { RealEstateFilters, Property } from './components/RealEstateLayer'
import type { NoiseComputeData } from './types/noise'
import type { QuietHex, QuietHexUpdate } from './components/HexLayer'
import { DEFAULT_BASEMAP, type BasemapId } from './utils/basemaps'

const AboutPage = lazy(() => import('./components/AboutPage'))

export default function App() {
  const isAbout = window.location.pathname.startsWith('/about')
  const { initial, updateUrl } = useUrlState()

  if (isAbout) {
    return (
      <Suspense fallback={<div className="h-screen w-screen bg-[#fafaf8]" />}>
        <AboutPage />
      </Suspense>
    )
  }

  const [selectedLocation, setSelectedLocation] = useState<SelectedLocation | null>(null)
  const [layersOpen, setLayersOpen] = useState(false)
  const [isochronActive, setIsochronActive] = useState(false)
  const [isochronGeojson, setIsochronGeojson] = useState<GeoJSON.Feature | null>(null)
  const [sourceModes, setSourceModes] = useState<Record<string, SourceMode>>(() => {
    // Aircraft has no UI toggle — popup/hex always include it; users toggle
    // the three aircraft *heatmap* layers via raster-overlay rows instead.
    const modes: Record<string, SourceMode> = { aircraft: '0db' }
    for (const id of ['road', 'railway', 'building', 'industrial']) {
      modes[id] = initial.layers.includes(id) ? '0db' : 'off'
    }
    for (const [id, mode] of Object.entries(initial.sourceModes)) {
      if (id !== 'aircraft' && initial.layers.includes(id)) modes[id] = mode
    }
    return modes
  })

  const [propagationFactors, setPropagationFactors] = useState<Record<string, boolean>>(() => {
    const factors: Record<string, boolean> = {
      terrain: true,
      screening: true,
      vegetation: true,
    }
    for (const id of initial.propagationDisabled) {
      factors[id] = false
    }
    return factors
  })
  const [detailPosition, setDetailPosition] = useState<{ lat: number; lng: number } | null>(initial.detailPosition)
  const [noiseDetailData, setNoiseDetailData] = useState<NoiseComputeData | null>(null)
  const [highlightGeometry, setHighlightGeometry] = useState<any | null>(null)
  const [quietHexData, setQuietHexData] = useState<QuietHex[]>([])
  const [quietVisible, setQuietVisible] = useState(false)
  const [quietDataRes, setQuietDataRes] = useState<number | null>(null)
  const [quietClustersEnabled, setQuietClustersEnabled] = useState(initial.quietClusters)
  const [quietThreshold, setQuietThreshold] = useState(initial.quietThreshold ?? 35)
  const [basemap, setBasemap] = useState<BasemapId>(initial.basemap ?? DEFAULT_BASEMAP)
  const [realEstateFilters, setRealEstateFilters] = useState<RealEstateFilters>({
    enabled: false, propertyType: 'all', listingType: 'all', maxNoise: 35,
  })
  const [selectedProperty, setSelectedProperty] = useState<Property | null>(null)
  const [rasterOverlays, setRasterOverlays] = useState<Record<string, boolean>>(
    initial.rasterOverlays ?? { ...EMPTY_RASTER_OVERLAYS },
  )
  const rasterOverlaysRef = useRef(rasterOverlays)
  rasterOverlaysRef.current = rasterOverlays

  const mapViewRef = useRef({ lat: initial.lat, lng: initial.lng, zoom: initial.zoom })
  const sourceModesRef = useRef(sourceModes)
  sourceModesRef.current = sourceModes
  const propagationRef = useRef(propagationFactors)
  const quietClustersRef = useRef(quietClustersEnabled)
  const quietThresholdRef = useRef(quietThreshold)
  const basemapRef = useRef(basemap)
  const quietDataResRef = useRef<number | null>(null)

  const syncUrl = useCallback((overrides?: Partial<{
    layers: Set<string>
    sourceModes: Record<string, SourceMode>
    quietClusters: boolean
    quietThreshold: number
    lat: number
    lng: number
    zoom: number
    detailPosition: { lat: number; lng: number } | null
    propagationDisabled: string[]
    basemap: BasemapId
    rasterOverlays: Record<string, boolean>
  }>) => {
    const v = mapViewRef.current
    const modes = overrides?.sourceModes ?? sourceModesRef.current
    const activeLayers = new Set(
      Object.entries(modes).filter(([, m]) => m !== 'off').map(([id]) => id)
    )
    const factors = propagationRef.current
    const disabledFactors = Object.entries(factors)
      .filter(([, enabled]) => !enabled)
      .map(([id]) => id)
    updateUrl({
      lat: overrides?.lat ?? v.lat,
      lng: overrides?.lng ?? v.lng,
      zoom: overrides?.zoom ?? v.zoom,
      layers: overrides?.layers ?? activeLayers,
      sourceModes: modes,
      quietClusters: overrides?.quietClusters ?? quietClustersRef.current,
      quietThreshold: overrides?.quietThreshold ?? quietThresholdRef.current,
      detailPosition: overrides?.detailPosition ?? null,
      propagationDisabled: overrides?.propagationDisabled ?? disabledFactors,
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

  const handleToggleSource = useCallback((sourceId: string) => {
    setQuietVisible(false)
    setSourceModes(prev => {
      const current = prev[sourceId] ?? '0db'
      const next = { ...prev, [sourceId]: current === 'off' ? '0db' : 'off' as SourceMode }
      syncUrl({ sourceModes: next })
      return next
    })
  }, [syncUrl])

  const handleSourceModeChange = useCallback((sourceId: string, mode: SourceMode) => {
    setQuietVisible(false)
    setSourceModes(prev => {
      const next = { ...prev, [sourceId]: mode }
      // Enforce single-diff: demote any other source currently in 'diff' to '0db'.
      // HexLayer only renders the first diff source; multi-diff would silently drop the rest.
      if (mode === 'diff') {
        for (const [id, m] of Object.entries(prev)) {
          if (id !== sourceId && m === 'diff') next[id] = '0db'
        }
      }
      syncUrl({ sourceModes: next })
      return next
    })
  }, [syncUrl])

  const handlePropagationChange = useCallback((factors: Record<string, boolean>) => {
    setQuietVisible(false)
    setPropagationFactors(factors)
    propagationRef.current = factors
    const disabled = Object.entries(factors)
      .filter(([, enabled]) => !enabled)
      .map(([id]) => id)
    syncUrl({ propagationDisabled: disabled })
  }, [syncUrl])

  const handleQuietClustersChange = useCallback((enabled: boolean) => {
    setQuietVisible(false)
    setQuietClustersEnabled(enabled)
    quietClustersRef.current = enabled
    syncUrl({ quietClusters: enabled })
  }, [syncUrl])

  const handleQuietThresholdChange = useCallback((threshold: number) => {
    setQuietThreshold(threshold)
    quietThresholdRef.current = threshold
    syncUrl({ quietThreshold: threshold })
  }, [syncUrl])

  const handleQuietHexUpdate = useCallback((update: QuietHexUpdate) => {
    if (update.phase === 'interactive') {
      if (quietDataResRef.current !== update.dataRes) {
        setQuietVisible(false)
      }
      return
    }

    quietDataResRef.current = update.dataRes
    setQuietHexData(update.hexes)
    setQuietDataRes(update.dataRes)
    setQuietVisible(true)
  }, [])

  const handleDetailPositionChange = useCallback((pos: { lat: number; lng: number } | null) => {
    setDetailPosition(pos)
    syncUrl({ detailPosition: pos })
  }, [syncUrl])

  const handleDetailData = useCallback((d: NoiseComputeData | null) => {
    setNoiseDetailData(d)
  }, [])

  const handleNoiseClose = useCallback(() => {
    setNoiseDetailData(null)
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
              sourceModes={sourceModes}
              onToggleSource={handleToggleSource}
              onSourceModeChange={handleSourceModeChange}
              propagationFactors={propagationFactors}
              onPropagationChange={handlePropagationChange}
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
        sourceModes={sourceModes}
        propagationFactors={propagationFactors}
        basemap={basemap}
        isochronGeojson={isochronGeojson}
        onViewChange={handleViewChange}
        onQuietHexUpdate={handleQuietHexUpdate}
        onDetailData={handleDetailData}
        onDetailPositionChange={handleDetailPositionChange}
        detailPosition={detailPosition}
        quietHexData={quietHexData}
        quietVisible={quietVisible}
        quietDataRes={quietDataRes}
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
          className="fixed bottom-[16px] right-[10px] z-[1003] flex h-[29px] w-[29px] items-center justify-center rounded-lg bg-white md:hidden"
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
          sourceModes={sourceModes}
          onToggleSource={handleToggleSource}
          onSourceModeChange={handleSourceModeChange}
          propagationFactors={propagationFactors}
          onPropagationChange={handlePropagationChange}
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
        onClose={() => { setNoiseDetailData(null); handleDetailPositionChange(null) }}
        onHighlight={setHighlightGeometry}
      />
    </div>
    </Tooltip.Provider>
  )
}
