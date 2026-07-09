/**
 * Shared plumbing for validation-v2 Leg A snapshot adapters
 * (docs/dev/validation-v2-plan.md §Leg A): per-network agent-run pulls that
 * write (a) raw+normalized SQLite under data/validation/ (gitignored,
 * re-fetchable) and (b) compact per-station annual JSON snapshots committed
 * under benchmarks/validation/snapshots/. No cron until a network has two
 * stable manual runs.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dirname, '../..')
export const VALIDATION_DATA_DIR = resolve(REPO_ROOT, 'data/validation')
export const SNAPSHOT_DIR = resolve(REPO_ROOT, 'benchmarks/validation/snapshots')
export const SQLITE_PATH = resolve(VALIDATION_DATA_DIR, 'validation.sqlite')

/** END periods over LOCAL time: ld 07–19, le 19–23, ln 23–07. */
export type EndPeriod = 'ld' | 'le' | 'ln'
export const PERIOD_MINUTES_PER_DAY: Record<EndPeriod, number> = { ld: 720, le: 240, ln: 480 }

export function endPeriodForLocalHour(hour: number): EndPeriod {
  if (hour >= 7 && hour < 19) return 'ld'
  if (hour >= 19 && hour < 23) return 'le'
  return 'ln'
}

/** Energetic (logarithmic) mean of A-weighted levels: 10·log10(Σ10^(L/10)/n). */
export function energeticMeanDb(energySum: number, n: number): number | null {
  if (n <= 0 || !Number.isFinite(energySum) || energySum <= 0) return null
  return 10 * Math.log10(energySum / n)
}

/** END Lden from period levels (levels may be null when a period is silent/missing). */
export function ldenFromPeriods(ld: number | null, le: number | null, ln: number | null): number | null {
  if (ld == null || le == null || ln == null) return null
  const num = 12 * 10 ** (ld / 10) + 4 * 10 ** ((le + 5) / 10) + 8 * 10 ** ((ln + 10) / 10)
  return 10 * Math.log10(num / 24)
}

export function openValidationDb(): DatabaseSync {
  mkdirSync(VALIDATION_DATA_DIR, { recursive: true })
  const db = new DatabaseSync(SQLITE_PATH)
  db.exec(`
    CREATE TABLE IF NOT EXISTS station (
      network TEXT NOT NULL, station_id TEXT NOT NULL,
      name TEXT, lat REAL, lng REAL, meta_json TEXT,
      PRIMARY KEY (network, station_id)
    );
    -- Raw-but-compact layer: per station × LOCAL calendar day × END period,
    -- the linear-energy sum and the minute count it covers. The 1-minute
    -- source rows are never stored (a Barcelona month alone is 2.1 GB) —
    -- re-fetchable from the portal, this is the smallest faithful reduction.
    CREATE TABLE IF NOT EXISTS daily_period (
      network TEXT NOT NULL, station_id TEXT NOT NULL,
      date TEXT NOT NULL, period TEXT NOT NULL,
      energy_sum REAL NOT NULL, minutes INTEGER NOT NULL,
      PRIMARY KEY (network, station_id, date, period)
    );
    -- Normalized layer: one row per station × year × metric. Metric names:
    -- ld/le/ln/lden (END, computed) or documented window variants as-is
    -- (e.g. laeq_tag_0622 for ZRH Tag) — metric honesty, never fake-converted.
    CREATE TABLE IF NOT EXISTS annual_value (
      network TEXT NOT NULL, station_id TEXT NOT NULL, year INTEGER NOT NULL,
      metric TEXT NOT NULL, value REAL NOT NULL, meta_json TEXT,
      PRIMARY KEY (network, station_id, year, metric)
    );
  `)
  return db
}

export type SnapshotStation = {
  station_id: string
  name: string
  lat: number
  lng: number
  /** Per-network extras (dominant source tag, district, coverage…). */
  [key: string]: unknown
}

export type Snapshot = {
  network: string
  year: number
  license: string
  source: string[]
  fetched_at: string
  /**
   * Which model quantity the network's values compare against — same axis as
   * the fixture `mode`: 'total' for street/ambient mics, 'source:aircraft'
   * for event-classified airport NMTs, etc.
   */
  mode: 'total' | 'source:road' | 'source:railway' | 'source:industrial' | 'source:building' | 'source:aircraft'
  /** Rule-2 commensurability defaults for every station in this network. */
  commensurability: Record<string, unknown>
  method: string
  stations: SnapshotStation[]
}

export function writeSnapshot(snapshot: Snapshot): string {
  mkdirSync(SNAPSHOT_DIR, { recursive: true })
  const path = resolve(SNAPSHOT_DIR, `${snapshot.network}.${snapshot.year}.json`)
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n')
  return path
}

/** CKAN package_show → resources (Open Data BCN and friends). */
export async function ckanResources(portalBase: string, packageId: string): Promise<Array<{ name: string; url: string; format: string }>> {
  const r = await fetch(`${portalBase}/api/3/action/package_show?id=${packageId}`, { signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`CKAN package_show ${packageId}: HTTP ${r.status}`)
  const body = (await r.json()) as { success: boolean; result: { resources: Array<{ name: string; url: string; format: string }> } }
  if (!body.success) throw new Error(`CKAN package_show ${packageId}: success=false`)
  return body.result.resources
}

/** Minimal CSV line splitter for well-behaved portal CSVs (no embedded newlines). */
export function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',')
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') inQ = false
      else cur += c
    } else if (c === '"') inQ = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

export function assertDir(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  return path
}
