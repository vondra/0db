import { useEffect, useState } from 'react'
import { useMap, Source, Layer } from 'react-map-gl/maplibre'
import { ldenToColor } from '../utils/noise-colors'
import { propertyJustClicked } from '../lib/property-click-guard'
import { DataPoint } from './noise/noise-tooltips'
import { txtTable } from '../utils/formatters'
import { SOURCE_LABELS } from './noise/shared'
import { SegmentList } from './noise/SegmentList'
import { TabStrip, type PopupTab } from './noise/TabStrip'
import { ContributorRow } from './noise/source/ContributorRow'
import type { NoiseComputeData } from '../types/noise'


export interface NoiseDetailContentProps {
  data: NoiseComputeData
  onHighlight?: (geometry: any | null) => void
  maxSources?: number
}

export function NoiseDetailContent({ data, onHighlight, maxSources }: NoiseDetailContentProps) {
  // Hide silence-sentinel values (sources with no audible contribution at this point).
  // The Rust engine returns periods even for empty source classes; their Lden falls
  // to ~−113 dB (silence) which is meaningless to display in the breakdown.
  const totalLdenText = data.total_lden != null
    ? txtTable([
        ...data.sources
          .filter(s => s.lden != null && s.lden > 0)
          .map(s => [SOURCE_LABELS[s.source_type] ?? s.source_type, `${s.lden!.toFixed(1)} dB`] as [string, string]),
        { sep: true },
        ['Total Lden', `${data.total_lden.toFixed(1)} dB`],
      ], 14, 9)
    : ''

  const [tab, setTab] = useState<PopupTab>('sources')
  // Mount the (up to 8000-row) Segments list only after its tab is first
  // visited — opening the popup on Sources must not pay to build it. Once
  // mounted it stays (display toggle) so per-row expanded state survives.
  const [segmentsMounted, setSegmentsMounted] = useState(false)
  const [fullSegments, setFullSegments] = useState<{
    segments: NoiseComputeData['segments']
    meta: NoiseComputeData['segments_meta']
  } | null>(null)
  const [loadingFull, setLoadingFull] = useState(false)
  // Reset augmented data whenever the user clicks a new point.
  useEffect(() => {
    setFullSegments(null)
    setLoadingFull(false)
  }, [data.h3_center[0], data.h3_center[1]])

  const displaySegments = fullSegments?.segments ?? data.segments ?? []
  const displayMeta = fullSegments?.meta ?? data.segments_meta ?? null
  const segmentsTotal = displayMeta?.total_count ?? displaySegments.length
  const hasSegmentsTab = segmentsTotal > 0
  const showSegments = tab === 'segments' && hasSegmentsTab

  const handleShowAll = async () => {
    if (loadingFull) return
    setLoadingFull(true)
    try {
      const [lat, lng] = data.h3_center
      const r = await fetch(`/api/noise-onfly-v2?lat=${lat}&lng=${lng}&full=1`)
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`)
      const next = (await r.json()) as NoiseComputeData
      setFullSegments({
        segments: next.segments ?? [],
        meta: next.segments_meta ?? null,
      })
    } finally {
      setLoadingFull(false)
    }
  }

  return (
    <div data-testid="detail-popup" role="dialog" className="px-2.5 pt-1 pb-2" onClick={(e) => e.stopPropagation()}>
      {data.total_lden != null ? (
        <>
          <div className="flex items-center justify-between mb-1">
            <span
              data-testid="noise-badge"
              className="text-2xl font-bold leading-none shrink-0"
              style={{ color: ldenToColor(data.total_lden) }}
            >
              <DataPoint title="Total Lden — energy sum across all sources" text={totalLdenText}>
                {data.total_lden.toFixed(1)} dB
              </DataPoint>
            </span>
            <div className="text-right pr-6">
              <div className="text-xs text-muted-foreground/60 font-mono leading-tight">
                {data.h3_center[0].toFixed(4)}, {data.h3_center[1].toFixed(4)}
              </div>
              {data.elevation_m > 0 && (
                <div className="text-xs text-muted-foreground/60 font-mono leading-tight">{Math.round(data.elevation_m)} m a.s.l.</div>
              )}
            </div>
          </div>
          {hasSegmentsTab ? (
            <TabStrip
              active={tab}
              sourceCount={data.top_contributors.length}
              segmentCount={segmentsTotal}
              onChange={(t) => { setTab(t); if (t === 'segments') setSegmentsMounted(true) }}
            />
          ) : (
            <div className="border-b border-border pb-0.5 mb-0.5">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Noise sources ({data.top_contributors.length})
              </span>
            </div>
          )}
          <div className="overflow-y-auto" style={{ maxHeight: 'max(100dvh - 400px, 160px)' }}>
            {/* Sources is always mounted; Segments mounts lazily (below) on first
                visit. Once mounted, both toggle via display so expanded-row state
                survives tab switches. */}
            <div style={{ display: showSegments ? 'none' : 'block' }}>
              {(maxSources ? data.top_contributors.slice(0, maxSources) : data.top_contributors).map((c, i) => (
                <ContributorRow key={`${c.source_type}-${c.osm_id}-${i}`} c={c} onToggle={onHighlight} />
              ))}
              {data.other_sources_lden !== null && Number.isFinite(data.other_sources_lden) && (
                <div className="flex items-baseline gap-1.5 px-0 py-1.5 border-t border-border/40 text-xs italic text-muted-foreground/70">
                  <span className="truncate flex-1">Other sources</span>
                  {/* Distance-column placeholder — keeps dB aligned with contributor rows above. */}
                  <span className="shrink-0 w-14" aria-hidden="true" />
                  <span className="shrink-0 w-14 text-right tabular-nums">
                    {data.other_sources_lden.toFixed(1)} dB
                  </span>
                  {/* Chevron-sized spacer so the right edge matches contributor rows. */}
                  <span aria-hidden="true" className="text-[10px] shrink-0 invisible">▼</span>
                </div>
              )}
            </div>
            {hasSegmentsTab && segmentsMounted && (
              <div style={{ display: showSegments ? 'block' : 'none' }}>
                <SegmentList
                  segments={displaySegments}
                  meta={displayMeta}
                  onHighlight={onHighlight}
                  onShowAll={handleShowAll}
                  loadingFull={loadingFull}
                />
              </div>
            )}
          </div>
          <TimingsOverlay timings={data.timings ?? null} />
        </>
      ) : (
        <div className="text-sm text-muted-foreground mt-1">No noise data computed for this location.</div>
      )}
    </div>
  )
}

function TimingsOverlay({ timings }: { timings: NoiseComputeData['timings'] }) {
  if (!timings) return null
  // Sort components by cost so the dominant bucket is visible at a glance.
  const rows: Array<[string, number]> = [
    ['road', timings.road_ms],
    ['rail', timings.rail_ms],
    ['building', timings.building_ms],
    ['industrial', timings.industrial_ms],
    ['ac airborne', timings.aircraft_airborne_ms],
    ['ac cruise', timings.aircraft_cruise_ms],
    ['ac ground', timings.aircraft_ground_ms],
    ['load', timings.load_ms],
    ['collect', timings.collect_ms],
  ]
  const total = rows.reduce((s, [, ms]) => s + ms, 0)
  const sorted = rows.sort((a, b) => b[1] - a[1])
  return (
    <div className="mt-2 pt-1.5 border-t border-border/30 text-[10px] font-mono text-muted-foreground/70 leading-tight">
      <div className="opacity-60 mb-0.5">⏱ popup-timing — Σ {total.toFixed(0)} ms (server, pre-JSON)</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0">
        {sorted.map(([k, ms]) => (
          <div key={k} className="flex justify-between">
            <span className="opacity-80">{k}</span>
            <span className="tabular-nums">{ms.toFixed(0)} ms</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export interface DetailPopupProps {
  detailPosition: { lat: number; lng: number } | null
  triggerPosition: { lat: number; lng: number } | null
  onDetailData?: (data: NoiseComputeData | null) => void
  onDetailPositionChange?: (pos: { lat: number; lng: number } | null) => void
  /// Fired when the noise fetch fails (non-abort). MVP-0: card stays
  /// open showing the position skeleton with an error message instead of
  /// silently unmounting via `onDetailPositionChange(null)` — Gemini
  /// /gg 2026-05-24 CRITICAL.
  onDetailError?: (message: string | null) => void
}

export default function DetailPopup({ detailPosition, triggerPosition, onDetailData, onDetailPositionChange, onDetailError }: DetailPopupProps) {
  const { current: map } = useMap()

  useEffect(() => {
    if (!map) return
    let dragStart: { x: number; y: number } | null = null

    const onMouseDown = (e: any) => {
      dragStart = { x: e.originalEvent.clientX, y: e.originalEvent.clientY }
    }

    const onClick = (e: any) => {
      if (dragStart) {
        const dx = e.originalEvent.clientX - dragStart.x
        const dy = e.originalEvent.clientY - dragStart.y
        if (Math.sqrt(dx * dx + dy * dy) > 5) return
      }
      if ((e.originalEvent.target as HTMLElement).closest('.maplibregl-popup')) return

      const { lat, lng } = e.lngLat
      // Defer a tick so a deck.gl property-marker click (separate overlay, which
      // can't suppress this MapLibre handler) registers first; skip if so, else
      // the noise popup opens on top of the PropertyCard.
      setTimeout(() => {
        if (!propertyJustClicked()) onDetailPositionChange?.({ lat, lng })
      }, 0)
    }

    map.on('mousedown', onMouseDown)
    map.on('click', onClick)
    return () => {
      map.off('mousedown', onMouseDown)
      map.off('click', onClick)
    }
  }, [map, onDetailPositionChange])

  useEffect(() => {
    if (triggerPosition) onDetailPositionChange?.(triggerPosition)
  }, [triggerPosition, onDetailPositionChange])

  useEffect(() => {
    if (!detailPosition || !map) return

    const controller = new AbortController()
    fetch(`/api/noise-onfly-v2?lat=${detailPosition.lat}&lng=${detailPosition.lng}`, { signal: controller.signal })
      .then(res => { if (!res.ok) throw new Error(`API ${res.status}`); return res.json() })
      .then((data: NoiseComputeData) => onDetailData?.(data))
      .catch(err => {
        if (err.name === 'AbortError') return
        console.error(err)
        // Keep `detailPosition` so the card stays open with a skeleton
        // → error state. Clearing position here (the pre-MVP-0 behavior)
        // unmounted the card and lost the user's clicked location.
        onDetailError?.(err instanceof Error ? err.message : String(err))
      })

    return () => controller.abort()
  }, [detailPosition, map, onDetailData, onDetailError])

  return (
    <>
      {detailPosition && (
        <Source id="clicked-point" type="geojson" data={{
          type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [detailPosition.lng, detailPosition.lat] }
        }}>
          <Layer id="clicked-point-marker" type="circle" paint={{
            'circle-radius': 6, 'circle-color': '#3b82f6', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
          }} />
        </Source>
      )}
    </>
  )
}
