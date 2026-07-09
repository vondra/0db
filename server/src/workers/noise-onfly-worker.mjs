// Noise-onfly NAPI worker: loads libsource_reader and answers point queries.
//
// Addon-copy invariant (2026-07-09): each pool SLOT owns one stable copy path
// (libsource_reader.worker-slot-N.node). Never per-thread paths: every
// DISTINCT PATH dlopen'd into the server process consumes glibc's fixed
// static-TLS surplus and worker terminate does NOT give it back —
// per-threadId copies made every recycle (request timeout, worker error)
// exhausted it after a few dozen recycles, after which EVERY worker spawn
// failed with "cannot allocate memory in static TLS block" and the popup
// 503'd until process restart (hit live on he84 2026-07-09). With a stable
// path, glibc keys the already-loaded object by name and returns the cached
// handle — no TLS growth, and also NO new code until process restart (the
// name match wins over the fresh inode — verified empirically 2026-07-09:
// unlink+copy then dlopen same path does NOT re-run constructors, 60×; the
// distinct-path variant is what exhausted TLS live on he84). The size/mtime
// check merely keeps the slot copy current for the NEXT server start without
// a 3.5 MB copy on every recycle. Details: docs/dev/binary-rebuild.md.

import { parentPort, threadId, workerData } from 'node:worker_threads'
import { copyFileSync, existsSync, lstatSync, readdirSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)

const { sourceReaderPath, h3r4Dir, slotIndex } = workerData
const sourceReaderDir = dirname(sourceReaderPath)
// threadId fallback keeps direct spawns working (distinct `tid-` prefix so
// the sweep below can reap them); the supervisor always passes slotIndex so
// pool recycles reuse one stable path per slot.
const nodePath = resolve(
  sourceReaderDir,
  slotIndex == null ? `libsource_reader.worker-tid-${threadId}.node` : `libsource_reader.worker-slot-${slotIndex}.node`,
)

if (!existsSync(sourceReaderPath)) {
  throw new Error(
    `libsource_reader.so not found at ${sourceReaderPath} — run: cd engine/source-reader && cargo build --release`,
  )
}

// Sweep legacy per-threadId copies (pre-slot-path era) AND stale tid-
// fallback copies from direct spawns; slot files are stable and must survive.
for (const entry of readdirSync(sourceReaderDir)) {
  if (!/^libsource_reader\.worker-(tid-)?\d+\.node$/.test(entry)) {
    continue
  }
  if (resolve(sourceReaderDir, entry) === nodePath) {
    continue
  }
  try {
    unlinkSync(resolve(sourceReaderDir, entry))
  } catch {
    // ignore stale addon cleanup failures
  }
}

const needsFreshCopy = () => {
  if (!existsSync(nodePath)) return true
  if (lstatSync(nodePath).isSymbolicLink()) return true
  const src = statSync(sourceReaderPath)
  const dst = statSync(nodePath)
  // Hard link to the source would defeat the whole point of copying (cargo
  // rewriting the .so would mutate the mapped file) — recopy to break it.
  if (src.dev === dst.dev && src.ino === dst.ino) return true
  // Copies get the source's mtime stamped on (utimesSync below), so mtime+size
  // equality means current. Plain `newer-than` would miss an rsync'd rebuild
  // that preserves an OLDER source mtime (rsync -t between hosts is a normal
  // flow here). Tolerance, not strict equality: utimesSync rounds the
  // sub-millisecond fraction (…238.8228 → …239 measured), strict !== would
  // recopy on every recycle.
  return src.size !== dst.size || Math.abs(src.mtimeMs - dst.mtimeMs) > 2
}
if (needsFreshCopy()) {
  // Unlink first: a NEW inode. Writing into the existing file would corrupt
  // code pages if any live worker still has it mapped.
  try {
    unlinkSync(nodePath)
  } catch {
    // first copy — nothing to unlink
  }
  copyFileSync(sourceReaderPath, nodePath)
  const src = statSync(sourceReaderPath)
  utimesSync(nodePath, src.atime, src.mtime)
}

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
