//! Compute orchestrators that consume row views from upstream readers.
//!
//! Sub-modules are organized per source kind. v6 is the popup contract
//! that reads aircraft popup arrows directly via typed column views,
//! avoiding the `AircraftSegment` synthesis that lived in source-reader
//! before C3.

pub mod aircraft_v6;
