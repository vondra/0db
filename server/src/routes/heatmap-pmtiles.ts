// Versioned heatmap tile route — serves HM3 tiles out of per-layer pmtiles
// archives (`data/tiles/{year}/pmtiles/{layer}.{build}.pmtiles`) instead of
// loose .bin files. A build ("b0", "b1", …) is an immutable published
// generation, so both hits and misses are cached hard by the browser.

import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import type { FastifyInstance } from 'fastify'
import {
  Compression,
  PMTiles,
  SharedPromiseCache,
  type RangeResponse,
  type Source,
} from 'pmtiles'
import { parseTileParams, PMTILES_BASE } from './heatmap-shared.js'

const gunzipAsync = promisify(gunzip)

const BUILD_ID = /^b\d+$/

// ~4 generations x 8 layers. Beyond this the oldest archive's file handle is
// closed — old builds stop being requested minutes after a manifest flip, so
// in practice this never evicts a hot entry.
const ARCHIVE_CACHE_MAX = 32

/**
 * pmtiles `Source` over a positional-read `FileHandle` (pread — safe under the
 * concurrent header/directory/tile reads one PMTiles instance issues). The npm
 * lib ships only browser-side sources (FetchSource over HTTP, FileSource over
 * the File API), so the Node file-backed source lives here.
 */
class FileHandleSource implements Source {
  constructor(private readonly handle: FileHandle, private readonly path: string) {}

  getKey(): string {
    return this.path
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const data = new ArrayBuffer(length)
    const { bytesRead } = await this.handle.read(new Uint8Array(data), 0, length, offset)
    // Short read = EOF clamp: the lib's initial header probe asks for 16 KiB
    // unconditionally, which overshoots on a near-empty archive. Exact-length
    // directory/tile reads only come up short on a truncated file, and then the
    // directory/tile parse fails loudly right after.
    return bytesRead === length ? { data } : { data: data.slice(0, bytesRead) }
  }
}

/**
 * Decompressor for our archives: gunzip directories, pass tile bytes through.
 *
 * The pmtiles lib runs this over BOTH internal directories (internalCompression,
 * gzip — the packer's default) and tile entries (tileCompression). Tile bytes
 * are whole-file-Brotli HM3 that the route ships verbatim with
 * `Content-Encoding: br` (browser inflates in its network stack; server stays a
 * dumb byte reader), so Brotli passthrough here is the point, not an omission.
 * `openHeatmapArchive` rejects any archive whose header contradicts these
 * assumptions instead of ever serving corrupt bytes.
 */
async function gunzipDirectoriesPassthroughTiles(
  buf: ArrayBuffer,
  compression: Compression,
): Promise<ArrayBuffer> {
  if (compression === Compression.Gzip) {
    const out = await gunzipAsync(buf)
    const copy = new ArrayBuffer(out.byteLength)
    new Uint8Array(copy).set(out)
    return copy
  }
  if (compression === Compression.Zstd) throw new Error('zstd archives not supported')
  return buf // None | Unknown | Brotli → verbatim
}

type OpenArchive = { pmtiles: PMTiles; handle: FileHandle }

// One PMTiles instance per (build, layer): its SharedPromiseCache keeps the
// parsed header + directories in memory, so a tile request costs one pread.
const archiveCache = new Map<string, Promise<OpenArchive>>()

async function openHeatmapArchive(path: string): Promise<OpenArchive> {
  const handle = await open(path, 'r')
  try {
    const pmtiles = new PMTiles(
      new FileHandleSource(handle, path),
      new SharedPromiseCache(100, true, gunzipDirectoriesPassthroughTiles),
      gunzipDirectoriesPassthroughTiles,
    )
    const header = await pmtiles.getHeader()
    // Fail loud at open (500 + log) rather than serve corrupt bytes: verbatim
    // Brotli shipping is only correct while the packer keeps gzip directories
    // and Brotli (or undeclared) tile entries.
    if (header.internalCompression !== Compression.Gzip
      && header.internalCompression !== Compression.None
      && header.internalCompression !== Compression.Unknown) {
      throw new Error(`unsupported internal compression ${header.internalCompression}`)
    }
    if (header.tileCompression === Compression.Gzip || header.tileCompression === Compression.Zstd) {
      throw new Error(`tile compression ${header.tileCompression} contradicts verbatim-Brotli serving`)
    }
    return { pmtiles, handle }
  } catch (e) {
    await handle.close().catch(() => {})
    throw e
  }
}

function getHeatmapArchive(build: string, layer: string): Promise<OpenArchive> {
  const key = `${build}/${layer}`
  const cached = archiveCache.get(key)
  if (cached) return cached
  const entry = openHeatmapArchive(join(PMTILES_BASE, `${layer}.${build}.pmtiles`))
  archiveCache.set(key, entry)
  // A failed open is not cached: the archive may simply not be packed yet.
  entry.catch(() => archiveCache.delete(key))
  if (archiveCache.size > ARCHIVE_CACHE_MAX) {
    const oldestKey = archiveCache.keys().next().value // Map iterates in insertion order
    if (oldestKey !== undefined && oldestKey !== key) {
      const evicted = archiveCache.get(oldestKey)
      archiveCache.delete(oldestKey)
      evicted?.then((a) => a.handle.close()).catch(() => {})
    }
  }
  return entry
}

/**
 * GET /api/heatmap-v3/:build/:layer/:z/:x/:y.bin
 *
 * Same wire contract as the loose-file route (raw HM3 v2 bytes, whole-file
 * Brotli, `Content-Encoding: br`), but addressed inside an immutable build:
 * hits AND misses get `max-age=31536000, immutable` — for a published
 * generation a missing tile is a permanent fact, and the frontend re-keys the
 * URL on the next build anyway. The loose-file route stays registered for
 * dual-read during the migration.
 */
export async function heatmapPmtilesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { build: string; layer: string; z: string; x: string; y: string } }>(
    '/api/heatmap-v3/:build/:layer/:z/:x/:y.bin',
    // Bodies are already Brotli (served with Content-Encoding: br) — opt out of
    // @fastify/compress so it doesn't re-compress incompressible bytes.
    { compress: false },
    async (req, reply) => {
      if (!BUILD_ID.test(req.params.build)) return reply.code(404).send('unknown build')
      const parsed = parseTileParams(req.params)
      if (typeof parsed === 'string') return reply.code(400).send(parsed)
      const { build } = req.params
      const { layer, z, x, y } = parsed

      let archive: OpenArchive
      try {
        archive = await getHeatmapArchive(build, layer)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.code(404).send('no such archive')
        }
        reply.header('Cache-Control', 'no-store') // don't cache a transient failure
        app.log?.error?.(`heatmap-pmtiles open ${layer}.${build}: ${(e as Error).message}`)
        return reply.code(500).send('archive open failed')
      }

      let tile: RangeResponse | undefined
      try {
        // getZxy maps (z,x,y) → the archive's Hilbert tileId and walks the
        // root/leaf directories; undefined = no entry for this build. Bytes
        // come back verbatim (see gunzipDirectoriesPassthroughTiles).
        tile = await archive.pmtiles.getZxy(z, x, y)
      } catch (e) {
        reply.header('Cache-Control', 'no-store')
        app.log?.error?.(`heatmap-pmtiles read ${layer}.${build}/${z}/${x}/${y}: ${(e as Error).message}`)
        return reply.code(500).send('read failed')
      }

      // Published generations are immutable → cache the miss as hard as the hit.
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      if (tile === undefined) return reply.code(204).send()
      // application/octet-stream — the body is a custom binary format (HM3),
      // stored as a whole-file Brotli stream; declare it so the browser
      // decompresses natively. Set AFTER the 204 so a miss has no encoding.
      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Encoding', 'br')
      return reply.send(Buffer.from(tile.data))
    },
  )
}
