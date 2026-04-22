import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import FloatingCard from './FloatingCard'
import { NoiseDetailContent } from './DetailPopup'
import type { NoiseComputeData } from '../types/noise'

interface DetailCardProps {
  noiseData: NoiseComputeData | null
  onNoiseClose: () => void
  onHighlight: (geometry: any | null) => void
}

export default function DetailCard({ noiseData, onNoiseClose, onHighlight }: DetailCardProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (noiseData && scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [noiseData])

  if (!noiseData) return null

  return (
    <FloatingCard className="relative p-0 max-h-[50vh] overflow-y-auto" ref={scrollRef}>
      <button
        onClick={onNoiseClose}
        className="absolute top-1 right-1.5 z-10 p-1 rounded-md hover:bg-black/5 text-muted-foreground hover:text-foreground"
        aria-label="Close"
      >
        <X className="size-3.5" />
      </button>

      <NoiseDetailContent data={noiseData} onHighlight={onHighlight} />
    </FloatingCard>
  )
}
