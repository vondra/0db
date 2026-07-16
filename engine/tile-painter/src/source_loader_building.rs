//! Read `buildings.arrow` (and `leisure.arrow`) for a set of H3 R4 hex cells
//! into per-point [`PointRow`]s — the building counterpart of
//! [`crate::source_loader_industrial`]. One on-disk building row is one
//! footprint; [`prepare_building_points`] resolves its emission profile (by
//! `building_type`, GFA-scaled by area × floors), splits a large polygon into a
//! 30 m grid (`Lw − 10·log10(N)` per point), sets source height to mid-facade
//! (`height/2`), and an emission-dependent reach capped at 2 km. This is the
//! exact chain the popup runs (`source-reader::lib`), so the scatter matches
//! `compute_point_sources` to quantisation noise.
//!
//! Settlement v2 phase 2: leisure AREA sources (sports pitch / playground /
//! pool / beer garden) FOLD into this building layer (one HM3 source id, one
//! frontend toggle) — `leisure.arrow` rows discretise via
//! [`prepare_leisure_points`] into the SAME [`PointRow`] stream, so the
//! per-layer `building` tile stays independent and needs no new wiring.

use std::path::Path;

use anyhow::Result;
use arrow::array::{BinaryArray, Float32Array, Float64Array, UInt8Array};
use arrow::record_batch::RecordBatch;
use noise_compute::normalize::{
    prepare_building_points, prepare_leisure_points, RawBuildingInput, RawLeisureInput,
};

use crate::source_line::opt;
use crate::source_loader_industrial::{hex_encode, pos_f32};
use crate::source_point::PointRow;

pub struct BuildingData {
    rows: Vec<PointRow>,
}

impl BuildingData {
    /// Load + discretise every `buildings.arrow` + `leisure.arrow` row across
    /// `r4_hexes`. Missing files are skipped (R4s with no buildings/leisure).
    pub fn load_for_r4s(h3r4_dir: &Path, r4_hexes: &[u64]) -> Result<Self> {
        use crate::schema_check::{
            read_surface_arrow_for_r4_with_contract, BUILDINGS_CONTRACT_V2, LEISURE_CONTRACT_V1,
        };
        let mut rows = Vec::new();
        for &r4 in r4_hexes {
            read_surface_arrow_for_r4_with_contract(
                h3r4_dir,
                r4,
                "buildings.arrow",
                "buildings_contract",
                BUILDINGS_CONTRACT_V2,
                |batch| absorb_batch(batch, &mut rows),
            )?;
            read_surface_arrow_for_r4_with_contract(
                h3r4_dir,
                r4,
                "leisure.arrow",
                "leisure_contract",
                LEISURE_CONTRACT_V1,
                |batch| absorb_leisure_batch(batch, &mut rows),
            )?;
        }
        Ok(Self { rows })
    }

    pub fn into_rows(self) -> Vec<PointRow> {
        self.rows
    }
}

/// Discretise one `leisure.arrow` batch into the building-layer point stream.
fn absorb_leisure_batch(batch: &RecordBatch, out: &mut Vec<PointRow>) -> Result<()> {
    let n = batch.num_rows();
    if n == 0 {
        return Ok(());
    }
    let (Some(clat), Some(clon)) = (
        opt::<Float64Array>(batch, "centroid_lat"),
        opt::<Float64Array>(batch, "centroid_lon"),
    ) else {
        return Ok(());
    };
    let sport = opt::<UInt8Array>(batch, "sport");
    let area = opt::<Float32Array>(batch, "area_m2");
    let wkb = opt::<BinaryArray>(batch, "polygon_wkb");

    for i in 0..n {
        // Null WKB (a leisure NODE without a footprint) reads as empty bytes
        // → centroid-only source in prepare_leisure_points (mirrors the building
        // path's lenient `value(i)` read).
        let wkb_hex = wkb.map(|a| hex_encode(a.value(i))).unwrap_or_default();
        let points = prepare_leisure_points(RawLeisureInput {
            centroid_lat: clat.value(i),
            centroid_lon: clon.value(i),
            sport: sport.map(|a| a.value(i)).unwrap_or(0),
            area_m2: area.and_then(|a| pos_f32(a.value(i)).map(f64::from)),
            polygon_wkb: &wkb_hex,
        });
        out.extend(points.iter().map(PointRow::from_prepared));
    }
    Ok(())
}

fn absorb_batch(batch: &RecordBatch, out: &mut Vec<PointRow>) -> Result<()> {
    let n = batch.num_rows();
    if n == 0 {
        return Ok(());
    }
    // Centroid is required; everything else defaults (popup-lenient reads).
    let (Some(clat), Some(clon)) = (
        opt::<Float64Array>(batch, "centroid_lat"),
        opt::<Float64Array>(batch, "centroid_lon"),
    ) else {
        return Ok(());
    };
    let height = opt::<Float32Array>(batch, "height");
    let floors = opt::<UInt8Array>(batch, "floors");
    let btype = opt::<UInt8Array>(batch, "building_type");
    let area = opt::<Float32Array>(batch, "area_m2");
    let wkb = opt::<BinaryArray>(batch, "polygon_wkb");

    for i in 0..n {
        let wkb_hex = wkb.map(|a| hex_encode(a.value(i))).unwrap_or_default();
        let points = prepare_building_points(RawBuildingInput {
            centroid_lat: clat.value(i),
            centroid_lon: clon.value(i),
            height_m: height.map(|a| a.value(i)).unwrap_or(0.0),
            floors: floors.map(|a| a.value(i)).unwrap_or(0),
            building_type: btype.map(|a| a.value(i)).unwrap_or(0),
            area_m2: area.and_then(|a| pos_f32(a.value(i)).map(f64::from)),
            polygon_wkb: &wkb_hex,
        });
        out.extend(points.iter().map(PointRow::from_prepared));
    }
    Ok(())
}
