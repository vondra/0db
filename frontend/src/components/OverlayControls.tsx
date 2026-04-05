import { useState, useEffect, useRef } from 'react'
import { TreePine } from 'lucide-react'

interface OverlayControlsProps {
  quietClustersEnabled: boolean
  onQuietClustersChange: (enabled: boolean) => void
  quietThreshold: number
  onQuietThresholdChange: (threshold: number) => void
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
      <input
        type="range"
        data-testid={testId}
        value={local}
        onChange={(e) => setLocal(parseInt(e.target.value, 10))}
        min={min}
        max={max}
        className="flex-1 h-1 accent-primary cursor-pointer"
      />
      <span className="text-[11px] text-muted-foreground tabular-nums w-10 text-right">{local} dB</span>
    </div>
  )
}

export default function OverlayControls({
  quietClustersEnabled, onQuietClustersChange,
  quietThreshold, onQuietThresholdChange,
}: OverlayControlsProps) {
  return (
    <div>
      <button
        onClick={() => onQuietClustersChange(!quietClustersEnabled)}
        title="Highlight contiguous areas where noise stays below a threshold"
        className="flex w-full items-center gap-2.5 py-1.5 px-1 rounded-lg hover:bg-black/5 transition-colors cursor-pointer"
      >
        <span className={quietClustersEnabled ? 'text-foreground' : 'text-muted-foreground'}>
          <TreePine className="size-4" />
        </span>
        <span className={`flex-1 text-left text-sm ${quietClustersEnabled ? 'text-foreground' : 'text-muted-foreground'}`}>
          Quiet zones
        </span>
        <span className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          quietClustersEnabled ? 'bg-primary' : 'bg-muted-foreground/20'
        }`}>
          <span className={`inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform ${
            quietClustersEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
          }`} />
        </span>
      </button>
      {quietClustersEnabled && (
        <NoiseSlider value={quietThreshold} onChange={onQuietThresholdChange} min={15} max={45} testId="quiet-threshold" />
      )}
    </div>
  )
}
