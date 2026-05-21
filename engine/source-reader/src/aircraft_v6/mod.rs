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

/// Build the per-popup `osm_id` → `ref` lookup from the
/// `airport_lines.arrow` batches. One entry per unique osm_id (one OSM
/// way can have many microsegments — all share the same `ref`). Rows
/// without a `ref` tag are skipped, so `HashMap::get` returns `None`
/// for them and the SegmentTrace falls back to the generic label.
fn build_osm_ref_lookup(batches: &[RecordBatch]) -> HashMap<u64, String> {
    use arrow::array::Array;
    let mut out: HashMap<u64, String> = HashMap::new();
    for batch in batches {
        let (Some(osm_id), Some(ref_col)) = (
            columns::col_i64(batch, "osm_id"),
            columns::col_str(batch, "ref"),
        ) else {
            continue;
        };
        for i in 0..batch.num_rows() {
            if ref_col.is_null(i) {
                continue;
            }
            // `trim()` rejects whitespace-only refs that would otherwise
            // surface as " " labels in the popup (OSM is community-edited;
            // see e.g. `ref=" "` accidental data entries).
            let r = ref_col.value(i).trim();
            if r.is_empty() {
                continue;
            }
            // Synth osm_ids (bit 63 set) live in
            // `synth_airport_lines.arrow`, not here, so the i64 → u64
            // cast is bit-identical for every row in this file.
            out.entry(osm_id.value(i) as u64).or_insert_with(|| r.to_string());
        }
    }
    out
}

/// Dedup `airport_traffic` rows by `airport_key` and emit one
/// `(lat, lon)` centroid per airport — midpoint-of-microsegment-midpoints.
/// Feeds the 6 km airport-context test in `airborne::scatter`;
/// sub-millisecond at LKPR density.
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
/// check (`v13` for airborne/cruise, `airport_traffic_v4` for the
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
    airport_lines_batches: &[RecordBatch],
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

    // Gates the 6 km `AIRPORT_CONTEXT_RADIUS_M` test in airborne
    // scatter; without it, approach-corridor sub-segments below the
    // 150 m fixed-wing-jet AGL floor would be dropped.
    let airport_centroids = airport_centroids_from_traffic(&traffic_views);

    let (mut air_periods, mut air_contribs, band_data) = compute_aircraft_v6(
        receiver,
        &airborne_views,
        &cruise_views,
        rasters,
        n_days,
        &airport_centroids,
        Some(traces),
        result.timings.as_mut(),
    );

    // airport_traffic → Doc 29 line-source contributors; fold their
    // per-period Lden into `air_periods` so the top-of-popup Aircraft
    // total includes ground-ops energy (not just its contributor row).
    let timing_on = std::env::var("POPUP_TIMING").as_deref() == Ok("1");
    let t_traffic_start = std::time::Instant::now();
    let mut n_traffic_rows: usize = 0;
    if !traffic_views.is_empty() {
        n_traffic_rows = traffic_views.len();
        // OSM `ref` tags (e.g. runway "06/24") let SegmentTrace render
        // "LKPR RWY 06/24" instead of generic "LKPR runway-roll". Synth
        // osm_ids have no `ref` row → fall through to the generic label.
        let osm_ref_lookup = build_osm_ref_lookup(airport_lines_batches);
        let traffic_contribs = compute_airport_traffic::run(
            receiver,
            &traffic_views,
            n_days,
            rasters,
            barriers,
            &osm_ref_lookup,
            Some(traces),
        );
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
    let t_traffic = t_traffic_start.elapsed();
    if timing_on {
        eprintln!(
            "popup-stage airport_traffic={:.0}ms (n_traffic_rows={})",
            t_traffic.as_secs_f64() * 1000.0,
            n_traffic_rows,
        );
    }
    if let Some(t) = result.timings.as_mut() {
        t.aircraft_ground_ms = t_traffic.as_secs_f64() * 1000.0;
    }

    if !air_periods.lden_db.is_finite() && air_contribs.is_empty() {
        return Ok(());
    }

    // Upstream Confidence::assess ran with has_aircraft=false (no
    // visibility into popup aircraft arrows there); now that we have
    // rows, bump the score and drop the stale "no ADS-B data" note.
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
    // Fresh per-popup compute; non-aircraft pass never touches this.
    result.aircraft_detail = Some(band_data);
    result.total = sum_periods_linear(&result.sources);

    // Re-finalize over the merged contributor set so aircraft compete
    // for top-N slots (non-aircraft pass already committed its top-30
    // + `other_sources_lden`; appending aircraft rows would leave a
    // padded list and a stale tail bucket).
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
/// (not a build-dep) keeps arrow IPC / parquet / anyhow out of the
/// popup runtime; must move in lock-step with `aircraft-extract::SCHEMA_VERSION`.
/// v14 replaces the per-fid cruise lists with bounded top-K
/// `top_candidates` + scalar `unique_count`. Old v13 files would
/// silently decode to zero fids under the new column layout — must
/// reject loud.
pub(super) const EXPECTED_SCHEMA_VERSION: &str = "v14";

/// Versions accepted under the dev-only `ACCEPT_LEGACY_AIRCRAFT_SCHEMA=1`
/// escape hatch. v13 is NOT in this list (column layout changed —
/// legacy decode would silently lose fid data; see plan §1.4 + Codex
/// W1 + Claude W7).
const LEGACY_SCHEMA_VERSIONS: &[&str] = &["v12"];

/// The `airport_traffic.arrow` semantic contract. `schema_version`
/// only guards column types/order; this guards what those columns
/// mean today: `band_energy_lin` = daily-total Z-weighted energy at
/// 25 m perpendicular; per-row scalar `unique_*_count` + per-microseg
/// UNION `microseg_unique_*` replace the v4 `flight_ids` list.
/// Airport-level UNION across R4s now lives in the separate
/// `airport_summary.arrow` sidecar.
pub(super) const EXPECTED_AIRPORT_TRAFFIC_CONTRACT: &str = "airport_traffic_v5";

/// Legacy `airport_traffic_contract` variants accepted under the same
/// `ACCEPT_LEGACY_AIRCRAFT_SCHEMA=1` escape hatch as
/// [`LEGACY_SCHEMA_VERSIONS`]. v4 is NOT in the legacy list — its
/// column shape (per-row `flight_ids: List<UInt64>`) is incompatible
/// with v5's scalar counters; silent decoding would drop fid data.
const LEGACY_AIRPORT_TRAFFIC_CONTRACTS: &[&str] = &["airport_traffic_v3"];

fn accept_legacy() -> bool {
    matches!(std::env::var("ACCEPT_LEGACY_AIRCRAFT_SCHEMA").as_deref(), Ok("1"))
}

/// Verify `schema_version` on every batch in the slice — the caller
/// merges batches across R4 cells, so one hex's current batches and a
/// sibling's stale batches can land in the same slice. Wrong-schema
/// readers silently drop rows via `col_list(...)` → `continue`; this
/// is the loud safety net.
pub(super) fn assert_schema_version(label: &str, batches: &[RecordBatch]) -> Result<(), String> {
    let allow_legacy = accept_legacy();
    for (idx, batch) in batches.iter().enumerate() {
        let v = batch
            .schema_ref()
            .metadata()
            .get("schema_version")
            .map(String::as_str);
        if v == Some(EXPECTED_SCHEMA_VERSION) {
            continue;
        }
        if allow_legacy && v.map_or(false, |s| LEGACY_SCHEMA_VERSIONS.contains(&s)) {
            eprintln!(
                "WARN: {label}[batch {idx}] legacy schema {v:?} accepted via \
                 ACCEPT_LEGACY_AIRCRAFT_SCHEMA — class_idx may map to wrong NPD profile"
            );
            continue;
        }
        return Err(format!(
            "{label}[batch {idx}] schema_version mismatch (expected {EXPECTED_SCHEMA_VERSION}, got {v:?}) \
             — re-extract aircraft pipeline (or set ACCEPT_LEGACY_AIRCRAFT_SCHEMA=1 for dev)"
        ));
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
    // Enforce schema_version too: metadata corruption could leave only
    // one of the two stamps intact.
    assert_schema_version(label, batches)?;
    let allow_legacy = accept_legacy();
    for (idx, batch) in batches.iter().enumerate() {
        let c = batch
            .schema_ref()
            .metadata()
            .get("airport_traffic_contract")
            .map(String::as_str);
        if c == Some(EXPECTED_AIRPORT_TRAFFIC_CONTRACT) {
            continue;
        }
        if allow_legacy && c.map_or(false, |s| LEGACY_AIRPORT_TRAFFIC_CONTRACTS.contains(&s)) {
            eprintln!(
                "WARN: {label}[batch {idx}] legacy airport_traffic_contract {c:?} accepted \
                 via ACCEPT_LEGACY_AIRCRAFT_SCHEMA — touch semantics may differ at rotation boundary"
            );
            continue;
        }
        return Err(format!(
            "{label}[batch {idx}] airport_traffic_contract mismatch \
             (expected {EXPECTED_AIRPORT_TRAFFIC_CONTRACT}, got {c:?}) \
             — re-extract aircraft pipeline (or set ACCEPT_LEGACY_AIRCRAFT_SCHEMA=1 for dev)"
        ));
    }
    Ok(())
}
