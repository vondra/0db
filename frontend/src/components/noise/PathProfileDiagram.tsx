import { useMemo, useRef, useState } from 'react'
import type { PathProfileTrace, ScreeningObstacleTrace } from '../../types/noise'

const VB_W = 600
const VB_H = 220
const PAD_L = 42
const PAD_R = 12
const PAD_T = 16
const PAD_B = 28
const PLOT_W = VB_W - PAD_L - PAD_R
const PLOT_H = VB_H - PAD_T - PAD_B

const MIN_BUILDING_PX = 4

function niceTickStep(range: number): number {
  if (range <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(range)))
  const norm = range / pow
  if (norm >= 5) return pow * 1
  if (norm >= 2) return pow * 0.5
  return pow * 0.2
}

function imdColor(imd: number): string {
  // IMD is the Copernicus Imperviousness-Density raster (0 = fully
  // natural / soft ground, 100 = fully sealed / hard). Engine inverts
  // it to the CNOSSOS ground factor G = 1 − imd/100.
  const t = imd / 100
  const r = Math.round(110 + t * (155 - 110))
  const g = Math.round(85 + t * (155 - 85))
  const b = Math.round(55 + t * (155 - 55))
  return `rgb(${r},${g},${b})`
}

/** Qualitative ground-hardness word for the scrub tooltip. Bands match the
 * common CNOSSOS bucketing used in site-survey reports. */
function imdLabel(imd: number): string {
  if (imd <= 15) return 'soft'
  if (imd <= 50) return 'mixed'
  if (imd <= 85) return 'hard'
  return 'sealed'
}

/** Linear interpolation of the profile's elevation_m at fractional t ∈ [0, 1]. */
function interpElevation(t: readonly number[], elev: readonly number[], tQuery: number): number {
  if (t.length === 0) return 0
  if (tQuery <= t[0]) return elev[0]
  if (tQuery >= t[t.length - 1]) return elev[t.length - 1]
  for (let i = 0; i + 1 < t.length; i++) {
    if (t[i] <= tQuery && t[i + 1] >= tQuery) {
      const span = t[i + 1] - t[i]
      const frac = span > 0 ? (tQuery - t[i]) / span : 0
      return elev[i] + frac * (elev[i + 1] - elev[i])
    }
  }
  return elev[elev.length - 1]
}

export interface PathProfileDiagramProps {
  trace: PathProfileTrace
  obstacle?: ScreeningObstacleTrace | null
  terrainEdgeApexT?: number | null
  terrainEdgeApexElev?: number | null
}

export function PathProfileDiagram({
  trace,
  obstacle,
  terrainEdgeApexT,
  terrainEdgeApexElev,
}: PathProfileDiagramProps) {
  const n = trace.t.length
  const dist = Math.max(trace.dist_m, 1)
  const hasPath = n > 0 && trace.dist_m > 0

  const { elevMin, elevMax, exaggeration, xOf, yOf, xAxisTicks } =
    useMemo(() => {
      const elevs = trace.elevation_m
      const maxBld = Math.max(...trace.building_h_m.map(v => Number(v) || 0), 0)
      const rawMin = Math.min(...elevs, trace.src_alt_m - maxBld)
      const rawMax = Math.max(...elevs, trace.src_alt_m, trace.rcv_alt_m)
      // Pad so the profile doesn't kiss the viewport and so buildings fit.
      const elevPad = Math.max((rawMax - rawMin) * 0.1, 2)
      const eMin = rawMin - elevPad
      const eMax = rawMax + maxBld + elevPad

      const range = Math.max(eMax - eMin, 1)
      const native = PLOT_H / range
      // Guarantee at least 4 px for min 1 m building so short obstacles stay
      // visible even on kilometre-long paths.
      const forBuildings = MIN_BUILDING_PX / Math.max(1, 1)
      const scale = Math.max(native, forBuildings)
      const exag = scale / native

      const xOf = (t: number) => PAD_L + Math.max(0, Math.min(1, t)) * PLOT_W
      const yOf = (elevM: number) => PAD_T + (eMax - elevM) * scale

      // Nice distance ticks (0, 200, 400 … m) up to dist_m.
      const step = niceTickStep(dist)
      const ticks: number[] = []
      for (let d = 0; d <= dist + step * 0.5; d += step) {
        ticks.push(d)
        if (ticks.length > 12) break
      }

      return {
        elevMin: eMin,
        elevMax: eMax,
        exaggeration: exag,
        xOf,
        yOf,
        xAxisTicks: ticks,
      }
    }, [trace, dist])

  // Elevation area polygon.
  const elevPath = useMemo(() => {
    const pts: string[] = []
    for (let i = 0; i < n; i++) {
      pts.push(`${xOf(trace.t[i]).toFixed(2)},${yOf(trace.elevation_m[i]).toFixed(2)}`)
    }
    return `M ${pts.join(' L ')} L ${xOf(1).toFixed(2)},${(PAD_T + PLOT_H).toFixed(2)} L ${xOf(0).toFixed(2)},${(PAD_T + PLOT_H).toFixed(2)} Z`
  }, [trace, n, xOf, yOf])

  const elevLine = useMemo(() => {
    const pts: string[] = []
    for (let i = 0; i < n; i++) {
      pts.push(`${xOf(trace.t[i]).toFixed(2)},${yOf(trace.elevation_m[i]).toFixed(2)}`)
    }
    return `M ${pts.join(' L ')}`
  }, [trace, n, xOf, yOf])

  // Ground strip (below the elevation curve) coloured per sample by IMD.
  const groundStripSegments = useMemo(() => {
    const segs: { x1: number; x2: number; y: number; color: string }[] = []
    for (let i = 0; i + 1 < n; i++) {
      const x1 = xOf(trace.t[i])
      const x2 = xOf(trace.t[i + 1])
      const y = PAD_T + PLOT_H - 2
      segs.push({ x1, x2, y, color: imdColor(trace.imd_u8[i]) })
    }
    return segs
  }, [trace, n, xOf])

  // Forest intervals: contiguous runs where forest_u8[i] > 0.
  const forestRects = useMemo(() => {
    const rects: { x: number; w: number }[] = []
    let i = 0
    while (i < n) {
      if (trace.forest_u8[i] > 0) {
        let j = i
        while (j < n && trace.forest_u8[j] > 0) j++
        const x1 = xOf(trace.t[i])
        const x2 = xOf(trace.t[Math.min(j, n - 1)])
        rects.push({ x: x1, w: Math.max(x2 - x1, 1) })
        i = j
      } else {
        i++
      }
    }
    return rects
  }, [trace, n, xOf])

  // Building rectangles — one per sample with building_h_m > 0.
  const buildingRects = useMemo(() => {
    const rects: { x: number; y: number; w: number; h: number }[] = []
    for (let i = 0; i < n; i++) {
      const h = trace.building_h_m[i]
      if (!h) continue
      const baseY = yOf(trace.elevation_m[i])
      const topY = yOf(trace.elevation_m[i] + h)
      const x = xOf(trace.t[i])
      const wSpan =
        i + 1 < n
          ? xOf(trace.t[i + 1]) - xOf(trace.t[i])
          : i > 0
            ? xOf(trace.t[i]) - xOf(trace.t[i - 1])
            : 4
      const hPx = Math.max(baseY - topY, MIN_BUILDING_PX)
      const yTop = baseY - hPx
      rects.push({ x: x - wSpan / 2, y: yTop, w: Math.max(wSpan, 2), h: hPx })
    }
    return rects
  }, [trace, n, xOf, yOf])

  // Hover/touch scrub: nearest sample by x. Pointer events so the tooltip
  // works with both mouse and touch (mobile popup).
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const scrubAt = (clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const p = pt.matrixTransform(ctm.inverse())
    const t = (p.x - PAD_L) / PLOT_W
    let bestI = 0
    let bestDist = Infinity
    for (let i = 0; i < n; i++) {
      const d = Math.abs(trace.t[i] - t)
      if (d < bestDist) {
        bestDist = d
        bestI = i
      }
    }
    setHoverIdx(bestI)
  }
  const handlePointerMove = (evt: React.PointerEvent<SVGSVGElement>) => {
    scrubAt(evt.clientX, evt.clientY)
  }
  const handlePointerDown = (evt: React.PointerEvent<SVGSVGElement>) => {
    // Touch devices: tap-then-drag. Capture pointer so moves outside the SVG
    // still feed the scrub bar until the finger lifts.
    evt.currentTarget.setPointerCapture?.(evt.pointerId)
    scrubAt(evt.clientX, evt.clientY)
  }
  const handlePointerUp = (evt: React.PointerEvent<SVGSVGElement>) => {
    evt.currentTarget.releasePointerCapture?.(evt.pointerId)
  }
  const handleLeave = () => setHoverIdx(null)

  if (!hasPath) {
    return (
      <div className="py-3 text-[10px] italic text-muted-foreground/60">
        No path data — source and receiver coincide.
      </div>
    )
  }

  const srcX = xOf(0)
  const rcvX = xOf(1)
  const srcY = yOf(trace.src_alt_m)
  // `trace.rcv_alt_m` already includes the receiver listening height
  // (engine returns ground + height_m via Receiver::altitude_m), so the
  // marker sits AT the LoS endpoint. The pre-existing `+ receiverListeningHeightM`
  // double-counted the offset and pulled the marker above the dashed
  // line of sight, leaving an "orange-looking" stub above the receiver.
  const rcvY = yOf(trace.rcv_alt_m)

  const obstacleMarker = obstacle && obstacle.kind !== 'none' ? obstacle : null
  const obsX = obstacleMarker ? xOf(obstacleMarker.t) : null
  const obsY = obstacleMarker
    ? yOf(
        interpElevation(trace.t, trace.elevation_m, obstacleMarker.t) + obstacleMarker.height_m,
      )
    : null

  const apexX = terrainEdgeApexT != null ? xOf(terrainEdgeApexT) : null
  const apexY = terrainEdgeApexElev != null ? yOf(terrainEdgeApexElev) : null

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full touch-none"
        style={{ height: 'auto', maxHeight: 260 }}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handleLeave}
      >
        {/* Plot area background */}
        <rect x={PAD_L} y={PAD_T} width={PLOT_W} height={PLOT_H} fill="var(--color-background, #fafafa)" />

        {/* Ground strip (IMD colour) */}
        {groundStripSegments.map((s, i) => (
          <line
            key={`g-${i}`}
            x1={s.x1}
            x2={s.x2}
            y1={s.y}
            y2={s.y}
            stroke={s.color}
            strokeWidth={5}
          />
        ))}

        {/* Forest bands under the elevation curve */}
        {forestRects.map((r, i) => (
          <rect
            key={`f-${i}`}
            x={r.x}
            y={PAD_T + PLOT_H - 8}
            width={r.w}
            height={6}
            fill="#3f7a3d"
            opacity={0.35}
          />
        ))}

        {/* Elevation area */}
        <path d={elevPath} fill="rgba(120,90,55,0.12)" />
        <path d={elevLine} fill="none" stroke="#8a6a3d" strokeWidth={1.2} />

        {/* Buildings */}
        {buildingRects.map((r, i) => (
          <rect key={`b-${i}`} x={r.x} y={r.y} width={r.w} height={r.h} fill="rgba(120,120,120,0.7)" />
        ))}

        {/* Line of sight (source → receiver) */}
        <line
          x1={srcX}
          y1={srcY}
          x2={rcvX}
          y2={rcvY}
          stroke="currentColor"
          strokeOpacity={0.35}
          strokeDasharray="3 3"
          strokeWidth={1}
        />

        {/* Terrain edge apex */}
        {apexX != null && apexY != null && (
          <g>
            <circle cx={apexX} cy={apexY} r={3.5} fill="#16a34a" />
            <text x={apexX + 5} y={apexY - 4} fontSize={14} fill="#16a34a">
              apex
            </text>
          </g>
        )}

        {/* Obstacle marker */}
        {obsX != null && obsY != null && (
          <g>
            <line x1={obsX - 5} y1={obsY - 5} x2={obsX + 5} y2={obsY + 5} stroke="#dc2626" strokeWidth={1.5} />
            <line x1={obsX - 5} y1={obsY + 5} x2={obsX + 5} y2={obsY - 5} stroke="#dc2626" strokeWidth={1.5} />
          </g>
        )}

        {/* Source marker */}
        <circle cx={srcX} cy={srcY} r={3.5} fill="#2563eb" />
        <line x1={srcX} y1={srcY} x2={srcX} y2={yOf(trace.elevation_m[0])} stroke="#2563eb" strokeWidth={1} />

        {/* Receiver marker — sits at the LoS endpoint (rcv_alt_m already
            includes the listening height), with a thin stick down to the
            ground for spatial context. */}
        <circle cx={rcvX} cy={rcvY} r={3.5} fill="#dc2626" />
        <line x1={rcvX} y1={rcvY} x2={rcvX} y2={yOf(trace.elevation_m[n - 1])} stroke="#dc2626" strokeWidth={1} />

        {/* Sample dots on terrain line */}
        {Array.from({ length: n }).map((_, i) => (
          <circle key={`s-${i}`} cx={xOf(trace.t[i])} cy={yOf(trace.elevation_m[i])} r={1.2} fill="#8a6a3d" />
        ))}

        {/* Scrub bar */}
        {hoverIdx != null && (
          <line
            x1={xOf(trace.t[hoverIdx])}
            y1={PAD_T}
            x2={xOf(trace.t[hoverIdx])}
            y2={PAD_T + PLOT_H}
            stroke="currentColor"
            strokeOpacity={0.25}
            strokeWidth={1}
          />
        )}

        {/* X axis */}
        <line x1={PAD_L} y1={PAD_T + PLOT_H} x2={PAD_L + PLOT_W} y2={PAD_T + PLOT_H} stroke="currentColor" strokeOpacity={0.4} />
        {xAxisTicks.map(d => {
          const tx = PAD_L + (d / dist) * PLOT_W
          return (
            <g key={`xt-${d}`}>
              <line x1={tx} y1={PAD_T + PLOT_H} x2={tx} y2={PAD_T + PLOT_H + 3} stroke="currentColor" strokeOpacity={0.4} />
              <text x={tx} y={PAD_T + PLOT_H + 18} textAnchor="middle" fontSize={14} fill="currentColor" opacity={0.7}>
                {d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`}
              </text>
            </g>
          )
        })}

        {/* Y axis (elev) */}
        <text x={6} y={PAD_T + 12} fontSize={14} fill="currentColor" opacity={0.7}>
          {elevMax.toFixed(0)} m
        </text>
        <text x={6} y={PAD_T + PLOT_H - 2} fontSize={14} fill="currentColor" opacity={0.7}>
          {elevMin.toFixed(0)} m
        </text>

        {/* Vertical exaggeration badge */}
        {exaggeration > 1.05 && (
          <text x={PAD_L + PLOT_W - 4} y={PAD_T + 12} textAnchor="end" fontSize={14} fill="currentColor" opacity={0.6}>
            ×{exaggeration.toFixed(1)} vert
          </text>
        )}
      </svg>

      {/* HTML scrub tooltip — rendered outside the SVG so the font stays at
          native browser pixels regardless of the viewBox scaling. */}
      {hoverIdx != null && (
        <div
          className="absolute top-1 left-1 pointer-events-none rounded border border-border/50 bg-background/95 shadow-sm px-2 py-1.5 text-[11px] leading-snug"
          style={{ minWidth: 170 }}
        >
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
            <span className="text-muted-foreground/70">Distance</span>
            <span className="text-right">{Math.round(trace.t[hoverIdx] * dist)} m</span>
            <span className="text-muted-foreground/70">Elevation</span>
            <span className="text-right">{trace.elevation_m[hoverIdx].toFixed(0)} m</span>
            <span className="text-muted-foreground/70">Building</span>
            <span className="text-right">{trace.building_h_m[hoverIdx]} m</span>
            <span className="text-muted-foreground/70">Forest</span>
            <span className="text-right">{trace.forest_u8[hoverIdx] > 0 ? 'yes' : 'no'}</span>
            <span
              className="text-muted-foreground/70"
              title={'Ground hardness derived from Copernicus Imperviousness\n' +
                'Density (0 = natural soil, 100 = fully sealed).\n' +
                'CNOSSOS ground factor G = 1 − IMD / 100.'}
            >
              Ground
            </span>
            <span className="text-right">
              {imdLabel(trace.imd_u8[hoverIdx])} (IMD {trace.imd_u8[hoverIdx]})
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
