import { BASEMAPS, type BasemapId } from '../utils/basemaps'

const ICONS: Record<BasemapId, React.ReactNode> = {
  standard: (
    <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </svg>
  ),
  terrain: (
    <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 19l5-10 4 6 3-8 8 12H2z" />
    </svg>
  ),
  satellite: (
    <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3c-2.5 3-4 6.5-4 9s1.5 6 4 9M12 3c2.5 3 4 6.5 4 9s-1.5 6-4 9M3 12h18" />
    </svg>
  ),
}

const BTN = 'flex items-center justify-center w-[29px] h-[29px] cursor-pointer'

interface BasemapBarProps {
  basemap: BasemapId
  onBasemapChange: (id: BasemapId) => void
}

export default function BasemapBar({ basemap, onBasemapChange }: BasemapBarProps) {
  return (
    <>
      {/* Desktop: vertical column, bottom-left */}
      <div className="hidden md:flex flex-col items-start fixed bottom-[110px] left-[10px] z-[1002]">
        <div className="rounded bg-white overflow-hidden" style={{ boxShadow: '0 0 0 2px rgba(0,0,0,.1)' }}>
          {BASEMAPS.map((b, i) => (
            <button
              key={b.id}
              onClick={() => onBasemapChange(b.id)}
              title={b.label}
              className={`${BTN} transition-colors ${
                basemap === b.id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-[#333] hover:bg-[#f2f2f2]'
              } ${i > 0 ? 'border-t border-[rgba(0,0,0,0.1)]' : ''}`}
            >
              {ICONS[b.id]}
            </button>
          ))}
        </div>
      </div>

      {/* Mobile: horizontal row, bottom-left */}
      <div className="flex md:hidden fixed bottom-[16px] left-[10px] z-[1002] rounded-lg bg-white overflow-hidden" style={{ boxShadow: '0 0 0 2px rgba(0,0,0,.1)' }}>
        {BASEMAPS.map((b, i) => (
          <button
            key={b.id}
            onClick={() => onBasemapChange(b.id)}
            title={b.label}
            className={`${BTN} transition-colors ${
              basemap === b.id
                ? 'bg-primary text-primary-foreground'
                : 'text-[#333] hover:bg-[#f2f2f2]'
            } ${i > 0 ? 'border-l border-[rgba(0,0,0,0.1)]' : ''}`}
          >
            {ICONS[b.id]}
          </button>
        ))}
      </div>
    </>
  )
}
