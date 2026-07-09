// Versioned heatmap-tile URLs — tracks the published pmtiles generation
// ("build") from /api/tiles-manifest.
//
// GENERATION-SNAPSHOT CONTRACT (dual-model review consensus, 2026-07-08): the
// build is delivered to components ONLY as a subscribed snapshot
// (`useTileBuild`) and passed EXPLICITLY into `tileUrl` — never read from
// module state inside a fetch closure. Every deck.gl layer id / tile cache is
// therefore keyed by exactly the generation it was constructed for: a
// mid-session flip re-renders (store notification) and re-keys the layers,
// instead of old layer instances silently fetching new-build tiles into their
// old caches (mixed generations on one screen).
//
// No published build (the ~50 ms before the manifest resolves, or a fresh
// checkout that never packed) = `null` = the tile layers simply don't mount.
// There is deliberately NO legacy-URL fallback — the loose-file route is gone.

import { useSyncExternalStore } from 'react'

// The published tile world's zoom band — ONE source for every component
// (mirrors server heatmap-shared.ts and what the packer writes). Base level
// z12: 512-px tiles carrying the old z13-pixel lattice; EVERY layer pyramids
// down to z2 — a single-layer view at world zoom is a first-class use case
// (deck's TileLayer renders NOTHING below its minZoom, so a deeper floor
// blanked e.g. roads-only at z4 — owner report 2026-07-09).
export const BASE_ZOOM = 12
export const MIN_ZOOM = 2

const BUILD_ID = /^b\d+$/
const MANIFEST_POLL_MS = 10 * 60 * 1000

let currentBuild: string | null = null
const listeners = new Set<() => void>()

/** The current tile generation, or `null` before any manifest resolves —
 *  subscribe, snapshot, pass down; render no tile layers while `null`. */
export function useTileBuild(): string | null {
  return useSyncExternalStore(subscribe, snapshot)
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function snapshot(): string | null {
  return currentBuild
}

/**
 * URL for one HM3 tile of `source` (a layer id or 'total') in generation
 * `build` — the caller passes the snapshot its layer was constructed with.
 */
export function tileUrl(build: string, source: string, z: number, x: number, y: number): string {
  return `/api/tiles/${build}/${source}/${z}/${x}/${y}.bin`
}

/**
 * Resolve and track the current build. Fire once (non-blocking) at app boot;
 * re-polls every 10 minutes and when the tab becomes visible again.
 *
 * A session never downgrades to `null` once a build is known: a published
 * generation is immutable and stays servable, so a later manifest 404/error
 * keeps the last known build.
 */
export async function initTileBuild(): Promise<void> {
  if (pollingStarted) return
  pollingStarted = true
  setInterval(() => void refreshTileBuild(), MANIFEST_POLL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshTileBuild()
  })
  await refreshTileBuild()
}

let pollingStarted = false

async function refreshTileBuild(): Promise<void> {
  try {
    const res = await fetch('/api/tiles-manifest', { cache: 'no-cache' })
    if (!res.ok) return // nothing published yet → stay as-is
    const manifest = (await res.json()) as { build?: unknown }
    if (
      typeof manifest.build === 'string' &&
      BUILD_ID.test(manifest.build) &&
      manifest.build !== currentBuild
    ) {
      currentBuild = manifest.build
      for (const cb of listeners) cb()
    }
  } catch {
    // Network hiccup — keep the current build; the next poll retries.
  }
}
