//! Run `compute_aircraft_v6` over the popup arrows and merge its output
//! into the `NoiseResult` returned by `compute_at_point_with_traces`.
//!
//! Lifetime story: `RecordBatch` arrays are `Arc<dyn Array>`-backed, so
//! source-reader's hex store can clone the batches cheaply and drop its
//! `RwLock`. `AirborneRowAccum<'a>` (Opt C) is now zero-copy — it borrows
//! `&[f32]` / `&str` directly out of the live arrow buffers tied to
//! the caller's `&[RecordBatch]` Vec. `CruiseRowAccum` and
//! `AirportTrafficRowAccum` still snapshot columns into owned
//! `Vec<T>` / `String` (Tier 3 to convert; small batches make the
//! savings less load-bearing for those layers).

mod airborne_view;
pub mod airport_summary_view;
mod airport_traffic_view;
mod columns;
mod cruise_view;

use std::path::Path;

use arrow::record_batch::RecordBatch;
use noise_compute::compute::aircraft_v6::{airport_traffic as compute_airport_traffic, compute_aircraft_v6};
use noise_compute::types::{
    LayerKind, NoisePeriods, NoiseResult, RasterSampler, Receiver, SourceMetadata, SourceResult,
    TraceCollector,
};

use airborne_view::AirborneRowAccum;
use airport_summary_view::load_airport_summary;
use airport_traffic_view::AirportTrafficRowAccum;
use cruise_view::CruiseRowAccum;
#[cfg(test)]
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


/// Run `compute_aircraft_v6` over the popup arrows and merge its output
/// into an existing `NoiseResult`. Caller is expected to have invoked
/// `compute_at_point_with_traces` first.
///
/// `airport_summary_path` points at the global `airport_summary.arrow`
/// sidecar (typically `<prepared>/aircraft/airport_summary.arrow`).
/// When the file is absent OR an airport is missing from it, popup
/// arr/dep/observed counts return zero — per Codex C4 + Claude W1; no
/// silent fallback to per-row sum (which over-counts 4-8×).
///
/// Returns `Err(String)` when any of the popup arrows fails its schema
/// check (`v15` for airborne/cruise, `airport_traffic_v7` for the
/// ground-ops arrow), so the popup HTTP path can map the failure to a
/// structured 500 response with an operator-actionable message.
pub fn add_v6_aircraft_to_result(
    result: &mut NoiseResult,
    traces: &mut TraceCollector,
    receiver: &Receiver,
    airborne_batches: &[RecordBatch],
    cruise_batches: &[RecordBatch],
    airport_traffic_batches: &[RecordBatch],
    airport_lines_batches: &[RecordBatch],
    // Was used to seed airport_anchors for the popup-side is_near_airport
    // carve-out; deleted 2026-05-23 (carve-out never fired in production).
    // Kept in the signature so the SourceData struct + caller chain stay
    // stable; rename or drop in a separate cleanup commit if desired.
    _synth_airport_lines_batches: &[RecordBatch],
    airport_summary_path: Option<&Path>,
    rasters: &dyn RasterSampler,
    barriers: &[noise_compute::types::Barrier],
    n_days: u16,
    // Per-kind top-K cap for airborne sub-segment traces — passed to
    // compute_aircraft_v6 so the bounded min-heap in airborne::scatter
    // is sized correctly. query_noise_impl sets this to
    // SEGMENT_TOP_K_PER_KIND (150) on the normal path or
    // SEGMENT_TOP_K_PER_KIND_FULL (1000) on the "Show all" path.
    trace_cap: usize,
) -> Result<(), String> {
    assert_schema_version("airborne.arrow", airborne_batches)?;
    assert_schema_version("cruise.arrow", cruise_batches)?;
    if !airborne_batches.is_empty() {
        assert_airborne_contract("airborne.arrow", airborne_batches)?;
    }
    if !cruise_batches.is_empty() {
        assert_cruise_contract("cruise.arrow", cruise_batches)?;
    }
    if !airport_traffic_batches.is_empty() {
        assert_airport_traffic_contract("airport_traffic.arrow", airport_traffic_batches)?;
    }
    let airborne_rows = AirborneRowAccum::new(airborne_batches);
    let cruise_rows = CruiseRowAccum::new(cruise_batches);
    let traffic_rows = AirportTrafficRowAccum::new(airport_traffic_batches);
    // Plan §4.3 + Codex C4: when airport_traffic.arrow rows exist but
    // the airport_summary.arrow sidecar is missing, this is a FATAL
    // pipeline state (Stage 2C reduce did not run, or operator
    // forgot to copy the sidecar). Loud `eprintln!` + `Err` so the
    // popup HTTP path surfaces a 500 instead of silently displaying
    // zero arr/dep counts (which look indistinguishable from "no
    // ADS-B data" at the receiver). When BOTH airport_traffic and
    // the sidecar are absent (rural receiver, no aircraft), no
    // sidecar lookup is required and `None` propagates harmlessly.
    //
    // `airport_summary_path = None` is treated identically to a
    // present-but-empty file: if traffic rows exist the call MUST
    // fail loud (per /gg Gemini audit) — otherwise a caller that
    // forgets to wire the path silently returns zero counts.
    let has_traffic_rows = !airport_traffic_batches.is_empty();
    let airport_summary_accum = match airport_summary_path {
        Some(p) => {
            let loaded = load_airport_summary(p)?;
            if loaded.is_none() && has_traffic_rows {
                eprintln!(
                    "ERROR: airport_traffic.arrow rows present but airport_summary.arrow \
                     missing at {} — Stage 2C reduce phase did not run, or scope changed \
                     between extract and popup. Re-extract or copy the sidecar.",
                    p.display()
                );
                return Err(format!(
                    "airport_summary.arrow missing at {} (required when airport_traffic.arrow present) \
                     — re-run Stage 2C reduce phase",
                    p.display()
                ));
            }
            loaded
        }
        None if has_traffic_rows => {
            eprintln!(
                "ERROR: airport_traffic.arrow rows present but airport_summary_path is None \
                 — caller must wire the sidecar location whenever traffic rows are loaded."
            );
            return Err(
                "airport_summary_path = None with airport_traffic.arrow rows present \
                 — wire `<prepared>/aircraft/airport_summary.arrow`"
                    .to_string(),
            );
        }
        None => None,
    };

    let airborne_views = airborne_rows.views();
    let cruise_view_slices = cruise_rows.views();
    let cruise_views = cruise_view_slices.as_row_views();
    let traffic_views = traffic_rows.views();

    let total_rows = airborne_views.len() + cruise_views.len() + traffic_views.len();
    if total_rows == 0 {
        return Ok(());
    }

    // Gates the 6 km `AIRPORT_CONTEXT_RADIUS_M` test in airborne
    // scatter; without it, approach-corridor sub-segments below the
    // 150 m fixed-wing-jet AGL floor would be dropped. Per-osm_id
    // Note: pre-2026-05-23 the airborne kernel called `is_near_airport`
    // over per-popup airport_anchors (runway endpoints + Stage 1.5 synth
    // + per-airport_key centroids) to set `ground_context = AIRPORT_LINE`
    // and bypass the popup's stale-AGL filter for legitimate low-AGL
    // approaches at airports. Empirically the carve-out NEVER fired in
    // production — Stage 1 + Stage 2A already correctly classify those
    // sub-segs. Deleted the call to save 944 ns/sub-seg × 22 M sub-segs
    // = 21 s per LKPR query. Aircraft Lden delta when bypassing the
    // stale filter entirely: 0.000 dB on 5 reference receivers.

    let (mut air_periods, mut air_contribs, band_data) = compute_aircraft_v6(
        receiver,
        &airborne_views,
        &cruise_views,
        rasters,
        n_days,
        trace_cap,
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
        let airport_summary_lookup = airport_summary_accum.as_ref().map(|a| a.lookup());
        let traffic_contribs = compute_airport_traffic::run(
            receiver,
            &traffic_views,
            n_days,
            rasters,
            barriers,
            &osm_ref_lookup,
            airport_summary_lookup.as_ref(),
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

    // Compute aircraft `periods_free` from the contributors before we
    // hand them off. Airborne and cruise kernels apply no terrain /
    // screening (Doc 29 free-field NPD), so each contributor's
    // `periods_free == periods`. Ground ops sets the same — see TODO on
    // `SourceResult.periods_free` doc in noise-compute/src/types.rs to
    // pull real free-field periods out of the airport_traffic kernel
    // variants (Codex /gg #80 CRITICAL — acceptable approximation today
    // because the field was always null before this commit).
    let aircraft_periods_free = noise_compute::periods::sum_periods(
        &air_contribs
            .iter()
            .map(|c| c.periods_free.clone())
            .collect::<Vec<_>>(),
    );

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
            periods_free: aircraft_periods_free,
            segment_count: total_rows,
            displayed_count,
        });
    }
    // Fresh per-popup compute; non-aircraft pass never touches this.
    result.aircraft_detail = Some(band_data);
    result.total = sum_periods_linear(&result.sources);
    // Recompute `total_free` after aircraft merge — the noise-compute pass
    // set it from non-aircraft sources only; we now have the full set.
    result.total_free = noise_compute::periods::sum_periods(
        &result
            .sources
            .iter()
            .map(|s| s.periods_free.clone())
            .collect::<Vec<_>>(),
    );

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
/// v15 (Opt A) adds pre-sampled terrain elevations to airborne
/// sub-segments (`terrain_start_elev_m`, `terrain_mid_elev_m`,
/// `terrain_end_elev_m`) + Stage 1 `start_elev_m` / `end_elev_m` so
/// the popup can skip ~1 M raster lookups per LKPR query. v14 files
/// would decode the missing columns as zero and falsely keep
/// "below-ground" segments — must reject loud.
pub(super) const EXPECTED_SCHEMA_VERSION: &str = "v15";

/// Versions accepted under the dev-only `ACCEPT_LEGACY_AIRCRAFT_SCHEMA=1`
/// escape hatch. Empty since v15 (Opt A): v15 adds mandatory
/// `terrain_*_elev_m` sub-segment columns that earlier versions cannot
/// provide; loading v12 / v13 / v14 under v15 reader code would silently
/// zero-out terrain in the popup (and the heatmap loader's
/// `unwrap_or_else(vec![0.0; n])` would do the same), masking real
/// underground segments. /gg flagged this in rev 2; force re-extract
/// instead of degrading silently.
const LEGACY_SCHEMA_VERSIONS: &[&str] = &[];

/// The `airport_traffic.arrow` semantic contract. `schema_version`
/// only guards column types/order; this guards what those columns
/// mean today: `band_energy_lin` = raw Σ over n_days of Z-weighted
/// energy at 25 m perpendicular (v6 convention; consumer divides via
/// `period_leq(_, n_days_f, _)`); per-row scalar `unique_*_count` +
/// per-microseg UNION `microseg_unique_*` replace the v4 `flight_ids`
/// list. Airport-level UNION across R4s lives in the separate
/// `airport_summary.arrow` sidecar.
pub(super) const EXPECTED_AIRPORT_TRAFFIC_CONTRACT: &str = "airport_traffic_v7";

/// Legacy `airport_traffic_contract` variants accepted under the same
/// `ACCEPT_LEGACY_AIRCRAFT_SCHEMA=1` escape hatch as
/// [`LEGACY_SCHEMA_VERSIONS`]. Empty: v5 stored daily-average
/// `band_energy_lin` plus a redundant `movements_per_day` column,
/// neither aligned with v6's raw Σ convention. Silent decoding would
/// ship wrong Lden numbers (~25.6 dB low at n_days=365). Re-extract is
/// the only safe path.
const LEGACY_AIRPORT_TRAFFIC_CONTRACTS: &[&str] = &[];

/// `airborne.arrow` sub-segment column-shape contract. v2 (K3) keeps
/// only `terrain_start_elev_m` / `terrain_end_elev_m`; v1 stored five
/// elevs (start / q1 / mid / q3 / end). Popup reader hard-fails on a
/// v1 file because the 13-col offset shifts every read past
/// `flags` — silent decoding would alias `terrain_q1_elev_m` slice
/// over what v2 treats as `terrain_end_elev_m`.
pub(super) const EXPECTED_AIRBORNE_CONTRACT: &str = "airborne_v2";
const LEGACY_AIRBORNE_CONTRACTS: &[&str] = &[];

/// Expected `cruise_contract` metadata. v16 drops the tautological
/// `flags` column (always IS_DEPARTURE per Doc 29 §A.3.2). Older
/// cruise.arrow files lack columns the popup expects; silent skip
/// would zero out cruise contributions at every receiver.
pub(super) const EXPECTED_CRUISE_CONTRACT: &str = "cruise_v16_no_flags";

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
                 via ACCEPT_LEGACY_AIRCRAFT_SCHEMA — energy semantics may differ"
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

/// Guard the `airborne.arrow` sub-segment column-shape contract.
/// Mirrors [`assert_airport_traffic_contract`] but checks the
/// `airborne_contract` metadata key set by Stage 2A. Pre-K3 (v1) files
/// have three extra terrain columns the v2 popup reader would silently
/// alias over `terrain_end_elev_m`, producing wrong Filter D cuts on
/// every airborne sub-segment.
pub(super) fn assert_airborne_contract(
    label: &str,
    batches: &[RecordBatch],
) -> Result<(), String> {
    assert_schema_version(label, batches)?;
    let allow_legacy = accept_legacy();
    for (idx, batch) in batches.iter().enumerate() {
        let c = batch
            .schema_ref()
            .metadata()
            .get("airborne_contract")
            .map(String::as_str);
        if c == Some(EXPECTED_AIRBORNE_CONTRACT) {
            continue;
        }
        if allow_legacy && c.map_or(false, |s| LEGACY_AIRBORNE_CONTRACTS.contains(&s)) {
            eprintln!(
                "WARN: {label}[batch {idx}] legacy airborne_contract {c:?} accepted \
                 via ACCEPT_LEGACY_AIRCRAFT_SCHEMA — terrain columns may differ"
            );
            continue;
        }
        return Err(format!(
            "{label}[batch {idx}] airborne_contract mismatch \
             (expected {EXPECTED_AIRBORNE_CONTRACT}, got {c:?}) \
             — re-extract aircraft pipeline (or set ACCEPT_LEGACY_AIRCRAFT_SCHEMA=1 for dev)"
        ));
    }
    Ok(())
}

/// Guard the `cruise.arrow` spatial-resolution contract. Pre-v15 files
/// stored an `r8_hex` column; the popup/heatmap readers silently skip
/// batches whose `r7_hex` column is missing, hiding the version skew.
pub(super) fn assert_cruise_contract(
    label: &str,
    batches: &[RecordBatch],
) -> Result<(), String> {
    assert_schema_version(label, batches)?;
    for (idx, batch) in batches.iter().enumerate() {
        let c = batch
            .schema_ref()
            .metadata()
            .get("cruise_contract")
            .map(String::as_str);
        if c == Some(EXPECTED_CRUISE_CONTRACT) {
            continue;
        }
        return Err(format!(
            "{label}[batch {idx}] cruise_contract mismatch \
             (expected {EXPECTED_CRUISE_CONTRACT}, got {c:?}) \
             — re-extract cruise stage 2B"
        ));
    }
    Ok(())
}

