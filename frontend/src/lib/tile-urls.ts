// Versioned heatmap-tile URLs — tracks the published pmtiles generation
// ("build") from /api/tiles-manifest and builds every HM3 tile URL from it.

let currentBuild: string | null = null

const BUILD_ID = /^b\d+$/
const MANIFEST_POLL_MS = 10 * 60 * 1000

/**
 * URL for one HM3 tile of `source` (a layer id or 'total'): the versioned
 * archive route `/api/heatmap-v3/{build}/…` once a build is known, else the
 * legacy unversioned loose-file route — the server dual-serves both during
 * the migration, so the map works with no manifest published at all.
 */
export function tileUrl(source: string, z: number, x: number, y: number): string {
  return currentBuild === null
    ? `/api/heatmap-v3/${source}/${z}/${x}/${y}.bin`
    : `/api/heatmap-v3/${currentBuild}/${source}/${z}/${x}/${y}.bin`
}

/**
 * Generation token for deck.gl layer ids (`"b0"`, or `"legacy"` before a
 * manifest lands). deck.gl matches layers by `id` across renders and carries
 * the matched instance's tile cache over — with an unchanged id, a build flip
 * would keep serving the old generation from that cache even though tileUrl()
 * already points at the new one. Baking this token into every tile-layer id
 * (and tile-cache key) re-keys the layer on a flip, dropping the cache and
 * forcing a refetch.
 */
export function tileBuildKey(): string {
  return currentBuild ?? 'legacy'
}

/**
 * Resolve and track the current build. Fire once (non-blocking) at app boot;
 * re-polls every 10 minutes and when the tab becomes visible again.
 *
 * Semantics: ONE generation per session-refresh. The build resolved at boot
 * serves the whole session; if a newer build is published mid-session, only
 * module state updates — layers pick it up whenever they next rebuild (their
 * id re-keys via tileBuildKey()), typically on the next reload. A session
 * never downgrades to legacy mode once a build is known: a published
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
    if (typeof manifest.build === 'string' && BUILD_ID.test(manifest.build)) {
      currentBuild = manifest.build
    }
  } catch {
    // Network hiccup — keep the current mode; the next poll retries.
  }
}
