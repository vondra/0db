/**
 * City traffic enrichment driver — stamps municipal counter AADT onto road
 * arrows for every enabled city in `lib/city-datasets.ts`.
 *
 * NAMED OUTSIDE the `enrich-roads-*.ts` glob on purpose: `pipeline/bench/
 * rerun-measured.sh` launches that glob CONCURRENTLY (xargs -P) and a city
 * driver racing national enrichers over the same hex arrows would fight the
 * per-hex lock — this driver runs as the runner's sequential Phase 3
 * instead (city-enrichment-plan §2.4, Gemini /gg CRITICAL).
 *
 * Per city: adapter loads normalized per-street records (cached download) →
 * rows inside the municipal ADM2 polygon (`makeCityGate` — real boundary,
 * never a bbox) are matched by normalized street name (or osm_id where the
 * source publishes it) → `writeRoadAadt` stamps the city's source_id
 * (priority 90 → `city-measured`, outranks national INSIDE the polygon
 * only).
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/enrich-cities-roads.ts [--city <slug>]
 *       [--enrich-only] [--force-download]
 */
import { resolve } from 'node:path'
import { CITY_DATASETS } from './lib/city-datasets.js'
import { makeCityGate } from './lib/city-polygon.js'
import { iterateCountryHexes, writeRoadAadt, type RoadAadt } from './lib/roads-arrow.js'
import { shouldOverwrite } from './lib/sources.js'

const YEAR = process.env.DATA_YEAR ?? '2026'
const H3R4_DIR = resolve(import.meta.dirname, '..', 'data', 'prepared', YEAR, 'h3r4')
const argv = process.argv.slice(2)
const ENRICH_ONLY = argv.includes('--enrich-only')
const FORCE_DOWNLOAD = argv.includes('--force-download')
const cityArg = argv.includes('--city') ? argv[argv.indexOf('--city') + 1] : null

/** Street-name normalization for the join: case/diacritics/whitespace-fold.
 *  TSK publishes "LEGEROVA", OSM has "Legerova"; abbreviations ("nám.",
 *  "tř.") stay as-is on both sides — extend per city if a real miss shows. */
function normStreet(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

async function enrichCity(slug: string): Promise<void> {
  const city = CITY_DATASETS.find((c) => c.slug === slug)
  if (!city) throw new Error(`unknown city slug "${slug}" (have: ${CITY_DATASETS.map((c) => c.slug).join(', ')})`)
  if (!city.enabled) {
    console.log(`[cities] ${slug}: disabled, skipping`)
    return
  }
  const records = await city.load({ enrichOnly: ENRICH_ONLY, forceDownload: FORCE_DOWNLOAD })
  const byName = new Map<string, (typeof records)[number]>()
  const byOsmId = new Map<number, (typeof records)[number]>()
  for (const r of records) {
    byName.set(normStreet(r.street), r)
    if (r.osmId != null) byOsmId.set(r.osmId, r)
  }
  const inCity = makeCityGate(city.adm2.iso3, city.adm2.shapeName)
  const hexes = iterateCountryHexes(H3R4_DIR, city.hexBbox)
  console.log(`[cities] ${slug}: ${records.length} street records, ${hexes.length} hexes in envelope`)

  let totalMatched = 0
  for (const hex of hexes) {
    const res = await writeRoadAadt(resolve(H3R4_DIR, hex, 'roads.arrow'), (row): RoadAadt | null => {
      // Rank fast-exit first (cheap), THEN the polygon gate — the
      // city-measured rank is only honest inside the municipal boundary;
      // bbox hexes reach far beyond it, so every stamped row passes PiP.
      if (!shouldOverwrite(row.existingSourceId, city.sourceId)) return null
      if (!inCity(row.midLat, row.midLon)) return null
      const rec =
        (row.osmId != null ? byOsmId.get(row.osmId) : undefined) ??
        (row.name ? byName.get(normStreet(row.name)) : undefined)
      if (!rec) return null
      return {
        light: rec.aadtLight,
        medium: rec.aadtMedium,
        heavy: rec.aadtHeavy,
        moto: rec.aadtMoto,
        sourceId: city.sourceId,
      }
    }, undefined, city.coverage)
    totalMatched += res.matched
  }
  console.log(`[cities] ${slug}: stamped ${totalMatched} rows across ${hexes.length} hexes`)
  if (totalMatched === 0) {
    throw new Error(`[cities] ${slug}: 0 rows matched — name normalization or gate regression?`)
  }
}

const targets = cityArg ? [cityArg] : CITY_DATASETS.filter((c) => c.enabled).map((c) => c.slug)
for (const slug of targets) {
  await enrichCity(slug)
}
