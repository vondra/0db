#!/usr/bin/env node
// Publisher-proof maintenance for the pmtiles manifest. Two explicit modes,
// neither ever runs automatically:
//
//   --trust-existing-packer-output   One-time transition for archives published
//       by the pre-proof tile-store-pack: trusts the old packer's manifest
//       sha256 attestation (never reads archive content) and binds it to the
//       archive's current stat identity.
//
//   --rebind-verified   Re-bind identities after a LEGITIMATE whole-archive
//       move (e.g. the 2026-07-14 Track D relocation of pmtiles/ from /data2
//       to /data1: rsync preserves mtime and bytes, but dev/ino/ctime change
//       by definition, so every sha256-posix-stat-v1 proof goes stale and
//       readiness hard-fails — hit live 2026-07-15, first qm-app restart
//       after the move). STRONGER trust anchor than the legacy mode: it
//       re-hashes every archive's full content and requires it to equal the
//       manifest sha256 before stamping the new identity — nothing is trusted
//       that isn't re-verified, so a tampered archive can't launder a fresh
//       proof through a "move".
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

  return atomicReplaceManifest(pmtilesDir, manifestPath, original, manifest, actualManifestSha256)
}

// Shared atomic tail for both modes: re-read to detect even an out-of-band
// writer that ignores .pack.lock, then write-fsync-rename-dirsync.
async function atomicReplaceManifest(pmtilesDir, manifestPath, original, manifest, beforeSha256) {
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
  return { before: beforeSha256, after: digest(replacement) }
}

// --rebind-verified: see the file header. Every archive is FULLY re-hashed and
// must equal the manifest sha256; identity is stat'd from the SAME open handle
// before and after the hash and must not change mid-read (the readiness
// checker's own "stable open file identity" discipline) — only then is the
// fresh identity stamped into the proof.
export async function rebindVerifiedProofs(pmtilesDir) {
  const manifestPath = join(pmtilesDir, 'current.json')
  const original = await readFile(manifestPath)
  const manifest = JSON.parse(original.toString('utf8'))
  if (!manifest.layers || typeof manifest.layers !== 'object') {
    throw new Error('current.json has no layers object')
  }
  for (const [layer, entry] of Object.entries(manifest.layers)) {
    if (!entry || typeof entry !== 'object'
      || typeof entry.file !== 'string' || basename(entry.file) !== entry.file
      || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
      throw new Error(`current.json layer ${layer} is not a valid packer entry`)
    }
    const proofBefore = entry.publisher_proof
    if (!proofBefore || proofBefore.schema !== 'sha256-posix-stat-v1' || proofBefore.sha256 !== entry.sha256) {
      throw new Error(
        `current.json layer ${layer} has no consistent publisher_proof — this mode only `
        + 're-binds a moved-but-already-proofed manifest (legacy manifests: --trust-existing-packer-output)',
      )
    }
    const handle = await open(join(pmtilesDir, entry.file), 'r')
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.size !== BigInt(entry.bytes)) {
        throw new Error(`current.json layer ${layer} archive size does not match its published bytes`)
      }
      const hash = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
      const actual = hash.digest('hex')
      if (actual !== entry.sha256) {
        throw new Error(`current.json layer ${layer} archive content sha256 ${actual} != manifest ${entry.sha256} — REFUSING to re-bind a changed archive`)
      }
      const after = await handle.stat({ bigint: true })
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw new Error(`current.json layer ${layer} archive changed while being verified`)
      }
      entry.publisher_proof = proof(after, entry.sha256)
    } finally {
      await handle.close().catch(() => {})
    }
  }
  return atomicReplaceManifest(pmtilesDir, manifestPath, original, manifest, digest(original))
}

async function main() {
  const [directory, modeFlag, expectedFlag, expected] = process.argv.slice(2)
  const legacy = modeFlag === '--trust-existing-packer-output'
    && expectedFlag === '--expected-manifest-sha256' && expected && SHA256.test(expected)
  const rebind = modeFlag === '--rebind-verified' && expectedFlag === undefined
  if (!legacy && !rebind) {
    throw new Error(
      'usage: bootstrap-pmtiles-proof.mjs <pmtiles-dir> '
      + '--trust-existing-packer-output --expected-manifest-sha256 <sha256>\n'
      + '   or: bootstrap-pmtiles-proof.mjs <pmtiles-dir> --rebind-verified',
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
  const result = legacy
    ? await bootstrapPublisherProofs(pmtilesDir, expected)
    : await rebindVerifiedProofs(pmtilesDir)
  console.log(`publisher proofs ${legacy ? 'bootstrapped' : 're-bound (content-verified)'} atomically: ${result.before} -> ${result.after}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
