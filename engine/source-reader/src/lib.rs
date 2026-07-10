//! source-reader: mmap'd Arrow IPC reader for noise popup.
//! Zero-copy: data stays in mmap'd pages, queries iterate directly over Arrow columns.

// mimalloc handles popup's many small short-lived allocs (SegmentTrace
// + Box<PropagationBreakdown> + inner Vec<f32>) faster than glibc malloc
// — Microsoft Research benchmarks ~2× speedup for similar workloads.
// At LKPR the per-popup drop cascade (~6 k traces × ~10 inner allocs)
// is the hot spot remaining in apply_segment_top_k_with_cap.
#[cfg(feature = "node")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

pub mod aircraft_v6;
pub mod geo;
pub mod hex_store;
pub mod query;
#[cfg(feature = "node")]
pub mod wire;

// Re-export the pure point-query API at the crate root so its paths
// (`source_reader::PointQueryData`, `collect_sources_at_point`, …) are
// unchanged after the lib.rs/query.rs split, and so the `#[napi]` wrappers
// below resolve `collect_from_hex_data` / `apply_segment_top_k_with_cap`.
pub use query::*;

#[cfg(feature = "node")]
use napi::{Error, Status};
#[cfg(feature = "node")]
use napi_derive::napi;
#[cfg(feature = "node")]
use std::collections::HashMap;
#[cfg(feature = "node")]
use std::sync::RwLock;

#[cfg(feature = "node")]
use hex_store::HexData;
use hex_store::{
    load_hex, query_barriers_from_batches, query_buildings_from_batches, query_roads_from_batches,
};

#[cfg(feature = "node")]
static STORE: std::sync::LazyLock<RwLock<HexStore>> =
    std::sync::LazyLock::new(|| RwLock::new(HexStore::new()));

#[cfg(feature = "node")]
static RASTERS: std::sync::OnceLock<raster_reader::RealRasters> = std::sync::OnceLock::new();

// NACE codes are now baked into industrial.arrow (nace_4digit UInt16 column).
// No global lookup needed at runtime.

#[cfg(feature = "node")]
struct HexStore {
    hexes: HashMap<String, HexData>,
    h3r4_dir: String,
}

#[cfg(feature = "node")]
impl HexStore {
    fn new() -> Self {
        HexStore {
            hexes: HashMap::new(),
            h3r4_dir: String::new(),
        }
    }
}

/// Make every hex in `hex_ids` resident, loading the missing ones IN
/// PARALLEL and OUTSIDE the store lock. Cold loads used to run
/// sequentially (7 hexes × ~12 files) under a held write lock — the whole
/// point of a shared store (all pool workers read one cache since
/// 2026-07-10) is that one visitor's cold load must neither serialize with
/// nor block everyone else's warm queries. First insert wins on a race —
/// the duplicate load is dropped, which is rare and harmless.
#[cfg(feature = "node")]
fn ensure_hexes_parallel(hex_ids: &[String]) {
    let missing: Vec<String> = {
        let store = STORE.read().expect("hex store poisoned");
        hex_ids
            .iter()
            .filter(|id| !store.hexes.contains_key(id.as_str()))
            .cloned()
            .collect()
    };
    if missing.is_empty() {
        return;
    }
    let h3r4_dir = STORE.read().expect("hex store poisoned").h3r4_dir.clone();
    let loaded: Vec<(String, HexData)> = std::thread::scope(|scope| {
        let handles: Vec<_> = missing
            .iter()
            .map(|hex_id| {
                let dir = format!("{h3r4_dir}/{hex_id}");
                scope.spawn(move || match load_hex(&dir) {
                    Ok(data) => data,
                    Err(e) => {
                        eprintln!("  source-reader: failed to load hex {hex_id}: {e}");
                        HexData::empty()
                    }
                })
            })
            .collect();
        missing
            .iter()
            .cloned()
            .zip(
                handles
                    .into_iter()
                    .map(|h| h.join().expect("hex load panicked")),
            )
            .collect()
    });
    let mut store = STORE.write().expect("hex store poisoned");
    for (id, data) in loaded {
        store.hexes.entry(id).or_insert(data);
    }
}

#[cfg(feature = "node")]
#[napi]
pub fn source_init(h3r4_dir: String) -> napi::Result<String> {
    let mut store = STORE
        .write()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
    // The pool workers share ONE library instance (single addon path since
    // 2026-07-10), so every worker spawn/recycle calls source_init on the
    // SAME store — re-init with an unchanged dir must keep the shared cache,
    // not clear it out from under the other workers.
    if store.h3r4_dir == h3r4_dir {
        return Ok(format!(
            "source-reader already initialized: {h3r4_dir} ({} hexes cached, shared store)",
            store.hexes.len()
        ));
    }
    store.h3r4_dir = h3r4_dir.clone();
    store.hexes.clear();

    // Rasters are at data/prepared/{dem,rasters}/ — two levels up from data/prepared/{year}/h3r4/
    let h3r4_path = std::path::Path::new(&h3r4_dir);
    let data_dir = h3r4_path
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or(std::path::Path::new("."));
    let rasters = raster_reader::RealRasters::new(data_dir);
    let has_dem = rasters.has_data();
    RASTERS.set(rasters).ok();

    // NACE codes are baked into industrial.arrow — no global JSON needed

    // Admin table for the defaults cascade (plan v5 §F.3). File lives
    // at data/prepared/h3r4-admin.bin (year-independent, like rasters/DEM).
    // Soft-fail — missing file just leaves the cascade in WORLD arm.
    let admin_bin = noise_compute::admin::default_admin_path(h3r4_path);
    let admin_status = match noise_compute::admin::init_admin_table(&admin_bin) {
        Ok(n) => format!("loaded {n} entries"),
        Err(e) => format!("unavailable ({e})"),
    };

    Ok(format!(
        "source-reader initialized: {h3r4_dir} (DEM: {}; admin: {admin_status})",
        if has_dem { "loaded" } else { "stub" },
    ))
}

#[cfg(feature = "node")]
#[napi]
pub fn query_roads(lat: f64, lng: f64, max_radius_m: f64) -> napi::Result<String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    ensure_hexes_parallel(&hex_ids);
    let store = STORE
        .read()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;

    let mut all_results = Vec::new();
    for hex_id in &hex_ids {
        let Some(data) = store.hexes.get(hex_id.as_str()) else {
            continue;
        };
        let mut results = query_roads_from_batches(&data.road_batches, lat, lng, max_radius_m);
        all_results.append(&mut results);
    }

    Ok(serde_json::to_string(&all_results).unwrap())
}

#[cfg(feature = "node")]
#[napi]
pub fn query_buildings(lat: f64, lng: f64, max_radius_m: f64) -> napi::Result<String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    ensure_hexes_parallel(&hex_ids);
    let store = STORE
        .read()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;

    let mut all_results = Vec::new();
    for hex_id in &hex_ids {
        let Some(data) = store.hexes.get(hex_id.as_str()) else {
            continue;
        };
        let mut results =
            query_buildings_from_batches(&data.building_batches, lat, lng, max_radius_m);
        all_results.append(&mut results);
    }

    Ok(serde_json::to_string(&all_results).unwrap())
}

#[cfg(feature = "node")]
#[napi]
pub fn query_barriers(lat: f64, lng: f64, max_radius_m: f64) -> napi::Result<String> {
    let hex_ids = geo::grid_disk_r4(lat, lng);
    ensure_hexes_parallel(&hex_ids);
    let store = STORE
        .read()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;

    let mut all_results = Vec::new();
    for hex_id in &hex_ids {
        let Some(data) = store.hexes.get(hex_id.as_str()) else {
            continue;
        };
        let mut results =
            query_barriers_from_batches(&data.barrier_batches, lat, lng, max_radius_m);
        all_results.append(&mut results);
    }

    Ok(serde_json::to_string(&all_results).unwrap())
}

#[cfg(feature = "node")]
#[napi]
pub fn reload_hexes(hex_ids: Vec<String>) -> napi::Result<u32> {
    let mut store = STORE
        .write()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
    let mut n = 0u32;
    for hex_id in &hex_ids {
        store.hexes.remove(hex_id);
        n += 1;
    }
    Ok(n)
}

/// Compute full noise at a point using noise-compute engine.
/// Returns JSON with total Lden, per-source breakdown, top contributors.
#[cfg(feature = "node")]
#[napi]
pub fn query_noise_at_point(lat: f64, lng: f64) -> napi::Result<String> {
    query_noise_impl(lat, lng, SEGMENT_TOP_K_PER_KIND)
}

/// Variant of `query_noise_at_point` with a much higher per-kind segment cap
/// (1000 instead of 150). Called from the popup's "Show all" button — the
/// fully-unfiltered airborne set at an airport is millions of segments, far
/// beyond what a browser can parse or what NAPI's string return can carry.
#[cfg(feature = "node")]
#[napi]
pub fn query_noise_at_point_unfiltered(lat: f64, lng: f64) -> napi::Result<String> {
    query_noise_impl(lat, lng, SEGMENT_TOP_K_PER_KIND_FULL)
}

#[cfg(feature = "node")]
fn query_noise_impl(lat: f64, lng: f64, top_k_per_kind: usize) -> napi::Result<String> {
    // Per-stage timing probes (env-gated: `POPUP_TIMING=1` to enable). Inline
    // `Instant::now()` is cheaper and less destructive than perf/flamegraph
    // for popup-scale work, and lets us watch one number per stage land in
    // the Fastify log per request.
    let timing_on = std::env::var("POPUP_TIMING").as_deref() == Ok("1");
    let t_start = std::time::Instant::now();

    let hex_ids = geo::grid_disk_r4(lat, lng);
    // Load missing hexes in parallel WITHOUT holding the store lock, then
    // collect under a read lock — concurrent popups on other workers keep
    // running against the shared cache during a cold load.
    ensure_hexes_parallel(&hex_ids);
    let store = STORE
        .read()
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
    let hex_refs: Vec<&hex_store::HexData> = hex_ids
        .iter()
        .filter_map(|id| store.hexes.get(id.as_str()))
        .collect();

    // Resolve airport_summary.arrow path: sibling of h3r4_dir under
    // `aircraft/` (Stage 2C v5 reduce output). Missing file →
    // popup returns zero airport-level counts (per Codex C4).
    let airport_summary_pathbuf = std::path::Path::new(&store.h3r4_dir)
        .parent()
        .map(|p| p.join("aircraft").join("airport_summary.arrow"));

    let stub = StubRasters;
    let real_rasters = RASTERS.get();
    let rasters: &dyn noise_compute::types::RasterSampler = match real_rasters {
        Some(r) => r,
        None => &stub,
    };
    // Sample receiver elevation up-front so the aircraft kernels see a
    // real ground reference. With the stub rasters (offline tests),
    // elevation is 0.0.
    let elevation = rasters.elevation(lat, lng);
    let t_load = t_start.elapsed();
    let sources = collect_from_hex_data(&hex_refs, lat, lng);
    let t_collect = t_start.elapsed() - t_load;
    drop(store);

    let receiver = noise_compute::types::Receiver::new(lat, lng, elevation);

    let config = noise_compute::types::ComputeConfig {
        n_days: sources.n_days,
        ..Default::default()
    };

    let n_airborne = sources
        .aircraft_airborne_batches
        .iter()
        .map(|b| b.num_rows())
        .sum::<usize>();
    let n_cruise = sources
        .aircraft_cruise_batches
        .iter()
        .map(|b| b.num_rows())
        .sum::<usize>();
    let n_traffic = sources
        .aircraft_airport_traffic_batches
        .iter()
        .map(|b| b.num_rows())
        .sum::<usize>();
    let n_aircraft = n_airborne + n_cruise + n_traffic;
    let n_roads = sources.roads.len();
    let n_railways = sources.railways.len();

    let mut traces = noise_compute::types::TraceCollector::new();
    let mut result = noise_compute::compute_at_point_with_traces(
        &receiver,
        &sources.roads,
        &sources.railways,
        &sources.buildings,
        &sources.industrial,
        &sources.barriers,
        rasters,
        &config,
        Some(&mut traces),
    );
    aircraft_v6::add_v6_aircraft_to_result(
        &mut result,
        &mut traces,
        &receiver,
        &sources.aircraft_airborne_batches,
        &sources.aircraft_cruise_batches,
        &sources.aircraft_airport_traffic_batches,
        &sources.airport_lines_batches,
        &sources.synth_airport_lines_batches,
        airport_summary_pathbuf.as_deref(),
        rasters,
        &sources.barriers,
        sources.n_days,
        top_k_per_kind,
    )
    .map_err(|e| Error::new(Status::GenericFailure, e))?;
    let t_compute = t_start.elapsed() - t_load - t_collect;

    let summary = apply_segment_top_k_with_cap(&mut traces, top_k_per_kind);
    result.segments = std::mem::take(&mut traces.segments);
    result.segments_meta = Some(summary);

    // Stamp wrapper timings before serializing so the popup JSON carries
    // the full per-component breakdown for the frontend debug overlay.
    if let Some(t) = result.timings.as_mut() {
        t.load_ms = t_load.as_secs_f64() * 1000.0;
        t.collect_ms = t_collect.as_secs_f64() * 1000.0;
    }
    let wire_result = wire::build_wire_result(result, lat, lng, elevation);
    let json = serde_json::to_string(&wire_result).unwrap();
    let t_total = t_start.elapsed();

    if timing_on {
        eprintln!(
            "popup-timing total={:.0}ms load={:.0}ms collect={:.0}ms compute={:.0}ms json={:.0}ms (rd={} rl={} ac={})",
            t_total.as_secs_f64() * 1000.0,
            t_load.as_secs_f64() * 1000.0,
            t_collect.as_secs_f64() * 1000.0,
            t_compute.as_secs_f64() * 1000.0,
            (t_total - t_load - t_collect - t_compute).as_secs_f64() * 1000.0,
            n_roads,
            n_railways,
            n_aircraft,
        );
    }

    Ok(json)
}

#[cfg(feature = "node")]
const SEGMENT_TOP_K_PER_KIND: usize = 150;

/// Upper bound for the "Show all" response. Higher than the default cap but
/// still bounded — NAPI's string return cannot carry the full airport payload
/// (millions of segments) and browsers can't parse it either.
#[cfg(feature = "node")]
const SEGMENT_TOP_K_PER_KIND_FULL: usize = 1000;

/// Stub raster sampler — flat terrain, no buildings, no vegetation.
/// Used as fallback when DEM/raster tiles are not available on disk.
#[cfg(feature = "node")]
struct StubRasters;

#[cfg(feature = "node")]
use noise_compute::types::RasterSampler;

#[cfg(feature = "node")]
impl RasterSampler for StubRasters {
    fn elevation(&self, _lat: f64, _lon: f64) -> f64 {
        200.0
    }
    fn building_height(&self, _: f64, _: f64) -> f64 {
        0.0
    }
    fn ground_g(&self, _: f64, _: f64) -> f64 {
        0.5
    }
    fn building_enclosure(&self, _: f64, _: f64) -> f64 {
        0.0
    }
}
