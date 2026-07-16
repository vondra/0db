//! tile-store-transcode — ingest ONE layer's loose `{z}/{x}/{y}.bin` tree into
//! the [`tile_store`] container, then prove parity before anyone deletes the
//! tree. Born as the 2026-07 migration tool; stays as the SINGLE-HOST glue
//! between a kernel's loose output and the store (build-heatmap.sh) — the
//! fleet's equivalent is `tile-store-ingest` driven by the hub.
//!
//! Pure blob copy: every loose tile is already a whole-file-Brotli HM3 image,
//! so it is stored VERBATIM ([`TileCodec::BrotliHm3`]) at every zoom — no
//! re-encode, no decoded-value drift possible. The working codec (zstd) enters
//! only later, when combine/pyramid REWRITE tiles.
//!
//! Everything is derived, no tuning flags (project rule): zoom levels from the
//! layer dir listing, `source_id` from the first tile's own header.
//!
//! Parity (three independent gates, all in one run — dual /gg reviewed):
//!   1. count — store scan total == loose census total (catches extras)
//!   2. exhaustive — EVERY census tile byte-compared loose vs store. This is
//!      the deletion-grade proof; a sampled gate would let unsampled
//!      corruption exit green (Codex CRITICAL, 2026-07-08).
//!   3. reference — every tile in the Dobříš + Ruzyně H3 R4 cells compared by
//!      decoded cells at every zoom (semantic smoke test on the project anchors)
//!
//! PRECONDITION: the loose tree is QUIESCENT (stop qm-combine; fleet down) —
//! the gates prove equality against the census taken at start, not against a
//! moving tree. On success the store is fsynced (files + dir) BEFORE the green
//! exit: exit 0 is the license to delete the loose tree, so it must mean
//! durable-on-disk, not page-cache (Gemini CRITICAL, 2026-07-08).
//!
//! Usage: tile-store-transcode <loose-layer-dir> <store-layer-dir>
//!   e.g.  tile-store-transcode data/tiles/2026/build/road \
//!                              data/tiles/2026/store/road

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use rayon::prelude::*;

use tile_painter::grid::{tile_range, TILE_PX};
use tile_painter::tile_store::{LooseTree, TileCodec, TileStore};
use tile_painter::wire_hm3::read_tile_bytes_source_id;

/// Project reference cells (CLAUDE.md): Dobříš + Ruzyně H3 R4. Every tile they
/// cover is decoded-compared — the same anchors every parity check uses.
const REFERENCE_CELLS: [&str; 2] = ["841e309ffffffff", "841e355ffffffff"];

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let (Some(loose_dir), Some(store_dir), None) = (args.next(), args.next(), args.next()) else {
        bail!("usage: tile-store-transcode <loose-layer-dir> <store-layer-dir>");
    };
    let loose_dir = PathBuf::from(loose_dir);
    let store_dir = PathBuf::from(store_dir);

    let zooms = detect_zooms(&loose_dir)?;
    if zooms.is_empty() {
        bail!("no numeric zoom dirs under {}", loose_dir.display());
    }
    eprintln!(
        "transcode {} → {} — zooms {:?}",
        loose_dir.display(),
        store_dir.display(),
        zooms
    );

    let (mut total_tiles, mut total_bytes) = (0u64, 0u64);
    let mut layer_source_id: Option<u8> = None;
    for &z in &zooms {
        let (tiles, bytes, sid) = transcode_zoom(&loose_dir, &store_dir, z)?;
        total_tiles += tiles;
        total_bytes += bytes;
        // One layer = one source_id; a cross-zoom mismatch means a corrupt or
        // mixed tree — refuse to bless it.
        if let Some(sid) = sid {
            match layer_source_id {
                None => layer_source_id = Some(sid),
                Some(prev) if prev != sid => {
                    bail!("z{z}: source_id {sid} ≠ layer's {prev}")
                }
                _ => {}
            }
        }
    }
    eprintln!(
        "DONE: {total_tiles} tiles, {:.1} GiB, all parity gates green",
        total_bytes as f64 / (1 << 30) as f64
    );
    Ok(())
}

/// Numeric subdirs of the layer dir = the zoom levels it carries.
fn detect_zooms(loose_dir: &Path) -> Result<Vec<u8>> {
    let mut zooms: Vec<u8> = std::fs::read_dir(loose_dir)
        .with_context(|| format!("read {}", loose_dir.display()))?
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
        .collect();
    zooms.sort_unstable();
    Ok(zooms)
}

/// Returns `(tiles, bytes, source_id)`; `source_id` is `None` for an empty zoom.
fn transcode_zoom(loose_dir: &Path, store_dir: &Path, z: u8) -> Result<(u64, u64, Option<u8>)> {
    let t0 = Instant::now();
    let tree = LooseTree::new(loose_dir, z);

    let mut coords: Vec<(u32, u32)> = Vec::new();
    tree.for_each_present(|x, y| {
        coords.push((x, y));
        Ok(())
    })?;
    if coords.is_empty() {
        eprintln!("z{z}: empty, skipped");
        return Ok((0, 0, None));
    }

    // The tiles themselves are the truth for the layer discriminator: read it
    // from this zoom's first tile (main() cross-checks zooms agree).
    let (fx, fy) = coords[0];
    let first = tree.get_blob(fx, fy)?.expect("censused tile exists");
    let source_id = read_tile_bytes_source_id(&first)?;

    let store = TileStore::create(store_dir, z, source_id, TILE_PX as u16)?;
    let bytes = AtomicU64::new(0);
    let done = AtomicU64::new(0);
    coords.par_iter().try_for_each(|&(x, y)| -> Result<()> {
        let blob = tree
            .get_blob(x, y)?
            .with_context(|| format!("z{z}/{x}/{y} vanished mid-transcode"))?;
        // Validate EVERY blob (decode + magic/version/size + layer id) — the
        // store ships BrotliHm3 verbatim into pmtiles, so a stale/corrupt
        // loose tile must be rejected HERE, not published (/gg Codex).
        let sid = read_tile_bytes_source_id(&blob)
            .with_context(|| format!("z{z}/{x}/{y}: invalid HM3 tile"))?;
        if sid != source_id {
            bail!("z{z}/{x}/{y}: source_id {sid} ≠ layer {source_id}");
        }
        store.put_blob(x, y, TileCodec::BrotliHm3, &blob)?;
        bytes.fetch_add(blob.len() as u64, Ordering::Relaxed);
        let n = done.fetch_add(1, Ordering::Relaxed) + 1;
        if n.is_multiple_of(1_000_000) {
            eprintln!("z{z}: {n}/{} …", coords.len());
        }
        Ok(())
    })?;

    // Durability BEFORE the gates: a green exit licenses deletion, so what the
    // gates verified must be what's on disk (files + their dir entries).
    store.sync_all()?;
    std::fs::File::open(store_dir)?.sync_all()?;

    verify_zoom(&tree, &store, &coords, z)?;
    eprintln!(
        "z{z}: {} tiles, {:.2} GiB in {:.0?} — parity OK (exhaustive)",
        coords.len(),
        bytes.load(Ordering::Relaxed) as f64 / (1 << 30) as f64,
        t0.elapsed()
    );
    Ok((
        coords.len() as u64,
        bytes.load(Ordering::Relaxed),
        Some(source_id),
    ))
}

/// The three parity gates for one zoom. Any failure aborts the whole run —
/// nothing may delete loose trees unless this binary exited 0.
fn verify_zoom(tree: &LooseTree, store: &TileStore, coords: &[(u32, u32)], z: u8) -> Result<()> {
    // Gate 1: exact presence count (store scan vs loose walk).
    let mut store_count = 0u64;
    store.for_each_present(|_, _, _| {
        store_count += 1;
        Ok(())
    })?;
    if store_count != coords.len() as u64 {
        bail!(
            "z{z}: store has {store_count} tiles, loose has {}",
            coords.len()
        );
    }

    // Gate 2: EXHAUSTIVE byte-for-byte over the whole census — the
    // deletion-grade proof (with gate 1 this is exact set equality).
    coords.par_iter().try_for_each(|&(x, y)| -> Result<()> {
        let loose_blob = tree
            .get_blob(x, y)?
            .with_context(|| format!("z{z}/{x}/{y} vanished during verify"))?;
        let (codec, store_blob) = store
            .get_blob(x, y)?
            .with_context(|| format!("z{z}/{x}/{y} missing from store"))?;
        if codec != TileCodec::BrotliHm3 || store_blob != loose_blob {
            bail!("z{z}/{x}/{y}: stored bytes differ from loose tile");
        }
        Ok(())
    })?;

    // Gate 3: reference cells, decoded-cell equality over the full tile range.
    for cell_str in REFERENCE_CELLS {
        let cell: h3o::CellIndex = cell_str.parse().context("reference cell")?;
        let (mut s, mut w, mut n, mut e) = (90.0f64, 180.0f64, -90.0f64, -180.0f64);
        for ll in cell.boundary().iter() {
            s = s.min(ll.lat());
            n = n.max(ll.lat());
            w = w.min(ll.lng());
            e = e.max(ll.lng());
        }
        let (xr, yr) = tile_range(z, s, w, n, e);
        for x in xr {
            for y in yr.clone() {
                let a = tree.get_cells(x, y)?;
                let b = store.get_cells(x, y)?;
                if a != b {
                    bail!("z{z}/{x}/{y}: reference-cell decode mismatch ({cell_str})");
                }
            }
        }
    }
    Ok(())
}
