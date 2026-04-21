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
  const rows: [string, React.ReactNode][] = [
    ['Geometric divergence', fmtDb(-baseline.geometric_db)],
    ['Atmospheric (1 kHz)', fmtDb(-baseline.atmospheric_bands[4])],
    ['Ground factor G', baseline.ground_factor_g.toFixed(2)],
    ['Source height', `${baseline.source_height_m.toFixed(1)} m`],
    ['Finite-line correction', fmtDb(baseline.finite_line_corr_db)],
  ]
  // Work in positive magnitudes (dB removed) — easier to reason about the
  // max rule. attenuation_db_a is negative when an effect removes sound, so
  // we flip the sign here.
  const aGrMag = -ground.attenuation_db_a
  const aTerMag = -terrain.attenuation_db_a
  const aScrMag = -screening.attenuation_db_a
  const aVegMag = -vegetation.attenuation_db_a
  const aBarMag = aTerMag + aScrMag
  const hasBarrier = aBarMag > 0
  const aGroundOrBarrier = hasBarrier ? Math.max(aGrMag, aBarMag) : aGrMag
  const barrierWins = hasBarrier && aBarMag >= aGrMag
  const aTotalPath = aGroundOrBarrier + aVegMag

  const effects: [string, React.ReactNode][] = [
    [
      'Terrain',
      <>
        {fmtDb(terrain.attenuation_db_a)} · δ {terrain.delta_m.toFixed(2)} m
        {terrain.is_double ? ' (double)' : ''}
      </>,
    ],
    [
      'Building screening',
      screening.obstacle ? (
        <>
          {fmtDb(screening.attenuation_db_a)} · {screening.obstacle.kind} {screening.obstacle.height_m.toFixed(1)} m
          @ t={screening.obstacle.t.toFixed(2)}
        </>
      ) : (
        fmtDb(screening.attenuation_db_a)
      ),
    ],
    ['Ground (A_gr)', fmtDb(ground.attenuation_db_a)],
    [
      hasBarrier ? 'Ground or barrier' : 'Ground (applied)',
      <HoverText title={MAX_RULE_FORMULA}>
        <span>
          {fmtDb(-aGroundOrBarrier)}
          {hasBarrier && (
            <span className="text-muted-foreground/50">
              {' '}
              = max(A_gr={aGrMag.toFixed(1)}, A_ter+A_scr={aBarMag.toFixed(1)}) ·{' '}
              <span className={barrierWins ? 'text-amber-500' : 'text-emerald-500'}>
                {barrierWins ? 'barrier' : 'ground'} wins
              </span>
            </span>
          )}
        </span>
      </HoverText>,
    ],
    [
      'Vegetation',
      <>
        {fmtDb(vegetation.attenuation_db_a)} · {vegetation.forest_depth_m.toFixed(0)} m forest ·{' '}
        {vegetation.forest_runs.length} run{vegetation.forest_runs.length === 1 ? '' : 's'}
      </>,
    ],
    [
      'Total path effect',
      <span className="font-medium">
        {fmtDb(-aTotalPath)}
        <span className="text-muted-foreground/50">
          {' '}(= ground_or_barrier {aGroundOrBarrier.toFixed(1)} + vegetation {aVegMag.toFixed(1)})
        </span>
      </span>,
    ],
  ]
  return (
    <Section title="Baseline & path effects">
      <InlineTable rows={rows} />
      <div className="h-1" />
      <InlineTable rows={effects} />
      <div className="mt-1 text-[9px] text-muted-foreground/50">
        Received Lden (full) = {received_lden.full.toFixed(1)} dB · free-field {received_lden.free_field.toFixed(1)} dB · delta {(received_lden.full - received_lden.free_field).toFixed(1)} dB.
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
