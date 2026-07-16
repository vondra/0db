//! Count-bounded LRU of decoded per-R4 aircraft source data, keyed by R4
//! hex. The region runner asks for `grid_disk(1)` (~7 R4s) per region;
//! adjacent regions share neighbours, so a small LRU plus the
//! space-filling traversal (M4) keeps each R4 decoded ≈once instead of
//! ≈7× (the re-load factor the world build lives or dies on).
//!
//! Bounded by R4 *count*, not bytes: per-R4 arrow sizes span 1000×
//! (a few KB rural → 756 MB at a hub), so a byte budget would thrash
//! unpredictably at hubs while a count cap stays simple and the hot
//! working set is dominated by the 2-3 hub R4s regardless. Set the cap
//! ≥ grid_disk(1)=7 or a region re-loads its whole ring every step.
//!
//! Entries are `Arc`, so an evicted R4 that the current region still
//! holds stays alive until that region finishes — eviction only drops
//! the cache's own reference. A multi-threaded build (M5) gives each
//! thread its OWN cache (no shared lock); this type is `&mut self`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;

use crate::source_loader::CruiseData;
use crate::source_loader_airborne::AirborneData;
use crate::source_loader_traffic::AirportTrafficData;

/// Which source layers to decode, mirroring the builder's `--source`
/// flag (ground = airport_traffic). An unselected layer loads empty so a
/// `--source cruise` build neither wastes I/O nor trips on an unrelated
/// stale/corrupt `airborne.arrow` in the same R4.
#[derive(Clone, Copy)]
pub struct SourceSel {
    pub cruise: bool,
    pub airborne: bool,
    pub traffic: bool,
}

impl SourceSel {
    pub const ALL: Self = Self {
        cruise: true,
        airborne: true,
        traffic: true,
    };
}

/// The three co-located source arrows for one R4, decoded and owned.
/// Missing (or unselected) arrow types are empty — the kernels
/// short-circuit on empty input.
pub struct R4Sources {
    pub cruise: CruiseData,
    pub airborne: AirborneData,
    pub traffic: AirportTrafficData,
}

impl R4Sources {
    fn load(h3r4_dir: &Path, r4: u64, sel: SourceSel) -> Result<Self> {
        Ok(Self {
            cruise: if sel.cruise {
                CruiseData::load_for_r4s(h3r4_dir, &[r4])?
            } else {
                CruiseData::empty()
            },
            airborne: if sel.airborne {
                AirborneData::load_for_r4s(h3r4_dir, &[r4])?
            } else {
                AirborneData::empty()
            },
            traffic: if sel.traffic {
                AirportTrafficData::load_for_r4s(h3r4_dir, &[r4])?
            } else {
                AirportTrafficData::empty()
            },
        })
    }
}

pub struct R4SourceCache {
    h3r4_dir: PathBuf,
    cap: usize,
    sel: SourceSel,
    map: HashMap<u64, Arc<R4Sources>>,
    /// MRU order, front = oldest. `cap` is small (tens), so the linear
    /// touch/evict scans are cheaper than a heavier intrusive list.
    order: Vec<u64>,
    hits: u64,
    misses: u64,
}

impl R4SourceCache {
    pub fn new(h3r4_dir: &Path, cap: usize, sel: SourceSel) -> Self {
        Self {
            h3r4_dir: h3r4_dir.to_path_buf(),
            cap: cap.max(1),
            sel,
            map: HashMap::new(),
            order: Vec::new(),
            hits: 0,
            misses: 0,
        }
    }

    /// Return the R4's decoded sources, loading + caching on a miss.
    /// Eviction happens BEFORE the load so the peak resident count stays
    /// at `cap` rather than `cap + 1` — the incoming R4 may be a
    /// multi-hundred-MB hub.
    pub fn get_or_load(&mut self, r4: u64) -> Result<Arc<R4Sources>> {
        if let Some(hit) = self.map.get(&r4).cloned() {
            self.hits += 1;
            self.touch(r4);
            return Ok(hit);
        }
        self.misses += 1;
        while self.map.len() >= self.cap {
            let evict = self.order.remove(0);
            self.map.remove(&evict);
        }
        let loaded = Arc::new(R4Sources::load(&self.h3r4_dir, r4, self.sel)?);
        self.map.insert(r4, Arc::clone(&loaded));
        self.order.push(r4);
        Ok(loaded)
    }

    fn touch(&mut self, r4: u64) {
        if let Some(pos) = self.order.iter().position(|&k| k == r4) {
            self.order.remove(pos);
            self.order.push(r4);
        }
    }

    /// `(hits, misses)` since construction — a `miss` loads one R4's
    /// selected arrows (absent/empty arrows still count as a load). A
    /// high hit rate means the region traversal order keeps each
    /// region's grid_disk(1) ring hot across neighbouring regions.
    pub fn stats(&self) -> (u64, u64) {
        (self.hits, self.misses)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Non-existent R4 dirs load as empty R4Sources (no error), so the LRU
    // bookkeeping is exercisable without fixture arrows.
    #[test]
    fn hit_returns_same_arc() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = R4SourceCache::new(tmp.path(), 4, SourceSel::ALL);
        let a1 = c.get_or_load(1).unwrap();
        let a2 = c.get_or_load(1).unwrap();
        assert!(Arc::ptr_eq(&a1, &a2), "second get must hit the cache");
    }

    #[test]
    fn evicts_least_recently_used() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = R4SourceCache::new(tmp.path(), 2, SourceSel::ALL);
        let a = c.get_or_load(1).unwrap();
        c.get_or_load(2).unwrap();
        c.get_or_load(3).unwrap(); // cap 2 → evicts 1 (oldest)
        let a_again = c.get_or_load(1).unwrap(); // reloaded → fresh Arc
        assert!(!Arc::ptr_eq(&a, &a_again), "1 should have been evicted");
    }

    #[test]
    fn touch_protects_recently_used() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = R4SourceCache::new(tmp.path(), 2, SourceSel::ALL);
        let a = c.get_or_load(1).unwrap();
        c.get_or_load(2).unwrap();
        let a_touch = c.get_or_load(1).unwrap(); // touch 1 → now 2 is oldest
        assert!(Arc::ptr_eq(&a, &a_touch), "1 still cached, must be a hit");
        c.get_or_load(3).unwrap(); // evicts 2, keeps 1
        let a_final = c.get_or_load(1).unwrap();
        assert!(Arc::ptr_eq(&a, &a_final), "touched 1 must survive eviction");
    }
}
