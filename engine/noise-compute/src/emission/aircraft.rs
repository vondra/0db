//! Doc 29 4th Edition aircraft noise emission.
//!
//! SEPARATE from ISO 9613-2. Doc 29 uses empirical NPD lookup, not
//! path-tracing. Aircraft noise does NOT use ground effect, diffraction,
//! vegetation, screening — NPD tables already include atmospheric effects.
//!
//! Master equation (Eq. 4-8b):
//!   SEL_seg = L_E(P, d_p) + ΔV + ΔI(φ) - Λ(β, l) + ΔF
//!
//! ## Module layout
//!
//! * [`npd`] — NPD profile metadata, alpha-eff back-out, NpdLuts cache,
//!   reach estimation, profiles_generated re-exports.
//! * [`doc29`] — CPA geometry, Δv/ΔF/ΔI/Λ corrections, shared
//!   `segment_energy_kernel`, period_leq.
//! * [`segment_filters`] — per-segment validity gates (airborne / ground
//!   stale / airport ground), `SegmentTerrain` cache, ground-ops kind /
//!   context constants.
//! * [`ground_ops`] — surface-model constants (per-kind reference
//!   speeds + spectrum shapes) shared by the `airport_traffic`
//!   emission kernel. The Phase-6-retired per-leg `ground.arrow`
//!   model lived here previously.
//! * [`segment_sel`] — single-shot per-segment SEL wrappers (popup +
//!   tests).

mod doc29;
mod ground_ops;
mod npd;
mod segment_filters;
mod segment_sel;

pub use doc29::*;
pub(crate) use ground_ops::*;
pub use npd::*;
pub use segment_filters::*;
pub use segment_sel::*;
