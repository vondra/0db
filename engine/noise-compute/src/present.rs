//! Popup presentation helpers — display filtering and top-N selection.

use std::collections::HashSet;

use crate::types::Contributor;

pub fn is_displayable(contributor: &Contributor) -> bool {
    contributor.periods.lden_db >= 0.0
}

pub fn display_count(contributors: &[Contributor]) -> usize {
    contributors.iter().filter(|c| is_displayable(c)).count()
}

pub fn finalize_popup_contributors(mut contributors: Vec<Contributor>, top_n: usize) -> Vec<Contributor> {
    contributors.retain(is_displayable);
    contributors.sort_by(|a, b| {
        b.periods
            .lden_db
            .partial_cmp(&a.periods.lden_db)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut seen_types = HashSet::new();
    let mut guaranteed = Vec::new();
    for contributor in &contributors {
        if seen_types.insert(contributor.source_type.clone()) {
            guaranteed.push(contributor.clone());
        }
    }

    contributors.truncate(top_n);
    for contributor in guaranteed {
        if !contributors.iter().any(|existing| existing.source_type == contributor.source_type) {
            contributors.push(contributor);
        }
    }
    contributors
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        Contributor, NoisePeriods, PropagationBaseline, ScreeningBreakdown, TerrainBreakdown,
        VegetationBreakdown,
    };

    fn contributor(source_type: &str, lden_db: f64) -> Contributor {
        Contributor {
            source_type: source_type.to_string(),
            osm_id: None,
            name: String::new(),
            subtype: String::new(),
            distance_m: 0.0,
            periods: NoisePeriods { ld_db: lden_db, le_db: lden_db, ln_db: lden_db, lden_db },
            periods_free: NoisePeriods { ld_db: lden_db, le_db: lden_db, ln_db: lden_db, lden_db },
            emission_db: 0.0,
            baseline: PropagationBaseline::default(),
            terrain: TerrainBreakdown::default(),
            screening: ScreeningBreakdown::default(),
            vegetation: VegetationBreakdown::default(),
            received_bands: [0.0; crate::types::NUM_BANDS],
            geometry: None,
            metadata: None,
        }
    }

    #[test]
    fn filters_negative_contributors_but_keeps_one_per_type_after_top_n() {
        let shown = finalize_popup_contributors(
            vec![
                contributor("road", 12.0),
                contributor("road", 11.0),
                contributor("railway", 10.0),
                contributor("industrial", 9.0),
                contributor("building", -1.0),
            ],
            2,
        );
        assert_eq!(shown.len(), 4);
        assert!(shown.iter().all(|c| c.periods.lden_db >= 0.0));
        assert!(shown.iter().any(|c| c.source_type == "road"));
        assert!(shown.iter().any(|c| c.source_type == "railway"));
        assert!(shown.iter().any(|c| c.source_type == "industrial"));
    }
}
