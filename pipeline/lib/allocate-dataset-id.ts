/**
 * Prints a paste-ready Dataset entry with the next available id.
 * Usage: npx tsx pipeline/lib/allocate-dataset-id.ts <layer> <key>
 *
 * Example:
 *   npx tsx pipeline/lib/allocate-dataset-id.ts roads de-bast-bundesstrassen
 *
 * Does NOT edit enrichment-datasets.ts automatically — the developer pastes the
 * suggested entry themselves. This avoids text-editor tooling races when two
 * devs allocate at the same time and keeps the registry hand-curated.
 */

import { DATASETS, type Dataset } from './enrichment-datasets.js'

const [, , layerArg, keyArg] = process.argv

if (!layerArg || !keyArg) {
  console.error('Usage: npx tsx pipeline/lib/allocate-dataset-id.ts <layer> <key>')
  console.error('  layer: roads | railways | buildings | industrial | any')
  console.error('  key:   stable slug (lowercase, hyphenated)')
  process.exit(1)
}

const validLayers: Dataset['layer'][] = ['roads', 'railways', 'buildings', 'industrial', 'any']
if (!validLayers.includes(layerArg as Dataset['layer'])) {
  console.error(`invalid layer: ${layerArg}. expected one of: ${validLayers.join(', ')}`)
  process.exit(1)
}

const keyInUse = DATASETS.find((d: Dataset) => d.key === keyArg)
if (keyInUse) {
  console.error(`key "${keyArg}" already allocated to id=${keyInUse.id} (${keyInUse.name})`)
  process.exit(1)
}

const maxId = Math.max(...DATASETS.map((d: Dataset) => d.id))
const nextId = maxId + 1

const template: Dataset = {
  id: nextId,
  layer: layerArg as Dataset['layer'],
  key: keyArg,
  name: `TODO: human-readable name`,
  year: null,
  license: null,
  url: null,
  priority: layerArg === 'any' ? 0 : 50,
}

console.log('// paste into pipeline/lib/enrichment-datasets.ts')
console.log(JSON.stringify(template, null, 2).replace(/"([^"]+)":/g, '$1:'))
console.log(`\n// then edit name/year/license/url/priority as appropriate.`)
