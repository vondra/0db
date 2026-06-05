/**
 * One-shot migration: add `{layer}_dataset_id: UInt16` (zeros) to every existing
 * per-hex Arrow file under data/prepared/{year}/h3r4/HEX/ for the four enrichable
 * layers (roads, railways, buildings, industrial).
 *
 * Idempotent: skips any arrow that already has the column (e.g. from a fresh
 * osm-extract after the finalize.rs change).
 *
 * Atomic via withArrowWrite() — tmp + rename, tolerates the running pipeline
 * worker's mmap readers (old mmap stays valid, new opens see the fresh file).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  makeTable,
  tableFromIPC,
  Uint16,
  vectorFromArray,
  type Table,
} from 'apache-arrow'
import { withArrowWrite } from '../lib/provenance.js'

const YEAR = process.env.DATA_YEAR || '2026'
const H3R4_DIR = `/home/vondra/0db-app/data/prepared/${YEAR}/h3r4`

type Layer = 'roads' | 'railways' | 'buildings' | 'industrial'
const LAYERS: Layer[] = ['roads', 'railways', 'buildings', 'industrial']

interface LayerCounts {
  added: number
  skipped: number
  errors: number
}

function newCounts(): LayerCounts {
  return { added: 0, skipped: 0, errors: 0 }
}

async function processFile(arrowPath: string, layer: Layer): Promise<'added' | 'skipped'> {
  // Peek at the schema first. If the column is already present, we can skip
  // the rewrite entirely (no lock, no tmp). This keeps the migration cheap on
  // fresh osm-extract output.
  const bytes = await fs.readFile(arrowPath)
  const table = tableFromIPC(bytes)
  const colName = `${layer}_dataset_id`
  if (table.schema.fields.some(f => f.name === colName)) {
    return 'skipped'
  }

  const nRows = table.numRows
  const zeros = new Uint16Array(nRows) // zero-initialized by default

  await withArrowWrite(arrowPath, (t: Table): Table => {
    // Re-check inside the lock — another process could have raced us.
    if (t.schema.fields.some(f => f.name === colName)) {
      return t
    }
    const columns: Record<string, any> = {}
    for (const field of t.schema.fields) {
      columns[field.name] = t.getChild(field.name)!
    }
    columns[colName] = vectorFromArray(zeros, new Uint16())
    return makeTable(columns)
  })

  return 'added'
}

async function main(): Promise<void> {
  const startMs = Date.now()
  const entries = await fs.readdir(H3R4_DIR, { withFileTypes: true })
  const hexDirs = entries.filter(e => e.isDirectory()).map(e => e.name)
  hexDirs.sort()

  const counts: Record<Layer, LayerCounts> = {
    roads: newCounts(),
    railways: newCounts(),
    buildings: newCounts(),
    industrial: newCounts(),
  }
  let totalErrors = 0

  let processed = 0
  for (const hex of hexDirs) {
    const hexDir = path.join(H3R4_DIR, hex)
    for (const layer of LAYERS) {
      const arrowPath = path.join(hexDir, `${layer}.arrow`)
      try {
        const st = await fs.stat(arrowPath)
        if (!st.isFile()) continue
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') continue
        counts[layer].errors++
        totalErrors++
        process.stderr.write(`[migrate] stat error ${arrowPath}: ${(err as Error).message}\n`)
        continue
      }

      try {
        const result = await processFile(arrowPath, layer)
        if (result === 'added') counts[layer].added++
        else counts[layer].skipped++
      } catch (err) {
        counts[layer].errors++
        totalErrors++
        process.stderr.write(`[migrate] error ${arrowPath}: ${(err as Error).message}\n`)
      }
    }

    processed++
    if (processed % 5000 === 0) {
      process.stderr.write(`[migrate] progress ${processed}/${hexDirs.length} hexes\n`)
    }
  }

  const wallMs = Date.now() - startMs
  const summary = {
    total_hexes: hexDirs.length,
    roads: { added: counts.roads.added, skipped: counts.roads.skipped },
    railways: { added: counts.railways.added, skipped: counts.railways.skipped },
    buildings: { added: counts.buildings.added, skipped: counts.buildings.skipped },
    industrial: { added: counts.industrial.added, skipped: counts.industrial.skipped },
    errors: totalErrors,
    errors_by_layer: {
      roads: counts.roads.errors,
      railways: counts.railways.errors,
      buildings: counts.buildings.errors,
      industrial: counts.industrial.errors,
    },
    wall_ms: wallMs,
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

main().catch(err => {
  process.stderr.write(`[migrate] fatal: ${(err as Error).stack || err}\n`)
  process.exit(1)
})
