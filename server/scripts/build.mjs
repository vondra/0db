// Reproducible immutable server release: compile into a clean staging tree,
// add non-TS assets, validate syntax, then publish through a release symlink.
// Old Node processes resolve the symlink to their own immutable generation,
// so a lazy Worker can never mix old supervisor JS with a new worker asset.
import {
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  prepareRelease,
  pruneUnusedReleases,
  releaseRoot,
  serverRoot,
} from './release-layout.mjs'
import { ensureReleaseLock } from './release-lock.mjs'

ensureReleaseLock(fileURLToPath(import.meta.url))
const requireNative = process.argv.includes('--require-native')
const frontendArg = process.argv.indexOf('--frontend-dir')
const frontendSource = frontendArg >= 0 && process.argv[frontendArg + 1]
  ? resolve(serverRoot, process.argv[frontendArg + 1])
  : null
if (frontendArg >= 0 && !frontendSource) throw new Error('--frontend-dir requires a path')
mkdirSync(releaseRoot, { recursive: true })
const dependencyRoot = resolve(serverRoot, '..', '.server-deps')
mkdirSync(dependencyRoot, { recursive: true })
const dependencyHash = createHash('sha256')
  .update(readFileSync(resolve(serverRoot, 'package-lock.json')))
  .update(`\0${process.platform}\0${process.arch}\0${process.versions.modules}`)
  .digest('hex')
  .slice(0, 20)
const dependencySnapshot = resolve(dependencyRoot, `deps-${dependencyHash}`)
const dependencyModules = resolve(dependencySnapshot, 'node_modules')
if (!existsSync(resolve(dependencyModules, 'fastify/package.json'))) {
  const dependencyStage = resolve(dependencyRoot, `.stage-deps-${dependencyHash}-${process.pid}`)
  try {
    rmSync(dependencySnapshot, { recursive: true, force: true })
    rmSync(dependencyStage, { recursive: true, force: true })
    mkdirSync(dependencyStage, { recursive: true })
    cpSync(resolve(serverRoot, 'node_modules'), resolve(dependencyStage, 'node_modules'), {
      recursive: true,
      mode: fsConstants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
    })
    renameSync(dependencyStage, dependencySnapshot)
  } finally {
    rmSync(dependencyStage, { recursive: true, force: true })
  }
}
if (!statSync(dependencyModules).isDirectory()
  || !existsSync(resolve(dependencyModules, 'fastify/package.json'))) {
  throw new Error(`invalid server dependency snapshot: ${dependencySnapshot}`)
}
const releaseName = `release-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}-${process.pid}`
const stage = resolve(releaseRoot, `.stage-${releaseName}`)
const release = resolve(releaseRoot, releaseName)
let published = false
let prepared = false
process.once('exit', () => {
  rmSync(stage, { recursive: true, force: true })
  if (published && !prepared) rmSync(release, { recursive: true, force: true })
})
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
symlinkSync(relative(stage, dependencyModules), resolve(stage, 'node_modules'), 'dir')
cpSync(resolve(serverRoot, 'package.json'), resolve(stage, 'package.json'))

const tsc = resolve(serverRoot, 'node_modules/typescript/bin/tsc')
const compiled = spawnSync(process.execPath, [
  tsc,
  '--project',
  'tsconfig.build.json',
  '--outDir',
  stage,
  '--noEmitOnError',
], {
  cwd: serverRoot,
  stdio: 'inherit',
})
if (compiled.status !== 0) {
  rmSync(stage, { recursive: true, force: true })
  process.exit(compiled.status ?? 1)
}

const runtimeAssets = [
  ['src/workers/noise-onfly-worker.mjs', 'workers/noise-onfly-worker.mjs'],
  ['src/pages/validation.html', 'pages/validation.html'],
]
for (const [sourceRelative, destinationRelative] of runtimeAssets) {
  const source = resolve(serverRoot, sourceRelative)
  const destination = resolve(stage, destinationRelative)
  if (!existsSync(source)) throw new Error(`missing runtime asset: ${sourceRelative}`)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination)
}

if (frontendSource) {
  if (!existsSync(resolve(frontendSource, 'index.html'))) {
    throw new Error(`prepared frontend has no index.html: ${frontendSource}`)
  }
  cpSync(frontendSource, resolve(stage, 'frontend'), {
    recursive: true,
    mode: fsConstants.COPYFILE_FICLONE,
  })
}

const nativeSource = resolve(serverRoot, '..', 'engine/source-reader/target/release/libsource_reader.so')
if (existsSync(nativeSource) && statSync(nativeSource).isFile() && statSync(nativeSource).size > 0) {
  const nativeDestination = resolve(stage, 'native/libsource_reader.so')
  mkdirSync(dirname(nativeDestination), { recursive: true })
  cpSync(nativeSource, nativeDestination)
} else if (requireNative) {
  rmSync(stage, { recursive: true, force: true })
  throw new Error(`missing required native addon: ${nativeSource}`)
}

for (const relative of ['server.js', 'workers/noise-onfly-worker.mjs']) {
  const checked = spawnSync(process.execPath, ['--check', resolve(stage, relative)], {
    cwd: serverRoot,
    stdio: 'inherit',
  })
  if (checked.status !== 0) {
    rmSync(stage, { recursive: true, force: true })
    process.exit(checked.status ?? 1)
  }
}

renameSync(stage, release)
published = true
prepareRelease(release)
prepared = true
pruneUnusedReleases()
console.log(`prepared immutable server release ${release}`)
