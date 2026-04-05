import { useState } from 'react'
import { ChevronUp, Layers3 } from 'lucide-react'
import FloatingCard from './FloatingCard'
import SourceToggles from './SourceToggles'
import OverlayControls from './OverlayControls'
import SoundPathSection from './SoundPathSection'
import type { RealEstateFilters } from './RealEstateLayer'

interface ControlCardProps {
  activeSources: Set<string>
  onToggleSource: (sourceId: string) => void
  propagationFactors: Record<string, boolean>
  onPropagationChange: (factors: Record<string, boolean>) => void
  quietClustersEnabled: boolean
  onQuietClustersChange: (enabled: boolean) => void
  quietThreshold: number
  onQuietThresholdChange: (threshold: number) => void
  realEstateFilters: RealEstateFilters
  onRealEstateChange: (filters: RealEstateFilters) => void
}

export default function ControlCard({
  activeSources, onToggleSource,
  propagationFactors, onPropagationChange,
  quietClustersEnabled, onQuietClustersChange,
  quietThreshold, onQuietThresholdChange,
  realEstateFilters, onRealEstateChange,
}: ControlCardProps) {
  const [collapsed, setCollapsed] = useState(false)

  if (collapsed) {
    return (
      <div className="hidden md:flex justify-end">
        <button
          onClick={() => setCollapsed(false)}
          title="Show layers"
          className="flex items-center justify-center w-[29px] h-[29px] rounded border border-[rgba(0,0,0,0.2)] bg-white text-muted-foreground hover:bg-[#f4f4f4] cursor-pointer"
        >
          <Layers3 className="size-[18px]" strokeWidth={2} />
        </button>
      </div>
    )
  }

  return (
    <FloatingCard className="hidden md:block p-2.5">
      <button
        onClick={() => setCollapsed(true)}
        title="Hide layers"
        className="flex items-center justify-between w-full px-1 py-0.5 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground"
      >
        <span className="text-[11px] font-medium uppercase tracking-[0.08em]">Layers</span>
        <ChevronUp className="size-3.5" />
      </button>

      <SourceToggles activeSources={activeSources} onToggleSource={onToggleSource} />

      <div className="my-1.5 border-t border-border" />

      <OverlayControls
        quietClustersEnabled={quietClustersEnabled}
        onQuietClustersChange={onQuietClustersChange}
        quietThreshold={quietThreshold}
        onQuietThresholdChange={onQuietThresholdChange}
        realEstateFilters={realEstateFilters}
        onRealEstateChange={onRealEstateChange}
      />

      <div className="my-1.5 border-t border-border" />

      <SoundPathSection
        propagationFactors={propagationFactors}
        onPropagationChange={onPropagationChange}
      />
    </FloatingCard>
  )
}
