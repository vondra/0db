import { useState } from 'react'
import { ChevronDown, Mountain, Building, TreePine, Shield, Plane } from 'lucide-react'

// Three aircraft heatmap layers — each ships as its own HM3 tile tree
// under `data/tiles/{year}/heatmap-v3/{id}/…` and is rendered by a
// dedicated `HeatmapV3Layer`. They were one combined raster before;
// users asked to see them separately so a quiet cruise overflight
// doesn't drown out a busy taxi run in the visualisation.
const OVERLAYS = [
  { id: 'aircraft-ground',   label: 'Aircraft — ground ops', tooltip: 'Taxi + runway roll + apron movements (LKPR-class noise)', icon: <Plane className="size-3.5" /> },
  { id: 'aircraft-airborne', label: 'Aircraft — airborne',   tooltip: 'Sub-cruise traffic: climb / approach / departure within ~3000 m AGL', icon: <Plane className="size-3.5" /> },
  { id: 'aircraft-cruise',   label: 'Aircraft — cruise',     tooltip: 'High-altitude overflight (FL100+), bands across the country', icon: <Plane className="size-3.5" /> },
  { id: 'dem', label: 'Elevation', tooltip: 'DEM terrain elevation — hills, valleys, ridges (30m)', icon: <Mountain className="size-3.5" /> },
  { id: 'building', label: 'Buildings', tooltip: 'Building heights from Overture Maps (30m)', icon: <Building className="size-3.5" /> },
  { id: 'forest', label: 'Forest', tooltip: 'Forest cover from ESA WorldCover (30m)', icon: <TreePine className="size-3.5" /> },
  { id: 'barriers', label: 'Noise barriers', tooltip: 'Noise barriers from OSM (walls blocking sound propagation)', icon: <Shield className="size-3.5" /> },
]

interface AdvancedSectionProps {
  rasterOverlays: Record<string, boolean>
  onRasterOverlayChange: (overlays: Record<string, boolean>) => void
}

export default function AdvancedSection({ rasterOverlays, onRasterOverlayChange }: AdvancedSectionProps) {
  const [open, setOpen] = useState(() => OVERLAYS.some(o => rasterOverlays[o.id]))

  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        title="Toggle raster data overlays — see what feeds the noise computation"
        className="flex w-full items-center gap-2.5 py-1.5 px-1 rounded-lg hover:bg-black/5 transition-colors cursor-pointer text-muted-foreground hover:text-foreground"
      >
        <span className="flex-1 text-left text-[11px] font-medium uppercase tracking-[0.08em]">
          Advanced
        </span>
        <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="ml-1 space-y-0.5 pb-1">
          {OVERLAYS.map(overlay => {
            const active = rasterOverlays[overlay.id] ?? false
            return (
              <button
                key={overlay.id}
                onClick={() => onRasterOverlayChange({ ...rasterOverlays, [overlay.id]: !active })}
                title={overlay.tooltip}
                className="flex w-full items-center gap-2 py-1 px-1 rounded-lg hover:bg-black/5 transition-colors cursor-pointer"
              >
                <span className={active ? 'text-foreground' : 'text-muted-foreground'}>{overlay.icon}</span>
                <span className={`flex-1 text-left text-xs ${active ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {overlay.label}
                </span>
                <span className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                  active ? 'bg-primary' : 'bg-muted-foreground/20'
                }`}>
                  <span className={`inline-block size-3 rounded-full bg-white shadow-sm transition-transform ${
                    active ? 'translate-x-[14px]' : 'translate-x-[2px]'
                  }`} />
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
