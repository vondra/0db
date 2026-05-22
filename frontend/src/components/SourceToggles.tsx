import { Car, TrainFront, Plane, Building2, Factory } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SourceMode } from '../hooks/useUrlState'
import type { AircraftLayerSource } from './HeatmapV3Overlay'

interface Source {
  id: string
  label: string
  tooltip: string
  icon: ReactNode
  hasEndModes: boolean
}

const SOURCES: Source[] = [
  { id: 'road', label: 'Roads', tooltip: 'Car, truck, and motorcycle traffic noise', icon: <Car className="size-4" />, hasEndModes: true },
  { id: 'railway', label: 'Railways', tooltip: 'Trains, trams, and freight lines', icon: <TrainFront className="size-4" />, hasEndModes: true },
  { id: 'building', label: 'Buildings', tooltip: 'Everyday building noise — HVAC, activity, deliveries', icon: <Building2 className="size-4" />, hasEndModes: false },
  { id: 'industrial', label: 'Industrial', tooltip: 'Factories, power plants, quarries', icon: <Factory className="size-4" />, hasEndModes: true },
]

// Aircraft is split into three independent heatmap layers (cruise / airborne /
// ground-ops have wildly different spatial signatures). They drive
// rasterOverlays directly — popup/hex always include aircraft regardless.
const AIRCRAFT_HEATMAP_ROWS: { id: AircraftLayerSource; label: string; tooltip: string }[] = [
  { id: 'aircraft-ground',   label: 'Aircraft — ground ops', tooltip: 'Taxi + runway roll + apron movements' },
  { id: 'aircraft-airborne', label: 'Aircraft — airborne',   tooltip: 'Climb / approach / departure within ~3000 m AGL' },
  { id: 'aircraft-cruise',   label: 'Aircraft — cruise',     tooltip: 'High-altitude overflight (FL100+)' },
]

export const ALL_SOURCE_IDS = SOURCES.map(s => s.id)

const END_MODES: { mode: SourceMode; label: string }[] = [
  { mode: '0db', label: '0db' },
  { mode: 'end', label: 'END' },
  { mode: 'diff', label: 'Diff' },
]

interface SourceTogglesProps {
  sourceModes: Record<string, SourceMode>
  onToggleSource: (sourceId: string) => void
  onSourceModeChange: (sourceId: string, mode: SourceMode) => void
  rasterOverlays: Record<string, boolean>
  onRasterOverlayChange: (overlays: Record<string, boolean>) => void
}

interface OnOffRowProps {
  id: string
  label: string
  tooltip: string
  icon: ReactNode
  active: boolean
  onToggle: () => void
}

function OnOffRow({ id, label, tooltip, icon, active, onToggle }: OnOffRowProps) {
  const tone = active ? 'text-foreground' : 'text-muted-foreground'
  return (
    <button
      onClick={onToggle}
      title={tooltip}
      data-testid={`layer-${id}`}
      className="flex w-full items-center gap-2.5 py-1.5 px-1 rounded-lg hover:bg-black/5 transition-colors cursor-pointer"
    >
      <span className={tone}>{icon}</span>
      <span className={`flex-1 text-left text-sm ${tone}`}>{label}</span>
      <span className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        active ? 'bg-primary' : 'bg-muted-foreground/20'
      }`}>
        <span className={`inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform ${
          active ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`} />
      </span>
    </button>
  )
}

const PLANE_ICON = <Plane className="size-4" />

export default function SourceToggles({
  sourceModes, onToggleSource, onSourceModeChange,
  rasterOverlays, onRasterOverlayChange,
}: SourceTogglesProps) {
  return (
    <div data-testid="layers-panel">
      {AIRCRAFT_HEATMAP_ROWS.map(row => {
        const active = !!rasterOverlays[row.id]
        return (
          <OnOffRow
            key={row.id}
            id={row.id}
            label={row.label}
            tooltip={row.tooltip}
            icon={PLANE_ICON}
            active={active}
            onToggle={() => onRasterOverlayChange({ ...rasterOverlays, [row.id]: !active })}
          />
        )
      })}
      {SOURCES.map(source => {
        const currentMode = sourceModes[source.id] ?? 'off'
        const active = currentMode !== 'off'

        if (!source.hasEndModes) {
          return (
            <OnOffRow
              key={source.id}
              id={source.id}
              label={source.label}
              tooltip={source.tooltip}
              icon={source.icon}
              active={active}
              onToggle={() => onToggleSource(source.id)}
            />
          )
        }

        // SHM-comparable sources: icon + label + [0db] [SHM] [Diff] pills
        return (
          <div
            key={source.id}
            data-testid={`layer-${source.id}`}
            className="flex w-full items-center gap-2.5 py-1.5 px-1 rounded-lg"
          >
            <button
              onClick={() => onToggleSource(source.id)}
              title={source.tooltip}
              className="flex items-center gap-2.5 cursor-pointer hover:opacity-70 transition-opacity"
            >
              <span className={`${active ? 'text-foreground' : 'text-muted-foreground'}`}>
                {source.icon}
              </span>
              <span className={`text-sm whitespace-nowrap ${active ? 'text-foreground' : 'text-muted-foreground'}`}>
                {source.label}
              </span>
            </button>
            <span className="flex-1" />
            <span className="flex gap-0.5">
              {END_MODES.map(({ mode, label }) => {
                const isActive = active && currentMode === mode
                return (
                  <button
                    key={mode}
                    onClick={() => {
                      if (isActive) {
                        onToggleSource(source.id) // turn off
                      } else {
                        onSourceModeChange(source.id, mode)
                      }
                    }}
                    className={`px-2 py-0.5 text-[11px] rounded-md transition-colors cursor-pointer ${
                      isActive
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </span>
          </div>
        )
      })}
    </div>
  )
}
