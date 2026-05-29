// A property marker lives in a separate non-interleaved deck.gl overlay whose
// click handler cannot stop MapLibre's own click handler (DetailPopup) from
// also firing — `return true` only suppresses propagation within deck, not
// MapLibre's separate listener. So the marker click stamps this guard, and
// DetailPopup defers its open by a tick and skips when a property was just
// clicked (the deferred check runs after both synchronous handlers, so it's
// independent of which fires first).
let lastClickTs = 0

export function markPropertyClick(): void {
  lastClickTs = Date.now()
}

export function propertyJustClicked(): boolean {
  return Date.now() - lastClickTs < 50
}
