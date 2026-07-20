//! Tile store — the working container that replaces the loose `{z}/{x}/{y}.bin`
//! tree (54.1 M files; 39.0 M at z13 alone, census 2026-07-08).
//!
//! One store = one `(layer, zoom)` → two data files in the layer dir (plus an
//! ancillary `z{N}.lock` — the empty file whose exclusive flock a writable open
//! holds; see [`store::acquire_write_lock`]):
//!
//! ```text
//! z13.qtsi   dense index: 32 B header + 4^z entries × 16 B, addressed [x·n + y].
//!            Created sparse (set_len) — absent tiles cost nothing. Entry
//!            `len == 0` ⇒ tile absent. WRITING THE ENTRY IS THE COMMIT POINT:
//!            a blob is invisible until its entry lands (crash/failed push ⇒
//!            garbage bytes at the data tail, never a visible partial tile).
//! z13.qtsd   append-only blob log: 32 B header + blobs back-to-back. Space of
//!            deleted/rewritten tiles is reclaimed at pack time (pmtiles pack =
//!            the natural compaction pass), never in place.
//! ```
//!
//! Design decided by measurement (2026-07-08, he84; see the census + codec
//! experiment in the git history of this file):
//!
//! * **Variable-size blobs + dense index, NOT fixed slots**: z13 sizes spread
//!   p50 717 B → max 41,460 B (`total`); fixed max-sized slots would burn
//!   534 GB for 55 GB of actual bytes (~90 % waste). Bounds: every 256 px tile
//!   < 42 KB, every 2×2 block (future 512 px tile) < 160 KB, pyramid z8 max
//!   51 KB ⇒ `len` fits u32 with huge margin, `offset` is u64.
//! * **Codecs** ([`TileCodec`]): source-layer z13 keeps the fleet-encoded
//!   whole-file-Brotli HM3 v2 blob VERBATIM (flows untouched into pmtiles).
//!   Central intermediates (total, all pyramid levels) ALSO write `BrotliHm3`
//!   directly since 2026-07-16 (`TileStore::put_cells_hm3`) — every store
//!   entry ships verbatim at publish time now, whatever wrote it. Before that
//!   date central writes used zstd-1 over the raw 65,536 cells (measured
//!   132 µs/tile round-trip vs 8,803 µs for the brotli-q9 round-trip, 67×
//!   less codec CPU at WRITE time — the reason the combine/pyramid phase
//!   wasn't compression-bound), but it forced `tile-store-pack` to redo that
//!   same brotli-q9 encode, from scratch, on EVERY publish (measured ~63 min
//!   for one 580k-tile layer) — moving the encode to write time is what
//!   killed that cost. `ZstdCells` is now legacy-read-only; see its own
//!   doc for the deletion condition.
//! * **pread/pwrite, no mmap**: reads hit the same page cache mmap would; no
//!   unsafe, no remap-on-growth. The index is fixed-size from creation; the
//!   data log grows by [`store::FALLOC_CHUNK`] `fallocate` steps (concurrent
//!   hole-filling writes serialize on the ext4 inode lock — pre-allocation
//!   sidesteps it).
//! * **Concurrency**: parallel `put_*` within ONE process (atomic tail
//!   reservation + disjoint index entries). Cross-process writers are serialized
//!   by the store ITSELF: a writable `open`/`create` takes an exclusive
//!   per-(layer,zoom) `flock` before recovering the tail or reserving any offset
//!   (`store::acquire_write_lock`). The build-level `_combine`/`.ingest.lock`
//!   flocks stay as coarser OUTER locks, but are no longer the only thing
//!   between two writer processes and offset-overlap corruption (industrial/z12,
//!   2026-07 — dual /gg root cause).
//! * **Crash contract: process-crash-safe, NOT host-crash-durable** (dual
//!   review 2026-07-08). There is deliberately no per-tile fsync (throughput);
//!   after an unclean HOST crash, entries whose data pages never reached disk
//!   may decode as garbage. Recovery path: every producer (transcode, combine,
//!   hub pushes) is re-runnable and the pack step decode-validates every tile —
//!   derived, rebuildable data does not buy per-tile fsyncs. What IS guaranteed
//!   even across a host crash: a writable `open()` can never hand out offsets
//!   that overwrite committed blobs — the tail is recovered as
//!   max(file length, highest indexed blob end), closing the stale-inode-size
//!   window (index page durable, data size update not).
//!
//! Submodules: [`format`] = on-disk layout + entry codec · [`store`] = the
//! read/write store · [`loose`] = read-only adapter over the legacy loose tree
//! (transcode source + parity diffing) · [`manifest`] = shared pmtiles-manifest
//! parsing (safe filenames, `layers` → `file` extraction) used by both the packer's
//! merge preflight and `tile-store-gc`'s retention sweep.

pub mod format;
pub mod fsck;
pub mod locks;
pub mod loose;
pub mod manifest;
pub mod rebuild;
pub mod store;

pub use format::{Entry, TileCodec};
pub use locks::{
    ingest_store_lock_path, master_store_lock_path, zoom_store_lock_path, StoreFileLock,
    StoreFileLocks, StoreMasterIngestLocks,
};
pub use loose::LooseTree;
pub use rebuild::{reject_incomplete_store_transactions, StoreRebuildFence, StoreUpdateFence};
pub use store::{detect_layers, detect_zooms, TileStore};

use crate::wire_hm3::{
    SOURCE_ID_AIRCRAFT, SOURCE_ID_BUILDING, SOURCE_ID_INDUSTRIAL, SOURCE_ID_RAIL, SOURCE_ID_ROAD,
    SOURCE_ID_TOTAL,
};

/// Source layers whose energy is folded into the derived `total` store.
///
/// The combiner and the packer's dependency fsck share this exact list: publishing a fresh
/// `total` while retaining an old archive for any corrupt input layer would otherwise bless a
/// coherent-but-incomplete energy sum.
pub const TOTAL_INPUT_LAYERS: &[&str] = &[
    "road",
    "rail",
    "industrial",
    "building",
    "aircraft-airborne",
    "aircraft-cruise",
    "aircraft-ground",
];

/// Exact layer set one immutable public manifest must expose.
///
/// A full pack must never derive this contract from whichever store directories happen to be
/// present: losing one directory would otherwise silently remove that layer from `current.json`.
pub const PUBLISHED_LAYERS: &[&str] = &[
    "total",
    "road",
    "rail",
    "industrial",
    "building",
    "aircraft-airborne",
    "aircraft-cruise",
    "aircraft-ground",
];

/// The HM3 discriminator required for one published layer name.
///
/// Keep this mapping beside the store format and use it at every boundary that turns an
/// untrusted directory name into a durable store/archive. The three aircraft products share
/// one wire discriminator by design; `total` is the derived energy sum and has its own id.
pub fn expected_source_id(layer: &str) -> Option<u8> {
    match layer {
        "total" => Some(SOURCE_ID_TOTAL),
        "road" => Some(SOURCE_ID_ROAD),
        "rail" => Some(SOURCE_ID_RAIL),
        "industrial" => Some(SOURCE_ID_INDUSTRIAL),
        "building" => Some(SOURCE_ID_BUILDING),
        "aircraft-ground" | "aircraft-airborne" | "aircraft-cruise" => Some(SOURCE_ID_AIRCRAFT),
        _ => None,
    }
}

/// Lowest zoom present in every complete, publishable heatmap layer.
pub const PUBLISHED_MIN_ZOOM: u8 = 2;
/// Finest zoom present in every complete, publishable 512-pixel heatmap layer.
pub const PUBLISHED_BASE_ZOOM: u8 = 12;
/// Durable fence left by an interrupted destructive whole-layer rebuild. Packers must refuse
/// the layer until the same rebuild path completes and removes this marker after fsync.
pub const REBUILD_INCOMPLETE_MARKER: &str = ".rebuild-incomplete";
/// Durable store-root fence spanning a manual scoped ingest → pyramids → total transaction.
pub const SCOPED_UPDATE_INCOMPLETE_MARKER: &str = ".scoped-update-incomplete";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_layer_source_ids_have_one_canonical_mapping() {
        assert_eq!(expected_source_id("total"), Some(SOURCE_ID_TOTAL));
        assert_eq!(expected_source_id("road"), Some(SOURCE_ID_ROAD));
        assert_eq!(expected_source_id("rail"), Some(SOURCE_ID_RAIL));
        assert_eq!(expected_source_id("industrial"), Some(SOURCE_ID_INDUSTRIAL));
        assert_eq!(expected_source_id("building"), Some(SOURCE_ID_BUILDING));
        for layer in ["aircraft-ground", "aircraft-airborne", "aircraft-cruise"] {
            assert_eq!(expected_source_id(layer), Some(SOURCE_ID_AIRCRAFT));
        }
        assert_eq!(expected_source_id("unknown"), None);
        assert_eq!(TOTAL_INPUT_LAYERS.len(), 7);
        assert!(TOTAL_INPUT_LAYERS
            .iter()
            .all(|layer| expected_source_id(layer).is_some()));
        assert!(!TOTAL_INPUT_LAYERS.contains(&"total"));
        assert_eq!(PUBLISHED_LAYERS.len(), TOTAL_INPUT_LAYERS.len() + 1);
        assert!(PUBLISHED_LAYERS.contains(&"total"));
        assert!(TOTAL_INPUT_LAYERS
            .iter()
            .all(|layer| PUBLISHED_LAYERS.contains(layer)));
    }
}
