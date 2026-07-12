/**
 * Leg A adapter: Zürich Airport NMT daytime aircraft levels — the airport
 * TEMPLATE adapter (validation-v2-plan.md wave 1). Source: the annual-report
 * noise page (report.flughafen-zuerich.ch/{year}/ar/en/laerm), a
 * server-rendered HTML table whose row "Daytime aircraft noise levels at
 * NMT 1/3/6/10 (dB[A])" carries one NMT quadruple per year column — the
 * whole 2019+ history lands in SQLite on every pull (trend), the requested
 * year goes to the committed snapshot.
 *
 * Metric honesty: values are Swiss Tag LAeq 06–22 (integer dB) — a documented
 * window variant (metric_variant laeq_windows), stored as `laeq_tag_0622`,
 * NEVER converted to Lden. Coords are village centres (NMT exact siting
 * unpublished) — coord_uncertainty_m 500, same caveat as the fixtures.
 *
 * Run: npx tsx pipeline/validation/snapshot-zrh.ts --year 2024
 */
import { openValidationDb, writeSnapshot } from './lib.ts'

const NETWORK = 'zrh-nmt'
// Coordinates from the 2026-06 airborne audit (village centres; NMT siting
// unpublished) — the same anchors the world-points ZRH fixtures use.
const STATIONS = [
  { station_id: 'nmt1', name: 'NMT 1 Rümlang', lat: 47.4524, lng: 8.531 },
  { station_id: 'nmt3', name: 'NMT 3 Oberglatt', lat: 47.4753, lng: 8.5052 },
  { station_id: 'nmt6', name: 'NMT 6 Glattbrugg', lat: 47.4333, lng: 8.563 },
  { station_id: 'nmt10', name: 'NMT 10 Nürensdorf', lat: 47.4467, lng: 8.6477 },
]

const year = Number(process.argv[process.argv.indexOf('--year') + 1] || NaN)
if (!Number.isInteger(year)) {
  console.error('usage: npx tsx pipeline/validation/snapshot-zrh.ts --year <YYYY of the annual report>')
  process.exit(2)
}
const url = `https://report.flughafen-zuerich.ch/${year}/ar/en/laerm`
const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
if (!r.ok) throw new Error(`[zrh] ${url}: HTTP ${r.status} — report year not published?`)
const html = await r.text()

// Anchor BOTH rows to the ONE <table> containing the NMT label — a year
// header taken from anywhere else on the page could silently mis-pair
// columns if the report ever adds another year-wide table.
const labelAt = html.indexOf('at NMT 1/3/6/10')
if (labelAt === -1) throw new Error('[zrh] report layout changed: NMT row label not found')
const table = html.slice(html.lastIndexOf('<table', labelAt), html.indexOf('</table>', labelAt))
const rowLabelAt = table.indexOf('at NMT 1/3/6/10')
const row = table.slice(table.lastIndexOf('<tr', rowLabelAt), table.indexOf('</tr>', rowLabelAt))
const quads = [...row.matchAll(/<span[^>]*>\s*(\d{2}\/\d{2}\/\d{2}\/\d{2})\s*<\/span>/g)].map((m) => m[1])
const firstYearAt = table.search(/<span[^>]*>\s*20\d\d\s*<\/span>/)
if (firstYearAt === -1) throw new Error('[zrh] report layout changed: no year header inside the noise-statistics table')
const yearRow = table.slice(table.lastIndexOf('<tr', firstYearAt), table.indexOf('</tr>', firstYearAt))
const years = [...yearRow.matchAll(/<span[^>]*>\s*(20\d\d)\s*<\/span>/g)].map((m) => Number(m[1]))
if (quads.length !== years.length || quads.length === 0) {
  throw new Error(`[zrh] report layout changed: ${years.length} year columns vs ${quads.length} NMT quadruples`)
}
if (!years.includes(year)) throw new Error(`[zrh] report ${year} carries columns ${years.join(',')} — requested year missing`)

const db = openValidationDb()
db.exec('BEGIN')
// Every pull re-imports the report's full year range — scope-delete the
// network so retracted/re-stated report columns can't leave stale rows.
db.prepare('DELETE FROM annual_value WHERE network = ?').run(NETWORK)
const upStation = db.prepare('INSERT OR REPLACE INTO station (network, station_id, name, lat, lng, meta_json) VALUES (?,?,?,?,?,?)')
const upAnnual = db.prepare('INSERT OR REPLACE INTO annual_value (network, station_id, year, metric, value, meta_json) VALUES (?,?,?,?,?,?)')
for (const st of STATIONS) upStation.run(NETWORK, st.station_id, st.name, st.lat, st.lng, JSON.stringify({ siting: 'village centre, NMT exact siting unpublished' }))
for (let i = 0; i < years.length; i++) {
  const values = quads[i].split('/').map(Number)
  STATIONS.forEach((st, j) =>
    upAnnual.run(NETWORK, st.station_id, years[i], 'laeq_tag_0622', values[j], JSON.stringify({ report: url })))
}
db.exec('COMMIT')
db.close()
console.error(`[zrh] stored ${years.length} report years (${years.join(', ')}) × ${STATIONS.length} NMTs`)

const idx = years.indexOf(year)
const values = quads[idx].split('/').map(Number)
const path = writeSnapshot({
  schema_version: 2,
  network: NETWORK,
  country_code: 'CH',
  year,
  license: 'Flughafen Zürich AG annual report (public figures; cite the report)',
  source: [url],
  fetched_at: new Date().toISOString(),
  mode: 'source:aircraft',
  anchor_type: 'measurement',
  regime: 'aircraft',
  tags: [],
  comparison_mode: 'trend_only',
  comparison_tolerance_db: null,
  comparison_tolerance_basis: null,
  measured_metric_field: 'laeq_tag_0622',
  model_metric_field: 'lden',
  commensurability: {
    metric_variant: 'laeq_windows',
    dominance: 'event_classified',
    receiver_convention: 'nmt_pole',
    coord_uncertainty_m: 500,
    note: 'Swiss Tag LAeq 06–22, integer dB, aircraft-specific NMT values — window metric compared as-is (trend anchor); never converted to Lden.',
  },
  method: 'parse annual-report HTML table row "Daytime aircraft noise levels at NMT 1/3/6/10" paired with the year header columns',
  stations: STATIONS.map((st, j) => ({ ...st, laeq_tag_0622: values[j] })),
})
console.error(`[zrh] snapshot: ${STATIONS.length} stations, year ${year} → ${path}`)
