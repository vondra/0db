import { useMemo, useState } from 'react'
import {
  AIRCRAFT_SUBTYPE,
  type SegmentKind,
  type SegmentTrace,
  type SegmentTracesSummary,
} from '../../types/noise'
import { SegmentRow } from './SegmentRow'

const KIND_FILTERS: { key: SegmentKind; label: string }[] = [
  { key: 'road', label: 'Road' },
  { key: 'railway', label: 'Rail' },
  { key: 'aircraft_ground', label: 'GroundOps' },
  { key: 'aircraft_airborne', label: 'Airborne' },
  { key: 'aircraft_cruise', label: 'Cruise' },
  { key: 'building', label: 'Buildings' },
  { key: 'industrial', label: 'Industrial' },
]

type UnifiedEntry = { trace: SegmentTrace; sortKey: number }

export function traceKind(t: SegmentTrace): SegmentKind {
  if (t.kind === 'aircraft') {
    switch (t.aircraft_subtype) {
      case AIRCRAFT_SUBTYPE.GROUND:
        return 'aircraft_ground'
      case AIRCRAFT_SUBTYPE.AIRBORNE:
        return 'aircraft_airborne'
      case AIRCRAFT_SUBTYPE.CRUISE:
        return 'aircraft_cruise'
      default:
        // Unknown subtype — backend-side schema drift. Fall back to
        // ground so the row still renders and console-warn so
        // operators see the regression in DevTools.
        if (typeof console !== 'undefined') {
          console.warn(`Unknown aircraft_subtype ${t.aircraft_subtype}; defaulting to ground.`)
        }
        return 'aircraft_ground'
    }
  }
  return t.kind as SegmentKind
}

// Unique React key. Point sources (buildings, industrial sites) are
// discretized into multiple grid points sharing one parent osm_id and
// segment_idx=0; aircraft ground ops emit the same physical segment
// per movement-kind so even (osm_id, segment_idx, cp_lat, cp_lon) can
// repeat with different `received_lden`. Including the received Lden
// keeps each row's React identity unique across all known engine
// duplicates.
function segmentRowKey(t: SegmentTrace): string {
  const rl = t.received_lden.full
  const rlKey = Number.isFinite(rl) ? rl.toFixed(2) : 'na'
  return `s-${t.osm_id ?? 'pt'}-${t.segment_idx}-${t.cp_lat.toFixed(6)},${t.cp_lon.toFixed(6)}-${rlKey}`
}

const META_FIELD: Record<SegmentKind, { count: keyof SegmentTracesSummary; total: keyof SegmentTracesSummary }> = {
  road: { count: 'road_count', total: 'road_total' },
  railway: { count: 'railway_count', total: 'railway_total' },
  aircraft_ground: { count: 'aircraft_ground_count', total: 'aircraft_ground_total' },
  aircraft_airborne: { count: 'aircraft_airborne_count', total: 'aircraft_airborne_total' },
  aircraft_cruise: { count: 'aircraft_cruise_count', total: 'aircraft_cruise_total' },
  building: { count: 'building_count', total: 'building_total' },
  industrial: { count: 'industrial_count', total: 'industrial_total' },
}

function metaCount(meta: SegmentTracesSummary | null | undefined, kind: SegmentKind, field: 'count' | 'total'): number {
  return (meta?.[META_FIELD[kind][field]] as number | undefined) ?? 0
}

export function SegmentList({
  segments,
  meta,
  onHighlight,
  onShowAll,
  loadingFull = false,
}: {
  segments: SegmentTrace[]
  meta: SegmentTracesSummary | null
  onHighlight?: (geometry: unknown | null) => void
  onShowAll?: () => void | Promise<void>
  loadingFull?: boolean
}) {
  const [enabled, setEnabled] = useState<Record<SegmentKind, boolean>>(() =>
    Object.fromEntries(KIND_FILTERS.map(k => [k.key, true])) as Record<SegmentKind, boolean>,
  )

  // Sort once when `segments` arrive — `enabled` toggles only filter
  // the pre-sorted list and don't touch the sort cost.
  const sortedSegments = useMemo<UnifiedEntry[]>(
    () =>
      segments
        .map(s => ({ trace: s, sortKey: s.received_lden.full }))
        .sort((x, y) => y.sortKey - x.sortKey),
    [segments],
  )

  const entries = useMemo<UnifiedEntry[]>(
    () => sortedSegments.filter(e => enabled[traceKind(e.trace)]),
    [sortedSegments, enabled],
  )

  // Strip should reflect the active toggle selection, not the global total.
  let shownCount = 0
  let totalCount = 0
  for (const { key } of KIND_FILTERS) {
    if (!enabled[key]) continue
    shownCount += metaCount(meta, key, 'count')
    totalCount += metaCount(meta, key, 'total')
  }
  const truncated = totalCount > shownCount

  return (
    <div>
      <div className="flex mt-1 mb-1.5 whitespace-nowrap text-[11px] bg-muted/30 rounded py-1 -mx-1 divide-x divide-foreground/25 overflow-x-auto">
        {KIND_FILTERS.map(({ key, label }) => {
          const kindCount = metaCount(meta, key, 'count')
          const kindTotal = metaCount(meta, key, 'total')
          // Empty kinds stay visible (greyed) so the user always sees
          // the full filter set — disappearing tabs on a sparse popup
          // looked unpredictable. Greyed-out + count=0 makes the
          // empty state explicit instead of hiding it.
          const isEmpty = kindCount === 0
          const on = enabled[key] && !isEmpty
          const countLabel = kindTotal > kindCount ? `${kindCount} of ${kindTotal}` : `${kindCount}`
          return (
            <button
              key={key}
              type="button"
              disabled={isEmpty}
              onClick={() => setEnabled(e => ({ ...e, [key]: !e[key] }))}
              title={`${label} — ${countLabel} segment${kindTotal === 1 ? '' : 's'}${
                isEmpty ? ' (no data at this point)' : on ? ' (click to hide)' : ' (click to show)'
              }`}
              className={`shrink-0 px-1 transition-colors ${
                isEmpty
                  ? 'text-muted-foreground/30 cursor-not-allowed'
                  : on
                    ? 'text-foreground hover:text-foreground/80'
                    : 'text-muted-foreground/40 line-through hover:text-foreground'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>
      <div>
        {entries.map(e => (
          <SegmentRow
            key={segmentRowKey(e.trace)}
            trace={e.trace}
            onHighlight={onHighlight}
          />
        ))}
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

