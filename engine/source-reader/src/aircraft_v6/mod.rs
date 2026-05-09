//! Run `compute_aircraft_v6` over the popup arrows and merge its
//! output into the `NoiseResult` returned by `compute_at_point_with_airports`
//! (whose aircraft branch is now a no-op — see `lib.rs::query_noise_impl`).
//!
//! Lifetime story: `RecordBatch` arrays are `Arc<dyn Array>`-backed,
//! so source-reader's hex store can clone the batches cheaply and
//! drop its `RwLock`. Each `*RowAccum` then snapshots the columns it
//! cares about into owned `Vec<T>` / `String` / `[f32; 8]` so the
//! `*RowView<'_>` slices we hand to noise-compute borrow into stable
//! Rust memory, not into mmap-backed arrow buffers.

mod airborne_view;
mod columns;
mod cruise_view;
mod ground_view;

use arrow::record_batch::RecordBatch;
use noise_compute::compute::aircraft_v6::compute_aircraft_v6;
use noise_compute::types::{
    Barrier, LayerKind, NoisePeriods, NoiseResult, RasterSampler, Receiver, SourceMetadata,
    SourceResult, TraceCollector,
};

use airborne_view::AirborneRowAccum;
use cruise_view::CruiseRowAccum;
use ground_view::GroundRowAccum;

/// Run `compute_aircraft_v6` over the popup arrows and merge its
/// output into an existing `NoiseResult`. The caller is expected to
/// have invoked `compute_at_point_with_airports` first with an empty
/// `aircraft` slice (the legacy aircraft branch is gone — see
/// `noise_compute::compute_at_point_with_airports`).
///
/// Returns `Err(String)` when any aircraft.arrow file fails the v7
/// schema or `dB_sum_v7_1` ground-energy contract, so the popup HTTP
/// path can map the failure to a structured 500 response with the
/// operator-actionable message instead of crashing the worker via
/// `assert!`.
pub fn add_v6_aircraft_to_result(
    result: &mut NoiseResult,
    traces: &mut TraceCollector,
    receiver: &Receiver,
    airborne_batches: &[RecordBatch],
    cruise_batches: &[RecordBatch],
    ground_batches: &[RecordBatch],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    n_days: u16,
) -> Result<(), String> {
    assert_schema_v7("airborne.arrow", airborne_batches)?;
    assert_schema_v7("cruise.arrow", cruise_batches)?;
    assert_schema_v7("ground.arrow", ground_batches)?;
    let airborne_rows = AirborneRowAccum::new(airborne_batches);
    let cruise_rows = CruiseRowAccum::new(cruise_batches);
    let ground_rows = GroundRowAccum::new(ground_batches)?;

    let airborne_views = airborne_rows.views();
    let cruise_views = cruise_rows.views();
    let ground_views = ground_rows.views();

    let total_rows = airborne_views.len() + cruise_views.len() + ground_views.len();
    if total_rows == 0 {
        return Ok(());
    }

    let (air_periods, air_contribs, band_data) = compute_aircraft_v6(
        receiver,
        &airborne_views,
        &cruise_views,
        &ground_views,
        barriers,
        rasters,
        n_days,
        Some(traces),
    );

    if !air_periods.lden_db.is_finite() && air_contribs.is_empty() {
        return Ok(());
    }

    result.contributors.extend(air_contribs);
    if air_periods.lden_db.is_finite() {
        let displayed_count = result
            .contributors
            .iter()
            .filter(|c| matches!(c.metadata.as_ref(), Some(SourceMetadata::Aircraft(_))))
            .count();
        result.sources.push(SourceResult {
            source_type: LayerKind::Aircraft,
            periods: air_periods,
            segment_count: total_rows,
            displayed_count,
        });
    }
    // Each popup query is a fresh compute, so the v6 band data fully
    // replaces whatever `compute_at_point_with_airports` left behind
    // (currently always `None` since its aircraft branch is a no-op).
    result.aircraft_detail = Some(band_data);
    result.total = sum_periods_linear(&result.sources);

    // compute_at_point_with_airports already ran finalize_popup_contributors
    // on roads/rails/buildings/industrial and committed the top-30 +
    // an `other_sources_lden` energy bucket. Aircraft contributors were
    // appended after that call, so the popup would otherwise see a
    // padded list (top-30 non-aircraft + N aircraft) and a stale
    // `other_sources_lden`. /gg (Codex) flagged this. Re-finalize over
    // the merged contributors so aircraft can compete for top-N slots
    // and `other_sources_lden` reflects the true tail.
    let other_lden_existing = result.other_sources_lden;
    let merged = std::mem::take(&mut result.contributors);
    let finalized = noise_compute::present::finalize_popup_contributors(merged, 30);
    result.contributors = finalized.shown;
    result.other_sources_lden = combine_other_lden(other_lden_existing, finalized.other_lden_db);
    Ok(())
}

/// Linear-energy sum of two `other_sources_lden` numbers. Either side
/// can be `NEG_INFINITY` (no leftovers), in which case the other side
/// passes through unchanged.
fn combine_other_lden(a: f64, b: f64) -> f64 {
    let to_lin = |v: f64| {
        if v.is_finite() {
            10f64.powf(v / 10.0)
        } else {
            0.0
        }
    };
    let total = to_lin(a) + to_lin(b);
    if total > 0.0 {
        10.0 * total.log10()
    } else {
        f64::NEG_INFINITY
    }
}

/// Energy-sum the per-source periods after the aircraft contribution
/// has been pushed onto `sources`. `compute_at_point_with_airports`
/// already filled in `result.total` for the non-aircraft sources, but
/// that total predates the v6 aircraft push so we recompute from
/// scratch here.
fn sum_periods_linear(sources: &[SourceResult]) -> NoisePeriods {
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
    let (mut day, mut eve, mut night) = (0.0f64, 0.0f64, 0.0f64);
    for s in sources {
        day += to_lin(s.periods.ld_db);
        eve += to_lin(s.periods.le_db);
        night += to_lin(s.periods.ln_db);
    }
    if day + eve + night <= 0.0 {
        return NoisePeriods::silence();
    }
    noise_compute::periods::periods(to_db(day), to_db(eve), to_db(night))
}

/// Stamp written by every aircraft-extract v7 Arrow file. Inline copy
/// rather than build-dep on aircraft-extract, which would pull arrow
/// IPC writers / parquet / anyhow into the popup runtime.
pub(super) const SCHEMA_VERSION_V7: &str = "v7";

/// Verify schema_version on the first batch — Arrow IPC writes one
/// schema per file shared across every RecordBatch, so checking the
/// rest is redundant. An empty `batches` slice (R4 with no aircraft
/// rows) is fine: nothing to validate.
pub(super) fn assert_schema_v7(label: &str, batches: &[RecordBatch]) -> Result<(), String> {
    let Some(batch) = batches.first() else {
        return Ok(());
    };
    let v = batch
        .schema_ref()
        .metadata()
        .get("schema_version")
        .map(String::as_str);
    if v != Some(SCHEMA_VERSION_V7) {
        return Err(format!(
            "{label} schema_version mismatch (expected {SCHEMA_VERSION_V7}, got {v:?}) \
             — re-extract aircraft pipeline with the M0c build"
        ));
    }
    Ok(())
}
