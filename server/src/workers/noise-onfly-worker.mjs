import { parentPort, threadId, workerData } from 'node:worker_threads'
import { copyFileSync, existsSync, lstatSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)

const { sourceReaderPath, h3r4Dir } = workerData
const sourceReaderDir = dirname(sourceReaderPath)
const nodePath = resolve(sourceReaderDir, `libsource_reader.worker-${threadId}.node`)

if (!existsSync(sourceReaderPath)) {
  throw new Error(
    `libsource_reader.so not found at ${sourceReaderPath} — run: cd engine/source-reader && cargo build --release`,
  )
}

if (existsSync(nodePath) && lstatSync(nodePath).isSymbolicLink()) {
  unlinkSync(nodePath)
}

for (const entry of readdirSync(sourceReaderDir)) {
  if (!entry.startsWith('libsource_reader.worker-') || !entry.endsWith('.node')) {
    continue
  }
  if (entry === `libsource_reader.worker-${threadId}.node`) {
    continue
  }
  try {
    unlinkSync(resolve(sourceReaderDir, entry))
  } catch {
    // ignore stale addon cleanup failures
  }
}

copyFileSync(sourceReaderPath, nodePath)

const st = statSync(sourceReaderPath)
console.log(
  `noise-onfly-worker: loaded ${nodePath} ` +
  `(mtime=${st.mtime.toISOString()} size=${st.size})`,
)

const sourceModule = req(nodePath)
if (existsSync(h3r4Dir)) {
  const msg = sourceModule.sourceInit(h3r4Dir)
  console.log(`noise-onfly-worker: ${msg}`)
}

parentPort?.on('message', ({ id, lat, lng, op }) => {
  try {
    const fn = op === 'unfiltered'
      ? sourceModule.queryNoiseAtPointUnfiltered
      : sourceModule.queryNoiseAtPoint
    const resultJson = fn(lat, lng)
    parentPort?.postMessage({ id, ok: true, resultJson })
  } catch (err) {
    parentPort?.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
})
