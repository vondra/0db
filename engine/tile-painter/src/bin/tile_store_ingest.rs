//! tile-store-ingest — the hub's promote step: move ONE extracted cell push
//! (`{layer}/{z}/{x}/{y}.bin` under a temp dir) into the per-(layer,zoom) tile
//! stores, verbatim ([`TileCodec::BrotliHm3`] blobs, entry-write-is-commit).
//!
//! Replaces the loose-tree `renameSync` loop in `scripts/world/hub.mjs`
//! (storage redesign 2026-07). The container format stays owned by ONE crate;
//! the hub just spawns this helper per validated push.
//!
//! Atomicity contract (unchanged from the loose era): per-TILE commit is the
//! store's index-entry write; per-CELL atomicity comes from the SEAL the hub
//! writes only after this helper exits 0. A crash mid-ingest leaves an
//! unsealed cell whose partial tiles are invisible to the combine (it follows
//! seals via `.stamps`) and are overwritten verbatim when the requeued cell is
//! pushed again.
//!
//! A layer whose store does not exist yet is created; its HM3 `source_id`
//! derives from the first tile's own header (the tiles are the truth).
//!
//! Usage: tile-store-ingest <store-root> <extracted-dir> [--rebuilt-bbox S,W,N,E]

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{bail, Context, Result};
use rayon::prelude::*;

use tile_painter::grid::{tile_range, TILE_PX};
use tile_painter::tile_store::{TileCodec, TileStore};
use tile_painter::wire_hm3::read_tile_bytes_source_id;

fn main() -> Result<()> {
    // usage: tile-store-ingest <store-root> <extracted-dir> [--rebuilt-bbox S,W,N,E]
    // --rebuilt-bbox declares "the staging is a COMPLETE rebuild of this box":
    // kernels never write all-silent tiles (skip_if_empty), so within the box
    // absence-from-staging MEANS silent — the sweep tombstones those store
    // tiles, or a tile that went quiet would keep its stale loud bytes and the
    // combine would keep summing them (/gg Codex CRITICAL, 2026-07-10).
    let mut positional: Vec<String> = Vec::new();
    let mut bbox: Option<[f64; 4]> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--rebuilt-bbox" {
            let v: Vec<f64> = args
                .next()
                .context("--rebuilt-bbox needs S,W,N,E")?
                .split(',')
                .map(|p| p.parse())
                .collect::<Result<_, _>>()
                .context("--rebuilt-bbox parse")?;
            let [s, w, n, e]: [f64; 4] = v
                .try_into()
                .map_err(|_| anyhow::anyhow!("--rebuilt-bbox needs 4 numbers"))?;
            bbox = Some([s, w, n, e]);
        } else {
            positional.push(a);
        }
    }
    let [store_root, extracted]: [String; 2] = positional.try_into().map_err(|_| {
        anyhow::anyhow!(
            "usage: tile-store-ingest <store-root> <extracted-dir> [--rebuilt-bbox S,W,N,E]"
        )
    })?;
    // CROSS-PROCESS OUTER LOCK — coarser than, and now belt-and-suspenders on top of, the store's own
    // per-(layer,zoom) flock. Originally the P0 fix (audit 2026-07-13): the hub spawns up to 8 concurrent
    // tile-store-ingest and TileStore's append tail is a process-local AtomicU64, so two ingests into the
    // same .qtsd claimed the SAME offset and corrupted blobs (437 invalid HM3 blobs in 80 cells). Since
    // 2026-07-15 every writable TileStore::open/create self-locks its (layer,zoom)
    // (store.rs::acquire_write_lock), closing the hole for EVERY writer (tile-store-transcode too, not
    // just ingest×ingest). This root-level flock is kept as the OUTER serialiser: it is taken BEFORE any
    // store opens (the per-store lock is the innermost), so the ordering has no cycle — never a deadlock.
    // Same-root only, which is exactly the collision domain (one store root).
    let _ingest_lock = {
        fs::create_dir_all(&store_root).ok();
        let lock = fs::File::create(Path::new(&store_root).join(".ingest.lock"))
            .context("create .ingest.lock")?;
        if unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&lock), libc::LOCK_EX) } != 0 {
            bail!("flock .ingest.lock: {}", std::io::Error::last_os_error());
        }
        lock
    };
    let (tiles, bytes, tombstoned) =
        ingest_dir(Path::new(&store_root), Path::new(&extracted), bbox)?;
    eprintln!("ingested {tiles} tiles / {bytes} B, tombstoned {tombstoned}");
    Ok(())
}

/// Walk `{layer}/{z}/{x}/{y}.bin` under `extracted` and put every blob into
/// `store_root/{layer}/z{z}`. Returns (tiles, bytes).
/// One tile file inside the extracted push: `(x, y, path)`.
type TileFile = (u32, u32, PathBuf);

fn ingest_dir(
    store_root: &Path,
    extracted: &Path,
    rebuilt_bbox: Option<[f64; 4]>,
) -> Result<(u64, u64, u64)> {
    // Group files per (layer, zoom) so each store opens exactly once.
    let mut groups: BTreeMap<(String, u8), Vec<TileFile>> = BTreeMap::new();
    for layer_entry in fs::read_dir(extracted).with_context(|| extracted.display().to_string())? {
        let layer_entry = layer_entry?;
        if !layer_entry.file_type()?.is_dir() {
            continue;
        }
        let layer = layer_entry.file_name().to_string_lossy().into_owned();
        for z_entry in fs::read_dir(layer_entry.path())? {
            let z_entry = z_entry?;
            let Some(z) = z_entry
                .file_name()
                .to_str()
                .and_then(|s| s.parse::<u8>().ok())
            else {
                continue;
            };
            for x_entry in fs::read_dir(z_entry.path())? {
                let x_entry = x_entry?;
                let Some(x) = x_entry
                    .file_name()
                    .to_str()
                    .and_then(|s| s.parse::<u32>().ok())
                else {
                    continue;
                };
                for y_entry in fs::read_dir(x_entry.path())? {
                    let y_entry = y_entry?;
                    let name = y_entry.file_name();
                    let Some(y) = name
                        .to_str()
                        .and_then(|s| s.strip_suffix(".bin"))
                        .and_then(|s| s.parse::<u32>().ok())
                    else {
                        continue;
                    };
                    groups
                        .entry((layer.clone(), z))
                        .or_default()
                        .push((x, y, y_entry.path()));
                }
            }
        }
    }
    if groups.is_empty() {
        bail!("no tiles under {}", extracted.display());
    }

    let (mut tiles, bytes) = (0u64, AtomicU64::new(0));
    let mut tombstoned = 0u64;
    for ((layer, z), files) in &groups {
        let dir = store_root.join(layer);
        // Stale-binary tripwire: the world base is z12 (512-px tiles) since
        // the 2026-07 shift — a z13 push can only come from a fleet box still
        // running pre-shift binaries, and must not plant a parallel 256 world
        // next to the real one (the pack would publish both). Probing the
        // pushed layer OR total/ covers a first-push-of-a-new-layer too.
        if *z == 13
            && (dir.join("z12.qtsi").exists() || store_root.join("total").join("z12.qtsi").exists())
        {
            bail!(
                "{layer}: push is z13 but the store world is 512@z12 — \
                 this worker still runs pre-shift binaries; re-provision it"
            );
        }
        let store = if dir.join(format!("z{z}.qtsi")).exists() {
            TileStore::open(&dir, *z, true)?
        } else {
            let first = fs::read(&files[0].2)?;
            let source_id = read_tile_bytes_source_id(&first)
                .with_context(|| format!("{layer}: first tile is not HM3"))?;
            TileStore::create(&dir, *z, source_id, TILE_PX as u16)?
        };
        let store_sid = store.source_id();
        files
            .par_iter()
            .try_for_each(|(x, y, path)| -> Result<()> {
                let blob = fs::read(path).with_context(|| path.display().to_string())?;
                // Validate EVERY blob (decode + magic/version/size) — the
                // store ships BrotliHm3 verbatim into pmtiles, so this is the
                // last gate a corrupt or pre-shift push can fail (/gg Codex).
                let sid = read_tile_bytes_source_id(&blob)
                    .with_context(|| format!("{layer} {x}/{y}: invalid HM3 push"))?;
                if sid != store_sid {
                    bail!("{layer} {x}/{y}: source_id {sid} ≠ store {store_sid}");
                }
                store.put_blob(*x, *y, TileCodec::BrotliHm3, &blob)?;
                bytes.fetch_add(blob.len() as u64, Ordering::Relaxed);
                Ok(())
            })?;

        // Rebuilt-bbox sweep: within the declared box, a store tile ABSENT
        // from this staging went silent in the rebuild (kernels skip empty
        // tiles) — tombstone it or its stale bytes keep serving + summing.
        // The sweep stays strictly inside tile_range(bbox): builders cover at
        // least that range, so absence there is a definite verdict, never a
        // guess about fringe tiles the kernel didn't attempt.
        if let Some([s, w, n, e]) = rebuilt_bbox {
            let staged: HashSet<(u32, u32)> = files.iter().map(|(x, y, _)| (*x, *y)).collect();
            let (xr, yr) = tile_range(*z, s, w, n, e);
            let mut present: Vec<(u32, u32)> = Vec::new();
            if !xr.is_empty() {
                // Guard the degenerate empty range (same lesson as combine's
                // scan): end-1 on an empty range would walk a full column.
                store.for_each_present_in_x_range(xr.start, xr.end - 1, |x, y, _| {
                    if yr.contains(&y) {
                        present.push((x, y));
                    }
                    Ok(())
                })?;
            }
            for (x, y) in present {
                if !staged.contains(&(x, y)) {
                    store.delete(x, y)?;
                    tombstoned += 1;
                }
            }
        }
        store.sync_all()?;
        tiles += files.len() as u64;
    }
    Ok((tiles, bytes.load(Ordering::Relaxed), tombstoned))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tile_painter::wire_hm3::{write_tile, NO_DATA, SOURCE_ID_RAIL};

    #[test]
    fn ingest_creates_store_and_reingest_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let (root, ex) = (tmp.path().join("stores"), tmp.path().join("x"));
        let mut cells = vec![NO_DATA; TILE_PX * TILE_PX];
        cells[7] = 90;
        for (x, y) in [(10u32, 11u32), (10, 12)] {
            let p = ex
                .join("rail/12")
                .join(x.to_string())
                .join(format!("{y}.bin"));
            write_tile(&p, &cells, SOURCE_ID_RAIL, false).unwrap();
        }

        let (n, b, _) = ingest_dir(&root, &ex, None).unwrap();
        assert_eq!(n, 2);
        assert!(b > 0);
        let s = TileStore::open(&root.join("rail"), 12, false).unwrap();
        assert_eq!(
            s.source_id(),
            SOURCE_ID_RAIL,
            "source_id derived from tiles"
        );
        assert_eq!(s.get_cells(10, 11).unwrap().unwrap(), cells);

        // A requeued cell re-pushes the same coords: same count, new bytes win.
        cells[7] = 92;
        let p = ex.join("rail/12/10/11.bin");
        write_tile(&p, &cells, SOURCE_ID_RAIL, false).unwrap();
        ingest_dir(&root, &ex, None).unwrap();
        let s = TileStore::open(&root.join("rail"), 12, false).unwrap();
        assert_eq!(
            s.get_cells(10, 11).unwrap().unwrap(),
            cells,
            "overwrite wins"
        );
        let mut count = 0;
        s.for_each_present(|_, _, _| {
            count += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(count, 2, "no duplicate entries after re-ingest");
    }
}
