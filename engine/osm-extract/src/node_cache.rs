//! Memory-mapped node coordinate cache.
//!
//! Stores lat/lon as i32 microdegrees (×1e7) in a sparse file indexed by node ID.
//! File layout: node_id × 8 bytes → [lat_i32, lon_i32].
//! Sparse file on NVMe — OS only allocates pages that are written.

use anyhow::Result;
use memmap2::MmapMut;
use osmpbf::{ElementReader, Element};
use std::fs::OpenOptions;
use std::path::Path;

/// Max OSM node ID (~12 billion as of 2026). 8 bytes per entry = ~96 GB sparse.
const MAX_NODE_ID: u64 = 13_000_000_000;
const ENTRY_SIZE: u64 = 8; // 4 bytes lat + 4 bytes lon

pub struct NodeCache {
    mmap: MmapMut,
    count: u64,
}

impl NodeCache {
    /// Build the node cache by streaming all nodes from the PBF.
    pub fn build(pbf_path: &Path, cache_path: &Path) -> Result<Self> {
        let file_size = MAX_NODE_ID * ENTRY_SIZE;

        // Create sparse file
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(cache_path)?;
        file.set_len(file_size)?;

        let mut mmap = unsafe { MmapMut::map_mut(&file)? };
        let mut count = 0u64;

        let reader = ElementReader::from_path(pbf_path)?;

        reader.for_each(|element| {
            let (id, lat, lon) = match element {
                Element::Node(n) => (n.id() as u64, n.lat(), n.lon()),
                Element::DenseNode(n) => (n.id as u64, n.lat(), n.lon()),
                _ => return,
            };

            if id >= MAX_NODE_ID { return; }

            let lat_i32 = (lat * 1e7) as i32;
            let lon_i32 = (lon * 1e7) as i32;

            let offset = (id * ENTRY_SIZE) as usize;
            mmap[offset..offset + 4].copy_from_slice(&lat_i32.to_le_bytes());
            mmap[offset + 4..offset + 8].copy_from_slice(&lon_i32.to_le_bytes());
            count += 1;
        })?;

        mmap.flush()?;

        eprintln!("  Node cache: {} nodes, sparse file {}", count, cache_path.display());
        Ok(NodeCache { mmap, count })
    }

    /// Look up coordinates for a node ID. Returns [lat, lon] as f64.
    pub fn get(&self, node_id: i64) -> Option<[f64; 2]> {
        let id = node_id as u64;
        if id >= MAX_NODE_ID { return None; }

        let offset = (id * ENTRY_SIZE) as usize;
        let lat_i32 = i32::from_le_bytes(self.mmap[offset..offset + 4].try_into().ok()?);
        let lon_i32 = i32::from_le_bytes(self.mmap[offset + 4..offset + 8].try_into().ok()?);

        // Skip unwritten entries (all zeros = 0°N 0°E = middle of ocean, treat as missing)
        if lat_i32 == 0 && lon_i32 == 0 { return None; }

        Some([lat_i32 as f64 / 1e7, lon_i32 as f64 / 1e7])
    }

    pub fn count(&self) -> u64 {
        self.count
    }
}
