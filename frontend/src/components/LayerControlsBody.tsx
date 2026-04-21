import SourceToggles from './SourceToggles'
import OverlayControls from './OverlayControls'
import SoundPathSection from './SoundPathSection'
import AdvancedSection from './AdvancedSection'
import type { RealEstateFilters } from './RealEstateLayer'
import type { SourceMode } from '../hooks/useUrlState'

export interface LayerControlsBodyProps {
  sourceModes: Record<string, SourceMode>
  onToggleSource: (sourceId: string) => void
  onSourceModeChange: (sourceId: string, mode: SourceMode) => void
  propagationFactors: Record<string, boolean>
  onPropagationChange: (factors: Record<string, boolean>) => void
  quietClustersEnabled: boolean
  onQuietClustersChange: (enabled: boolean) => void
  quietThreshold: number
  onQuietThresholdChange: (threshold: number) => void
  realEstateFilters: RealEstateFilters
  onRealEstateChange: (filters: RealEstateFilters) => void
  rasterOverlays: Record<string, boolean>
  onRasterOverlayChange: (overlays: Record<string, boolean>) => void
  dividerSpacing?: 'compact' | 'comfortable'
}

/**
 * Shared body for the layer controls panel — rendered inside both the desktop
 * floating ControlCard and the mobile bottom-sheet LayersPanel. Only the shell
 * (header, dismiss affordance, animation, visibility media query) differs.
 */
export default function LayerControlsBody({
  sourceModes, onToggleSource, onSourceModeChange,
  propagationFactors, onPropagationChange,
  quietClustersEnabled, onQuietClustersChange,
  quietThreshold, onQuietThresholdChange,
  realEstateFilters, onRealEstateChange,
  rasterOverlays, onRasterOverlayChange,
  dividerSpacing = 'compact',
}: LayerControlsBodyProps) {
  const divClass = dividerSpacing === 'compact'
    ? 'my-1.5 border-t border-border'
    : 'my-2 border-t border-border'

  return (
    <>
      <SourceToggles sourceModes={sourceModes} onToggleSource={onToggleSource} onSourceModeChange={onSourceModeChange} />

      <div className={divClass} />

      <OverlayControls
        quietClustersEnabled={quietClustersEnabled}
        onQuietClustersChange={onQuietClustersChange}
        quietThreshold={quietThreshold}
        onQuietThresholdChange={onQuietThresholdChange}
        realEstateFilters={realEstateFilters}
        onRealEstateChange={onRealEstateChange}
      />

      <div className={divClass} />

      <SoundPathSection
        propagationFactors={propagationFactors}
        onPropagationChange={onPropagationChange}
      />

      <div className={divClass} />

      <AdvancedSection
        rasterOverlays={rasterOverlays}
        onRasterOverlayChange={onRasterOverlayChange}
      />
    </>
  )
}
