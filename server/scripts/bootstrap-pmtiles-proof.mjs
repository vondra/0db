#!/usr/bin/env node
// One-time transition for archives published by the pre-proof tile-store-pack.
// The old packer already computed every manifest sha256 after finalizing the
// immutable file. This command explicitly trusts that publisher attestation,
// binds it to the archive's current stat identity, and atomically replaces the
// manifest. It never reads archive content and never runs automatically.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { open, readFile, rename, rm, stat } from 'node:fs/promises'

const SHA256 = /^[a-f0-9]{64}$/

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function proof(info, sha256) {
  return {
    schema: 'sha256-posix-stat-v1',
    sha256,
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    size: info.size.toString(),
    mtime_ns: info.mtimeNs.toString(),
    ctime_ns: info.ctimeNs.toString(),
  }
}

export async function bootstrapPublisherProofs(pmtilesDir, expectedManifestSha256) {
  const manifestPath = join(pmtilesDir, 'current.json')
  const original = await readFile(manifestPath)
  const actualManifestSha256 = digest(original)
  if (actualManifestSha256 !== expectedManifestSha256) {
    throw new Error(
      `current.json changed: expected ${expectedManifestSha256}, got ${actualManifestSha256}`,
    )
  }
  const manifest = JSON.parse(original.toString('utf8'))
  if (!Number.isSafeInteger(manifest.created_unix) || manifest.created_unix <= 0) {
    throw new Error('current.json has no valid publisher created_unix')
  }
  if (!manifest.layers || typeof manifest.layers !== 'object') {
    throw new Error('current.json has no layers object')
  }

  // `created_unix` has one-second precision. A legacy archive whose ctime is
  // later than the end of that second was changed after the packer attested it.
  const publicationSecondEndNs = BigInt(manifest.created_unix + 1) * 1_000_000_000n
  for (const [layer, entry] of Object.entries(manifest.layers)) {
    if (!entry || typeof entry !== 'object'
      || typeof entry.file !== 'string' || basename(entry.file) !== entry.file
      || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
      throw new Error(`current.json layer ${layer} is not a valid legacy packer entry`)
    }
    if (entry.publisher_proof !== undefined) {
      throw new Error(`current.json layer ${layer} already has publisher_proof; refusing mixed bootstrap`)
    }
    const archive = await stat(join(pmtilesDir, entry.file), { bigint: true })
    if (!archive.isFile() || archive.size !== BigInt(entry.bytes)) {
      throw new Error(`current.json layer ${layer} archive does not match its published bytes`)
    }
    if (archive.ctimeNs >= publicationSecondEndNs) {
      throw new Error(`current.json layer ${layer} archive changed after legacy publication`)
    }
    entry.publisher_proof = proof(archive, entry.sha256)
  }

  // Detect even an out-of-band writer that ignores .pack.lock before rename.
  const beforePublish = await readFile(manifestPath)
  if (!beforePublish.equals(original)) throw new Error('current.json changed during proof bootstrap')

  const replacement = Buffer.from(`${JSON.stringify(manifest)}\n`)
  const manifestInfo = await stat(manifestPath)
  const temporary = join(pmtilesDir, `.current.json.publisher-proof-${process.pid}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', manifestInfo.mode & 0o777)
    await handle.writeFile(replacement)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, manifestPath)
    const directory = await open(pmtilesDir, 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    if (handle) await handle.close().catch(() => {})
    await rm(temporary, { force: true })
  }
  return { before: actualManifestSha256, after: digest(replacement) }
}

async function main() {
  const [directory, trustFlag, expectedFlag, expected] = process.argv.slice(2)
  if (trustFlag !== '--trust-existing-packer-output'
    || expectedFlag !== '--expected-manifest-sha256'
    || !expected || !SHA256.test(expected)) {
    throw new Error(
      'usage: bootstrap-pmtiles-proof.mjs <pmtiles-dir> '
      + '--trust-existing-packer-output --expected-manifest-sha256 <sha256>',
    )
  }
  const pmtilesDir = resolve(directory)
  if (process.env.QM_PACK_LOCK_HELD !== pmtilesDir) {
    const locked = spawnSync('flock', [
      '-n', '-E', '75', join(pmtilesDir, '.pack.lock'),
      process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2),
    ], {
      env: { ...process.env, QM_PACK_LOCK_HELD: pmtilesDir },
      stdio: 'inherit',
    })
    process.exit(locked.status ?? 1)
  }
  const result = await bootstrapPublisherProofs(pmtilesDir, expected)
  console.log(`publisher proofs bootstrapped atomically: ${result.before} -> ${result.after}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
