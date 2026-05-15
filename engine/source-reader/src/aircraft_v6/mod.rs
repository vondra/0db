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

use arrow::record_batch::RecordBatch;
use noise_compute::compute::aircraft_v6::{airport_traffic as compute_airport_traffic, compute_aircraft_v6};
use noise_compute::types::{
    LayerKind, NoisePeriods, NoiseResult, RasterSampler, Receiver, SourceMetadata, SourceResult,
    TraceCollector,
};

use airborne_view::AirborneRowAccum;
use airport_traffic_view::AirportTrafficRowAccum;
use cruise_view::CruiseRowAccum;
use noise_compute::compute::aircraft_v6::AirportTrafficRowView;
use std::collections::HashMap;

/// Dedup airport_traffic rows by `airport_key` and emit one
/// `(lat, lon)` centroid per airport. The centroid is the
/// midpoint-of-midpoints of all microsegments under that key —
/// good enough for the 6 km airport-context test in
/// `airborne::scatter`. Sub-millisecond at LKPR-density.
fn airport_centroids_from_traffic(rows: &[AirportTrafficRowView<'_>]) -> Vec<(f64, f64)> {
    let mut acc: HashMap<&str, (f64, f64, u32)> = HashMap::new();
    for row in rows {
        let mid_lat = (row.start_lat + row.end_lat) as f64 * 0.5;
        let mid_lon = (row.start_lon + row.end_lon) as f64 * 0.5;
        let entry = acc.entry(row.airport_key).or_insert((0.0, 0.0, 0));
        entry.0 += mid_lat;
        entry.1 += mid_lon;
        entry.2 += 1;
    }
    acc.into_values()
        .map(|(sum_lat, sum_lon, n)| {
            let inv = 1.0 / (n as f64).max(1.0);
            (sum_lat * inv, sum_lon * inv)
        })
        .collect()
}

/// Run `compute_aircraft_v6` over the popup arrows and merge its output
/// into an existing `NoiseResult`. Caller is expected to have invoked
/// `compute_at_point_with_traces` first.
///
/// Returns `Err(String)` when any of the popup arrows fails its schema
/// check (`v12` for airborne/cruise, `airport_traffic_v3` for the
/// ground-ops arrow), so the popup HTTP path can map the failure to
/// a structured 500 response with an operator-actionable message
/// instead of crashing the worker via `assert!`.
pub fn add_v6_aircraft_to_result(
    result: &mut NoiseResult,
    traces: &mut TraceCollector,
    receiver: &Receiver,
    airborne_batches: &[RecordBatch],
    cruise_batches: &[RecordBatch],
    airport_traffic_batches: &[RecordBatch],
    rasters: &dyn RasterSampler,
    barriers: &[noise_compute::types::Barrier],
    n_days: u16,
) -> Result<(), String> {
    assert_schema_version("airborne.arrow", airborne_batches)?;
    assert_schema_version("cruise.arrow", cruise_batches)?;
    if !airport_traffic_batches.is_empty() {
        assert_airport_traffic_contract("airport_traffic.arrow", airport_traffic_batches)?;
    }
    let airborne_rows = AirborneRowAccum::new(airborne_batches);
    let cruise_rows = CruiseRowAccum::new(cruise_batches);
    let traffic_rows = AirportTrafficRowAccum::new(airport_traffic_batches);

    let airborne_views = airborne_rows.views();
    let cruise_views = cruise_rows.views();
    let traffic_views = traffic_rows.views();

    let total_rows = airborne_views.len() + cruise_views.len() + traffic_views.len();
    if total_rows == 0 {
        return Ok(());
    }

    // Build the airport-centroid list from the receiver-disk's
    // airport_traffic.arrow rows. Phase 7c: dedup per `airport_key`
    // and use the energy-mean centroid as the airport's "where".
    // Airborne sub-segments that fall within
    // `AIRPORT_CONTEXT_RADIUS_M` of any of these centroids get
    // `ground_context = AIRPORT_LINE` so the 150 m fixed-wing-jet
    // floor in `is_valid_airborne_with_terrain` short-circuits.
    // Without this, approach corridor vertices (Phase 7c P1a now
    // routes them to airborne instead of ground) would be dropped
    // by that floor.
    let airport_centroids = airport_centroids_from_traffic(&traffic_views);

    let (mut air_periods, mut air_contribs, band_data) = compute_aircraft_v6(
        receiver,
        &airborne_views,
        &cruise_views,
        rasters,
        n_days,
        &airport_centroids,
        Some(traces),
    );

    // airport_traffic.arrow → Doc 29 line-source compute. Adds
    // per-airport Contributor rows next to the airborne/cruise path.
    // Each traffic contributor carries its own per-period Lden, so we
    // fold those into `air_periods` here — otherwise the per-source
    // Aircraft total at the top of the popup would omit ground-ops
    // energy while still listing it as a contributor row below.
    let timing_on = std::env::var("POPUP_TIMING").as_deref() == Ok("1");
    let t_traffic_start = std::time::Instant::now();
    let mut n_traffic_rows: usize = 0;
    if !traffic_views.is_empty() {
        n_traffic_rows = traffic_views.len();
        let traffic_contribs =
            compute_airport_traffic::run(receiver, &traffic_views, n_days, rasters, barriers);
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
    if timing_on {
        let t_traffic = t_traffic_start.elapsed();
        eprintln!(
            "popup-stage airport_traffic={:.0}ms (n_traffic_rows={})",
            t_traffic.as_secs_f64() * 1000.0,
            n_traffic_rows,
        );
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

/// The `airport_traffic.arrow` semantic contract. `schema_version`
/// only guards column types/order; this guards what those columns
/// mean.
///
/// * **v1** — `band_energy_lin` was per-movement SEL × n_movements
///   (quadratic over-count of energy at popup time).
/// * **v2** — `band_energy_lin` became daily-total energy; decoding
///   a v1 file under v2 silently over-counts by ~10·log10(n_days)
///   ≈ 11.5 dB at n_days=14.
/// * **v3** — adds `flight_ids: List<UInt64>` and recomputes
///   `movements_per_day = unique_flight_ids / n_days`. v2's
///   `movements_per_day` was a per-FlightSegment-hit counter that
///   over-counted real rotations by 5–15× at busy airports.
///
/// The assert here is a safety net so a stale file from any older
/// contract never sneaks into the popup display path.
pub(super) const EXPECTED_AIRPORT_TRAFFIC_CONTRACT: &str = "airport_traffic_v3";

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
