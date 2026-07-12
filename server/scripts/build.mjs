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
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

const repoRoot = resolve(serverRoot, '..')

function runGit(args, encoding = 'utf8') {
  return spawnSync('git', args, {
    cwd: repoRoot,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Fingerprint every Git-visible source byte used to identify this release.
 * Sampling before and after the build prevents a concurrent commit or edit
 * from labelling mixed output as a clean release from the new commit.
 */
function sourceTreeIdentity() {
  const repository = runGit(['rev-parse', '--is-inside-work-tree'])
  if (repository.status !== 0 || repository.stdout.trim() !== 'true') {
    return { gitCommit: null, gitDirty: null, fingerprint: null }
  }

  const commit = runGit(['rev-parse', '--verify', 'HEAD'])
  const trackedDiff = runGit(['diff', '--no-ext-diff', '--binary', 'HEAD', '--'], null)
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z'])
  for (const result of [commit, trackedDiff, untracked]) {
    if (result.status !== 0) {
      throw new Error(`cannot fingerprint source tree: ${String(result.stderr).trim() || 'git command failed'}`)
    }
  }

  const untrackedPaths = untracked.stdout.split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')
    .update('tracked-diff\0')
    .update(trackedDiff.stdout)
  for (const path of untrackedPaths) {
    hash.update('\0untracked-path\0').update(path).update('\0content\0')
    hash.update(readFileSync(resolve(repoRoot, path)))
  }
  return {
    gitCommit: commit.stdout.trim(),
    gitDirty: trackedDiff.stdout.length > 0 || untrackedPaths.length > 0,
    fingerprint: hash.digest('hex'),
  }
}

const sourceIdentityBefore = sourceTreeIdentity()
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
  ['../pipeline/validation/comparison-runtime.mjs', 'validation-runtime/comparison-runtime.mjs'],
  ['../pipeline/validation/holdouts-runtime.mjs', 'validation-runtime/holdouts-runtime.mjs'],
  ['../pipeline/validation/server-identity.mjs', 'validation-runtime/server-identity.mjs'],
  ['../pipeline/validation/snapshot-loader.mjs', 'validation-runtime/snapshot-loader.mjs'],
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

const sourceIdentityAfter = sourceTreeIdentity()
if (JSON.stringify(sourceIdentityBefore) !== JSON.stringify(sourceIdentityAfter)) {
  throw new Error('source tree changed during server build; refusing to publish a mixed release')
}

const bundledNative = resolve(stage, 'native/libsource_reader.so')
const nativeSourceReaderSha256 = existsSync(bundledNative)
  ? createHash('sha256').update(readFileSync(bundledNative)).digest('hex')
  : null
const { parseRuntimeIdentity } = await import(
  pathToFileURL(resolve(stage, 'runtime-identity.js')).href
)
const runtimeIdentity = parseRuntimeIdentity({
  schema_version: 1,
  git_commit: sourceIdentityBefore.gitCommit,
  git_dirty: sourceIdentityBefore.gitDirty,
  built_at: new Date().toISOString(),
  native_source_reader_sha256: nativeSourceReaderSha256,
})
const runtimeIdentityPath = resolve(stage, 'runtime-identity.json')
writeFileSync(runtimeIdentityPath, `${JSON.stringify(runtimeIdentity, null, 2)}\n`, { flag: 'wx' })
// Validate the bytes that will be renamed into the immutable release, not only
// the in-memory value that produced them.
parseRuntimeIdentity(JSON.parse(readFileSync(runtimeIdentityPath, 'utf8')))

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
