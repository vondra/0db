// Shared tile-URL + per-layer-build helpers for the plain-Node scripts
// (warm-tile-cache.mjs, scripts/world/verify-tiles.mjs). The frontend keeps
// its own deliberately-mirrored copy (frontend/src/lib/tile-urls.ts) across
// the browser/Node bundle boundary — same convention as validate-manifest's
// ALLOWED_LAYERS; THIS file is the one canonical copy on the scripts side.

const BUILD_ID = /^b\d+$/
const FILE_BUILD = /\.(b\d+)\.pmtiles$/

/** One tile's public URL — the only place scripts spell the route shape. */
export function tileUrl(base, build, layer, z, x, y) {
  return `${base}/api/tiles/${build}/${layer}/${z}/${x}/${y}.bin`
}

/** A layer's OWN build, mirroring the frontend's resolution (tile-urls.ts):
 *  the manifest entry's build field, else recovered from the archive
 *  filename (pre-partial-pack manifests lack the field), else the
 *  manifest-level build. */
export function layerBuild(entry, manifestBuild) {
  if (typeof entry.build === 'string' && BUILD_ID.test(entry.build)) return entry.build
  const fromFile = typeof entry.file === 'string' ? FILE_BUILD.exec(entry.file)?.[1] : undefined
  return fromFile ?? manifestBuild
}
