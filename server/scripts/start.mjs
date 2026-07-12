import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveNamedRelease } from './release-layout.mjs'

const selectedRelease = process.env.SERVER_DIST ?? 'dist'
if (selectedRelease !== 'dist' && selectedRelease !== 'dist.next') {
  throw new Error(`invalid SERVER_DIST ${JSON.stringify(selectedRelease)}`)
}
await import(pathToFileURL(resolve(resolveNamedRelease(selectedRelease), 'server.js')).href)
