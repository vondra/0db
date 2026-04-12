import { Source, Layer } from 'react-map-gl/maplibre'

interface RasterOverlayLayerProps {
  visibleLayers: Record<string, boolean>
}

const LAYERS = [
  { id: 'dem', minzoom: 6 },
  { id: 'building', minzoom: 10 },
  { id: 'forest', minzoom: 8 },
] as const

export default function RasterOverlayLayer({ visibleLayers }: RasterOverlayLayerProps) {
  return (
    <>
      {LAYERS.map(({ id, minzoom }) =>
        visibleLayers[id] ? (
          <Source
            key={id}
            id={`raster-${id}`}
            type="raster"
            tiles={[`/api/raster/${id}/{z}/{x}/{y}.png`]}
            tileSize={256}
            minzoom={minzoom}
            maxzoom={16}
          >
            <Layer
              id={`raster-${id}-layer`}
              type="raster"
              paint={{ 'raster-opacity': 0.7 }}
              beforeId="_deck-ceiling"
            />
          </Source>
        ) : null,
      )}
    </>
  )
}
