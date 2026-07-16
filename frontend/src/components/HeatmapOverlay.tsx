import { useCallback, useEffect, useRef, useState } from 'react'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { TileLayer } from '@deck.gl/geo-layers'
import { BitmapLayer, GeoJsonLayer } from '@deck.gl/layers'
import { useMap } from 'react-map-gl/maplibre'

import { fetchAndDecodeHM3, TILE_PX, NO_DATA } from '../lib/hm3-decoder'
import { composeOffThread } from '../lib/compose-off-thread'
import { PREVIEW_DELTA } from '../lib/hm3-compose'
import { lngLatToTileFloat, tileXToLng, tileYToLat } from '../lib/tile-math'
import { BASE_ZOOM, MIN_ZOOM, WORLD_EXTENT, buildKey, tileUrl, useTileBuild, type TileBuilds } from '../lib/tile-urls'

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

type HeatTile = {
  image: ImageData
  /** Cancels the progressive tail (fetches deck can no longer abort — it
   *  disarms its own abort at our early resolve). Wired to onTileUnload. */
  abortRefine?: () => void
}

// Head start before a partially-loaded tile resolves early: on a warm CDN the
// full layer set lands inside this window, deck keeps its whole normal
// lifecycle (request throttling + aborts, zero progressive overhead) — only
// genuinely slow loads resolve early and refine as layers land. Their tails
// escape deck's maxRequests budget by design: they are same-viewport work
// that still fills the tile cache, they are bounded by the wave size, and
// every cancellation path (eviction, re-key, unmount) can reach them —
// enforcing the budget exactly would mean reimplementing deck's scheduler.
const EARLY_RESOLVE_AFTER_MS = 250

// Grace period before the ancestor preview may win the paint race: a warm-CDN
// full load typically completes under this, so everyday browsing paints sharp
// directly — the blocky preview only appears where loads are genuinely slow.
const PREVIEW_GRACE_MS = 80

// Ancestor fetches are memoized: a whole block of children (4^Δ tiles) shares
// one ancestor and the browser does NOT coalesce concurrent fetches of the
// same URL — without this a cold wave fired a duplicate ancestor request per
// tile (owner report 2026-07-16). Shared resource, so deliberately NOT tied to any one tile's
// abort; 'low' priority keeps sharp tiles ahead in the network queue. (deck's
// own sharp-path fetch of the same URL after a deep zoom-out can still
// duplicate one request — rare, lands on the warmed CDN band, accepted.)
// Tiles deck evicted while their load was still pending — their late resolve
// must not register in the loaded-tile registry (see getTileData).
const unloadedWhilePending = new WeakSet<Promise<HeatTile | null>>()

type AncestorEntry = { promise: Promise<{ cells: Uint8Array } | null>; done: boolean }
const ancestorMemo = new Map<string, AncestorEntry>()
const ANCESTOR_MEMO_MAX = 128
function fetchAncestor(url: string): Promise<{ cells: Uint8Array } | null> {
  const hit = ancestorMemo.get(url)
  if (hit) {
    // True LRU: refresh recency on every hit.
    ancestorMemo.delete(url)
    ancestorMemo.set(url, hit)
    return hit.promise
  }
  const entry: AncestorEntry = {
    promise: fetchAndDecodeHM3(url, undefined, 'low').catch(() => {
      // A failed fetch must not negative-cache as "empty ancestor".
      ancestorMemo.delete(url)
      return null
    }),
    done: false,
  }
  void entry.promise.finally(() => { entry.done = true })
  ancestorMemo.set(url, entry)
  if (ancestorMemo.size > ANCESTOR_MEMO_MAX) {
    // Evict the oldest SETTLED entry — never an in-flight promise another
    // tile is about to share (in-flight count bounds any temporary overshoot).
    for (const [key, e] of ancestorMemo) {
      if (e.done) {
        ancestorMemo.delete(key)
        break
      }
    }
  }
  return entry.promise
}

/**
 * Progressive multi-layer tile load: give the full set a short head start;
 * past it, resolve with whatever landed FIRST so the tile paints at the
 * fastest layer's latency, then recompose as the remaining layers land
 * (coalesced to one compose per frame per tile) by swapping the image on the
 * same tile object — the caller's `onRefined` bumps deck's repaint trigger.
 * The partial energy sum transiently underestimates — a lighter shade for a
 * moment beats a blank tile — and converges to the exact sum with the last
 * layer. A failed single layer renders as that layer being empty
 * (pre-existing behavior).
 *
 * While the real layers load, the z−Δ ANCESTOR (Δ = PREVIEW_DELTA) races
 * them as a preview: one ancestor serves 4^Δ children (browser-cached) and
 * the warm-crawled z≤9 band keeps it an edge HIT, so a cold-area tile paints
 * a smooth coarse energy field ~instantly instead of nothing. The first real
 * compose replaces it; a preview with nothing real behind it clears to
 * transparent once every layer settles empty (a preview must never lie
 * permanently).
 *
 * Lifecycle: deck releases its request slot and disarms its abort the moment
 * we resolve (tile-2d-header marks the tile loaded), and it never calls
 * onTileUnload when finalizing a whole layer — so the tail fetches run on our
 * OWN controller, registered in `tails`: cancelled by onTileUnload (eviction)
 * or by the component when the tile layer itself is swapped out.
 */
async function loadTileProgressively(
  urls: string[],
  deckSignal: AbortSignal | undefined,
  onRefined: () => void,
  tails: Set<() => void>,
  previewSpec: { urls: string[]; blockX: number; blockY: number } | null,
  hasDeckFallback?: () => boolean,
): Promise<HeatTile | null> {
  const ctl = new AbortController()
  if (deckSignal?.aborted) ctl.abort()
  deckSignal?.addEventListener('abort', () => ctl.abort())
  // The preview has its OWN controller: it dies with the tile (chained), and
  // is also cancelled the moment it becomes useless — a real grid landed, or
  // the load completed — without touching the real fetches.
  const previewCtl = new AbortController()
  if (ctl.signal.aborted) previewCtl.abort() // the chained listener below can't fire retroactively
  ctl.signal.addEventListener('abort', () => previewCtl.abort())
  const grids: Uint8Array[] = []
  const perFetch = urls.map((u) =>
    fetchAndDecodeHM3(u, ctl.signal)
      .then((d) => {
        if (d?.cells) {
          grids.push(d.cells)
          previewCtl.abort() // real data beats any preview from here on
        }
      })
      .catch(() => { /* abort, or a failed layer → renders empty */ }),
  )
  const allDone = Promise.all(perFetch)
  let allSettled = false
  void allDone.then(() => { allSettled = true })
  let previewImage: ImageData | null = null
  let previewSettled: Promise<unknown> = Promise.resolve()
  const previewReady = new Promise<void>((resolve) => {
    const spec = previewSpec
    if (!spec) return
    previewSettled = (async () => {
      const decoded = await Promise.all(spec.urls.map((u) => fetchAncestor(u)))
      if (previewCtl.signal.aborted) return
      const ancestors = decoded.flatMap((d) => (d?.cells ? [d.cells] : []))
      if (ancestors.length === 0 || previewCtl.signal.aborted) return
      // The worker upsamples each ancestor's sub-block AND composes — the
      // main thread only ships the raw ancestor grids.
      previewImage = await composeOffThread(ancestors, TILE_PX, TILE_PX, {
        x: spec.blockX,
        y: spec.blockY,
      })
      resolve()
    })().catch(() => { /* a failed preview just never shows */ })
  })
  await Promise.race([
    allDone,
    new Promise<void>((resolve) => setTimeout(resolve, EARLY_RESOLVE_AFTER_MS)),
    // The preview may only win after a grace period, so a warm-CDN full load
    // paints sharp directly instead of flashing blocky first.
    new Promise<void>((resolve) => setTimeout(resolve, PREVIEW_GRACE_MS)).then(() => previewReady),
  ])
  if (!allSettled) {
    // Slow load → progressive: wake on every settle, proceed once ANY real
    // grid landed, the ancestor preview is ready, or everything settled.
    const firstGrid = new Promise<void>((resolve) => {
      for (const p of perFetch) void p.then(() => { if (grids.length > 0) resolve() })
    })
    await Promise.race([allDone, previewReady, firstGrid])
    if (!allSettled && grids.length === 0 && previewImage && hasDeckFallback?.()) {
      // A sharper cached ancestor landed while the preview was in flight —
      // resolving coarse now would HIDE it (no-overlap shows the exact tile
      // once loaded). Drop the preview and wait for real data instead.
      previewImage = null
      await Promise.race([allDone, firstGrid])
    }
  }
  if (ctl.signal.aborted) throw new DOMException('tile aborted', 'AbortError')
  if (allSettled) {
    // Complete load (fast path): plain tile, no tail to manage.
    previewCtl.abort()
    if (grids.length === 0) return null
    const image = await composeOffThread(grids, TILE_PX, TILE_PX)
    if (ctl.signal.aborted) throw new DOMException('tile aborted', 'AbortError')
    return { image }
  }
  const abortTail = () => ctl.abort()
  tails.add(abortTail)
  // Deregister on allDone only: the preview fetch is a SHARED memoized
  // resource that must not pin per-tile closures in the registry; a late
  // preview compose is already gated by previewCtl.signal.
  void allDone.then(() => tails.delete(abortTail))
  let composedCount = grids.length
  let scheduled = false
  // Real data when any landed; otherwise the race guarantees the preview
  // (transparent fallback is defensive only).
  const image = composedCount > 0
    ? await composeOffThread(grids.slice(0, composedCount), TILE_PX, TILE_PX)
    : previewImage ?? new ImageData(TILE_PX, TILE_PX)
  if (ctl.signal.aborted) throw new DOMException('tile aborted', 'AbortError')
  const data: HeatTile = { image, abortRefine: abortTail }
  const recomposeSoon = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      if (ctl.signal.aborted) return
      if (grids.length === composedCount) {
        // Preview with nothing real behind it: once every layer settled
        // empty, clear to a transparent tile instead of lying forever.
        if (allSettled && grids.length === 0) {
          previewCtl.abort()
          data.image = new ImageData(TILE_PX, TILE_PX)
          onRefined()
        }
        return
      }
      // composedCount only advances on SUCCESS — a rejected compose (worker
      // death mid-OOM) stays retryable by the next settle.
      const target = grids.length
      composeOffThread(grids.slice(0, target), TILE_PX, TILE_PX)
        .then((refined) => {
          if (ctl.signal.aborted) return
          composedCount = target
          data.image = refined
          onRefined()
        })
        .catch(() => { /* retried on the next settle */ })
    })
  }
  for (const p of perFetch) void p.then(recomposeSoon)
  return data
}
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

  // Progressive-refine repaint: a tile whose late layers landed swapped its
  // image in place — bump the trigger and re-apply (coalesced per frame) so
  // deck re-runs renderSubLayers and uploads the new ImageData.
  const refineSeq = useRef(0)
  const refinePending = useRef(false)
  const onRefined = useCallback(() => {
    refineSeq.current++
    if (refinePending.current) return
    refinePending.current = true
    requestAnimationFrame(() => {
      refinePending.current = false
      if (mounted.current) applyRef.current()
    })
  }, [])
  // Live progressive tails + the loaded-tile registry of the CURRENT tile
  // layer. deck never aborts a tile it already resolved and never calls
  // onTileUnload when finalizing a whole layer — so a layer swap (build/source
  // re-key, composite mode, unmount) must cancel the tails here. `loaded`
  // mirrors deck's session cache (z/x/y keys) so the ancestor preview can
  // yield to deck's own better fallback (owner policy 2026-07-16: exact zoom >
  // z−1 > z−2 > … > coarse preview > blank).
  const tileTails = useRef<{ key: string; aborts: Set<() => void>; loaded: Set<string> }>(
    { key: '', aborts: new Set(), loaded: new Set() },
  )
  const dropTileTails = useCallback((nextKey: string) => {
    if (tileTails.current.key === nextKey) return
    for (const abort of tileTails.current.aborts) abort()
    tileTails.current.aborts.clear()
    tileTails.current.loaded.clear()
    tileTails.current.key = nextKey
  }, [])
  useEffect(() => () => dropTileTails(''), [dropTileTails])
  // Retina/HiDPI: fetch one pyramid level finer so one data cell ≈ one device
  // pixel on the zooms where a finer level exists (≤ z11 viewports; z12 is the
  // data floor). Costs 4× tiles for DPR ≥ 1.5 screens — owner call 2026-07-16
  // ("to chci"). Re-render if the window moves to a screen with different DPR.
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio))
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`)
    const onChange = () => setDpr(window.devicePixelRatio)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [dpr])
  // A DPR flip re-creates `apply` but nothing else calls it — apply NOW so the
  // re-keyed layer (offset is part of the id) fetches the finer/coarser level.
  useEffect(() => { applyRef.current() }, [dpr])

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
        dropTileTails('') // the tile layer is gone — its tails must not linger
        layers.push(new BitmapLayer({
          id: 'hm3-composite',
          image: c.image,
          bounds: c.bounds,
          beforeId,
          textureParameters: { minFilter: 'linear', magFilter: 'linear' },
        }))
      } else {
        const zoomOffset = dpr >= 1.5 ? 1 : 0
        // Offset is part of the registry key AND the layer id: a DPR flip must
        // re-key the layer (deck won't recompute tile selection on an options
        // change alone) and start a fresh loaded/tails registry with it.
        dropTileTails(`${buildKey(build, sources)}-o${zoomOffset}`)
        layers.push(makeHeatmapTileLayer(
          build, sources, beforeId, refineSeq.current, onRefined,
          tileTails.current.aborts, tileTails.current.loaded, zoomOffset,
        ))
      }
    } else {
      dropTileTails('') // every source off (or no build) removes the layer too
    }
    layers.push(...makeHighlightLayers(highlightGeometry))
    overlay.setProps({ layers })
  }, [overlay, mapRef, build, sources, highlightGeometry, onRefined, dropTileTails, dpr])
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
          const built = await buildComposite(range, sources, build, () => seq !== buildSeq.current)
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

  // Idle ancestor prefetch (owner ask 2026-07-16): once the viewport settles,
  // quietly pull the 3×3 ring of ancestor tiles around the view plus the
  // centre block one zoom deeper — memoized, low-priority, ≤10 × |sources|
  // small requests fired 600 ms after the map stops (deliberately outside
  // deck's request budget: they must never queue ahead of sharp tiles) — so
  // ANY pan or zoom direction already has its blurry preview in memory.
  const prefetchTimer = useRef(0)
  useEffect(() => {
    if (!mapRef || build === null || sources.length === 0) return
    const map = mapRef.getMap()
    const prefetchRing = () => {
      window.clearTimeout(prefetchTimer.current)
      prefetchTimer.current = window.setTimeout(() => {
        const z = Math.round(Math.min(Math.max(map.getZoom(), MIN_ZOOM), BASE_ZOOM))
        const pz = z - PREVIEW_DELTA
        if (pz < MIN_ZOOM) return
        const center = map.getCenter()
        const [fx, fy] = lngLatToTileFloat(center.lng, center.lat, pz)
        const span = 2 ** pz
        for (let dy = -1; dy <= 1; dy++) {
          const ay = Math.floor(fy) + dy
          if (ay < 0 || ay >= span) continue
          for (let dx = -1; dx <= 1; dx++) {
            const ax = (((Math.floor(fx) + dx) % span) + span) % span
            for (const s of sources) void fetchAncestor(tileUrl(build, s, pz, ax, ay))
          }
        }
        // Zoom-in ahead: the centre ancestor block ONE level deeper, so the
        // first wheel step also finds its preview waiting (zoom-out ancestors
        // are already cached from the way down). moveend fires after zooms
        // too, so the ring itself re-targets on every zoom change.
        if (pz + 1 <= BASE_ZOOM - PREVIEW_DELTA) {
          const deepSpan = 2 ** (pz + 1)
          const [zx, zy] = lngLatToTileFloat(center.lng, center.lat, pz + 1)
          const ax = ((Math.floor(zx) % deepSpan) + deepSpan) % deepSpan
          const ay = Math.floor(zy)
          if (ay >= 0 && ay < deepSpan) {
            for (const s of sources) void fetchAncestor(tileUrl(build, s, pz + 1, ax, ay))
          }
        }
      }, 600)
    }
    map.on('moveend', prefetchRing)
    prefetchRing()
    return () => {
      window.clearTimeout(prefetchTimer.current)
      map.off('moveend', prefetchRing)
    }
  }, [mapRef, build, sources])

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
  refineSeq: number,
  onRefined: () => void,
  tails: Set<() => void>,
  loaded: Set<string>,
  zoomOffset: number,
) {
  return new TileLayer<HeatTile | null>({
    id: `hm3-tiles-${buildKey(build, sources)}-o${zoomOffset}`,
    // beforeId on the TileLayer (NOT its sublayers): MapboxOverlay slots only the
    // top-level deck layer; the tile BitmapLayers draw inside it. Spread because
    // _TileLayerProps doesn't type beforeId though MapboxOverlay reads it at runtime.
    ...(beforeId ? { beforeId } : {}),
    minZoom: MIN_ZOOM,
    maxZoom: BASE_ZOOM,
    // +1 on HiDPI screens: one data cell ≈ one device pixel wherever a finer
    // pyramid level exists (maxZoom still clamps at the z12 data floor).
    zoomOffset,
    // Without an extent deck renders NOTHING once the computed tile zoom drops
    // below minZoom (world views under z≈1.5 were blank — owner report
    // 2026-07-16); with one it clamps to minZoom and scales the z2 world
    // tiles instead (deck getTileIndices contract).
    extent: WORLD_EXTENT,
    tileSize: TILE_PX,
    maxCacheSize: 512,
    // One fetch+decode per tile, so allow more in flight → faster fill.
    maxRequests: 12,
    // 'no-overlap', NOT 'best-available': the Lden palette is highly opaque, so
    // best-available's brief parent+child overlap during a zoom double-draws the
    // colour → a dark flash. no-overlap never overlaps them.
    refinementStrategy: 'no-overlap',
    getTileData: ({ index, signal }) => {
      const { x, y, z } = index
      const span = 2 ** z
      const wx = ((x % span) + span) % span // wrap x across the antimeridian
      const urls = sources.map((s) => tileUrl(build, s, z, wx, y))
      // Owner fallback policy 2026-07-16: exact zoom > deck's cached z−1 >
      // z−2 > … > coarse preview > blank. If ANY nearby ancestor is already
      // session-loaded, skip the preview — deck's no-overlap refinement keeps
      // painting that sharper ancestor until this tile's data lands (an empty
      // resolved ancestor counts too: blank IS its truth).
      const deckFallback = () => {
        for (let d = 1; d <= 6 && z - d >= MIN_ZOOM; d++) {
          if (loaded.has(`${z - d}/${wx >> d}/${y >> d}`)) return true
        }
        return false
      }
      const deckHasFallback = deckFallback()
      // z−Δ ancestor for the instant preview (shallow zooms are the warm band
      // itself — no preview needed or possible below the z2 floor).
      const pz = z - PREVIEW_DELTA
      const mask = (1 << PREVIEW_DELTA) - 1
      const preview = !deckHasFallback && pz >= MIN_ZOOM
        ? {
            urls: sources.map((s) => tileUrl(build, s, pz, wx >> PREVIEW_DELTA, y >> PREVIEW_DELTA)),
            blockX: wx & mask,
            blockY: y & mask,
          }
        : null
      let p: Promise<HeatTile | null>
      p = loadTileProgressively(urls, signal, onRefined, tails, preview, deckFallback).then((data) => {
        // A tile evicted while still pending gets no future onTileUnload —
        // registering it would leave a ghost ancestor forever (and grow the
        // set unboundedly under fast panning).
        if (!unloadedWhilePending.has(p)) loaded.add(`${z}/${wx}/${y}`)
        return data
      })
      return p
    },
    // Bumped by onRefined when a tile's late layers land — deck re-runs
    // renderSubLayers, and only mutated tiles carry a NEW ImageData reference
    // (unchanged tiles keep their texture; the sublayer descriptors of the
    // visible set are recreated, a few ms coalesced to one frame per wave).
    updateTriggers: { renderSubLayers: refineSeq },
    // deck can no longer abort a tile once it resolved (see
    // loadTileProgressively) — cancel the progressive tail ourselves when the
    // tile leaves the cache, so evicted tiles stop fetching and repainting.
    onTileUnload: (tile) => {
      const { x, y, z } = tile.index
      const span = 2 ** z
      loaded.delete(`${z}/${((x % span) + span) % span}/${y}`)
      const d = tile.data
      if (!d) return
      // A still-pending tile can be evicted without deck aborting it — cancel
      // its tail the moment it resolves instead of letting it refine a ghost,
      // and bar its resolve from registering in `loaded`.
      if (d instanceof Promise) {
        unloadedWhilePending.add(d)
        void d.then((t) => t?.abortRefine?.()).catch(() => {})
      } else {
        d.abortRefine?.()
      }
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
  isStale: () => boolean,
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
  // A pan/zoom during the fetches supersedes this composite — bail before the
  // big compose (up to 96 tiles) so stale work never queues ahead of fresh
  // tile composes in the single worker.
  if (isStale()) return null
  const image = await composeOffThread(grids, width, height)
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
