//! Single-edge δ diffraction kernel — the shared core for surface-source
//! terrain/screening, replacing the multi-edge upper-convex-hull selection with
//! the CNOSSOS "edge of largest path-length difference δ".
//!
//! Same `max(A_ground, A_terrain + A_screen)` contract as the old multi-edge
//! path, but each of the two attenuation terms is a SINGLE deterministic δ-edge:
//!   A_terrain  = diffraction over the max-δ edge of the BARE-EARTH profile
//!   A_combined = diffraction over the max-δ edge of the COMPOSITE profile
//!   A_screen   = (A_combined − A_terrain).max(0)        ← INCREMENT, never a sum
//! so `terrain + screen ≡ A_combined`, byte-compatible with the caller
//! arithmetic (`a_bar = terrain + screen; max(a_gr, a_bar)`). Summing two
//! independent Maekawa terms would double-count (Maekawa is non-linear).
//!
//! δ ∝ 1/(L−x) toward each endpoint, so the single max-δ edge is the
//! near-endpoint barrier that the hull's LOS-excess ranking systematically
//! under-weighted (excess favours near-source obstacles, where the LOS sits low).

use super::diffraction::{compute_single_edge, diffraction_attenuation_rayleigh};
use crate::types::NUM_BANDS;

/// Per-band terrain (bare-earth δ\*) + screening (composite-edge increment) for
/// one source→receiver path. The caller sums `terrain + screen` into `a_bar`,
/// then `max(a_gr, a_bar)` (ISO 9613-2 §7.3.1 — barrier REPLACES ground).
#[derive(Clone, Copy, Debug)]
pub struct EdgeDiffraction {
    pub terrain: [f64; NUM_BANDS],
    pub screen: [f64; NUM_BANDS],
    /// Composite δ-edge distance from the receiver (m); -1.0 if none. Trace only.
    pub edge_to_rcv_m: f64,
    /// Composite δ-edge height above its own ground (m); 0.0 if none. Trace only.
    pub edge_height_m: f64,
}

impl EdgeDiffraction {
    pub const ZERO: EdgeDiffraction = EdgeDiffraction {
        terrain: [0.0; NUM_BANDS],
        screen: [0.0; NUM_BANDS],
        edge_to_rcv_m: -1.0,
        edge_height_m: 0.0,
    };
}

/// Index of the obstacle with the largest CNOSSOS path-length difference
/// δ = d_S→O + d_O→R − d_S→R over `1..n-1`, among samples above the
/// source→receiver line of sight. `None` if the path is clear. The geometry
/// matches [`compute_single_edge`] so the selected δ equals the diffracted δ.
fn max_delta_idx(
    t: &[f64],
    profile: &[f64],
    total_dist: f64,
    src_elev: f64,
    rcv_elev: f64,
    dsr: f64,
) -> Option<usize> {
    let n = profile.len();
    let mut best: Option<usize> = None;
    let mut best_delta = 0.0_f64;
    for i in 1..n - 1 {
        let top = profile[i];
        let los = src_elev + (rcv_elev - src_elev) * t[i];
        if top <= los {
            continue;
        }
        let d_sg = t[i] * total_dist;
        let d_rg = (1.0 - t[i]) * total_dist;
        let d_sb = (d_sg * d_sg + (top - src_elev).powi(2)).sqrt();
        let d_br = (d_rg * d_rg + (top - rcv_elev).powi(2)).sqrt();
        let delta = d_sb + d_br - dsr;
        if delta > best_delta {
            best_delta = delta;
            best = Some(i);
        }
    }
    best
}

/// The shared single-edge δ kernel. `bare` = bare-earth ground elevations,
/// `composite` = ground+building, both absolute metres at fractional path
/// positions `t∈[0,1]`; `total_dist` ground metres; `src_height`/`rcv_height`
/// above local ground. Paths under 30 m carry no diffraction (raster-resolution
/// floor — matches the old `compute_path_difference` guard).
pub fn solve_single_edge(
    t: &[f64],
    bare: &[f64],
    composite: &[f64],
    total_dist: f64,
    src_height: f64,
    rcv_height: f64,
) -> EdgeDiffraction {
    let n = bare.len();
    if n < 3 || total_dist < 30.0 {
        return EdgeDiffraction::ZERO;
    }
    let src_elev = bare[0] + src_height;
    let rcv_elev = bare[n - 1] + rcv_height;
    let dsr = (total_dist * total_dist + (rcv_elev - src_elev).powi(2)).sqrt();

    // A_terrain: diffraction over the max-δ bare-earth edge.
    let terrain = match max_delta_idx(t, bare, total_dist, src_elev, rcv_elev, dsr) {
        Some(idx) => {
            let r = compute_single_edge(
                t, bare, bare, total_dist, idx, src_elev, rcv_elev, dsr, src_height, rcv_height,
            );
            diffraction_attenuation_rayleigh(&r)
        }
        None => [0.0; NUM_BANDS],
    };

    // A_combined: diffraction over the max-δ composite edge (δ\* still over bare).
    let (combined, edge_to_rcv_m, edge_height_m) =
        match max_delta_idx(t, composite, total_dist, src_elev, rcv_elev, dsr) {
            Some(idx) => {
                let r = compute_single_edge(
                    t, composite, bare, total_dist, idx, src_elev, rcv_elev, dsr, src_height,
                    rcv_height,
                );
                let bands = diffraction_attenuation_rayleigh(&r);
                (bands, (1.0 - t[idx]) * total_dist, composite[idx] - bare[idx])
            }
            None => ([0.0; NUM_BANDS], -1.0, 0.0),
        };

    // A_screen = the INCREMENT over terrain, so `terrain + screen ≡ A_combined`.
    let mut screen = [0.0; NUM_BANDS];
    for i in 0..NUM_BANDS {
        screen[i] = (combined[i] - terrain[i]).max(0.0);
    }
    EdgeDiffraction { terrain, screen, edge_to_rcv_m, edge_height_m }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uniform_t(n: usize) -> Vec<f64> {
        (0..n).map(|i| i as f64 / (n - 1) as f64).collect()
    }

    /// (a) Clear path → no terrain, no screening.
    #[test]
    fn flat_path_is_silent() {
        let t = uniform_t(11);
        let bare = vec![100.0; 11];
        let d = solve_single_edge(&t, &bare, &bare, 500.0, 0.05, 4.0);
        assert_eq!(d.terrain, [0.0; NUM_BANDS]);
        assert_eq!(d.screen, [0.0; NUM_BANDS]);
        assert_eq!(d.edge_to_rcv_m, -1.0);
    }

    /// (b) A bare hill with NO building: terrain attenuates, screening is exactly
    /// zero (composite == bare → A_combined == A_terrain → increment 0).
    #[test]
    fn bare_hill_has_no_screening_increment() {
        let t = uniform_t(11);
        let mut bare = vec![100.0; 11];
        bare[5] = 112.0;
        let d = solve_single_edge(&t, &bare, &bare, 500.0, 0.05, 4.0);
        assert!(d.terrain.iter().any(|&a| a > 0.0), "hill must attenuate");
        assert_eq!(d.screen, [0.0; NUM_BANDS], "no building → zero screening");
    }

    /// (c) A building on flat ground: zero terrain, screening == the full
    /// composite attenuation (terrain is zero so the increment is the whole thing).
    #[test]
    fn building_on_flat_is_pure_screening() {
        let t = uniform_t(11);
        let bare = vec![100.0; 11];
        let mut composite = bare.clone();
        composite[5] = 106.0; // 6 m building
        let d = solve_single_edge(&t, &bare, &composite, 500.0, 0.05, 4.0);
        assert_eq!(d.terrain, [0.0; NUM_BANDS], "flat ground → zero terrain");
        assert!(d.screen.iter().any(|&a| a > 0.0), "building must screen");
        assert!(d.edge_height_m > 5.9 && d.edge_height_m < 6.1);
        assert!((d.edge_to_rcv_m - 250.0).abs() < 1.0, "edge at mid-path");
    }

    /// (d) THE fix: δ-selection favours the near-RECEIVER barrier over a mid-path
    /// one of equal height (δ ∝ 1/(L−x) is minimised mid-path). LOS-excess — the
    /// old hull ranking — would tie or prefer the mid edge.
    #[test]
    fn delta_picks_near_endpoint_over_midpath() {
        let t = uniform_t(11);
        let bare = vec![100.0; 11];
        let mut composite = bare.clone();
        composite[5] = 108.0; // mid-path, 8 m
        composite[9] = 108.0; // near receiver (t=0.9), same 8 m
        // Symmetric heights (src≈rcv height) so the only discriminator is δ.
        let d = solve_single_edge(&t, &bare, &composite, 500.0, 2.0, 2.0);
        assert!(
            (d.edge_to_rcv_m - 50.0).abs() < 1.0,
            "near-receiver edge (50 m) must win on δ, got {:.1} m",
            d.edge_to_rcv_m
        );
    }

    /// (e) NO DOUBLE-COUNT: for a barrier on a hill, `terrain + screen` must equal
    /// the combined composite attenuation, NOT the sum of two Maekawa terms.
    #[test]
    fn barrier_on_hill_does_not_double_count() {
        let t = uniform_t(11);
        let mut bare = vec![100.0; 11];
        bare[5] = 110.0; // 10 m hill
        let mut composite = bare.clone();
        composite[5] = 116.0; // hill + 6 m building
        let d = solve_single_edge(&t, &bare, &composite, 500.0, 0.05, 4.0);
        assert!(d.terrain.iter().any(|&a| a > 0.0), "hill attenuates");
        assert!(d.screen.iter().any(|&a| a > 0.0), "building adds screening");

        // Independently compute A_combined over the composite δ-edge (idx 5, the
        // only obstacle). `terrain + screen` must reconstruct it EXACTLY — proving
        // screen is the increment, not a second Maekawa term added on top.
        let src_elev = bare[0] + 0.05;
        let rcv_elev = bare[10] + 4.0;
        let dsr = (500.0 * 500.0 + (rcv_elev - src_elev).powi(2)).sqrt();
        let r = compute_single_edge(&t, &composite, &bare, 500.0, 5, src_elev, rcv_elev, dsr, 0.05, 4.0);
        let combined = diffraction_attenuation_rayleigh(&r);
        for i in 0..NUM_BANDS {
            assert!(
                (d.terrain[i] + d.screen[i] - combined[i]).abs() < 1e-9,
                "band {i}: terrain+screen {:.4} ≠ A_combined {:.4} (double-count!)",
                d.terrain[i] + d.screen[i],
                combined[i]
            );
        }
    }
}
