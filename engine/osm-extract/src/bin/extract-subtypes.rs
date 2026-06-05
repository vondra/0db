//! Extract industrial site_subtype from OSM PBF.
//!
//! Reads a PBF file, finds all ways/relations that are industrial sites,
//! computes site_subtype from `industrial=*` and `product=*` tags,
//! and outputs `osm_id\tsite_subtype` TSV to stdout.
//!
//! Usage:
//!   extract-subtypes /path/to/planet.osm.pbf > subtypes.tsv
//!
//! Then patch Arrow files:
//!   DATA_YEAR=2026 npx tsx pipeline/patch-industrial-subtype.ts subtypes.tsv

use osmpbf::{ElementReader, Element};
use std::env;
use std::collections::HashMap;

/// Classify from `industrial=*` tag (mirrors spill.rs site_subtype_from_tags).
fn subtype_from_industrial_tag(val: &str) -> u8 {
    match val {
        "warehouse" | "depot" | "logistics" => 1,
        "factory" | "manufacturing" => 2,
        "mine" | "quarry" | "open_pit" => 3,
        "oil" | "chemical" | "refinery" | "gas" => 4,
        "cement" | "glass" | "brickyard" | "ceramics" => 5,
        "steelmaking" | "smelting" | "foundry" | "metal" | "aluminium" | "iron" => 6,
        "brewery" | "winery" | "distillery" | "bakery" | "food" | "slaughterhouse" | "sugar" => 7,
        "sawmill" | "timber" | "lumber" | "paper" | "pulp" | "woodworking" => 8,
        "scrap_yard" | "recycling" | "waste" | "landfill" => 9,
        "farm" | "agriculture" | "horticulture" | "greenhouse" => 10,
        "port" | "shipyard" | "boatyard" | "dock" => 12,
        _ => 0,
    }
}

/// Classify from `product=*` tag.
fn subtype_from_product_tag(val: &str) -> u8 {
    let p = val.to_lowercase();
    if p.contains("cement") || p.contains("concrete") || p.contains("brick") || p.contains("glass") || p.contains("ceramic") || p.contains("tile") { return 5; }
    if p.contains("steel") || p.contains("iron") || p.contains("alumin") || p.contains("copper") || p.contains("metal") || p.contains("zinc") { return 6; }
    if p.contains("chemical") || p.contains("petrol") || p.contains("oil") || p.contains("fuel") || p.contains("plastic") || p.contains("fertiliz") { return 4; }
    if p.contains("food") || p.contains("sugar") || p.contains("beer") || p.contains("wine") || p.contains("flour") || p.contains("dairy") || p.contains("meat") { return 7; }
    if p.contains("wood") || p.contains("paper") || p.contains("timber") || p.contains("lumber") || p.contains("pulp") { return 8; }
    0
}

/// Check if a way/relation is an industrial site we extract.
fn is_industrial(tags: &[(String, String)]) -> bool {
    for (k, v) in tags {
        match k.as_str() {
            "landuse" if matches!(v.as_str(), "industrial" | "quarry" | "farmyard") => return true,
            "man_made" if matches!(v.as_str(), "works" | "wastewater_plant") => return true,
            "amenity" if v == "fuel" => return true,
            "power" if matches!(v.as_str(), "plant" | "generator" | "substation") => return true,
            _ => {}
        }
    }
    false
}

/// Compute site_subtype from all tags.
fn compute_subtype(tags: &[(String, String)]) -> u8 {
    // Check industrial=* first (most specific)
    for (k, v) in tags {
        if k == "industrial" {
            let st = subtype_from_industrial_tag(v);
            if st > 0 { return st; }
        }
    }
    // Check product=*
    for (k, v) in tags {
        if k == "product" {
            let st = subtype_from_product_tag(v);
            if st > 0 { return st; }
        }
    }
    // Check man_made=*
    // NOTE: wastewater_plant NOT classified — has dedicated source_type=4 profile (89 dB, 24/7)
    for (k, v) in tags {
        if k == "man_made" {
            if v == "works" { return 2; }
        }
    }
    // Check landuse=*
    for (k, v) in tags {
        if k == "landuse" {
            match v.as_str() {
                "farmyard" | "farmland" => return 10,
                "quarry" => return 3,
                _ => {}
            }
        }
    }
    // Check office=*
    for (k, _) in tags {
        if k == "office" { return 11; }
    }
    0
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: extract-subtypes <planet.osm.pbf>");
        std::process::exit(1);
    }
    let pbf_path = &args[1];

    eprintln!("Reading {}", pbf_path);
    let reader = ElementReader::from_path(pbf_path).expect("Failed to open PBF");

    let merged: HashMap<i64, u8> = reader
        .par_map_reduce(
            |element| {
                let mut local = HashMap::new();
                match element {
                    Element::Way(way) => {
                        let tags: Vec<(String, String)> = way
                            .tags()
                            .map(|(k, v)| (k.to_string(), v.to_string()))
                            .collect();
                        if is_industrial(&tags) {
                            let st = compute_subtype(&tags);
                            if st > 0 {
                                local.insert(way.id(), st);
                            }
                        }
                    }
                    Element::Relation(rel) => {
                        let tags: Vec<(String, String)> = rel
                            .tags()
                            .map(|(k, v)| (k.to_string(), v.to_string()))
                            .collect();
                        if is_industrial(&tags) {
                            let st = compute_subtype(&tags);
                            if st > 0 {
                                // Relations use negative IDs in our extraction
                                local.insert(-rel.id(), st);
                            }
                        }
                    }
                    _ => {}
                }
                local
            },
            HashMap::new,
            |mut a, b| {
                a.extend(b);
                a
            },
        )
        .expect("PBF read failed");

    eprintln!("Found {} industrial sites with subtype > 0", merged.len());

    // Output TSV to stdout
    println!("osm_id\tsite_subtype");
    let mut entries: Vec<_> = merged.into_iter().collect();
    entries.sort_by_key(|(id, _)| *id);
    for (id, st) in entries {
        println!("{}\t{}", id, st);
    }
}
