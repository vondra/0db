//! Spill bucket writer.
//!
//! Features are hashed by hex_id % num_buckets and appended to intermediate files.
//! Each bucket is a simple binary format: sequences of records grouped by feature type.
//! We use CSV for simplicity during development — Arrow IPC in finalize step.

use crate::classify::{self, FeatureType, Tags};
use anyhow::Result;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

/// One record waiting to be written.
pub struct SegmentRecord {
    pub hex_id: u64,
    pub osm_id: i64,
    pub segment_idx: i16,
    pub start_lat: f64,
    pub start_lon: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    pub length_m: f32,
    pub tags: Tags,
}

pub struct PolygonRecord {
    pub hex_id: u64,
    pub osm_id: i64,
    pub centroid_lat: f64,
    pub centroid_lon: f64,
    pub tags: Tags,
    pub wkb: Option<Vec<u8>>,
}

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
            BucketFile { writer: BufWriter::with_capacity(1 << 20, file) }
        })
    }

    /// Emit a linear segment (road, railway, barrier).
    pub fn emit_segment(
        &mut self, ftype: &FeatureType, hex_id: u64, osm_id: i64,
        seg_idx: i16, seg: &([f64; 2], [f64; 2], f32), tags: &Tags,
    ) {
        // H3 res-4 IDs have lower 28 bits = 0xFFFFFFF → shift right before modulo
        let bucket = ((hex_id >> 28) as usize) % self.num_buckets;
        let name = ftype.name();

        // TSV: hex_id, osm_id, seg_idx, start_lat, start_lon, end_lat, end_lon, length_m, tags...
        let w = &mut self.get_writer(name, bucket).writer;
        let _ = write!(w, "{}\t{}\t{}\t{:.7}\t{:.7}\t{:.7}\t{:.7}\t{:.1}",
            hex_id, osm_id, seg_idx,
            seg.0[0], seg.0[1], seg.1[0], seg.1[1], seg.2);

        // Append feature-specific tags as key=value pairs
        match ftype {
            FeatureType::Road => {
                let highway = tags.get("highway").map(|s| s.as_str()).unwrap_or("");
                let bridge = matches!(tags.get("bridge").map(|s| s.as_str()), Some("yes" | "viaduct" | "cantilever" | "movable"));
                let tunnel = matches!(tags.get("tunnel").map(|s| s.as_str()), Some("yes" | "building_passage" | "culvert"));
                let toll = tags.get("toll").map(|s| s.as_str()) == Some("yes");
                let lit = match tags.get("lit").map(|s| s.as_str()) {
                    Some("yes") => 1u8, Some("no") => 2, _ => 0, // 0=unknown
                };
                let _ = write!(w, "\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                    classify::road_class(highway),
                    tags.get("maxspeed").and_then(|s| s.parse::<u8>().ok()).unwrap_or(0),
                    classify::surface_type(tags.get("surface").map(|s| s.as_str())),
                    if tags.get("oneway").map(|s| s.as_str()) == Some("yes") { 1 } else { 0 },
                    tags.get("lanes").and_then(|s| s.parse::<u8>().ok()).unwrap_or(0),
                    tags.get("name").unwrap_or(&String::new()),
                    tags.get("ref").unwrap_or(&String::new()),
                    if bridge { 1 } else { 0 },
                    if tunnel { 1 } else { 0 },
                    if toll { 1 } else { 0 },
                    lit,
                );
            }
            FeatureType::Railway => {
                let railway = tags.get("railway").map(|s| s.as_str()).unwrap_or("rail");
                let electrified = match tags.get("electrified").map(|s| s.as_str()) {
                    Some("contact_line") | Some("yes") | Some("rail") => 1u8,
                    Some("no") => 2,
                    _ => 0, // unknown
                };
                let gauge = tags.get("gauge").and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
                let _ = write!(w, "\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                    classify::rail_type(railway),
                    tags.get("usage").and_then(|s| match s.as_str() {
                        "main" => Some(0u8), "branch" => Some(1), "industrial" => Some(2), _ => Some(0)
                    }).unwrap_or(0),
                    tags.get("maxspeed").and_then(|s| s.parse::<u8>().ok()).unwrap_or(0),
                    tags.get("name").unwrap_or(&String::new()),
                    tags.get("ref").unwrap_or(&String::new()),
                    electrified,
                    gauge,
                );
            }
            FeatureType::Barrier => {
                let _ = write!(w, "\t{}\t{}",
                    tags.get("height").and_then(|s| s.parse::<f32>().ok()).unwrap_or(3.0),
                    tags.get("material").and_then(|s| match s.as_str() {
                        "concrete" => Some(0u8), "metal" => Some(1), "wood" => Some(2),
                        "glass" => Some(3), "brick" => Some(4), _ => Some(0)
                    }).unwrap_or(0),
                );
            }
            _ => {}
        }

        let _ = writeln!(w);
    }

    /// Emit a polygon/point feature (building, industrial, wind turbine).
    pub fn emit_polygon(
        &mut self, ftype: &FeatureType, hex_id: u64, osm_id: i64,
        clat: f64, clon: f64, tags: &Tags, wkb: Option<&[u8]>,
    ) {
        // H3 res-4 IDs have lower 28 bits = 0xFFFFFFF → shift right before modulo
        let bucket = ((hex_id >> 28) as usize) % self.num_buckets;
        let name = ftype.name();

        let w = &mut self.get_writer(name, bucket).writer;
        let _ = write!(w, "{}\t{}\t{:.7}\t{:.7}", hex_id, osm_id, clat, clon);

        match ftype {
            FeatureType::Building => {
                let _ = write!(w, "\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                    tags.get("building").map(|s| building_type(s)).unwrap_or(0),
                    tags.get("building:use").map(|s| building_use(s)).unwrap_or(0),
                    tags.get("height").and_then(|s| parse_height(s)).unwrap_or(0.0),
                    tags.get("building:levels").and_then(|s| s.parse::<u8>().ok()).unwrap_or(0),
                    tags.get("name").unwrap_or(&String::new()),
                    tags.get("addr:street").unwrap_or(&String::new()),
                    tags.get("addr:housenumber").unwrap_or(&String::new()),
                );
            }
            FeatureType::Industrial | FeatureType::WindTurbine => {
                let src_type: u8 = if matches!(ftype, FeatureType::WindTurbine) { 10 } // wind_turbine
                    else { site_type_from_tags(tags) };
                let _ = write!(w, "\t{}\t{}\t{}\t{}\t{}",
                    src_type,
                    0u8, // site_subtype (TODO)
                    tags.get("name").unwrap_or(&String::new()),
                    tags.get("height").and_then(|s| parse_height(s)).unwrap_or(0.0),
                    parse_power_kw(tags.get("generator:output:electricity").map(|s| s.as_str())),
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

    pub fn flush_all(&mut self) -> Result<()> {
        for (_, bf) in self.writers.iter_mut() {
            bf.writer.flush()?;
        }
        Ok(())
    }
}

fn building_type(val: &str) -> u8 {
    match val {
        "residential" | "house" | "detached" | "semidetached_house" | "terrace" | "apartments" => 0,
        "commercial" | "retail" | "office" => 1,
        "industrial" | "warehouse" => 2,
        "school" | "university" | "college" | "kindergarten" => 3,
        "hospital" | "clinic" => 4,
        "church" | "cathedral" | "chapel" | "mosque" | "synagogue" | "temple" => 5,
        "hotel" | "hostel" | "motel" => 6,
        "garage" | "garages" | "carport" | "parking" => 7,
        "farm" | "barn" | "stable" | "sty" | "cowshed" => 8,
        "public" | "civic" | "government" => 9,
        "yes" | "" => 0, // default to residential
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

fn parse_height(val: &str) -> Option<f32> {
    val.trim_end_matches(" m").trim_end_matches("m").parse().ok()
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
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
            .collect()
    }
}

pub use hex::decode as hex_decode;
