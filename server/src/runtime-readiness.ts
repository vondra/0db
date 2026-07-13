// Readiness contract for the public server. Filesystem checks remain cheap
// and refresh periodically. Successful native probes have a short cache: this
// avoids making every monitor request contend with point queries while still
// detecting a worker that exits after startup.
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { ALLOWED_LAYERS, PMTILES_BASE } from './routes/heatmap-shared.js'
import { H3R4_DIR, SOURCE_READER_PATH } from './runtime-paths.js'

export type ReadinessComponent = 'engine' | 'prepared-data' | 'pmtiles'

export type ReadinessResult = {
  ready: boolean
  failed: ReadinessComponent[]
  /** Server logs only. Never include these strings in an HTTP response. */
  errors: Partial<Record<ReadinessComponent, string>>
}

export type ReadinessCheck = () => Promise<ReadinessResult>

type ReadinessOptions = {
  engineProbe: () => Promise<void>
  sourceReaderPath?: string
  h3r4Dir?: string
  pmtilesDir?: string
  now?: () => number
  filesystemCacheMs?: number
  engineRetryMs?: number
  engineSuccessCacheMs?: number
}

type FilesystemResult = Omit<ReadinessResult, 'ready'>

const REFERENCE_HEX = '841e309ffffffff' // Dobříš — committed project reference cell.

async function requireNonEmptyFile(filePath: string): Promise<void> {
  const info = await stat(filePath)
  if (!info.isFile() || info.size <= 0) {
    throw new Error(`${filePath} is not a non-empty regular file`)
  }
}

async function checkPreparedData(h3r4Dir: string): Promise<void> {
  const root = await stat(h3r4Dir)
  if (!root.isDirectory()) throw new Error(`${h3r4Dir} is not a directory`)
  // A fixed reference is deterministic and O(1); listing the global H3 tree
  // allocates tens of thousands of entries on every readiness refresh.
  await requireNonEmptyFile(join(h3r4Dir, REFERENCE_HEX, 'roads.arrow'))
}

type PublisherProof = {
  schema?: unknown
  sha256?: unknown
  dev?: unknown
  ino?: unknown
  size?: unknown
  mtime_ns?: unknown
  ctime_ns?: unknown
}
type ManifestLayer = {
  file?: unknown
  bytes?: unknown
  build?: unknown
  sha256?: unknown
  publisher_proof?: PublisherProof
}

const BUILD_ID = /^b[0-9]+$/
const SHA256 = /^[a-f0-9]{64}$/
const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/
const SIGNED_DECIMAL = /^(0|-?[1-9][0-9]*)$/

function proofInteger(
  value: unknown,
  field: string,
  manifestPath: string,
  layer: string,
  signed = false,
): bigint {
  if (typeof value !== 'string' || !(signed ? SIGNED_DECIMAL : UNSIGNED_DECIMAL).test(value)) {
    throw new Error(`${manifestPath} layer ${layer} has invalid publisher proof ${field}`)
  }
  return BigInt(value)
}

async function checkPmtiles(pmtilesDir: string): Promise<void> {
  const manifestPath = join(pmtilesDir, 'current.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    build?: unknown
    layers?: Record<string, ManifestLayer>
  }
  if (typeof manifest.build !== 'string' || !BUILD_ID.test(manifest.build)) {
    throw new Error(`${manifestPath} has an invalid build id`)
  }
  if (!manifest.layers || typeof manifest.layers !== 'object') {
    throw new Error(`${manifestPath} has no layers object`)
  }

  for (const layer of ALLOWED_LAYERS) {
    if (!(layer in manifest.layers)) {
      throw new Error(`${manifestPath} is missing layer ${layer}`)
    }
  }
  for (const [layer, entry] of Object.entries(manifest.layers)) {
    if (!entry || typeof entry.file !== 'string' || basename(entry.file) !== entry.file) {
      throw new Error(`${manifestPath} layer ${layer} has an unsafe file name`)
    }
    const expectedPrefix = `${layer}.`
    const filenameBuild = entry.file.startsWith(expectedPrefix) && entry.file.endsWith('.pmtiles')
      ? entry.file.slice(expectedPrefix.length, -'.pmtiles'.length)
      : ''
    if (!BUILD_ID.test(filenameBuild)) {
      throw new Error(`${manifestPath} layer ${layer} file does not match the served archive name`)
    }
    if (entry.build !== undefined) {
      if (typeof entry.build !== 'string' || !BUILD_ID.test(entry.build)) {
        throw new Error(`${manifestPath} layer ${layer} has an invalid build id`)
      }
      if (entry.build !== filenameBuild) {
        throw new Error(`${manifestPath} layer ${layer} build does not match its archive file`)
      }
    }
    if (!Number.isSafeInteger(entry.bytes) || (entry.bytes as number) <= 0) {
      throw new Error(`${manifestPath} layer ${layer} has invalid bytes`)
    }
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
      throw new Error(`${manifestPath} layer ${layer} has invalid sha256`)
    }
    const proof = entry.publisher_proof
    if (!proof || proof.schema !== 'sha256-posix-stat-v1' || proof.sha256 !== entry.sha256) {
      throw new Error(`${manifestPath} layer ${layer} has no matching publisher proof`)
    }
    const archivePath = join(pmtilesDir, entry.file)
    const archive = await stat(archivePath, { bigint: true })
    if (!archive.isFile() || archive.size !== BigInt(entry.bytes as number)) {
      throw new Error(`${archivePath} size ${archive.size} does not match manifest ${entry.bytes}`)
    }
    const expectedIdentity = {
      dev: proofInteger(proof.dev, 'dev', manifestPath, layer),
      ino: proofInteger(proof.ino, 'ino', manifestPath, layer),
      size: proofInteger(proof.size, 'size', manifestPath, layer),
      mtimeNs: proofInteger(proof.mtime_ns, 'mtime_ns', manifestPath, layer, true),
      ctimeNs: proofInteger(proof.ctime_ns, 'ctime_ns', manifestPath, layer, true),
    }
    if (expectedIdentity.dev !== archive.dev
      || expectedIdentity.ino !== archive.ino
      || expectedIdentity.size !== archive.size
      || expectedIdentity.mtimeNs !== archive.mtimeNs
      || expectedIdentity.ctimeNs !== archive.ctimeNs) {
      throw new Error(`${archivePath} identity does not match its sha256 publisher proof`)
    }
    if (expectedIdentity.size !== BigInt(entry.bytes as number)) {
      throw new Error(`${manifestPath} layer ${layer} publisher proof size does not match bytes`)
    }
  }
}

export function createReadinessCheck(options: ReadinessOptions): ReadinessCheck {
  const sourceReaderPath = options.sourceReaderPath ?? SOURCE_READER_PATH
  const h3r4Dir = options.h3r4Dir ?? H3R4_DIR
  const pmtilesDir = options.pmtilesDir ?? PMTILES_BASE
  const now = options.now ?? Date.now
  const filesystemCacheMs = options.filesystemCacheMs ?? 10_000
  const engineRetryMs = options.engineRetryMs ?? 5_000
  const engineSuccessCacheMs = options.engineSuccessCacheMs ?? 10_000

  let filesystemCache: { expiresAt: number; result: FilesystemResult } | null = null
  let engineReadyUntil = 0
  let engineRetryAt = 0
  let engineError = 'native engine has not completed its readiness probe'
  let inFlight: Promise<ReadinessResult> | null = null

  async function checkFilesystem(): Promise<FilesystemResult> {
    const timestamp = now()
    if (filesystemCache && timestamp < filesystemCache.expiresAt) return filesystemCache.result

    const failed: ReadinessComponent[] = []
    const errors: ReadinessResult['errors'] = {}
    const checks: Array<[ReadinessComponent, () => Promise<void>]> = [
      ['engine', () => requireNonEmptyFile(sourceReaderPath)],
      ['prepared-data', () => checkPreparedData(h3r4Dir)],
      ['pmtiles', () => checkPmtiles(pmtilesDir)],
    ]
    await Promise.all(checks.map(async ([component, check]) => {
      try {
        await check()
      } catch (error) {
        failed.push(component)
        errors[component] = error instanceof Error ? error.message : String(error)
      }
    }))
    failed.sort()
    const result = { failed, errors }
    // A transient startup failure must be observable again on the next probe;
    // start.sh retries readiness once a second. Successful stats are the only
    // results worth caching for the normal steady-state path.
    filesystemCache = failed.length === 0
      ? { expiresAt: timestamp + filesystemCacheMs, result }
      : null
    return result
  }

  return async () => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      const filesystem = await checkFilesystem()
      const failed = new Set(filesystem.failed)
      const errors = { ...filesystem.errors }

      // Do not spawn/dlopen a worker against paths already known to be bad.
      if (!failed.has('engine') && !failed.has('prepared-data')) {
        let engineReady = now() < engineReadyUntil
        if (!engineReady && now() >= engineRetryAt) {
          try {
            await options.engineProbe()
            engineReady = true
            engineReadyUntil = now() + engineSuccessCacheMs
            engineError = ''
          } catch (error) {
            engineReadyUntil = 0
            engineError = error instanceof Error ? error.message : String(error)
            engineRetryAt = now() + engineRetryMs
          }
        }
        if (!engineReady) {
          failed.add('engine')
          errors.engine = engineError
        }
      }

      const ordered = [...failed].sort() as ReadinessComponent[]
      return { ready: ordered.length === 0, failed: ordered, errors }
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }
}
