//! Load the vector obstacle store for a region (geodata-v2 1.5) — the
//! pipeline twin of `source-reader::obstacle_store`; keep loading policy in
//! lockstep (the barrier loader ↔ popup precedent).
//!
//! Reads per-H3R4-cell `obstacles*.arrow` shards (Overture footprints +
//! heights, `scripts/obstacles/ingest-overture-obstacles.py`) into per-cell
//! [`ObstacleIndex`]es (origin = cell centre) shared across the region's
//! tile batches as an [`ObstacleSet`]. Roots per cell, first hit wins: the
//! PROMOTED tree (`h3r4_dir/<cell>/`, post-Wave-1) then the enrichment
//! staging tree; `QM_OBSTACLES_DIR` overrides (tests).
//!
//! ALL-OR-RASTER (gg review 2026-07-28): a MISSING ring cell (strict
//! default) disables vector obstacles for the WHOLE region — a partial index
//! would silently delete raster buildings where coverage is absent;
//! `QM_OBSTACLES_ALLOW_PARTIAL=1` admits missing halo NEIGHBOURS at staging
//! frontiers for dev A/B, but never the region's own cell (popup's
//! query-cell rule). A shard READ/PARSE error — including a failed
//! directory listing — is a hard `Err` that fails the region build: a
//! pipeline must never silently paint with different physics than requested
//! (the popup, facing users, soft-falls to raster instead).

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use arrow::array::{Array, BinaryArray, Float32Array};
use arrow::ipc::reader::FileReader;
use h3o::{CellIndex, LatLng};
use noise_compute::propagation::obstacle_index::{
    vector_buildings_enabled, ObstacleIndex, ObstacleKind, ObstacleSet,
};

/// A region's vector obstacles: `None` ⇒ every scatter keeps the raster path.
pub struct ObstacleData {
    set: Option<Arc<ObstacleSet>>,
}

impl ObstacleData {
    /// Vector obstacles disabled (flag off / not ingested / policy fallback).
    pub fn off() -> Self {
        ObstacleData { set: None }
    }

    /// The region set, if vector mode is live.
    pub fn set(&self) -> Option<&ObstacleSet> {
        self.set.as_deref()
    }

    /// Load per-cell indexes for the region's ring when
    /// `QM_VECTOR_BUILDINGS=1`. Follows the all-or-raster policy above; a
    /// policy fallback logs and returns [`ObstacleData::off`], a shard ERROR
    /// is a hard `Err` (a pipeline region must not silently paint with
    /// different physics than requested).
    ///
    /// `region_r4` is the cell being PAINTED: even under
    /// `QM_OBSTACLES_ALLOW_PARTIAL=1` it must be ingested — partial mode
    /// admits a missing halo NEIGHBOUR at a staging frontier, never a
    /// missing centre (deleting the centre's raster buildings with no
    /// footprints to replace them). Same rule as the popup store's
    /// query-cell requirement.
    pub fn load_for_r4s(h3r4_dir: &Path, region_r4: u64, r4_hexes: &[u64]) -> Result<Self> {
        if !vector_buildings_enabled() {
            return Ok(Self::off());
        }
        let allow_partial = std::env::var("QM_OBSTACLES_ALLOW_PARTIAL").is_ok_and(|v| v == "1");
        let mut indexes = Vec::new();
        for &r4 in r4_hexes {
            let cell = CellIndex::try_from(r4).context("invalid r4 hex")?;
            let Some(dir) = cell_dir(h3r4_dir, cell)? else {
                if allow_partial && r4 != region_r4 {
                    continue;
                }
                eprintln!(
                    "[obstacles] {} cell {cell} not ingested — region stays on the raster \
                     path (QM_OBSTACLES_ALLOW_PARTIAL=1 admits missing halo neighbours \
                     for dev A/B)",
                    if r4 == region_r4 { "REGION" } else { "ring" },
                );
                return Ok(Self::off());
            };
            indexes.push(Arc::new(build_cell_index(cell, &dir)?));
        }
        let set = ObstacleSet { indexes };
        if set.edge_count() == 0 {
            return Ok(Self::off());
        }
        eprintln!(
            "[obstacles] vector mode: {} edges across {} cells",
            set.edge_count(),
            set.indexes.len()
        );
        Ok(ObstacleData {
            set: Some(Arc::new(set)),
        })
    }
}

fn staging_root(h3r4_dir: &Path) -> PathBuf {
    if let Ok(dir) = std::env::var("QM_OBSTACLES_DIR") {
        return PathBuf::from(dir);
    }
    // h3r4_dir = <root>/data/prepared/{year}/h3r4 → <root>/data/enrichment/…
    h3r4_dir
        .ancestors()
        .nth(3)
        .map(|d| d.join("enrichment/global/overture-obstacles/h3r4"))
        .unwrap_or_else(|| PathBuf::from("data/enrichment/global/overture-obstacles/h3r4"))
}

fn cell_dir(h3r4_dir: &Path, cell: CellIndex) -> Result<Option<PathBuf>> {
    if std::env::var("QM_OBSTACLES_DIR").is_err() {
        let promoted = h3r4_dir.join(cell.to_string());
        if !shard_paths(&promoted)?.is_empty() {
            return Ok(Some(promoted));
        }
    }
    let staged = staging_root(h3r4_dir).join(cell.to_string());
    Ok((!shard_paths(&staged)?.is_empty()).then_some(staged))
}

/// Sorted shard listing — deterministic obstacle ordinals per on-disk state.
/// A missing directory is a legitimate "not ingested" (`Ok(empty)`); any
/// OTHER I/O failure is a hard error — a permission or disk fault must not
/// read as "cell missing" and silently activate an incomplete index
/// (gg review 2026-07-28).
fn shard_paths(dir: &Path) -> Result<Vec<PathBuf>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("read_dir {}", dir.display())),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.with_context(|| format!("read_dir entry in {}", dir.display()))?;
        let p = entry.path();
        if p.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("obstacles") && n.ends_with(".arrow"))
        {
            out.push(p);
        }
    }
    out.sort();
    Ok(out)
}

fn build_cell_index(cell: CellIndex, dir: &Path) -> Result<ObstacleIndex> {
    let centre = LatLng::from(cell);
    let mut builder = ObstacleIndex::builder(centre.lat(), centre.lng());
    let mut next_id: u32 = 0;
    let shards = shard_paths(dir)?;
    if shards.is_empty() {
        bail!("shard dir emptied under us: {}", dir.display());
    }
    for path in shards {
        let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        let reader = FileReader::try_new(Cursor::new(bytes), None)
            .with_context(|| format!("arrow open {}", path.display()))?;
        for batch in reader {
            let batch = batch.with_context(|| format!("arrow batch {}", path.display()))?;
            let (Some(wkb), Some(heights)) = (
                batch
                    .column_by_name("polygon_wkb")
                    .and_then(|c| c.as_any().downcast_ref::<BinaryArray>()),
                batch
                    .column_by_name("height_m")
                    .and_then(|c| c.as_any().downcast_ref::<Float32Array>()),
            ) else {
                bail!("{}: missing polygon_wkb/height_m", path.display());
            };
            for i in 0..batch.num_rows() {
                if wkb.is_null(i) || heights.is_null(i) {
                    bail!("{}: null row {i}", path.display());
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
    use arrow::array::Float32Array;
    use h3o::{LatLng, Resolution};

    /// One tiny valid shard: a single closed ~20 m square footprint at
    /// (lat, lon), WKB little-endian Polygon, 1 ring × 5 points.
    fn write_shard(dir: &Path, lat: f64, lon: f64) {
        std::fs::create_dir_all(dir).unwrap();
        let schema = arrow::datatypes::Schema::new(vec![
            arrow::datatypes::Field::new("polygon_wkb", arrow::datatypes::DataType::Binary, false),
            arrow::datatypes::Field::new("height_m", arrow::datatypes::DataType::Float32, false),
        ]);
        let mut wkb: Vec<u8> = vec![1, 3, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0];
        for (dlon, dlat) in [
            (0.0, 0.0),
            (3e-4, 0.0),
            (3e-4, 2e-4),
            (0.0, 2e-4),
            (0.0, 0.0),
        ] {
            wkb.extend_from_slice(&f64::to_le_bytes(lon + dlon));
            wkb.extend_from_slice(&f64::to_le_bytes(lat + dlat));
        }
        let batch = arrow::record_batch::RecordBatch::try_new(
            Arc::new(schema.clone()),
            vec![
                Arc::new(arrow::array::BinaryArray::from_vec(vec![&wkb])),
                Arc::new(Float32Array::from(vec![9.0_f32])),
            ],
        )
        .unwrap();
        let file = std::fs::File::create(dir.join("obstacles-TEST.arrow")).unwrap();
        let mut w = arrow::ipc::writer::FileWriter::try_new(file, &schema).unwrap();
        w.write(&batch).unwrap();
        w.finish().unwrap();
    }

    /// The whole pipeline loading policy in ONE test (env vars are process
    /// globals; a single body keeps the assertions order-independent):
    /// full ring loads; a missing halo neighbour → raster-off strict but
    /// loads under partial; a missing REGION cell → raster-off EVEN under
    /// partial (the popup's query-cell rule); a corrupt shard → hard Err.
    #[test]
    fn loading_policy_matrix() {
        let tmp = std::env::temp_dir().join(format!("qm-obst-pipe-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::set_var("QM_VECTOR_BUILDINGS", "1");
        std::env::set_var("QM_OBSTACLES_DIR", tmp.to_str().unwrap());
        std::env::remove_var("QM_OBSTACLES_ALLOW_PARTIAL");

        let region = LatLng::new(50.08, 14.43).unwrap().to_cell(Resolution::Four);
        let ring: Vec<u64> = region
            .grid_disk::<Vec<_>>(1)
            .into_iter()
            .map(u64::from)
            .collect();
        let h3r4 = tmp.join("unused-h3r4");
        let last = *ring.last().unwrap(); // a halo neighbour (grid_disk puts the centre first)
        assert_ne!(last, u64::from(region));

        // All but one halo cell ingested.
        for &r4 in &ring {
            if r4 == last {
                continue;
            }
            let c = CellIndex::try_from(r4).unwrap();
            let centre = LatLng::from(c);
            write_shard(&tmp.join(c.to_string()), centre.lat(), centre.lng());
        }

        let strict = ObstacleData::load_for_r4s(&h3r4, u64::from(region), &ring).unwrap();
        assert!(
            strict.set().is_none(),
            "missing halo neighbour must stay raster (strict)"
        );

        std::env::set_var("QM_OBSTACLES_ALLOW_PARTIAL", "1");
        let partial = ObstacleData::load_for_r4s(&h3r4, u64::from(region), &ring).unwrap();
        let set = partial
            .set()
            .expect("partial mode admits a staging frontier");
        assert_eq!(set.indexes.len(), ring.len() - 1);
        assert!(set.edge_count() >= 4 * (ring.len() - 1));

        // Missing REGION cell: even partial mode must refuse.
        std::fs::remove_dir_all(tmp.join(region.to_string())).unwrap();
        let no_region = ObstacleData::load_for_r4s(&h3r4, u64::from(region), &ring).unwrap();
        assert!(
            no_region.set().is_none(),
            "missing REGION cell must stay raster even partial"
        );

        // Corrupt shard in an ingested cell: hard Err, not a silent fallback.
        let centre = LatLng::from(region);
        write_shard(&tmp.join(region.to_string()), centre.lat(), centre.lng());
        std::fs::write(
            tmp.join(region.to_string()).join("obstacles-BAD.arrow"),
            b"garbage",
        )
        .unwrap();
        assert!(
            ObstacleData::load_for_r4s(&h3r4, u64::from(region), &ring).is_err(),
            "corrupt shard must fail the region build"
        );

        std::env::remove_var("QM_OBSTACLES_DIR");
        std::env::remove_var("QM_OBSTACLES_ALLOW_PARTIAL");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
