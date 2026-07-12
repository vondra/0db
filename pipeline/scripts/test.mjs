// Deterministic pipeline unit-test discovery. The city-polygon integration
// test downloads national boundary datasets when its cache is cold, so the
// required fast gate excludes it; `npm run test:all` opts into network I/O.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pipelineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function collect(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const absolute = resolve(dir, entry.name)
    if (entry.isDirectory()) files.push(...collect(absolute))
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(absolute)
  }
  return files
}

const includeNetwork = process.env.INCLUDE_NETWORK_TESTS === '1'
const tests = collect(pipelineRoot)
  .map((file) => relative(pipelineRoot, file))
  .filter((file) => includeNetwork || file !== 'lib/city-polygon.test.ts')
  .sort()

if (tests.length === 0) throw new Error('no pipeline tests discovered')
console.log(`pipeline tests: ${tests.length} files${includeNetwork ? ' (network integration included)' : ' (offline)'}`)
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], {
  cwd: pipelineRoot,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
