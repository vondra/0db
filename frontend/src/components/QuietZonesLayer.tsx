import { useEffect, useState } from 'react'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { TileLayer } from '@deck.gl/geo-layers'
import { BitmapLayer } from '@deck.gl/layers'
import { useMap } from 'react-map-gl/maplibre'

import { fetchAndDecodeHM3, TILE_PX, NO_DATA } from '../lib/hm3-decoder'
import { tileBuildKey, tileUrl } from '../lib/tile-urls'

// Translucent green wash over pixels whose total Lden is at or below the
// user threshold. The legacy feature traced H3 hex clusters into outlined
// polygons (h3-js + flood-fill + boundary stitching) — all of which existed
// only because hexes had no raster to shade. The heatmap is now a z13 raster,
// so thresholding its pixels into a green bitmap is pixel-accurate and reuses
// the HM3 tile machinery with none of that complexity.
const QUIET_RGBA = [22, 163, 74, 110] as const // green-600 @ ~0.43

const MIN_ZOOM = 6
// deck upscales the z=13 texture for higher viewport zooms; we don't ship z14+.
const MAX_ZOOM = 13

interface Props {
  enabled: boolean
  /** Quiet if total Lden ≤ this (dB). NO_DATA pixels are excluded so the
   *  slider cleanly controls the highlighted band. */
  threshold: number
}

/**
 * Highlight quiet areas: a deck.gl `TileLayer` over the precomputed `total`
 * z13 raster that paints every pixel at or below `threshold` dB green. deck
 * handles viewport tile loading; a threshold change re-keys the layer so the
 * mask recomputes. Its own overlay sits above the heatmap so the wash shows
 * over the faint sub-40 dB heatmap colours.
 */
export default function QuietZonesLayer({ enabled, threshold }: Props): null {
  const { current: mapRef } = useMap()
  const [overlay, setOverlay] = useState<MapboxOverlay | null>(null)

  useEffect(() => {
    if (!mapRef) return
    const map = mapRef.getMap()
    const next = new MapboxOverlay({ interleaved: false, layers: [] })
    map.addControl(next)
    setOverlay(next)
    return () => {
      map.removeControl(next)
      setOverlay(null)
    }
  }, [mapRef])

  useEffect(() => {
    if (!overlay) return
    overlay.setProps({ layers: enabled ? [makeQuietLayer(threshold)] : [] })
  }, [overlay, enabled, threshold])

  return null
}

type QuietTile = { cells: Uint8Array }

function makeQuietLayer(threshold: number) {
  const maxByte = threshold * 2 // HM3 encodes dB × 2
  return new TileLayer<QuietTile | null>({
    // Build token in the id: a generation flip re-keys the layer so deck drops
    // its tile cache instead of masking stale-generation tiles (see tileBuildKey).
    id: `quiet-zones-${tileBuildKey()}`,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    tileSize: TILE_PX,
    // getTileData returns the raw decoded cells (threshold-independent), so a
    // threshold change keeps the tile cache instead of refetching. The object
    // wrapper is required — deck.gl's TileLayer mishandles a bare typed array
    // as tile data (it never reaches renderSubLayers as-is).
    getTileData: async ({ index, signal }) => {
      const url = tileUrl('total', index.z, index.x, index.y)
      try {
        const decoded = await fetchAndDecodeHM3(url, signal)
        return decoded ? { cells: decoded.cells } : null
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') throw err
        return null
      }
    },
    // Dragging the slider re-masks the cached tiles (CPU only) rather than
    // refetching the network — only renderSubLayers re-runs on a threshold change.
    updateTriggers: { renderSubLayers: [maxByte] },
    renderSubLayers: (props) => {
      const data = props.data as QuietTile | null
      if (!data) return null
      const { west, south, east, north } = props.tile.bbox as {
        west: number; south: number; east: number; north: number
      }
      return new BitmapLayer({
        id: `${props.id}-bitmap`,
        image: quietMaskToImageData(data.cells, maxByte),
        bounds: [west, south, east, north],
      })
    },
  })
}

/**
 * Paint cells with a computed Lden ≤ `maxByte` green; leave the rest
 * transparent. NO_DATA stays transparent — "no computed value" is not the
 * same as "quiet", and treating it as quiet would flood every gap between
 * sources and make the threshold slider meaningless.
 */
function quietMaskToImageData(cells: Uint8Array, maxByte: number): ImageData {
  const rgba = new Uint8ClampedArray(TILE_PX * TILE_PX * 4)
  const [r, g, b, a] = QUIET_RGBA
  for (let i = 0; i < cells.length; i++) {
    const byte = cells[i]
    if (byte === NO_DATA || byte > maxByte) continue
    const off = i * 4
    rgba[off] = r
    rgba[off + 1] = g
    rgba[off + 2] = b
    rgba[off + 3] = a
  }
  return new ImageData(rgba, TILE_PX, TILE_PX)
}
