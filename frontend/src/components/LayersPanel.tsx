import { useState, useRef, useCallback } from 'react'
import SourceToggles from './SourceToggles'
import OverlayControls from './OverlayControls'
import SoundPathSection from './SoundPathSection'
import AdvancedSection from './AdvancedSection'
import type { RealEstateFilters } from './RealEstateLayer'
import type { SourceMode } from '../hooks/useUrlState'

interface LayersPanelProps {
  open: boolean
  onClose: () => void
  activeSources: Set<string>
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
}

export default function LayersPanel({
  open, onClose,
  activeSources, sourceModes, onToggleSource, onSourceModeChange,
  propagationFactors, onPropagationChange,
  quietClustersEnabled, onQuietClustersChange,
  quietThreshold, onQuietThresholdChange,
  realEstateFilters, onRealEstateChange,
  rasterOverlays, onRasterOverlayChange,
}: LayersPanelProps) {
  const [dismissing, setDismissing] = useState(false)
  const [dragOffset, setDragOffset] = useState(0)
  const dragRef = useRef({ startY: 0, isDragging: false })

  const handleDismiss = useCallback(() => {
    setDismissing(true)
    setDragOffset(0)
    setTimeout(() => {
      onClose()
      setDismissing(false)
    }, 300)
  }, [onClose])

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    dragRef.current = { startY: e.touches[0].clientY, isDragging: true }
  }, [])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragRef.current.isDragging) return
    const deltaY = e.touches[0].clientY - dragRef.current.startY
    if (deltaY > 0) setDragOffset(deltaY)
  }, [])

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!dragRef.current.isDragging) return
    e.preventDefault()
    e.stopPropagation()
    const deltaY = e.changedTouches[0].clientY - dragRef.current.startY
    dragRef.current.isDragging = false
    if (deltaY > 80) {
      handleDismiss()
    } else {
      setDragOffset(0)
    }
  }, [handleDismiss])

  if (!open) return null

  const transform = dismissing
    ? 'translateY(100%)'
    : dragOffset > 0
      ? `translateY(${dragOffset}px)`
      : undefined
  const transition = dragRef.current.isDragging ? 'none' : 'transform 0.3s ease-out'

  return (
    <div
      className="fixed z-[1002] bg-background shadow-xl border border-border bottom-0 left-0 right-0 max-h-[60vh] rounded-t-xl px-4 pb-3 overflow-y-auto"
      style={{ transform, transition }}
    >
      <div
        className="flex justify-center py-3 cursor-grab"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={handleDismiss}
        style={{ touchAction: 'none' }}
        role="button"
        aria-label="Drag to close"
      >
        <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
      </div>

      <SourceToggles activeSources={activeSources} sourceModes={sourceModes} onToggleSource={onToggleSource} onSourceModeChange={onSourceModeChange} />
      <div className="my-2 border-t border-border" />
      <OverlayControls
        quietClustersEnabled={quietClustersEnabled}
        onQuietClustersChange={onQuietClustersChange}
        quietThreshold={quietThreshold}
        onQuietThresholdChange={onQuietThresholdChange}
        realEstateFilters={realEstateFilters}
        onRealEstateChange={onRealEstateChange}
      />
      <div className="my-2 border-t border-border" />
      <SoundPathSection
        propagationFactors={propagationFactors}
        onPropagationChange={onPropagationChange}
      />
      <div className="my-2 border-t border-border" />
      <AdvancedSection
        rasterOverlays={rasterOverlays}
        onRasterOverlayChange={onRasterOverlayChange}
      />
    </div>
  )
}
