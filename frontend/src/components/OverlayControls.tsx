import { useState, useEffect, useRef } from 'react'
import { TreePine, Home } from 'lucide-react'
import type { RealEstateFilters } from './RealEstateLayer'

interface OverlayControlsProps {
  quietClustersEnabled: boolean
  onQuietClustersChange: (enabled: boolean) => void
  quietThreshold: number
  onQuietThresholdChange: (threshold: number) => void
  realEstateFilters: RealEstateFilters
  onRealEstateChange: (filters: RealEstateFilters) => void
}

function ToggleRow({ active, icon, label, tooltip, onClick }: {
  active: boolean; icon: React.ReactNode; label: string; tooltip: string; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={tooltip}
      className="flex w-full items-center gap-2.5 py-1.5 px-1 rounded-lg hover:bg-black/5 transition-colors cursor-pointer"
    >
      <span className={active ? 'text-foreground' : 'text-muted-foreground'}>{icon}</span>
      <span className={`flex-1 text-left text-sm ${active ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</span>
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

function NoiseSlider({ value, onChange, min, max, testId }: {
  value: number; onChange: (v: number) => void; min: number; max: number; testId: string
}) {
  const [local, setLocal] = useState(value)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  useEffect(() => { setLocal(value) }, [value])
  useEffect(() => {
    if (local === value) return
    const t = setTimeout(() => onChangeRef.current(local), 300)
    return () => clearTimeout(t)
  }, [local, value])
  return (
    <div className="flex items-center gap-2 ml-7 mt-0.5 mb-1">
      <span className="text-[11px] text-muted-foreground shrink-0">below</span>
      <input type="range" data-testid={testId} value={local}
        onChange={(e) => setLocal(parseInt(e.target.value, 10))} min={min} max={max}
        className="flex-1 h-1 accent-primary cursor-pointer" />
      <span className="text-[11px] text-muted-foreground tabular-nums w-10 text-right">{local} dB</span>
    </div>
  )
}

export default function OverlayControls({
  quietClustersEnabled, onQuietClustersChange,
  quietThreshold, onQuietThresholdChange,
  realEstateFilters: f, onRealEstateChange,
}: OverlayControlsProps) {
  return (
    <div>
      <ToggleRow
        active={quietClustersEnabled}
        icon={<TreePine className="size-4" />}
        label="Quiet zones"
        tooltip="Highlight areas where total noise (all sources) stays below a threshold"
        onClick={() => onQuietClustersChange(!quietClustersEnabled)}
      />
      {quietClustersEnabled && (
        <NoiseSlider value={quietThreshold} onChange={onQuietThresholdChange} min={40} max={65} testId="quiet-threshold" />
      )}

      <ToggleRow
        active={f.enabled}
        icon={<Home className="size-4" />}
        label="Properties"
        tooltip="Show properties for sale/rent with noise levels"
        onClick={() => onRealEstateChange({ ...f, enabled: !f.enabled })}
      />
      {f.enabled && (
        <div className="ml-7 mt-0.5 mb-1 space-y-1.5">
          <div className="flex gap-1">
            {(['all', 'land', 'house'] as const).map(t => (
              <button key={t} onClick={() => onRealEstateChange({ ...f, propertyType: t })}
                className={`px-2 py-0.5 text-[11px] rounded-md transition-colors ${
                  f.propertyType === t ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent'
                }`}>{t === 'all' ? 'All' : t === 'land' ? 'Land' : 'Houses'}</button>
            ))}
            <span className="mx-1 border-l border-border" />
            {(['buy', 'rent'] as const).map(t => (
              <button key={t} onClick={() => onRealEstateChange({ ...f, listingType: f.listingType === t ? 'all' : t })}
                className={`px-2 py-0.5 text-[11px] rounded-md transition-colors ${
                  f.listingType === t ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent'
                }`}>{t === 'buy' ? 'Buy' : 'Rent'}</button>
            ))}
          </div>
          <NoiseSlider value={f.maxNoise} onChange={(v) => onRealEstateChange({ ...f, maxNoise: v })} min={20} max={45} testId="max-noise" />
        </div>
      )}
    </div>
  )
}
