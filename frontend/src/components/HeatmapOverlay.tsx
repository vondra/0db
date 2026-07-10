import { useCallback, useEffect, useRef, useState } from 'react'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { TileLayer } from '@deck.gl/geo-layers'
import { BitmapLayer, GeoJsonLayer } from '@deck.gl/layers'
import { useMap } from 'react-map-gl/maplibre'

import { fetchAndDecodeHM3, TILE_PX, NO_DATA } from '../lib/hm3-decoder'
import { composeToImageData } from '../lib/hm3-compose'
import { lngLatToTileFloat, tileXToLng, tileYToLat } from '../lib/tile-math'
import { BASE_ZOOM, MIN_ZOOM, buildKey, tileUrl, useTileBuild, type TileBuilds } from '../lib/tile-urls'

// The seven toggleable noise layers. All share the same HM3 format + palette
// (Lden), so the tile fetch/decode/energy-sum loop is layer-agnostic.
export const HEATMAP_LAYERS = [
  'road',
  'rail',
  'industrial',
  'building',
  'aircraft-ground',
  'aircraft-airborne',
  'aircraft-cruise',
] as const

export type HeatmapLayer = (typeof HEATMAP_LAYERS)[number]

// The overlay can also fetch the precomputed `total` (energy-sum of all seven).
// MapView passes `['total']` when every layer is on — the common case, one fetch.
export type HeatmapSource = HeatmapLayer | 'total'

interface Props {
  sources: readonly HeatmapSource[]
  highlightGeometry?: GeoJSON.Geometry | null
}

// Display zoom at/above which we stitch ONE composite image (no internal tile
// borders → no seam) instead of the per-tile TileLayer. deck already over-zooms
// the base tiles from ~half a zoom up (tileSize 512), so a faint seam exists below this too
// — but it only gets objectionable when magnified further, and only this deep
// does the viewport span few enough base tiles for the stitch to stay cheap (the
// MAX_COMPOSITE_TILES cap). Tuned by eye.
const OVERZOOM_FROM = BASE_ZOOM + 1
// One base tile of margin around the viewport so a small pan at deep zoom stays
// covered without an immediate rebuild (a base tile is magnified 2-8x here).
const COMPOSITE_MARGIN = 1
// Safety cap — never stitch a pathologically large composite (only trips if
// OVERZOOM_FROM is lowered toward normal zoom).
const MAX_COMPOSITE_TILES = 96

type HeatTile = { image: ImageData }
type Bounds = [number, number, number, number]
type Composite = { image: ImageData; bounds: Bounds }
type LngLatBounds = { getWest(): number; getEast(): number; getNorth(): number; getSouth(): number }

/**
 * Render the noise heatmap with TWO modes, switched by zoom:
 *
 *  - **Normal zoom (< z14):** deck.gl `TileLayer` of per-tile `BitmapLayer`s.
 *    deck owns viewport tile selection, fetch, cache and parent-tile fallback —
 *    fast and native. At native resolution the per-tile seam is sub-pixel.
 *  - **Over-zoom (≥ z14):** ONE stitched composite `BitmapLayer` over the few
 *    base-zoom tiles under the viewport. A single texture has no internal borders, so
 *    the seam that per-tile clamp-to-edge sampling shows when magnified is gone.
 *    Few tiles at this zoom, so the stitch is cheap.
 *
 * Each tile (and the composite) is fetched as static `.bin`, decoded +
 * energy-summed (multi-layer subsets) + palette-mapped to `ImageData` in the
 * browser — server stays a dumb static/CDN reader. Interleaved overlay + a
 * `beforeId` of the first label layer keeps city labels on top.
 */
export default function HeatmapOverlay({ sources, highlightGeometry }: Props): null {
  const { current: mapRef } = useMap()
  // Generation snapshot: a build flip re-renders and re-keys every layer; the
  // snapshot is passed explicitly into URL builders so no fetch closure ever
  // reads newer module state than the layer it feeds (no mixed generations).
  const build = useTileBuild()
  const [overlay, setOverlay] = useState<MapboxOverlay | null>(null)
  const labelAnchor = useRef<string | undefined>(undefined)
  // The stitched over-zoom composite (≥ z14). `sig` is the source + z13-range key
  // it was built for, so a pan within the same tiles skips the rebuild.
  const composite = useRef<(Composite & { sig: string }) | null>(null)
  // Bumped before each build so a slow stitch can't overwrite a newer one.
  const buildSeq = useRef(0)
  const applyRef = useRef<() => void>(() => {})
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // One interleaved MapboxOverlay (shares MapLibre's GL context).
  useEffect(() => {
    if (!mapRef) return
    const map = mapRef.getMap()
    const next = new MapboxOverlay({ interleaved: true, layers: [] })
    map.addControl(next)
    setOverlay(next)
    return () => {
      map.removeControl(next)
      setOverlay(null)
    }
  }, [mapRef])

  // Pick the mode by zoom and push the deck layers. Cheap — no fetch (the
  // composite is built in `update`); also handles label-anchor + highlight changes.
  const apply = useCallback(() => {
    if (!overlay || !mapRef) return
    const map = mapRef.getMap()
    const beforeId = labelAnchor.current
    const layers = []
    // No published build yet (manifest still resolving) → no tile layers; the
    // store notification re-renders us the moment it lands.
    if (sources.length > 0 && build !== null) {
      const c = composite.current
      const overzoom = map.getZoom() >= OVERZOOM_FROM
      // Paint the stitched composite ONLY while its `sig` matches the live view.
      // After a layer toggle (or a pan/zoom that out-raced its rebuild) the cached
      // composite is for the wrong source/range — fall back to the per-tile
      // TileLayer (correct data, maybe a faint seam) rather than paint stale tiles,
      // until `update` rebuilds the matching composite.
      if (overzoom && c && c.sig === compositeSig(build, sources, baseRange(map.getBounds()))) {
        layers.push(new BitmapLayer({
          id: 'hm3-composite',
          image: c.image,
          bounds: c.bounds,
          beforeId,
          textureParameters: { minFilter: 'linear', magFilter: 'linear' },
        }))
      } else {
        layers.push(makeHeatmapTileLayer(build, sources, beforeId))
      }
    }
    layers.push(...makeHighlightLayers(highlightGeometry))
    overlay.setProps({ layers })
  }, [overlay, mapRef, build, sources, highlightGeometry])
  applyRef.current = apply

  // Rebuild the over-zoom composite (only past OVERZOOM_FROM, only when the base range/sources
  // changed) then re-apply. Coalesced to one run per frame. Below OVERZOOM_FROM it's
  // just a re-apply (deck drives the TileLayer itself).
  const update = useCallback(() => {
    if (pending.current) return
    pending.current = true
    requestAnimationFrame(async () => {
      pending.current = false
      const map = mapRef?.getMap()
      if (!map || !mounted.current) return
      if (map.getZoom() >= OVERZOOM_FROM && sources.length > 0 && build !== null) {
        const range = baseRange(map.getBounds())
        const sig = compositeSig(build, sources, range)
        if (composite.current?.sig !== sig) {
          // Re-apply NOW so the stale composite (built for the old source/range)
          // stops painting immediately — `apply`'s sig guard falls back to the
          // per-tile TileLayer — instead of lingering on screen for the ~100ms the
          // rebuild takes. The matching composite is painted by the apply below.
          applyRef.current()
          const seq = ++buildSeq.current
          const built = await buildComposite(range, sources, build)
          if (!mounted.current || seq !== buildSeq.current) return // unmounted or superseded
          composite.current = built ? { ...built, sig } : null
        }
      }
      applyRef.current()
    })
  }, [mapRef, sources, build])

  // Re-run on source/highlight/overlay change. `overlay` is load-bearing: it's null
  // on first render, so the mount-time update() no-ops (apply guards on overlay);
  // re-firing once it lands paints the heatmap on load without needing a pan/zoom.
  useEffect(() => {
    update()
  }, [update, highlightGeometry, overlay])

  // Re-apply + (≥z14) rebuild the composite after the viewport settles.
  useEffect(() => {
    if (!mapRef) return
    const map = mapRef.getMap()
    map.on('moveend', update)
    return () => {
      map.off('moveend', update)
    }
  }, [mapRef, update])

  // Track the basemap's first label layer as the heatmap's z-anchor (beforeId).
  useEffect(() => {
    if (!mapRef) return
    const map = mapRef.getMap()
    const sync = () => {
      const layers = map.getStyle()?.layers
      // Anchor below the first label layer so labels draw on top. Standard +
      // satellite rename labels `_label-*`; the Positron fallback doesn't, so
      // fall back to the first symbol layer.
      const id = layers?.find((l) => l.id.startsWith('_label'))?.id
        ?? layers?.find((l) => l.type === 'symbol')?.id
      if (id !== labelAnchor.current) {
        labelAnchor.current = id
        applyRef.current()
      }
    }
    sync()
    map.on('styledata', sync)
    return () => {
      map.off('styledata', sync)
    }
  }, [mapRef])

  return null
}

/** Per-tile heatmap as a deck `TileLayer` (used below the over-zoom threshold).
 *  `build` is the generation SNAPSHOT this layer is constructed for — both the
 *  id (deck's cache key) and every fetch URL use it, so the layer can never mix
 *  generations even if the module-level build advances mid-flight. */
function makeHeatmapTileLayer(
  build: TileBuilds,
  sources: readonly HeatmapSource[],
  beforeId: string | undefined,
) {
  return new TileLayer<HeatTile | null>({
    id: `hm3-tiles-${buildKey(build, sources)}`,
    // beforeId on the TileLayer (NOT its sublayers): MapboxOverlay slots only the
    // top-level deck layer; the tile BitmapLayers draw inside it. Spread because
    // _TileLayerProps doesn't type beforeId though MapboxOverlay reads it at runtime.
    ...(beforeId ? { beforeId } : {}),
    minZoom: MIN_ZOOM,
    maxZoom: BASE_ZOOM,
    tileSize: TILE_PX,
    maxCacheSize: 512,
    // One fetch+decode per tile, so allow more in flight → faster fill.
    maxRequests: 12,
    // 'no-overlap', NOT 'best-available': the Lden palette is highly opaque, so
    // best-available's brief parent+child overlap during a zoom double-draws the
    // colour → a dark flash. no-overlap never overlaps them.
    refinementStrategy: 'no-overlap',
    getTileData: async ({ index, signal }) => {
      const { x, y, z } = index
      const span = 2 ** z
      const wx = ((x % span) + span) % span // wrap x across the antimeridian
      const decoded = await Promise.all(
        sources.map((s) =>
          fetchAndDecodeHM3(tileUrl(build, s, z, wx, y), signal).catch((err) => {
            if ((err as DOMException)?.name === 'AbortError') throw err
            return null
          }),
        ),
      )
      const grids = decoded.flatMap((d) => (d?.cells ? [d.cells] : []))
      if (grids.length === 0) return null // cache the empty slot (no refetch)
      return { image: composeToImageData(grids, TILE_PX, TILE_PX) }
    },
    renderSubLayers: (props) => {
      const data = props.data as HeatTile | null
      if (!data) return null
      const { west, south, east, north } = props.tile.bbox as {
        west: number; south: number; east: number; north: number
      }
      return new BitmapLayer({
        id: `${props.id}-bitmap`,
        image: data.image,
        bounds: [west, south, east, north],
        textureParameters: { minFilter: 'linear', magFilter: 'linear' },
      })
    },
  })
}

type Range = { z: number; span: number; x0: number; x1: number; y0: number; y1: number; cols: number; rows: number }

/** Identity of a built composite — tile build + source set + base tile range.
 *  `update` skips a rebuild while this is unchanged; `apply` paints the composite
 *  only while it still matches the live view (else the cached one is stale → fall
 *  back to tiles). The build snapshot makes a mid-session generation flip rebuild
 *  the composite instead of keeping stale-generation pixels. */
function compositeSig(build: TileBuilds, sources: readonly HeatmapSource[], range: Range): string {
  return `${buildKey(build, sources)}|${[...sources].join(',')}|${range.x0},${range.x1},${range.y0},${range.y1}`
}

/** The base-zoom tile range covering `bounds` (+ a 1-tile margin), clamped to the world. */
function baseRange(bounds: LngLatBounds): Range {
  const z = BASE_ZOOM
  const span = 2 ** z
  const [xWest, yNorth] = lngLatToTileFloat(bounds.getWest(), bounds.getNorth(), z)
  const [xEast, ySouth] = lngLatToTileFloat(bounds.getEast(), bounds.getSouth(), z)
  const x0 = Math.floor(xWest) - COMPOSITE_MARGIN
  const x1 = Math.floor(xEast) + COMPOSITE_MARGIN
  const y0 = Math.max(0, Math.floor(yNorth) - COMPOSITE_MARGIN)
  const y1 = Math.min(span - 1, Math.floor(ySouth) + COMPOSITE_MARGIN)
  return { z, span, x0, x1, y0, y1, cols: x1 - x0 + 1, rows: y1 - y0 + 1 }
}

/** Stitch the base-zoom tiles of `range` (energy-summed across sources, palette-mapped)
 *  into ONE seamless `ImageData` + its geo bounds. Null if nothing audible. All
 *  source×tile fetches run in one parallel batch. */
async function buildComposite(
  range: Range,
  sources: readonly HeatmapSource[],
  build: TileBuilds,
): Promise<Composite | null> {
  const { z, span, x0, x1, y0, y1, cols, rows } = range
  if (cols < 1 || rows < 1 || cols * rows > MAX_COMPOSITE_TILES) return null
  const width = cols * TILE_PX
  const height = rows * TILE_PX
  const jobs: Array<{ source: string; tx: number; ty: number }> = []
  for (const source of sources) {
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) jobs.push({ source, tx, ty })
    }
  }
  const decoded = await Promise.all(
    jobs.map(({ source, tx, ty }) => {
      const wx = ((tx % span) + span) % span
      return fetchAndDecodeHM3(tileUrl(build, source, z, wx, ty)).catch(() => null)
    }),
  )
  // Bucket the landed tiles into one grid per source (allocated only on first hit).
  const gridBySource = new Map<string, Uint8Array>()
  decoded.forEach((d, i) => {
    if (!d?.cells) return
    const { source, tx, ty } = jobs[i]
    let grid = gridBySource.get(source)
    if (!grid) {
      grid = new Uint8Array(width * height).fill(NO_DATA)
      gridBySource.set(source, grid)
    }
    blit(d.cells, grid, (tx - x0) * TILE_PX, (ty - y0) * TILE_PX, width)
  })
  const grids = [...gridBySource.values()]
  if (grids.length === 0) return null
  const image = composeToImageData(grids, width, height)
  const bounds: Bounds = [tileXToLng(x0, z), tileYToLat(y1 + 1, z), tileXToLng(x1 + 1, z), tileYToLat(y0, z)]
  return { image, bounds }
}

/** Copy a TILE_PX×TILE_PX tile into `grid` at pixel offset (ox, oy), row by row. */
function blit(cells: Uint8Array, grid: Uint8Array, ox: number, oy: number, width: number) {
  for (let r = 0; r < TILE_PX; r++) {
    grid.set(cells.subarray(r * TILE_PX, (r + 1) * TILE_PX), (oy + r) * width + ox)
  }
}

/**
 * Contributor-highlight casing + core pair: a wider black stroke under a thinner
 * white one (readable on any basemap). No `beforeId` → drawn last, above labels.
 */
function makeHighlightLayers(geometry: GeoJSON.Geometry | null | undefined) {
  if (!geometry) return []
  const data: GeoJSON.Feature = { type: 'Feature', geometry, properties: {} }
  return [
    new GeoJsonLayer({
      id: 'contributor-highlight-casing',
      data,
      stroked: true, filled: true,
      getLineColor: [0, 0, 0, 255],
      getLineWidth: 5, lineWidthMinPixels: 5, lineWidthUnits: 'pixels',
      getFillColor: [255, 255, 255, 76],
      getPointRadius: 5, pointRadiusUnits: 'pixels',
      pickable: false,
    }),
    new GeoJsonLayer({
      id: 'contributor-highlight-core',
      data,
      stroked: true, filled: false,
      getLineColor: [255, 255, 255, 255],
      getLineWidth: 2, lineWidthMinPixels: 2, lineWidthUnits: 'pixels',
      getPointRadius: 3, pointRadiusUnits: 'pixels',
      pickable: false,
    }),
  ]
}
