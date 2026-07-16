//! tile-store-fsck — read-only health check for one or more `(layer, zoom)`
//! tile stores: decode-validates every present entry, and flags any pair of
//! entries whose `[offset, offset+len)` byte ranges overlap in the data log.
//!
//! Non-overlap is an invariant of a correctly functioning store (`put_blob`
//! reserves offsets via an atomic tail bump — no two entries should ever
//! collide), so an overlap is corruption BY CONSTRUCTION, and decode success
//! alone cannot catch this class: a corrupt entry can be a valid Brotli
//! stream for a DIFFERENT tile plus trailing garbage, which decodes
//! "successfully" to the wrong tile's data. Found live, 2026-07-14: 88
//! duplicate-offset groups in `industrial/z12`, 43 of them this exact
//! silent-wrong-data pattern — this tool generalizes that forensic scan into
//! a standing, scriptable check.
//!
//! MANDATORY pre-publish gate since 2026-07-16: `worldctl publish` runs this
//! over every layer it is about to pack, BEFORE invoking `tile-store-pack` —
//! a non-zero exit aborts the publish. This is what let `tile-store-pack`'s
//! own ship-out (`TileStore::get_hm3_by_entry`) drop its per-tile decode-
//! validation of `BrotliHm3` blobs and go back to a verbatim copy: the
//! decode-validate work this tool already did per entry only needs to run
//! once before a publish, not once per read inside the packer.
//!
//! Usage: tile-store-fsck <store-root> [--layer L] [--zoom N]
//!        Exit 0 = clean. Exit 1 = problems found.

use std::path::Path;

use anyhow::{Context, Result};
use rayon::prelude::*;

use tile_painter::grid::TILE_PX;
use tile_painter::tile_store::{detect_layers, detect_zooms, Entry, TileCodec, TileStore};

/// A real tile never exceeds ~160 KB even at the largest documented case (a 512px pyramid
/// block, per `tile_store/mod.rs`'s own measurement) — comfortable headroom above that, but
/// FAR below what a corrupted `Entry.len` (an untrusted `u32`, up to ~4 GiB) could claim.
/// `get_blob_by_entry` allocates a same-sized buffer before it ever reads a byte, so an
/// unchecked bogus `len` risks OOM-killing the whole fsck run — on the exact input class
/// (a corrupted store) this tool exists to survive (/gg Codex, 2026-07-14). Checked BEFORE
/// the read, not after: the allocation itself is the danger, not just a failed decode.
const MAX_PLAUSIBLE_BLOB_LEN: u32 = 8 << 20;

#[derive(Clone, Copy)]
struct TileRef {
    x: u32,
    y: u32,
    entry: Entry,
}

struct Report {
    layer: String,
    zoom: u8,
    entries: usize,
    /// Store's own `tile_px` vs. the current global `TILE_PX` — set when they differ. Not a
    /// per-entry problem: `TileStore::get_hm3_by_entry`'s `ZstdCells` arm re-encodes through
    /// `wire_hm3::encode_tile_bytes`, which `assert_eq!`s the cell count against the GLOBAL
    /// `TILE_PX`, not the store's own header — a legitimately self-consistent smaller store
    /// (e.g. a pre-2026-07-shift 256px store) decodes fine here but PANICS the real pmtiles
    /// packer the moment it reaches a `ZstdCells` entry. fsck must not report "clean" on a
    /// store the real ship path cannot survive (/gg Codex, 2026-07-14).
    tile_px_mismatch: Option<u16>,
    decode_failures: Vec<(TileRef, String)>,
    overlaps: Vec<(TileRef, TileRef)>,
}

fn main() -> Result<()> {
    let mut positional: Vec<String> = Vec::new();
    let mut only_layer: Option<String> = None;
    let mut only_zoom: Option<u8> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--layer" => only_layer = Some(args.next().context("--layer needs a value")?),
            "--zoom" => {
                only_zoom = Some(
                    args.next()
                        .context("--zoom needs a value")?
                        .parse()
                        .context("--zoom must be a number")?,
                )
            }
            _ => positional.push(a),
        }
    }
    let [store_root]: [String; 1] = positional.try_into().map_err(|_| {
        anyhow::anyhow!("usage: tile-store-fsck <store-root> [--layer L] [--zoom N]")
    })?;
    let store_root = Path::new(&store_root);

    let mut layers = detect_layers(store_root)?;
    if let Some(l) = &only_layer {
        layers.retain(|x| x == l);
    }
    if layers.is_empty() {
        anyhow::bail!("no layer stores under {}", store_root.display());
    }

    let mut reports = Vec::new();
    for layer in &layers {
        let layer_dir = store_root.join(layer);
        let mut zooms = detect_zooms(&layer_dir)?;
        if let Some(z) = only_zoom {
            zooms.retain(|&x| x == z);
        }
        for zoom in zooms {
            reports.push(fsck_one(&layer_dir, layer, zoom)?);
        }
    }
    // A --zoom that matches no store (e.g. --zoom 13 over a root that's all z12) leaves
    // `reports` empty here even though every --layer matched — printing "0 problem(s)
    // across 0 store(s)" and exiting 0 would be a silent false-green, indistinguishable
    // from a genuinely clean, fully-checked store (/gg Codex, 2026-07-14).
    if reports.is_empty() {
        anyhow::bail!(
            "no store matched --layer/--zoom under {} — nothing was checked",
            store_root.display()
        );
    }

    let mut problems = 0usize;
    for r in &reports {
        println!(
            "{}/z{}: {} entries, {} decode failures, {} overlap groups{}",
            r.layer,
            r.zoom,
            r.entries,
            r.decode_failures.len(),
            r.overlaps.len(),
            if r.tile_px_mismatch.is_some() {
                ", TILE_PX MISMATCH"
            } else {
                ""
            }
        );
        if let Some(actual) = r.tile_px_mismatch {
            println!(
                "  TILE_PX MISMATCH: store is {actual}px, current build expects {TILE_PX}px — \
                 any ZstdCells entry here will panic the real pmtiles packer (get_hm3_by_entry \
                 → encode_tile_bytes asserts against the GLOBAL TILE_PX, not this store's own)"
            );
        }
        for (t, err) in &r.decode_failures {
            println!(
                "  DECODE FAIL {}/{}/{} @{}: {err}",
                r.layer, t.x, t.y, t.entry.offset
            );
        }
        for (a, b) in &r.overlaps {
            println!(
                "  OVERLAP {}/{}/{} @{}+{} vs {}/{}/{} @{}+{}",
                r.layer,
                a.x,
                a.y,
                a.entry.offset,
                a.entry.len,
                r.layer,
                b.x,
                b.y,
                b.entry.offset,
                b.entry.len
            );
        }
        problems +=
            r.decode_failures.len() + r.overlaps.len() + usize::from(r.tile_px_mismatch.is_some());
    }
    println!("---");
    println!("{problems} problem(s) across {} store(s)", reports.len());
    if problems > 0 {
        std::process::exit(1);
    }
    Ok(())
}

fn fsck_one(layer_dir: &Path, layer: &str, zoom: u8) -> Result<Report> {
    let store =
        TileStore::open(layer_dir, zoom, false).with_context(|| format!("open {layer}/z{zoom}"))?;
    let tile_px_mismatch = (store.tile_px() as usize != TILE_PX).then_some(store.tile_px());
    let mut entries: Vec<TileRef> = Vec::new();
    store.for_each_present(|x, y, entry| {
        entries.push(TileRef { x, y, entry });
        Ok(())
    })?;
    // Sort by offset ONCE — decode order doesn't matter, and this is exactly the order
    // the overlap scan below needs (adjacent-pair check after an offset sort). Sorting
    // in place here means the decode pass and the overlap scan share one Vec instead of
    // a second offset-sorted copy.
    entries.sort_unstable_by_key(|t| t.entry.offset);

    // Decode-validate in parallel: independent pread + decompress per entry, the same
    // shape tile-store-pack already parallelizes (its pack_layer). This IS the mandatory
    // pre-publish check now (2026-07-16, `worldctl publish` runs this before every
    // tile-store-pack invocation): ship-out itself (`TileStore::get_hm3_by_entry`) stopped
    // decode-validating BrotliHm3 blobs — it used to, but that meant every publish re-paid
    // the decode cost on every tile, for a check that only ever needs to run once before a
    // publish. `validate_hm3_by_entry` is the same check (decode + magic/version/length,
    // then a source_id match against this store's own layer), split out so fsck can run it
    // without also composing a ship-out image. ZstdCells stays on
    // get_blob_by_entry+decode_cells directly: `get_hm3_by_entry`'s ZstdCells arm forces a
    // full Brotli-q9 RE-ENCODE (the ship-out format) — ~67× the CPU of a zstd round-trip
    // (tile_store/mod.rs's own measurement) — wasted work for a health check that only
    // needs to prove the bytes decode, never re-encode them.
    let decode_failures: Vec<(TileRef, String)> = entries
        .par_iter()
        .filter_map(|t| {
            // Reject an implausible len BEFORE the read: get_blob_by_entry allocates a
            // same-sized buffer first, and a corrupted Entry.len is an untrusted u32 up to
            // ~4 GiB — the exact input this tool must survive, not just report on.
            if t.entry.len > MAX_PLAUSIBLE_BLOB_LEN {
                return Some((
                    *t,
                    format!(
                        "implausible len {} (max {MAX_PLAUSIBLE_BLOB_LEN})",
                        t.entry.len
                    ),
                ));
            }
            let result: Result<()> = match t.entry.codec {
                TileCodec::BrotliHm3 => store.validate_hm3_by_entry(&t.entry),
                TileCodec::ZstdCells => store
                    .get_blob_by_entry(&t.entry)
                    .and_then(|blob| store.decode_cells(t.entry.codec, &blob))
                    .map(|_| ()),
            };
            result.err().map(|err| (*t, err.to_string()))
        })
        .collect();

    // checked_add, not `+`: entry.offset is an untrusted u64 read straight off a possibly
    // corrupted index — a bogus offset near u64::MAX would panic this addition in a debug
    // build (or silently wrap in release, hiding the corruption) with the plain operator.
    // An overflow here is itself corruption: report it as an overlap unconditionally, since
    // "this entry's range cannot even be computed" is strictly worse than "these two ranges
    // touch" (/gg Codex, 2026-07-14).
    let mut overlaps = Vec::new();
    for w in entries.windows(2) {
        let (a, b) = (w[0], w[1]);
        let end = a.entry.offset.checked_add(u64::from(a.entry.len));
        if end.is_none_or(|e| e > b.entry.offset) {
            overlaps.push((a, b));
        }
    }

    Ok(Report {
        layer: layer.to_string(),
        zoom,
        entries: entries.len(),
        tile_px_mismatch,
        decode_failures,
        overlaps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tile_painter::wire_hm3::{write_tile, NO_DATA, SOURCE_ID_INDUSTRIAL, SOURCE_ID_RAIL};

    #[test]
    fn clean_store_reports_zero_problems() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("rail");
        let cells = vec![NO_DATA; tile_painter::grid::TILE_PX * tile_painter::grid::TILE_PX];
        let p = dir.join("z12/10/11.bin");
        write_tile(&p, &cells, SOURCE_ID_RAIL, false).unwrap();
        // Promote the loose tile into a real store the same way tile-store-ingest does.
        let blob = std::fs::read(&p).unwrap();
        let store = TileStore::create(&dir, 12, SOURCE_ID_RAIL, 512).unwrap();
        store.put_blob(10, 11, TileCodec::BrotliHm3, &blob).unwrap();
        store.sync_all().unwrap();

        let r = fsck_one(&dir, "rail", 12).unwrap();
        assert_eq!(r.entries, 1);
        assert!(r.decode_failures.is_empty());
        assert!(r.overlaps.is_empty());
    }

    #[test]
    fn corrupt_blob_is_reported_as_decode_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("rail");
        let store = TileStore::create(&dir, 12, SOURCE_ID_RAIL, 512).unwrap();
        store
            .put_blob(3, 4, TileCodec::BrotliHm3, b"not a valid HM3 blob")
            .unwrap();
        store.sync_all().unwrap();

        let r = fsck_one(&dir, "rail", 12).unwrap();
        assert_eq!(r.entries, 1);
        assert_eq!(r.decode_failures.len(), 1);
        assert_eq!((r.decode_failures[0].0.x, r.decode_failures[0].0.y), (3, 4));
        assert!(r.overlaps.is_empty());
    }

    /// Direct regression test for the live 2026-07-14 finding: two entries
    /// whose declared `[offset, offset+len)` ranges overlap must be flagged
    /// even though BOTH blobs decode successfully — decode-validation alone
    /// cannot catch a valid-stream-for-a-different-tile-plus-garbage entry.
    #[test]
    fn overlapping_entries_are_reported_even_when_both_decode_cleanly() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("industrial");
        let cells = vec![NO_DATA; tile_painter::grid::TILE_PX * tile_painter::grid::TILE_PX];
        let loose = tmp.path().join("loose.bin");
        write_tile(&loose, &cells, SOURCE_ID_RAIL, false).unwrap();
        let blob = std::fs::read(&loose).unwrap();

        let store = TileStore::create(&dir, 12, SOURCE_ID_RAIL, 512).unwrap();
        store
            .put_blob(524, 997, TileCodec::BrotliHm3, &blob)
            .unwrap();
        store
            .put_blob(1232, 2500, TileCodec::BrotliHm3, &blob)
            .unwrap();
        store.sync_all().unwrap();
        drop(store);

        // Simulate the live corruption class directly: alias the second
        // tile's index entry onto the first tile's exact offset+len+codec
        // bytes — both now point at the SAME valid blob, so both decode
        // cleanly, but their ranges are identical (the sharpest overlap).
        use std::os::unix::fs::FileExt;
        let index_path = dir.join("z12.qtsi");
        let entry_pos =
            |x: u32, y: u32| -> u64 { 32 + (u64::from(x) * (1u64 << 12) + u64::from(y)) * 16 };
        let f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&index_path)
            .unwrap();
        let mut first_entry = [0u8; 16];
        f.read_exact_at(&mut first_entry, entry_pos(524, 997))
            .unwrap();
        f.write_all_at(&first_entry, entry_pos(1232, 2500)).unwrap();

        let r = fsck_one(&dir, "industrial", 12).unwrap();
        assert_eq!(r.entries, 2);
        assert!(
            r.decode_failures.is_empty(),
            "both entries point at the same valid blob — decode alone must NOT catch this"
        );
        assert_eq!(
            r.overlaps.len(),
            1,
            "aliased offset must be reported as an overlap"
        );
    }

    /// Regression test for the altitude-review finding (2026-07-14): decode_cells alone
    /// accepts an entry whose blob decodes cleanly but carries a DIFFERENT layer's
    /// source_id — the exact class validate_hm3_by_entry rejects, as the MANDATORY
    /// pre-publish check this tool now runs before every publish (`worldctl publish`).
    /// fsck must use the same check, or it reports "clean" on a store publish must refuse.
    #[test]
    fn source_id_mismatch_is_reported_even_though_the_blob_decodes_cleanly() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("rail");
        let cells = vec![NO_DATA; tile_painter::grid::TILE_PX * tile_painter::grid::TILE_PX];
        let loose = tmp.path().join("loose.bin");
        // A blob honestly tagged for a DIFFERENT source — a valid BrotliHm3 stream in its
        // own right, decode_cells has no reason to reject it.
        write_tile(&loose, &cells, SOURCE_ID_INDUSTRIAL, false).unwrap();
        let blob = std::fs::read(&loose).unwrap();

        // Store's own header says rail — put_blob trusts the caller, so this plants a
        // mismatch directly (mirrors how a stale/cross-layer ingest could corrupt a store).
        let store = TileStore::create(&dir, 12, SOURCE_ID_RAIL, 512).unwrap();
        store.put_blob(1, 1, TileCodec::BrotliHm3, &blob).unwrap();
        store.sync_all().unwrap();

        let r = fsck_one(&dir, "rail", 12).unwrap();
        assert_eq!(r.entries, 1);
        assert_eq!(
            r.decode_failures.len(),
            1,
            "a source_id mismatch must be reported even though the blob decodes cleanly"
        );
    }

    /// Regression test for the /gg finding (2026-07-14): a legitimately self-consistent
    /// smaller store (pre-2026-07-shift 256px, still creatable via the API) decodes cleanly
    /// here, but `get_hm3_by_entry`'s ZstdCells arm would panic the real packer via
    /// `encode_tile_bytes`'s `assert_eq!` against the GLOBAL TILE_PX. fsck must flag the
    /// mismatch itself, not attempt the panicking call to find out.
    #[test]
    fn tile_px_mismatch_is_reported_even_with_zero_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("rail");
        TileStore::create(&dir, 12, SOURCE_ID_RAIL, 256).unwrap();

        let r = fsck_one(&dir, "rail", 12).unwrap();
        assert_eq!(r.tile_px_mismatch, Some(256));
    }

    #[test]
    fn matching_tile_px_reports_no_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("rail");
        TileStore::create(&dir, 12, SOURCE_ID_RAIL, tile_painter::grid::TILE_PX as u16).unwrap();

        let r = fsck_one(&dir, "rail", 12).unwrap();
        assert_eq!(r.tile_px_mismatch, None);
    }

    /// Regression test for the /gg finding (2026-07-14): Entry.len is an untrusted u32 read
    /// straight off disk — a corrupted index claiming an implausible length must be reported
    /// as a problem, not trigger a same-sized allocation before fsck ever gets to say so.
    #[test]
    fn implausible_len_is_reported_without_attempting_the_read() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("rail");
        let cells = vec![NO_DATA; tile_painter::grid::TILE_PX * tile_painter::grid::TILE_PX];
        let p = dir.join("z12/10/11.bin");
        write_tile(&p, &cells, SOURCE_ID_RAIL, false).unwrap();
        let blob = std::fs::read(&p).unwrap();
        let store = TileStore::create(&dir, 12, SOURCE_ID_RAIL, 512).unwrap();
        store.put_blob(10, 11, TileCodec::BrotliHm3, &blob).unwrap();
        store.sync_all().unwrap();
        drop(store);

        // Corrupt the entry's len field in place to something far beyond any real tile —
        // simulates a corrupted index without needing gigabytes of backing data on disk.
        use std::os::unix::fs::FileExt;
        let index_path = dir.join("z12.qtsi");
        let entry_pos =
            |x: u32, y: u32| -> u64 { 32 + (u64::from(x) * (1u64 << 12) + u64::from(y)) * 16 };
        let f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&index_path)
            .unwrap();
        let mut entry = [0u8; 16];
        f.read_exact_at(&mut entry, entry_pos(10, 11)).unwrap();
        entry[8..12].copy_from_slice(&(MAX_PLAUSIBLE_BLOB_LEN + 1).to_le_bytes());
        f.write_all_at(&entry, entry_pos(10, 11)).unwrap();

        let r = fsck_one(&dir, "rail", 12).unwrap();
        assert_eq!(r.entries, 1);
        assert_eq!(r.decode_failures.len(), 1);
        assert!(r.decode_failures[0].1.contains("implausible len"));
    }

    /// Regression test for the /gg finding (2026-07-14): the overlap scan's `offset + len`
    /// must not panic (debug) or silently wrap (release) on a corrupted near-u64::MAX offset
    /// — the exact untrusted-index input class this tool exists to survive. Two entries are
    /// corrupted to adjacent near-MAX offsets so the smaller (the "a" of the sorted window)
    /// overflows when its len is added — proving `checked_add`, not a bare `+`, is in place.
    #[test]
    fn overflowing_offset_addition_is_reported_not_panicked() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("rail");
        let cells = vec![NO_DATA; tile_painter::grid::TILE_PX * tile_painter::grid::TILE_PX];
        let p = dir.join("z12/1/1.bin");
        write_tile(&p, &cells, SOURCE_ID_RAIL, false).unwrap();
        let blob = std::fs::read(&p).unwrap();
        let store = TileStore::create(&dir, 12, SOURCE_ID_RAIL, 512).unwrap();
        store.put_blob(1, 1, TileCodec::BrotliHm3, &blob).unwrap();
        store.put_blob(2, 2, TileCodec::BrotliHm3, &blob).unwrap();
        store.sync_all().unwrap();
        drop(store);

        use std::os::unix::fs::FileExt;
        let index_path = dir.join("z12.qtsi");
        let entry_pos =
            |x: u32, y: u32| -> u64 { 32 + (u64::from(x) * (1u64 << 12) + u64::from(y)) * 16 };
        let f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&index_path)
            .unwrap();
        let plant = |x: u32, y: u32, offset: u64| {
            let mut entry = [0u8; 16];
            f.read_exact_at(&mut entry, entry_pos(x, y)).unwrap();
            entry[0..8].copy_from_slice(&offset.to_le_bytes());
            f.write_all_at(&entry, entry_pos(x, y)).unwrap();
        };
        // a's offset must be within its own (small but nonzero) len of u64::MAX for
        // offset+len to actually overflow — u64::MAX-1 leaves only 1 byte of headroom,
        // comfortably less than any real compressed tile's length.
        plant(1, 1, u64::MAX - 1); // sorts first; +len overflows past u64::MAX
        plant(2, 2, u64::MAX); // sorts second

        let r = fsck_one(&dir, "rail", 12).unwrap(); // must return, not panic
        assert_eq!(r.entries, 2);
        assert_eq!(
            r.overlaps.len(),
            1,
            "an unrepresentable range must be reported, not silently ignored"
        );
    }
}
