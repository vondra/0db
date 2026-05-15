//! Run `compute_aircraft_v6` over the popup arrows and merge its output
//! into the `NoiseResult` returned by `compute_at_point_with_traces`.
//!
//! Lifetime story: `RecordBatch` arrays are `Arc<dyn Array>`-backed, so
//! source-reader's hex store can clone the batches cheaply and drop its
//! `RwLock`. Each `*RowAccum` then snapshots the columns it cares about
//! into owned `Vec<T>` / `String` / `[f32; 8]` so the `*RowView<'_>`
//! slices we hand to noise-compute borrow into stable Rust memory, not
//! into mmap-backed arrow buffers.

mod airborne_view;
mod airport_traffic_view;
mod columns;
mod cruise_view;
mod ground_view;

use arrow::record_batch::RecordBatch;
use noise_compute::compute::aircraft_v6::{airport_traffic as compute_airport_traffic, compute_aircraft_v6};
use noise_compute::types::{
    Barrier, LayerKind, NoisePeriods, NoiseResult, RasterSampler, Receiver, SourceMetadata,
    SourceResult, TraceCollector,
};

use airborne_view::AirborneRowAccum;
use airport_traffic_view::AirportTrafficRowAccum;
use cruise_view::CruiseRowAccum;
use ground_view::GroundRowAccum;

/// Run `compute_aircraft_v6` over the popup arrows and merge its output
/// into an existing `NoiseResult`. Caller is expected to have invoked
/// `compute_at_point_with_traces` first.
///
/// Returns `Err(String)` when any of the three popup arrows
/// (`airborne.arrow` / `cruise.arrow` / `ground.arrow`) fails the v10
/// schema check, so the popup HTTP path can map the failure to a
/// structured 500 response with an operator-actionable message instead
/// of crashing the worker via `assert!`.
pub fn add_v6_aircraft_to_result(
    result: &mut NoiseResult,
    traces: &mut TraceCollector,
    receiver: &Receiver,
    airborne_batches: &[RecordBatch],
    cruise_batches: &[RecordBatch],
    ground_batches: &[RecordBatch],
    airport_traffic_batches: &[RecordBatch],
    barriers: &[Barrier],
    rasters: &dyn RasterSampler,
    n_days: u16,
) -> Result<(), String> {
    assert_schema_version("airborne.arrow", airborne_batches)?;
    assert_schema_version("cruise.arrow", cruise_batches)?;
    // When `airport_traffic.arrow` is present we treat it as the
    // authoritative ground-ops source and **skip** ground.arrow to
    // avoid double-counting. Older popup hex dirs without re-extract
    // still fall back to ground.arrow. The contract assert here
    // refuses to decode a v1 file under the v2 dimensional contract
    // (silent ~11.5 dB over-count at n_days=14 otherwise).
    let use_airport_traffic = !airport_traffic_batches.is_empty();
    if use_airport_traffic {
        assert_airport_traffic_contract("airport_traffic.arrow", airport_traffic_batches)?;
    } else {
        assert_schema_version("ground.arrow", ground_batches)?;
    }
    let airborne_rows = AirborneRowAccum::new(airborne_batches);
    let cruise_rows = CruiseRowAccum::new(cruise_batches);
    let ground_rows = if use_airport_traffic {
        GroundRowAccum::empty()
    } else {
        GroundRowAccum::new(ground_batches)?
    };
    let traffic_rows = AirportTrafficRowAccum::new(airport_traffic_batches);

    let airborne_views = airborne_rows.views();
    let cruise_views = cruise_rows.views();
    let ground_views = ground_rows.views();
    let traffic_views = traffic_rows.views();

    let total_rows =
        airborne_views.len() + cruise_views.len() + ground_views.len() + traffic_views.len();
    if total_rows == 0 {
        return Ok(());
    }

    let (mut air_periods, mut air_contribs, band_data) = compute_aircraft_v6(
        receiver,
        &airborne_views,
        &cruise_views,
        &ground_views,
        barriers,
        rasters,
        n_days,
        Some(traces),
    );

    // Phase 4: airport_traffic.arrow → Doc 29 line-source compute.
    // Adds per-airport Contributor rows next to the airborne/cruise
    // path. Ground.arrow legacy path was already short-circuited above
    // when this batch is non-empty, so there's no double-counting.
    // Each traffic contributor carries its own per-period Lden, so we
    // fold those into `air_periods` here — otherwise the per-source
    // Aircraft total at the top of the popup would omit ground-ops
    // energy while still listing it as a contributor row below.
    if !traffic_views.is_empty() {
        let traffic_contribs = compute_airport_traffic::run(receiver, &traffic_views);
        if !traffic_contribs.is_empty() {
            let mut all: Vec<NoisePeriods> = Vec::with_capacity(1 + traffic_contribs.len());
            all.push(air_periods);
            for c in &traffic_contribs {
                all.push(c.periods.clone());
            }
            air_periods = noise_compute::periods::sum_periods(&all);
        }
        air_contribs.extend(traffic_contribs);
    }

    if !air_periods.lden_db.is_finite() && air_contribs.is_empty() {
        return Ok(());
    }

    // compute_at_point_inner had no visibility into the popup aircraft
    // arrows, so it ran Confidence::assess with has_aircraft=false and
    // emitted the "no ADS-B data" note. Now that we have rows, bump the
    // score and drop the misleading note.
    result.confidence.overall = (result.confidence.overall + 0.15).min(1.0);
    result.confidence.notes.retain(|n| !n.starts_with("Aircraft:"));

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
    // replaces whatever the non-aircraft pass left behind (always `None`
    // — that pass doesn't touch `aircraft_detail`).
    result.aircraft_detail = Some(band_data);
    result.total = sum_periods_linear(&result.sources);

    // The non-aircraft pass already ran finalize_popup_contributors on
    // roads/rails/buildings/industrial and committed top-30 + an
    // `other_sources_lden` energy bucket. Aircraft contributors are
    // appended after that, so without re-finalizing the popup would see
    // a padded list (top-30 non-aircraft + N aircraft) and a stale
    // `other_sources_lden`. Re-finalize over the merged set so aircraft
    // compete for top-N slots and the tail bucket stays honest.
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
/// has been pushed onto `sources`. The non-aircraft pass already filled
/// `result.total` for road/rail/building/industrial, but that total
/// predates the aircraft push so we recompute from scratch here.
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

/// Stamp written by every aircraft-extract Arrow file. Inline copy
/// rather than build-dep on aircraft-extract, which would pull arrow
/// IPC writers / parquet / anyhow into the popup runtime.
pub(super) const EXPECTED_SCHEMA_VERSION: &str = "v12";

/// The `airport_traffic.arrow` semantic contract. `schema_version` only
/// guards column types/order; this guards the dimensional meaning of
/// `band_energy_lin` (v1 = per-movement SEL, v2 = daily-total energy).
/// Decoding a v1 file under the v2 kernel silently over-counts by
/// ~10·log10(n_days) ≈ 11.5 dB at n_days=14, so the assert is a
/// safety net, not cosmetic.
pub(super) const EXPECTED_AIRPORT_TRAFFIC_CONTRACT: &str = "airport_traffic_v2";

/// Verify `schema_version` on every batch in the slice. Single-file
/// IPC guarantees one schema per file, but the caller merges batches
/// across R4 cells (`source_reader::lib::collect_from_hex_data`), so a
/// mixed slice can carry current batches from one hex and stale ones
/// from a sibling. Loop over every batch, not just the first. A
/// reader running against the wrong schema can silently drop every
/// batch via `col_list(...)` → `continue` (zero rows) instead of
/// raising; loud error here is the safety net.
pub(super) fn assert_schema_version(label: &str, batches: &[RecordBatch]) -> Result<(), String> {
    for (idx, batch) in batches.iter().enumerate() {
        let v = batch
            .schema_ref()
            .metadata()
            .get("schema_version")
            .map(String::as_str);
        if v != Some(EXPECTED_SCHEMA_VERSION) {
            return Err(format!(
                "{label}[batch {idx}] schema_version mismatch (expected {EXPECTED_SCHEMA_VERSION}, got {v:?}) \
                 — re-extract aircraft pipeline"
            ));
        }
    }
    Ok(())
}

/// Guard the `airport_traffic.arrow` dimensional contract. Mirrors
/// [`assert_schema_version`] but checks the orthogonal
/// `airport_traffic_contract` metadata key, which encodes the
/// quantity stored in `band_energy_lin` (see
/// [`EXPECTED_AIRPORT_TRAFFIC_CONTRACT`]).
pub(super) fn assert_airport_traffic_contract(
    label: &str,
    batches: &[RecordBatch],
) -> Result<(), String> {
    // Also enforce schema_version since metadata corruption could
    // leave only one of the two stamps intact.
    assert_schema_version(label, batches)?;
    for (idx, batch) in batches.iter().enumerate() {
        let c = batch
            .schema_ref()
            .metadata()
            .get("airport_traffic_contract")
            .map(String::as_str);
        if c != Some(EXPECTED_AIRPORT_TRAFFIC_CONTRACT) {
            return Err(format!(
                "{label}[batch {idx}] airport_traffic_contract mismatch \
                 (expected {EXPECTED_AIRPORT_TRAFFIC_CONTRACT}, got {c:?}) \
                 — re-extract aircraft pipeline"
            ));
        }
    }
    Ok(())
}
