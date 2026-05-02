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
  { key: 'road', label: 'Road' },
  { key: 'railway', label: 'Rail' },
  { key: 'aircraft_ground', label: 'GroundOps' },
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

// Server omits `flight_id` (packed icao24+ts32 overflows JS Number — see
// types/noise.ts comment), so the key falls back to per-trace identity.
// Synth cruise buckets are keyed on (date, period, profile) by the engine;
// received_lden tie-breaks the rare same-bucket-same-receiver collisions.
function airborneRowKey(t: AirborneTrace): string {
  if (t.icao_hex && t.start_unix != null) {
    return `a-real-${t.icao_hex}-${t.start_unix}-${t.received_lden.toFixed(3)}`
  }
  return `a-synth-${t.date}-${t.period}-${t.profile}-${t.received_lden.toFixed(3)}`
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

function totalsByKind(meta: SegmentTracesSummary | null | undefined) {
  return {
    road: meta?.road_total ?? 0,
    railway: meta?.railway_total ?? 0,
    aircraft_ground: meta?.aircraft_ground_total ?? 0,
    aircraft_airborne: meta?.aircraft_airborne_total ?? 0,
    building: meta?.building_total ?? 0,
    industrial: meta?.industrial_total ?? 0,
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
  const totals = totalsByKind(meta)

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

  // Strip should reflect the active toggle selection, not the global total.
  let shownCount = 0
  let totalCount = 0
  for (const { key } of KIND_FILTERS) {
    if (!enabled[key]) continue
    shownCount += counts[key]
    totalCount += totals[key]
  }
  const truncated = totalCount > shownCount

  return (
    <div>
      <div className="flex mt-1 mb-1.5 whitespace-nowrap text-[11px] bg-muted/30 rounded py-1 -mx-1 divide-x divide-foreground/25 overflow-x-auto">
        {KIND_FILTERS.map(({ key, label }) => {
          const kindCount = counts[key]
          const kindTotal = totals[key]
          if (kindCount === 0 && shownCount > 0) return null
          const on = enabled[key]
          const countLabel = kindTotal > kindCount ? `${kindCount} of ${kindTotal}` : `${kindCount}`
          return (
            <button
              key={key}
              type="button"
              onClick={() => setEnabled(e => ({ ...e, [key]: !e[key] }))}
              title={`${label} — ${countLabel} segment${kindTotal === 1 ? '' : 's'} (click to ${on ? 'hide' : 'show'})`}
              className={`shrink-0 px-1 transition-colors ${
                on
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
        {entries.map(e =>
          e.kind === 'segment' ? (
            <SegmentRow
              key={segmentRowKey(e.trace)}
              trace={e.trace}
              onHighlight={onHighlight}
            />
          ) : (
            <AirborneRow
              key={airborneRowKey(e.trace)}
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

