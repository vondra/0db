//! Shared line-source row consumed by [`crate::scatter_line`], plus the two
//! Arrow helpers every surface loader uses. Road and rail are both single-row
//! line segments with the same propagation physics (ISO 9613-2 cylindrical
//! divergence + finite-line correction); they differ only in emission, source
//! height, and reach — all carried on the row — so one [`LineRow`] feeds the
//! one scatter kernel for both.

use arrow::record_batch::RecordBatch;
use noise_compute::types::NUM_BANDS;

/// One normalised line segment (road or rail): geometry + per-period linear
/// band emission. `emission_lin[period][band] = 10^(L_W'/m_dB / 10)`,
/// precomputed at load so the scatter hot loop multiplies by a shared
/// per-pixel path factor without a per-pixel `exp`.
pub struct LineRow {
    pub start_lat: f64,
    pub start_lon: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    pub length_m: f32,
    /// Propagation cutoff (m): road = `ROAD_MAX_RADIUS[class]`, rail = the
    /// segment's own 25 dB Lden crossing (`railway::rail_reach_m`, clamped
    /// [2 km, 10 km]) — per ROW, not a blanket constant.
    pub max_distance_m: f64,
    /// Source height above ground (m): road 0.05, rail 0.5.
    pub source_height_m: f64,
    /// Bridge segments propagate over hard ground (G = 0).
    pub bridge: bool,
    /// `[day, evening, night][band]` linear A-unweighted band energy.
    pub emission_lin: [[f32; NUM_BANDS]; 3],
}

/// `L_W'/m` dB band spectrum → linear band energy (`10^(dB/10)`).
#[inline]
pub(crate) fn db_bands_to_lin(db: [f32; NUM_BANDS]) -> [f32; NUM_BANDS] {
    db.map(|d| 10f32.powf(d * 0.1))
}

/// Optional typed column accessor — `None` if absent or wrong-typed,
/// mirroring the popup's lenient column reads. Callers check geometry
/// presence; every other column defaults when missing.
pub(crate) fn opt<'a, T: 'static>(b: &'a RecordBatch, n: &str) -> Option<&'a T> {
    b.column_by_name(n)
        .and_then(|c| c.as_any().downcast_ref::<T>())
}
