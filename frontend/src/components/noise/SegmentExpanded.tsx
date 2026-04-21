import { useMemo } from 'react'
import type { EmissionTrace, SegmentTrace } from '../../types/noise'
import { ldenToColor } from '../../utils/noise-colors'
import { HoverText } from '../ui/info-tip'
import { PathProfileDiagram } from './PathProfileDiagram'

const PERIOD_ROWS = [
  { key: 'day', label: 'Day (07–19)', weight: 12 },
  { key: 'evening', label: 'Evening (19–23)', weight: 4 },
  { key: 'night', label: 'Night (23–07)', weight: 8 },
] as const

const BAND_FREQS = [63, 125, 250, 500, 1000, 2000, 4000, 8000] as const
const BAND_LABELS = ['63 Hz', '125 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '8 kHz'] as const

function bandsTooltip(
  bands: readonly number[],
  {
    title,
    signed = true,
    highlightIdx = 4,
    note,
  }: { title: string; signed?: boolean; highlightIdx?: number; note?: string } = { title: '' },
) {
  const lines = bands.map((v, i) => {
    const label = BAND_LABELS[i] ?? `${BAND_FREQS[i]} Hz`
    const sign = signed && v > 0 ? '+' : ''
    const mark = i === highlightIdx ? ' ←' : ''
    return `  ${label.padEnd(8)} ${sign}${v.toFixed(2).padStart(7)} dB${mark}`
  })
  const header = title ? `${title}\n\n` : ''
  const footer = note ? `\n\n${note}` : ''
  return `${header}${lines.join('\n')}${footer}`
}

const LDEN_FORMULA =
  'Lden = 10·log₁₀( (12·10^(Ld/10) + 4·10^((Le+5)/10) + 8·10^((Ln+10)/10)) / 24 )\n' +
  'Evening +5 dB and night +10 dB are the CNOSSOS penalties.'

const MAX_RULE_FORMULA =
  'ISO 9613-2 §7.3.1: when a barrier (terrain or building) is present,\n' +
  'ground attenuation is REPLACED by max(A_ground, A_terrain+A_screening).\n' +
  'Vegetation is always additive.'

function fmtDb(v: number, { signed = true, digits = 1 } = {}): string {
  if (!Number.isFinite(v)) return '—'
  const sign = signed && v > 0 ? '+' : ''
  return `${sign}${v.toFixed(digits)} dB`
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5">
      <div className="text-[9px] uppercase tracking-[0.08em] text-muted-foreground/70 mb-0.5">
        {title}
      </div>
      {children}
    </div>
  )
}

function InlineTable({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <span className="text-muted-foreground/70 whitespace-nowrap">{k}</span>
          <span className="text-foreground font-mono text-right">{v}</span>
        </div>
      ))}
    </div>
  )
}

function AggregateAttenuations({ trace }: { trace: SegmentTrace }) {
  const { baseline, terrain, screening, vegetation, ground, received_lden } = trace
  const TOOLTIP_NOTE =
    'Scalar above is A-weighted Lden delta from variant comparison. Per-band values below are the raw attenuations the engine applied — the arrow (←) marks 1 kHz for orientation, but the scalar itself is a dB(A) sum, not a single band.'
  const rows: [string, React.ReactNode][] = [
    ['Geometric divergence', fmtDb(-baseline.geometric_db)],
    [
      'Atmospheric (at 1 kHz)',
      <HoverText
        title={bandsTooltip(baseline.atmospheric_bands, {
          title: 'Atmospheric absorption (ISO 9613-2 §7.2) — per band',
          signed: true,
          highlightIdx: 4,
          note:
            'Frequency-dependent (α_atm × d/1000). Engine applies per band before A-weighting; display scalar is 1 kHz only.',
        })}
      >
        {fmtDb(-baseline.atmospheric_bands[4])}
      </HoverText>,
    ],
    ['Ground factor G', baseline.ground_factor_g.toFixed(2)],
    ['Source height', `${baseline.source_height_m.toFixed(1)} m`],
    ['Finite-line correction', fmtDb(baseline.finite_line_corr_db)],
  ]

  // A-weighted Lden impacts from PropagationVariants. Negative = effect
  // reduced Lden. Semantics per ISO 9613-2: attenuation is defined per
  // octave band; the only physically meaningful single-number summary is
  // ΔL_A = L_A(no effect) − L_A(with effect), which is exactly what the
  // engine's variant energies give us in A-weighted terms.
  const terrainDelta = received_lden.full - received_lden.no_terrain
  const screeningDelta = received_lden.full - received_lden.no_screening
  const vegetationDelta = received_lden.full - received_lden.no_vegetation
  const totalPathDelta = received_lden.full - received_lden.free_field

  // Per-band (raw) max-rule applied as the engine does it — for tooltip only.
  const groundOrBarrierBands: number[] = baseline.atmospheric_bands.map((_, i) => {
    const bar = terrain.attenuation_bands[i] + screening.attenuation_bands[i]
    return bar > 0 ? Math.max(ground.attenuation_bands[i], bar) : ground.attenuation_bands[i]
  })
  const totalPathBands = groundOrBarrierBands.map((gob, i) => gob + vegetation.attenuation_bands[i])

  const effects: [string, React.ReactNode][] = [
    [
      'Terrain impact',
      <HoverText
        title={bandsTooltip(terrain.attenuation_bands, {
          title: `Terrain diffraction — per band (δ = ${terrain.delta_m.toFixed(2)} m${terrain.is_double ? ', double' : ''})`,
          highlightIdx: 4,
          note: TOOLTIP_NOTE,
        })}
      >
        <span>
          {fmtDb(terrainDelta)} (A) · δ {terrain.delta_m.toFixed(2)} m
          {terrain.is_double ? ' (double)' : ''}
        </span>
      </HoverText>,
    ],
    [
      'Building screening impact',
      <HoverText
        title={bandsTooltip(screening.attenuation_bands, {
          title: screening.obstacle
            ? `Building screening — per band (${screening.obstacle.kind} ${screening.obstacle.height_m.toFixed(1)} m @ t=${screening.obstacle.t.toFixed(2)})`
            : 'Building screening — per band',
          highlightIdx: 4,
          note: TOOLTIP_NOTE,
        })}
      >
        <span>
          {fmtDb(screeningDelta)} (A)
          {screening.obstacle ? (
            <>
              {' '}· {screening.obstacle.kind} {screening.obstacle.height_m.toFixed(1)} m @ t=
              {screening.obstacle.t.toFixed(2)}
            </>
          ) : null}
        </span>
      </HoverText>,
    ],
    [
      'Vegetation impact',
      <HoverText
        title={bandsTooltip(vegetation.attenuation_bands, {
          title: `Vegetation — per band (${vegetation.forest_depth_m.toFixed(0)} m forest · ${vegetation.forest_runs.length} run${vegetation.forest_runs.length === 1 ? '' : 's'})`,
          highlightIdx: 4,
          note: TOOLTIP_NOTE,
        })}
      >
        <span>
          {fmtDb(vegetationDelta)} (A) · {vegetation.forest_depth_m.toFixed(0)} m forest ·{' '}
          {vegetation.forest_runs.length} run{vegetation.forest_runs.length === 1 ? '' : 's'}
        </span>
      </HoverText>,
    ],
    [
      'Ground (per band only)',
      <HoverText
        title={bandsTooltip(ground.attenuation_bands, {
          title: `Ground effect — per band (G = ${ground.factor_g.toFixed(2)})`,
          highlightIdx: 4,
          note:
            'Engine has no "no_ground" variant, so no A-weighted Lden delta is available. Per-band: CF[i] × G. Soft ground (G → 1) can ADD sound at 63/125 Hz (negative values are standard).',
        })}
      >
        <span className="text-muted-foreground/70">
          G = {ground.factor_g.toFixed(2)} · hover for bands
        </span>
      </HoverText>,
    ],
    [
      'Applied ground + barrier (per band)',
      <HoverText
        title={bandsTooltip(groundOrBarrierBands, {
          title: 'Engine applies max(A_gr, A_terrain + A_screening) per band',
          highlightIdx: 4,
          note: MAX_RULE_FORMULA,
        })}
      >
        <span className="text-muted-foreground/70">
          hover for per-band max(A_gr, A_ter+A_scr)
        </span>
      </HoverText>,
    ],
    [
      'Total path effect',
      <HoverText
        title={bandsTooltip(totalPathBands, {
          title: 'All path effects combined — per band (ground_or_barrier + vegetation)',
          highlightIdx: 4,
          note: 'Scalar above = full − free_field (A-weighted Lden delta including ground + barriers + vegetation + reflection boost).',
        })}
      >
        <span className="font-medium">
          {fmtDb(totalPathDelta)} (A) · full vs free-field Lden
        </span>
      </HoverText>,
    ],
  ]

  return (
    <Section title="Baseline & path effects">
      <InlineTable rows={rows} />
      <div className="h-1" />
      <InlineTable rows={effects} />
      <div className="mt-1 text-[9px] text-muted-foreground/50">
        Received Lden = {received_lden.full.toFixed(1)} dB(A) · free-field {received_lden.free_field.toFixed(1)} dB(A) · path-effect delta {fmtDb(totalPathDelta)}.
        <br />
        ISO 9613-2 §7.3.1: engine applies <code>max(A_gr, A_ter+A_scr)</code> per band, then adds vegetation;{' '}
        impacts above are <code>Lden_full − Lden_no_X</code> from the engine's variant comparison.
      </div>
    </Section>
  )
}

function PeriodTable({ trace }: { trace: SegmentTrace }) {
  const periodCells = useMemo(
    () =>
      PERIOD_ROWS.map(p => {
        const bands = trace.received_bands[p.key]
        const energy = bands.reduce((a, b) => a + Math.pow(10, b / 10), 0)
        return {
          ...p,
          lw: trace.lw_db_a[p.key],
          lrec: 10 * Math.log10(Math.max(energy, 1e-30)),
        }
      }),
    [trace.lw_db_a, trace.received_bands],
  )
  return (
    <Section title="Periods">
      <table className="w-full text-[10px] font-mono">
        <thead>
          <tr className="text-muted-foreground/60">
            <th className="text-left font-normal pb-0.5">Period</th>
            <th className="text-right font-normal pb-0.5">Lw (A)</th>
            <th className="text-right font-normal pb-0.5">Lrec (A)</th>
            <th className="text-right font-normal pb-0.5">hours</th>
          </tr>
        </thead>
        <tbody>
          {periodCells.map(p => (
            <tr key={p.key}>
              <td>{p.label}</td>
              <td className="text-right">{fmtDb(p.lw, { signed: false })}</td>
              <td className="text-right">{fmtDb(p.lrec, { signed: false })}</td>
              <td className="text-right text-muted-foreground/50">{p.weight} h</td>
            </tr>
          ))}
          <tr className="border-t border-border/40">
            <td>
              <HoverText title={LDEN_FORMULA}>Lden</HoverText>
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

function VariantComparison({ trace }: { trace: SegmentTrace }) {
  const { received_lden } = trace
  const rows: [string, number][] = [
    ['Full', received_lden.full],
    ['Free field', received_lden.free_field],
    ['No terrain', received_lden.no_terrain],
    ['No screening', received_lden.no_screening],
    ['No vegetation', received_lden.no_vegetation],
  ]
  return (
    <Section title="Variant comparison">
      <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-0.5 text-[10px] font-mono">
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
    </Section>
  )
}

function EmissionBreakdown({ emission }: { emission: EmissionTrace }) {
  const rows = useMemo(() => emissionRows(emission), [emission])
  return (
    <Section title="Emission inputs">
      <InlineTable rows={rows} />
    </Section>
  )
}

function emissionRows(e: EmissionTrace): [string, React.ReactNode][] {
  switch (e.kind) {
    case 'road': {
      const total = e.aadt_light + e.aadt_medium + e.aadt_heavy + e.aadt_moto
      return [
        [
          'AADT (effective)',
          `light ${Math.round(e.aadt_light)} · med ${Math.round(e.aadt_medium)} · heavy ${Math.round(
            e.aadt_heavy,
          )} · moto ${Math.round(e.aadt_moto)} = ${Math.round(total)}/day`,
        ],
        ['Speed', `${e.speed_kmh.toFixed(0)} km/h`],
        ['Surface correction', fmtDb(e.surface_corr_db)],
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
      return [
        ['Trains (pax / freight)', `${e.trains_passenger.toFixed(1)} / ${e.trains_freight.toFixed(1)} per day`],
        ['Speed', `${e.speed_kmh.toFixed(0)} km/h`],
        ['Type', `${e.rail_type}${e.highspeed ? ' · highspeed' : ''}${e.service ? ' · service' : ''}`],
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

export function SegmentExpanded({ trace }: { trace: SegmentTrace }) {
  return (
    <div className="px-1 pb-2 text-[10px] text-muted-foreground/90">
      <PathProfileDiagram
        trace={trace.path_profile}
        obstacle={trace.screening.obstacle}
        terrainEdgeApexT={trace.terrain.edge_apex_t}
        terrainEdgeApexElev={trace.terrain.edge_apex_elev_m}
      />
      <AggregateAttenuations trace={trace} />
      <PeriodTable trace={trace} />
      <VariantComparison trace={trace} />
      <EmissionBreakdown emission={trace.emission} />
    </div>
  )
}
