//! Vector obstacle loading for the popup (geodata-v2 1.4).
//!
//! When `QM_VECTOR_BUILDINGS=1`, each query assembles an
//! [`ObstacleSet`] from PER-CELL [`ObstacleIndex`]es covering the query
//! cell's `grid_disk(1)` — the halo the ingest contract requires
//! (centroid-assigned footprints; `scripts/obstacles/ingest-overture-obstacles.py`).
//!
//! Two hard rules from the gg review (2026-07-28):
//! - **Bounded cost.** Per-cell indexes are built ONCE per process and
//!   LRU-cached (`CELL_CACHE_CAP`); a query only Arc-clones ≤7 of them.
//!   The naive per-query rebuild measured 448 MB RSS / 0.47 s per popup.
//! - **All-or-raster.** Any shard read/parse error, and by default any
//!   MISSING ring-1 cell, aborts the whole load → the query keeps the
//!   legacy raster path (loudly, via stderr). A partial index would delete
//!   raster buildings where coverage is absent — silent under-screening.
//!   `QM_OBSTACLES_ALLOW_PARTIAL=1` relaxes ONLY the missing-cell rule for
//!   dev A/B runs inside a partially staged world; shard errors always abort.
//!
//! Shard roots, per cell, first hit wins: the PROMOTED tree
//! (`…/prepared/{year}/h3r4/<cell>/obstacles*.arrow`, post-Wave-1) and the
//! ENRICHMENT staging tree the ingest writes today. `QM_OBSTACLES_DIR`
//! overrides both (tests).

use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use arrow::array::{Array, BinaryArray, Float32Array};
use arrow::ipc::reader::FileReader;
use h3o::{CellIndex, LatLng, Resolution};
use noise_compute::propagation::obstacle_index::{ObstacleIndex, ObstacleKind, ObstacleSet};

/// Per-cell index cache capacity. A dense metro cell's index runs to low
/// hundreds of MB; popups cluster spatially, so a small LRU covers the
/// active area while bounding worst-case RSS.
const CELL_CACHE_CAP: usize = 8;

struct CellCache {
    /// cell → (index, LRU stamp). Failed builds are NOT cached — transient
    /// IO must stay retryable; missing cells stay a per-query decision.
    map: HashMap<CellIndex, (Arc<ObstacleIndex>, u64)>,
    stamp: u64,
}

static CELL_CACHE: OnceLock<Mutex<CellCache>> = OnceLock::new();

fn staging_root(data_dir: &Path) -> PathBuf {
    if let Ok(dir) = std::env::var("QM_OBSTACLES_DIR") {
        return PathBuf::from(dir);
    }
    data_dir
        .parent()
        .map(|d| d.join("enrichment/global/overture-obstacles/h3r4"))
        .unwrap_or_else(|| PathBuf::from("data/enrichment/global/overture-obstacles/h3r4"))
}

/// The cell's shard directory: promoted tree first (post-Wave-1 layout),
/// staging second. `None` when the cell is nowhere ingested.
fn cell_dir(h3r4_dir: Option<&Path>, data_dir: &Path, cell: CellIndex) -> Option<PathBuf> {
    if std::env::var("QM_OBSTACLES_DIR").is_err() {
        if let Some(h3r4) = h3r4_dir {
            let promoted = h3r4.join(cell.to_string());
            if has_shards(&promoted) {
                return Some(promoted);
            }
        }
    }
    let staged = staging_root(data_dir).join(cell.to_string());
    has_shards(&staged).then_some(staged)
}

fn has_shards(dir: &Path) -> bool {
    shard_paths(dir).map(|v| !v.is_empty()).unwrap_or(false)
}

/// Sorted shard listing — deterministic iteration keeps the query-local
/// obstacle ordinals stable for one on-disk state.
fn shard_paths(dir: &Path) -> Option<Vec<PathBuf>> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("obstacles") && n.ends_with(".arrow"))
        })
        .collect();
    out.sort();
    Some(out)
}

/// Assemble the query's [`ObstacleSet`]. `None` ⇒ caller keeps the raster
/// path (not ingested here, incomplete ring coverage under the strict
/// default, or any shard error).
pub fn load_obstacle_set(
    h3r4_dir: Option<&Path>,
    data_dir: &Path,
    lat: f64,
    lon: f64,
) -> Option<ObstacleSet> {
    let allow_partial = std::env::var("QM_OBSTACLES_ALLOW_PARTIAL").is_ok_and(|v| v == "1");
    let cell = LatLng::new(lat, lon).ok()?.to_cell(Resolution::Four);
    let mut indexes = Vec::new();
    for c in cell.grid_disk::<Vec<_>>(1) {
        let Some(dir) = cell_dir(h3r4_dir, data_dir, c) else {
            if c == cell {
                return None; // query cell itself not ingested — plain raster
            }
            if allow_partial {
                continue; // dev A/B at the staging frontier — documented risk
            }
            eprintln!(
                "obstacle_store: ring cell {c} not ingested — falling back to raster \
                 (set QM_OBSTACLES_ALLOW_PARTIAL=1 only for dev A/B)"
            );
            return None;
        };
        match cell_index(c, &dir) {
            Ok(idx) => indexes.push(idx),
            Err(e) => {
                eprintln!("obstacle_store: {e} — falling back to raster for this query");
                return None;
            }
        }
    }
    let set = ObstacleSet { indexes };
    if set.edge_count() == 0 {
        None
    } else {
        Some(set)
    }
}

/// Cached per-cell index. Build errors are not cached; successful builds are
/// immutable and shared.
fn cell_index(cell: CellIndex, dir: &Path) -> Result<Arc<ObstacleIndex>, String> {
    let cache = CELL_CACHE.get_or_init(|| {
        Mutex::new(CellCache {
            map: HashMap::new(),
            stamp: 0,
        })
    });
    {
        let mut c = cache.lock().unwrap_or_else(|e| e.into_inner());
        c.stamp += 1;
        let stamp = c.stamp;
        if let Some((idx, touched)) = c.map.get_mut(&cell) {
            *touched = stamp;
            return Ok(Arc::clone(idx));
        }
    }

    let built = Arc::new(build_cell_index(cell, dir)?);
    let mut c = cache.lock().unwrap_or_else(|e| e.into_inner());
    c.stamp += 1;
    let stamp = c.stamp;
    if c.map.len() >= CELL_CACHE_CAP {
        if let Some((&evict, _)) = c.map.iter().min_by_key(|(_, (_, t))| *t) {
            c.map.remove(&evict);
        }
    }
    c.map.insert(cell, (Arc::clone(&built), stamp));
    Ok(built)
}

/// Build one cell's index from its sorted shards. The index origin is the
/// CELL CENTRE (not the query point) so the cache entry is query-independent;
/// crossings project the ray per call, so mixed origins across a set are fine.
fn build_cell_index(cell: CellIndex, dir: &Path) -> Result<ObstacleIndex, String> {
    let centre = LatLng::from(cell);
    let mut builder = ObstacleIndex::builder(centre.lat(), centre.lng());
    let mut next_id: u32 = 0;
    let shards =
        shard_paths(dir).ok_or_else(|| format!("unreadable shard dir {}", dir.display()))?;
    for path in shards {
        let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let reader = FileReader::try_new(Cursor::new(bytes), None)
            .map_err(|e| format!("arrow open {}: {e}", path.display()))?;
        for batch in reader {
            let batch = batch.map_err(|e| format!("arrow batch {}: {e}", path.display()))?;
            let wkb = batch
                .column_by_name("polygon_wkb")
                .and_then(|c| c.as_any().downcast_ref::<BinaryArray>())
                .ok_or_else(|| format!("{}: missing polygon_wkb", path.display()))?;
            let heights = batch
                .column_by_name("height_m")
                .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
                .ok_or_else(|| format!("{}: missing height_m", path.display()))?;
            for i in 0..batch.num_rows() {
                if wkb.is_null(i) || heights.is_null(i) {
                    return Err(format!("{}: null row {i}", path.display()));
                }
                builder.add_polygon_wkb(
                    wkb.value(i),
                    heights.value(i),
                    ObstacleKind::Building,
                    next_id,
                );
                next_id = next_id.wrapping_add(1);
            }
        }
    }
    Ok(builder.build())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs only where the Praha obstacle staging exists (dev boxes after the
    /// geodata-v2 night-1 ingest); hermetic CI skips silently. Asserts the
    /// REAL scale (the gg review flagged a >10k assertion as hiding it) and
    /// that the second load is a cache hit, not a rebuild.
    #[test]
    fn loads_praha_set_and_caches_cells() {
        let data_dir = Path::new("../../data/prepared");
        let staged = data_dir
            .parent()
            .map(|d| d.join("enrichment/global/overture-obstacles/h3r4"))
            .is_some_and(|d| d.is_dir());
        if !staged {
            return;
        }
        std::env::set_var("QM_OBSTACLES_ALLOW_PARTIAL", "1");
        let t0 = std::time::Instant::now();
        let Some(set) = load_obstacle_set(None, data_dir, 50.08, 14.43) else {
            std::env::remove_var("QM_OBSTACLES_ALLOW_PARTIAL");
            return; // cell not ingested on this box — skip
        };
        let cold = t0.elapsed();
        assert!(
            set.edge_count() > 100_000,
            "central Praha must index >100k edges, got {}",
            set.edge_count()
        );
        let mut out = Vec::new();
        set.crossings(50.08, 14.43, 50.095, 14.45, &mut out);
        assert!(
            !out.is_empty(),
            "a 2 km central-Praha ray must cross footprints"
        );
        assert!(out.windows(2).all(|w| w[0].t <= w[1].t));

        let t1 = std::time::Instant::now();
        let set2 = load_obstacle_set(None, data_dir, 50.08, 14.43).expect("cached reload");
        let warm = t1.elapsed();
        assert_eq!(set2.edge_count(), set.edge_count());
        assert!(
            warm < cold / 5,
            "second load must be a cache hit: cold {cold:?}, warm {warm:?}"
        );
        std::env::remove_var("QM_OBSTACLES_ALLOW_PARTIAL");
    }

    /// Strict default: a missing ring cell aborts to the raster path; the
    /// dev override admits the partial disk.
    #[test]
    fn missing_ring_cell_falls_back_unless_partial_allowed() {
        let tmp = std::env::temp_dir().join(format!("qm-obst-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let cell = LatLng::new(50.08, 14.43).unwrap().to_cell(Resolution::Four);
        let dir = tmp.join(cell.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        // One tiny valid shard: a single closed square footprint (~20 m), WKB
        // little-endian Polygon with 1 ring × 5 points.
        let schema = arrow::datatypes::Schema::new(vec![
            arrow::datatypes::Field::new("polygon_wkb", arrow::datatypes::DataType::Binary, false),
            arrow::datatypes::Field::new("height_m", arrow::datatypes::DataType::Float32, false),
        ]);
        let mut wkb: Vec<u8> = vec![1, 3, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0];
        for (lon, lat) in [
            (14.4300, 50.0800),
            (14.4303, 50.0800),
            (14.4303, 50.0802),
            (14.4300, 50.0802),
            (14.4300, 50.0800),
        ] {
            wkb.extend_from_slice(&f64::to_le_bytes(lon));
            wkb.extend_from_slice(&f64::to_le_bytes(lat));
        }
        let batch = arrow::record_batch::RecordBatch::try_new(
            Arc::new(schema.clone()),
            vec![
                Arc::new(BinaryArray::from_vec(vec![&wkb])),
                Arc::new(Float32Array::from(vec![9.0_f32])),
            ],
        )
        .unwrap();
        let file = std::fs::File::create(dir.join("obstacles-TEST.arrow")).unwrap();
        let mut w = arrow::ipc::writer::FileWriter::try_new(file, &schema).unwrap();
        w.write(&batch).unwrap();
        w.finish().unwrap();

        std::env::set_var("QM_OBSTACLES_DIR", tmp.to_str().unwrap());
        std::env::remove_var("QM_OBSTACLES_ALLOW_PARTIAL");
        let strict = load_obstacle_set(None, Path::new("/nonexistent"), 50.08, 14.43);
        assert!(
            strict.is_none(),
            "missing ring cells must fall back to raster"
        );

        std::env::set_var("QM_OBSTACLES_ALLOW_PARTIAL", "1");
        let partial = load_obstacle_set(None, Path::new("/nonexistent"), 50.08, 14.43);
        assert!(
            partial.is_some(),
            "dev override must admit the partial disk"
        );
        assert_eq!(partial.unwrap().edge_count(), 4);

        std::env::remove_var("QM_OBSTACLES_DIR");
        std::env::remove_var("QM_OBSTACLES_ALLOW_PARTIAL");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
