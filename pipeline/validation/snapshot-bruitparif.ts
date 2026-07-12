/**
 * Leg A adapter: Bruitparif Rumeur (Paris region) → annual per-station
 * snapshot. The OpenData proxy (opendata.bruitparif.fr, Licence Ouverte v2,
 * attribution "Bruitparif") computes ANNUAL Lden/Ln server-side
 * (PeriodicValues2, periods=Y) including a 0-1 `weight` data-completeness
 * fraction — so rule 1 (annual averages only; <~9 months → diagnostic) is
 * enforced by a weight gate, no client-side period math at all.
 * Stations carry road/rail/air network tags (SiteListByTags categories) —
 * recorded per station as a composition HINT; values are total ambient, so
 * the Δ table's asymmetric total_ambient rule applies unchanged.
 *
 * LICENCE: UNVERIFIED for the Rumeur API — bruitparif.fr/licence-ouverte
 * provably covers the carto GIS products; mentions-legales restricts
 * automated extraction (Codex /gg 2026-07-12). Snapshot JSONs therefore stay
 * UNCOMMITTED (kept local for validation runs; see .gitignore) until
 * Bruitparif confirms in writing — ask alongside the production outreach.
 *
 * Run: npx tsx pipeline/validation/snapshot-bruitparif.ts [--year 2025]
 */
import { openValidationDb, writeSnapshot, type Snapshot, type SnapshotStation } from './lib.ts'

const yearArgIdx = process.argv.indexOf('--year')
const YEAR = yearArgIdx === -1 ? 2025 : Number(process.argv[yearArgIdx + 1])
if (!Number.isInteger(YEAR) || YEAR < 2015 || YEAR > 2100) {
  console.error(`invalid --year ${process.argv[yearArgIdx + 1]}`)
  process.exit(1)
}
const BASE = 'https://opendata.bruitparif.fr/data/rumeur'
const SUFFIX = 'lang=fr&host=rumeur.bruitparif.fr'
const UA = { 'User-Agent': '0db.app/1.0 (noise atlas; contact: info@0db.app)' }
/** Rule-1 gate: server `weight` (0-1 completeness) below this → skipped
 *  (a 9-of-12-month year ≈ 0.75). */
const MIN_WEIGHT = 0.75

type BpSite = {
  site_id: number
  site_name: string
  description?: string
  latitude: number
  longitude: number
  height?: number
  city?: string
  zip_code?: string
  is_active?: number
}

async function getJson(url: string): Promise<any> {
  // Fail-loud: a 429/5xx/timeout must abort the whole pull after one retry —
  // a swallowed error would publish a silently PARTIAL snapshot (Codex /gg).
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (e) {
      if (attempt >= 1) throw new Error(`${url}: ${e}`)
      await sleep(2000)
    }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  // Tag sweeps define the universe AND the per-station source hint.
  const tagOf = new Map<string, Set<string>>()
  const sites = new Map<string, BpSite>()
  for (const tag of ['route', 'fer', 'air']) {
    const body = await getJson(`${BASE}/SiteListByTags/json?tags=${tag}&${SUFFIX}`)
    const list: BpSite[] = body?.opendata?.site ?? []
    for (const s of list) {
      sites.set(s.site_name, s)
      if (!tagOf.has(s.site_name)) tagOf.set(s.site_name, new Set())
      tagOf.get(s.site_name)!.add(tag)
    }
    console.log(`tag ${tag}: ${list.length} sites`)
  }

  const db = openValidationDb()
  // Rerun convergence: replace this network's rows wholesale inside one
  // transaction — retracted/now-subthreshold station-years must not linger.
  db.exec("BEGIN")
  db.prepare("DELETE FROM annual_value WHERE network = 'bruitparif-rumeur'").run()
  db.prepare("DELETE FROM station WHERE network = 'bruitparif-rumeur'").run()
  const upsertStation = db.prepare(
    `INSERT OR REPLACE INTO station (network, station_id, name, lat, lng, meta_json) VALUES (?,?,?,?,?,?)`,
  )
  const upsertAnnual = db.prepare(
    `INSERT OR REPLACE INTO annual_value (network, station_id, year, metric, value, meta_json) VALUES (?,?,?,?,?,?)`,
  )

  // One call per station over the whole 2015..YEAR span — periods=Y returns
  // one row per calendar year with its own completeness weight, so the
  // richest historical campaigns (most of the network is decommissioned
  // today) land in per-year snapshots at no extra request cost.
  const byYear = new Map<number, SnapshotStation[]>()
  let probed = 0
  let lowWeight = 0
  let noData = 0
  for (const [name, site] of sites) {
    probed++
    if (probed % 100 === 0) console.log(`  ${probed}/${sites.size} probed`)
    const body = await getJson(
      `${BASE}/PeriodicValues2/json?site_name=${encodeURIComponent(name)}` +
        `&from_day=2015-01-01&to_day=${YEAR}-12-31&calculations=Lden,Ln,LAeq,Ld,Le&periods=Y&${SUFFIX}`,
    )
    await sleep(120)
    const rows: any[] = body?.opendata?.Y ?? []
    let kept = false
    for (const row of rows) {
      if (row?.Lden == null) continue
      const year = Number.isInteger(row.i) ? (row.i as number) : NaN
      if (!Number.isInteger(year) || year < 2015 || year > YEAR) continue
      // Missing weight = unknown completeness — rule 1 demands a known
      // ~annual window, so unknown is treated as failing, not passing.
      const weight = typeof row.weight === 'number' ? row.weight : null
      for (const m of ['Lden', 'Ln', 'LAeq', 'Ld', 'Le'] as const) {
        if (row[m] != null)
          upsertAnnual.run('bruitparif-rumeur', String(site.site_id), year, m.toLowerCase(), row[m], JSON.stringify({ weight }))
      }
      if (weight == null || weight < MIN_WEIGHT) {
        lowWeight++
        continue
      }
      const tags = [...(tagOf.get(name) ?? [])].sort().join(',')
      const st: SnapshotStation = {
        station_id: String(site.site_id),
        name: `${name}${site.description ? ` — ${site.description}` : ''}`,
        lat: site.latitude,
        lng: site.longitude,
        lden: row.Lden,
        ln: row.Ln ?? null,
        laeq: row.LAeq ?? null,
        ld: row.Ld ?? null,
        le: row.Le ?? null,
        weight,
        network_tags: tags,
        mic_height_m: site.height ?? null,
        city: site.city ?? null,
      }
      if (!byYear.has(year)) byYear.set(year, [])
      byYear.get(year)!.push(st)
      if (!kept) {
        upsertStation.run('bruitparif-rumeur', st.station_id, name, site.latitude, site.longitude, JSON.stringify({ tags, city: site.city, height: site.height }))
        kept = true
      }
    }
    if (!kept) noData++
  }
  db.exec("COMMIT")

  /** Years worth committing as snapshot files — below this they stay
   *  SQLite-only (a 3-station year is not a network anchor set). */
  const MIN_STATIONS_PER_SNAPSHOT = 15
  for (const [year, stations] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`year ${year}: ${stations.length} station-years`)
    if (stations.length < MIN_STATIONS_PER_SNAPSHOT) continue
    writeYearSnapshot(year, stations)
  }
  console.log(`probed ${probed} sites (${noData} without any usable year, ${lowWeight} station-years under weight gate)`)
}

function writeYearSnapshot(year: number, stations: SnapshotStation[]) {
  const snapshot: Snapshot = {
    schema_version: 2,
    network: 'bruitparif-rumeur',
    country_code: 'FR',
    year,
    license: 'PENDING WRITTEN CONFIRMATION — Licence Ouverte v2.0 provably covers carto only; Rumeur API reuse to be confirmed with Bruitparif (attribute "Bruitparif" regardless)',
    source: [`${BASE}/SiteListByTags/json`, `${BASE}/PeriodicValues2/json`],
    fetched_at: new Date().toISOString(),
    mode: 'total',
    anchor_type: 'measurement',
    regime: 'mixed',
    tags: [],
    comparison_mode: 'upper_bound',
    comparison_tolerance_db: 2,
    comparison_tolerance_basis: 'Project diagnostic +2 dB upper allowance for annual aggregation and mixed receiver siting; not a measurement confidence interval.',
    measured_metric_field: 'lden',
    model_metric_field: 'lden',
    commensurability: {
      metric_variant: 'lden',
      dominance: 'total_ambient',
      receiver_convention: 'mixed',
      coord_uncertainty_m: 10,
      note:
        'Server-computed annual Lden/Ln (PeriodicValues2 periods=Y) with a 0-1 completeness weight; ' +
        `stations below weight ${MIN_WEIGHT} skipped (rule 1). network_tags (route/fer/air) is the ` +
        'network-purpose hint per station — values are TOTAL ambient, asymmetric rule applies. ' +
        'Mic height per station in mic_height_m (often facade/mast, not 4 m).',
    },
    method:
      'SiteListByTags (route|fer|air) → PeriodicValues2 periods=Y per site over the calendar year; ' +
      'kept stations with a non-null annual Lden and weight >= gate.',
    stations,
  }
  const path = writeSnapshot(snapshot)
  console.log(`  → ${path}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
