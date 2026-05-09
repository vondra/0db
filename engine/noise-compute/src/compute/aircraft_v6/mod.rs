//! `compute_aircraft_v6` — popup entry point that consumes the v6
//! popup arrows directly via typed column views (no Arrow / IPC
//! dependency in noise-compute).
//!
//! Architecture: airborne + cruise rows are converted to
//! `AircraftSegment`s and run through the existing
//! [`compute_aircraft`] kernel (Doc 29 + segment-level NPD + per-flight
//! stats + band counters). Ground rows skip that path entirely — Stage
//! 2C v2 already aggregated per-bucket emission energy into the
//! `em_*_bands` columns under the `dB_sum_v6_1` contract, so we feed
//! those bands straight into [`propagate_variants_full`] without
//! re-bucketing or re-computing reference SEL. This is the
//! "n_days bifurcation" the plan calls out: airborne / cruise still
//! divide by `n_days`, ground does not.

use crate::compute_path_effects;
use crate::periods;
use crate::propagation::iso9613::{self, SourceGeometry};
use crate::types::{
    AircraftBandData, AircraftGroundOpsClassDetail, AircraftGroundOpsDetail, AircraftMetadata,
    AircraftSegment, Barrier, Contributor, LayerKind, NoisePeriods, PropagationBaseline,
    PropagationVariants, RasterSampler, Receiver, ScreeningBreakdown, SourceMetadata,
    TerrainBreakdown, TraceCollector, VegetationBreakdown,
};

pub mod airborne;
pub mod cruise;
pub mod ground;
pub mod views;

pub use views::{AirborneRowView, BBox, CruiseRowView, GroundRowView, SubSegmentSlice};

const NUM_BANDS: usize = 8;

/// Pure-view popup compute. The signature is the v6 contract; airborne
/// + cruise rows are expanded into `AircraftSegment`s under the hood
/// to reuse the existing kernel — that's a temporary bridge while the
/// per-row kernel path is being built. Ground propagation already
/// runs row-direct.
pub fn compute_aircraft_v6(
    receiver: &Receiver,
    airborne_rows: &[AirborneRowView<'_>],
    cruise_rows: &[CruiseRowView<'_>],
    ground_rows: &[GroundRowView<'_>],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    n_days: u16,
    traces: Option<&mut TraceCollector>,
) -> (NoisePeriods, Vec<Contributor>, AircraftBandData) {
    let n_days_f = (n_days as f64).max(1.0);

    let airborne_segs = airborne::expand(airborne_rows);
    let cruise_segs = cruise::expand(cruise_rows);
    let mut ac_segs: Vec<AircraftSegment> =
        Vec::with_capacity(airborne_segs.len() + cruise_segs.len());
    ac_segs.extend(airborne_segs);
    ac_segs.extend(cruise_segs);

    let (ac_periods, ac_contribs, ac_band_data) = crate::compute_aircraft(
        receiver,
        &ac_segs,
        &[],
        &[],
        barriers,
        rasters,
        n_days,
        traces,
    );

    let g_res = ground::run(receiver, ground_rows, barriers, rasters);

    let (g_periods, g_contribs, g_band) =
        build_ground_outputs(receiver, barriers, rasters, &g_res, n_days_f);

    let combined_periods =
        combine_periods(&ac_band_data.airborne.periods, &g_periods, &ac_periods);
    let mut contributors: Vec<Contributor> = Vec::new();
    contributors.extend(ac_contribs.into_iter().filter(|c| {
        c.subtype == "airborne"
            || matches!(
                c.metadata.as_ref(),
                Some(SourceMetadata::Aircraft(meta)) if meta.variant == "airborne"
            )
    }));
    contributors.extend(g_contribs);

    let band_data = AircraftBandData {
        airborne: ac_band_data.airborne,
        ground_ops: g_band,
    };

    (combined_periods, contributors, band_data)
}

fn periods_from_normalized(energy: [f64; 3]) -> NoisePeriods {
    if energy.iter().sum::<f64>() <= 0.0 {
        return NoisePeriods::silence();
    }
    periods::periods(
        PropagationVariants::to_db(energy[0]),
        PropagationVariants::to_db(energy[1]),
        PropagationVariants::to_db(energy[2]),
    )
}

fn periods_from_variants_field(
    variants: &[PropagationVariants; 3],
    field: fn(&PropagationVariants) -> f64,
) -> NoisePeriods {
    periods_from_normalized([field(&variants[0]), field(&variants[1]), field(&variants[2])])
}

fn build_ground_outputs(
    receiver: &Receiver,
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    res: &ground::GroundResult,
    n_days_f: f64,
) -> (NoisePeriods, Vec<Contributor>, AircraftGroundOpsDetail) {
    let total = periods_from_variants_field(&res.global_variants, |v| v.full_energy);
    let total_free = periods_from_variants_field(&res.global_variants, |v| v.free_field_energy);
    let no_terrain = periods_from_variants_field(&res.global_variants, |v| v.no_terrain_energy);
    let no_screening = periods_from_variants_field(&res.global_variants, |v| v.no_screening_energy);
    let no_vegetation =
        periods_from_variants_field(&res.global_variants, |v| v.no_vegetation_energy);
    let no_ground = periods_from_variants_field(&res.global_variants, |v| v.no_ground_energy);
    let no_atmospheric =
        periods_from_variants_field(&res.global_variants, |v| v.no_atmospheric_energy);

    let (terrain, screening, vegetation) = if res.min_dist.is_finite() {
        compute_path_effects(
            rasters,
            barriers,
            res.cp_lat,
            res.cp_lon,
            res.src_height,
            receiver,
            res.min_dist,
            0.0,
        )
    } else {
        (
            TerrainBreakdown::default(),
            ScreeningBreakdown::default(),
            VegetationBreakdown::default(),
        )
    };

    let baseline = if res.min_dist.is_finite() {
        iso9613::compute_baseline(res.min_d_slant, SourceGeometry::Line, res.min_ground_g)
    } else {
        PropagationBaseline::default()
    };

    let received_bands: [f64; NUM_BANDS] = std::array::from_fn(|i| {
        let band_total = res.global_variants[0].band_energy[i]
            + res.global_variants[1].band_energy[i]
            + res.global_variants[2].band_energy[i];
        if band_total > 0.0 {
            10.0 * band_total.log10()
        } else {
            f64::NEG_INFINITY
        }
    });

    let detail = AircraftGroundOpsDetail {
        periods: total.clone(),
        periods_free: total_free,
        observed_movements_per_day: round1(res.n_observed_window / n_days_f),
        modeled_movements_per_day: round1(res.n_modeled_window / n_days_f),
        distance_m: if res.min_dist.is_finite() { res.min_dist } else { 0.0 },
        emission_db: 0.0,
        received_bands,
        runway_roll: kind_detail(
            &res.global_kind_variants[0],
            res.n_observed_by_kind_window[0] / n_days_f,
            res.n_modeled_by_kind_window[0] / n_days_f,
        ),
        taxi: kind_detail(
            &res.global_kind_variants[1],
            res.n_observed_by_kind_window[1] / n_days_f,
            res.n_modeled_by_kind_window[1] / n_days_f,
        ),
        apron_movement: kind_detail(
            &res.global_kind_variants[2],
            res.n_observed_by_kind_window[2] / n_days_f,
            res.n_modeled_by_kind_window[2] / n_days_f,
        ),
        baseline,
        terrain,
        screening,
        vegetation,
        terrain_impact_db: aircraft_impact(&total, &no_terrain, false),
        screening_impact_db: aircraft_impact(&total, &no_screening, false),
        vegetation_impact_db: aircraft_impact(&total, &no_vegetation, false),
        atmospheric_impact_db: aircraft_impact(&total, &no_atmospheric, false),
        ground_impact_db: aircraft_impact(&total, &no_ground, true),
    };

    let mut airport_keys: Vec<&String> = res.airports.keys().collect();
    airport_keys.sort();
    let mut contribs = Vec::new();
    for ak in airport_keys {
        let acc = &res.airports[ak];
        let airport_periods = periods_from_variants_field(&acc.variants, |v| v.full_energy);
        if !airport_periods.lden_db.is_finite() {
            continue;
        }
        let airport_periods_free =
            periods_from_variants_field(&acc.variants, |v| v.free_field_energy);
        let airport_no_terrain =
            periods_from_variants_field(&acc.variants, |v| v.no_terrain_energy);
        let airport_no_screening =
            periods_from_variants_field(&acc.variants, |v| v.no_screening_energy);
        let airport_no_vegetation =
            periods_from_variants_field(&acc.variants, |v| v.no_vegetation_energy);
        let airport_no_ground =
            periods_from_variants_field(&acc.variants, |v| v.no_ground_energy);
        let airport_no_atmospheric =
            periods_from_variants_field(&acc.variants, |v| v.no_atmospheric_energy);
        let (a_terrain, a_screening, a_vegetation) = compute_path_effects(
            rasters,
            barriers,
            acc.cp_lat,
            acc.cp_lon,
            acc.src_height,
            receiver,
            acc.min_dist,
            0.0,
        );
        let airport_baseline =
            iso9613::compute_baseline(acc.min_d_slant, SourceGeometry::Line, acc.min_ground_g);
        let received_bands_per_airport: [f64; NUM_BANDS] = std::array::from_fn(|i| {
            let band_total = acc.variants[0].band_energy[i]
                + acc.variants[1].band_energy[i]
                + acc.variants[2].band_energy[i];
            if band_total > 0.0 {
                10.0 * band_total.log10()
            } else {
                f64::NEG_INFINITY
            }
        });
        let airport_detail = AircraftGroundOpsDetail {
            periods: airport_periods.clone(),
            periods_free: airport_periods_free,
            observed_movements_per_day: round1(acc.n_observed_window / n_days_f),
            modeled_movements_per_day: round1(acc.n_modeled_window / n_days_f),
            distance_m: acc.min_dist,
            emission_db: 0.0,
            received_bands: received_bands_per_airport,
            runway_roll: kind_detail(
                &acc.kind_variants[0],
                acc.n_observed_by_kind_window[0] / n_days_f,
                acc.n_modeled_by_kind_window[0] / n_days_f,
            ),
            taxi: kind_detail(
                &acc.kind_variants[1],
                acc.n_observed_by_kind_window[1] / n_days_f,
                acc.n_modeled_by_kind_window[1] / n_days_f,
            ),
            apron_movement: kind_detail(
                &acc.kind_variants[2],
                acc.n_observed_by_kind_window[2] / n_days_f,
                acc.n_modeled_by_kind_window[2] / n_days_f,
            ),
            baseline: airport_baseline,
            terrain: a_terrain,
            screening: a_screening,
            vegetation: a_vegetation,
            terrain_impact_db: aircraft_impact(&airport_periods, &airport_no_terrain, false),
            screening_impact_db: aircraft_impact(&airport_periods, &airport_no_screening, false),
            vegetation_impact_db: aircraft_impact(&airport_periods, &airport_no_vegetation, false),
            atmospheric_impact_db: aircraft_impact(
                &airport_periods,
                &airport_no_atmospheric,
                false,
            ),
            ground_impact_db: aircraft_impact(&airport_periods, &airport_no_ground, true),
        };
        contribs.push(Contributor {
            osm_id: None,
            geometry: Some(serde_json::json!({
                "type": "MultiLineString",
                "coordinates": acc.line_coords.clone(),
            })),
            baseline: airport_detail.baseline.clone(),
            terrain: airport_detail.terrain.clone(),
            screening: airport_detail.screening.clone(),
            vegetation: airport_detail.vegetation.clone(),
            terrain_impact_db: airport_detail.terrain_impact_db,
            screening_impact_db: airport_detail.screening_impact_db,
            vegetation_impact_db: airport_detail.vegetation_impact_db,
            atmospheric_impact_db: airport_detail.atmospheric_impact_db,
            ground_impact_db: airport_detail.ground_impact_db,
            source_type: LayerKind::Aircraft,
            name: format!("Aircraft - {} ground ops", acc.name),
            subtype: "ground_ops".to_string(),
            distance_m: acc.min_dist,
            periods: airport_periods.clone(),
            periods_free: airport_detail.periods_free.clone(),
            emission_db: airport_periods.lden_db,
            received_bands: airport_detail.received_bands,
            metadata: Some(SourceMetadata::Aircraft(AircraftMetadata {
                variant: "ground_ops".to_string(),
                airport_name: Some(acc.name.clone()),
                airport_key: Some(acc.airport_key.clone()),
                airborne: None,
                ground_ops: Some(airport_detail),
            })),
        });
    }

    (total, contribs, detail)
}

fn kind_detail(
    variants: &[PropagationVariants; 3],
    observed_per_day: f64,
    modeled_per_day: f64,
) -> AircraftGroundOpsClassDetail {
    AircraftGroundOpsClassDetail {
        periods: periods_from_variants_field(variants, |v| v.full_energy),
        observed_movements_per_day: round1(observed_per_day),
        modeled_movements_per_day: round1(modeled_per_day),
    }
}

#[inline]
fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[inline]
fn aircraft_impact(full: &NoisePeriods, no_effect: &NoisePeriods, signed: bool) -> f64 {
    if !full.lden_db.is_finite() {
        return 0.0;
    }
    let d = full.lden_db - no_effect.lden_db;
    round1(if signed { d } else { d.min(0.0) })
}

/// Energy-sum the airborne+cruise periods (already daily-averaged
/// inside `compute_aircraft` via Doc-29 normalization) with the v6
/// ground periods. Falls back to the airborne-only result if ground
/// is silent so callers still see a finite Lden when there are no
/// ground rows.
fn combine_periods(
    airborne: &NoisePeriods,
    ground: &NoisePeriods,
    airborne_total: &NoisePeriods,
) -> NoisePeriods {
    let to_lin = |db: f64| -> f64 {
        if db.is_finite() {
            (db * std::f64::consts::LN_10 * 0.1).exp()
        } else {
            0.0
        }
    };
    let to_db = |lin: f64| -> f64 {
        if lin > 0.0 {
            10.0 * lin.log10()
        } else {
            f64::NEG_INFINITY
        }
    };
    let total_day = to_lin(airborne.ld_db) + to_lin(ground.ld_db);
    let total_eve = to_lin(airborne.le_db) + to_lin(ground.le_db);
    let total_night = to_lin(airborne.ln_db) + to_lin(ground.ln_db);
    if total_day + total_eve + total_night <= 0.0 {
        return airborne_total.clone();
    }
    periods::periods(to_db(total_day), to_db(total_eve), to_db(total_night))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FlatGround;
    impl RasterSampler for FlatGround {
        fn elevation(&self, _: f64, _: f64) -> f64 {
            0.0
        }
        fn building_height(&self, _: f64, _: f64) -> f64 {
            0.0
        }
        fn ground_g(&self, _: f64, _: f64) -> f64 {
            1.0
        }
        fn building_enclosure(&self, _: f64, _: f64) -> f64 {
            0.0
        }
    }

    #[test]
    fn silence_when_no_data() {
        let receiver = Receiver::new(50.10, 14.262, 0.0);
        let (periods, contribs, _band) =
            compute_aircraft_v6(&receiver, &[], &[], &[], &[], &FlatGround, 1, None);
        assert!(!periods.lden_db.is_finite());
        assert!(contribs.is_empty());
    }
}
