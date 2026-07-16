//! Read `railways.arrow` for a set of H3 R4 hex cells into per-segment
//! [`LineRow`]s with pre-computed per-period emission — the rail analogue of
//! [`crate::source_loader_road`]. One on-disk row is one railway microsegment
//! (geometry + train columns); no per-vehicle row explosion, so no group-by.
//!
//! Normalisation + emission run ONCE here at load: the raw row →
//! [`RawRailInput`] → [`normalize_rail`] (resolves speed, applies the
//! `service` × `parallel_divisor` traffic scaling, picks type/usage default
//! train counts) → [`NormalizedRail::period_emissions`] (CNOSSOS Annex IV
//! rolling + traction `L_W'/m` per band, per period). This is the exact chain
//! the popup runs at `RailSegment` construction (`source-reader::lib`), so the
//! scatter result matches `compute_railways` to quantisation noise.
//!
//! Rows that the popup would drop are dropped here too — tunnels (no outdoor
//! noise) and segments whose scaled train count is zero — so the scatter
//! kernel never sees a segment that contributes nothing. `admin` drives the C1
//! per-region day/evening/night split (EU freight runs ~55 % at night vs ~33 %
//! world); the popup resolves it per receiver, the heatmap once per region
//! (uniform within a ~75 km region except border cells), exactly like road.

use std::path::Path;

use anyhow::Result;
use arrow::array::{BooleanArray, Float32Array, Float64Array, Int32Array, UInt16Array, UInt8Array};
use arrow::record_batch::RecordBatch;
use noise_compute::admin::Admin;
use noise_compute::normalize::{normalize_rail, RawRailInput};
use noise_compute::propagation::geo::flat_dist;

use crate::source_line::{db_bands_to_lin, opt, LineRow};

pub struct RailData {
    rows: Vec<LineRow>,
}

impl RailData {
    /// Load + normalise every `railways.arrow` row across `r4_hexes`. `admin` is
    /// the region's admin (for the C1 per-region period split). Missing files
    /// are skipped (R4s with no railways).
    pub fn load_for_r4s(h3r4_dir: &Path, r4_hexes: &[u64], admin: Admin) -> Result<Self> {
        let mut rows = Vec::new();
        for &r4 in r4_hexes {
            crate::schema_check::read_surface_arrow_for_r4(
                h3r4_dir,
                r4,
                "railways.arrow",
                |batch| absorb_batch(batch, admin, &mut rows),
            )?;
        }
        Ok(Self { rows })
    }

    pub fn into_rows(self) -> Vec<LineRow> {
        self.rows
    }
}

fn absorb_batch(batch: &RecordBatch, admin: Admin, out: &mut Vec<LineRow>) -> Result<()> {
    let n = batch.num_rows();
    if n == 0 {
        return Ok(());
    }
    // Geometry is required; everything else defaults (popup-lenient reads).
    let (Some(slat), Some(slon), Some(elat), Some(elon)) = (
        opt::<Float64Array>(batch, "start_lat"),
        opt::<Float64Array>(batch, "start_lon"),
        opt::<Float64Array>(batch, "end_lat"),
        opt::<Float64Array>(batch, "end_lon"),
    ) else {
        return Ok(());
    };
    let length = opt::<Float32Array>(batch, "length_m");
    let rail_type = opt::<UInt8Array>(batch, "rail_type");
    let usage = opt::<UInt8Array>(batch, "usage");
    // Width-tolerant: new extracts write UInt16 maxspeed (300+ km/h
    // overflowed u8), pre-2026-06 arrows carry UInt8.
    let maxspeed_u16 = opt::<UInt16Array>(batch, "maxspeed");
    let maxspeed_u8 = opt::<UInt8Array>(batch, "maxspeed");
    let service = opt::<UInt8Array>(batch, "service");
    let highspeed = opt::<BooleanArray>(batch, "highspeed");
    let trains_pax = opt::<Int32Array>(batch, "trains_passenger");
    let trains_frt = opt::<Int32Array>(batch, "trains_freight");
    let par_div = opt::<UInt8Array>(batch, "parallel_divisor");
    let bridge = opt::<BooleanArray>(batch, "bridge");
    let tunnel = opt::<BooleanArray>(batch, "tunnel");

    for i in 0..n {
        // Tunnels emit no outdoor noise — the popup skips them in compute.
        if tunnel.map(|a| a.value(i)).unwrap_or(false) {
            continue;
        }
        let norm = normalize_rail(
            RawRailInput {
                rail_type: rail_type.map(|a| a.value(i)).unwrap_or(0),
                usage: usage.map(|a| a.value(i)).unwrap_or(0),
                maxspeed: maxspeed_u16
                    .map(|a| a.value(i))
                    .or_else(|| maxspeed_u8.map(|a| a.value(i) as u16))
                    .unwrap_or(0),
                service: service.map(|a| a.value(i)).unwrap_or(0),
                highspeed: highspeed.map(|a| a.value(i)).unwrap_or(false),
                trains_passenger: trains_pax.map(|a| a.value(i)).unwrap_or(0),
                trains_freight: trains_frt.map(|a| a.value(i)).unwrap_or(0),
                parallel_divisor: par_div.map(|a| a.value(i)).unwrap_or(1),
            },
            admin,
        );
        // No trains in any period → no emission (compute_railways' q≤0 cull).
        if norm.scaled_passenger_per_day + norm.scaled_freight_per_day <= 0.0 {
            continue;
        }
        let s_lat = slat.value(i);
        let s_lon = slon.value(i);
        let e_lat = elat.value(i);
        let e_lon = elon.value(i);
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
            // Per-row reach: this segment's own 25 dB Lden crossing, clamped
            // [2 km, 10 km]. The popup's `compute_railways` gate calls the same
            // `rail_reach_m` solver → identical cutoff (parity by construction).
            max_distance_m: norm.max_distance_m(),
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
    use noise_compute::admin::Continent;
    use noise_compute::types::NUM_BANDS;
    use std::sync::Arc;

    /// CZ admin so the C1 EU freight night split (0.5458) is exercised — the
    /// mainline test rows below are EU-corridor-shaped (100 pax + 40 freight).
    const CZ: Admin = Admin {
        continent: Continent::Europe,
        country_iso: *b"CZ",
        city_id: 0,
    };

    /// One-row railways batch. `parallel_divisor` and `tunnel` are the test
    /// knobs; a mainline (rail_type 0, usage 0) with explicit train counts so
    /// the type-default fallback is bypassed.
    fn rail_batch(parallel_divisor: u8, tunnel: bool) -> RecordBatch {
        rail_batch_with_maxspeed(
            parallel_divisor,
            tunnel,
            Field::new("maxspeed", DataType::UInt16, false),
            Arc::new(UInt16Array::from(vec![120u16])),
        )
    }

    /// Column vec for a one-row mainline batch (100 pax + 40 freight @ 120 km/h),
    /// UInt16 maxspeed. Shared by `rail_batch_with_maxspeed` and the pax-only
    /// test (which overwrites index 12 = `trains_freight`).
    fn base_cols(parallel_divisor: u8, tunnel: bool) -> Vec<(Field, ArrayRef)> {
        vec![
            (
                Field::new("osm_id", DataType::Int64, false),
                Arc::new(Int64Array::from(vec![1i64])),
            ),
            (
                Field::new("start_lat", DataType::Float64, false),
                Arc::new(Float64Array::from(vec![49.95])),
            ),
            (
                Field::new("start_lon", DataType::Float64, false),
                Arc::new(Float64Array::from(vec![14.40])),
            ),
            (
                Field::new("end_lat", DataType::Float64, false),
                Arc::new(Float64Array::from(vec![49.96])),
            ),
            (
                Field::new("end_lon", DataType::Float64, false),
                Arc::new(Float64Array::from(vec![14.41])),
            ),
            (
                Field::new("length_m", DataType::Float32, false),
                Arc::new(Float32Array::from(vec![180.0f32])),
            ),
            (
                Field::new("rail_type", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![0u8])),
            ),
            (
                Field::new("usage", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![0u8])),
            ),
            (
                Field::new("maxspeed", DataType::UInt16, false),
                Arc::new(UInt16Array::from(vec![120u16])),
            ),
            (
                Field::new("service", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![0u8])),
            ),
            (
                Field::new("highspeed", DataType::Boolean, false),
                Arc::new(BooleanArray::from(vec![false])),
            ),
            (
                Field::new("trains_passenger", DataType::Int32, false),
                Arc::new(Int32Array::from(vec![100i32])),
            ),
            (
                Field::new("trains_freight", DataType::Int32, false),
                Arc::new(Int32Array::from(vec![40i32])),
            ),
            (
                Field::new("parallel_divisor", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![parallel_divisor])),
            ),
            (
                Field::new("bridge", DataType::Boolean, false),
                Arc::new(BooleanArray::from(vec![false])),
            ),
            (
                Field::new("tunnel", DataType::Boolean, false),
                Arc::new(BooleanArray::from(vec![tunnel])),
            ),
        ]
    }

    fn rail_batch_with_maxspeed(
        parallel_divisor: u8,
        tunnel: bool,
        maxspeed_field: Field,
        maxspeed_arr: ArrayRef,
    ) -> RecordBatch {
        // Replace the maxspeed column BY NAME (index-free).
        let mut maxspeed = Some((maxspeed_field, maxspeed_arr));
        let cols: Vec<(Field, ArrayRef)> = base_cols(parallel_divisor, tunnel)
            .into_iter()
            .map(|(f, a)| {
                if f.name() == "maxspeed" {
                    maxspeed.take().unwrap()
                } else {
                    (f, a)
                }
            })
            .collect();
        let fields: Vec<Field> = cols.iter().map(|(f, _)| f.clone()).collect();
        let arrs: Vec<ArrayRef> = cols.into_iter().map(|(_, a)| a).collect();
        RecordBatch::try_new(Arc::new(Schema::new(fields)), arrs).unwrap()
    }

    #[test]
    fn loads_and_precomputes_positive_emission() {
        let mut rows = Vec::new();
        absorb_batch(&rail_batch(1, false), CZ, &mut rows).unwrap();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert!((r.length_m - 180.0).abs() < 1e-3);
        // Per-row reach: the loader must set the segment's own 25 dB crossing
        // (clamp band), NOT a blanket constant. Independently re-solve from the
        // same normalized inputs (mainline 100 pax + 40 freight @ 120 km/h, CZ
        // admin) to prove the wiring goes through `rail_reach_m` with the same
        // per-region split.
        let expect = noise_compute::emission::railway::rail_reach_m(
            CZ,
            noise_compute::emission::railway::RailType::Rail,
            120.0,
            100.0,
            40.0,
        );
        assert_eq!(
            r.max_distance_m, expect,
            "loader reach must equal the row's solved reach"
        );
        assert!(
            (2_000.0..=10_000.0).contains(&r.max_distance_m),
            "reach {} m out of clamp band",
            r.max_distance_m
        );
        assert!(
            (r.source_height_m - 0.5).abs() < 1e-9,
            "rail source height 0.5 m"
        );
        for p in 0..3 {
            assert!(
                r.emission_lin[p].iter().all(|&e| e > 0.0),
                "period {p} band energy"
            );
        }
        // C1 (plan §3.5): this freight-heavy EU mainline (100 pax + 40 freight,
        // freight +9.6 dB/train) now has NIGHT hourly Leq density exceeding day —
        // EU freight runs 54.6 % at night over only 8 h vs 34 % over 12 h. The
        // pre-C1 flat 65/20/15 split made day always exceed night; the flip is
        // the entire point of the milestone (was the OLD assertion here).
        let sum = |b: &[f32; NUM_BANDS]| b.iter().sum::<f32>();
        assert!(
            sum(&r.emission_lin[2]) > sum(&r.emission_lin[0]),
            "freight-heavy EU night Leq {} must exceed day {}",
            sum(&r.emission_lin[2]),
            sum(&r.emission_lin[0]),
        );
    }

    /// A TRAM (rail_type 1, urban pax curve, night share 0.05, no freight ever)
    /// keeps day Leq above night — proving the split is per-CATEGORY: the night
    /// flip is freight-specific, not a blanket inversion. (A pax-only `RailType::
    /// Rail` row can't be expressed in the arrow — `trains_freight = 0` triggers
    /// the type-default freight fallback in `normalize_rail`; the emission-level
    /// pax-only shift is pinned in `noise_compute::emission::railway` tests.)
    #[test]
    fn tram_keeps_day_above_night() {
        let cols: Vec<(Field, ArrayRef)> = base_cols(1, false)
            .into_iter()
            .map(|(f, a)| {
                if f.name() == "rail_type" {
                    (f, Arc::new(UInt8Array::from(vec![1u8])) as ArrayRef) // tram
                } else {
                    (f, a)
                }
            })
            .collect();
        let fields: Vec<Field> = cols.iter().map(|(f, _)| f.clone()).collect();
        let arrs: Vec<ArrayRef> = cols.into_iter().map(|(_, a)| a).collect();
        let batch = RecordBatch::try_new(Arc::new(Schema::new(fields)), arrs).unwrap();
        let mut rows = Vec::new();
        absorb_batch(&batch, CZ, &mut rows).unwrap();
        let r = &rows[0];
        let sum = |b: &[f32; NUM_BANDS]| b.iter().sum::<f32>();
        assert!(
            sum(&r.emission_lin[0]) > sum(&r.emission_lin[2]),
            "tram day Leq {} must exceed night {}",
            sum(&r.emission_lin[0]),
            sum(&r.emission_lin[2]),
        );
    }

    #[test]
    fn tunnel_rows_are_dropped() {
        let mut rows = Vec::new();
        absorb_batch(&rail_batch(1, true), CZ, &mut rows).unwrap();
        assert!(rows.is_empty(), "tunnel dropped");
    }

    /// Pre-2026-06 arrows store `maxspeed` as UInt8 — the tolerant read
    /// must produce the same emission as the current UInt16 layout.
    #[test]
    fn legacy_u8_maxspeed_loads_identically() {
        let mut new = Vec::new();
        let mut legacy = Vec::new();
        absorb_batch(&rail_batch(1, false), CZ, &mut new).unwrap();
        absorb_batch(
            &rail_batch_with_maxspeed(
                1,
                false,
                Field::new("maxspeed", DataType::UInt8, false),
                Arc::new(UInt8Array::from(vec![120u8])),
            ),
            CZ,
            &mut legacy,
        )
        .unwrap();
        assert_eq!(legacy.len(), 1);
        assert_eq!(
            new[0].emission_lin, legacy[0].emission_lin,
            "u8 fallback parity"
        );
    }

    /// `parallel_divisor` halves the effective traffic, so the per-band linear
    /// emission of a divisor-2 track is ~half that of divisor-1 — the loader's
    /// independent check on the scaling the parity gate shares with the popup.
    #[test]
    fn parallel_divisor_scales_emission_down() {
        let mut one = Vec::new();
        let mut two = Vec::new();
        absorb_batch(&rail_batch(1, false), CZ, &mut one).unwrap();
        absorb_batch(&rail_batch(2, false), CZ, &mut two).unwrap();
        let e1: f32 = one[0].emission_lin[0].iter().sum();
        let e2: f32 = two[0].emission_lin[0].iter().sum();
        let ratio = e2 / e1;
        // Q halves → ~0.5× linear band energy (within float tolerance).
        assert!(
            (ratio - 0.5).abs() < 0.02,
            "divisor-2 ≈ half divisor-1, got {ratio:.3}"
        );
    }
}
