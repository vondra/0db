//! `FlightSource` trait — abstracts over the various ways flight data
//! arrives in the pipeline. The plan reserves three sources:
//!
//!   * `AdsbTarSource` — adsb.lol cached TAR archives (today's only driver).
//!   * Schedule synth — placeholder for OAG / FlightRadar24 modelled
//!     flights (Stage 0 trait ready; no driver implementation now).
//!   * Live ADS-B feed — for future real-time popup.
//!
//! Every produced [`crate::flight::Flight`] carries a stable
//! `source_id` so [`crate::dedup`] can reconcile the same flight
//! arriving via two channels.

use anyhow::Result;
use std::path::Path;

use crate::flight::Flight;

/// One pluggable flight data source for Stage 0.
pub trait FlightSource {
    /// Stable identifier — see `flight::source_id::*`.
    fn source_id(&self) -> u8;

    /// Read every flight observable for one calendar day. The day is
    /// expressed as an absolute date string (`"YYYY-MM-DD"`); the
    /// driver translates that to its native layout.
    fn read_day(&self, day_str: &str) -> Result<Vec<Flight>>;

    /// Optional: where a driver caches data on disk. Used by
    /// orchestration to validate prerequisites before kicking off a
    /// long batch.
    fn cache_root(&self) -> Option<&Path> {
        None
    }
}
