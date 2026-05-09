//! Aircraft pipeline v6 — popup-first extraction.
//!
//! Five stages, each producing stable Arrow artifacts. Stage 0 ingests
//! adsb.lol TAR archives into per-day flight records. Stage 1 attaches
//! DEM AGL, classifies phase (Ground/Airborne/Cruise), and applies
//! receiver-independent filters with trajectory-aware truncation.
//! Stages 2A/2B/2C aggregate per-R4: airborne sub-segments, cruise R8
//! buckets, and ground operations on OSM aeroways. The popup loads three
//! independent Arrow files per R4 × 7 R4 (centre + ring1) and runs the
//! same propagation kernels as the existing road / rail compute paths.
//!
//! Each schema sets `schema_version = "v9"` in its Arrow metadata so
//! the reader can refuse stale inputs at load time.

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
pub mod segment;
pub mod source;
pub mod source_adsb_tar;
pub mod stage_0;
pub mod stage_1;
pub mod stage_2a;
pub mod stage_2b;
pub mod stage_2c;
pub mod trace;

/// Schema-version tag stamped into every Arrow file produced by this
/// crate. v10 rewrites `ground.arrow`: 1 row = 1 aircraft × 1 contiguous
/// ground path (vertices + per-leg ops_kind + count_weight + em_bands).
/// Replaces the v9 `(osm_id × ops_kind × sub_bucket_idx)` snap-and-bucket
/// schema entirely — the OSM aeroway snap chain (line / area / aerodrome
/// proximity / R10 fallback) and the S2 synth fill are gone; ground
/// geometry is raw ADS-B trajectories with the nearest aerodrome from
/// `airport_areas.arrow` providing identity. v9 added `profile_mix`
/// (List<Struct>) for the popup top-3 typecode display; v8 added
/// `observed_flight_ids` (List<UInt64>) for M4 dedup; v7 introduced
/// per-rotation flight_id + callsign / aircraft_type columns.
pub const SCHEMA_VERSION: &str = "v10";
