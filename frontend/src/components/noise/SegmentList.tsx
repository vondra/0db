import { useMemo, useState } from 'react'
import type {
  AirborneTrace,
  SegmentKind,
  SegmentTrace,
  SegmentTracesSummary,
} from '../../types/noise'
import { AirborneRow } from './AirborneRow'
import { SegmentRow } from './SegmentRow'

const KIND_FILTERS: { key: SegmentKind; label: string }[] = [
  { key: 'road', label: 'Roads' },
  { key: 'railway', label: 'Rails' },
  { key: 'aircraft_ground', label: 'Aircraft ground' },
  { key: 'aircraft_airborne', label: 'Airborne' },
  { key: 'building', label: 'Buildings' },
  { key: 'industrial', label: 'Industrial' },
]

type UnifiedEntry =
  | { kind: 'segment'; trace: SegmentTrace; sortKey: number }
  | { kind: 'airborne'; trace: AirborneTrace; sortKey: number }

function traceKind(t: SegmentTrace): SegmentKind {
  // SegmentTrace.kind in the engine is SourceKind (Road/Railway/Building/Industrial/Aircraft).
  // Aircraft here means ground ops — airborne aircraft come through airborne_traces separately.
  if (t.kind === 'aircraft') return 'aircraft_ground'
  return t.kind as SegmentKind
}

function countsByKind(meta: SegmentTracesSummary | null | undefined) {
  return {
    road: meta?.road_count ?? 0,
    railway: meta?.railway_count ?? 0,
    aircraft_ground: meta?.aircraft_ground_count ?? 0,
    aircraft_airborne: meta?.aircraft_airborne_count ?? 0,
    building: meta?.building_count ?? 0,
    industrial: meta?.industrial_count ?? 0,
  } as Record<SegmentKind, number>
}

export function SegmentList({
  segments,
  airborne,
  meta,
  receiverLatLon,
  onHighlight,
  onShowAll,
  loadingFull = false,
}: {
  segments: SegmentTrace[]
  airborne: AirborneTrace[]
  meta: SegmentTracesSummary | null
  receiverLatLon: [number, number]
  onHighlight?: (geometry: unknown | null) => void
  onShowAll?: () => void | Promise<void>
  loadingFull?: boolean
}) {
  const [enabled, setEnabled] = useState<Record<SegmentKind, boolean>>(() =>
    Object.fromEntries(KIND_FILTERS.map(k => [k.key, true])) as Record<SegmentKind, boolean>,
  )

  const counts = countsByKind(meta)

  const entries = useMemo<UnifiedEntry[]>(() => {
    const rows: UnifiedEntry[] = []
    for (const s of segments) {
      const kind = traceKind(s)
      if (!enabled[kind]) continue
      rows.push({ kind: 'segment', trace: s, sortKey: s.received_lden.full })
    }
    for (const a of airborne) {
      if (!enabled.aircraft_airborne) continue
      rows.push({ kind: 'airborne', trace: a, sortKey: a.received_lden })
    }
    rows.sort((x, y) => y.sortKey - x.sortKey)
    return rows
  }, [segments, airborne, enabled])

  const shownCount = segments.length + airborne.length
  const totalCount = meta?.total_count ?? shownCount
  const truncated = meta?.truncated ?? false

  return (
    <div>
      <div className="flex gap-1 pb-1 overflow-x-auto whitespace-nowrap -mx-1 px-1 scrollbar-thin">
        {KIND_FILTERS.map(({ key, label }) => {
          const kindCount = counts[key]
          if (kindCount === 0 && shownCount > 0) return null
          const on = enabled[key]
          return (
            <button
              key={key}
              type="button"
              onClick={() => setEnabled(e => ({ ...e, [key]: !e[key] }))}
              title={`${label} — ${kindCount} segment${kindCount === 1 ? '' : 's'} (click to ${on ? 'hide' : 'show'})`}
              className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 transition-colors ${
                on
                  ? 'border-foreground/80 text-foreground bg-foreground/10'
                  : 'border-border/50 text-muted-foreground/40 line-through hover:text-foreground'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>
      <div>
        {entries.map(e =>
          e.kind === 'segment' ? (
            <SegmentRow
              key={`s-${e.trace.osm_id ?? 'pt'}-${e.trace.segment_idx}`}
              trace={e.trace}
              onHighlight={onHighlight}
            />
          ) : (
            <AirborneRow
              key={`a-${e.trace.flight_id}-${e.trace.period}`}
              trace={e.trace}
              receiverLatLon={receiverLatLon}
              onHighlight={onHighlight}
            />
          ),
        )}
      </div>
      {truncated && (
        <div className="flex items-center justify-between border-t border-border/40 py-1 text-[10px] text-muted-foreground">
          <span>
            Showing {shownCount.toLocaleString()} of {totalCount.toLocaleString()}
          </span>
          <button
            disabled={loadingFull || !onShowAll}
            onClick={() => void onShowAll?.()}
            className="px-1.5 py-0.5 border border-border/60 rounded hover:bg-foreground/[0.03] disabled:text-muted-foreground/50 disabled:cursor-not-allowed"
            title="Fetches the full segment list — can be several MB at airport points."
          >
            {loadingFull ? 'Loading…' : 'Show all'}
          </button>
        </div>
      )}
    </div>
  )
}

