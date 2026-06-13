//! Spill bucket writer.
//!
//! Features are hashed by hex_id % num_buckets and appended to intermediate files.
//! Each bucket is a simple binary format: sequences of records grouped by feature type.
//! We use CSV for simplicity during development — Arrow IPC in finalize step.

use crate::classify::{self, FeatureType, Tags};
use crate::microsegment;
use anyhow::Result;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

/// Per-feature-type, per-bucket writer.
struct BucketFile {
    writer: BufWriter<File>,
}

pub struct Spiller {
    dir: PathBuf,
    num_buckets: usize,
    /// (feature_type_name, bucket_idx) → writer
    writers: HashMap<(String, usize), BucketFile>,
}

impl Spiller {
    pub fn new(dir: &Path, num_buckets: usize) -> Result<Self> {
        fs::create_dir_all(dir)?;
        Ok(Spiller {
            dir: dir.to_path_buf(),
            num_buckets,
            writers: HashMap::new(),
        })
    }

    fn get_writer(&mut self, ftype: &str, bucket: usize) -> &mut BucketFile {
        let key = (ftype.to_string(), bucket);
        self.writers.entry(key).or_insert_with(|| {
            let path = self.dir.join(format!("{}_{:03}.tsv", ftype, bucket));
            let file = File::create(&path).expect("cannot create spill file");
            BucketFile {
                writer: BufWriter::with_capacity(1 << 20, file),
            }
        })
    }

    /// Emit a linear segment (road, railway, barrier).
    pub fn emit_segment(
        &mut self,
        ftype: &FeatureType,
        hex_id: u64,
        osm_id: i64,
        seg_idx: i16,
        seg: &([f64; 2], [f64; 2], f32),
        tags: &Tags,
    ) {
        // H3 res-4 IDs have lower 28 bits = 0xFFFFFFF → shift right before modulo
        let bucket = ((hex_id >> 28) as usize) % self.num_buckets;
        let name = ftype.name();

        // TSV: hex_id, osm_id, seg_idx, start_lat, start_lon, end_lat, end_lon, length_m, tags...
        let w = &mut self.get_writer(name, bucket).writer;
        let _ = write!(
            w,
            "{}\t{}\t{}\t{:.7}\t{:.7}\t{:.7}\t{:.7}\t{:.1}",
            hex_id, osm_id, seg_idx, seg.0[0], seg.0[1], seg.1[0], seg.1[1], seg.2
        );

        // Append feature-specific tags as key=value pairs
        match ftype {
            FeatureType::Road => {
                let highway = tags.get("highway").map(|s| s.as_str()).unwrap_or("");
                // highway=track is physically unpaved by OSM convention — default
                // the surface when unspecified. +3 dB rolling correction is material
                // (see SURFACE_CORR in noise-compute/constants.rs).
                let surface = tags
                    .get("surface")
                    .map(|s| s.as_str())
                    .or_else(|| (highway == "track").then_some("unpaved"));
                let bridge = matches!(
                    tags.get("bridge").map(|s| s.as_str()),
                    Some("yes" | "viaduct" | "cantilever" | "movable")
                );
                let tunnel = matches!(
                    tags.get("tunnel").map(|s| s.as_str()),
                    Some("yes" | "building_passage" | "culvert")
                );
                let toll = tags.get("toll").map(|s| s.as_str()) == Some("yes");
                let lit = match tags.get("lit").map(|s| s.as_str()) {
                    Some("yes") => 1u8,
                    Some("no") => 2,
                    _ => 0, // 0=unknown
                };
                let _ = write!(
                    w,
                    "\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                    classify::road_class(highway),
                    tags.get("maxspeed")
                        .map(|s| match classify::parse_maxspeed_kmh(s) {
                            // u8 column unchanged: `none` → sentinel 255,
                            // real limits clamp to 254 so they can't collide.
                            classify::MAXSPEED_NONE => classify::SPEED_LIMIT_DERESTRICTED,
                            v => v.min(254) as u8,
                        })
                        .unwrap_or(0),
                    classify::surface_type(surface),
                    if tags.get("oneway").map(|s| s.as_str()) == Some("yes") {
                        1
                    } else {
                        0
                    },
                    tags.get("lanes")
                        .and_then(|s| s.parse::<u8>().ok())
                        .unwrap_or(0),
                    tags.get("name").unwrap_or(&String::new()),
                    tags.get("ref").unwrap_or(&String::new()),
                    if bridge { 1 } else { 0 },
                    if tunnel { 1 } else { 0 },
                    if toll { 1 } else { 0 },
                    lit,
                    classify::junction_type(tags.get("junction").map(|s| s.as_str())),
                    classify::access_type(
                        tags.get("access").map(|s| s.as_str()),
                        tags.get("motor_vehicle").map(|s| s.as_str()),
                        tags.get("vehicle").map(|s| s.as_str()),
                    ),
                );
            }
            FeatureType::Railway => {
                let railway = tags.get("railway").map(|s| s.as_str()).unwrap_or("rail");
                let electrified = match tags.get("electrified").map(|s| s.as_str()) {
                    Some("contact_line") | Some("yes") | Some("rail") => 1u8,
                    Some("no") => 2,
                    _ => 0, // unknown
                };
                let gauge = tags
                    .get("gauge")
                    .and_then(|s| s.parse::<u16>().ok())
                    .unwrap_or(0);
                let bridge = matches!(
                    tags.get("bridge").map(|s| s.as_str()),
                    Some("yes" | "viaduct" | "cantilever" | "movable")
                );
                let tunnel = matches!(
                    tags.get("tunnel").map(|s| s.as_str()),
                    Some("yes" | "building_passage" | "culvert")
                );
                let _ = write!(
                    w,
                    "\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                    classify::rail_type(railway),
                    classify::rail_usage_type(tags.get("usage").map(|s| s.as_str())),
                    // `none` is a road concept; on rail drop it so it falls to
                    // the same 0 = untagged → type-default speed downstream.
                    // u16 column (finalize.rs): 300+ km/h survives.
                    tags.get("maxspeed")
                        .map(|s| classify::parse_maxspeed_kmh(s))
                        .filter(|&v| v != classify::MAXSPEED_NONE)
                        .unwrap_or(0u16),
                    tags.get("name").unwrap_or(&String::new()),
                    tags.get("ref").unwrap_or(&String::new()),
                    electrified,
                    gauge,
                    if bridge { 1 } else { 0 },
                    if tunnel { 1 } else { 0 },
                    if tags.get("highspeed").map(|s| s.as_str()) == Some("yes") {
                        1
                    } else {
                        0
                    },
                    classify::rail_service_type(tags.get("service").map(|s| s.as_str())),
                );
            }
            FeatureType::Barrier => {
                let _ = write!(
                    w,
                    "\t{}\t{}",
                    tags.get("height")
                        .and_then(|s| s.parse::<f32>().ok())
                        .unwrap_or(3.0),
                    classify::barrier_material_type(tags.get("material").map(|s| s.as_str())),
                );
            }
            FeatureType::AirportLine => {
                let heading = microsegment::bearing_deg(seg.0[0], seg.0[1], seg.1[0], seg.1[1]);
                let _ = write!(
                    w,
                    "\t{:.1}\t{}\t{}\t{}\t",
                    heading,
                    classify::aeroway_type(tags),
                    tags.get("ref").map(String::as_str).unwrap_or(""),
                    tags.get("surface").map(String::as_str).unwrap_or(""),
                );
                if let Some(v) = classify::parse_width_m(tags.get("width").map(|s| s.as_str())) {
                    let _ = write!(w, "{v:.1}");
                }
            }
            _ => {}
        }

        let _ = writeln!(w);
    }

    /// Emit a polygon/point feature (building, industrial, wind turbine).
    pub fn emit_polygon(
        &mut self,
        ftype: &FeatureType,
        hex_id: u64,
        osm_id: i64,
        clat: f64,
        clon: f64,
        tags: &Tags,
        wkb: Option<&[u8]>,
    ) {
        // H3 res-4 IDs have lower 28 bits = 0xFFFFFFF → shift right before modulo
        let bucket = ((hex_id >> 28) as usize) % self.num_buckets;
        let name = ftype.name();

        let w = &mut self.get_writer(name, bucket).writer;
        let _ = write!(w, "{}\t{}\t{:.7}\t{:.7}", hex_id, osm_id, clat, clon);

        match ftype {
            FeatureType::Building => {
                // Use amenity/shop/healthcare tags to override building type classification.
                // WHY: building=yes + amenity=school → type 3 (school), not 0 (residential).
                let bt = building_type_from_tags(tags);
                let _ = write!(
                    w,
                    "\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                    bt,
                    tags.get("building:use")
                        .map(|s| building_use(s))
                        .unwrap_or(0),
                    tags.get("height")
                        .and_then(|s| parse_height(s))
                        .unwrap_or(0.0),
                    tags.get("building:levels")
                        .and_then(|s| s.parse::<u8>().ok())
                        .unwrap_or(0),
                    tags.get("name").unwrap_or(&String::new()),
                    tags.get("addr:street").unwrap_or(&String::new()),
                    tags.get("addr:housenumber").unwrap_or(&String::new()),
                    // settlement v2 phase 2: opening_hours → day-fraction u8.
                    classify::opening_hours_fraction(
                        tags.get("opening_hours").map(|s| s.as_str())
                    ),
                );
            }
            FeatureType::Leisure => {
                let _ = write!(
                    w,
                    "\t{}\t{}\t{}\t{}",
                    classify::leisure_sport_class(tags),
                    classify::parse_capacity(tags)
                        .map(|c| c.to_string())
                        .unwrap_or_default(),
                    classify::opening_hours_fraction(
                        tags.get("opening_hours").map(|s| s.as_str())
                    ),
                    tags.get("name").unwrap_or(&String::new()),
                );
            }
            FeatureType::Industrial | FeatureType::WindTurbine => {
                let src_type: u8 = if matches!(ftype, FeatureType::WindTurbine) {
                    10
                }
                // wind_turbine
                else {
                    site_type_from_tags(tags)
                };
                let _ = write!(
                    w,
                    "\t{}\t{}\t{}\t{}\t{}",
                    src_type,
                    site_subtype_from_tags(tags),
                    tags.get("name").unwrap_or(&String::new()),
                    tags.get("height")
                        .and_then(|s| parse_height(s))
                        .unwrap_or(0.0),
                    parse_power_kw(tags.get("generator:output:electricity").map(|s| s.as_str())),
                );
            }
            FeatureType::AirportArea => {
                let airport_ref = tags
                    .get("ref")
                    .or_else(|| tags.get("local_ref"))
                    .map(|s| s.as_str())
                    .unwrap_or("");
                let width_m = classify::parse_width_m(tags.get("width").map(|s| s.as_str()))
                    .map(|v| format!("{v:.1}"))
                    .unwrap_or_default();
                let _ = write!(
                    w,
                    "\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                    classify::aeroway_type(tags),
                    tags.get("name").map(|s| s.as_str()).unwrap_or(""),
                    airport_ref,
                    tags.get("icao").map(|s| s.as_str()).unwrap_or(""),
                    tags.get("iata").map(|s| s.as_str()).unwrap_or(""),
                    tags.get("operator").map(|s| s.as_str()).unwrap_or(""),
                    tags.get("surface").map(|s| s.as_str()).unwrap_or(""),
                    width_m,
                    tags.get("aerodrome:type").map(|s| s.as_str()).unwrap_or(""),
                    tags.get("access").map(|s| s.as_str()).unwrap_or(""),
                );
            }
            _ => {}
        }

        // WKB as hex-encoded string
        if let Some(wkb_bytes) = wkb {
            let _ = write!(w, "\t{}", hex::encode(wkb_bytes));
        } else {
            let _ = write!(w, "\t");
        }

        let _ = writeln!(w);
    }

    /// Emit a function-POI node for the finalize footprint join (settlement v2
    /// phase 2). Format: `hex_id, lat, lon, class`. Consumed ONLY by finalize to
    /// reclassify the `building=yes` the POI sits inside; never a final arrow.
    /// `class` is the settlement class from [`poi_class`]; rows whose tags don't
    /// resolve are not emitted (caller checks first).
    pub fn emit_poi(&mut self, hex_id: u64, clat: f64, clon: f64, class: u8) {
        let bucket = ((hex_id >> 28) as usize) % self.num_buckets;
        let w = &mut self.get_writer(FeatureType::Poi.name(), bucket).writer;
        let _ = writeln!(w, "{}\t{:.7}\t{:.7}\t{}", hex_id, clat, clon, class);
    }

    pub fn flush_all(&mut self) -> Result<()> {
        for (_, bf) in self.writers.iter_mut() {
            bf.writer.flush()?;
        }
        Ok(())
    }
}

/// Classify building type from all relevant OSM tags, not just building=*.
/// Priority: amenity/shop/healthcare/tourism > building tag.
/// WHY: OSM mappers often tag building=yes with function in amenity/shop.
///   Without this, a hospital tagged building=yes + amenity=hospital
///   would be classified as residential and get wrong emission profile.
///
/// `farm_auxiliary` co-tagged with a livestock signal is rescued from SILENT
/// back to farm (class 8) — many auxiliaries are sheds (→ SILENT) but a few are
/// barns. Function POIs reuse [`poi_class`] (shared with the finalize join).
fn building_type_from_tags(tags: &Tags) -> u8 {
    let get = |k: &str| tags.get(k).map(|s| s.as_str());
    if let Some(c) = poi_class(get("amenity"), get("shop"), get("healthcare"), get("tourism")) {
        return c;
    }
    // farm_auxiliary + livestock → real farm building, not a silent shed.
    if get("building") == Some("farm_auxiliary")
        && (tags.contains_key("animal") || get("livestock").is_some())
    {
        return 8;
    }
    // Fallback to building tag
    tags.get("building").map(|s| building_type(s)).unwrap_or(0)
}

/// The emission class implied by a function POI (`amenity`/`shop`/`healthcare`/
/// `tourism`), or `None` if none of the values are noise-relevant. Shared by the
/// way-level `building_type_from_tags` and the finalize POI-in-footprint join so
/// a standalone `amenity=hospital` node and a `building=yes + amenity=hospital`
/// way classify identically. Returns the settlement class u8.
/// [`poi_class`] resolved from a node/way `Tags` map (settlement v2 phase 2).
pub fn poi_class_from_tags(tags: &Tags) -> Option<u8> {
    poi_class(
        tags.get("amenity").map(|s| s.as_str()),
        tags.get("shop").map(|s| s.as_str()),
        tags.get("healthcare").map(|s| s.as_str()),
        tags.get("tourism").map(|s| s.as_str()),
    )
}

pub fn poi_class(
    amenity: Option<&str>,
    shop: Option<&str>,
    healthcare: Option<&str>,
    tourism: Option<&str>,
) -> Option<u8> {
    use noise_compute::emission::settlement as st;
    if let Some(a) = amenity {
        match a {
            "school" | "kindergarten" | "university" | "college" | "library" => return Some(3),
            "hospital" | "clinic" | "doctors" | "dentist" | "pharmacy" => return Some(4),
            "place_of_worship" => return Some(5),
            "restaurant" | "bar" | "pub" | "cafe" | "fast_food" | "food_court" | "ice_cream"
            | "nightclub" => return Some(st::HOSPITALITY),
            "fuel" | "car_wash" => return Some(1), // small-commercial placeholder (PROP-MEAS)
            "parking" | "parking_space" => return Some(7),
            "fire_station" | "police" | "townhall" | "courthouse" | "post_office" => {
                return Some(9)
            }
            _ => {}
        }
    }
    if let Some(s) = shop {
        match s {
            "supermarket" | "convenience" | "wholesale" | "greengrocer" | "butcher"
            | "bakery" | "deli" | "frozen_food" | "mall" | "department_store" => {
                return Some(st::FOOD_RETAIL)
            }
            "" => {}
            _ => return Some(1), // any other shop = commercial
        }
    }
    if let Some(h) = healthcare {
        if matches!(h, "hospital" | "clinic") {
            return Some(4);
        }
    }
    if let Some(t) = tourism {
        if matches!(t, "hotel" | "hostel" | "motel" | "guest_house") {
            return Some(6);
        }
    }
    None
}

/// Map a raw `building=*` value to a settlement emission class (the u8s defined
/// in `noise_compute::emission::settlement`). Settlement v2 phase 2 splits the
/// phase-1 coarse type 0: detached/terrace houses → HOUSE (garden + heat pump),
/// `building=supermarket` → FOOD_RETAIL (24/7 refrigeration), restaurant/cafe
/// buildings → HOSPITALITY, and the enumeration §C′ silent tail (sheds, roofs,
/// huts, greenhouses, ruins — ~18 M objects that wrongly radiated residential)
/// → SILENT. `yes`/`""`/unknown stay 0 = residential-apartments (the dominant
/// `building=yes` 79 % can only be reclassified by the POI join, not by tag).
fn building_type(val: &str) -> u8 {
    use noise_compute::emission::settlement as st;
    match val {
        // Apartments / generic residential keep type 0 (no garden term).
        "residential" | "apartments" | "dormitory" => 0,
        // Single-family houses get the HOUSE class (garden + heat pump).
        "house" | "detached" | "semidetached_house" | "semidetached" | "terrace"
        | "bungalow" | "houseboat" | "cabin" => st::HOUSE,
        "supermarket" => st::FOOD_RETAIL,
        "restaurant" | "cafe" | "pub" | "bar" | "fast_food" => st::HOSPITALITY,
        "commercial" | "retail" | "office" | "kiosk" => 1,
        "industrial" | "warehouse" | "manufacture" => 2,
        "school" | "university" | "college" | "kindergarten" => 3,
        "hospital" | "clinic" => 4,
        "church" | "cathedral" | "chapel" | "mosque" | "synagogue" | "temple" => 5,
        "hotel" | "hostel" | "motel" => 6,
        "garage" | "garages" | "carport" | "parking" => 7,
        "farm" | "barn" | "stable" | "sty" | "cowshed" => 8,
        "public" | "civic" | "government" => 9,
        // §C′ SILENT tail: uninhabited / unheated / infra structures. Routing
        // these out of residential is the largest correctness win of phase 2
        // (~2.6 % of all buildings stop emitting phantom residential noise).
        // `farm_auxiliary` is ambiguous (many are sheds) → SILENT unless the
        // building_type_from_tags livestock check overrides it to farm.
        "shed" | "roof" | "hut" | "outbuilding" | "greenhouse" | "static_caravan"
        | "carport_roof" | "ruins" | "ruin" | "construction" | "collapsed" | "service"
        | "allotment_house" | "boathouse" | "bunker" | "tent" | "container"
        | "storage_tank" | "silo" | "hangar" | "conservatory" | "ger" | "farm_auxiliary"
        | "transformer_tower" | "water_tower" | "no" => st::SILENT,
        "yes" | "" => 0, // default to residential-apartments
        _ => 0,
    }
}

fn building_use(val: &str) -> u8 {
    match val {
        "residential" => 0,
        "commercial" | "retail" | "office" => 1,
        "industrial" => 2,
        _ => 0,
    }
}

fn site_type_from_tags(tags: &Tags) -> u8 {
    if let Some(lu) = tags.get("landuse") {
        match lu.as_str() {
            "industrial" => return 0,
            "quarry" => return 1,
            "farmyard" => return 2,
            _ => {}
        }
    }
    if let Some(mm) = tags.get("man_made") {
        match mm.as_str() {
            "works" => return 3,
            "wastewater_plant" => return 4,
            _ => {}
        }
    }
    0
}

/// Classify industrial site subtype from OSM `industrial=*` and `product=*` tags.
/// Pipeline-worker uses this to infer NACE when industrial.arrow has no enriched
/// `nace_4digit` code.
///
/// Values:
///   0 = unknown/generic industrial (default 93 dB)
///   1 = warehouse/logistics (quiet — 75 dB)
///   2 = factory/works (loud — 95 dB)
///   3 = mine/quarry (very loud — 99 dB)
///   4 = chemical/refinery (90 dB)
///   5 = cement/mineral (100 dB)
///   6 = metal/steel/smelter (100 dB)
///   7 = food/brewery/mill (88 dB)
///   8 = wood/sawmill/paper (90 dB)
///   9 = waste/recycling (93 dB)
///  10 = farm/agriculture (70 dB)
///  11 = office/commercial (60 dB)
///  12 = port/shipyard (92 dB)
fn site_subtype_from_tags(tags: &Tags) -> u8 {
    // Check industrial=* tag (most specific)
    if let Some(ind) = tags.get("industrial") {
        match ind.as_str() {
            "warehouse" | "depot" | "logistics" => return 1,
            "factory" | "manufacturing" => return 2,
            "mine" | "quarry" | "open_pit" => return 3,
            "oil" | "chemical" | "refinery" | "gas" => return 4,
            "cement" | "glass" | "brickyard" | "ceramics" => return 5,
            "steelmaking" | "smelting" | "foundry" | "metal" | "aluminium" | "iron" => return 6,
            "brewery" | "winery" | "distillery" | "bakery" | "food" | "slaughterhouse" | "sugar" => return 7,
            "sawmill" | "timber" | "lumber" | "paper" | "pulp" | "woodworking" => return 8,
            "scrap_yard" | "recycling" | "waste" | "landfill" => return 9,
            "farm" | "agriculture" | "horticulture" | "greenhouse" => return 10,
            "port" | "shipyard" | "boatyard" | "dock" => return 12,
            _ => {}
        }
    }
    // Check product=* tag
    if let Some(prod) = tags.get("product") {
        let p = prod.to_lowercase();
        if p.contains("cement") || p.contains("concrete") || p.contains("brick") || p.contains("glass") || p.contains("ceramic") || p.contains("tile") { return 5; }
        if p.contains("steel") || p.contains("iron") || p.contains("alumin") || p.contains("copper") || p.contains("metal") || p.contains("zinc") { return 6; }
        if p.contains("chemical") || p.contains("petrol") || p.contains("oil") || p.contains("fuel") || p.contains("plastic") || p.contains("fertiliz") { return 4; }
        if p.contains("food") || p.contains("sugar") || p.contains("beer") || p.contains("wine") || p.contains("flour") || p.contains("dairy") || p.contains("meat") { return 7; }
        if p.contains("wood") || p.contains("paper") || p.contains("timber") || p.contains("lumber") || p.contains("pulp") { return 8; }
    }
    // Check man_made=* for additional classification
    // NOTE: wastewater_plant intentionally NOT classified — it has a dedicated
    // source_type=4 profile (89 dB, 24/7) which is more accurate than waste subtype=9 (93 dB).
    if let Some(mm) = tags.get("man_made") {
        if mm.as_str() == "works" { return 2 }
    }
    // Check landuse refinements
    if let Some(lu) = tags.get("landuse") {
        match lu.as_str() {
            "farmyard" | "farmland" => return 10,
            "quarry" => return 3,
            _ => {}
        }
    }
    // Check building=office in industrial context
    if tags.get("office").is_some() {
        return 11;
    }
    0 // unknown — will use default 93 dB
}

fn parse_height(val: &str) -> Option<f32> {
    val.trim_end_matches(" m")
        .trim_end_matches("m")
        .parse()
        .ok()
}

fn parse_power_kw(val: Option<&str>) -> f32 {
    let v = val.unwrap_or("0");
    if let Some(mw) = v.strip_suffix(" MW").or_else(|| v.strip_suffix("MW")) {
        mw.parse::<f32>().unwrap_or(0.0) * 1000.0
    } else if let Some(kw) = v.strip_suffix(" kW").or_else(|| v.strip_suffix("kW")) {
        kw.parse::<f32>().unwrap_or(0.0)
    } else if let Some(w) = v.strip_suffix(" W").or_else(|| v.strip_suffix("W")) {
        w.parse::<f32>().unwrap_or(0.0) / 1000.0
    } else {
        v.parse::<f32>().unwrap_or(0.0)
    }
}

// hex crate for WKB encoding
mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    pub fn decode(s: &str) -> Option<Vec<u8>> {
        if !s.len().is_multiple_of(2) || s.is_empty() {
            return None;
        }
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
            .collect()
    }
}

pub use hex::decode as hex_decode;

#[cfg(test)]
mod settlement_class_tests {
    use super::*;
    use noise_compute::emission::settlement as st;

    #[test]
    fn building_type_splits_house_from_apartments() {
        assert_eq!(building_type("apartments"), 0);
        assert_eq!(building_type("residential"), 0);
        assert_eq!(building_type("yes"), 0);
        assert_eq!(building_type("house"), st::HOUSE);
        assert_eq!(building_type("detached"), st::HOUSE);
        assert_eq!(building_type("terrace"), st::HOUSE);
    }

    #[test]
    fn building_type_food_retail_and_hospitality() {
        assert_eq!(building_type("supermarket"), st::FOOD_RETAIL);
        assert_eq!(building_type("restaurant"), st::HOSPITALITY);
        assert_eq!(building_type("pub"), st::HOSPITALITY);
        // generic retail/office stay commercial.
        assert_eq!(building_type("retail"), 1);
        assert_eq!(building_type("office"), 1);
    }

    #[test]
    fn silent_tail_routed_out_of_residential() {
        for v in ["shed", "roof", "hut", "greenhouse", "ruins", "construction", "carport_roof"] {
            assert_eq!(building_type(v), st::SILENT, "{v} must be SILENT");
        }
        // The default for genuinely-unknown small footprints stays residential
        // (only the ENUMERATED silent values flip — plan §C′).
        assert_eq!(building_type("some_unknown_value"), 0);
    }

    #[test]
    fn poi_class_priorities() {
        assert_eq!(poi_class(Some("hospital"), None, None, None), Some(4));
        assert_eq!(poi_class(Some("school"), None, None, None), Some(3));
        assert_eq!(poi_class(Some("cafe"), None, None, None), Some(st::HOSPITALITY));
        assert_eq!(poi_class(None, Some("supermarket"), None, None), Some(st::FOOD_RETAIL));
        assert_eq!(poi_class(None, Some("convenience"), None, None), Some(st::FOOD_RETAIL));
        assert_eq!(poi_class(None, Some("clothes"), None, None), Some(1));
        assert_eq!(poi_class(None, None, Some("hospital"), None), Some(4));
        assert_eq!(poi_class(None, None, None, Some("hotel")), Some(6));
        // Non-noise POIs return None (so they don't bloat the join file).
        assert_eq!(poi_class(Some("bench"), None, None, None), None);
        assert_eq!(poi_class(None, None, None, None), None);
    }

    #[test]
    fn farm_auxiliary_silent_unless_livestock() {
        let mut shed = Tags::new();
        shed.insert("building".into(), "farm_auxiliary".into());
        assert_eq!(building_type_from_tags(&shed), st::SILENT);
        let mut barn = Tags::new();
        barn.insert("building".into(), "farm_auxiliary".into());
        barn.insert("animal".into(), "cattle".into());
        assert_eq!(building_type_from_tags(&barn), 8);
    }

    #[test]
    fn building_type_from_tags_poi_overrides_yes() {
        let mut t = Tags::new();
        t.insert("building".into(), "yes".into());
        t.insert("amenity".into(), "hospital".into());
        assert_eq!(building_type_from_tags(&t), 4);
    }
}
