/**
 * HM3 binary tile decoder (browser-side).
 *
 * Wire layout (header 20 B, little-endian) — mirror of
 * `engine/heatmap-aircraft/src/wire_hm3.rs`:
 *
 *  | offset | size | field                                |
 *  | ------ | ---- | ------------------------------------ |
 *  | 0      | 4    | magic "HM3 " (ASCII)                 |
 *  | 4      | 1    | version = 1                          |
 *  | 5      | 1    | n_periods = 1 (Lden only)            |
 *  | 6      | 1    | n_sources                            |
 *  | 7      | 1    | flags (bit 0: 1 = dense, 0 = sparse) |
 *  | 8      | 2    | grid_size (u16, = 256)               |
 *  | 10     | 1    | source_id                            |
 *  | 11     | 1    | quant_kind (= 1 → u8 × 0.5 dB)       |
 *  | 12     | 4    | non_empty_cells (u32)                |
 *  | 16     | 4    | payload_len (u32)                    |
 *  | 20     | ...  | zstd-compressed body                 |
 *
 * Decoded body is `TILE_PX × TILE_PX` `Uint8Array` of `u8 × 0.5 dB`
 * cells with `NO_DATA = 255` carrying transparency.
 */

export const TILE_PX = 256
export const NO_DATA = 255
export const HM3_HEADER_BYTES = 20
const MAGIC = 'HM3 '
const VERSION = 1
const QUANT_KIND_U8_HALF_DB = 1

export interface DecodedHM3Tile {
  /** `TILE_PX * TILE_PX` cells, row-major (py * 256 + px). 255 = no data. */
  cells: Uint8Array
  /** Decode-time metadata for downstream tooling. */
  sourceId: number
  nonEmptyCells: number
}

/**
 * Decode a tile byte → byte. Sentinel 255 stays 255 (no data);
 * everything else is the encoded dB × 2.
 */
export function dequantiseLden(byte: number): number {
  return byte === NO_DATA ? Number.NEGATIVE_INFINITY : byte / 2
}

/**
 * Fetch + decode one HM3 tile. Throws on header / version / body
 * mismatch — callers should catch and render an empty tile.
 */
export async function fetchAndDecodeHM3(url: string, signal?: AbortSignal): Promise<DecodedHM3Tile | null> {
  const res = await fetch(url, { signal })
  if (res.status === 204) return null
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  const buf = await res.arrayBuffer()
  return decodeHM3(buf)
}

export async function decodeHM3(buf: ArrayBuffer): Promise<DecodedHM3Tile> {
  if (buf.byteLength < HM3_HEADER_BYTES) {
    throw new Error(`HM3 too short: ${buf.byteLength} B`)
  }
  const view = new DataView(buf)
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  )
  if (magic !== MAGIC) throw new Error(`not HM3 (magic = "${magic}")`)
  const version = view.getUint8(4)
  if (version !== VERSION) throw new Error(`HM3 version ${version} != ${VERSION}`)
  const nPeriods = view.getUint8(5)
  if (nPeriods !== 1) throw new Error(`HM3 n_periods ${nPeriods} != 1`)
  const flags = view.getUint8(7)
  const isDense = (flags & 1) !== 0
  const gridSize = view.getUint16(8, true)
  if (gridSize !== TILE_PX) throw new Error(`HM3 grid ${gridSize} != ${TILE_PX}`)
  const sourceId = view.getUint8(10)
  const quantKind = view.getUint8(11)
  if (quantKind !== QUANT_KIND_U8_HALF_DB) {
    throw new Error(`HM3 quant_kind ${quantKind} unsupported`)
  }
  const nonEmptyCells = view.getUint32(12, true)
  // payload_len redundant once we have the slice — use it as a sanity check.
  const payloadLen = view.getUint32(16, true)
  const compressed = new Uint8Array(buf, HM3_HEADER_BYTES, payloadLen)
  const body = await zstdDecompress(compressed)

  const cells = new Uint8Array(TILE_PX * TILE_PX).fill(NO_DATA)
  if (isDense) {
    if (body.byteLength !== TILE_PX * TILE_PX) {
      throw new Error(`HM3 dense body ${body.byteLength} != ${TILE_PX * TILE_PX}`)
    }
    cells.set(body)
  } else {
    if (body.byteLength < 32) throw new Error('HM3 sparse body < 32 B mask')
    const mask = body.subarray(0, 32)
    let offset = 32
    for (let py = 0; py < TILE_PX; py++) {
      if ((mask[py >> 3] & (1 << (py & 7))) === 0) continue
      if (offset + TILE_PX > body.byteLength) {
        throw new Error(`HM3 sparse body truncated at row ${py}`)
      }
      cells.set(body.subarray(offset, offset + TILE_PX), py * TILE_PX)
      offset += TILE_PX
    }
  }
  return { cells, sourceId, nonEmptyCells }
}

/**
 * Zstd decompression with a JS fallback.
 *
 * Native [`DecompressionStream('zstd')`] is the fast path (Chrome 127+ /
 * Firefox 126+ / Safari 18+); when missing or rejected (older Chromium,
 * test browsers) we fall back to [`fzstd`] — a ~10 kB pure-JS decoder
 * that imports lazily so it doesn't tax the cold-load bundle.
 *
 * The native-fail probe is per-process: the first miss flips a static
 * flag so subsequent tiles skip straight to fzstd.
 */
let nativeZstdBroken = false

async function zstdDecompress(data: Uint8Array): Promise<Uint8Array> {
  if (!nativeZstdBroken && typeof DecompressionStream !== 'undefined') {
    try {
      const Ctor = DecompressionStream as unknown as new (fmt: string) => GenericTransformStream
      const ds = new Ctor('zstd')
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds)
      const out = await new Response(stream).arrayBuffer()
      return new Uint8Array(out)
    } catch (e) {
      nativeZstdBroken = true
      console.info('hm3: native zstd unavailable, falling back to fzstd', e)
    }
  }
  const { decompress } = await import('fzstd')
  return decompress(data)
}
