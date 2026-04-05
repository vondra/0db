import { useState, useCallback, useRef } from 'react'
import AboutPage from './components/AboutPage'
import MapView from './components/MapView'
import SearchBar from './components/SearchBar'
import IsochronPanel from './components/IsochronPanel'
import ControlCard from './components/ControlCard'
import DetailCard from './components/DetailCard'
import LayersPanel from './components/LayersPanel'
import MobileDetailSheet from './components/MobileDetailSheet'
import BasemapBar from './components/BasemapBar'
import { useUrlState } from './hooks/useUrlState'
import type { SelectedLocation } from './components/FlyToLocation'
import type { RealEstateFilters } from './components/RealEstateLayer'
import type { NoiseComputeData } from './components/DetailPopup'
import type { HexFeature } from './components/HexLayer'
import { DEFAULT_BASEMAP, type BasemapId } from './utils/basemaps'

export default function App() {
  if (window.location.pathname.startsWith('/about')) {
    return <AboutPage />
  }

  const { initial, updateUrl } = useUrlState()

  const [selectedLocation, setSelectedLocation] = useState<SelectedLocation | null>(null)
  const [layersOpen, setLayersOpen] = useState(false)
  const [isochronActive, setIsochronActive] = useState(false)
  const [isochronGeojson, setIsochronGeojson] = useState<GeoJSON.Feature | null>(null)
  const [activeSources, setActiveSources] = useState<Set<string>>(
    new Set(initial.layers)
  )
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
  const [hexData, setHexData] = useState<HexFeature[]>([])
  const [quietClustersEnabled, setQuietClustersEnabled] = useState(initial.quietClusters)
  const [quietThreshold, setQuietThreshold] = useState(initial.quietThreshold ?? 35)
  const [basemap, setBasemap] = useState<BasemapId>(initial.basemap ?? DEFAULT_BASEMAP)
  const [realEstateFilters, setRealEstateFilters] = useState<RealEstateFilters>({
    enabled: false, propertyType: 'all', listingType: 'all', maxNoise: 35,
  })

  const mapViewRef = useRef({ lat: initial.lat, lng: initial.lng, zoom: initial.zoom })
  const activeSourcesRef = useRef(activeSources)
  const propagationRef = useRef(propagationFactors)
  const quietClustersRef = useRef(quietClustersEnabled)
  const quietThresholdRef = useRef(quietThreshold)
  const basemapRef = useRef(basemap)

  const syncUrl = useCallback((overrides?: Partial<{
    layers: Set<string>
    quietClusters: boolean
    quietThreshold: number
    lat: number
    lng: number
    zoom: number
    detailPosition: { lat: number; lng: number } | null
    propagationDisabled: string[]
    basemap: BasemapId
  }>) => {
    const v = mapViewRef.current
    const factors = propagationRef.current
    const disabledFactors = Object.entries(factors)
      .filter(([, enabled]) => !enabled)
      .map(([id]) => id)
    updateUrl({
      lat: overrides?.lat ?? v.lat,
      lng: overrides?.lng ?? v.lng,
      zoom: overrides?.zoom ?? v.zoom,
      layers: overrides?.layers ?? activeSourcesRef.current,
      quietClusters: overrides?.quietClusters ?? quietClustersRef.current,
      quietThreshold: overrides?.quietThreshold ?? quietThresholdRef.current,
      detailPosition: overrides?.detailPosition ?? null,
      propagationDisabled: overrides?.propagationDisabled ?? disabledFactors,
      basemap: overrides?.basemap ?? basemapRef.current,
    })
  }, [updateUrl])

  const handleViewChange = useCallback((lat: number, lng: number, zoom: number) => {
    mapViewRef.current = { lat, lng, zoom }
    syncUrl({ lat, lng, zoom })
  }, [syncUrl])

  const handleToggleSource = useCallback((sourceId: string) => {
    setActiveSources(prev => {
      const next = new Set(prev)
      if (next.has(sourceId)) next.delete(sourceId)
      else next.add(sourceId)
      activeSourcesRef.current = next
      syncUrl({ layers: next })
      return next
    })
  }, [syncUrl])

  const handlePropagationChange = useCallback((factors: Record<string, boolean>) => {
    setPropagationFactors(factors)
    propagationRef.current = factors
    const disabled = Object.entries(factors)
      .filter(([, enabled]) => !enabled)
      .map(([id]) => id)
    syncUrl({ propagationDisabled: disabled })
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
              activeSources={activeSources}
              onToggleSource={handleToggleSource}
              propagationFactors={propagationFactors}
              onPropagationChange={handlePropagationChange}
              quietClustersEnabled={quietClustersEnabled}
              onQuietClustersChange={handleQuietClustersChange}
              quietThreshold={quietThreshold}
              onQuietThresholdChange={handleQuietThresholdChange}
              realEstateFilters={realEstateFilters}
              onRealEstateChange={setRealEstateFilters}
            />
          </div>
          <div className="pointer-events-auto">
            <DetailCard
              noiseData={noiseDetailData}
              onNoiseClose={handleNoiseClose}
              onHighlight={setHighlightGeometry}
            />
          </div>
        </div>

        <div className="pointer-events-auto">
          <BasemapBar basemap={basemap} onBasemapChange={handleBasemapChange} />
        </div>
      </div>

      <MapView
        selectedLocation={selectedLocation}
        initialCenter={[initial.lat, initial.lng]}
        initialZoom={initial.zoom}
        activeSources={activeSources}
        propagationFactors={propagationFactors}
        basemap={basemap}
        isochronGeojson={isochronGeojson}
        onViewChange={handleViewChange}
        onHexData={setHexData}
        onDetailData={handleDetailData}
        onDetailPositionChange={handleDetailPositionChange}
        initialDetailPosition={initial.detailPosition}
        hexData={hexData}
        quietClustersEnabled={quietClustersEnabled}
        quietThreshold={quietThreshold}
        highlightGeometry={highlightGeometry}
        realEstateFilters={realEstateFilters}
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
          activeSources={activeSources}
          onToggleSource={handleToggleSource}
          propagationFactors={propagationFactors}
          onPropagationChange={handlePropagationChange}
          quietClustersEnabled={quietClustersEnabled}
          onQuietClustersChange={handleQuietClustersChange}
          quietThreshold={quietThreshold}
          onQuietThresholdChange={handleQuietThresholdChange}
          realEstateFilters={realEstateFilters}
          onRealEstateChange={setRealEstateFilters}
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
  )
}
