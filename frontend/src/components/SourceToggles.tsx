import { Car, TrainFront, Plane, Building2, Factory } from 'lucide-react'
import type { ReactNode } from 'react'

interface Source {
  id: string
  label: string
  tooltip: string
  icon: ReactNode
}

const SOURCES: Source[] = [
  { id: 'road', label: 'Roads', tooltip: 'Car, truck, and motorcycle traffic noise', icon: <Car className="size-4" /> },
  { id: 'railway', label: 'Railways', tooltip: 'Trains, trams, and freight lines', icon: <TrainFront className="size-4" /> },
  { id: 'aircraft', label: 'Aircraft', tooltip: 'Flight paths from ADS-B radar data', icon: <Plane className="size-4" /> },
  { id: 'building', label: 'Buildings', tooltip: 'Everyday building noise — HVAC, activity, deliveries', icon: <Building2 className="size-4" /> },
  { id: 'industrial', label: 'Industrial', tooltip: 'Factories, power plants, quarries', icon: <Factory className="size-4" /> },
]

interface SourceTogglesProps {
  activeSources: Set<string>
  onToggleSource: (sourceId: string) => void
}

export default function SourceToggles({ activeSources, onToggleSource }: SourceTogglesProps) {
  return (
    <div data-testid="layers-panel">
      {SOURCES.map(source => {
        const active = activeSources.has(source.id)
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
      })}
    </div>
  )
}
