//! `buildings.arrow` writer (settlement v2 phase 2): one row per building
//! footprint with the POI-footprint join applied and area pre-computed from WKB.
//! Stamps the `buildings_v2` per-file contract. See `finalize_bucket` dispatch.

use anyhow::Result;
use arrow::array::*;
use arrow::datatypes::*;
use arrow::ipc::writer::FileWriter;
use arrow::record_batch::RecordBatch;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;

use super::{schema_with_contract, BUILDINGS_CONTRACT_V2};
use crate::poi_join::{joined_building_type, JoinStats, PoiIndex};
use crate::spill::hex_decode;

/// A footprint larger than any real restaurant / bar — above this an
/// `amenity=restaurant/bar` is a tenant of a big structure, not the structure.
/// Tuned by eye: a huge restaurant / food court tops out ~3000 m²; terminals,
/// breweries and stadiums sit far above.
const MAX_RESTAURANT_FOOTPRINT_M2: f64 = 4000.0;

/// Downgrade an oversized `amenity`-derived restaurant to commercial. Restaurants
/// (HOSPITALITY) on a 10⁴–10⁵ m² footprint are airport terminals / breweries /
/// stadium concourses where the bar is one tenant; the footprint area-law would
/// otherwise stamp the whole envelope at ~90–100 dB. FOOD_RETAIL is exempt —
/// hypermarkets legitimately reach 5–15 k m².
fn downgrade_oversized_restaurant(bt: u8, area_m2: Option<f64>) -> u8 {
    use noise_compute::emission::settlement as st;
    if bt == st::HOSPITALITY && area_m2.is_some_and(|a| a > MAX_RESTAURANT_FOOTPRINT_M2) {
        return 1; // commercial — generic HVAC envelope
    }
    bt
}

pub(super) fn write_buildings(
    rows: &[Vec<String>],
    path: &Path,
    hex: u64,
    poi_index: &PoiIndex,
    join_stats: &JoinStats,
) -> Result<()> {
    let n = rows.len();
    let schema = schema_with_contract(
        vec![
            Field::new("osm_id", DataType::Int64, false),
            Field::new("centroid_lat", DataType::Float64, false),
            Field::new("centroid_lon", DataType::Float64, false),
            Field::new("building_type", DataType::UInt8, false),
            Field::new("building_use", DataType::UInt8, false),
            Field::new("height", DataType::Float32, true),
            Field::new("floors", DataType::UInt8, false),
            Field::new("name", DataType::Utf8, true),
            Field::new("addr_street", DataType::Utf8, true),
            Field::new("addr_housenumber", DataType::Utf8, true),
            Field::new("polygon_wkb", DataType::Binary, true),
            // area_m2: pre-computed from WKB polygon with cos(lat) Shoelace.
            // WHY: Runtime WKB decode is slow; pre-compute once at extract time.
            Field::new("area_m2", DataType::Float32, true),
            // Dataset provenance — 0 = unspecified, populated by enrich-buildings-*.ts.
            Field::new("source_id", DataType::UInt16, false),
            // settlement v2 phase 2: opening_hours day-fraction
            // (0=unknown,1=24/7,2=day,3=evening/night). See
            // classify::opening_hours_fraction.
            Field::new("opening_hours_frac", DataType::UInt8, false),
        ],
        "buildings_contract",
        BUILDINGS_CONTRACT_V2,
    );

    let mut osm_id = Int64Builder::with_capacity(n);
    let mut clat = Float64Builder::with_capacity(n);
    let mut clon = Float64Builder::with_capacity(n);
    let mut btype = UInt8Builder::with_capacity(n);
    let mut buse = UInt8Builder::with_capacity(n);
    let mut height = Float32Builder::with_capacity(n);
    let mut floors = UInt8Builder::with_capacity(n);
    let mut name = StringBuilder::with_capacity(n, n * 8);
    let mut street = StringBuilder::with_capacity(n, n * 12);
    let mut housenumber = StringBuilder::with_capacity(n, n * 4);
    let mut area_m2 = Float32Builder::with_capacity(n);
    let mut source_id = UInt16Builder::with_capacity(n);
    let mut wkb = BinaryBuilder::with_capacity(n, n * 100);
    let mut opening = UInt8Builder::with_capacity(n);

    // Centroids of the REAL buildings in this hex (those with a `building` tag,
    // area_source=0). A functional-AREA source (mall / hospital / school / zone,
    // area_source=1) that geometrically contains one of these is suppressed below:
    // the inner buildings already represent that footprint (anti-double-count).
    // A clean area with no buildings inside survives as the only source.
    let real_centroids: Vec<(f64, f64)> = rows
        .iter()
        .filter(|r| r.len() >= 14 && r[12].as_str() == "0")
        .filter_map(|r| Some((r[2].parse().ok()?, r[3].parse().ok()?)))
        .collect();

    for row in rows {
        // TSV: hex_id(0) osm_id(1) clat(2) clon(3) btype(4) buse(5) height(6) floors(7)
        //      name(8) street(9) housenumber(10) opening_hours(11) area_source(12) wkb_hex(13)
        // Require the full v2 layout (14 fields incl. the always-present trailing
        // WKB) so a stale spill row can't be misparsed (Codex finalize-only note).
        if row.len() < 14 {
            continue;
        }
        let wkb_hex = row.get(13).map(|s| s.as_str()).unwrap_or("");
        // Overlap suppression: a functional-area source wrapping real buildings.
        if row[12].as_str() == "1" && !wkb_hex.is_empty() {
            if let Some(fp) = noise_compute::wkb::WkbFootprint::parse(wkb_hex) {
                if real_centroids.iter().any(|&(la, lo)| fp.contains(la, lo)) {
                    continue;
                }
            }
        }
        let area_opt = (!wkb_hex.is_empty())
            .then(|| noise_compute::wkb::wkb_area_m2(wkb_hex))
            .flatten();
        // POI footprint join (settlement v2 phase 2): reclassify `building=yes`
        // when a function POI sits inside it.
        let bt = joined_building_type(
            row[4].parse().unwrap_or(0),
            wkb_hex,
            hex,
            poi_index,
            join_stats,
        );
        // Catches the `building=yes` + `amenity=restaurant` case (specific
        // structural tags already won in `building_type_from_tags`); rationale on
        // the fn.
        let bt = downgrade_oversized_restaurant(bt, area_opt);
        osm_id.append_value(row[1].parse().unwrap_or(0));
        clat.append_value(row[2].parse().unwrap_or(0.0));
        clon.append_value(row[3].parse().unwrap_or(0.0));
        btype.append_value(bt);
        buse.append_value(row[5].parse().unwrap_or(0));
        let h: f32 = row[6].parse().unwrap_or(0.0);
        if h > 0.0 {
            height.append_value(h);
        } else {
            height.append_null();
        }
        floors.append_value(row[7].parse().unwrap_or(0));
        name.append_value(row.get(8).unwrap_or(&String::new()));
        street.append_value(row.get(9).unwrap_or(&String::new()));
        housenumber.append_value(row.get(10).unwrap_or(&String::new()));
        opening.append_value(row[11].parse().unwrap_or(0));
        match (!wkb_hex.is_empty()).then(|| hex_decode(wkb_hex)).flatten() {
            Some(bytes) => {
                match area_opt {
                    Some(a) => area_m2.append_value(a as f32),
                    None => area_m2.append_null(),
                }
                wkb.append_value(&bytes);
            }
            None => {
                wkb.append_null();
                area_m2.append_null();
            }
        }
        source_id.append_value(0);
    }

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(osm_id.finish()),
            Arc::new(clat.finish()),
            Arc::new(clon.finish()),
            Arc::new(btype.finish()),
            Arc::new(buse.finish()),
            Arc::new(height.finish()),
            Arc::new(floors.finish()),
            Arc::new(name.finish()),
            Arc::new(street.finish()),
            Arc::new(housenumber.finish()),
            Arc::new(wkb.finish()),
            Arc::new(area_m2.finish()),
            Arc::new(source_id.finish()),
            Arc::new(opening.finish()),
        ],
    )?;

    let file = File::create(path)?;
    let mut writer = FileWriter::try_new(file, &batch.schema())?;
    writer.write(&batch)?;
    writer.finish()?;
    Ok(())
}
