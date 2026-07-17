/**
 * Per-hex country resolution for enrichment WRITERS (service-tree national
 * vehicle mix / trip rates).
 *
 * h3r4-admin.bin assigns one country per ~22 km res-4 hex by centroid — fine
 * for diagnostics, forbidden for traffic-data writes at borders (a Czech road
 * in the Hlučínsko salient got Polish AADT that way; see country-polygon.ts).
 * The split here: INTERIOR hexes (every k=1 neighbour agrees) take the cheap
 * admin-bin answer; BORDER hexes refine each query point through the CGAZ
 * polygon gates of the candidate countries seen in the neighbourhood.
 *
 * Construction fails loud when the admin bin is missing/empty
 * (requireAdminIso) — a silent WORLD fallback across a whole extract is the
 * exact failure the 2026-07 /gg review caught.
 */

import { cellToBoundary, gridDisk } from 'h3-js'
import { requireAdminIso } from './admin-iso.js'
import { allCountryPolygonBboxes, hasCountryPolygon, makeCountryGate } from './country-polygon.js'

export interface HexCountryResolver {
  /** admin-bin ISO2 of the hex itself (undefined when the bin has no row —
   *  ocean/unassigned hexes). */
  hexIso(hexId: string): string | undefined
  /** True when any k=1 neighbour present in the admin bin carries a different
   *  country — the hex may straddle a border. */
  isBorderHex(hexId: string): boolean
  /** Country at a point: the hex ISO for interior hexes; for border hexes the
   *  first CGAZ candidate polygon containing the point (own country tested
   *  first — the majority case), falling back to the hex ISO for points no
   *  candidate claims (offshore/reclaimed-land coastal roads). */
  isoAt(hexId: string, lat: number, lon: number): string | undefined
}

export function createHexCountryResolver(adminBinPath: string): HexCountryResolver {
  const adminIso = requireAdminIso(adminBinPath)

  // Lazy per-ISO gates: CGAZ parse + ring indexing is paid once per process,
  // and only when a border hex is actually encountered. `null` = territory
  // without a CGAZ polygon (HK/PR/…) — cheap pre-check keeps I/O errors loud.
  const gates = new Map<string, ((lat: number, lon: number) => boolean) | null>()
  function gateFor(iso: string): ((lat: number, lon: number) => boolean) | null {
    let gate = gates.get(iso)
    if (gate === undefined) {
      gate = hasCountryPolygon(iso) ? makeCountryGate(iso) : null
      gates.set(iso, gate)
    }
    return gate
  }

  // Countries whose ENTIRE polygon part fits inside the hex neighbourhood —
  // microstates and enclaves (SG/MC/SM/VA/LI) have no res-4 centroid of their
  // own, so the admin bin can never nominate them; their whole CGAZ part
  // sitting inside the padded hex box is exactly the "country smaller than
  // the neighbourhood" signature (/gg diff review). Large countries never
  // qualify: their parts exceed any single-hex neighbourhood.
  function containedMicrostates(hexId: string): string[] {
    const boundary = cellToBoundary(hexId) // [[lat, lon], …]
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity
    for (const [lat, lon] of boundary) {
      if (lat < s) s = lat
      if (lat > n) n = lat
      if (lon < w) w = lon
      if (lon > e) e = lon
    }
    const PAD_DEG = 0.3 // ≈ one k-ring of slop around the ~22 km hex
    const out: string[] = []
    for (const [iso, parts] of Object.entries(allCountryPolygonBboxes())) {
      for (const [ps, pw, pn, pe] of parts) {
        if (ps >= s - PAD_DEG && pn <= n + PAD_DEG && pw >= w - PAD_DEG && pe <= e + PAD_DEG) {
          out.push(iso)
          break
        }
      }
    }
    return out
  }

  // Border status + neighbour-country candidates, cached per hex (each hex is
  // queried once per segment otherwise).
  const borderInfo = new Map<string, { border: boolean; candidates: string[] }>()
  function infoFor(hexId: string): { border: boolean; candidates: string[] } {
    let info = borderInfo.get(hexId)
    if (info === undefined) {
      const own = adminIso.get(hexId)
      const seen = new Set<string>()
      for (const neighbour of gridDisk(hexId, 1)) {
        const iso = adminIso.get(neighbour)
        if (iso !== undefined) seen.add(iso)
      }
      for (const iso of containedMicrostates(hexId)) seen.add(iso)
      const foreign = [...seen].filter((iso) => iso !== own)
      // Own country first: the majority of a border hex's segments are inside it.
      const candidates = own !== undefined ? [own, ...foreign] : foreign
      info = { border: foreign.length > 0, candidates }
      borderInfo.set(hexId, info)
    }
    return info
  }

  return {
    hexIso: (hexId) => adminIso.get(hexId),
    isBorderHex: (hexId) => infoFor(hexId).border,
    isoAt(hexId, lat, lon) {
      const info = infoFor(hexId)
      if (!info.border) return adminIso.get(hexId)
      for (const iso of info.candidates) {
        const gate = gateFor(iso)
        if (gate !== null && gate(lat, lon)) return iso
      }
      // No polygon claims the point — coastal roads sit metres outside the
      // 55 m-simplified CGAZ coastline (piers, mangrove roads, reclaimed
      // land). They belong to the neighbourhood's dominant country, not to
      // WORLD: falling back to the hex's own admin ISO returned undefined on
      // coastal hexes whose centroid is over water, which silently gave a
      // fifth of Krabi's segments the 1 % WORLD moto split (world sweep
      // spot-check 2026-07-17).
      return adminIso.get(hexId) ?? info.candidates[0]
    },
  }
}
