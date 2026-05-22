//! Aircraft pipeline — popup-first extraction.
//!
//! Five stages, each producing stable Arrow artifacts. Stage 0 ingests
//! adsb.lol TAR archives into per-day flight records. Stage 1 attaches
//! DEM AGL, classifies phase (Ground/Airborne/Cruise), and applies
//! receiver-independent filters with trajectory-aware truncation.
//! Stages 2A/2B/2C aggregate per-R4 to three popup Arrow files:
//! airborne sub-segments, cruise R8 buckets, and ground paths from raw
//! ADS-B trajectories. Every schema stamps `schema_version =
//! SCHEMA_VERSION` so the popup reader can refuse stale inputs.

pub mod airport_io;
pub mod arrow_io;
pub mod arrow_schemas;
pub mod classify;
pub mod dedup;
pub mod filters;
pub mod flight;
pub mod geo;
pub mod ground_inference;
pub mod period;
pub mod profile;
pub mod progress;
pub mod scope;
pub mod segment;
pub mod shuffle;
pub mod source;
pub mod source_adsb_tar;
pub mod stage_0;
pub mod stage_1;
pub mod stage_2a;
pub mod stage_2b;
pub mod stage_2c;
pub mod stage_airport_discover;
pub mod stage_airport_discover_runner;
pub mod synth_airport_io;
pub mod trace;
pub mod wipe;

/// Schema-version tag stamped into every Arrow file produced by this
/// crate. Reader-side `assert_schema_version` rejects mismatches so
/// callers must re-extract when bumped. v14 replaced the per-fid
/// `cruise_flight_ids` / `cruise_aircraft_types` / `cruise_callsigns`
/// lists with a bounded top-K `top_candidates` struct list + scalar
/// `unique_count`. v15 (Opt A, 2026-05) adds pre-sampled terrain
/// elevations to airborne sub-segments (`terrain_start_elev_m`,
/// `terrain_mid_elev_m`, `terrain_end_elev_m`) plus Stage 1
/// per-segment `start_elev_m` / `end_elev_m` so the popup can drop
/// ~1 M raster lookups per LKPR popup. Column layout is incompatible
/// with v14 — readers MUST reject v14 instead of silently mis-decoding
/// (terrain checks would read zeros and falsely keep "below-ground"
/// segments). Within-v15 evolutions of `airport_traffic.arrow` semantics
/// (e.g. v5→v6 raw-Σ convention) are gated by the orthogonal
/// `airport_traffic_contract` metadata, leaving upstream arrows
/// (airborne, cruise, segments) re-extract-free.
pub const SCHEMA_VERSION: &str = "v15";
