//! Optional bounding box that restricts which R4 hexes Stage 2A/2B/2C
//! are allowed to write into. Required when extracting from a
//! bbox/radius-clipped ADS-B cache: those caches keep whole daily
//! traces for any flight that crossed the filter, so a Canary subset
//! still carries the full transatlantic / European trajectories of
//! those flights — without this scope filter the per-stage writers
//! would overwrite R4 files in regions completely outside the cache
//! intent.
//!
//! Filtering happens at the R4-bucket step: each stage tests the R4
//! cell's centroid against `[min_lat..=max_lat] × [min_lon..=max_lon]`,
//! expanded by [`SCOPE_BUFFER_M`] (≈ 50 km) to keep border cells whose
//! body sits half inside the configured bbox.

use h3o::{CellIndex, LatLng};

/// 50 km border keep-radius. Slightly larger than an R4 cell's
/// ~22 km circumradius so a cell straddling the bbox edge isn't
/// dropped just because its centroid happens to sit on the wrong
/// side.
pub const SCOPE_BUFFER_M: f64 = 50_000.0;

/// Lat/lon bounding rectangle. Inclusive on all sides.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScopeBbox {
    pub min_lat: f64,
    pub min_lon: f64,
    pub max_lat: f64,
    pub max_lon: f64,
}

impl ScopeBbox {
    /// Parse `"min_lat,min_lon,max_lat,max_lon"` (matches the format
    /// `adsb-subset-cache --bbox` accepts).
    pub fn parse(s: &str) -> Result<Self, String> {
        let parts: Vec<&str> = s.split(',').collect();
        if parts.len() != 4 {
            return Err(format!(
                "expected min_lat,min_lon,max_lat,max_lon, got {parts:?}"
            ));
        }
        let parse_f = |i: usize, name: &str| -> Result<f64, String> {
            parts[i]
                .trim()
                .parse::<f64>()
                .map_err(|e| format!("bad {name}: {e}"))
        };
        let min_lat = parse_f(0, "min_lat")?;
        let min_lon = parse_f(1, "min_lon")?;
        let max_lat = parse_f(2, "max_lat")?;
        let max_lon = parse_f(3, "max_lon")?;
        if min_lat > max_lat || min_lon > max_lon {
            return Err(format!(
                "bbox is empty: min_lat={min_lat} > max_lat={max_lat} \
                 or min_lon={min_lon} > max_lon={max_lon}"
            ));
        }
        Ok(Self {
            min_lat,
            min_lon,
            max_lat,
            max_lon,
        })
    }

    /// Test whether an H3 R4 cell's centroid sits inside this bbox
    /// expanded by [`SCOPE_BUFFER_M`].
    pub fn contains_r4(&self, r4_hex: u64) -> bool {
        let Ok(cell) = CellIndex::try_from(r4_hex) else {
            return false;
        };
        let ll: LatLng = cell.into();
        // Latitude buffer is constant; longitude buffer scales with
        // cos(lat) to stay ~50 km on the ground regardless of where
        // the cell sits on the globe.
        let lat_buf = SCOPE_BUFFER_M / 111_320.0;
        let cos_lat = ll.lat().to_radians().cos().max(0.05);
        let lon_buf = SCOPE_BUFFER_M / (111_320.0 * cos_lat);
        ll.lat() >= self.min_lat - lat_buf
            && ll.lat() <= self.max_lat + lat_buf
            && ll.lng() >= self.min_lon - lon_buf
            && ll.lng() <= self.max_lon + lon_buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use h3o::Resolution;

    #[test]
    fn parse_accepts_canary_bbox() {
        let s = "27.0,-18.5,29.5,-13.0";
        let b = ScopeBbox::parse(s).unwrap();
        assert_eq!(b.min_lat, 27.0);
        assert_eq!(b.min_lon, -18.5);
        assert_eq!(b.max_lat, 29.5);
        assert_eq!(b.max_lon, -13.0);
    }

    #[test]
    fn parse_rejects_inverted_or_short() {
        assert!(ScopeBbox::parse("27,18,29").is_err());
        assert!(ScopeBbox::parse("30,18,27,20").is_err());
        assert!(ScopeBbox::parse("not,a,bbox,here").is_err());
    }

    fn cell(lat: f64, lon: f64) -> u64 {
        u64::from(LatLng::new(lat, lon).unwrap().to_cell(Resolution::Four))
    }

    #[test]
    fn canary_bbox_includes_gran_canaria_cell_excludes_praha() {
        let canary = ScopeBbox::parse("27.0,-18.5,29.5,-13.0").unwrap();
        assert!(canary.contains_r4(cell(27.93, -15.39)), "GCLP");
        assert!(canary.contains_r4(cell(28.04, -16.57)), "TFS");
        assert!(!canary.contains_r4(cell(50.11, 14.26)), "LKPR");
        assert!(!canary.contains_r4(cell(0.0, 0.0)), "ocean off Africa");
    }

    #[test]
    fn buffer_keeps_border_cells() {
        // ~30 km north of the bbox top edge — within the 50 km buffer.
        let canary = ScopeBbox::parse("27.0,-18.5,29.5,-13.0").unwrap();
        assert!(canary.contains_r4(cell(29.77, -15.4)), "30 km north");
    }
}
