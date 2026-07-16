//! Read `roads.arrow` for a set of H3 R4 hex cells into per-segment rows
//! with pre-computed per-period emission. Each on-disk row is one road
//! microsegment (geometry + traffic columns); there is no per-vehicle-class
//! row explosion, so no group-by is needed (unlike airport_traffic).
//!
//! Normalisation + emission run ONCE here at load (not per pixel): the raw
//! row → [`RawRoadInput`] → [`normalize_road_with_cache`] (drops tunnels /
//! no-access, applies one-way × access × lane factors, junction speed cap,
//! surface correction) → [`NormalizedRoad::period_emissions`] (CNOSSOS
//! Annex II `L_W'/m` per octave band, per period). We store the per-period
//! emission as LINEAR band energy (`10^(dB/10)`) so the scatter hot loop
//! multiplies by a shared per-pixel path factor without a per-pixel `exp`.
//!
//! Column reads mirror the popup road reader (`source-reader::hex_store`):
//! only the geometry is required; every attribute column defaults when
//! absent, so base (un-enriched) extracts — which lack `aadt_*` — still load
//! with class-default traffic. roads.arrow has no aircraft `schema_version`,
//! so the surface read path skips that gate (per-column reads are the gate).
//!
//! `admin` drives the class-default AADT cascade for unenriched rows; the
//! popup resolves it per receiver, the heatmap resolves it once per region
//! (uniform within a ~75 km region except border cells). Enriched roads
//! (real AADT) ignore admin entirely, so the motorway parity tile is exact.

use std::path::Path;

use anyhow::Result;
use arrow::array::{BooleanArray, Float32Array, Float64Array, Int32Array, UInt16Array, UInt8Array};
use arrow::record_batch::RecordBatch;
use noise_compute::admin::Admin;
use noise_compute::defaults::{build_traffic_default_cache, Aadt, WORLD_DEFAULT};
use noise_compute::normalize::{normalize_road_with_cache, RawRoadInput};
use noise_compute::propagation::geo::flat_dist;
use noise_compute::sources::provenance_of;

use crate::source_line::{db_bands_to_lin, opt, LineRow};

pub struct RoadData {
    rows: Vec<LineRow>,
}

impl RoadData {
    /// Load + normalise every `roads.arrow` row across `r4_hexes`. `admin`
    /// is the region's admin (for the default-AADT cascade on unenriched
    /// rows). Missing files are skipped (rural R4s have no roads).
    pub fn load_for_r4s(h3r4_dir: &Path, r4_hexes: &[u64], admin: Admin) -> Result<Self> {
        // Build the 13-class default-AADT cascade ONCE per load (region
        // admin), not per row — `normalize_road` would rebuild it each call.
        let cache = build_traffic_default_cache(admin);
        let mut rows = Vec::new();
        for &r4 in r4_hexes {
            crate::schema_check::read_surface_arrow_for_r4(h3r4_dir, r4, "roads.arrow", |batch| {
                absorb_batch(batch, admin, &cache, &mut rows)
            })?;
        }
        Ok(Self { rows })
    }

    pub fn into_rows(self) -> Vec<LineRow> {
        self.rows
    }
}

fn absorb_batch(
    batch: &RecordBatch,
    admin: Admin,
    cache: &[Aadt; WORLD_DEFAULT.len()],
    out: &mut Vec<LineRow>,
) -> Result<()> {
    let n = batch.num_rows();
    if n == 0 {
        return Ok(());
    }
    // Geometry is required; a batch lacking it has nothing to scatter.
    let (Some(slat), Some(slon), Some(elat), Some(elon)) = (
        opt::<Float64Array>(batch, "start_lat"),
        opt::<Float64Array>(batch, "start_lon"),
        opt::<Float64Array>(batch, "end_lat"),
        opt::<Float64Array>(batch, "end_lon"),
    ) else {
        return Ok(());
    };
    // Every attribute column defaults when absent — the popup's lenient
    // defaults for the acoustic fields (osm_id / length_m differ harmlessly:
    // we don't read identity, and length falls back to the endpoint distance).
    let length = opt::<Float32Array>(batch, "length_m");
    let rclass = opt::<UInt8Array>(batch, "road_class");
    let speed = opt::<UInt8Array>(batch, "speed_limit");
    // Absent on pre-taper arrows → 0 = none (R7 taper writes it).
    let speed_taper = opt::<UInt8Array>(batch, "speed_taper");
    let surface = opt::<UInt8Array>(batch, "surface_type");
    let oneway = opt::<BooleanArray>(batch, "oneway");
    let lanes = opt::<UInt8Array>(batch, "lanes");
    let access = opt::<UInt8Array>(batch, "access");
    let junction = opt::<UInt8Array>(batch, "junction");
    let aadt_l = opt::<Int32Array>(batch, "aadt_light");
    let aadt_m = opt::<Int32Array>(batch, "aadt_medium");
    let aadt_h = opt::<Int32Array>(batch, "aadt_heavy");
    let aadt_mo = opt::<Int32Array>(batch, "aadt_moto");
    let source_id = opt::<UInt16Array>(batch, "source_id");
    let bridge = opt::<BooleanArray>(batch, "bridge");
    let tunnel = opt::<BooleanArray>(batch, "tunnel");
    // Absent on pre-migration arrows → 0 = unknown → the legacy speed table.
    let built_up = opt::<UInt8Array>(batch, "built_up");

    for i in 0..n {
        let raw = RawRoadInput {
            road_class: rclass.map(|a| a.value(i)).unwrap_or(0),
            speed_limit: speed.map(|a| a.value(i)).unwrap_or(0),
            speed_taper: speed_taper.map(|a| a.value(i)).unwrap_or(0),
            surface_type: surface.map(|a| a.value(i)).unwrap_or(0),
            oneway: oneway.map(|a| a.value(i)).unwrap_or(false),
            lanes: lanes.map(|a| a.value(i)).unwrap_or(0),
            aadt_light: aadt_l.map(|a| a.value(i)).unwrap_or(0),
            aadt_medium: aadt_m.map(|a| a.value(i)).unwrap_or(0),
            aadt_heavy: aadt_h.map(|a| a.value(i)).unwrap_or(0),
            aadt_moto: aadt_mo.map(|a| a.value(i)).unwrap_or(0),
            provenance: provenance_of(source_id.map(|a| a.value(i)).unwrap_or(0)),
            tunnel: tunnel.map(|a| a.value(i)).unwrap_or(false),
            access: access.map(|a| a.value(i)).unwrap_or(0),
            junction: junction.map(|a| a.value(i)).unwrap_or(0),
            built_up: built_up.map(|a| a.value(i)).unwrap_or(0),
        };
        // Drops tunnels / access=no — the same gate the popup applies.
        let Some(norm) = normalize_road_with_cache(raw, admin, cache) else {
            continue;
        };
        let s_lat = slat.value(i);
        let s_lon = slon.value(i);
        let e_lat = elat.value(i);
        let e_lon = elon.value(i);
        // length_m is always written by osm-extract; fall back to the
        // endpoint distance if a stray batch omits/zeroes it.
        let len_m = length
            .map(|a| a.value(i))
            .filter(|l| *l > 0.0)
            .unwrap_or_else(|| flat_dist(s_lat, s_lon, e_lat, e_lon) as f32);
        let (day, eve, night) = norm.period_emissions();
        out.push(LineRow {
            start_lat: s_lat,
            start_lon: s_lon,
            end_lat: e_lat,
            end_lon: e_lon,
            length_m: len_m,
            max_distance_m: norm.max_distance_m,
            source_height_m: norm.source_height_m,
            bridge: bridge.map(|a| a.value(i)).unwrap_or(false),
            emission_lin: [
                db_bands_to_lin(day),
                db_bands_to_lin(eve),
                db_bands_to_lin(night),
            ],
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{ArrayRef, Int64Array};
    use arrow::datatypes::{DataType, Field, Schema};
    use noise_compute::types::NUM_BANDS;
    use std::sync::Arc;

    fn cache() -> [Aadt; WORLD_DEFAULT.len()] {
        build_traffic_default_cache(Admin::UNKNOWN)
    }

    /// Build a one-row roads batch; `drop` removes a named column to test
    /// the geometry gate / attribute leniency. A motorway (class 0) with
    /// enriched AADT so the admin default cascade is bypassed (exact emission).
    fn road_batch(tunnel: bool, access: u8, drop: Option<&str>) -> RecordBatch {
        let cols: Vec<(Field, ArrayRef)> = vec![
            (
                Field::new("osm_id", DataType::Int64, false),
                Arc::new(Int64Array::from(vec![1i64])),
            ),
            (
                Field::new("start_lat", DataType::Float64, false),
                Arc::new(Float64Array::from(vec![50.10])),
            ),
            (
                Field::new("start_lon", DataType::Float64, false),
                Arc::new(Float64Array::from(vec![14.30])),
            ),
            (
                Field::new("end_lat", DataType::Float64, false),
                Arc::new(Float64Array::from(vec![50.11])),
            ),
            (
                Field::new("end_lon", DataType::Float64, false),
                Arc::new(Float64Array::from(vec![14.31])),
            ),
            (
                Field::new("length_m", DataType::Float32, false),
                Arc::new(Float32Array::from(vec![120.0f32])),
            ),
            (
                Field::new("road_class", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![0u8])),
            ),
            (
                Field::new("speed_limit", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![130u8])),
            ),
            (
                Field::new("surface_type", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![0u8])),
            ),
            (
                Field::new("oneway", DataType::Boolean, false),
                Arc::new(BooleanArray::from(vec![false])),
            ),
            (
                Field::new("lanes", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![4u8])),
            ),
            (
                Field::new("access", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![access])),
            ),
            (
                Field::new("junction", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![0u8])),
            ),
            (
                Field::new("aadt_light", DataType::Int32, false),
                Arc::new(Int32Array::from(vec![50_000i32])),
            ),
            (
                Field::new("aadt_medium", DataType::Int32, false),
                Arc::new(Int32Array::from(vec![5_000i32])),
            ),
            (
                Field::new("aadt_heavy", DataType::Int32, false),
                Arc::new(Int32Array::from(vec![8_000i32])),
            ),
            (
                Field::new("aadt_moto", DataType::Int32, false),
                Arc::new(Int32Array::from(vec![500i32])),
            ),
            (
                Field::new("source_id", DataType::UInt16, false),
                Arc::new(UInt16Array::from(vec![1u16])),
            ),
            (
                Field::new("tunnel", DataType::Boolean, false),
                Arc::new(BooleanArray::from(vec![tunnel])),
            ),
        ];
        let cols: Vec<_> = cols
            .into_iter()
            .filter(|(f, _)| Some(f.name().as_str()) != drop)
            .collect();
        let fields: Vec<Field> = cols.iter().map(|(f, _)| f.clone()).collect();
        let arrs: Vec<ArrayRef> = cols.into_iter().map(|(_, a)| a).collect();
        RecordBatch::try_new(Arc::new(Schema::new(fields)), arrs).unwrap()
    }

    #[test]
    fn loads_and_precomputes_positive_emission() {
        let mut rows = Vec::new();
        absorb_batch(
            &road_batch(false, 0, None),
            Admin::UNKNOWN,
            &cache(),
            &mut rows,
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert!((r.length_m - 120.0).abs() < 1e-3);
        assert_eq!(r.max_distance_m, 10_000.0, "motorway reach");
        assert!((r.source_height_m - 0.05).abs() < 1e-9);
        for p in 0..3 {
            assert!(
                r.emission_lin[p].iter().all(|&e| e > 0.0),
                "period {p} band energy"
            );
        }
        let sum = |b: &[f32; NUM_BANDS]| b.iter().sum::<f32>();
        assert!(
            sum(&r.emission_lin[0]) > sum(&r.emission_lin[2]),
            "day > night energy"
        );
    }

    #[test]
    fn tunnel_and_no_access_rows_are_dropped() {
        let mut rows = Vec::new();
        absorb_batch(
            &road_batch(true, 0, None),
            Admin::UNKNOWN,
            &cache(),
            &mut rows,
        )
        .unwrap();
        assert!(rows.is_empty(), "tunnel dropped");
        // access=no with MEASURED AADT (fixture: source_id=1 GlobalMeasured,
        // aadt_light 50k) passes the gate — measured reality outranks the tag
        // (normalize/road.rs, Neratovice case 2026-07-10).
        absorb_batch(
            &road_batch(false, 2, None),
            Admin::UNKNOWN,
            &cache(),
            &mut rows,
        )
        .unwrap();
        assert_eq!(rows.len(), 1, "access=no + measured AADT emits");
        rows.clear();
        // Same row WITHOUT the aadt_light column (reads 0): fail-closed drop —
        // a measured stamp with zero light traffic must not fall through to
        // class defaults on a closed road.
        absorb_batch(
            &road_batch(false, 2, Some("aadt_light")),
            Admin::UNKNOWN,
            &cache(),
            &mut rows,
        )
        .unwrap();
        assert!(
            rows.is_empty(),
            "access=no without light traffic stays dropped"
        );
    }

    #[test]
    fn missing_geometry_skips_batch_missing_attribute_defaults() {
        // Dropping a geometry column → whole batch skipped (popup-identical).
        let mut rows = Vec::new();
        absorb_batch(
            &road_batch(false, 0, Some("start_lat")),
            Admin::UNKNOWN,
            &cache(),
            &mut rows,
        )
        .unwrap();
        assert!(rows.is_empty(), "no geometry → skip");
        // Dropping an attribute column (no aadt_* → base extract) still
        // loads with class-default traffic, NOT an error.
        absorb_batch(
            &road_batch(false, 0, Some("aadt_light")),
            Admin::UNKNOWN,
            &cache(),
            &mut rows,
        )
        .unwrap();
        assert_eq!(
            rows.len(),
            1,
            "missing aadt_light defaults, row still loads"
        );
        assert!(rows[0].emission_lin[0].iter().all(|&e| e > 0.0));
    }
}
