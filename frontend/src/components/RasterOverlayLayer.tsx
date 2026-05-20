import { useEffect, useState } from 'react'
import { Source, Layer, useMap } from 'react-map-gl/maplibre'

interface RasterOverlayLayerProps {
  visibleLayers: Record<string, boolean>
}

/// `url` overrides the default `/api/raster/{id}/{z}/{x}/{y}.png` when
/// non-empty. Heatmap-v2-aircraft lives on its own route family
/// (`/api/heatmap-v2/...`), and reads from the binary HM2A tile cache
/// the heatmap-aircraft Rust crate writes — see
/// `engine/heatmap-aircraft` and `server/src/routes/heatmap-v2.ts`.
const LAYERS = [
  { id: 'dem', minzoom: 6, url: '' },
  { id: 'building', minzoom: 10, url: '' },
  { id: 'forest', minzoom: 8, url: '' },
  { id: 'barriers', minzoom: 12, url: '' },
  { id: 'aircraft-v2', minzoom: 6, url: '/api/heatmap-v2/aircraft/{z}/{x}/{y}.png' },
] as const

export default function RasterOverlayLayer({ visibleLayers }: RasterOverlayLayerProps) {
  const { current: mapRef } = useMap()
  const [styleState, setStyleState] = useState({
    epoch: 0,
    ready: false,
    ceilingReady: false,
  })

  useEffect(() => {
    if (!mapRef) return

    const map = mapRef.getMap()

    const sync = () => {
      setStyleState(prev => {
        const nextReady = !!map.isStyleLoaded()
        const nextCeilingReady = !!map.getLayer('_deck-ceiling')
        if (prev.ready === nextReady && prev.ceilingReady === nextCeilingReady) {
          return prev
        }
        return {
          epoch: prev.epoch + 1,
          ready: nextReady,
          ceilingReady: nextCeilingReady,
        }
      })
    }

    sync()
    map.on('style.load', sync)
    map.on('idle', sync)

    return () => {
      map.off('style.load', sync)
      map.off('idle', sync)
    }
  }, [mapRef])

  if (!styleState.ready) return null

  const beforeId = styleState.ceilingReady ? '_deck-ceiling' : undefined

  return (
    <>
      {LAYERS.map(({ id, minzoom, url }) =>
        visibleLayers[id] ? (
          <Source
            key={`${id}-${styleState.epoch}`}
            id={`raster-${id}`}
            type="raster"
            tiles={[url || `/api/raster/${id}/{z}/{x}/{y}.png`]}
            tileSize={256}
            minzoom={minzoom}
            maxzoom={id === 'aircraft-v2' ? 15 : 16}
          >
            <Layer
              id={`raster-${id}-layer`}
              type="raster"
              paint={{ 'raster-opacity': id === 'aircraft-v2' ? 1.0 : 0.7 }}
              {...(beforeId ? { beforeId } : {})}
            />
          </Source>
        ) : null,
      )}
    </>
  )
}
