//! Compute orchestrators that consume row views from upstream readers.
//! `aircraft_v6` reads the popup aircraft arrows directly via typed
//! column views, avoiding any `AircraftSegment` synthesis at the popup
//! boundary.

pub mod aircraft_v6;
pub(crate) mod point_sources;
pub(crate) mod railways;
pub(crate) mod roads;
