import { useState, useEffect, useRef, useCallback } from 'react'
import { NoiseDetailContent } from './DetailPopup'
import type { NoiseComputeData } from './DetailPopup'

interface MobileDetailSheetProps {
  data: NoiseComputeData | null
  onClose: () => void
  onHighlight?: (geometry: any | null) => void
}

export default function MobileDetailSheet({ data, onClose, onHighlight }: MobileDetailSheetProps) {
  const [expanded, setExpanded] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [dragOffset, setDragOffset] = useState(0)
  const dragRef = useRef({ startY: 0, isDragging: false })

  useEffect(() => {
    if (data) {
      setExpanded(true)
      setDismissing(false)
      setDragOffset(0)
    }
  }, [data])

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
      setDismissing(true)
      setDragOffset(0)
      setTimeout(onClose, 300)
    } else {
      setDragOffset(0)
    }
  }, [onClose])

  if (!data) return null

  const transform = dismissing
    ? 'translateY(100%)'
    : dragOffset > 0
      ? `translateY(${dragOffset}px)`
      : undefined
  const transition = dragRef.current.isDragging ? 'none' : 'transform 0.3s ease-out'

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[2000] md:hidden">
      <div
        data-testid="mobile-detail-sheet"
        className="bg-background rounded-t-xl shadow-2xl"
        style={{ maxHeight: expanded ? '50vh' : 'auto', transform, transition }}
      >
        <div
          className="flex justify-center py-3 cursor-grab"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onClick={() => setExpanded(!expanded)}
          style={{ touchAction: 'none' }}
          role="button"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
        </div>

        <div className={`pb-1 ${expanded ? 'overflow-y-auto' : ''}`} style={expanded ? { maxHeight: 'calc(50vh - 16px)' } : undefined}>
          <NoiseDetailContent data={data} onHighlight={onHighlight} maxSources={9} />
        </div>
      </div>
    </div>
  )
}
