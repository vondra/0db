// Shared tile-URL + per-layer-build helpers for the plain-Node scripts
// (warm-tile-cache.mjs, scripts/world/verify-tiles.mjs). The frontend keeps
// its own deliberately-mirrored copy (frontend/src/lib/tile-urls.ts) across
// the browser/Node bundle boundary — same convention as validate-manifest's
// ALLOWED_LAYERS; THIS file is the one canonical copy on the scripts side.

export const BUILD_ID = /^b\d+$/
const FILE_BUILD = /\.(b\d+)\.pmtiles$/

/** One tile's public URL — the only place scripts spell the route shape. */
export function tileUrl(base, build, layer, z, x, y) {
  return `${base}/api/tiles/${build}/${layer}/${z}/${x}/${y}.bin`
}

/** A layer's own immutable build. Legacy manifests omit `entry.build`, so the archive filename
 * is authoritative. When both exist they must agree; malformed or contradictory entries fail
 * closed instead of silently falling back to the top-level merge-head build. `layer` is optional
 * only for legacy callers that already obtained the entry from a trusted manifest map. */
export function layerBuild(entry, manifestBuild, layer = null) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  let fromFile = null
  if (typeof entry.file === 'string') {
    if (layer != null) {
      const prefix = `${layer}.`
      if (entry.file.startsWith(prefix) && entry.file.endsWith('.pmtiles')) {
        const candidate = entry.file.slice(prefix.length, -'.pmtiles'.length)
        if (BUILD_ID.test(candidate)) fromFile = candidate
      }
    } else {
      fromFile = FILE_BUILD.exec(entry.file)?.[1] ?? null
    }
  }
  if (entry.build !== undefined) {
    if (typeof entry.build !== 'string' || !BUILD_ID.test(entry.build)) return null
    if (fromFile != null && entry.build !== fromFile) return null
    if (layer != null && fromFile == null) return null
    return entry.build
  }
  if (fromFile != null) return fromFile
  return layer == null && typeof manifestBuild === 'string' && BUILD_ID.test(manifestBuild)
    ? manifestBuild : null
}

/** Strict present/valid shape used by goal reconciliation and verification. */
export function manifestLayerBuild(manifest, layer) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || !manifest.layers || typeof manifest.layers !== 'object'
      || Array.isArray(manifest.layers)) {
    return { valid: false, present: false, build: null }
  }
  const entry = manifest.layers[layer]
  if (entry == null) return { valid: true, present: false, build: null }
  const build = layerBuild(entry, manifest.build, layer)
  return { valid: build != null, present: true, build }
}

/** Clone a manifest with every valid legacy layer build made explicit. */
export function manifestWithResolvedLayerBuilds(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return manifest
  const layers = {}
  for (const [layer, entry] of Object.entries(manifest.layers ?? {})) {
    const build = layerBuild(entry, manifest.build, layer)
    layers[layer] = build == null ? entry : { ...entry, build }
  }
  return { ...manifest, layers }
}
