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

/// Aeroway-type sentinels for runway-typed `airport_lines.arrow`
/// rows. Mirrors `osm-extract::classify::aeroway_type` codomain:
/// 0=runway, 6=stopway, 7=airstrip. Taxiways (1) deliberately
/// excluded — their endpoints already sit inside the runway-end
/// neighborhood at almost every airport, and including them
/// inflates the anchor list 5-10× at hubs without widening the
/// gate where it matters.
const RUNWAY_AEROWAY_TYPES: [u8; 3] = [0, 6, 7];

fn is_runway_aeroway_type(t: u8) -> bool {
    RUNWAY_AEROWAY_TYPES.contains(&t)
}

/// One per-batch runway-microsegment row extracted from
/// `airport_lines.arrow` or `synth_airport_lines.arrow`. Carries
/// only the bits the runway-end resolver needs.
struct RunwayLineRow {
    osm_id: u64,
    segment_idx: i32,
    start_lat: f64,
    start_lon: f64,
    end_lat: f64,
    end_lon: f64,
}

/// Decode one batch's runway-typed rows into `RunwayLineRow`s.
/// Handles BOTH real OSM lines (`osm_id: Int64`, `segment_idx: Int16`)
/// and Stage 1.5 synth lines (`osm_id: UInt64`, `segment_idx: UInt16`)
/// — the lat/lon columns share `Float64` in both schemas. Returns
/// nothing when required columns are missing or have unexpected types.
fn collect_runway_rows(batch: &RecordBatch, out: &mut Vec<RunwayLineRow>) {
    let (Some(slat), Some(slon), Some(elat), Some(elon), Some(atype)) = (
        columns::col_f64(batch, "start_lat"),
        columns::col_f64(batch, "start_lon"),
        columns::col_f64(batch, "end_lat"),
        columns::col_f64(batch, "end_lon"),
        columns::col_u8(batch, "aeroway_type"),
    ) else {
        return;
    };
    // osm_id is Int64 in real OSM lines, UInt64 in synth. Try both;
    // bit-identical casts when values fit in i64 (real osm_ids are
    // always positive per `osm-extract/main.rs:200,287`). Synth ids
    // use the high bit but live in their own batches.
    let osm_id_i64 = columns::col_i64(batch, "osm_id");
    let osm_id_u64 = columns::col_u64(batch, "osm_id");
    // segment_idx is Int16 (real) or UInt16 (synth).
    let seg_idx_i16 = columns::col_i16(batch, "segment_idx");
    let seg_idx_u16 = columns::col_u16(batch, "segment_idx");
    if osm_id_i64.is_none() && osm_id_u64.is_none() {
        return;
    }
    if seg_idx_i16.is_none() && seg_idx_u16.is_none() {
        return;
    }
    for i in 0..batch.num_rows() {
        if !is_runway_aeroway_type(atype.value(i)) {
            continue;
        }
        let osm_id: u64 = match (osm_id_i64, osm_id_u64) {
            (Some(c), _) => c.value(i) as u64,
            (_, Some(c)) => c.value(i),
            _ => unreachable!("checked above"),
        };
        // segment_idx widened to i32 so the per-osm_id min/max
        // reduction has headroom regardless of signed/unsigned source.
        let segment_idx: i32 = match (seg_idx_i16, seg_idx_u16) {
            (Some(c), _) => c.value(i) as i32,
            (_, Some(c)) => c.value(i) as i32,
            _ => unreachable!("checked above"),
        };
        out.push(RunwayLineRow {
            osm_id,
            segment_idx,
            start_lat: slat.value(i),
            start_lon: slon.value(i),
            end_lat: elat.value(i),
            end_lon: elon.value(i),
        });
    }
}

/// Extract per-`osm_id` runway endpoints from real OSM
/// `airport_lines.arrow` + Stage 1.5 `synth_airport_lines.arrow`
/// batches. For every `osm_id` with at least one runway-typed row,
/// emit two anchors: the `(start_lat, start_lon)` of the row with
/// MIN `segment_idx` and the `(end_lat, end_lon)` of the row with
/// MAX `segment_idx`. Microsegments are emitted in along-the-way
/// order by `osm-extract::microsegment::split` (and the synth
/// mirror in `stage_airport_discover_runner.rs`), so these are the
/// physical OSM way endpoints.
///
/// Heliports (no runway rows) and taxiway-only osm_ids emit zero
/// anchors here; the caller layers the airport_traffic centroid set
/// on top so heliports retain the legacy gate.
fn runway_ends_from_airport_lines(
    airport_lines_batches: &[RecordBatch],
    synth_lines_batches: &[RecordBatch],
) -> Vec<(f64, f64)> {
    // Per-osm_id running min/max segment_idx + the start/end at each.
    // i32::MAX / i32::MIN sentinels so the first row always wins.
    struct Acc {
        min_seg: i32,
        min_start_lat: f64,
        min_start_lon: f64,
        max_seg: i32,
        max_end_lat: f64,
        max_end_lon: f64,
    }
    let mut by_osm: HashMap<u64, Acc> = HashMap::new();
    let mut rows: Vec<RunwayLineRow> = Vec::new();
    for batch in airport_lines_batches.iter().chain(synth_lines_batches.iter()) {
        collect_runway_rows(batch, &mut rows);
    }
    for r in &rows {
        let entry = by_osm.entry(r.osm_id).or_insert(Acc {
            min_seg: i32::MAX,
            min_start_lat: 0.0,
            min_start_lon: 0.0,
            max_seg: i32::MIN,
            max_end_lat: 0.0,
            max_end_lon: 0.0,
        });
        if r.segment_idx < entry.min_seg {
            entry.min_seg = r.segment_idx;
            entry.min_start_lat = r.start_lat;
            entry.min_start_lon = r.start_lon;
        }
        if r.segment_idx > entry.max_seg {
            entry.max_seg = r.segment_idx;
            entry.max_end_lat = r.end_lat;
            entry.max_end_lon = r.end_lon;
        }
    }
    let mut anchors: Vec<(f64, f64)> = Vec::with_capacity(by_osm.len() * 2);
    for acc in by_osm.into_values() {
        // Defence: a one-microsegment runway way still has min_seg
        // ≤ max_seg (both equal) — both endpoints come from the same
        // row's start/end fields.
        anchors.push((acc.min_start_lat, acc.min_start_lon));
        anchors.push((acc.max_end_lat, acc.max_end_lon));
    }
    anchors
}

/// Build the airport-context gate's anchor set.
///
/// Returns the **concatenation** of per-osm_id runway endpoints
/// (from real + synth `airport_lines` batches) and the legacy
/// per-airport_key mean-midpoint centroids (from `airport_traffic`
/// rows). The two lists are layered, not exclusive — `is_near_airport`
/// uses any-of semantics so redundant interior anchors at hubs are
/// harmless (each sits inside every runway-end's 6 km disk) but they
/// preserve today's exact behavior at heliports / taxiway-only
/// aerodromes where no runway anchor would be produced.
///
/// Anchor budget at LKPR density: ≤ ~30 runway-end anchors + ≤ ~20
/// centroids = ≤ ~50 total. The `flat_dist`-per-sub-segment scan
/// stays sub-millisecond.
fn airport_anchors(
    airport_lines_batches: &[RecordBatch],
    synth_lines_batches: &[RecordBatch],
    traffic_rows: &[AirportTrafficRowView<'_>],
) -> Vec<(f64, f64)> {
    let mut anchors =
        runway_ends_from_airport_lines(airport_lines_batches, synth_lines_batches);
    anchors.extend(airport_centroids_from_traffic(traffic_rows));
    anchors
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
    synth_airport_lines_batches: &[RecordBatch],
    airport_summary_path: Option<&Path>,
    rasters: &dyn RasterSampler,
    barriers: &[noise_compute::types::Barrier],
    n_days: u16,
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
    // runway endpoints (real OSM + Stage 1.5 synth) plus the legacy
    // per-airport_key centroids — see [`airport_anchors`] for the
    // any-of-anchors layering rationale at multi-runway hubs.
    let airport_anchors = airport_anchors(
        airport_lines_batches,
        synth_airport_lines_batches,
        &traffic_views,
    );

    let (mut air_periods, mut air_contribs, band_data) = compute_aircraft_v6(
        receiver,
        &airborne_views,
        &cruise_views,
        rasters,
        n_days,
        &airport_anchors,
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

#[cfg(test)]
mod runway_anchor_tests {
    use super::*;
    use arrow::array::{
        Float32Array, Float64Array, Int16Array, Int64Array, StringArray, UInt16Array, UInt64Array,
        UInt8Array,
    };
    use arrow::datatypes::{DataType, Field, Schema};
    use std::sync::Arc;

    /// Schema matching osm-extract `write_airport_lines` for the
    /// columns this resolver consults. Tests fabricate batches with
    /// this schema so the helper is exercised without depending on
    /// real OSM data on disk.
    fn real_lines_schema() -> Arc<Schema> {
        Arc::new(Schema::new(vec![
            Field::new("osm_id", DataType::Int64, false),
            Field::new("segment_idx", DataType::Int16, false),
            Field::new("start_lat", DataType::Float64, false),
            Field::new("start_lon", DataType::Float64, false),
            Field::new("end_lat", DataType::Float64, false),
            Field::new("end_lon", DataType::Float64, false),
            Field::new("length_m", DataType::Float32, false),
            Field::new("heading_deg", DataType::Float32, false),
            Field::new("aeroway_type", DataType::UInt8, false),
            Field::new("ref", DataType::Utf8, true),
        ]))
    }

    fn synth_lines_schema() -> Arc<Schema> {
        Arc::new(Schema::new(vec![
            Field::new("osm_id", DataType::UInt64, false),
            Field::new("segment_idx", DataType::UInt16, false),
            Field::new("airport_key", DataType::Utf8, false),
            Field::new("start_lat", DataType::Float64, false),
            Field::new("start_lon", DataType::Float64, false),
            Field::new("end_lat", DataType::Float64, false),
            Field::new("end_lon", DataType::Float64, false),
            Field::new("length_m", DataType::Float32, false),
            Field::new("heading_deg", DataType::Float32, false),
            Field::new("aeroway_type", DataType::UInt8, false),
            Field::new("name", DataType::Utf8, false),
        ]))
    }

    struct RowSpec {
        osm_id: i64,
        segment_idx: i16,
        start_lat: f64,
        start_lon: f64,
        end_lat: f64,
        end_lon: f64,
        aeroway_type: u8,
    }

    fn real_batch(rows: &[RowSpec]) -> RecordBatch {
        let osm_id = Int64Array::from_iter_values(rows.iter().map(|r| r.osm_id));
        let seg_idx = Int16Array::from_iter_values(rows.iter().map(|r| r.segment_idx));
        let slat = Float64Array::from_iter_values(rows.iter().map(|r| r.start_lat));
        let slon = Float64Array::from_iter_values(rows.iter().map(|r| r.start_lon));
        let elat = Float64Array::from_iter_values(rows.iter().map(|r| r.end_lat));
        let elon = Float64Array::from_iter_values(rows.iter().map(|r| r.end_lon));
        let len = Float32Array::from_iter_values(rows.iter().map(|_| 100.0_f32));
        let head = Float32Array::from_iter_values(rows.iter().map(|_| 0.0_f32));
        let atype = UInt8Array::from_iter_values(rows.iter().map(|r| r.aeroway_type));
        let refcol = StringArray::from(vec![None::<&str>; rows.len()]);
        RecordBatch::try_new(
            real_lines_schema(),
            vec![
                Arc::new(osm_id),
                Arc::new(seg_idx),
                Arc::new(slat),
                Arc::new(slon),
                Arc::new(elat),
                Arc::new(elon),
                Arc::new(len),
                Arc::new(head),
                Arc::new(atype),
                Arc::new(refcol),
            ],
        )
        .unwrap()
    }

    fn synth_batch(rows: &[RowSpec]) -> RecordBatch {
        let osm_id = UInt64Array::from_iter_values(rows.iter().map(|r| r.osm_id as u64));
        let seg_idx = UInt16Array::from_iter_values(rows.iter().map(|r| r.segment_idx as u16));
        let key = StringArray::from_iter_values(rows.iter().map(|_| "auto-key"));
        let slat = Float64Array::from_iter_values(rows.iter().map(|r| r.start_lat));
        let slon = Float64Array::from_iter_values(rows.iter().map(|r| r.start_lon));
        let elat = Float64Array::from_iter_values(rows.iter().map(|r| r.end_lat));
        let elon = Float64Array::from_iter_values(rows.iter().map(|r| r.end_lon));
        let len = Float32Array::from_iter_values(rows.iter().map(|_| 100.0_f32));
        let head = Float32Array::from_iter_values(rows.iter().map(|_| 0.0_f32));
        let atype = UInt8Array::from_iter_values(rows.iter().map(|r| r.aeroway_type));
        let name = StringArray::from_iter_values(rows.iter().map(|_| "synth"));
        RecordBatch::try_new(
            synth_lines_schema(),
            vec![
                Arc::new(osm_id),
                Arc::new(seg_idx),
                Arc::new(key),
                Arc::new(slat),
                Arc::new(slon),
                Arc::new(elat),
                Arc::new(elon),
                Arc::new(len),
                Arc::new(head),
                Arc::new(atype),
                Arc::new(name),
            ],
        )
        .unwrap()
    }

    /// Three abutting runway microsegments → exactly two anchors at
    /// the way endpoints.
    #[test]
    fn real_runway_three_microsegs_yields_two_anchors_at_endpoints() {
        let batch = real_batch(&[
            RowSpec { osm_id: 42, segment_idx: 0, start_lat: 50.0, start_lon: 14.0, end_lat: 50.0, end_lon: 14.001, aeroway_type: 0 },
            RowSpec { osm_id: 42, segment_idx: 1, start_lat: 50.0, start_lon: 14.001, end_lat: 50.0, end_lon: 14.002, aeroway_type: 0 },
            RowSpec { osm_id: 42, segment_idx: 2, start_lat: 50.0, start_lon: 14.002, end_lat: 50.0, end_lon: 14.003, aeroway_type: 0 },
        ]);
        let mut anchors = runway_ends_from_airport_lines(&[batch], &[]);
        anchors.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        assert_eq!(anchors.len(), 2);
        assert!((anchors[0].1 - 14.0).abs() < 1e-9);
        assert!((anchors[1].1 - 14.003).abs() < 1e-9);
    }

    /// Single-microsegment runway way still produces two anchors —
    /// the start and end of that one row.
    #[test]
    fn one_microseg_runway_emits_both_endpoints_from_same_row() {
        let batch = real_batch(&[RowSpec {
            osm_id: 7,
            segment_idx: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            end_lat: 50.0,
            end_lon: 14.001,
            aeroway_type: 0,
        }]);
        let mut anchors = runway_ends_from_airport_lines(&[batch], &[]);
        anchors.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        assert_eq!(anchors.len(), 2);
        assert!((anchors[0].1 - 14.0).abs() < 1e-9);
        assert!((anchors[1].1 - 14.001).abs() < 1e-9);
    }

    /// Taxiway-only osm_ids emit zero anchors. The runway filter is
    /// load-bearing — taxiway endpoints already sit inside the runway
    /// envelope at almost every airport.
    #[test]
    fn taxiway_only_osm_id_yields_no_anchors() {
        let batch = real_batch(&[RowSpec {
            osm_id: 99,
            segment_idx: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            end_lat: 50.0,
            end_lon: 14.001,
            aeroway_type: 1, // taxiway
        }]);
        let anchors = runway_ends_from_airport_lines(&[batch], &[]);
        assert!(anchors.is_empty());
    }

    /// Mixed runway + taxiway batch keeps only runway anchors. Plus
    /// the 255 osm-extract parse-failure sentinel must also drop out.
    #[test]
    fn mixed_aeroway_types_keeps_runway_only() {
        let batch = real_batch(&[
            RowSpec { osm_id: 42, segment_idx: 0, start_lat: 50.0, start_lon: 14.0, end_lat: 50.0, end_lon: 14.001, aeroway_type: 0 },
            RowSpec { osm_id: 43, segment_idx: 0, start_lat: 50.0, start_lon: 14.002, end_lat: 50.0, end_lon: 14.003, aeroway_type: 1 },
            RowSpec { osm_id: 44, segment_idx: 0, start_lat: 50.0, start_lon: 14.004, end_lat: 50.0, end_lon: 14.005, aeroway_type: 255 },
            RowSpec { osm_id: 42, segment_idx: 1, start_lat: 50.0, start_lon: 14.001, end_lat: 50.0, end_lon: 14.002, aeroway_type: 0 },
        ]);
        let anchors = runway_ends_from_airport_lines(&[batch], &[]);
        assert_eq!(anchors.len(), 2, "only osm_id 42 is runway-typed");
    }

    /// Synth batches contribute alongside real batches. Both use
    /// distinct osm_id pools (synth has high bit set), so each
    /// contributes its own pair.
    #[test]
    fn synth_batch_emits_anchors_too() {
        let real = real_batch(&[RowSpec {
            osm_id: 42, segment_idx: 0, start_lat: 50.0, start_lon: 14.0, end_lat: 50.0, end_lon: 14.001, aeroway_type: 0,
        }]);
        // Synth osm_id mirrors Stage 1.5's high-bit encoding
        // (`SYNTHETIC_OSM_ID_BIT = 1u64 << 63`). `i64::MIN` is the
        // two's-complement representation of `1u64 << 63`, so the
        // cast in `synth_batch` round-trips bit-for-bit.
        let synth = synth_batch(&[RowSpec {
            osm_id: i64::MIN,
            segment_idx: 0, start_lat: 51.0, start_lon: 15.0, end_lat: 51.0, end_lon: 15.001, aeroway_type: 7,
        }]);
        let anchors = runway_ends_from_airport_lines(&[real], &[synth]);
        assert_eq!(anchors.len(), 4);
    }

    /// `airport_anchors` always layers traffic centroids on top of
    /// runway-end anchors. Heliport (no runway batch rows) gets the
    /// legacy centroid path, exactly today's behavior.
    #[test]
    fn airport_anchors_layers_runway_ends_plus_centroids() {
        // One runway batch, plus one fabricated traffic row (we build
        // the AirportTrafficRowView by hand since AirportTrafficRowAccum
        // requires schema-stamped batches).
        let batch = real_batch(&[RowSpec {
            osm_id: 42, segment_idx: 0, start_lat: 50.0, start_lon: 14.0, end_lat: 50.0, end_lon: 14.001, aeroway_type: 0,
        }]);
        let band_zero: [f32; 8] = [0.0; 8];
        let gse_zero: [u32; 3] = [0; 3];
        let traffic = vec![AirportTrafficRowView {
            airport_key: "LKTEST",
            osm_id: 42,
            segment_idx: 0,
            geometry_kind: 0,
            start_lat: 50.0,
            start_lon: 14.0,
            end_lat: 50.0,
            end_lon: 14.001,
            length_m: 100.0,
            ops_kind: 1,
            is_departure: 0,
            veh_kind: 0,
            class_idx: 0,
            period: 0,
            band_energy_lin: &band_zero,
            unique_movement_count: 0,
            unique_arr_count: 0,
            unique_dep_count: 0,
            unique_gse_count_per_class: &gse_zero,
            microseg_unique_count: 0,
            microseg_unique_arr_count: 0,
            microseg_unique_dep_count: 0,
            microseg_unique_gse_count_per_class: &gse_zero,
        }];
        let anchors = airport_anchors(&[batch], &[], &traffic);
        // 2 runway endpoints + 1 traffic centroid = 3.
        assert_eq!(anchors.len(), 3);
    }

    /// CRITICAL regression test (rev 1 issue #2): runway lines
    /// present in the disk but ZERO airport_traffic rows must still
    /// produce runway-end anchors. Today's centroid-only code path
    /// would have produced zero anchors here (traffic-coupled).
    #[test]
    fn no_traffic_runway_lines_still_emit_anchors() {
        let batch = real_batch(&[
            RowSpec { osm_id: 42, segment_idx: 0, start_lat: 50.0, start_lon: 14.0, end_lat: 50.0, end_lon: 14.001, aeroway_type: 0 },
            RowSpec { osm_id: 42, segment_idx: 1, start_lat: 50.0, start_lon: 14.001, end_lat: 50.0, end_lon: 14.002, aeroway_type: 0 },
        ]);
        let anchors = airport_anchors(&[batch], &[], &[]);
        assert_eq!(anchors.len(), 2);
    }

    /// Empty disk → empty anchors. Same graceful-degradation behavior
    /// as today's `airport_centroids_from_traffic` on an empty slice.
    #[test]
    fn empty_inputs_produce_empty_anchors() {
        let anchors = airport_anchors(&[], &[], &[]);
        assert!(anchors.is_empty());
    }

    // ──────────────────────────────────────────────────────────────
    // Integration-level scenarios — exercise the gate semantics
    // `airport_anchors` exists to support. The kernel-side gate is
    // `is_near_airport` (private), so the tests re-implement the
    // identical "any anchor within AIRPORT_CONTEXT_RADIUS_M" check
    // directly via `noise_compute::propagation::geo::flat_dist`.
    // ──────────────────────────────────────────────────────────────

    /// Mirrors `AIRPORT_CONTEXT_RADIUS_M` in the kernel. Hardcoded
    /// here so the test breaks loud if the kernel constant changes
    /// without updating this assertion.
    const GATE_RADIUS_M: f64 = 6000.0;

    fn any_within(anchors: &[(f64, f64)], lat: f64, lon: f64) -> bool {
        anchors.iter().any(|&(a_lat, a_lon)| {
            noise_compute::propagation::geo::flat_dist(lat, lon, a_lat, a_lon) <= GATE_RADIUS_M
        })
    }

    /// Plan §8.3 dual-runway hub scenario. Two parallel east-west
    /// runways 8 km long, separated by ~11 km north-south. The
    /// centroid-only path would place a single anchor near the
    /// midpoint between both runways and gate-fail at receivers
    /// near each far runway end; the runway-end path provides 4
    /// anchors and rescues those receivers.
    #[test]
    fn dual_runway_hub_gate_active_at_each_runway_end() {
        // 0.111° lon at 50° lat ≈ 8 km east; 0.10° lat ≈ 11 km north.
        let batch = real_batch(&[
            RowSpec {
                osm_id: 1, segment_idx: 0,
                start_lat: 50.000, start_lon: 0.000,
                end_lat:   50.000, end_lon:   0.111,
                aeroway_type: 0,
            },
            RowSpec {
                osm_id: 2, segment_idx: 0,
                start_lat: 50.100, start_lon: 0.000,
                end_lat:   50.100, end_lon:   0.111,
                aeroway_type: 0,
            },
        ]);
        let anchors = runway_ends_from_airport_lines(&[batch], &[]);
        assert_eq!(anchors.len(), 4, "two runways × two endpoints each");
        assert!(any_within(&anchors, 50.000, 0.000), "near runway A west end");
        assert!(any_within(&anchors, 50.000, 0.111), "near runway A east end");
        assert!(any_within(&anchors, 50.100, 0.111), "near runway B east end");
        assert!(
            !any_within(&anchors, 50.200, 0.000),
            "11 km north of runway B — must fail gate",
        );
    }

    /// Plan §8.5 perpendicular-off-axis small airport.
    ///
    /// Single 3.5 km east-west runway centred at (50.000, 0.000),
    /// receiver 5.8 km north of midpoint. The centroid-only path
    /// places the anchor at the runway midpoint → 5.8 km away,
    /// passes 6 km gate. The runway-end path places anchors at
    /// both endpoints, each at √(5.8² + 1.75²) ≈ 6.06 km from the
    /// receiver → fails the gate.
    ///
    /// Documents the intentional tightening at perpendicular-off-
    /// axis cases — the gate exists to rescue along-axis approach
    /// segments below the 150 m AGL floor, not perpendicular-off-
    /// axis receivers.
    #[test]
    fn perpendicular_off_axis_small_airport_tightens_after_runway_ends() {
        let half_runway_deg_lon = 0.04879 * 0.5; // ~1.75 km east-west at 50° lat
        let batch = real_batch(&[RowSpec {
            osm_id: 1, segment_idx: 0,
            start_lat: 50.000, start_lon: -half_runway_deg_lon,
            end_lat:   50.000, end_lon:    half_runway_deg_lon,
            aeroway_type: 0,
        }]);
        let anchors = runway_ends_from_airport_lines(&[batch], &[]);
        assert_eq!(anchors.len(), 2);
        // 5.8 km / 110_540 m/° ≈ 0.05246°.
        let rcv_lat = 50.000 + 0.05246;
        let rcv_lon = 0.000;
        // Legacy centroid path would have passed: receiver IS within
        // 6 km of the runway midpoint.
        assert!(
            noise_compute::propagation::geo::flat_dist(rcv_lat, rcv_lon, 50.000, 0.000)
                <= GATE_RADIUS_M,
            "receiver should be within 6 km of runway midpoint (legacy path)",
        );
        // New path: receiver ≈ 6.06 km from each runway end → fails
        // gate. This is the documented intentional tightening.
        assert!(
            !any_within(&anchors, rcv_lat, rcv_lon),
            "runway-end anchors should tighten the gate at perpendicular off-axis receivers",
        );
    }

    /// Mixed-disk heliport + runway airport: both keep gate behavior
    /// (the heliport via its centroid fallback, the runway airport
    /// via its endpoint anchors). The layering at the popup site is
    /// what preserves today's heliport behavior bit-for-bit.
    #[test]
    fn heliport_keeps_centroid_when_layered_with_runway_airport() {
        // Heliport: airport_traffic row only, no runway lines.
        let band_zero: [f32; 8] = [0.0; 8];
        let gse_zero: [u32; 3] = [0; 3];
        let traffic = vec![AirportTrafficRowView {
            airport_key: "HELIPAD",
            osm_id: 0, segment_idx: 0, geometry_kind: 0,
            start_lat: 51.000, start_lon: 1.000,
            end_lat: 51.000, end_lon: 1.000,
            length_m: 0.0,
            ops_kind: 1, is_departure: 0, veh_kind: 0, class_idx: 0, period: 0,
            band_energy_lin: &band_zero,
            unique_movement_count: 0, unique_arr_count: 0, unique_dep_count: 0,
            unique_gse_count_per_class: &gse_zero,
            microseg_unique_count: 0, microseg_unique_arr_count: 0,
            microseg_unique_dep_count: 0,
            microseg_unique_gse_count_per_class: &gse_zero,
        }];
        // Runway airport: airport_lines row only, no traffic.
        let batch = real_batch(&[RowSpec {
            osm_id: 1, segment_idx: 0,
            start_lat: 50.000, start_lon: 0.000,
            end_lat:   50.000, end_lon:   0.001,
            aeroway_type: 0,
        }]);
        let anchors = airport_anchors(&[batch], &[], &traffic);
        assert_eq!(anchors.len(), 3, "2 runway endpoints + 1 heliport centroid");
        assert!(any_within(&anchors, 51.000, 1.000), "receiver at heliport");
        assert!(any_within(&anchors, 50.000, 0.000), "receiver at runway");
        assert!(
            !any_within(&anchors, 50.500, 0.500),
            "receiver ~55 km away from either — must fail gate",
        );
    }
}
