import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const APPROVED_SNAPSHOT_MANIFEST = 'benchmarks/validation/approved-snapshots.v1.json'
const SNAPSHOT_FILENAME = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.(\d{4})\.json$/

export function validateApprovedSnapshotManifest(value, label = 'approved snapshot manifest') {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected an object`)
  if (value.version !== 1) throw new Error(`${label}: version must be 1`)
  if (!Array.isArray(value.files) || value.files.length === 0) throw new Error(`${label}: files must be a non-empty array`)
  const seen = new Set()
  for (const file of value.files) {
    if (typeof file !== 'string' || !SNAPSHOT_FILENAME.test(file)) {
      throw new Error(`${label}: unsafe snapshot filename ${JSON.stringify(file)}`)
    }
    if (seen.has(file)) throw new Error(`${label}: duplicate snapshot filename ${JSON.stringify(file)}`)
    seen.add(file)
  }
}

/** Critical identity checks shared by every plain-Node consumer. Full metric
 * semantics are additionally checked by validateSnapshot in pipeline code. */
export function validateApprovedSnapshotIdentity(value, file, label = file) {
  const match = SNAPSHOT_FILENAME.exec(file)
  if (!match) throw new Error(`${label}: unsafe snapshot filename`)
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: snapshot must be an object`)
  if (value.schema_version !== 2) throw new Error(`${label}: schema_version must be 2`)
  if (value.network !== match[1] || value.year !== Number(match[2])) {
    throw new Error(`${label}: filename and snapshot network/year disagree`)
  }
  if (!Array.isArray(value.stations) || value.stations.length === 0) throw new Error(`${label}: stations must be a non-empty array`)
  const stationIds = new Set()
  for (const station of value.stations) {
    const id = station?.station_id
    if (typeof id !== 'string' || id.length === 0 || id !== id.trim()
      || id !== id.normalize('NFC') || id.includes('/') || id.includes('\0')) {
      throw new Error(`${label}: unsafe station_id ${JSON.stringify(id)}`)
    }
    if (stationIds.has(id)) throw new Error(`${label}: duplicate station_id ${JSON.stringify(id)}`)
    stationIds.add(id)
  }
}

/** Explicit allow-list loader. It never scans snapshots/, so pending files stay invisible. */
export function loadApprovedSnapshots(repoRoot) {
  const manifestPath = resolve(repoRoot, APPROVED_SNAPSHOT_MANIFEST)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  validateApprovedSnapshotManifest(manifest, manifestPath)
  const snapshotDir = resolve(repoRoot, 'benchmarks/validation/snapshots')
  return manifest.files.map(file => {
    const path = resolve(snapshotDir, file)
    const snapshot = JSON.parse(readFileSync(path, 'utf8'))
    validateApprovedSnapshotIdentity(snapshot, file, path)
    return { file, path, snapshot }
  })
}
