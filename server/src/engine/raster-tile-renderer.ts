import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'

type LayerId = 'dem' | 'building' | 'forest'

interface SourceTile {
  data: Int16Array | Uint8Array
  samples: number
}

const DATA_DIR = resolve(import.meta.dirname, '..', '..', '..', 'data', 'prepared')
const DEM_DIRS = [
  join(DATA_DIR, 'dem', 'copernicus'),
  join(DATA_DIR, 'dem', 'srtm'),
]
const BUILDING_DIR = join(DATA_DIR, 'rasters', 'building')
const FOREST_DIR = join(DATA_DIR, 'rasters', 'forest')

const MAX_TILES_PER_LAYER = 5
const tileCache = new Map<string, SourceTile | null>()
const tileLru: string[] = []

function evictIfNeeded(layer: LayerId): void {
  const prefix = layer + ':'
  let count = 0
  for (const k of tileLru) {
    if (k.startsWith(prefix)) count++
  }
  while (count >= MAX_TILES_PER_LAYER) {
    const idx = tileLru.findIndex(k => k.startsWith(prefix))
    if (idx === -1) break
    const key = tileLru.splice(idx, 1)[0]
    tileCache.delete(key)
    count--
  }
}

function tileName(latInt: number, lonInt: number, ext: string): string {
  const ns = latInt >= 0 ? 'N' : 'S'
  const ew = lonInt >= 0 ? 'E' : 'W'
  return `${ns}${String(Math.abs(latInt)).padStart(2, '0')}${ew}${String(Math.abs(lonInt)).padStart(3, '0')}.${ext}`
}

async function readSourceTile(layer: LayerId, latInt: number, lonInt: number): Promise<SourceTile | null> {
  const cacheKey = `${layer}:${latInt}:${lonInt}`
  if (tileCache.has(cacheKey)) {
    const idx = tileLru.indexOf(cacheKey)
    if (idx !== -1) { tileLru.splice(idx, 1); tileLru.push(cacheKey) }
    return tileCache.get(cacheKey)!
  }

  let tilePath: string | null = null
  if (layer === 'dem') {
    const fname = tileName(latInt, lonInt, 'hgt')
    for (const dir of DEM_DIRS) {
      const p = join(dir, fname)
      if (existsSync(p)) { tilePath = p; break }
    }
  } else {
    const dir = layer === 'building' ? BUILDING_DIR : FOREST_DIR
    const fname = tileName(latInt, lonInt, 'raw')
    const p = join(dir, fname)
    if (existsSync(p)) tilePath = p
  }

  if (!tilePath) {
    tileCache.set(cacheKey, null)
    return null
  }

  evictIfNeeded(layer)

  const buf = await readFile(tilePath)
  let tile: SourceTile

  if (layer === 'dem') {
    const data = new Int16Array(buf.byteLength / 2)
    for (let i = 0; i < data.length; i++) {
      data[i] = (buf[i * 2] << 8) | buf[i * 2 + 1]
      if (data[i] === -32768) data[i] = 0
    }
    tile = { data, samples: Math.round(Math.sqrt(data.length)) }
  } else {
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    tile = { data, samples: Math.round(Math.sqrt(data.length)) }
  }

  tileCache.set(cacheKey, tile)
  tileLru.push(cacheKey)
  return tile
}

function sampleNearest(tile: SourceTile, fracLat: number, fracLon: number): number {
  const s = tile.samples
  const row = Math.round((1.0 - fracLat) * (s - 1))
  const col = Math.round(fracLon * (s - 1))
  const r = Math.max(0, Math.min(s - 1, row))
  const c = Math.max(0, Math.min(s - 1, col))
  return tile.data[r * s + c]
}

function sampleBilinear(tile: SourceTile, fracLat: number, fracLon: number): number {
  const s = tile.samples
  const row = (1.0 - fracLat) * (s - 1)
  const col = fracLon * (s - 1)
  const ri = Math.min(Math.floor(row), s - 2)
  const ci = Math.min(Math.floor(col), s - 2)
  const rf = row - ri
  const cf = col - ci
  const v00 = tile.data[ri * s + ci]
  const v01 = tile.data[ri * s + ci + 1]
  const v10 = tile.data[(ri + 1) * s + ci]
  const v11 = tile.data[(ri + 1) * s + ci + 1]
  return v00 * (1 - cf) * (1 - rf) + v01 * cf * (1 - rf) + v10 * (1 - cf) * rf + v11 * cf * rf
}

// DEM colormap: green → tan → brown → gray → white
const DEM_STOPS: [number, number, number, number][] = [
  [0, 0x2d, 0x6a, 0x4f],
  [200, 0x74, 0xc6, 0x9d],
  [500, 0xd4, 0xa3, 0x73],
  [1000, 0xbc, 0x6c, 0x25],
  [2000, 0x8b, 0x8b, 0x8b],
  [4000, 0xf0, 0xf0, 0xf0],
]

function demColor(elev: number): [number, number, number, number] {
  if (elev <= 0) return [0x2d, 0x6a, 0x4f, 160]
  for (let i = 1; i < DEM_STOPS.length; i++) {
    if (elev <= DEM_STOPS[i][0]) {
      const [e0, r0, g0, b0] = DEM_STOPS[i - 1]
      const [e1, r1, g1, b1] = DEM_STOPS[i]
      const t = (elev - e0) / (e1 - e0)
      return [
        Math.round(r0 + t * (r1 - r0)),
        Math.round(g0 + t * (g1 - g0)),
        Math.round(b0 + t * (b1 - b0)),
        160,
      ]
    }
  }
  return [0xf0, 0xf0, 0xf0, 160]
}

function buildingColor(h: number): [number, number, number, number] {
  if (h === 0) return [0, 0, 0, 0]
  if (h <= 5) return [0xfe, 0xe0, 0x8b, 180]
  if (h <= 15) return [0xfd, 0xae, 0x61, 180]
  if (h <= 30) return [0xf4, 0x6d, 0x43, 180]
  if (h <= 60) return [0xd7, 0x30, 0x27, 180]
  return [0xa5, 0x00, 0x26, 180]
}

function forestColor(v: number): [number, number, number, number] {
  if (v === 0) return [0, 0, 0, 0]
  return [0x2d, 0x6a, 0x4f, 150]
}

function tileToLatLonBbox(z: number, x: number, y: number) {
  const n = 2 ** z
  const lonWest = (x / n) * 360 - 180
  const lonEast = ((x + 1) / n) * 360 - 180
  const latNorth = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * (180 / Math.PI)
  const latSouth = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * (180 / Math.PI)
  return { latNorth, latSouth, lonWest, lonEast }
}

type TileMap = Map<string, SourceTile | null>

async function collectSourceTiles(
  layer: LayerId, latSouth: number, latNorth: number, lonWest: number, lonEast: number,
): Promise<TileMap> {
  const tiles: TileMap = new Map()
  const latMin = Math.floor(latSouth)
  const latMax = Math.floor(latNorth)
  const lonMin = Math.floor(lonWest)
  const lonMax = Math.floor(lonEast)
  const promises: Promise<void>[] = []
  for (let lat = latMin; lat <= latMax; lat++) {
    for (let lon = lonMin; lon <= lonMax; lon++) {
      const key = `${lat}:${lon}`
      promises.push(readSourceTile(layer, lat, lon).then(t => { tiles.set(key, t) }))
    }
  }
  await Promise.all(promises)
  return tiles
}

export async function renderTile(layer: LayerId, z: number, x: number, y: number): Promise<Buffer> {
  const { latNorth, latSouth, lonWest, lonEast } = tileToLatLonBbox(z, x, y)
  const mercYNorth = Math.log(Math.tan(Math.PI / 4 + (latNorth * Math.PI) / 360))
  const mercYSouth = Math.log(Math.tan(Math.PI / 4 + (latSouth * Math.PI) / 360))
  const sourceTiles = await collectSourceTiles(layer, latSouth, latNorth, lonWest, lonEast)

  const W = 256
  const pixels = Buffer.alloc(W * W * 4)
  const colorFn = layer === 'dem' ? demColor : layer === 'building' ? buildingColor : forestColor
  const bilinear = layer === 'dem'

  for (let py = 0; py < W; py++) {
    const fracY = (py + 0.5) / W
    const mercY = mercYNorth + fracY * (mercYSouth - mercYNorth)
    const lat = (2 * Math.atan(Math.exp(mercY)) - Math.PI / 2) * (180 / Math.PI)

    for (let px = 0; px < W; px++) {
      const lon = lonWest + ((px + 0.5) / W) * (lonEast - lonWest)
      const latInt = Math.floor(lat)
      const lonInt = Math.floor(lon)
      const tile = sourceTiles.get(`${latInt}:${lonInt}`)
      let value = 0
      if (tile) {
        const fracLat = lat - latInt
        const fracLon = lon - lonInt
        value = bilinear ? sampleBilinear(tile, fracLat, fracLon) : sampleNearest(tile, fracLat, fracLon)
      }
      const [r, g, b, a] = colorFn(value)
      const off = (py * W + px) * 4
      pixels[off] = r
      pixels[off + 1] = g
      pixels[off + 2] = b
      pixels[off + 3] = a
    }
  }

  return encodePNG(W, W, pixels)
}

function encodePNG(width: number, height: number, rgba: Buffer): Buffer {
  const filtered = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    filtered[y * (1 + width * 4)] = 0 // filter: none
    rgba.copy(filtered, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const compressed = deflateSync(filtered, { level: 1 })

  const chunks: Buffer[] = []

  // PNG signature
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

  // IHDR
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type: RGBA
  chunks.push(pngChunk('IHDR', ihdr))

  // IDAT
  chunks.push(pngChunk('IDAT', compressed))

  // IEND
  chunks.push(pngChunk('IEND', Buffer.alloc(0)))

  return Buffer.concat(chunks)
}

function pngChunk(type: string, data: Buffer): Buffer {
  const buf = Buffer.alloc(12 + data.length)
  buf.writeUInt32BE(data.length, 0)
  buf.write(type, 4, 4, 'ascii')
  data.copy(buf, 8)
  const crcData = Buffer.alloc(4 + data.length)
  crcData.write(type, 0, 4, 'ascii')
  data.copy(crcData, 4)
  buf.writeUInt32BE(crc32(crcData) >>> 0, 8 + data.length)
  return buf
}

// Transparent 256×256 PNG cached once
let emptyPng: Buffer | null = null
export function getEmptyPng(): Buffer {
  if (!emptyPng) {
    emptyPng = encodePNG(256, 256, Buffer.alloc(256 * 256 * 4))
  }
  return emptyPng
}
