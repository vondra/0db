import { X } from 'lucide-react'
import FloatingCard from './FloatingCard'
import { NoiseDetailContent } from './DetailPopup'
import type { NoiseComputeData } from './DetailPopup'

interface DetailCardProps {
  noiseData: NoiseComputeData | null
  onNoiseClose: () => void
  onHighlight: (geometry: any | null) => void
}

export default function DetailCard({ noiseData, onNoiseClose, onHighlight }: DetailCardProps) {
  if (!noiseData) return null

  return (
    <FloatingCard className="relative p-0 max-h-[50vh] overflow-y-auto">
      <button
        onClick={onNoiseClose}
        className="absolute top-2 right-2 z-10 p-1 rounded-lg hover:bg-black/5 text-muted-foreground hover:text-foreground"
        aria-label="Close"
      >
        <X className="size-4" />
      </button>

      <NoiseDetailContent data={noiseData} onHighlight={onHighlight} />
    </FloatingCard>
  )
}
