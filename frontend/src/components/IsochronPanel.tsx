import { useState } from 'react'
import { Radar } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface IsochronRequest {
  lat: number
  lng: number
  time: number
  modes: string[]
}

interface IsochronPanelProps {
  location: { lat: number; lng: number } | null
  onGo: (request: IsochronRequest) => void
  active: boolean
}

export default function IsochronPanel({ location, onGo, active }: IsochronPanelProps) {
  const [walk, setWalk] = useState(true)
  const [car, setCar] = useState(true)
  const [time, setTime] = useState(60)

  const handleGo = () => {
    if (!location) return
    const modes = []
    if (walk) modes.push('walk')
    if (car) modes.push('car')
    if (modes.length === 0) return
    onGo({ lat: location.lat, lng: location.lng, time, modes })
  }

  if (!active) return null

  return (
    <div className="
      fixed z-[1003] bg-background rounded-lg shadow-xl border border-border px-3 py-2.5
      left-[calc(50%-50vw+0.75rem)] right-[calc(50%-50vw+0.75rem)] top-[58px]
      md:left-1/2 md:-translate-x-1/2 md:right-auto md:top-[58px] md:w-[calc(100%-1.5rem)] md:max-w-md
    ">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-foreground whitespace-nowrap">Reachable in</span>
        <input
          type="number"
          value={time}
          onChange={(e) => setTime(parseInt(e.target.value, 10) || 0)}
          min={1}
          max={120}
          className="w-14 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground text-center focus:border-ring focus:outline-none focus:ring-0"
        />
        <span className="text-muted-foreground">min</span>
        {/* Group modes + action so they wrap together (right-aligned) on narrow screens. */}
        <div className="flex items-center gap-2 ml-auto">
          <Button type="button" variant={walk ? 'secondary' : 'outline'} size="xs" onClick={() => setWalk(!walk)} className={walk ? '' : 'text-muted-foreground'}>Walk</Button>
          <Button type="button" variant={car ? 'secondary' : 'outline'} size="xs" onClick={() => setCar(!car)} className={car ? '' : 'text-muted-foreground'}>Car</Button>
          <Button variant="default" size="xs" onClick={handleGo} disabled={!location || (!walk && !car)}><Radar />Show area</Button>
        </div>
      </div>
      {!location && <div className="text-xs text-muted-foreground mt-1">Search for a location first</div>}
    </div>
  )
}
