/**
 * Leg A adapter: Dublin City ambient noise network (Sonitus API behind
 * data.smartdublin.ie, CC BY — Dublin City Council). The API serves hourly
 * LAeq per monitor with a hard 28-day window cap, so a year is 13 chained
 * windows; END Ld/Le/Ln + Lden are computed client-side over LOCAL hours,
 * exactly the Barcelona reduction but from hourly rows (energy weighted
 * ×60 minutes). No server-side Lden exists (day/night only) — metric
 * honesty via period_split.
 *
 * Sonitus `datetime` labels the END of the averaging hour (01:00 covers
 * 00:00-01:00 — DCC's own monitor pages); rows are re-labelled to interval
 * START before END-period binning, and the year is fetched with a +1 h tail
 * so Dec 31 23-24h (labelled Jan 1 00:00) is included (Codex /gg).
 * Monitors are classified noise-vs-air via the dashboard feed with a
 * label-prefix fallback, so historical replacement instruments that have
 * dropped out of the current registry still contribute their year.
 *
 * Credentials are PUBLISHED IN PLAINTEXT by Dublin City Council themselves
 * in the dataset readme, explicitly for reuse under CC-BY:
 * https://data.smartdublin.ie/dataset/sonitus-api → readme.txt.
 *
 * Run: npx tsx pipeline/validation/snapshot-dublin.ts --year 2025
 */
import {
  boundedCoveragePercent,
  endPeriodForLocalHour, energeticMeanDb, ldenFromPeriods, openValidationDb,
  PERIOD_MINUTES_PER_DAY, writeSnapshot, type EndPeriod, type SnapshotStation,
} from './lib.ts'

const NETWORK = 'dublin-sonitus'
const API = 'https://data.smartdublin.ie/sonitus-api'
const SITE_MONITORS = 'https://dublincityairandnoise.ie/assets/php/get-monitors.php'
const CRED = 'username=dublincityapi&password=Xpa5vAQ9ki'
const UA = { 'User-Agent': 'quietmap.org/1.0 (noise atlas; contact: info@quietmap.org)' }
const WINDOW_DAYS = 28 // hard server cap, verified by binary search
const MIN_MONTHS = 9
const MIN_PERIOD_COVERAGE = 0.7
const MONTH_COVERED_FRACTION = 0.5

const yearArgIdx = process.argv.indexOf('--year')
const year = yearArgIdx === -1 ? 2025 : Number(process.argv[yearArgIdx + 1])
if (!Number.isInteger(year) || year < 2010 || year > 2100) {
  console.error('usage: npx tsx pipeline/validation/snapshot-dublin.ts --year <YYYY>')
  process.exit(2)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Fail-loud POST (params live in the query string on this API): one retry,
 *  then abort the whole pull — a swallowed 429 must not ship a partial year. */
async function postJson(url: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: UA, signal: AbortSignal.timeout(60000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (e) {
      if (attempt >= 1) throw new Error(`${url.replace(CRED, 'username=…')}: ${e}`)
      await sleep(3000)
    }
  }
}

async function main() {
  // Category tagging (noise vs air) lives on the public site endpoint;
  // serial_number is the Sonitus join key (code != serial on some monitors).
  const site: any[] = await (await fetch(SITE_MONITORS, { headers: UA, signal: AbortSignal.timeout(30000) })).json()
  const categoryBySerial = new Map<string, string>(
    site.map(m => [String(m.serial_number), String(m.monitor_type?.category ?? '')]),
  )
  const monitors: any[] = await postJson(`${API}/api/monitors?${CRED}`)
  // Category from the dashboard feed when the serial is still registered;
  // label-prefix fallback keeps historical replacement instruments (e.g.
  // 01534/01535 carry 2025 data but left the current registry).
  const noiseMonitors = monitors.filter(m => {
    const cat = categoryBySerial.get(String(m.serial_number))
    return cat ? cat === 'noise' : String(m.label ?? '').startsWith('Noise')
  })
  console.error(`[dublin] ${monitors.length} monitors, ${noiseMonitors.length} noise-classified`)

  const db = openValidationDb()
  const upStation = db.prepare('INSERT OR REPLACE INTO station (network, station_id, name, lat, lng, meta_json) VALUES (?,?,?,?,?,?)')
  const upDaily = db.prepare('INSERT OR REPLACE INTO daily_period (network, station_id, date, period, energy_sum, minutes) VALUES (?,?,?,?,?,?)')
  const upAnnual = db.prepare('INSERT OR REPLACE INTO annual_value (network, station_id, year, metric, value, meta_json) VALUES (?,?,?,?,?,?)')

  const daysInYear = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 366 : 365
  const daysInMonth = (ym: string) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate()
  const yearStart = Date.UTC(year, 0, 1) / 1000
  // +3599: the year's last hour is labelled Jan 1 00:00 (hour-END semantics).
  const yearEnd = Date.UTC(year + 1, 0, 1) / 1000 + 3599

  /** Interval-START date+hour from an hour-END label; 00:xx belongs to the
   *  PREVIOUS calendar date's hour 23 (date-only UTC arithmetic — DST-safe). */
  const intervalStart = (ts: string): { date: string; hour: number } => {
    const hour = Number(ts.slice(11, 13))
    if (hour >= 1) return { date: ts.slice(0, 10), hour: hour - 1 }
    const prev = new Date(new Date(`${ts.slice(0, 10)}T12:00:00Z`).getTime() - 86400e3)
    return { date: prev.toISOString().slice(0, 10), hour: 23 }
  }

  type Reduced = { mon: any; serial: string; byDate: Map<string, Record<EndPeriod, [number, number]>> }
  const reduced: Reduced[] = []
  let badRows = 0
  let totalRows = 0
  for (const mon of noiseMonitors) {
    const serial = String(mon.serial_number)
    const byDate = new Map<string, Record<EndPeriod, [number, number]>>()
    const seenTs = new Set<string>()
    for (let start = yearStart; start <= yearEnd; start += WINDOW_DAYS * 86400) {
      const end = Math.min(start + WINDOW_DAYS * 86400 - 1, yearEnd)
      const rows: any[] = await postJson(`${API}/api/hourly-averages?${CRED}&monitor=${encodeURIComponent(serial)}&start=${start}&end=${end}`)
      await sleep(150)
      if (!Array.isArray(rows)) throw new Error(`[dublin] ${serial} window ${start}: non-array payload — API drift, refusing a silently partial year`)
      for (const row of rows) {
        totalRows++
        const ts = String(row.datetime ?? '')
        if (ts.length < 13) { badRows++; continue }
        if (row.laeq == null || Number(row.laeq) <= 0) continue // documented offline flag, not a malformed row
        const laeq = Number(row.laeq)
        if (!Number.isFinite(laeq)) { badRows++; continue }
        if (seenTs.has(ts)) continue // boundary rows may repeat across windows
        seenTs.add(ts)
        const { date, hour } = intervalStart(ts)
        if (!date.startsWith(String(year))) continue
        const period = endPeriodForLocalHour(hour)
        let slots = byDate.get(date)
        if (!slots) byDate.set(date, (slots = { ld: [0, 0], le: [0, 0], ln: [0, 0] }))
        slots[period][0] += 60 * 10 ** (laeq / 10)
        slots[period][1] += 60
      }
    }
    reduced.push({ mon, serial, byDate })
  }
  if (badRows > totalRows * 0.01) throw new Error(`[dublin] ${badRows}/${totalRows} malformed rows (>1%) — API format drift, refusing to ship`)

  // Short transaction: network is done, this is pure SQLite now.
  db.exec('BEGIN')
  db.prepare('DELETE FROM daily_period WHERE network = ? AND date LIKE ?').run(NETWORK, `${year}-%`)
  db.prepare('DELETE FROM annual_value WHERE network = ? AND year = ?').run(NETWORK, year)

  const snapshotStations: SnapshotStation[] = []
  for (const { mon, serial, byDate } of reduced) {

    const total: Record<EndPeriod, [number, number]> = { ld: [0, 0], le: [0, 0], ln: [0, 0] }
    const monthMinutes = new Map<string, number>()
    for (const [date, slots] of byDate) {
      for (const period of ['ld', 'le', 'ln'] as const) {
        const [e, n] = slots[period]
        if (n > 0) upDaily.run(NETWORK, serial, date, period, e, n)
        total[period][0] += e
        total[period][1] += n
        monthMinutes.set(date.slice(0, 7), (monthMinutes.get(date.slice(0, 7)) ?? 0) + n)
      }
    }
    const monthsCovered = [...monthMinutes.entries()]
      .filter(([ym, min]) => min >= daysInMonth(ym) * 1440 * MONTH_COVERED_FRACTION).length
    const periodCoverage = (['ld', 'le', 'ln'] as const)
      .map(p => total[p][1] / (PERIOD_MINUTES_PER_DAY[p] * daysInYear))
    for (const c of periodCoverage) {
      if (c > 1.005) throw new Error(`[dublin] ${serial}: period coverage ${(c * 100).toFixed(1)} % > 100 % — window overlap bug, refusing to ship`)
    }
    const minCoverage = Math.min(...periodCoverage)
    const ld = energeticMeanDb(...total.ld)
    const le = energeticMeanDb(...total.le)
    const ln = energeticMeanDb(...total.ln)
    const lden = ldenFromPeriods(ld, le, ln)
    const name = `${mon.label ?? serial} — ${mon.location ?? ''}`.trim()
    upStation.run(NETWORK, serial, name, Number(mon.latitude), Number(mon.longitude), JSON.stringify({ last_calibrated: mon.last_calibrated ?? null }))
    const coveragePct = boundedCoveragePercent(minCoverage)
    const meta = JSON.stringify({ min_period_coverage_pct: coveragePct, months_covered: monthsCovered })
    for (const [metric, value] of Object.entries({ ld, le, ln, lden })) {
      if (value != null) upAnnual.run(NETWORK, serial, year, metric, +value.toFixed(2), meta)
    }
    if (lden == null || monthsCovered < MIN_MONTHS || minCoverage < MIN_PERIOD_COVERAGE) {
      console.error(`[dublin] ${serial} (${name}): ${monthsCovered} covered mo, min period ${(minCoverage * 100).toFixed(0)} % — SQLite only, excluded (rule 1)`)
      continue
    }
    console.error(`[dublin] ${serial} (${name}): lden ${lden.toFixed(1)} — kept`)
    snapshotStations.push({
      station_id: serial, name, lat: Number(mon.latitude), lng: Number(mon.longitude),
      ld: +ld!.toFixed(1), le: +le!.toFixed(1), ln: +ln!.toFixed(1), lden: +lden.toFixed(1),
      months_covered: monthsCovered, coverage_pct: coveragePct,
    })
  }
  // A temporary replacement can report the same year in parallel with its
  // host instrument. Portal coordinates differ by a few metres, so decimal
  // string equality is not a valid site identity. Drop a replacement only
  // when an independently named non-replacement passed the gate within 25 m;
  // otherwise retain it (the host may have failed coverage or been removed).
  const distanceM = (a: (typeof snapshotStations)[number], b: (typeof snapshotStations)[number]) => {
    const lat = ((a.lat + b.lat) / 2) * Math.PI / 180
    return Math.hypot((a.lat - b.lat) * 110_540, (a.lng - b.lng) * 111_320 * Math.cos(lat))
  }
  const isReplacement = (station: (typeof snapshotStations)[number]) => /temp(?:orary)?\s+replacement/i.test(station.name)
  const siteKey = (station: (typeof snapshotStations)[number]) => station.name
    .replace(/^Noise\s+\S+\s+—\s+/i, '')
    .replace(/\s+temp(?:orary)?\s+replacement$/i, '')
    .trim()
    .toLocaleLowerCase('en-IE')
  const deduplicated = snapshotStations.filter(station => {
    if (!isReplacement(station)) return true
    const host = snapshotStations.find(candidate => !isReplacement(candidate)
      && (siteKey(candidate) === siteKey(station) || distanceM(station, candidate) <= 25))
    if (!host) return true
    console.error(`[dublin] ${station.station_id} (${station.name}): replacement for host ${host.station_id}; portal coordinates differ by ${distanceM(station, host).toFixed(1)} m — deduped`)
    return false
  })
  snapshotStations.length = 0
  snapshotStations.push(...deduplicated)
  if (snapshotStations.length === 0) throw new Error('[dublin] 0 stations pass the coverage gate — refusing a silently empty snapshot')
  db.exec('COMMIT')
  db.close()

  snapshotStations.sort((a, b) => a.station_id.localeCompare(b.station_id, undefined, { numeric: true }))
  const path = writeSnapshot({
    schema_version: 2,
    network: NETWORK,
    country_code: 'IE',
    year,
    license: 'CC BY — Dublin City Council (data.smartdublin.ie Sonitus API dataset; credentials published in the dataset readme for reuse)',
    source: [`${API} (POST /api/monitors, /api/hourly-averages)`, SITE_MONITORS],
    fetched_at: new Date().toISOString(),
    mode: 'total',
    anchor_type: 'measurement',
    regime: 'mixed',
    tags: [],
    comparison_mode: 'upper_bound',
    comparison_tolerance_db: 2,
    comparison_tolerance_basis: 'Project diagnostic +2 dB upper allowance for annual aggregation and receiver siting; not a measurement confidence interval.',
    measured_metric_field: 'lden',
    model_metric_field: 'lden',
    commensurability: {
      metric_variant: 'period_split',
      dominance: 'total_ambient',
      receiver_convention: 'nmt_pole',
      coord_uncertainty_m: 15,
      note:
        'END Ld/Le/Ln from Sonitus hourly LAeq over local hours (60-min energy weights), Lden per END ' +
        'weighting; 28-day API windows chained across the year. Street/park mics hear everything — ' +
        'asymmetric rule: model_total ≤ measured + U only.',
    },
    method: 'POST hourly-averages per monitor in 13×28-day windows → daily END-period energy sums (SQLite) → annual energetic means',
    stations: snapshotStations,
  })
  console.error(`[dublin] snapshot: ${snapshotStations.length} stations → ${path}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
