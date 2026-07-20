//! Integrity checks over an already-captured tile-store index snapshot.

use anyhow::{bail, Result};
use rayon::prelude::*;

use super::{Entry, TileCodec, TileStore};
use crate::grid::TILE_PX;
use crate::tile_store::format::HEADER_BYTES;

/// Comfortable headroom above every real compressed 512px tile, but far below an untrusted
/// corrupt `u32` length that would otherwise make validation allocate gigabytes.
pub const MAX_PLAUSIBLE_BLOB_LEN: u32 = 8 << 20;

/// One exact index entry copied while its writer domain was quiescent.
#[derive(Debug, Clone, Copy)]
pub struct CapturedTileRef {
    pub x: u32,
    pub y: u32,
    pub entry: Entry,
}

/// Every problem found in one captured `(layer, zoom)` store.
pub struct StoreFsckReport {
    pub layer: String,
    pub zoom: u8,
    pub entries: usize,
    pub tile_px_mismatch: Option<u16>,
    pub decode_failures: Vec<(CapturedTileRef, String)>,
    pub overlaps: Vec<(CapturedTileRef, CapturedTileRef)>,
}

impl StoreFsckReport {
    pub fn problem_count(&self) -> usize {
        self.decode_failures.len()
            + self.overlaps.len()
            + usize::from(self.tile_px_mismatch.is_some())
    }

    /// Turn a dirty snapshot into one concise publish-blocking error. The standalone fsck binary
    /// prints every individual problem from the same report for forensic use.
    pub fn ensure_clean(&self) -> Result<()> {
        if self.problem_count() == 0 {
            return Ok(());
        }
        let first_decode = self
            .decode_failures
            .first()
            .map(|(tile, error)| {
                format!(
                    "; first decode/bounds failure {}/{}: {error}",
                    tile.x, tile.y
                )
            })
            .unwrap_or_default();
        let first_overlap = self
            .overlaps
            .first()
            .map(|(left, right)| {
                format!(
                    "; first overlap {}/{} @{}+{} vs {}/{} @{}+{}",
                    left.x,
                    left.y,
                    left.entry.offset,
                    left.entry.len,
                    right.x,
                    right.y,
                    right.entry.offset,
                    right.entry.len
                )
            })
            .unwrap_or_default();
        bail!(
            "{}/z{} snapshot fsck failed: tile_px={:?}, {} decode/bounds failure(s), {} overlap(s){}{}",
            self.layer,
            self.zoom,
            self.tile_px_mismatch,
            self.decode_failures.len(),
            self.overlaps.len(),
            first_decode,
            first_overlap
        )
    }
}

/// Validate the exact entries and data-file length captured under the writer locks.
///
/// `entry_ref` lets the packer retain its PMTiles ordering key beside each captured entry while
/// this shared core remains agnostic to archive layout. Offset-ordering uses an index vector, so
/// the caller's captured feed is never reordered or recopied.
pub fn validate_captured_store<T: Sync>(
    store: &TileStore,
    layer: &str,
    zoom: u8,
    captured_data_len: u64,
    entries: &[T],
    entry_ref: impl Fn(&T) -> CapturedTileRef + Sync,
) -> StoreFsckReport {
    let tile_px_mismatch = (store.tile_px() as usize != TILE_PX).then_some(store.tile_px());

    let decode_failures: Vec<(CapturedTileRef, String)> = entries
        .par_iter()
        .filter_map(|item| {
            let tile = entry_ref(item);
            let entry = tile.entry;
            if entry.len > MAX_PLAUSIBLE_BLOB_LEN {
                return Some((
                    tile,
                    format!(
                        "implausible len {} (max {MAX_PLAUSIBLE_BLOB_LEN})",
                        entry.len
                    ),
                ));
            }
            let Some(end) = entry.offset.checked_add(u64::from(entry.len)) else {
                return Some((tile, "offset + len overflows u64".to_string()));
            };
            if entry.offset < HEADER_BYTES || end > captured_data_len {
                return Some((
                    tile,
                    format!(
                        "blob range {}..{} outside captured data file {}..{}",
                        entry.offset, end, HEADER_BYTES, captured_data_len
                    ),
                ));
            }
            let result: Result<()> = match entry.codec {
                TileCodec::BrotliHm3 => store.validate_hm3_by_entry(&entry),
                TileCodec::ZstdCells => store
                    .get_blob_by_entry(&entry)
                    .and_then(|blob| store.decode_cells(entry.codec, &blob))
                    .map(|_| ()),
            };
            result.err().map(|error| (tile, error.to_string()))
        })
        .collect();

    let mut by_offset: Vec<usize> = (0..entries.len()).collect();
    by_offset.sort_unstable_by_key(|&index| entry_ref(&entries[index]).entry.offset);
    let mut overlaps = Vec::new();
    for adjacent in by_offset.windows(2) {
        let left = entry_ref(&entries[adjacent[0]]);
        let right = entry_ref(&entries[adjacent[1]]);
        let end = left.entry.offset.checked_add(u64::from(left.entry.len));
        if end.is_none_or(|end| end > right.entry.offset) {
            overlaps.push((left, right));
        }
    }

    StoreFsckReport {
        layer: layer.to_string(),
        zoom,
        entries: entries.len(),
        tile_px_mismatch,
        decode_failures,
        overlaps,
    }
}
