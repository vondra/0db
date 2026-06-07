/**
 * High-resolution country point-in-polygon gate from the committed Natural Earth
 * 1:10m admin-0 file (`scripts/cache/ne_10m_admin_0_countries.geojson`).
 *
 * Use to stop an enricher writing one country's data onto another country's roads
 * where a rectangular `*_HEX_BBOX` overlaps a neighbour: Poland's bbox blankets
 * most of Czechia, so a Czech "I/150" was matched to Polish "DW150" and given
 * Polish AADT (see the Stage-3 road audit). Gate the match by the road midpoint's
 * actual country.
 *
 * This is the full-resolution polygon — NOT `h3r4-admin.bin`, which is H3 res-4
 * (~22 km, centroid-based) and far too coarse to separate roads at a border.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { pointInRing } from './spatial.js'

const NE_GEOJSON = resolve(import.meta.dirname, '..', '..', 'scripts', 'cache', 'ne_10m_admin_0_countries.geojson')
// scripts/cache/ is gitignored (this 13 MB file is a downloadable reference, not committed),
// so a fresh checkout/host lacks it. Same file + URL build-h3-admin.ts fetches — pull once on demand.
const NE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson'

type NeFeature = { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }
let features: ReadonlyArray<NeFeature> | null = null
function neFeatures(): ReadonlyArray<NeFeature> {
  if (features) return features
  if (!existsSync(NE_GEOJSON)) {
    mkdirSync(dirname(NE_GEOJSON), { recursive: true })
    execFileSync('curl', ['-fsSL', NE_URL, '-o', NE_GEOJSON])
  }
  return (features = JSON.parse(readFileSync(NE_GEOJSON, 'utf8')).features)
}

type Ring = ReadonlyArray<readonly [number, number]>

/**
 * A load-once point-in-country tester: `true` iff `(lat, lon)` is inside any outer
 * ring of the ISO-3166-1 alpha-2 country (holes/enclaves ignored — fine for a
 * border-road gate). Matches both `ISO_A2` and `ISO_A2_EH` (Natural Earth stores
 * France/Norway/… under the latter). Throws on an unknown code — fail loud, since a
 * silent always-false gate would drop every match. `makeCountryGate(iso2)` IS the
 * reuse path for other enrichers; no need to expose the raw rings.
 */
export function makeCountryGate(iso2: string): (lat: number, lon: number) => boolean {
  const code = iso2.toUpperCase()
  const f = neFeatures().find(x => x.properties.ISO_A2 === code || x.properties.ISO_A2_EH === code)
  if (!f) throw new Error(`country-polygon: no Natural Earth feature for ISO_A2=${code}`)
  const g = f.geometry
  const rings: Ring[] = []   // outer ring of each Polygon (N for a MultiPolygon)
  if (g.type === 'Polygon') rings.push((g.coordinates as Ring[])[0])
  else if (g.type === 'MultiPolygon') for (const poly of g.coordinates as Ring[][]) rings.push(poly[0])
  return (lat, lon) => {
    for (const ring of rings) if (pointInRing(lon, lat, ring)) return true
    return false
  }
}
