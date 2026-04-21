//! Popup presentation helpers — display filtering and top-N selection.

use crate::types::Contributor;

pub fn is_displayable(contributor: &Contributor) -> bool {
    contributor.periods.lden_db >= 0.0
}

pub fn display_count(contributors: &[Contributor]) -> usize {
    contributors.iter().filter(|c| is_displayable(c)).count()
}

/// Result of popup contributor finalization: the top-N displayable list,
/// plus the energy sum (dB) of everything else (dropped by threshold or
/// truncated past top_n). `other_lden_db` = NEG_INFINITY when there are
/// no leftovers to report.
pub struct FinalizedContributors {
    pub shown: Vec<Contributor>,
    pub other_lden_db: f64,
}

pub fn finalize_popup_contributors(
    mut contributors: Vec<Contributor>,
    top_n: usize,
) -> FinalizedContributors {
    contributors.sort_by(|a, b| {
        b.periods
            .lden_db
            .partial_cmp(&a.periods.lden_db)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut shown: Vec<Contributor> = Vec::with_capacity(top_n.min(contributors.len()));
    let mut other_energy = 0.0f64;
    for c in contributors {
        let keep = is_displayable(&c) && shown.len() < top_n;
        if keep {
            shown.push(c);
        } else {
            let lden = c.periods.lden_db;
            if lden.is_finite() {
                other_energy += 10f64.powf(lden / 10.0);
            }
        }
    }
    let other_lden_db = if other_energy > 0.0 {
        10.0 * other_energy.log10()
    } else {
        f64::NEG_INFINITY
    };
    FinalizedContributors {
        shown,
        other_lden_db,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        Contributor, NoisePeriods, PropagationBaseline, ScreeningBreakdown, SourceKind,
        TerrainBreakdown, VegetationBreakdown,
    };

    fn contributor(source_type: SourceKind, lden_db: f64) -> Contributor {
        Contributor {
            source_type,
            osm_id: None,
            name: String::new(),
            subtype: String::new(),
            distance_m: 0.0,
            periods: NoisePeriods {
                ld_db: lden_db,
                le_db: lden_db,
                ln_db: lden_db,
                lden_db,
            },
            periods_free: NoisePeriods {
                ld_db: lden_db,
                le_db: lden_db,
                ln_db: lden_db,
                lden_db,
            },
            emission_db: 0.0,
            baseline: PropagationBaseline::default(),
            terrain: TerrainBreakdown::default(),
            screening: ScreeningBreakdown::default(),
            vegetation: VegetationBreakdown::default(),
            terrain_impact_db: 0.0,
            screening_impact_db: 0.0,
            vegetation_impact_db: 0.0,
            atmospheric_impact_db: 0.0,
            ground_impact_db: 0.0,
            received_bands: [0.0; crate::types::NUM_BANDS],
            geometry: None,
            metadata: None,
        }
    }

    #[test]
    fn sorts_by_lden_drops_negative_and_truncates() {
        let r = finalize_popup_contributors(
            vec![
                contributor(SourceKind::Road, 11.0),
                contributor(SourceKind::Road, 12.0),
                contributor(SourceKind::Railway, 10.0),
                contributor(SourceKind::Industrial, 9.0),
                contributor(SourceKind::Building, -1.0),
            ],
            2,
        );
        // Top 2 are Road 12 and Road 11.
        assert_eq!(r.shown.len(), 2);
        assert_eq!(r.shown[0].periods.lden_db, 12.0);
        assert_eq!(r.shown[1].periods.lden_db, 11.0);
        // Other: Railway 10 + Industrial 9 (dropped by top_n) + Building -1 (below threshold).
        let expect = 10.0
            * (10f64.powf(10.0 / 10.0) + 10f64.powf(9.0 / 10.0) + 10f64.powf(-1.0 / 10.0))
                .log10();
        assert!((r.other_lden_db - expect).abs() < 1e-9);
    }

    #[test]
    fn other_lden_neg_inf_when_all_shown() {
        let r = finalize_popup_contributors(
            vec![
                contributor(SourceKind::Road, 10.0),
                contributor(SourceKind::Railway, 5.0),
            ],
            30,
        );
        assert_eq!(r.shown.len(), 2);
        assert_eq!(r.other_lden_db, f64::NEG_INFINITY);
    }

    #[test]
    fn other_lden_sums_only_below_threshold() {
        let r = finalize_popup_contributors(
            vec![
                contributor(SourceKind::Road, -5.0),
                contributor(SourceKind::Road, -10.0),
                contributor(SourceKind::Railway, -2.0),
            ],
            30,
        );
        // All three below threshold → none shown, all aggregated.
        assert_eq!(r.shown.len(), 0);
        let expect = 10.0
            * (10f64.powf(-5.0 / 10.0)
                + 10f64.powf(-10.0 / 10.0)
                + 10f64.powf(-2.0 / 10.0))
            .log10();
        assert!((r.other_lden_db - expect).abs() < 1e-9);
    }
}
