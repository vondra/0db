import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ReactNode } from "react"
import { createPortal } from "react-dom"

import { cn } from "@/lib/utils"

/**
 * HoverText — minimal monospace tooltip with portal escape and viewport clamping.
 *
 * Renders inline trigger (cursor-help + dotted underline). On hover (desktop)
 * or tap (touch) opens a small dark popup containing `title` rendered as
 * `<pre className="font-mono">` so column-aligned tables (padded with spaces
 * and box-drawing separators) line up perfectly.
 *
 * Position: prefers above the trigger, centred horizontally. After mount the
 * popup is measured with `useLayoutEffect` and clamped to the viewport
 * (horizontal: shift to fit; vertical: flip below if no room above).
 *
 * Touch: tap to toggle, tap outside to dismiss. Desktop: hover to open,
 * mouse-leave with small delay to close. ESC also dismisses.
 */
export function HoverText({
  title,
  children,
  className,
}: {
  title: string
  children: ReactNode
  className?: string
}) {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean } | null>(null)
  const closeTimer = useRef<number | null>(null)

  const show = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    // Render off-screen first; useLayoutEffect will measure and place it.
    setPos({ left: -9999, top: -9999, ready: false })
    setOpen(true)
  }, [])

  const scheduleHide = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => {
      setOpen(false)
      setPos(null)
      closeTimer.current = null
    }, 120)
  }, [])

  // Measure tooltip after first render, place it correctly inside viewport.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !tooltipRef.current) return
    const trigger = triggerRef.current.getBoundingClientRect()
    const tip = tooltipRef.current.getBoundingClientRect()
    const pad = 8

    // Horizontal: centre on trigger, clamp to viewport.
    let left = trigger.left + trigger.width / 2 - tip.width / 2
    left = Math.max(pad, Math.min(left, window.innerWidth - tip.width - pad))

    // Vertical: prefer above, flip below if no room.
    let top = trigger.top - tip.height - pad
    if (top < pad) top = trigger.bottom + pad
    // If still off bottom (very tall tooltip on small viewport), clamp to top.
    if (top + tip.height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - tip.height - pad)
    }

    setPos({ left, top, ready: true })
  }, [open])

  // Tap outside / Esc dismiss
  useEffect(() => {
    if (!open) return
    function onPointer(e: PointerEvent) {
      if (triggerRef.current?.contains(e.target as Node)) return
      if (tooltipRef.current?.contains(e.target as Node)) return
      setOpen(false)
      setPos(null)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false)
        setPos(null)
      }
    }
    document.addEventListener("pointerdown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  // Reposition on scroll / resize while open
  useEffect(() => {
    if (!open) return
    const handler = () => {
      if (!triggerRef.current || !tooltipRef.current) return
      const trigger = triggerRef.current.getBoundingClientRect()
      const tip = tooltipRef.current.getBoundingClientRect()
      const pad = 8
      let left = trigger.left + trigger.width / 2 - tip.width / 2
      left = Math.max(pad, Math.min(left, window.innerWidth - tip.width - pad))
      let top = trigger.top - tip.height - pad
      if (top < pad) top = trigger.bottom + pad
      if (top + tip.height > window.innerHeight - pad) {
        top = Math.max(pad, window.innerHeight - tip.height - pad)
      }
      setPos({ left, top, ready: true })
    }
    window.addEventListener("scroll", handler, true)
    window.addEventListener("resize", handler)
    return () => {
      window.removeEventListener("scroll", handler, true)
      window.removeEventListener("resize", handler)
    }
  }, [open])

  return (
    <>
      <span
        ref={triggerRef}
        className={cn(
          "cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2",
          className,
        )}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        onClick={(e) => {
          e.stopPropagation()
          if (open) {
            setOpen(false)
            setPos(null)
          } else {
            show()
          }
        }}
      >
        {children}
      </span>
      {open && pos && createPortal(
        <div
          ref={tooltipRef}
          role="tooltip"
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            zIndex: 9999,
            pointerEvents: "none",
            opacity: pos.ready ? 1 : 0,
            // 28rem (~448px) fits all column-aligned tables (≤40 chars at 11 px
            // monospace ≈ 280 px) AND forces long single-sentence descriptions
            // to wrap at word boundaries.
            maxWidth: "min(28rem, calc(100vw - 16px))",
            maxHeight: `calc(100vh - 16px)`,
            overflow: "auto",
          }}
          className="rounded-md bg-zinc-900/95 text-zinc-50 border border-zinc-700/60 shadow-xl px-3 py-2"
        >
          <pre className="font-mono text-[11px] leading-snug m-0" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{title}</pre>
        </div>,
        document.body,
      )}
    </>
  )
}
// rebuild 1775942220
// rebuild 1775942403
// 399110800
