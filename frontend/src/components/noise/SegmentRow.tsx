import { useState } from 'react'
import type { SegmentTrace } from '../../types/noise'
import { HoverText } from '../ui/info-tip'
import { ldenToColor } from '../../utils/noise-colors'
import { SegmentExpanded } from './SegmentExpanded'
import { SOURCE_LABELS, formatDist, lineStringFromLatLon, subtypeLabel } from './shared'

function segmentName(t: SegmentTrace): string {
  if (t.name && t.name.length > 0) return t.name
  return SOURCE_LABELS[t.kind] ?? t.kind
}

function highlightGeometry(t: SegmentTrace) {
  if (t.kind === 'building' || t.kind === 'industrial') {
    return { type: 'Point', coordinates: [t.start_lon, t.start_lat] }
  }
  return lineStringFromLatLon([t.start_lat, t.start_lon], [t.end_lat, t.end_lon])
}

const POWER_SUM_HINT =
  'Per-segment received Lden shown is the segment-alone level.\n' +
  'Grouped "Noise source" Lden pools segments in energy, not dB:\n' +
  '  L_total = 10·log₁₀(Σᵢ 10^(Lᵢ/10))'

export function SegmentRow({
  trace,
  onHighlight,
}: {
  trace: SegmentTrace
  onHighlight?: (geometry: unknown | null) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const lden = trace.received_lden.full
  const subtype = subtypeLabel(trace.kind, trace.subtype)

  const handleToggle = () => {
    const next = !expanded
    setExpanded(next)
    onHighlight?.(next ? highlightGeometry(trace) : null)
  }

  return (
    <div className="border-b border-border/30 last:border-b-0">
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between gap-2 px-1 py-0.5 text-[11px] hover:bg-foreground/[0.03] text-left"
      >
        <span className="flex items-center gap-1 min-w-0 flex-1">
          <span className="truncate">
            <span className="text-foreground">{segmentName(trace)}</span>
            {trace.is_dominant_of_group && (
              <span
                className="text-[10px] text-amber-500 ml-0.5"
                title="Dominant segment of its Noise source group"
              >
                ⭑
              </span>
            )}
            <span className="text-muted-foreground/60"> · {subtype}</span>
          </span>
        </span>
        <span className="flex items-center gap-2 shrink-0 font-mono text-muted-foreground/80 text-[10px]">
          <span>{formatDist(Math.round(trace.dist_m))}</span>
          <HoverText title={POWER_SUM_HINT} className="no-underline">
            <span style={{ color: ldenToColor(lden) }} className="font-medium">
              {lden.toFixed(1)} dB
            </span>
          </HoverText>
          <span className="text-muted-foreground/40">{expanded ? '▴' : '▾'}</span>
        </span>
      </button>
      {expanded && <SegmentExpanded trace={trace} />}
    </div>
  )
}
