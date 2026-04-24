import { useMemo, useState } from 'react'
import type { EmissionTrace, SegmentTrace } from '../../types/noise'
import { ldenToColor } from '../../utils/noise-colors'
import { HoverText } from '../ui/info-tip'
import { PathProfileDiagram } from './PathProfileDiagram'
import {
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

const LDEN_FORMULA =
  'Lden = 10·log₁₀( (12·10^(Ld/10) + 4·10^((Le+5)/10) + 8·10^((Ln+10)/10)) / 24 )\n' +
  'Evening +5 dB and night +10 dB are the CNOSSOS penalties.'

function bandsTooltip(
  bands: readonly number[],
  {
    title,
    signed = true,
    note,
  }: { title: string; signed?: boolean; note?: string } = { title: '' },
) {
  const lines = bands.map((v, i) => {
    const label = BAND_LABELS[i] ?? `${BAND_FREQS[i]} Hz`
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
  const emissionRowsList = useMemo(() => emissionInputRows(trace.emission), [trace.emission])
  const lwRow = useMemo(() => computeLwRow(trace), [trace])
  const rows = useMemo(
    () => (lwRow ? [...emissionRowsList, lwRow] : emissionRowsList),
    [emissionRowsList, lwRow],
  )
  return (
    <Section>
      <InlineTable rows={rows} />
    </Section>
  )
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
  const tooltip =
    `${cfg.symbol} — ${cfg.desc}, A-weighted\n\n` +
    `  day      ${lw.day.toFixed(1).padStart(6)} ${cfg.unit}\n` +
    `  evening  ${lw.evening.toFixed(1).padStart(6)} ${cfg.unit}\n` +
    `  night    ${lw.night.toFixed(1).padStart(6)} ${cfg.unit}\n\n` +
    `Day value is representative (longest, loudest period for\nmost sources). Per-band values live in §5 under "Emission".`
  return [
    <HoverText title={tooltip} className="no-underline">
      <span className="cursor-help">{cfg.label}</span>
    </HoverText>,
    `${lw.day.toFixed(1)} ${cfg.unit}`,
  ]
}

function emissionInputRows(e: EmissionTrace): [React.ReactNode, React.ReactNode][] {
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
          <HoverText title={trafficText} className="no-underline">
            {Math.round(total)}/day
          </HoverText>,
        ],
        [
          'Surface',
          <HoverText title={surfaceText} className="no-underline">
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
          <HoverText title={trainsText} className="no-underline">
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
      return [
        ['Class', e.class],
        ['Observed movements', e.observed_movements.toFixed(1)],
        ['Modeled movements', e.modeled_movements.toFixed(1)],
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
      return [
        ['Source type', e.source_type],
        ['Area', e.area_m2 > 0 ? `${Math.round(e.area_m2)} m²` : '—'],
        ['NACE', e.nace ?? '—'],
        ['Hub height', e.hub_height_m != null ? `${e.hub_height_m.toFixed(1)} m` : '—'],
        ['Rated power', e.rated_power_kw != null ? `${Math.round(e.rated_power_kw)} kW` : '—'],
        ['Effective source dist', `${e.effective_area_source_dist_m.toFixed(0)} m`],
      ]
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// §2 Baseline — path-independent (distance only, no terrain/obstacles)
// ────────────────────────────────────────────────────────────────────────────

function Section2Baseline({ trace }: { trace: SegmentTrace }) {
  const { baseline, received_lden } = trace
  const atmosphericDelta = received_lden.full - received_lden.no_atmospheric

  const slantSame = Math.abs(trace.d_slant_m - trace.dist_m) < 0.5
  const distRow: [string, React.ReactNode] = [
    'Distance',
    slantSame
      ? `${trace.dist_m.toFixed(0)} m`
      : `${trace.dist_m.toFixed(0)} m (slant ${trace.d_slant_m.toFixed(0)} m)`,
  ]
  return (
    <Section>
      <InlineTable
        rows={[
          distRow,
          ['Source height', `${baseline.source_height_m.toFixed(1)} m`],
          ['Geometric divergence', fmtDb(-baseline.geometric_db)],
          [
            <HoverText
              title={bandsTooltip(baseline.atmospheric_bands, {
                title: 'Atmospheric absorption — α[i] × d/1000 per band',
                signed: true,
                note:
                  'ISO 9613-2 §7.2 standard atmosphere (15 °C, 70 % RH). Higher\nfrequencies absorb more. Scalar above is A-weighted ΔL_A from\nthe full vs no_atmospheric variant comparison.',
              })}
            >
              <span className="cursor-help">Atmospheric impact</span>
            </HoverText>,
            fmtDb(atmosphericDelta),
          ],
        ]}
      />
    </Section>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// §4 Path effects — derived from the path geometry (terrain, ground, etc.)
// ────────────────────────────────────────────────────────────────────────────

function Section4PathEffects({ trace }: { trace: SegmentTrace }) {
  const { baseline, terrain, screening, vegetation, ground, received_lden } = trace

  const groundDelta = received_lden.full - received_lden.no_ground
  const terrainDelta = received_lden.full - received_lden.no_terrain
  const screeningDelta = received_lden.full - received_lden.no_screening
  const vegetationDelta = received_lden.full - received_lden.no_vegetation
  const totalPathDelta = received_lden.full - received_lden.free_field

  const rows: [React.ReactNode, React.ReactNode][] = [
    [
      <HoverText
        title={bandsTooltip(ground.attenuation_bands, {
          title: `Ground effect — per band (G = ${ground.factor_g.toFixed(2)})`,
          note:
            'SIGNED: over soft ground CF[i] < 0 at 63/125 Hz, so ground can\nBOOST LF energy. Positive ΔL_A means ground added dB.',
        })}
      >
        <span className="cursor-help">Ground (G={ground.factor_g.toFixed(2)})</span>
      </HoverText>,
      fmtDb(groundDelta),
    ],
    [
      (() => {
        // "single / double / triple edge" per engine's n_edges (is_double alone
        // can't tell N=2 from N=3 — both set is_double=true for back-compat).
        const edgeLabel =
          terrain.n_edges === 1 ? 'single edge'
          : terrain.n_edges === 2 ? 'double edge'
          : terrain.n_edges === 3 ? 'triple edge'
          : null
        const deltaStr = terrain.delta_m > 0
          ? `δ = ${terrain.delta_m.toFixed(2)} m${edgeLabel ? `, ${edgeLabel}` : ''}`
          : 'no obstruction'
        const triple = terrain.n_edges === 3
          ? '\n\nN=3 cascade (project simplification): δ = |S→E₁|+|E₁→E₂|+|E₂→E₃|+|E₃→R|−|S→R|, e = |E₁→E₃|, cap 25 dB.'
          : ''
        const rayleigh = terrain.delta_star_m > 0
          ? `\n\nRayleigh δ* = ${terrain.delta_star_m.toFixed(2)} m — per-band gate: bands with δ ≤ λ/4 − δ* are zeroed (CNOSSOS §2.5.6(c)).`
          : ''
        const title =
          `Terrain diffraction — per band (${deltaStr})\n` +
          '\nFresnel / Maekawa model. δ = path difference at the apex.' +
          '\nScalar above = A-weighted ΔL_A (full − no_terrain Lden).' +
          triple +
          rayleigh
        return (
          <HoverText title={bandsTooltip(terrain.attenuation_bands, { title })}>
            <span className="cursor-help">
              Terrain {edgeLabel
                ? `(δ ${terrain.delta_m.toFixed(2)} m, ${edgeLabel})`
                : '(none)'}
            </span>
          </HoverText>
        )
      })(),
      fmtDb(terrainDelta),
    ],
    [
      (() => {
        // "N diffraction edges" — NOT "N obstacles" (one edge can be a
        // bare-earth hill with kind='terrain').
        const obs = screening.obstacle
        const edgeCount = obs?.n_edges ?? 0
        const screenLabel = obs
          ? edgeCount > 1
            ? `${edgeCount} diffraction edges`
            : `${obs.kind} ${obs.height_m.toFixed(1)} m`
          : 'none'
        const edgesDetail = obs && obs.edges.length > 0
          ? '\n\nEdges:' + obs.edges
              .map((e, i) => {
                const kind = e.kind
                const h = kind === 'terrain' ? 'hill peak' : `${kind} ${e.height_m.toFixed(1)} m`
                return `\n  E${['₁','₂','₃'][i] ?? i + 1}  ${h}  @ t=${e.t.toFixed(2)}  (+${e.screen_h_m.toFixed(1)} m above LOS)`
              })
              .join('')
          : ''
        const title =
          `Screening (combined terrain + buildings + barriers) — per band\n` +
          (obs ? `Representative obstacle: ${obs.kind} ${obs.height_m.toFixed(1)} m @ t=${obs.t.toFixed(2)}\n` : '') +
          '\nCombined diffraction over composite top profile = elevation + max(building, barrier).' +
          '\nSingle Fresnel pass — A_terrain + A_screen ≡ A_combined (SPEC §3.5b, anti-double-count).' +
          '\nScalar above = A-weighted ΔL_A (full − no_screening Lden).' +
          edgesDetail
        return (
          <HoverText title={bandsTooltip(screening.attenuation_bands, { title })}>
            <span className="cursor-help">Screening ({screenLabel})</span>
          </HoverText>
        )
      })(),
      fmtDb(screeningDelta),
    ],
    [
      <HoverText
        title={bandsTooltip(vegetation.attenuation_bands, {
          title: `Vegetation — per band (${vegetation.forest_depth_m.toFixed(0)} m forest · ${
            vegetation.forest_runs.length
          } run${vegetation.forest_runs.length === 1 ? '' : 's'})`,
          note: 'ISO 9613-2 §A.2.2: per-band absorption × min(forest_depth, 200 m).\nScalar above = A-weighted ΔL_A (full − no_vegetation Lden).',
        })}
      >
        <span className="cursor-help">
          Vegetation
          {vegetation.forest_depth_m > 0
            ? ` (${vegetation.forest_depth_m.toFixed(0)} m forest)`
            : ' (none)'}
        </span>
      </HoverText>,
      fmtDb(vegetationDelta),
    ],
  ]

  if (Math.abs(baseline.finite_line_corr_db) > 0.05) {
    rows.push([
      <HoverText title="Finite-line correction — applies to line sources (roads, rails). Compensates for the segment's finite angular extent at the receiver.">
        <span className="cursor-help">Finite-line correction</span>
      </HoverText>,
      fmtDb(baseline.finite_line_corr_db),
    ])
  }

  // Rayleigh gate indicator: which bands the engine zeroed by the CNOSSOS
  // §2.5.6(c) δ ≤ λ/4 − δ* rule. We read the engine's per-band output
  // (zero where δ_m > 0 means the gate fired) — no re-derivation.
  const gatedBands = terrain.delta_m > 0 && terrain.delta_star_m > 0
    ? BAND_LABELS.filter((_, i) => terrain.attenuation_bands[i] === 0)
    : []

  return (
    <Section>
      <InlineTable rows={rows} />
      {gatedBands.length > 0 && (
        <HoverText
          title={
            `Rayleigh gate — CNOSSOS §2.5.6(c) per-band condition δ ≤ λ/4 − δ*.\n` +
            `Engine computed δ* = ${terrain.delta_star_m.toFixed(2)} m for the dominant edge\n` +
            `(mirror fit over bare-earth OLS planes). Bands that fail the test\n` +
            `contribute 0 dB of diffraction attenuation in the total.`
          }
        >
          <div className="mt-0.5 text-[10px] text-muted-foreground italic cursor-help">
            Rayleigh gate zeroed: {gatedBands.join(', ')}
          </div>
        </HoverText>
      )}
      <HoverText
        title={
          'Combined terrain + building + barrier screening (SPEC §3.5b).\n' +
          'Single Fresnel pass over composite top profile = elevation +\n' +
          'max(building, barrier). A_terrain + A_screen ≡ A_combined — the two\n' +
          'rows above are an engine decomposition, not two independent Fresnels.\n' +
          'δ* OLS fit stays on bare-earth elevation for correct ground-reflection\n' +
          'physics.'
        }
      >
        <div className="mt-0.5 text-[10px] text-muted-foreground italic cursor-help">
          Terrain + screening computed as one combined diffraction (§3.5b).
        </div>
      </HoverText>
      <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 border-t border-border/40 pt-0.5">
        <span className="text-muted-foreground/70 font-medium">Total path effect</span>
        <span className="text-foreground font-mono font-medium text-right">
          {fmtDb(totalPathDelta)}
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
            <th className="text-right font-normal pb-0.5">Lw (A)</th>
            <th className="text-right font-normal pb-0.5">L_rec (A)</th>
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
              <HoverText title={`${LDEN_FORMULA}\n\n${PERIOD_TOOLTIP}`}>Lden</HoverText>
            </td>
            <td colSpan={3} className="text-right font-medium" style={{ color: ldenToColor(trace.received_lden.full) }}>
              {trace.received_lden.full.toFixed(1)} dB
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
  const rows: [string, number][] = [
    ['Full', received_lden.full],
    ['Free field', received_lden.free_field],
    ['No terrain', received_lden.no_terrain],
    ['No screening', received_lden.no_screening],
    ['No vegetation', received_lden.no_vegetation],
    ['No ground', received_lden.no_ground],
    ['No atmospheric', received_lden.no_atmospheric],
  ]
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="text-[9px] uppercase tracking-[0.08em] text-muted-foreground/70 hover:text-foreground inline-flex items-center gap-1"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>What-if</span>
      </button>
      {open && (
        <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-0.5 tabular-nums mt-0.5">
          {rows.map(([label, v], i) => {
            const delta = v - received_lden.full
            return (
              <div key={i} className="contents">
                <span className="text-muted-foreground/70">{label}</span>
                <span className="text-right">{fmtDb(v, { signed: false })}</span>
                <span className="text-right text-muted-foreground/50">
                  {label === 'Full' ? '' : delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1)}
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
  return (
    <div className="ml-2 mr-4 pb-2 text-[11px] leading-relaxed font-mono text-muted-foreground">
      <Section1Source trace={trace} />
      <Section2Baseline trace={trace} />
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
          <div className="mt-0.5 text-[10px] text-muted-foreground italic cursor-help">
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
