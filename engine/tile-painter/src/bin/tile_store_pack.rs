//! tile-store-pack — publish one BUILD: every layer store → `{layer}.{build}.pmtiles`
//! + an atomically-swapped `current.json` manifest (the ops + serving pointer).
//!
//! `--layer L` (repeatable) packs ONLY those layers and MERGES the manifest —
//! untouched layers keep their previous archive + build id. Pack multiple
//! layers in ONE invocation (they parallelise internally); two concurrent
//! PARTIAL packs would race the manifest read-modify-write.
//!
//! Ship-out is codec-blind via [`TileStore::get_hm3_by_entry`], and — since
//! the 2026-07-16 publish-speed fix — a straight VERBATIM copy for the
//! overwhelming majority of entries: `BrotliHm3` blobs ship untouched whether
//! they came from the fleet (source-layer ingest) or from a central writer
//! (`build_heatmap_combine`, `pyramid::build_one_level`, which now encode
//! Brotli-q9 once at write time via `TileStore::put_cells_hm3` instead of
//! deferring it here). Only a legacy `ZstdCells` entry — a central tile a
//! store hasn't been rewritten through since the cutover — still gets
//! composed + Brotli-encoded on this path; that population only shrinks as
//! stores get touched again. Integrity is no longer re-checked per tile here:
//! `worldctl publish` runs the MANDATORY `tile-store-fsck` gate over every
//! layer before this binary ever starts (see that tool's module doc). The
//! pmtiles header declares `tile_compression = brotli` via a passthrough
//! codec (bytes are added pre-compressed); internal directories stay gzip
//! (default) so the npm `pmtiles` reader decodes them natively.
//!
//! Tiles are fed in ascending pmtiles TileId order (the spec's Hilbert-derived
//! id) → a clustered archive; the writer dedups identical blobs (xxhash64 of
//! the bytes — hash-based, not byte-verified, the pmtiles-ecosystem standard),
//! which collapses the uniform low-dB halo tiles for free.
//!
//! Published files are IMMUTABLE: an existing `{layer}.{build}.pmtiles` is a
//! hard error, never overwritten. The manifest is written last, tmp + atomic
//! rename — a crash mid-pack leaves the previous build fully live.
//!
//! Usage: tile-store-pack <store-root> <out-dir> <build-id>
//!   e.g.  tile-store-pack data/tiles/2026/store \
//!                         data/tiles/2026/pmtiles  b0

use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use pmtiles::{Compression, Compressor, PmTilesWriter, PmtResult, TileCoord, TileType};
use rayon::prelude::*;
use sha2::{Digest, Sha256};

use tile_painter::tile_store::manifest::is_safe_archive_filename;
use tile_painter::tile_store::{detect_layers, detect_zooms, Entry, TileStore};

/// Declares Brotli in the pmtiles header while passing bytes through verbatim —
/// everything this packer adds is already a whole-file-Brotli HM3 image.
struct BrotliPassthrough;

impl Compressor for BrotliPassthrough {
    fn compression(&self) -> Compression {
        Compression::Brotli
    }
    fn compress(
        &self,
        f: &mut dyn FnMut(&mut dyn Write) -> std::io::Result<()>,
        writer: &mut dyn Write,
    ) -> PmtResult<()> {
        f(writer)?;
        Ok(())
    }
}

struct LayerResult {
    layer: String,
    file: String,
    sha256: String,
    tiles: u64,
    bytes: u64,
    publisher_proof: PublisherProof,
}

#[derive(Debug, Eq, PartialEq)]
struct PublisherProof {
    dev: u64,
    ino: u64,
    size: u64,
    mtime_ns: i128,
    ctime_ns: i128,
}

const PUBLISHER_PROOF_SCHEMA: &str = "sha256-posix-stat-v1";

impl PublisherProof {
    fn from_metadata(path: &Path, metadata: &fs::Metadata) -> Result<Self> {
        if !metadata.is_file() {
            bail!("{} is not a regular file", path.display());
        }
        Ok(Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            size: metadata.size(),
            mtime_ns: i128::from(metadata.mtime()) * 1_000_000_000
                + i128::from(metadata.mtime_nsec()),
            ctime_ns: i128::from(metadata.ctime()) * 1_000_000_000
                + i128::from(metadata.ctime_nsec()),
        })
    }

    fn read(path: &Path) -> Result<Self> {
        Self::from_metadata(path, &fs::metadata(path)?)
    }
}

fn proof_u64(proof: &serde_json::Map<String, serde_json::Value>, field: &str) -> Result<u64> {
    let value = proof
        .get(field)
        .and_then(|value| value.as_str())
        .with_context(|| format!("publisher_proof.{field} must be a decimal string"))?;
    let parsed: u64 = value
        .parse()
        .with_context(|| format!("publisher_proof.{field} is not u64 decimal"))?;
    if parsed.to_string() != value {
        bail!("publisher_proof.{field} is not canonical decimal");
    }
    Ok(parsed)
}

fn proof_i128(proof: &serde_json::Map<String, serde_json::Value>, field: &str) -> Result<i128> {
    let value = proof
        .get(field)
        .and_then(|value| value.as_str())
        .with_context(|| format!("publisher_proof.{field} must be a decimal string"))?;
    let parsed: i128 = value
        .parse()
        .with_context(|| format!("publisher_proof.{field} is not signed decimal"))?;
    if parsed.to_string() != value {
        bail!("publisher_proof.{field} is not canonical decimal");
    }
    Ok(parsed)
}

fn validate_manifest_entry(out_dir: &Path, layer: &str, value: &serde_json::Value) -> Result<()> {
    let entry = value
        .as_object()
        .with_context(|| format!("manifest layer {layer} is not an object"))?;
    let file = entry
        .get("file")
        .and_then(|value| value.as_str())
        .with_context(|| format!("manifest layer {layer} has no file"))?;
    if !is_safe_archive_filename(file) {
        bail!("manifest layer {layer} has unsafe file name {file:?}");
    }
    let prefix = format!("{layer}.");
    let filename_build = file
        .strip_prefix(&prefix)
        .and_then(|name| name.strip_suffix(".pmtiles"))
        .unwrap_or("");
    if !filename_build.starts_with('b')
        || filename_build.len() < 2
        || !filename_build[1..].chars().all(|c| c.is_ascii_digit())
    {
        bail!("manifest layer {layer} file does not contain a valid build id");
    }
    if let Some(build) = entry.get("build") {
        if build.as_str() != Some(filename_build) {
            bail!("manifest layer {layer} build does not match its archive file");
        }
    }
    let bytes = entry
        .get("bytes")
        .and_then(|value| value.as_u64())
        .with_context(|| format!("manifest layer {layer} has invalid bytes"))?;
    let sha256 = entry
        .get("sha256")
        .and_then(|value| value.as_str())
        .with_context(|| format!("manifest layer {layer} has no sha256"))?;
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("manifest layer {layer} has invalid sha256");
    }
    let proof = entry
        .get("publisher_proof")
        .and_then(|value| value.as_object())
        .with_context(|| format!("manifest layer {layer} has no publisher_proof"))?;
    if proof.get("schema").and_then(|value| value.as_str()) != Some(PUBLISHER_PROOF_SCHEMA)
        || proof.get("sha256").and_then(|value| value.as_str()) != Some(sha256)
    {
        bail!("manifest layer {layer} publisher_proof is not bound to sha256");
    }
    let expected = PublisherProof {
        dev: proof_u64(proof, "dev")?,
        ino: proof_u64(proof, "ino")?,
        size: proof_u64(proof, "size")?,
        mtime_ns: proof_i128(proof, "mtime_ns")?,
        ctime_ns: proof_i128(proof, "ctime_ns")?,
    };
    if expected.size != bytes {
        bail!("manifest layer {layer} publisher_proof size does not match bytes");
    }
    let archive_path = out_dir.join(file);
    let actual = PublisherProof::read(&archive_path)?;
    if actual != expected {
        bail!(
            "manifest layer {layer} publisher_proof does not match {}",
            archive_path.display()
        );
    }
    Ok(())
}

fn validate_manifest_layers(
    out_dir: &Path,
    layers: &serde_json::Map<String, serde_json::Value>,
    replacing: Option<&[String]>,
) -> Result<()> {
    for (layer, entry) in layers {
        if replacing.is_some_and(|names| names.iter().any(|name| name == layer)) {
            continue;
        }
        validate_manifest_entry(out_dir, layer, entry)?;
    }
    Ok(())
}

fn main() -> Result<()> {
    // usage: tile-store-pack <store-root> <out-dir> <build-id> [--layer L]...
    // With --layer, only the named layers are packed and the manifest MERGES:
    // untouched layers keep their previous archive + build id — a road-only
    // republish costs one layer's Brotli, not all eight (owner ask 2026-07-09).
    let mut positional: Vec<String> = Vec::new();
    let mut only: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--layer" {
            only.push(args.next().context("--layer needs a value")?);
        } else {
            positional.push(a);
        }
    }
    let [store_root, out_dir, build]: [String; 3] = positional.try_into().map_err(|_| {
        anyhow::anyhow!(
            "usage: tile-store-pack <store-root> <out-dir> <build-id (b<N>)> [--layer L]..."
        )
    })?;
    if !build.starts_with('b') || !build[1..].chars().all(|c| c.is_ascii_digit()) || build.len() < 2
    {
        bail!("build id must be b<N>, got {build:?}");
    }
    let store_root = PathBuf::from(store_root);
    let out_dir = PathBuf::from(out_dir);
    fs::create_dir_all(&out_dir)?;

    let mut layers = detect_layers(&store_root)?;
    if layers.is_empty() {
        bail!("no layer stores under {}", store_root.display());
    }
    let partial = !only.is_empty();
    // Serialize whole partial packs on a lock file: the manifest merge is
    // read-modify-write, and two concurrent partials would drop each other's
    // entries (and clash on the same-build temp name). Held for the process
    // lifetime; full packs take it too so a full and a partial cannot
    // interleave either (/gg consensus).
    let _pack_lock = {
        let lock = File::create(out_dir.join(".pack.lock"))?;
        if unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&lock), libc::LOCK_EX) } != 0 {
            bail!("flock .pack.lock: {}", std::io::Error::last_os_error());
        }
        lock
    };
    if partial {
        for l in &only {
            if !layers.contains(l) {
                bail!("--layer {l}: no store under {}", store_root.display());
            }
        }
        layers.retain(|l| only.contains(l));
        // Preflight the merge base BEFORE any (immutable) archive is written —
        // discovering a missing manifest after the pack leaves undeletable
        // {layer}.{build}.pmtiles behind and burns the build id (/gg Codex).
        let manifest = out_dir.join("current.json");
        if !manifest.exists() {
            bail!(
                "partial pack needs an existing {} to merge over — run a full pack first",
                manifest.display()
            );
        }
        let previous: serde_json::Value = serde_json::from_str(&fs::read_to_string(&manifest)?)?;
        let previous_layers = previous
            .get("layers")
            .and_then(|value| value.as_object())
            .context("current.json has no layers object")?;
        // Validate every entry the partial pack will retain BEFORE spending
        // hours writing a new immutable archive. Selected layers are replaced
        // by fresh, post-hash proofs below.
        validate_manifest_layers(&out_dir, previous_layers, Some(&only))?;
    }
    eprintln!(
        "pack {build}: {} layers{} → {}",
        layers.len(),
        if partial {
            " (partial — manifest merges)"
        } else {
            ""
        },
        out_dir.display()
    );

    // One pmtiles writer per layer, layers in parallel; INSIDE each layer the
    // ordered-prefetch pipeline (see pack_layer) keeps every core reading —
    // and, for any still-legacy ZstdCells entry, re-encoding — while the
    // single format-mandated writer streams in id order.
    let mut results: Vec<LayerResult> = layers
        .par_iter()
        .map(|layer| pack_layer(&store_root.join(layer), layer, &out_dir, &build))
        .collect::<Result<_>>()?;
    results.sort_by(|a, b| a.layer.cmp(&b.layer));

    write_manifest(&out_dir, &build, &results, partial)?;
    // Deletion no longer happens here (2026-07-16 Track 2 rewrite — docs/dev/
    // checkout-restructure-plan.md). Per-environment pins (`current.{env}.json`) mean a
    // prod pointer can legitimately lag dev by many publishes; this pack's old
    // "keep new+previous" retention would 404 a stale-but-still-live pin the moment TWO
    // publishes happened after it. Retention is now `tile-store-gc`'s job: it proves an
    // archive unreferenced by EVERY environment pointer + a bounded history before
    // removing it, instead of this binary guessing from build numbers the instant it
    // finishes packing.
    let total_tiles: u64 = results.iter().map(|r| r.tiles).sum();
    let total_bytes: u64 = results.iter().map(|r| r.bytes).sum();
    eprintln!(
        "PUBLISHED {build}: {} layers, {total_tiles} tiles, {:.1} GiB, manifest flipped",
        results.len(),
        total_bytes as f64 / (1 << 30) as f64
    );
    Ok(())
}

fn pack_layer(layer_dir: &Path, layer: &str, out_dir: &Path, build: &str) -> Result<LayerResult> {
    let t0 = Instant::now();
    let zooms = detect_zooms(layer_dir)?;
    if zooms.is_empty() {
        bail!("{layer}: no z*.qtsi stores");
    }
    let out_name = format!("{layer}.{build}.pmtiles");
    let out_path = out_dir.join(&out_name);

    // Collect every (TileId, zoom-store-index, entry), sort by id → clustered
    // archive. ~17 M entries × 32 B for the largest layer — fine in RAM.
    let stores: Vec<TileStore> = zooms
        .iter()
        .map(|&z| TileStore::open(layer_dir, z, false))
        .collect::<Result<_>>()?;
    let mut feed: Vec<(u64, usize, tile_painter::tile_store::Entry)> = Vec::new();
    for (si, (store, &z)) in stores.iter().zip(&zooms).enumerate() {
        store.for_each_present(|x, y, e| {
            let id = TileCoord::new(z, x, y)
                .map_err(|e| anyhow::anyhow!("z{z}/{x}/{y}: {e}"))?
                .into();
            feed.push((pmtiles::TileId::value(id), si, e));
            Ok(())
        })?;
    }
    feed.sort_unstable_by_key(|(id, _, _)| *id);

    let source_id = stores[0].source_id();
    let metadata = format!(
        r#"{{"name":"quietmap-{layer}","layer":"{layer}","build":"{build}","source_id":{source_id}}}"#
    );
    let writer = PmTilesWriter::new(TileType::Unknown)
        .tile_codec(BrotliPassthrough)
        .metadata(&metadata)
        .min_zoom(zooms[0])
        .max_zoom(*zooms.last().expect("non-empty"))
        .bounds(-180.0, -85.051_13, 180.0, 85.051_13)
        .center(15.5, 49.8)
        .center_zoom(zooms[0]);
    // create_new = the atomic "builds are immutable" guard — no exists() TOCTOU,
    // a racing second packer errors instead of truncating a published archive.
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&out_path)
        .with_context(|| {
            format!(
                "{}: already published? builds are immutable",
                out_path.display()
            )
        })?;
    let mut w = writer.create(file)?;

    let n_feed = feed.len() as u64;
    // Ordered-prefetch pipeline (owner efficiency directive, 2026-07-08): the
    // pmtiles format forces ONE writer in ascending-id order, but nothing
    // forces the READS to be serial. A producer thread pulls blob batches with
    // the shared rayon pool (full-core NVMe queue depth — this is what erased
    // the 23.5-min single-threaded road/total tail of the first b0 pack) and a
    // bounded channel hands them to this thread, which writes strictly in
    // order. Batches are BYTE-bounded, so peak RAM is machine-independent:
    // ~PREFETCH_BATCH_BYTES × (PREFETCH_WINDOW + 2) per layer.
    const PREFETCH_BATCH_BYTES: u64 = 32 << 20;
    const PREFETCH_WINDOW: usize = 3;
    let mut batches: Vec<&[(u64, usize, Entry)]> = Vec::new();
    {
        let (mut start, mut acc) = (0usize, 0u64);
        for (i, (_, _, e)) in feed.iter().enumerate() {
            acc += u64::from(e.len);
            if acc >= PREFETCH_BATCH_BYTES {
                batches.push(&feed[start..=i]);
                start = i + 1;
                acc = 0;
            }
        }
        if start < feed.len() {
            batches.push(&feed[start..]);
        }
    }
    // Per-tile fetch still allocates a fresh Vec<u8> (get_blob_by_entry) rather than reusing a
    // per-rayon-thread scratch buffer. Considered and skipped: every blob here is handed to
    // `tx.send` and on to the single writer thread as an OWNED Vec (add_raw_tile only borrows
    // it briefly) — a shared scratch buffer would need a return path back to whichever rayon
    // worker produced it once the writer is done with it, which is real plumbing for a step
    // that (post 2026-07-16) no longer decodes or re-encodes anything: the dominant per-tile
    // cost is now the pread itself, not the allocation. Not worth the complexity unless a
    // future profile shows allocation (not I/O) is the bottleneck.
    std::thread::scope(|scope| -> Result<()> {
        let (tx, rx) =
            std::sync::mpsc::sync_channel::<Vec<Result<(u64, Vec<u8>)>>>(PREFETCH_WINDOW);
        let stores = &stores;
        scope.spawn(move || {
            for batch in &batches {
                let blobs: Vec<Result<(u64, Vec<u8>)>> = batch
                    .par_iter()
                    .map(|(id, si, e)| Ok((*id, stores[*si].get_hm3_by_entry(e)?)))
                    .collect();
                if tx.send(blobs).is_err() {
                    return; // writer bailed — stop prefetching
                }
            }
        });
        for blobs in rx {
            for r in blobs {
                let (id, blob) = r?;
                let coord = pmtiles::TileId::new(id)
                    .map_err(|e| anyhow::anyhow!("tile id {id}: {e}"))?
                    .into();
                w.add_raw_tile(coord, &blob)
                    .map_err(|e| anyhow::anyhow!("{layer} id {id}: {e}"))?;
            }
        }
        Ok(())
    })?;
    w.finalize()
        .map_err(|e| anyhow::anyhow!("{layer}: finalize: {e}"))?;

    // Durability + integrity record: fsync, then hash what is actually on
    // disk. The second read pass is deliberate — pmtiles finalize() SEEKS BACK
    // to rewrite the header + root directory, so a streaming hash of writes
    // would not match the final file bytes (reviewed 2026-07-08).
    let f = File::open(&out_path)?;
    f.sync_all()?;
    let (sha, bytes, publisher_proof) = sha256_file(&out_path)?;
    eprintln!(
        "{layer}: {n_feed} tiles → {} ({:.2} GiB) in {:.0?}",
        out_name,
        bytes as f64 / (1 << 30) as f64,
        t0.elapsed()
    );
    Ok(LayerResult {
        layer: layer.to_string(),
        file: out_name,
        sha256: sha,
        tiles: n_feed,
        bytes,
        publisher_proof,
    })
}

fn sha256_file(path: &Path) -> Result<(String, u64, PublisherProof)> {
    let mut f = File::open(path)?;
    let before = PublisherProof::from_metadata(path, &f.metadata()?)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 8 << 20];
    let mut total = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    let mut hex = String::with_capacity(64);
    for b in hasher.finalize() {
        write!(hex, "{b:02x}").expect("write to String");
    }
    let after = PublisherProof::from_metadata(path, &f.metadata()?)?;
    if before != after {
        bail!(
            "{} changed while its sha256 was being computed",
            path.display()
        );
    }
    if total != after.size {
        bail!(
            "{} read {total} bytes while stat reports {}",
            path.display(),
            after.size
        );
    }
    let published_path = PublisherProof::read(path)?;
    if published_path != after {
        bail!(
            "{} path changed after its sha256 was computed",
            path.display()
        );
    }
    Ok((hex, total, after))
}

/// `current.json`, written last, tmp + atomic rename: the pointer flip. Readers
/// (Fastify, publish/rsync tooling, rollback) treat THIS as the single truth.
/// Every layer entry carries its OWN `build` — a partial pack merges over the
/// previous manifest, so untouched layers keep serving their existing archives
/// (the per-layer split finally pays off: one-layer republish, one-layer cost).
fn write_manifest(
    out_dir: &Path,
    build: &str,
    results: &[LayerResult],
    partial: bool,
) -> Result<()> {
    let created_unix = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let path = out_dir.join("current.json");

    // Seed from the previous manifest on a partial pack; a FULL pack starts
    // empty so retired layers cannot linger.
    let mut layers: serde_json::Map<String, serde_json::Value> = if partial {
        let prev: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(&path)
                .context("partial pack needs an existing current.json to merge over")?,
        )?;
        prev.get("layers")
            .and_then(|l| l.as_object())
            .cloned()
            .context("current.json has no layers object")?
    } else {
        serde_json::Map::new()
    };
    for r in results {
        let proof = &r.publisher_proof;
        layers.insert(
            r.layer.clone(),
            serde_json::json!({
                "file": r.file, "build": build, "sha256": r.sha256,
                "tiles": r.tiles, "bytes": r.bytes,
                "publisher_proof": {
                    "schema": PUBLISHER_PROOF_SCHEMA,
                    "sha256": r.sha256,
                    "dev": proof.dev.to_string(),
                    "ino": proof.ino.to_string(),
                    "size": proof.size.to_string(),
                    "mtime_ns": proof.mtime_ns.to_string(),
                    "ctime_ns": proof.ctime_ns.to_string(),
                },
            }),
        );
    }
    // Recheck every retained and newly packed archive immediately before the
    // atomic manifest flip. This closes the partial-pack preflight race.
    validate_manifest_layers(out_dir, &layers, None)?;
    let json = serde_json::json!({
        "build": build, "created_unix": created_unix, "layers": layers,
    })
    .to_string();

    // Build-unique temp name: two concurrent packers must not clobber each
    // other's staged manifest (the rename itself is last-writer-wins, atomic).
    let tmp = out_dir.join(format!("current.json.{build}.tmp"));
    fs::write(&tmp, &json)?;
    File::open(&tmp)?.sync_all()?;
    fs::rename(&tmp, &path)?;
    File::open(out_dir)?.sync_all()?; // the rename itself, durable
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn entry(file: &str, sha256: &str, proof: &PublisherProof) -> serde_json::Value {
        serde_json::json!({
            "file": file,
            "build": "b1",
            "bytes": proof.size,
            "sha256": sha256,
            "publisher_proof": {
                "schema": PUBLISHER_PROOF_SCHEMA,
                "sha256": sha256,
                "dev": proof.dev.to_string(),
                "ino": proof.ino.to_string(),
                "size": proof.size.to_string(),
                "mtime_ns": proof.mtime_ns.to_string(),
                "ctime_ns": proof.ctime_ns.to_string(),
            },
        })
    }

    #[test]
    fn sha256_is_bound_to_the_stable_open_file_identity() -> Result<()> {
        let dir = tempdir()?;
        let path = dir.path().join("total.b1.pmtiles");
        fs::write(&path, b"abc")?;

        let (sha256, bytes, proof) = sha256_file(&path)?;
        assert_eq!(
            sha256,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(bytes, 3);
        assert_eq!(proof, PublisherProof::read(&path)?);
        Ok(())
    }

    #[test]
    fn manifest_proof_rejects_a_same_size_atomic_replacement() -> Result<()> {
        let dir = tempdir()?;
        let file = "total.b1.pmtiles";
        let path = dir.path().join(file);
        fs::write(&path, b"abc")?;
        let (sha256, _, proof) = sha256_file(&path)?;
        let manifest_entry = entry(file, &sha256, &proof);
        validate_manifest_entry(dir.path(), "total", &manifest_entry)?;

        let replacement = dir.path().join("replacement.pmtiles");
        fs::write(&replacement, b"abc")?;
        fs::rename(replacement, path)?;
        assert!(validate_manifest_entry(dir.path(), "total", &manifest_entry).is_err());
        Ok(())
    }

    #[test]
    fn partial_merge_preflight_rejects_a_legacy_entry_without_proof() -> Result<()> {
        let dir = tempdir()?;
        let path = dir.path().join("road.b1.pmtiles");
        fs::write(&path, b"road")?;
        let legacy = serde_json::json!({
            "file": "road.b1.pmtiles",
            "build": "b1",
            "bytes": 4,
            "sha256": "0".repeat(64),
        });
        assert!(validate_manifest_entry(dir.path(), "road", &legacy).is_err());
        Ok(())
    }

    /// Rewritten retention test (2026-07-16 Track 2 — replaces the old `prune_*` tests, which
    /// exercised a `prune_superseded` function that no longer exists): running a REAL pack
    /// (`pack_layer` + `write_manifest`, the exact pair `main()` calls) must leave every other
    /// `.pmtiles` file in `out_dir` untouched — old generations of the SAME layer, a sibling
    /// layer's archive, everything. Retention is `tile-store-gc`'s job now, proven separately
    /// in `tile_store_gc.rs`'s own tests; this just locks in that packing never deletes.
    #[test]
    fn pack_never_deletes_other_archives_in_out_dir() -> Result<()> {
        use tile_painter::grid::TILE_PX;
        use tile_painter::tile_store::{TileCodec, TileStore};
        use tile_painter::wire_hm3::{self, NO_DATA, SOURCE_ID_ROAD};

        let dir = tempdir()?;
        let store_root = dir.path().join("store");
        let out_dir = dir.path().join("pmtiles");
        fs::create_dir_all(&out_dir)?;

        // Stale archives that a real deployment would have accumulated over prior publishes —
        // older generations of the layer about to be republished, plus a sibling layer's
        // archive this pack never touches at all.
        for f in [
            "road.b4.pmtiles",
            "road.b5.pmtiles",
            "road.b6.pmtiles",
            "rail.b3.pmtiles",
        ] {
            fs::write(out_dir.join(f), b"stale-archive")?;
        }

        let layer_dir = store_root.join("road");
        let store = TileStore::create(&layer_dir, 6, SOURCE_ID_ROAD, TILE_PX as u16)?;
        let mut cells = vec![NO_DATA; TILE_PX * TILE_PX];
        cells[10] = 42;
        let blob = wire_hm3::encode_tile_bytes(&cells, SOURCE_ID_ROAD)?;
        store.put_blob(1, 1, TileCodec::BrotliHm3, &blob)?;
        store.sync_all()?;
        drop(store);

        let result = pack_layer(&layer_dir, "road", &out_dir, "b7")?;
        write_manifest(&out_dir, "b7", std::slice::from_ref(&result), false)?;

        let exists = |f: &str| out_dir.join(f).exists();
        assert!(
            exists("road.b7.pmtiles"),
            "the freshly published archive exists"
        );
        assert!(
            exists("road.b6.pmtiles"),
            "pack must not delete older generations"
        );
        assert!(
            exists("road.b5.pmtiles"),
            "pack must not delete older generations"
        );
        assert!(
            exists("road.b4.pmtiles"),
            "pack must not delete older generations"
        );
        assert!(
            exists("rail.b3.pmtiles"),
            "pack must not touch a layer it didn't publish"
        );
        Ok(())
    }

    /// End-to-end `pack_layer` over a store mid-cutover: one entry already rewritten through
    /// the new `put_cells_hm3`/`BrotliHm3` write path, one entry still the legacy `ZstdCells`
    /// working codec (`put_cells`) — exactly the mixed state every real store is in for a
    /// while after 2026-07-16 (only tiles a combine/pyramid pass actually touches get
    /// rewritten; the rest keep publishing correctly via the ZstdCells arm). Both must ship:
    /// pack_layer must not error, must produce a tile for each, and — the actual point of the
    /// publish-speed fix — the BrotliHm3 entry must ship byte-identical to what was stored,
    /// the exact call (`get_hm3_by_entry`) pack_layer's prefetch pipeline makes per tile.
    #[test]
    fn pack_layer_ships_mixed_codec_store_correctly() -> Result<()> {
        use tile_painter::grid::TILE_PX;
        use tile_painter::tile_store::{TileCodec, TileStore};
        use tile_painter::wire_hm3::{self, NO_DATA, SOURCE_ID_ROAD};

        let dir = tempdir()?;
        let layer_dir = dir.path().join("store").join("road");
        let out_dir = dir.path().join("pmtiles");
        fs::create_dir_all(&out_dir)?;

        let store = TileStore::create(&layer_dir, 6, SOURCE_ID_ROAD, TILE_PX as u16)?;
        let mut cells_new = vec![NO_DATA; TILE_PX * TILE_PX];
        cells_new[10] = 88;
        let blob_new = wire_hm3::encode_tile_bytes(&cells_new, SOURCE_ID_ROAD)?;
        store.put_blob(3, 4, TileCodec::BrotliHm3, &blob_new)?; // new central-writer path
        let mut cells_legacy = vec![NO_DATA; TILE_PX * TILE_PX];
        cells_legacy[20] = 99;
        store.put_cells(5, 6, &cells_legacy)?; // legacy working codec, not yet rewritten
        store.sync_all()?;
        drop(store);

        let result = pack_layer(&layer_dir, "road", &out_dir, "b1")?;
        assert_eq!(result.tiles, 2, "both codecs must ship");
        assert!(out_dir.join("road.b1.pmtiles").exists());

        // pack_layer's own ship-out call is `TileStore::get_hm3_by_entry` — reopen the store
        // and call it the same way to confirm what actually got fed to the pmtiles writer.
        let reopened = TileStore::open(&layer_dir, 6, false)?;
        assert_eq!(
            reopened.get_hm3(3, 4)?.unwrap(),
            blob_new,
            "a BrotliHm3 entry ships byte-identical to the stored blob"
        );
        assert_eq!(
            wire_hm3::read_tile_bytes(&reopened.get_hm3(3, 4)?.unwrap())?,
            cells_new
        );
        assert_eq!(
            wire_hm3::read_tile_bytes(&reopened.get_hm3(5, 6)?.unwrap())?,
            cells_legacy,
            "a legacy ZstdCells entry still composes correctly"
        );
        Ok(())
    }
}
