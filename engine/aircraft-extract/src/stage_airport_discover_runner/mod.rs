//! Stage 1.5 — DBSCAN auto-discovery of OSM-missing airfields.
//!
//! Runs once over the multi-day Stage 1 segment set, between Stage 1
//! (per-day par_iter) and Stage 2A (sequential popup-arrow writers).
//! Sits at Stage 1.5 — not Stage 1 — so Stage 1 stays
//! ADS-B-normalisation-only and doesn't grow a dependency on OSM
//! geometry. Sits BEFORE Stage 2A/2C — so `R4Cache::load` sees the
//! `synth_airport_lines.arrow` / `synth_airport_areas.arrow` sidecars
//! this stage emits.
//!
//! Pipeline per R4 in scope:
//! 1. Load `airport_lines.arrow` for that R4.
//! 2. For every aircraft ground-phase FlightSegment whose midpoint
//!    falls in the R4, project the segment's leg onto airport lines
//!    with the same buffer Stage 2C uses ([`AIRPORT_LINE_SNAP_BUFFER_M`])
//!    — so a vertex Stage 2C would have snapped to cannot feed
//!    DBSCAN. GSE segments (`veh_kind != 0`) are excluded: their
//!    service-road clusters can look line-like but don't represent
//!    runway activity.
//! 3. Run [`discover_strips`] with eps=200 m / min_samples=5
//!    (sized low per the observability-first principle so small
//!    clusters surface and the user can triage them via popup
//!    metadata rather than being silently dropped).
//! 4. Classify each cluster:
//!    * `Reject` — not line-shaped (`is_line=false`); the only
//!      remaining silent-drop path, kept because the synth line
//!      schema only carries line geometry (blob/area clusters need
//!      Stage 2C's `geometry_kind=AREA_GRID_POINT` to round-trip,
//!      which is a separate workstream).
//!    * `Reattribute(real_key)` — centroid sits inside the same
//!      polygon-radius-aware aerodrome window Stage 2C uses (the
//!      shared [`nearest_aerodrome_within`] helper) AND within
//!      `REAL_LINE_NEAR_BUFFER_M` of a real OSM aeroway line. The
//!      cluster's geometry is emitted under the real airport's
//!      `airport_key` so Stage 2C unifies it with the real OSM
//!      lines for that airport.
//!    * `SynthAirport` — every other accepted cluster, including
//!      (a) clusters far from any real aerodrome (genuine auto-
//!      discoveries) and (b) clusters inside a real aerodrome's
//!      polygon buffer but NOT near any real OSM line; both are
//!      labelled `auto-<H3-R11-hex>` so they remain visible in the
//!      popup with full provenance.
//! 5. Microsegment each accepted cluster into ≤50 m pieces matching
//!    the real `airport_lines.arrow` convention.
//! 6. **Always rewrite** `synth_airport_lines.arrow` /
//!    `synth_airport_areas.arrow` for every in-scope R4 — including
//!    R4s with no accepted clusters (writes empty arrows). Keeps
//!    re-extracts idempotent: a strip that was discovered last run
//!    but no longer clusters this run cannot leave a stale row on
//!    disk for Stage 2C to consume.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result};
use noise_compute::types::AirportArea;
use rayon::prelude::*;

use crate::airport_index::AerodromeIndex;
use crate::airport_io::{read_airport_lines, AirportLineRow};
use crate::flight::{FlightSegment, Phase};
use crate::geo::{r4_hex_str, M_PER_DEG_LAT, M_PER_DEG_LON_EQUATOR};
use crate::progress::{finished, started, Milestone};
use crate::scope::ScopeBbox;
use crate::stage_2c::airport_traffic::{
    project_leg_onto_airport_lines, AirportLineSegment, AIRPORT_LINE_SNAP_BUFFER_M,
};
use crate::stage_airport_discover::{discover_strips, DiscoveredStrip};
use crate::synth_airport_io::{
    synth_airport_key_for, synth_display_name, synth_osm_id_for, write_synth_airport_areas,
    write_synth_airport_lines, SynthAirportAreaRow, SynthAirportLineRow, AIRSTRIP_AEROWAY_TYPE,
    SYNTH_AERODROME_AEROWAY_TYPE, SYNTH_AREAS_FILE, SYNTH_LINES_FILE,
};

/// DBSCAN cluster radius. 200 m bridges adjacent ADS-B fixes along
/// a typical 1–3 km airstrip without merging two physically distinct
/// strips (real airport runways are ~1.5–4 km long, two-runway
/// airports have ≥500 m between them).
const DBSCAN_EPS_M: f32 = 200.0;

/// DBSCAN min cluster size. 5 vertices over the extraction window
/// admits strips with as few as 1-2 flights/14 days (each rotation
/// contributes ~4-10 ground vertices). Sized low so popup
/// observability surfaces low-confidence strips for triage rather
/// than silently dropping them — line-shape (in `classify_cluster`)
/// plus the `CLUSTER_MAX_*` caps below are the only accept/reject
/// gates.
const DBSCAN_MIN_SAMPLES: usize = 5;

/// Reject clusters longer than this even if `is_line=true`. Real
/// runways top out around 4000 m (Doha 4850 m, Madrid 4350 m are
/// the longest commercial runways in service); a synth line longer
/// than that is almost certainly an approach corridor mis-merged
/// across multiple aircraft trajectories.
const CLUSTER_MAX_LENGTH_M: f32 = 4000.0;

/// Reject clusters whose vertex_count over the extraction window
/// implies > ~700 ground visits/day. The busiest microsegments at
/// LKPR see ~50-100 movements/day; a count an order of magnitude
/// higher means the cluster captured non-ground vertices (typically
/// dense ATC waypoints on the STAR/SID corridor).
const CLUSTER_MAX_VERTICES: u32 = 20_000;

/// Maximum perpendicular distance from a cluster centroid to any real
/// OSM aeroway microsegment for the cluster to count as "on an
/// aeroway". The Stage 1.5 reattribution gate uses this in concert
/// with the polygon-buffer test from
/// [`nearest_aerodrome_within`]: a cluster inside an aerodrome's
/// polygon buffer is only folded into the airport's key when it
/// also sits on (or right next to) a real runway / taxiway line.
/// Otherwise it flows to the `auto-<R11>` synth path so it stays
/// visible under a neutral label — never silently dropped. Without
/// this second pass, ADS-B noise from cars on access roads or GSE
/// in parking lots within the polygon buffer (LKPR's
/// `NEAREST_AERODROME_FLOOR_M = 6 km` reaches them) was
/// mis-labeled with the airport's key — the Hostivice phantom strips
/// 4-5 km SE of LKPR were the symptom that surfaced this gate.
///
/// 300 m = 6 × the Stage 2C
/// [`AIRPORT_LINE_SNAP_BUFFER_M`](crate::stage_2c::airport_traffic::AIRPORT_LINE_SNAP_BUFFER_M)
/// of 50 m. The two are deliberately separate knobs: Stage 2C snaps
/// per-leg endpoints (tight, on-line semantics), while Stage 1.5
/// snaps a cluster's CENTROID — a coarser summary that already
/// averages across the strip's extent. The wider value covers
/// apron-edge clusters whose centroid sits ~200-300 m off the
/// nearest taxiway centerline even though the cluster's vertices
/// hugged the line. Tighter risks rejecting legit apron-edge
/// clusters; the Hostivice phantoms sit 1.1-2.4 km from any real
/// LKPR line so even substantially looser values still reject them.
const REAL_LINE_NEAR_BUFFER_M: f64 = 300.0;

/// Microsegment length cap for the emitted synthetic runway. Matches
/// the real `airport_lines.arrow` writer (osm-extract `main.rs:269,
/// max_len = 250.0`) and the road/rail microsegment cap. The Stage 2C
/// projection buffer (50 m perpendicular) is spatial-only, so segment
/// LENGTH doesn't affect its snap correctness; matching road/rail
/// keeps per-microsegment compute scaling uniform across all layers.
const SYNTH_MICROSEGMENT_M: f32 = 250.0;

/// Disposition of a cluster after the acceptance + identity pass.
enum ClusterDisposition<'a> {
    Reject,
    /// Cluster centroid sits inside a real aerodrome's snap window.
    /// Emit synth lines under the real airport's key so Stage 2C
    /// unifies them with the (incomplete) real OSM lines.
    Reattribute(&'a AirportArea),
    /// Default disposition for any accepted cluster the
    /// `Reattribute` arm doesn't claim. Emit under a fresh
    /// content-addressed `auto-<H3-R11>` key. Covers two cases:
    /// (a) cluster far from every real aerodrome (genuine auto-
    /// discovery, e.g. unmapped African / GA strip);
    /// (b) cluster inside a real aerodrome's polygon buffer but
    /// further than `REAL_LINE_NEAR_BUFFER_M` from any real OSM
    /// aeroway line. Kept visible per the observability-first
    /// principle so phantom in-buffer clusters can be triaged in the
    /// popup rather than vanishing.
    SynthAirport,
}

/// Drive Stage 1.5 over the Stage 1 multi-day segment set. Returns
/// the total number of R4s that received at least one synthetic /
/// re-attributed line row.
///
/// `airport_areas_global` is the union of every R4's
/// `airport_areas.arrow` (the same global set Stage 2C consumes for
/// `nearest_aerodrome_within`). The runner uses it for both the
/// re-attribution check (cluster inside a real aerodrome → use its
/// key) and the implicit "new airfield" path (no nearby real area).
///
/// `airport_lines_global` is the union of every R4's
/// `airport_lines.arrow`. Inside an aerodrome's polygon buffer the
/// runner cross-checks each cluster against this set: clusters that
/// sit on or right next to a real OSM aeroway line are folded into
/// the airport's key; clusters that pass the polygon test but sit
/// far from every real line are rejected as DBSCAN false positives.
pub fn run_stage_airport_discover(
    segments_by_r4_dir: &Path,
    aerodrome_index: &AerodromeIndex,
    airport_lines_global: &[AirportLineRow],
    h3r4_dir: &Path,
    scope: Option<&ScopeBbox>,
) -> Result<usize> {
    let active: BTreeMap<u64, std::path::PathBuf> =
        crate::shuffle::list_r4_shards(segments_by_r4_dir, "ground.arrow", scope)?
            .into_iter()
            .collect();
    // Union with R4s holding stale synth sidecars on disk so a
    // previously-populated R4 with no ground signal this run gets its
    // sidecars cleared (run_one_r4 with empty segments writes empty
    // arrows); otherwise Stage 2C reads zombie airport areas.
    let stale = stale_synth_sidecar_r4s(h3r4_dir, scope, &active)?;
    if active.is_empty() && stale.is_empty() {
        return Ok(0);
    }
    let mut r4_keys: Vec<u64> = active.keys().copied().collect();
    r4_keys.extend(stale);
    r4_keys.sort_unstable();
    started(
        "stage1.5",
        &format!(
            "{} R4 cells ({} active, {} stale-only)",
            r4_keys.len(),
            active.len(),
            r4_keys.len() - active.len()
        ),
    );
    let stage_start = std::time::Instant::now();
    let r4_counter = Milestone::new("stage1.5", "R4 cells", 50);
    // Per-R4 detail log only for cells whose body takes longer than
    // this — keeps the log readable when 95% of cells finish in
    // milliseconds (polygon gate covers them), surfaces the long-tail
    // hub R4s without further configuration.
    const PER_R4_SLOW_LOG_THRESHOLD: std::time::Duration = std::time::Duration::from_secs(5);

    let results: Vec<Result<bool>> = r4_keys
        .par_iter()
        .map(|r4| {
            let r4_start = std::time::Instant::now();
            let segments = match active.get(r4) {
                Some(shard) => crate::arrow_io::read_segments(shard)
                    .with_context(|| format!("read {}", shard.display()))?,
                None => Vec::new(),
            };
            let n_segs = segments.len();
            let out = run_one_r4(
                *r4,
                &segments,
                aerodrome_index,
                airport_lines_global,
                h3r4_dir,
            )
            .with_context(|| format!("R4 {r4:015x}"))?;
            let elapsed = r4_start.elapsed();
            if elapsed >= PER_R4_SLOW_LOG_THRESHOLD {
                eprintln!(
                    "{} [stage1.5] R4 {} done in {:?} ({} ground segs, populated={})",
                    crate::progress::ts(),
                    r4_hex_str(*r4),
                    elapsed,
                    n_segs,
                    out,
                );
            }
            r4_counter.add(1);
            Ok(out)
        })
        .collect();

    let mut populated = 0usize;
    for r in results {
        if r? {
            populated += 1;
        }
    }
    finished(
        "stage1.5",
        &format!(
            "{populated} of {} R4s populated with synth airport_lines in {:?}",
            r4_keys.len(),
            stage_start.elapsed()
        ),
    );
    Ok(populated)
}

/// Process one R4: build candidate set, cluster, classify, emit. Always
/// rewrites both sidecars (even empty) so a previously-populated R4
/// that this run finds nothing in is monotonically cleared.
fn run_one_r4(
    r4: u64,
    segments: &[FlightSegment],
    aerodrome_index: &AerodromeIndex,
    airport_lines_global: &[AirportLineRow],
    h3r4_dir: &Path,
) -> Result<bool> {
    let r4_dir = h3r4_dir.join(r4_hex_str(r4));
    let lines_path = r4_dir.join("airport_lines.arrow");
    let lines = load_airport_lines_as_segments(&lines_path)?;

    let candidates = collect_miss_snap_vertices(segments, &lines, aerodrome_index);
    let strips = if candidates.len() >= DBSCAN_MIN_SAMPLES {
        discover_strips(&candidates, DBSCAN_EPS_M, DBSCAN_MIN_SAMPLES)
    } else {
        Vec::new()
    };

    let mut line_rows = Vec::new();
    let mut area_rows = Vec::new();
    for strip in &strips {
        match classify_cluster(strip, aerodrome_index, airport_lines_global) {
            ClusterDisposition::Reject => continue,
            ClusterDisposition::Reattribute(real_area) => {
                emit_lines_for_strip(strip, real_area.airport_key.clone(), &mut line_rows);
                // Do NOT emit a synth area — the real aerodrome
                // polygon already exists in `airport_areas.arrow`.
            }
            ClusterDisposition::SynthAirport => {
                let centroid_lat = strip.center_lat as f64;
                let centroid_lon = strip.center_lon as f64;
                let key = synth_airport_key_for(centroid_lat, centroid_lon);
                emit_lines_for_strip(strip, key.clone(), &mut line_rows);
                area_rows.push(SynthAirportAreaRow {
                    osm_id: synth_osm_id_for(centroid_lat, centroid_lon),
                    airport_key: key,
                    name: synth_display_name(
                        centroid_lat,
                        centroid_lon,
                        strip.length_m,
                        strip.vertex_count,
                    ),
                    aeroway_type: SYNTH_AERODROME_AEROWAY_TYPE,
                    centroid_lat,
                    centroid_lon,
                    area_m2: strip.length_m * strip.width_m,
                });
            }
        }
    }

    // Idempotency: always rewrite even when both vecs are empty.
    // `write_synth_airport_*` truncate-and-replaces via
    // `arrow_io::write_record_batches`, so a previously-populated R4
    // that this run finds nothing in is cleared on disk.
    write_synth_airport_lines(&r4_dir.join(SYNTH_LINES_FILE), &line_rows)?;
    write_synth_airport_areas(&r4_dir.join(SYNTH_AREAS_FILE), &area_rows)?;

    Ok(!line_rows.is_empty())
}

/// In-scope R4 subdirs holding a synth sidecar on disk but absent
/// from `already_known` (the current-run ground-segment set). Used to
/// reach R4s a prior run discovered but that have no segments today —
/// without this scan, their stale sidecars feed Stage 2C zombie data.
fn stale_synth_sidecar_r4s(
    h3r4_dir: &Path,
    scope: Option<&ScopeBbox>,
    already_known: &BTreeMap<u64, std::path::PathBuf>,
) -> Result<Vec<u64>> {
    // Missing dir on first run is fine; permission / IO errors must
    // propagate so a silent skip can't reproduce the zombie-sidecar
    // bug this scan was added to prevent.
    let entries = match std::fs::read_dir(h3r4_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("read_dir {}", h3r4_dir.display())),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.with_context(|| format!("read_dir entry in {}", h3r4_dir.display()))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(r4) = u64::from_str_radix(name, 16) else {
            continue;
        };
        if already_known.contains_key(&r4) {
            continue;
        }
        if let Some(s) = scope {
            if !s.contains_r4(r4) {
                continue;
            }
        }
        if path.join(SYNTH_LINES_FILE).exists() || path.join(SYNTH_AREAS_FILE).exists() {
            out.push(r4);
        }
    }
    Ok(out)
}

/// Load `airport_lines.arrow` for one R4. Missing file → empty vec
/// (a legitimately OSM-sparse R4). Corrupt / unreadable file →
/// `Err` with the path in context — failing loud is preferable to
/// silently flooding DBSCAN with bogus miss-snap candidates that
/// would emit fake airfields.
fn load_airport_lines_as_segments(path: &Path) -> Result<Vec<AirportLineSegment>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let rows = read_airport_lines(path).with_context(|| format!("read {}", path.display()))?;
    Ok(rows
        .into_iter()
        .map(|r| AirportLineSegment {
            osm_id: r.osm_id,
            segment_idx: r.segment_idx,
            start_lat: r.start_lat,
            start_lon: r.start_lon,
            end_lat: r.end_lat,
            end_lon: r.end_lon,
            length_m: r.length_m,
            aeroway_type: r.aeroway_type,
        })
        .collect())
}

/// One ground segment becomes 0 or 2 miss-snap vertices, depending on
/// two gates applied in order:
///
/// 1. **Known-aerodrome polygon gate** — drop the whole segment when
///    EITHER endpoint sits inside any OSM aerodrome's centroid-radius
///    window. Stage 1.5 is for OSM-MISSING airfields, so a leg with
///    one foot at a known aerodrome can never seed an unmapped strip:
///    the exterior endpoint is either a takeoff climb / final-approach
///    point (en-route ADS-B noise) or a cross-country waypoint, not a
///    strip vertex. Skipping the segment entirely also skips the
///    expensive line-snap kernel below — at hub R4s this is the
///    decisive win because takeoff / landing transitions
///    (one foot at the aerodrome, the other 6-10 km out) make up the
///    bulk of ground-tagged segments and they all flowed through the
///    O(M_lines) kernel under the BOTH-inside rule.
/// 2. **OSM aeroway line gate** — for segments fully outside every
///    aerodrome polygon, drop the segment when the leg projects onto
///    any local OSM aeroway microsegment within
///    [`AIRPORT_LINE_SNAP_BUFFER_M`]. Catches isolated taxi /
///    runway segments at airports whose polygon coverage in OSM is
///    incomplete (only `aeroway=runway` line, no `aerodrome`
///    polygon — common for small fields).
///
/// Both endpoints flow into DBSCAN as cluster seeds. Mid-leg emission
/// is intentionally not used; cluster geometry should capture the
/// actual ADS-B trajectory shape, and the leg-pair is what shapes
/// the synth runway centreline downstream.
fn collect_miss_snap_vertices(
    segments: &[FlightSegment],
    lines: &[AirportLineSegment],
    index: &AerodromeIndex,
) -> Vec<(f32, f32)> {
    let mut out = Vec::with_capacity(segments.len() * 2);
    for seg in segments {
        // Stage 1.5 only clusters aircraft ground vertices — GSE
        // service-road clusters can look line-like but don't represent
        // runway activity. Shuffle merged both veh_kinds into
        // ground.arrow; filter here.
        if seg.phase != Phase::Ground || seg.veh_kind != 0 {
            continue;
        }
        // Stage 1's classifier shouldn't produce non-finite endpoints,
        // but a downstream rayon panic would be harder to diagnose
        // than a silent skip.
        if !seg.start_lat.is_finite()
            || !seg.start_lon.is_finite()
            || !seg.end_lat.is_finite()
            || !seg.end_lon.is_finite()
        {
            continue;
        }
        // Polygon gate — bool check, no per-line allocation. EITHER
        // endpoint inside any known aerodrome → drop the whole leg
        // (see docstring for the takeoff/landing transition rationale).
        if index.contains(seg.start_lat as f64, seg.start_lon as f64)
            || index.contains(seg.end_lat as f64, seg.end_lon as f64)
        {
            continue;
        }
        // Line gate — only fully-exterior legs reach here, so the
        // O(M_lines) cost is bounded by genuine ambiguous-airport
        // segments (small fields with line but no polygon).
        let intersections = project_leg_onto_airport_lines(
            seg.start_lat,
            seg.start_lon,
            seg.end_lat,
            seg.end_lon,
            lines,
            AIRPORT_LINE_SNAP_BUFFER_M,
        );
        if !intersections.is_empty() {
            continue;
        }
        out.push((seg.start_lat, seg.start_lon));
        out.push((seg.end_lat, seg.end_lon));
    }
    out
}

fn classify_cluster<'a>(
    strip: &DiscoveredStrip,
    aerodrome_index: &'a AerodromeIndex<'_>,
    airport_lines_global: &[AirportLineRow],
) -> ClusterDisposition<'a> {
    if !strip.is_line {
        // Commits 1-4 ship line clusters only — apron-equivalent
        // blobs need a `geometry_kind` extension to Stage 2C that's
        // out of scope (see plan "Out of scope").
        return ClusterDisposition::Reject;
    }
    // Length / vertex caps for approach-corridor ghost clusters.
    // Even with the AGL filter on input vertices, occasional
    // mis-classified samples sneak through and DBSCAN's eps=200m
    // can bridge them into multi-km lines. Reject those rather
    // than emit garbage geometry that draws across residential
    // areas miles from any actual runway.
    if strip.length_m > CLUSTER_MAX_LENGTH_M {
        return ClusterDisposition::Reject;
    }
    if strip.vertex_count > CLUSTER_MAX_VERTICES {
        return ClusterDisposition::Reject;
    }
    // `nearest_aerodrome_within` admits name-only entries (key may
    // still be empty if the OSM extract carried a `name=` tag with
    // no ICAO `ref=`). Re-attribution requires a non-empty key
    // because that's what flows into airport_traffic.arrow rows.
    let nearby_aerodrome = aerodrome_index
        .nearest(strip.center_lat as f64, strip.center_lon as f64)
        .filter(|a| !a.airport_key.is_empty());
    // Inside a real aerodrome's polygon buffer the cluster must ALSO
    // sit within `REAL_LINE_NEAR_BUFFER_M` of at least one real OSM
    // aeroway microsegment. Otherwise it's a DBSCAN false positive
    // (ADS-B vertices from cars on access roads, GSE in parking
    // lots) that previously slipped through and got mis-labeled with
    // the airport's key. Far-from-any-aerodrome clusters still flow
    // through the existing `auto-<R11>` path — the line gate is
    // intentionally gated inside the polygon arm so genuinely-new
    // airfields with zero OSM coverage still get auto-discovered.
    // Three-way disposition driven by observability: never silently
    // drop a cluster, only relabel. A cluster in an aerodrome's
    // polygon buffer AND near a real OSM line → fold into that
    // airport. A cluster in the buffer but FAR from any real line
    // (typical false-positive: ADS-B noise from access-road cars,
    // approach-corridor mis-classifications) → relabel as a
    // synthetic `auto-<R11>` airfield so it stays visible in the
    // popup with full provenance, not erased. A cluster far from
    // every aerodrome → auto-* as before.
    match nearby_aerodrome {
        Some(area)
            if cluster_near_real_aeroway_line(
                strip.center_lat as f64,
                strip.center_lon as f64,
                airport_lines_global,
            ) =>
        {
            ClusterDisposition::Reattribute(area)
        }
        Some(_) | None => ClusterDisposition::SynthAirport,
    }
}

/// True iff some microsegment in `airport_lines_global` is within
/// `REAL_LINE_NEAR_BUFFER_M` PERPENDICULAR distance of
/// `(cluster_lat, cluster_lon)`. Uses
/// [`noise_compute::propagation::geo::point_to_segment`] (the same
/// kernel road / rail / Stage 2C projection use) so a long microseg
/// whose midpoint is >300 m from the cluster but whose body passes
/// within 300 m still counts as "near".
///
/// Linear `.any()` scan with short-circuit. For CZ scope `airport_
/// lines_global` is ~10-15 k microsegs; global OSM aeroway coverage
/// is in the low millions. Worst-case per cluster ~10 µs (CZ) to a
/// few ms (global); ~dozens of clusters per R4 makes this a single-
/// digit ms contribution to Stage 1.5 versus the DBSCAN itself.
fn cluster_near_real_aeroway_line(
    cluster_lat: f64,
    cluster_lon: f64,
    airport_lines_global: &[AirportLineRow],
) -> bool {
    use noise_compute::propagation::geo::point_to_segment;
    airport_lines_global.iter().any(|line| {
        let (dist_m, _, _, _) = point_to_segment(
            cluster_lat,
            cluster_lon,
            line.start_lat as f64,
            line.start_lon as f64,
            line.end_lat as f64,
            line.end_lon as f64,
        );
        dist_m < REAL_LINE_NEAR_BUFFER_M
    })
}

fn emit_lines_for_strip(
    strip: &DiscoveredStrip,
    airport_key: String,
    out: &mut Vec<SynthAirportLineRow>,
) {
    let centroid_lat = strip.center_lat as f64;
    let centroid_lon = strip.center_lon as f64;
    let osm_id = synth_osm_id_for(centroid_lat, centroid_lon);
    let name = synth_display_name(
        centroid_lat,
        centroid_lon,
        strip.length_m,
        strip.vertex_count,
    );
    for ms in microsegment_strip(strip) {
        out.push(SynthAirportLineRow {
            osm_id,
            segment_idx: ms.segment_idx,
            airport_key: airport_key.clone(),
            start_lat: ms.start_lat,
            start_lon: ms.start_lon,
            end_lat: ms.end_lat,
            end_lon: ms.end_lon,
            length_m: ms.length_m,
            heading_deg: strip.heading_deg,
            aeroway_type: AIRSTRIP_AEROWAY_TYPE,
            name: name.clone(),
        });
    }
}

/// One emitted microsegment of a synthetic runway.
struct MicroSegment {
    segment_idx: u16,
    start_lat: f64,
    start_lon: f64,
    end_lat: f64,
    end_lon: f64,
    length_m: f32,
}

/// Slice the cluster line (length `strip.length_m` along
/// `strip.heading_deg`, centred at `(center_lat, center_lon)`) into
/// `ceil(length / 50 m)` microsegments. The synthetic line is
/// straight; real OSM runways are usually straight too, so a polyline
/// model isn't needed.
fn microsegment_strip(strip: &DiscoveredStrip) -> Vec<MicroSegment> {
    let n = ((strip.length_m / SYNTH_MICROSEGMENT_M).ceil() as u32).max(1);
    let step_m = strip.length_m / n as f32;
    let half = strip.length_m * 0.5;
    let bearing_rad = (strip.heading_deg as f64).to_radians();
    // Compass heading: 0 = north, 90 = east. East unit = sin, north unit = cos.
    let east_unit = bearing_rad.sin();
    let north_unit = bearing_rad.cos();
    let cos_lat = (strip.center_lat as f64).to_radians().cos();

    let center_lat_f64 = strip.center_lat as f64;
    let center_lon_f64 = strip.center_lon as f64;

    let mut out = Vec::with_capacity(n as usize);
    for i in 0..n {
        let along_start_m = -(half as f64) + (i as f64) * (step_m as f64);
        let along_end_m = along_start_m + (step_m as f64);
        let (slat, slon) = offset_latlon(
            center_lat_f64,
            center_lon_f64,
            east_unit,
            north_unit,
            cos_lat,
            along_start_m,
        );
        let (elat, elon) = offset_latlon(
            center_lat_f64,
            center_lon_f64,
            east_unit,
            north_unit,
            cos_lat,
            along_end_m,
        );
        out.push(MicroSegment {
            segment_idx: i as u16,
            start_lat: slat,
            start_lon: slon,
            end_lat: elat,
            end_lon: elon,
            length_m: step_m,
        });
    }
    out
}

/// Add `along_m` along the unit vector `(east_unit, north_unit)` to
/// the anchor `(anchor_lat, anchor_lon)`. Local equirectangular —
/// fine for ≤4 km runway extents at any latitude off the poles.
/// Longitude is wrapped to `(-180, 180]` so a strip running across
/// the antimeridian (Pacific airstrips, Fiji-style coverage) emits
/// valid OSM-compatible coordinates instead of values like `181.5`.
fn offset_latlon(
    anchor_lat: f64,
    anchor_lon: f64,
    east_unit: f64,
    north_unit: f64,
    cos_lat: f64,
    along_m: f64,
) -> (f64, f64) {
    let east_m = east_unit * along_m;
    let north_m = north_unit * along_m;
    let dlat = north_m / M_PER_DEG_LAT as f64;
    let dlon = east_m / (M_PER_DEG_LON_EQUATOR as f64 * cos_lat);
    let lat = anchor_lat + dlat;
    let mut lon = anchor_lon + dlon;
    if lon > 180.0 {
        lon -= 360.0;
    } else if lon <= -180.0 {
        lon += 360.0;
    }
    (lat, lon)
}

#[cfg(test)]
mod tests;
