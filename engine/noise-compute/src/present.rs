//! Popup presentation helpers — display filtering and top-N selection.

use crate::types::Contributor;

pub fn is_displayable(contributor: &Contributor) -> bool {
    contributor.periods.lden_db >= 0.0
}

pub fn display_count(contributors: &[Contributor]) -> usize {
    contributors.iter().filter(|c| is_displayable(c)).count()
}

pub fn finalize_popup_contributors(
    mut contributors: Vec<Contributor>,
    top_n: usize,
) -> Vec<Contributor> {
    contributors.retain(is_displayable);
    contributors.sort_by(|a, b| {
        b.periods
            .lden_db
            .partial_cmp(&a.periods.lden_db)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    contributors.truncate(top_n);
    contributors
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
            received_bands: [0.0; crate::types::NUM_BANDS],
            geometry: None,
            metadata: None,
        }
    }

    #[test]
    fn sorts_by_lden_drops_negative_and_truncates() {
        let shown = finalize_popup_contributors(
            vec![
                contributor(SourceKind::Road, 11.0),
                contributor(SourceKind::Road, 12.0),
                contributor(SourceKind::Railway, 10.0),
                contributor(SourceKind::Industrial, 9.0),
                contributor(SourceKind::Building, -1.0),
            ],
            2,
        );
        assert_eq!(shown.len(), 2);
        assert_eq!(shown[0].periods.lden_db, 12.0);
        assert_eq!(shown[1].periods.lden_db, 11.0);
    }
}
