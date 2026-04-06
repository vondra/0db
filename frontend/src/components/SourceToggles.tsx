import { Car, TrainFront, Plane, Building2, Factory } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SourceMode } from '../hooks/useUrlState'

interface Source {
  id: string
  label: string
  tooltip: string
  icon: ReactNode
  hasShmModes: boolean
}

const SOURCES: Source[] = [
  { id: 'road', label: 'Roads', tooltip: 'Car, truck, and motorcycle traffic noise', icon: <Car className="size-4" />, hasShmModes: true },
  { id: 'railway', label: 'Railways', tooltip: 'Trains, trams, and freight lines', icon: <TrainFront className="size-4" />, hasShmModes: true },
  { id: 'aircraft', label: 'Aircraft', tooltip: 'Flight paths from ADS-B radar data', icon: <Plane className="size-4" />, hasShmModes: true },
  { id: 'building', label: 'Buildings', tooltip: 'Everyday building noise — HVAC, activity, deliveries', icon: <Building2 className="size-4" />, hasShmModes: false },
  { id: 'industrial', label: 'Industrial', tooltip: 'Factories, power plants, quarries', icon: <Factory className="size-4" />, hasShmModes: true },
]

export const ALL_SOURCE_IDS = SOURCES.map(s => s.id)

const SHM_MODES: { mode: SourceMode; label: string }[] = [
  { mode: '0db', label: '0db' },
  { mode: 'shm', label: 'SHM' },
  { mode: 'diff', label: 'Diff' },
]

interface SourceTogglesProps {
  activeSources: Set<string>
  sourceModes: Record<string, SourceMode>
  onToggleSource: (sourceId: string) => void
  onSourceModeChange: (sourceId: string, mode: SourceMode) => void
}

export default function SourceToggles({ activeSources, sourceModes, onToggleSource, onSourceModeChange }: SourceTogglesProps) {
  return (
    <div data-testid="layers-panel">
      {SOURCES.map(source => {
        const active = activeSources.has(source.id)
        const currentMode = sourceModes[source.id] ?? '0db'

        if (!source.hasShmModes) {
          // Buildings: simple on/off toggle (same as before)
          return (
            <button
              key={source.id}
              onClick={() => onToggleSource(source.id)}
              title={source.tooltip}
              data-testid={`layer-${source.id}`}
              className="flex w-full items-center gap-2.5 py-1.5 px-1 rounded-lg hover:bg-black/5 transition-colors cursor-pointer"
            >
              <span className={`${active ? 'text-foreground' : 'text-muted-foreground'}`}>
                {source.icon}
              </span>
              <span className={`flex-1 text-left text-sm ${active ? 'text-foreground' : 'text-muted-foreground'}`}>
                {source.label}
              </span>
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
              {SHM_MODES.map(({ mode, label }) => {
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
