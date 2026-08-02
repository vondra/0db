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
use arrow::array::{Array, BinaryArray, Float32Array, Float64Array, UInt8Array};
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
            let low_profile = LowProfileLookup::load(h3r4_dir, cell)?;
            indexes.push(Arc::new(build_cell_index(cell, &dir, &low_profile)?));
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

/// Overwrite one tile's pre-baked `rx_refl_db` with the VECTOR enclosure —
/// the SAME 150 × 150 m nine-probe footprint as the raster 3×3
/// (`noise_compute::…::enclosure_db`; SPEC §3.8). The single bake shared by
/// the CPU builder, the GPU runner, and e2-full (gg review 2026-07-28:
/// three hand-copies drift).
pub fn bake_tile_vector_rx_refl(
    tile: &mut raster_reader::fused_tile_z13::FusedTileZ13,
    set: &ObstacleSet,
) {
    use noise_compute::constants::ENCLOSURE_RADIUS_M;
    use noise_compute::propagation::obstacle_index::enclosure_db;
    use raster_reader::fused_tile_z13::TILE_PX;
    for py in 0..TILE_PX {
        let lat = tile.rx_lat[py];
        for px in 0..TILE_PX {
            tile.rx_refl_db[py * TILE_PX + px] =
                enclosure_db(set, lat, tile.rx_lon[px], ENCLOSURE_RADIUS_M) as f32;
        }
    }
}

/// LOW-PROFILE height cap (2026-08-02, Dobříš garage-colony finding): the
/// Overture obstacle rows carry no building class, so a footprint with no
/// mapped height defaulted to 8 m (`height_tier == 2`) even when it is a
/// garage / carport / shed / greenhouse row that really stands ~2.5–3 m —
/// hundreds of phantom 8 m walls in a 200 m grid over-screen entire
/// neighbourhoods. OSM (via this cell's `buildings.arrow`) DOES know the
/// class; a defaulted obstacle whose centroid sits within [`Self::MATCH_M`]
/// of a low-profile OSM building with a comparable footprint area is capped
/// at [`Self::LOW_HEIGHT_M`] (= one floor, the same constant family as the
/// ingest ladder). Applies at LOAD time so the whole world heals without
/// re-staging the 350 GB obstacle store; deterministic (fixed grid, sorted
/// candidates), and it changes painted output — the OUTPUT_VER bump rides
/// the same commit.
/// (lat, lon, area_m2) rows bucketed by the ~55 m spatial-hash key.
type LowProfileBuckets = std::collections::HashMap<(i32, i32), Vec<(f64, f64, f32)>>;

struct LowProfileLookup {
    /// ~55 m spatial hash over (lat, lon) → (centroid, area_m2) of low-class
    /// OSM buildings; empty when the cell has no `buildings.arrow` (ML-only
    /// coverage) — then nothing is capped, exactly the pre-fix behavior.
    buckets: LowProfileBuckets,
}

impl LowProfileLookup {
    const GRID: f64 = 2000.0; // 1/2000° ≈ 55 m bucket edge
    const MATCH_M: f64 = 15.0;
    const AREA_RATIO: (f32, f32) = (0.4, 2.5);
    const LOW_HEIGHT_M: f32 = 3.0; // = ingest FLOOR_HEIGHT (one floor)
    /// settlement classes that are structurally low: 7 = garage/carport/
    /// parking, SILENT (10) = shed/roof/hut/greenhouse/container/… (the
    /// emission §C′ tail — also the structurally-low tail).
    const LOW_CLASSES: [u8; 2] = [7, noise_compute::emission::settlement::SILENT];

    fn load(h3r4_dir: &Path, cell: CellIndex) -> Result<Self> {
        let path = h3r4_dir.join(cell.to_string()).join("buildings.arrow");
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self {
                    buckets: Default::default(),
                })
            }
            Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
        };
        let reader = FileReader::try_new(Cursor::new(bytes), None)
            .with_context(|| format!("arrow open {}", path.display()))?;
        let mut buckets: LowProfileBuckets = Default::default();
        for batch in reader {
            let batch = batch.with_context(|| format!("arrow batch {}", path.display()))?;
            let (Some(lats), Some(lons), Some(types), Some(areas)) = (
                batch
                    .column_by_name("centroid_lat")
                    .and_then(|c| c.as_any().downcast_ref::<Float64Array>()),
                batch
                    .column_by_name("centroid_lon")
                    .and_then(|c| c.as_any().downcast_ref::<Float64Array>()),
                batch
                    .column_by_name("building_type")
                    .and_then(|c| c.as_any().downcast_ref::<UInt8Array>()),
                batch
                    .column_by_name("area_m2")
                    .and_then(|c| c.as_any().downcast_ref::<Float32Array>()),
            ) else {
                // An older buildings.arrow schema simply means no capping —
                // never a hard error for a correction layer.
                return Ok(Self {
                    buckets: Default::default(),
                });
            };
            for i in 0..batch.num_rows() {
                if lats.is_null(i) || lons.is_null(i) || types.is_null(i) || areas.is_null(i) {
                    continue;
                }
                if !Self::LOW_CLASSES.contains(&types.value(i)) {
                    continue;
                }
                let (lat, lon) = (lats.value(i), lons.value(i));
                let key = (
                    (lat * Self::GRID).floor() as i32,
                    (lon * Self::GRID).floor() as i32,
                );
                buckets
                    .entry(key)
                    .or_default()
                    .push((lat, lon, areas.value(i)));
            }
        }
        Ok(Self { buckets })
    }

    /// Cap a DEFAULTED height when a matching low-profile OSM building sits
    /// at (nearly) the same spot with a comparable footprint.
    fn capped_height(&self, height_m: f32, tier: u8, lat: f64, lon: f64, area_m2: f32) -> f32 {
        if tier != 2 || height_m <= Self::LOW_HEIGHT_M || self.buckets.is_empty() {
            return height_m;
        }
        let key_lat = (lat * Self::GRID).floor() as i32;
        let key_lon = (lon * Self::GRID).floor() as i32;
        let m_per_deg_lon = 111_320.0 * lat.to_radians().cos().max(0.1);
        for dy in -1..=1 {
            for dx in -1..=1 {
                let Some(rows) = self.buckets.get(&(key_lat + dy, key_lon + dx)) else {
                    continue;
                };
                for &(blat, blon, barea) in rows {
                    let dm_lat = (blat - lat) * 111_320.0;
                    let dm_lon = (blon - lon) * m_per_deg_lon;
                    if dm_lat * dm_lat + dm_lon * dm_lon > Self::MATCH_M * Self::MATCH_M {
                        continue;
                    }
                    let ratio = if barea > 0.0 {
                        area_m2 / barea
                    } else {
                        f32::MAX
                    };
                    if ratio >= Self::AREA_RATIO.0 && ratio <= Self::AREA_RATIO.1 {
                        return Self::LOW_HEIGHT_M;
                    }
                }
            }
        }
        height_m
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

/// Outer-ring area (m², shoelace on a local equirectangular projection) —
/// the low-profile cap's footprint-comparability check. Uses the SAME parser
/// the index builder consumes, so the two can never disagree on geometry.
fn outer_ring_area_m2(wkb: &[u8]) -> f32 {
    let mut total = 0.0f64;
    for (outer, _holes) in noise_compute::wkb::parse_wkb_polygons_bytes(wkb) {
        if outer.len() < 4 {
            continue;
        }
        let lat0 = outer[0].0;
        let m_lon = 111_320.0 * lat0.to_radians().cos().max(0.1);
        let mut acc = 0.0f64;
        for w in outer.windows(2) {
            let (x0, y0) = ((w[0].1) * m_lon, (w[0].0) * 111_320.0);
            let (x1, y1) = ((w[1].1) * m_lon, (w[1].0) * 111_320.0);
            acc += x0 * y1 - x1 * y0;
        }
        total += (acc * 0.5).abs();
    }
    total as f32
}

fn build_cell_index(
    cell: CellIndex,
    dir: &Path,
    low_profile: &LowProfileLookup,
) -> Result<ObstacleIndex> {
    let centre = LatLng::from(cell);
    let mut builder = ObstacleIndex::builder(centre.lat(), centre.lng());
    let mut next_id: u32 = 0;
    let mut capped = 0usize;
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
            // Older staging shards lack tier/centroid — then nothing is
            // capped (tier unknowable), matching pre-fix behavior.
            let tiers = batch
                .column_by_name("height_tier")
                .and_then(|c| c.as_any().downcast_ref::<UInt8Array>());
            let clats = batch
                .column_by_name("centroid_lat")
                .and_then(|c| c.as_any().downcast_ref::<Float64Array>());
            let clons = batch
                .column_by_name("centroid_lon")
                .and_then(|c| c.as_any().downcast_ref::<Float64Array>());
            for i in 0..batch.num_rows() {
                if wkb.is_null(i) || heights.is_null(i) {
                    bail!("{}: null row {i}", path.display());
                }
                let mut height = heights.value(i);
                if let (Some(tiers), Some(clats), Some(clons)) = (tiers, clats, clons) {
                    if !tiers.is_null(i) && !clats.is_null(i) && !clons.is_null(i) {
                        let capped_h = low_profile.capped_height(
                            height,
                            tiers.value(i),
                            clats.value(i),
                            clons.value(i),
                            outer_ring_area_m2(wkb.value(i)),
                        );
                        if capped_h < height {
                            capped += 1;
                        }
                        height = capped_h;
                    }
                }
                builder.add_polygon_wkb(wkb.value(i), height, ObstacleKind::Building, next_id);
                next_id = next_id.wrapping_add(1);
            }
        }
    }
    if capped > 0 {
        eprintln!("[obstacles] {cell}: {capped} defaulted heights capped to low-profile 3 m");
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
    /// The low-profile cap's decision matrix (2026-08-02 garage-colony fix):
    /// a DEFAULTED (tier 2) height caps to 3 m only when a low-class OSM
    /// building matches by centroid AND comparable area; mapped heights
    /// (tier 0/1), far buildings, high classes and wild area ratios all keep
    /// the original height.
    #[test]
    fn low_profile_cap_matrix() {
        let mut buckets: LowProfileBuckets = Default::default();
        let (lat, lon) = (49.7778, 14.1636);
        let key = (
            (lat * LowProfileLookup::GRID).floor() as i32,
            (lon * LowProfileLookup::GRID).floor() as i32,
        );
        buckets.insert(key, vec![(lat, lon, 22.0)]); // one 22 m² garage
        let lookup = LowProfileLookup { buckets };

        // Defaulted 8 m footprint on the garage → capped to 3 m.
        assert_eq!(lookup.capped_height(8.0, 2, lat, lon, 24.0), 3.0);
        // Mapped height (tier 0) never caps, even at the same spot.
        assert_eq!(lookup.capped_height(8.0, 0, lat, lon, 24.0), 8.0);
        // Floors-derived (tier 1) never caps.
        assert_eq!(lookup.capped_height(9.0, 1, lat, lon, 24.0), 9.0);
        // 30 m away — outside MATCH_M — keeps the default.
        assert_eq!(lookup.capped_height(8.0, 2, lat + 0.0003, lon, 24.0), 8.0);
        // A big hall (600 m²) over a tiny garage row is NOT comparable.
        assert_eq!(lookup.capped_height(8.0, 2, lat, lon, 600.0), 8.0);
        // Already low stays untouched.
        assert_eq!(lookup.capped_height(2.5, 2, lat, lon, 24.0), 2.5);
        // Empty lookup (no buildings.arrow) = pre-fix behavior.
        let empty = LowProfileLookup {
            buckets: Default::default(),
        };
        assert_eq!(empty.capped_height(8.0, 2, lat, lon, 24.0), 8.0);
    }

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
