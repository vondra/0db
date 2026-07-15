// GET /api/tiles-manifest — the currently published pmtiles generation.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { PMTILES_BASE } from './heatmap-shared.js'

/**
 * Serve `current.json`, which the Rust packer publishes atomically after each
 * generation: `{build, created, layers: {<layer>: {file, sha256, tiles,
 * bytes}}}`. The packer's fields pass through verbatim — the manifest is the
 * single source of truth and reshaping it here would fork that truth
 * (JSON.parse below is a validity gate only, so a torn/corrupt file becomes a
 * 500 instead of garbage with a 200). ONE deployment field is added on top:
 * `tile_base` (env PUBLIC_TILE_BASE, e.g. https://t.0db.app) tells the
 * frontend which HOSTNAME serves the tiles — that is serving topology, which
 * the packer can't know and which must be changeable per checkout/host
 * without a frontend rebuild. Absent env = null = same-origin (devex,
 * localhost, canaries). `no-cache` so the frontend's 10-minute re-poll
 * revalidates instead of pinning an old generation; 404 = no build published
 * yet (the frontend then renders no tile layers).
 */
export async function tilesManifestRoutes(app: FastifyInstance): Promise<void> {
  const tileBase = (process.env.PUBLIC_TILE_BASE || '').replace(/\/$/, '') || null
  app.get('/api/tiles-manifest', async (_req, reply) => {
    reply.header('Cache-Control', 'no-cache')
    let raw: string
    try {
      raw = await readFile(join(PMTILES_BASE, 'current.json'), 'utf-8')
    } catch {
      return reply.code(404).send({ error: 'no build published' })
    }
    try {
      return { ...JSON.parse(raw), tile_base: tileBase }
    } catch (e) {
      app.log?.error?.(`tiles-manifest: current.json invalid: ${(e as Error).message}`)
      return reply.code(500).send({ error: 'manifest unreadable' })
    }
  })
}
