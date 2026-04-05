interface FloatingCardProps {
  children: React.ReactNode
  className?: string
}

export default function FloatingCard({ children, className = '' }: FloatingCardProps) {
  return (
    <div data-side-panel className={`rounded-md bg-white/95 backdrop-blur-md shadow-lg border border-black/5 ${className}`}>
      {children}
    </div>
  )
}
