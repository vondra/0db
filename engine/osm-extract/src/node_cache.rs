//! Memory-mapped node coordinate cache.
//!
//! Stores lat/lon as i32 microdegrees (×1e7) in a sparse file indexed by node ID.
//! File layout: node_id × 8 bytes → [lat_i32, lon_i32].
//! Sparse file on NVMe — OS only allocates pages that are written.

use anyhow::Result;
use memmap2::MmapMut;
use osmpbf::{Element, ElementReader};
use std::fs::OpenOptions;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Max OSM node ID (~12 billion as of 2026). 8 bytes per entry = ~96 GB sparse.
const MAX_NODE_ID: u64 = 13_000_000_000;
const ENTRY_SIZE: u64 = 8; // 4 bytes lat + 4 bytes lon

pub struct NodeCache {
    mmap: MmapMut,
    count: u64,
}

/// Raw shared pointer wrapper for parallel writes to disjoint mmap offsets.
///
/// Safety: every write targets a unique `node_id`, so the per-node 8-byte
/// slice is never touched by another thread. The `MmapMut` is kept alive
/// by the owning `NodeCache::build` for the whole scope of par_map_reduce.
#[derive(Clone, Copy)]
struct MmapWriter {
    ptr: *mut u8,
    len: usize,
}

// SAFETY: disjoint writes, see MmapWriter doc.
unsafe impl Send for MmapWriter {}
unsafe impl Sync for MmapWriter {}

impl MmapWriter {
    #[inline]
    fn write(&self, node_id: u64, lat: f64, lon: f64) -> bool {
        if node_id >= MAX_NODE_ID {
            return false;
        }
        let offset = (node_id * ENTRY_SIZE) as usize;
        if offset + 8 > self.len {
            return false;
        }
        let lat_i32 = (lat * 1e7) as i32;
        let lon_i32 = (lon * 1e7) as i32;
        // SAFETY: disjoint per-node 8-byte slices; offset + 8 <= len checked above.
        unsafe {
            let p = self.ptr.add(offset);
            std::ptr::copy_nonoverlapping(lat_i32.to_le_bytes().as_ptr(), p, 4);
            std::ptr::copy_nonoverlapping(lon_i32.to_le_bytes().as_ptr(), p.add(4), 4);
        }
        true
    }
}

impl NodeCache {
    /// Build the node cache by streaming all nodes from the PBF.
    ///
    /// Uses `par_map_reduce` — each rayon worker decodes PBF blocks
    /// independently and writes to the shared sparse mmap. Writes are
    /// per-node-id (8 bytes at `node_id * 8` offset), so worker threads
    /// never touch the same byte range.
    pub fn build(pbf_path: &Path, cache_path: &Path) -> Result<Self> {
        let file_size = MAX_NODE_ID * ENTRY_SIZE;

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(cache_path)?;
        file.set_len(file_size)?;

        let mut mmap = unsafe { MmapMut::map_mut(&file)? };

        let writer = MmapWriter {
            ptr: mmap.as_mut_ptr(),
            len: mmap.len(),
        };
        let count = AtomicU64::new(0);

        let reader = ElementReader::from_path(pbf_path)?;
        reader.par_map_reduce(
            |element| {
                let (id, lat, lon) = match element {
                    Element::Node(n) => (n.id() as u64, n.lat(), n.lon()),
                    Element::DenseNode(n) => (n.id as u64, n.lat(), n.lon()),
                    _ => return 0u64,
                };
                if writer.write(id, lat, lon) {
                    1
                } else {
                    0
                }
            },
            || 0u64,
            |a, b| a + b,
        )
        .map(|n| count.fetch_add(n, Ordering::Relaxed))?;

        let count = count.load(Ordering::Relaxed);
        mmap.flush()?;

        eprintln!(
            "  Node cache: {} nodes, sparse file {}",
            count,
            cache_path.display()
        );
        Ok(NodeCache { mmap, count })
    }

    /// Look up coordinates for a node ID. Returns [lat, lon] as f64.
    pub fn get(&self, node_id: i64) -> Option<[f64; 2]> {
        let id = node_id as u64;
        if id >= MAX_NODE_ID {
            return None;
        }

        let offset = (id * ENTRY_SIZE) as usize;
        let lat_i32 = i32::from_le_bytes(self.mmap[offset..offset + 4].try_into().ok()?);
        let lon_i32 = i32::from_le_bytes(self.mmap[offset + 4..offset + 8].try_into().ok()?);

        // Skip unwritten entries (all zeros = 0°N 0°E = middle of ocean, treat as missing)
        if lat_i32 == 0 && lon_i32 == 0 {
            return None;
        }

        Some([lat_i32 as f64 / 1e7, lon_i32 as f64 / 1e7])
    }

    pub fn count(&self) -> u64 {
        self.count
    }
}
