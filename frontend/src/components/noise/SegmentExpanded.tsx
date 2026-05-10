import { useMemo, useState } from 'react'
import type { CruiseHexTopFlight, SegmentTrace } from '../../types/noise'
import { fmtFloat } from '../../utils/formatters'
import { ldenToColor } from '../../utils/noise-colors'
import { HoverText } from '../ui/info-tip'
import { PathProfileDiagram } from './PathProfileDiagram'
import {
  EDGE_SUBSCRIPTS,
  PERIOD_LABELS_DETAIL,
  PERIOD_TOOLTIP,
  isLineSourceKind,
  roadSourceDescription,
  railTrainSourceLine,
} from './shared'

// CNOSSOS period weights (hours in each bucket, out of 24). Labels
// share PERIOD_LABELS_DETAIL with other tabs so the wording matches.
const PERIOD_ROWS = [
  { key: 'day', label: PERIOD_LABELS_DETAIL[0], weight: 12 },
  { key: 'evening', label: PERIOD_LABELS_DETAIL[1], weight: 4 },
  { key: 'night', label: PERIOD_LABELS_DETAIL[2], weight: 8 },
] as const

const BAND_FREQS = [63, 125, 250, 500, 1000, 2000, 4000, 8000] as const
const BAND_LABELS = ['63 Hz', '125 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '8 kHz'] as const

function bandsTooltip(
  bands: readonly (number | null)[],
  {
    title,
    signed = true,
    note,
  }: { title: string; signed?: boolean; note?: string } = { title: '' },
) {
  // Period-keyed bands (lw_bands.day, etc.) are null when the period had no
  // emission — runway segments often have day/evening null with night-only
  // data. Render "—" instead of crashing on null.toFixed.
  const lines = bands.map((v, i) => {
    const label = BAND_LABELS[i] ?? `${BAND_FREQS[i]} Hz`
    if (v == null) return `  ${label.padEnd(8)} ${'—'.padStart(7)}`
    const sign = signed && v > 0 ? '+' : ''
    return `  ${label.padEnd(8)} ${sign}${v.toFixed(2).padStart(7)} dB`
  })
  const header = title ? `${title}\n\n` : ''
  const footer = note ? `\n\n${note}` : ''
  return `${header}${lines.join('\n')}${footer}`
}

function fmtDb(v: number, { signed = true, digits = 1 } = {}): string {
  if (!Number.isFinite(v)) return '—'
  const sign = signed && v > 0 ? '+' : ''
  return `${sign}${v.toFixed(digits)} dB`
}

// Bare visual block — no header. Spacing alone separates §1/§2/§3/§4/§5.
function Section({ children }: { children: React.ReactNode }) {
  return <div className="mt-3">{children}</div>
}

function InlineTable({ rows }: { rows: [string | React.ReactNode, React.ReactNode][] }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <span className="text-muted-foreground/70 whitespace-nowrap">{k}</span>
          <span className="text-foreground text-right tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// §1 Source — Lw emission (what the source emits)
// ────────────────────────────────────────────────────────────────────────────

function Section1Source({ trace }: { trace: SegmentTrace }) {
  const emissionRowsList = useMemo(() => emissionInputRows(trace), [trace])
  const lwRow = useMemo(() => computeLwRow(trace), [trace])
  const sourceHeightRow = useMemo(() => computeSourceHeightRow(trace), [trace])
  const rows = useMemo(
    () => {
      const out: [React.ReactNode, React.ReactNode][] = [...emissionRowsList]
      if (lwRow) out.push(lwRow)
      out.push(sourceHeightRow)
      return out
    },
    [emissionRowsList, lwRow, sourceHeightRow],
  )
  return (
    <Section>
      <InlineTable rows={rows} />
      {trace.kind === 'aircraft' && trace.aircraft_subtype === 3 && trace.cruise_top_flights && trace.cruise_top_flights.length > 0 && (
        <CruiseLoudestFlights tops={trace.cruise_top_flights} />
      )}
    </Section>
  )
}

// `<table>` cannot live inside `InlineTable`'s `<span>` value cell, so cruise
// hexes get a separate block under the key-value rows.
function CruiseLoudestFlights({ tops }: { tops: CruiseHexTopFlight[] }) {
  return (
    <div className="mt-1.5">
      <div className="text-muted-foreground/70 mb-0.5">Loudest flights</div>
      <table className="text-[10px] [&_th]:font-normal [&_th]:text-left [&_td]:text-left">
        <thead>
          <tr className="text-muted-foreground/60">
            <th className="text-right pr-1.5">Lmax</th>
            <th className="text-right pr-1.5">Alt</th>
            <th className="pl-1">Aircraft</th>
            <th className="pl-2">When (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {tops.map((f, i) => (
            <tr key={i}>
              <td className="text-right pr-1.5 tabular-nums">{f.lmax_db.toFixed(1)}</td>
              <td className="text-right pr-1.5 tabular-nums">{Math.round(f.altitude_m)} m</td>
              <td className="pl-1">
                {f.aircraft_type || '—'}
                {f.callsign && <span className="text-muted-foreground/60"> · {f.callsign}</span>}
              </td>
              <td className="pl-2 text-muted-foreground/60 tabular-nums">
                {f.date ? f.date.slice(5) : '—'} {f.time_utc ? f.time_utc.slice(0, 5) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Source height is the single row inherited from the removed §2 Baseline
// section — value is a per-source-type model constant (road 0.05 m wheel,
// rail 0.5 m wheel-rail, building mid-facade, industrial varies, aircraft
// ground 4 m), not a computed field. Tooltip explains the convention.
function computeSourceHeightRow(trace: SegmentTrace): [React.ReactNode, React.ReactNode] {
  const h = trace.baseline.source_height_m
  const slantSame = Math.abs(trace.d_slant_m - trace.dist_m) < 0.5
  const slantNote = slantSame
    ? ''
    : `\n\nSlant distance: ${trace.d_slant_m.toFixed(0)} m vs horizontal ${trace.dist_m.toFixed(0)} m — the vertical offset from source height contributes.`
  const tooltip =
    'Source height above ground — model constant per source type:\n' +
    '  road       0.05 m   (wheel/tyre contact)\n' +
    '  railway    0.5 m    (wheel-rail contact)\n' +
    '  aircraft   4.0 m    (ground ops)\n' +
    '  building   height/2 (mid-facade)\n' +
    '  industrial varies   (5 m other / 8 m quarry / 10 m heavy NACE;\n' +
    '                       wind turbine = hub height)\n\n' +
    `Feeds geometric divergence (d_slant = √(d_horizontal² + Δh²)) and\n` +
    'diffraction S/R anchor points.' +
    slantNote
  return [
    <HoverText title={tooltip}>Source height</HoverText>,
    `${h.toFixed(1)} m`,
  ]
}

const LW_LINE_SOURCE = {
  unit: 'dB(A)/m',
  symbol: "L'w",
  label: "L'w (day)",
  desc: 'line-source power density',
} as const
const LW_POINT_SOURCE = {
  unit: 'dB(A)',
  symbol: 'Lw',
  label: 'Lw (day)',
  desc: 'point-source sound power',
} as const
const POINT_SOURCE_KINDS = new Set(['building', 'industrial'])

function computeLwRow(trace: SegmentTrace): [React.ReactNode, React.ReactNode] | null {
  const lw = trace.lw_db_a
  if (!lw) return null
  const kind = trace.emission.kind
  const cfg = isLineSourceKind(kind)
    ? LW_LINE_SOURCE
    : POINT_SOURCE_KINDS.has(kind)
      ? LW_POINT_SOURCE
      : null
  if (!cfg) return null
  const labelConcept =
    `${cfg.symbol} — ${cfg.desc}, A-weighted. Sound power at the\n` +
    'source before any propagation is applied. CNOSSOS-EU Annex II\n' +
    '(road, railway) / project emission model (building, industrial).'
  const valueComputation =
    `Per-period ${cfg.symbol}:\n\n` +
    `  day      ${lw.day.toFixed(1).padStart(6)} ${cfg.unit}\n` +
    `  evening  ${lw.evening.toFixed(1).padStart(6)} ${cfg.unit}\n` +
    `  night    ${lw.night.toFixed(1).padStart(6)} ${cfg.unit}\n\n` +
    `Day shown is the representative period. Per-band L_w lives\n` +
    'in §5 under "Lw (A)" — hover each period cell there.'
  return [
    <HoverText title={labelConcept}>{cfg.label}</HoverText>,
    <HoverText title={valueComputation}>{`${lw.day.toFixed(1)} ${cfg.unit}`}</HoverText>,
  ]
}

function emissionInputRows(t: SegmentTrace): [React.ReactNode, React.ReactNode][] {
  const e = t.emission
  switch (e.kind) {
    case 'road': {
      const total = e.aadt_light + e.aadt_medium + e.aadt_heavy + e.aadt_moto
      const trafficText =
        roadSourceDescription(e.traffic_source, e.provenance, e.road_class) +
        `\n\n` +
        `Daily traffic (per OSM way):\n` +
        (e.aadt_light > 0 ? `  Light    ${Math.round(e.aadt_light)}\n` : '') +
        (e.aadt_medium > 0 ? `  Medium   ${Math.round(e.aadt_medium)}\n` : '') +
        (e.aadt_heavy > 0 ? `  Heavy    ${Math.round(e.aadt_heavy)}\n` : '') +
        (e.aadt_moto > 0 ? `  Moto     ${Math.round(e.aadt_moto)}\n` : '') +
        `  ──────────────\n  Total    ${Math.round(total)}/day`
      const surfaceText =
        `Source: OSM surface=${e.surface}\n\n` +
        `CNOSSOS Annex II rolling-noise correction relative to the standard\n` +
        `asphalt baseline (0 dB). ${e.surface} → ${fmtDb(e.surface_corr_db)}.`
      return [
        ['Speed', `${e.speed_kmh.toFixed(0)} km/h`],
        [
          'Traffic',
          <HoverText title={trafficText}>
            {Math.round(total)}/day
          </HoverText>,
        ],
        [
          'Surface',
          <HoverText title={surfaceText}>
            {e.surface}
            {e.surface_corr_db !== 0 ? ` (${fmtDb(e.surface_corr_db)})` : ''}
          </HoverText>,
        ],
        ['Class', e.road_class],
        [
          'Flags',
          `${e.oneway ? 'oneway' : 'two-way'} · ${e.lanes} lanes${e.bridge ? ' · bridge' : ''}${
            e.tunnel ? ' · tunnel' : ''
          }`,
        ],
      ]
    }
    case 'railway': {
      const total = e.trains_passenger + e.trains_freight
      // Label on its own line so long dataset names can never collide with
      // the prefix and trigger mid-word wraps.
      const paxSrc = e.trains_passenger > 0
        ? `Passenger source:\n  ${railTrainSourceLine(e.trains_passenger_source, e.provenance, e.rail_type).split('\n').join('\n  ')}\n\n`
        : ''
      const frtSrc = e.trains_freight > 0
        ? `Freight source:\n  ${railTrainSourceLine(e.trains_freight_source, e.provenance, e.rail_type).split('\n').join('\n  ')}\n\n`
        : ''
      const countLines =
        (e.trains_passenger > 0 ? `  Passenger  ${e.trains_passenger.toFixed(1).padStart(6)}\n` : '') +
        (e.trains_freight > 0 ? `  Freight    ${e.trains_freight.toFixed(1).padStart(6)}\n` : '')
      const trainsText =
        paxSrc +
        frtSrc +
        `Daily trains (per track):\n` +
        countLines +
        `  ──────────────\n  Total      ${total.toFixed(1).padStart(6)}/day`
      return [
        ['Speed', `${e.speed_kmh.toFixed(0)} km/h`],
        [
          'Trains',
          <HoverText title={trainsText}>
            {total.toFixed(1)}/day
          </HoverText>,
        ],
        [
          'Type',
          `${e.rail_type}${e.highspeed ? ' · highspeed' : ''}${e.service ? ' · service' : ''}`,
        ],
        ['Bridge', e.bridge ? 'yes' : 'no'],
      ]
    }
    case 'aircraft_ground': {
      const rows: [React.ReactNode, React.ReactNode][] = [
        ['Class', e.class],
        ['Observed movements', fmtFloat(e.observed_movements)],
        ['Modeled movements', fmtFloat(e.modeled_movements)],
      ]
      const lengths = t.length_m_per_kind
      if (lengths) {
        const [runway, taxi, apron] = lengths
        const total = runway + taxi + apron
        if (total > 0) {
          const fmt = (v: number) =>
            v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`
          rows.push([
            'Path lengths',
            `runway ${fmt(runway)} · taxi ${fmt(taxi)} · apron ${fmt(apron)}`,
          ])
        }
      }
      return rows
    }
    case 'aircraft_airborne': {
      return [
        ['Class', e.class],
        ['Callsign', e.callsign || '—'],
        ['Aircraft', e.aircraft_type || '—'],
        ['CPA distance', `${Math.round(e.cpa_distance_m)} m`],
        ['Altitude at CPA', `${Math.round(e.altitude_m_at_cpa)} m`],
      ]
    }
    case 'aircraft_cruise': {
      return [
        ['R8 hex', e.r8_hex],
        ['Unique flights', `${e.n_unique_flights}`],
      ]
    }
    case 'building': {
      return [
        ['Type', e.building_type],
        ['Height', `${e.height_m.toFixed(1)} m (${e.floors || '—'} floors)`],
        ['Footprint', e.area_m2 > 0 ? `${Math.round(e.area_m2)} m²` : '—'],
      ]
    }
    case 'industrial': {
      const rows: [React.ReactNode, React.ReactNode][] = [
        ['Source type', e.source_type],
        ['Area', e.area_m2 > 0 ? `${Math.round(e.area_m2)} m²` : '—'],
        ['NACE', e.nace ?? '—'],
      ]
      // Wind-turbine-only fields — non-wind industrials send null/0, row
      // adds no value there.
      if (e.hub_height_m != null && e.hub_height_m > 0) {
        rows.push(['Hub height', `${e.hub_height_m.toFixed(1)} m`])
      }
      if (e.rated_power_kw != null && e.rated_power_kw > 0) {
        rows.push(['Rated power', `${Math.round(e.rated_power_kw)} kW`])
      }
      rows.push(['Effective source dist', `${e.effective_area_source_dist_m.toFixed(0)} m`])
      return rows
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// §2 Path effects — derived from the path geometry (terrain, ground, etc.)
// Former §2 Baseline (Distance + Source height) removed: distance lives in
// the collapsed header, source height moved into §1 as a model-constant row.
// ────────────────────────────────────────────────────────────────────────────

function Section4PathEffects({ trace }: { trace: SegmentTrace }) {
  const { baseline, terrain, screening, vegetation, ground, received_lden } = trace

  const groundDelta = received_lden.full - received_lden.no_ground
  const atmosphericDelta = received_lden.full - received_lden.no_atmospheric
  const terrainDelta = received_lden.full - received_lden.no_terrain
  const screeningDelta = received_lden.full - received_lden.no_screening
  const vegetationDelta = received_lden.full - received_lden.no_vegetation
  // Engine (iso9613.rs): free_field = base − A_gr + A_flc (+ refl_v). Total
  // obstruction delta = full − free_field = A_bar + A_fol contributions.
  // A_div, A_atm, A_gr, A_flc, A_refl are baseline corrections — shown above
  // the Total for transparency, not as sum-terms feeding it.
  const totalPathDelta = received_lden.full - received_lden.free_field

  // Baseline corrections — ordered per ISO 9613-2 §7.1 → §7.5 then FLC.
  // Split-tooltip rule: LABEL tooltip = concept only (what the term is +
  // standard symbol); VALUE tooltip = how this specific number was
  // computed (engine source, per-band breakdown where applicable,
  // variant-delta origin). Plain labels, symbols live only in tooltips.
  const baselineRows: [React.ReactNode, React.ReactNode][] = [
    [
      <HoverText
        title={
          'A_div — Geometric divergence (ISO 9613-2 §7.1).\n\n' +
          'Inverse-distance spreading of the source power. Always applied,\n' +
          'grows with distance. Line sources: cylindrical spreading; point\n' +
          'sources: spherical spreading plus a source-geometry adapter.'
        }
      >
        Geometric divergence
      </HoverText>,
      <HoverText
        title={
          `baseline.geometric_db = ${baseline.geometric_db.toFixed(2)} dB (engine scalar).\n\n` +
          'Formula: line → 10·log₁₀(2π·d_slant);\n' +
          '        point → 20·log₁₀(d_slant) + 11.\n' +
          `d_slant = ${trace.d_slant_m.toFixed(1)} m.\n` +
          'Sign-flipped here because it subtracts from L_w.'
        }
      >
        {fmtDb(-baseline.geometric_db)}
      </HoverText>,
    ],
    [
      <HoverText
        title={
          'A_atm — Atmospheric absorption (ISO 9613-2 §7.2).\n\n' +
          'Frequency-dependent air absorption. Standard atmosphere\n' +
          '(15 °C, 70 % RH). Higher frequencies attenuate much more\n' +
          'per kilometre than low frequencies.'
        }
      >
        Atmospheric absorption
      </HoverText>,
      <HoverText
        title={bandsTooltip(baseline.atmospheric_bands, {
          title: 'A_atm per band — α[i] × d_slant / 1000',
          signed: true,
          note:
            `d_slant = ${trace.d_slant_m.toFixed(1)} m.\n` +
            'Scalar = A-weighted ΔL_A (full − no_atmospheric Lden).',
        })}
      >
        {fmtDb(atmosphericDelta)}
      </HoverText>,
    ],
    [
      <HoverText
        title={
          'A_gr — Ground effect (ISO 9613-2 §7.3.1 / CNOSSOS §2.5.15).\n\n' +
          'Interaction of direct + ground-reflected rays — destructive at\n' +
          'mid bands, constructive at LF over soft ground. SIGNED: over\n' +
          'soft ground (G → 1) the 63/125 Hz bands can BOOST energy.'
        }
      >
        Ground effect (G={ground.factor_g.toFixed(2)})
      </HoverText>,
      <HoverText
        title={bandsTooltip(ground.attenuation_bands, {
          title: `A_gr per band — CF[i] × G (G = ${ground.factor_g.toFixed(2)})`,
          signed: true,
          note:
            'G is path-averaged from the receiver\'s imperviousness raster\n' +
            '(0 = hard, 1 = soft).\n' +
            'Scalar = A-weighted ΔL_A (full − no_ground Lden).',
        })}
      >
        {fmtDb(groundDelta)}
      </HoverText>,
    ],
  ]
  if (baseline.reflection_boost_db > 0.05) {
    baselineRows.push([
      <HoverText
        title={
          'A_refl — Urban reflection boost (ISO 9613-2 §7.5).\n\n' +
          'Per-receiver 0..5 dB boost from local building enclosure\n' +
          '(3×3 raster around the receiver). Reflected energy adds to\n' +
          'the direct path — always positive, same scalar for every\n' +
          'segment at this receiver.'
        }
      >
        Urban reflection
      </HoverText>,
      <HoverText
        title={
          `baseline.reflection_boost_db = +${baseline.reflection_boost_db.toFixed(2)} dB (engine scalar).\n\n` +
          'Computed once per receiver from the local building_enclosure()\n' +
          'raster probe and clamped 0..5 dB. Not a variant delta — the\n' +
          'same value appears on every segment at this point.'
        }
      >
        +{baseline.reflection_boost_db.toFixed(1)} dB
      </HoverText>,
    ])
  }
  if (Math.abs(baseline.finite_line_corr_db) > 0.05) {
    baselineRows.push([
      <HoverText
        title={
          'A_flc — Finite-line correction.\n\n' +
          'Line sources only (roads, railways). Compensates for the\n' +
          'segment subtending a finite angle at the receiver instead\n' +
          'of the infinite line assumed by cylindrical divergence.\n' +
          'Standard practice in NMPB / NoiseModelling / CNOSSOS.'
        }
      >
        Finite-line correction
      </HoverText>,
      <HoverText
        title={
          `baseline.finite_line_corr_db = ${baseline.finite_line_corr_db.toFixed(2)} dB (engine scalar).\n\n` +
          'Computed from the segment endpoint geometry at the receiver —\n' +
          'closer / shorter segments subtend less angle and attenuate\n' +
          'more than the infinite-line approximation predicts.'
        }
      >
        {fmtDb(baseline.finite_line_corr_db)}
      </HoverText>,
    ])
  }

  // Obstruction rows — terrain + screening + vegetation. Compose totalPathDelta.
  // Same split rule: LABEL concept, VALUE computation details.
  const obstructionRows: [React.ReactNode, React.ReactNode][] = [
    (() => {
      const edgeLabel =
        terrain.n_edges === 1 ? 'single edge'
        : terrain.n_edges === 2 ? 'double edge'
        : terrain.n_edges === 3 ? 'triple edge'
        : null
      const labelTooltip =
        'A_bar — Terrain diffraction (ISO 9613-2 §7.4 / CNOSSOS §2.5.6).\n\n' +
        'Sound bending over hills, cuttings, berms — any DEM feature\n' +
        'above the line-of-sight. Maekawa formula per band with a C₃\n' +
        'frequency term. Engine picks up to 3 edges from the upper\n' +
        'convex hull of the profile; N = 3 triggers a project-specific\n' +
        'cascade variant.'
      const deltaStr = terrain.delta_m > 0
        ? `δ = ${terrain.delta_m.toFixed(2)} m, ${edgeLabel ?? 'N edges'}`
        : 'no obstruction'
      const triple = terrain.n_edges === 3
        ? '\n\nN=3 cascade δ = |S→E₁|+|E₁→E₂|+|E₂→E₃|+|E₃→R|−|S→R|,\ne = |E₁→E₃|, cap 25 dB.'
        : ''
      const valueTooltip =
        `${deltaStr}.\n\n` +
        'Maekawa per-band output below.\n' +
        'Scalar = A-weighted ΔL_A (full − no_terrain Lden).\n' +
        'Rayleigh δ* gate is reported on its own row when it zeroes any band.' +
        triple
      return [
        <HoverText title={labelTooltip}>
          Terrain diffraction{edgeLabel
            ? ` (δ ${terrain.delta_m.toFixed(2)} m, ${edgeLabel})`
            : ' (none)'}
        </HoverText>,
        <HoverText title={bandsTooltip(terrain.attenuation_bands, { title: valueTooltip })}>
          {fmtDb(terrainDelta)}
        </HoverText>,
      ]
    })(),
    (() => {
      const obs = screening.obstacle
      const edgeCount = obs?.n_edges ?? 0
      const screenLabel = obs
        ? edgeCount > 1
          ? `${edgeCount} diffraction edges`
          : `${obs.kind} ${obs.height_m.toFixed(1)} m`
        : 'none'
      const labelTooltip =
        'A_bar — Building / barrier screening component (SPEC §3.5b).\n\n' +
        'Engine runs ONE combined diffraction over a composite top\n' +
        'profile = elevation + max(building, barrier). This row is the\n' +
        'increment of that combined A_bar over the pure-terrain\n' +
        'component above. A_terrain + A_screen ≡ A_combined — the two\n' +
        'rows are engine decomposition, not two independent Fresnels.'
      const edgesDetail = obs && obs.edges.length > 0
        ? '\n\nEdges:' + obs.edges
            .map((e, i) => {
              const kind = e.kind
              const h = kind === 'terrain' ? 'hill peak' : `${kind} ${e.height_m.toFixed(1)} m`
              return `\n  E${EDGE_SUBSCRIPTS[i] ?? i + 1}  ${h}  @ t=${e.t.toFixed(2)}  (+${e.screen_h_m.toFixed(1)} m above LOS)`
            })
            .join('')
        : ''
      const valueTooltip =
        (obs ? `Representative: ${obs.kind} ${obs.height_m.toFixed(1)} m @ t=${obs.t.toFixed(2)}.\n\n` : '') +
        'Per-band increment below.\n' +
        'Scalar = A-weighted ΔL_A (full − no_screening Lden).' +
        edgesDetail
      return [
        <HoverText title={labelTooltip}>Building/barrier ({screenLabel})</HoverText>,
        <HoverText title={bandsTooltip(screening.attenuation_bands, { title: valueTooltip })}>
          {fmtDb(screeningDelta)}
        </HoverText>,
      ]
    })(),
    [
      <HoverText
        title={
          'A_fol — Foliage / vegetation (ISO 9613-2:2024 Annex A.2.2).\n\n' +
          'Dense forest along the path absorbs mid-to-high frequencies.\n' +
          'Capped at ~200 m effective depth. Project applies a ×0.5\n' +
          'Central-Europe calibration because the WorldCover raster is\n' +
          'binary (any canopy → forest), so pure foliage density is\n' +
          'overcounted without the scalar.'
        }
      >
        Foliage
        {vegetation.forest_depth_m > 0
          ? ` (${vegetation.forest_depth_m.toFixed(0)} m forest, 0.5× adj.)`
          : ' (none)'}
      </HoverText>,
      <HoverText
        title={bandsTooltip(vegetation.attenuation_bands, {
          title: `A_fol per band — α_veg[i] × min(depth, 200 m)`,
          note:
            `Forest depth: ${vegetation.forest_depth_m.toFixed(0)} m across ${vegetation.forest_runs.length} run${vegetation.forest_runs.length === 1 ? '' : 's'}.\n` +
            'Already includes the ×0.5 Central-Europe calibration.\n' +
            'Scalar = A-weighted ΔL_A (full − no_vegetation Lden).',
        })}
      >
        {fmtDb(vegetationDelta)}
      </HoverText>,
    ],
  ]

  // Rayleigh gate indicator: which bands the engine zeroed by the CNOSSOS
  // §2.5.6(c) δ ≤ λ/4 − δ* rule. Read from engine's zeroed bands — no
  // re-derivation.
  const gatedBands = terrain.delta_m > 0 && terrain.delta_star_m > 0
    ? BAND_LABELS.filter((_, i) => terrain.attenuation_bands[i] === 0)
    : []

  return (
    <Section>
      <div className="text-muted-foreground/60 font-normal pb-0.5">
        <HoverText
          title={
            'Baseline corrections: ISO 9613-2 §7 + CNOSSOS-EU §2.5.\n' +
            'Obstructions: ISO 9613-2 §7.4 Maekawa barrier formula +\n' +
            'CNOSSOS-EU §2.5.6(c) Rayleigh δ* gate. Hover individual rows\n' +
            'for concept + value breakdown.'
          }
        >
          Attenuations
        </HoverText>
      </div>
      <InlineTable rows={baselineRows} />
      <div className="h-2" aria-hidden="true" />
      <InlineTable rows={obstructionRows} />
      {gatedBands.length > 0 && (
        <HoverText
          title={
            `Rayleigh gate — CNOSSOS §2.5.6(c) per-band condition δ ≤ λ/4 − δ*.\n` +
            `Engine computed δ* = ${terrain.delta_star_m.toFixed(2)} m for the dominant edge\n` +
            `(mirror fit over bare-earth OLS planes). Bands that fail the test\n` +
            `contribute 0 dB of diffraction attenuation in the total.`
          }
        >
          <div className="mt-0.5 text-[10px] text-muted-foreground italic">
            Rayleigh gate zeroed: {gatedBands.join(', ')}
          </div>
        </HoverText>
      )}
      <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 border-t border-border/40 pt-0.5">
        <span className="text-muted-foreground/70 font-medium">
          <HoverText
            title={
              'Engine variant delta: full Lden − free-field Lden.\n\n' +
              'Free-field covers divergence + atmospheric + ground + FLC\n' +
              '(iso9613.rs:253). Everything else applied in Full shows up\n' +
              'here: terrain diffraction (A_bar), building/barrier screening\n' +
              '(A_bar increment), foliage (A_fol), and — when non-zero —\n' +
              'the urban reflection boost (A_refl). 0 dB means no obstruction\n' +
              'and no reflection changed the outcome.'
            }
          >
            Total obstruction effect
          </HoverText>
        </span>
        <span className="text-foreground font-mono font-medium text-right">
          <HoverText
            title={
              `received_lden.full − received_lden.free_field\n` +
              `= ${received_lden.full.toFixed(2)} − ${received_lden.free_field.toFixed(2)}\n` +
              `= ${totalPathDelta.toFixed(2)} dB (A-weighted).\n\n` +
              'Covers obstructions (A_bar terrain + A_bar building +\n' +
              'A_fol foliage) and — when non-zero — the urban reflection\n' +
              'boost (A_refl), since reflection is applied in Full but\n' +
              'not in free_field.'
            }
          >
            {fmtDb(totalPathDelta)}
          </HoverText>
        </span>
      </div>
    </Section>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// §5 Lden — A-weighting + period weighting → final number
// ────────────────────────────────────────────────────────────────────────────

function Section5Lden({ trace }: { trace: SegmentTrace }) {
  const periodCells = useMemo(
    () =>
      PERIOD_ROWS.map(p => {
        const bands = trace.received_bands[p.key]
        const energy = bands.reduce((a, b) => a + Math.pow(10, b / 10), 0)
        return {
          ...p,
          lw: trace.lw_db_a[p.key],
          lwBands: trace.lw_bands[p.key],
          lrec: 10 * Math.log10(Math.max(energy, 1e-30)),
          lrecBands: bands,
        }
      }),
    [trace.lw_db_a, trace.lw_bands, trace.received_bands],
  )
  return (
    <Section>
      <table className="w-full tabular-nums">
        <thead>
          <tr className="text-muted-foreground/60">
            <th className="text-left font-normal pb-0.5">Period</th>
            <th className="text-right font-normal pb-0.5">
              <HoverText
                title={
                  'L_w — A-weighted sound power level at the source,\n' +
                  'per period. Line sources: dB(A)/m; point sources: dB(A).\n' +
                  'CNOSSOS D/E/N split applied (12/4/8 hour buckets).'
                }
              >
                Lw (A)
              </HoverText>
            </th>
            <th className="text-right font-normal pb-0.5">
              <HoverText
                title={
                  'L_rec — A-weighted received level at this point, per\n' +
                  'period. = L_w − (all propagation terms). What someone\n' +
                  "standing here would actually hear during that period."
                }
              >
                L_rec (A)
              </HoverText>
            </th>
            <th className="text-right font-normal pb-0.5">hours</th>
          </tr>
        </thead>
        <tbody>
          {periodCells.map(p => (
            <tr key={p.key}>
              <td className="text-muted-foreground/80">{p.label}</td>
              <td className="text-right">
                <HoverText
                  title={bandsTooltip(p.lwBands, {
                    title: `${p.label} — Lw per band`,
                    signed: false,
                    note: 'Scalar above = A-weighted sum of all 8 bands (dB(A)).',
                  })}
                                 >
                  {fmtDb(p.lw, { signed: false })}
                </HoverText>
              </td>
              <td className="text-right">
                <HoverText
                  title={bandsTooltip(p.lrecBands, {
                    title: `${p.label} — L_received per band`,
                    signed: false,
                    note: 'Scalar above = A-weighted sum of all 8 bands (dB(A)).',
                  })}
                                 >
                  {fmtDb(p.lrec, { signed: false })}
                </HoverText>
              </td>
              <td className="text-right text-muted-foreground/50">{p.weight} h</td>
            </tr>
          ))}
          <tr className="border-t border-border/40">
            <td>
              <HoverText
                title={
                  'L_den — Day-Evening-Night weighted 24 h noise level.\n' +
                  'Standard END 2002/49/EC metric. Evening gets a +5 dB\n' +
                  'penalty, night +10 dB to reflect higher annoyance.\n' +
                  'Hover the value for the exact formula applied here.'
                }
              >
                Lden
              </HoverText>
            </td>
            <td
              colSpan={3}
              className="text-right font-medium"
              style={{ color: ldenToColor(trace.received_lden.full) }}
            >
              <HoverText
                title={
                  `received_lden.full = ${trace.received_lden.full.toFixed(2)} dB (engine scalar).\n\n` +
                  'Formula:\n' +
                  '  Lden = 10·log₁₀((12·10^(Ld/10)\n' +
                  '              + 4·10^((Le+5)/10)\n' +
                  '              + 8·10^((Ln+10)/10)) / 24)\n\n' +
                  'Ld / Le / Ln are the per-period L_rec(A) rows above\n' +
                  '(day / evening / night). Engine sums per-band received\n' +
                  'energies into each period\'s A-weighted total, then the\n' +
                  'weighted log-sum into Lden.\n\n' +
                  PERIOD_TOOLTIP
                }
              >
                {trace.received_lden.full.toFixed(1)} dB
              </HoverText>
            </td>
          </tr>
        </tbody>
      </table>
    </Section>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// §6 What-if comparison — collapsed by default
// ────────────────────────────────────────────────────────────────────────────

function Section6Variants({ trace }: { trace: SegmentTrace }) {
  const [open, setOpen] = useState(false)
  const { received_lden } = trace
  // "Full" removed — it duplicates the Lden shown in the collapsed header
  // and at the bottom of §5. The delta column anchors against received_lden.full
  // so the label is still the reference, just not rendered as its own row.
  const rows: [string, number, string][] = [
    [
      'Free field',
      received_lden.free_field,
      'Engine variant: full − obstructions − reflection.\n' +
      'Computed as base − A_gr + A_flc (iso9613.rs:253) —\n' +
      'includes divergence, atmospheric, ground, and finite-line\n' +
      'correction, but NOT terrain/screening/foliage obstructions\n' +
      'and NOT urban reflection. Δ vs Full = combined effect of\n' +
      'obstructions plus reflection at this receiver.',
    ],
    [
      'No terrain',
      received_lden.no_terrain,
      'Lden recalculated without terrain diffraction (A_bar, terrain\n' +
      'component only — building/barrier screening still applied).\n' +
      'Δ vs Full = what the hill contributed.',
    ],
    [
      'No screening',
      received_lden.no_screening,
      'Lden without the building/barrier component of combined\n' +
      'diffraction. Δ vs Full = how much the tallest obstacle helped.',
    ],
    [
      'No vegetation',
      received_lden.no_vegetation,
      'Lden without A_fol foliage attenuation. Δ vs Full = forest\n' +
      'contribution to noise reduction along this path.',
    ],
    [
      'No ground',
      received_lden.no_ground,
      'Lden without A_gr ground effect. SIGNED: over soft ground,\n' +
      'removing it may INCREASE Lden (LF boost disappears), so Δ\n' +
      'can be either sign.',
    ],
    [
      'No atmospheric',
      received_lden.no_atmospheric,
      'Lden without atmospheric absorption (air = perfectly\n' +
      'transmitting). Δ vs Full = what the air ate, mainly HF.',
    ],
  ]
  const whatIfTooltip =
    `Deltas below = Lden when removing each effect, compared to\n` +
    `the full ${received_lden.full.toFixed(1)} dB shown above. Each row\n` +
    `is an engine variant (no_terrain / no_screening / …) from\n` +
    `iso9613.rs; Δ quantifies what that effect contributes.`
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="text-[9px] uppercase tracking-[0.08em] text-muted-foreground/70 hover:text-foreground inline-flex items-center gap-1"
      >
        <span>{open ? '▾' : '▸'}</span>
        <HoverText title={whatIfTooltip}>
          <span>What-if</span>
        </HoverText>
      </button>
      {open && (
        <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-0.5 tabular-nums mt-0.5">
          {rows.map(([label, v, conceptTooltip], i) => {
            const delta = v - received_lden.full
            return (
              <div key={i} className="contents">
                <HoverText title={conceptTooltip}>
                  <span className="text-muted-foreground/70">{label}</span>
                </HoverText>
                <span className="text-right">{fmtDb(v, { signed: false })}</span>
                <span className="text-right text-muted-foreground/50">
                  {delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Main expanded view — physics chain order
// ────────────────────────────────────────────────────────────────────────────

export function SegmentExpanded({ trace }: { trace: SegmentTrace }) {
  // Airborne sub-segments and cruise R8 hexes use Doc 29 SEL chains —
  // not ISO 9613-2 path effects — so the path-profile / terrain /
  // screening / vegetation / per-band Lw / Lden sections render with
  // empty / silent / uniform values that misrepresent the source.
  // Render the emission-input section only for those sub-types and
  // skip the ISO chain entirely.
  const isAirborne =
    trace.kind === 'aircraft' && (trace.aircraft_subtype === 2 || trace.aircraft_subtype === 3)
  if (isAirborne) {
    return (
      <div className="ml-2 mr-4 pb-2 text-[11px] leading-relaxed font-mono text-muted-foreground">
        <Section1Source trace={trace} />
      </div>
    )
  }
  return (
    <div className="ml-2 mr-4 pb-2 text-[11px] leading-relaxed font-mono text-muted-foreground">
      <Section1Source trace={trace} />
      <Section>
        <PathProfileDiagram
          trace={trace.path_profile}
          terrainEdges={trace.terrain.edges}
          dominantEdgeIdx={trace.terrain.dominant_edge_idx}
        />
        <HoverText
          title={
            'Bilateral cadence: one 10 m near-probe at each end (berm catch),\n' +
            'then three samples at 30 m / 60 m / 120 m, then 240 m through the\n' +
            'middle. step_m_med is the median inter-sample gap the engine saw\n' +
            '(propagation::path_profile::fill_t_values).'
          }
        >
          <div className="mt-0.5 text-[10px] text-muted-foreground italic">
            Profile: {trace.path_profile.t.length} samples · median step{' '}
            {trace.path_profile.step_m_med.toFixed(1)} m
          </div>
        </HoverText>
      </Section>
      <Section4PathEffects trace={trace} />
      <Section5Lden trace={trace} />
      <Section6Variants trace={trace} />
    </div>
  )
}
