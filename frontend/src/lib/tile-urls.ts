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

import { useSyncExternalStore } from 'react'

/** Sentinel before any manifest is published → legacy unversioned route. */
export const LEGACY_BUILD = 'legacy'

const BUILD_ID = /^b\d+$/
const MANIFEST_POLL_MS = 10 * 60 * 1000

let currentBuild: string = LEGACY_BUILD
const listeners = new Set<() => void>()

/** The current tile generation as React state — subscribe, snapshot, pass down. */
export function useTileBuild(): string {
  return useSyncExternalStore(subscribe, snapshot)
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function snapshot(): string {
  return currentBuild
}

/**
 * URL for one HM3 tile of `source` (a layer id or 'total') in generation
 * `build` — the caller passes the snapshot its layer was constructed with.
 * [`LEGACY_BUILD`] targets the unversioned loose-file route — the server
 * dual-serves both during the migration, so the map works with no manifest
 * published at all.
 */
export function tileUrl(build: string, source: string, z: number, x: number, y: number): string {
  return build === LEGACY_BUILD
    ? `/api/heatmap-v3/${source}/${z}/${x}/${y}.bin`
    : `/api/heatmap-v3/${build}/${source}/${z}/${x}/${y}.bin`
}

/**
 * Resolve and track the current build. Fire once (non-blocking) at app boot;
 * re-polls every 10 minutes and when the tab becomes visible again.
 *
 * A session never downgrades to legacy mode once a build is known: a published
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
    if (!res.ok) return // 404 = nothing published → stay in the current mode
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
    // Network hiccup — keep the current mode; the next poll retries.
  }
}
