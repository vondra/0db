/**
 * Leg A adapter: EBA Lärmmonitoring (Eisenbahn-Bundesamt) — 19 permanent
 * rail-noise stations on German freight corridors, microphone 7.5 m from
 * track centre / 1.2 m above rail top. Source: the annual report PDF on
 * laerm-monitoring.de; Tabelle 7 (24 h) and Tabelle 8 (Tag 06–22 / Nacht
 * 22–06) carry per-station year-average levels PLUS mean train counts,
 * freight counts, axle counts, train lengths and speeds — the counts are
 * direct anchors for OUR rail traffic inputs (the rail-freight-R1/R2 gap),
 * which is this network's primary value. Report states U = 1.3 dB (k=2).
 *
 * Coordinates come from pipeline/validation/eba-stations.json — currently
 * TOWN CENTROIDS (±~3 km); the mast positions are not yet geolocated, so
 * level comparison stays trend-only (laeq_windows is not band_capable
 * anyway — German day/night windows, never converted to Lden).
 *
 * Requires `pdftotext` (poppler-utils). Run:
 *   npx tsx pipeline/validation/snapshot-eba.ts --year 2023
 */
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { assertDir, openValidationDb, VALIDATION_DATA_DIR, writeSnapshot } from './lib.ts'

const NETWORK = 'eba-laermmonitoring'
const REGISTRY_PATH = resolve(import.meta.dirname, 'eba-stations.json')
const PDF_DIR = resolve(VALIDATION_DATA_DIR, 'eba')

const year = Number(process.argv[process.argv.indexOf('--year') + 1] || NaN)
if (!Number.isInteger(year)) {
  console.error('usage: npx tsx pipeline/validation/snapshot-eba.ts --year <YYYY of the annual report>')
  process.exit(2)
}

const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as {
  stations: Record<string, { lat: number; lng: number; strecke: string }>
}

// ── 1. Fetch + text-extract the annual report ───────────────────────────────

const pdfUrl = `https://www.laerm-monitoring.de/pdf/${encodeURIComponent(`Lärm-Monitoring Jahresbericht ${year}.pdf`)}`
const pdfPath = assertDir(resolve(PDF_DIR, `jahresbericht-${year}.pdf`))
if (!existsSync(pdfPath) || statSync(pdfPath).size === 0) {
  console.error(`[eba] downloading ${pdfUrl}`)
  const r = await fetch(pdfUrl, { signal: AbortSignal.timeout(120000) })
  if (!r.ok || !r.body) throw new Error(`[eba] ${pdfUrl}: HTTP ${r.status} — report year not published?`)
  await pipeline(Readable.fromWeb(r.body as never), createWriteStream(pdfPath))
}
const extract = spawnSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (extract.status !== 0) throw new Error(`[eba] pdftotext failed (${extract.status}) — poppler-utils installed? ${extract.stderr?.slice(0, 200)}`)
const text = extract.stdout

// ── 2. Parse Tabelle 7 (24 h) + Tabelle 8 (Tag/Nacht) ──────────────────────
// Row shapes are strict (station, window, level with German decimal comma,
// then five integer columns); any station name outside the registry fails
// loud — layout drift must never ship a silently mis-parsed snapshot.

const de = (s: string) => Number(s.replace(',', '.'))
type Metrics = { level: number; trains: number; freight: number; axles: number; length_m: number; speed_kmh: number }
const stations = new Map<string, Partial<Record<'24h' | 'tag' | 'nacht', Metrics>>>()

function record(name: string, window: '24h' | 'tag' | 'nacht', m: Metrics) {
  if (!registry.stations[name]) throw new Error(`[eba] report row for unknown station "${name}" — update pipeline/validation/eba-stations.json`)
  if (!stations.has(name)) stations.set(name, {})
  const st = stations.get(name)!
  if (st[window]) throw new Error(`[eba] duplicate ${window} row for ${name} — table parse drift`)
  st[window] = m
}

const row24 = /^\s*([A-ZÄÖÜ][\wäöüß .-]+?)\s{2,}24h\s+(\d+,\d)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/
const rowDN = /^\s*([A-ZÄÖÜ][\wäöüß .-]+?)?\s*\s{2,}(Nacht|Tag)\s+(\d+,\d)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/
let carryName: string | null = null
for (const line of text.split('\n')) {
  const m24 = row24.exec(line)
  if (m24) {
    record(m24[1].trim(), '24h', { level: de(m24[2]), trains: +m24[3], freight: +m24[4], axles: +m24[5], length_m: +m24[6], speed_kmh: +m24[7] })
    continue
  }
  const mdn = rowDN.exec(line)
  if (mdn) {
    const name: string | null = mdn[1]?.trim() || carryName
    if (!name) throw new Error(`[eba] Tag/Nacht row without a station context: ${line.trim()}`)
    carryName = name
    record(name, mdn[2] === 'Tag' ? 'tag' : 'nacht', { level: de(mdn[3]), trains: +mdn[4], freight: +mdn[5], axles: +mdn[6], length_m: +mdn[7], speed_kmh: +mdn[8] })
  }
}

const complete = [...stations.entries()].filter(([, w]) => w['24h'] && w.tag && w.nacht)
if (complete.length < 10) throw new Error(`[eba] only ${complete.length} complete stations parsed — report layout drift`)
for (const name of Object.keys(registry.stations)) {
  if (!stations.has(name)) console.error(`[eba] registry station ${name} absent from the ${year} report (commissioned later?) — skipped`)
}

// ── 3. Persist + snapshot ───────────────────────────────────────────────────

const db = openValidationDb()
db.exec('BEGIN')
db.prepare('DELETE FROM annual_value WHERE network = ? AND year = ?').run(NETWORK, year)
const upStation = db.prepare('INSERT OR REPLACE INTO station (network, station_id, name, lat, lng, meta_json) VALUES (?,?,?,?,?,?)')
const upAnnual = db.prepare('INSERT OR REPLACE INTO annual_value (network, station_id, year, metric, value, meta_json) VALUES (?,?,?,?,?,?)')
const META = JSON.stringify({ report: pdfUrl, uncertainty_db: 1.3 })
for (const [name, w] of complete) {
  const reg = registry.stations[name]
  upStation.run(NETWORK, name, `${name} (Strecke ${reg.strecke})`, reg.lat, reg.lng, JSON.stringify({ strecke: reg.strecke, geometry: 'mic 7.5 m from track centre, 1.2 m above rail top; coords = town centroid' }))
  const metrics: Record<string, number> = {
    laeq_24h: w['24h']!.level, laeq_tag_0622: w.tag!.level, laeq_nacht_2206: w.nacht!.level,
    trains_per_day: w['24h']!.trains, freight_trains_per_day: w['24h']!.freight,
    freight_trains_night: w.nacht!.trains, mean_speed_kmh: w['24h']!.speed_kmh,
    mean_train_length_m: w['24h']!.length_m,
  }
  for (const [metric, value] of Object.entries(metrics)) upAnnual.run(NETWORK, name, year, metric, value, META)
}
db.exec('COMMIT')
db.close()

const path = writeSnapshot({
  network: NETWORK,
  year,
  license: 'Eisenbahn-Bundesamt Lärm-Monitoring Jahresbericht (public federal report; cite the report)',
  source: [pdfUrl, 'https://www.laerm-monitoring.de/Standorte'],
  fetched_at: new Date().toISOString(),
  mode: 'source:railway',
  commensurability: {
    metric_variant: 'laeq_windows',
    dominance: 'near_source',
    receiver_convention: 'free_field',
    height_m: 1.2,
    coord_uncertainty_m: 3000,
    note: 'German Tag 06–22 / Nacht 22–06 windows at the standardized 7.5 m pass-by geometry; U = 1.3 dB (k=2) per report. Coords are town centroids until masts are geolocated — LEVELS are trend anchors; the per-station train counts / freight share / speeds are the primary anchors (rail traffic inputs).',
  },
  method: 'pdftotext -layout over the annual report; strict-row parse of Tabelle 7 (24h) + Tabelle 8 (Tag/Nacht); station names validated against eba-stations.json',
  stations: complete.map(([name, w]) => ({
    station_id: name,
    name: `${name} (Strecke ${registry.stations[name].strecke})`,
    lat: registry.stations[name].lat,
    lng: registry.stations[name].lng,
    laeq_24h: w['24h']!.level,
    laeq_tag_0622: w.tag!.level,
    laeq_nacht_2206: w.nacht!.level,
    trains_per_day: w['24h']!.trains,
    freight_trains_per_day: w['24h']!.freight,
    trains_night: w.nacht!.trains,
    mean_speed_kmh: w['24h']!.speed_kmh,
    mean_train_length_m: w['24h']!.length_m,
  })).sort((a, b) => a.station_id.localeCompare(b.station_id)),
})
console.error(`[eba] snapshot: ${complete.length} stations, year ${year} → ${path}`)
