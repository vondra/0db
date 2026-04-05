//! osm-to-h3r4: Extract noise-relevant features from OSM PBF into H3 res-4 partitioned Arrow IPC.
//!
//! Pipeline:
//!   Pass 0: Scan relations → manifest of multipolygon members
//!   Pass 1: Stream nodes → mmap'd coordinate cache
//!   Pass 2: Stream ways + relations → classify, resolve, microsegment, assemble multipolygons
//!   Spill to 256 intermediate buckets, then finalize → per-hex Arrow IPC

mod node_cache;
mod classify;
mod microsegment;
mod relations;
mod spill;
mod finalize;

use anyhow::Result;
use clap::Parser;
use osmpbf::{ElementReader, Element};
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser)]
#[command(name = "osm-to-h3r4")]
struct Cli {
    #[arg(short, long)]
    input: PathBuf,
    #[arg(short, long, default_value = "source-data/h3r4")]
    output: PathBuf,
    #[arg(long, default_value = "/tmp/osm_nodes.cache")]
    node_cache: PathBuf,
    #[arg(long, default_value = "/tmp/osm_spill")]
    spill_dir: PathBuf,
    #[arg(long, default_value_t = 256)]
    num_buckets: usize,
    /// Skip extraction, only run finalize on existing spill data.
    #[arg(long)]
    finalize_only: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let t0 = Instant::now();
    eprintln!("=== osm-to-h3r4 ===");

    if cli.finalize_only {
        eprintln!("  Finalize-only mode (skipping extraction)");
        eprintln!("  Spill dir: {}", cli.spill_dir.display());
        eprintln!("  Output: {}", cli.output.display());

        let t_fin = Instant::now();
        let hex_count = finalize::finalize(&cli.spill_dir, &cli.output, cli.num_buckets)?;
        eprintln!("  {} hex dirs in {:.1}s", hex_count, t_fin.elapsed().as_secs_f64());

        // Don't clean up spill (user may want to re-run)
        eprintln!("\n=== Done: {:.1}s ===", t0.elapsed().as_secs_f64());
        return Ok(());
    }

    eprintln!("  Input:  {}", cli.input.display());

    // ── Pass 0: Scan relations ──
    eprintln!("\n── Pass 0: Scan relations ──");
    let manifest = relations::scan_relations(&cli.input)?;
    eprintln!("  {:.1}s", t0.elapsed().as_secs_f64());

    // ── Pass 1: Node coordinate cache ──
    eprintln!("\n── Pass 1: Node cache ──");
    let t1 = Instant::now();
    let cache = node_cache::NodeCache::build(&cli.input, &cli.node_cache)?;
    eprintln!("  {} nodes in {:.1}s", cache.count(), t1.elapsed().as_secs_f64());

    // ── Pass 2: Extract features ──
    eprintln!("\n── Pass 2: Extract → spill ──");
    let t2 = Instant::now();
    let mut spiller = spill::Spiller::new(&cli.spill_dir, cli.num_buckets)?;
    let mut assembler = relations::RelationAssembler::new(&manifest);

    let reader = ElementReader::from_path(&cli.input)?;
    let mut ways_total = 0u64;
    let mut features_total = 0u64;
    let mut rels_assembled = 0u64;

    reader.for_each(|element| {
        match element {
            Element::Way(way) => {
                ways_total += 1;
                if ways_total % 2_000_000 == 0 {
                    eprintln!("  {:.1}M ways, {:.1}M features, {} rels assembled...",
                        ways_total as f64 / 1e6, features_total as f64 / 1e6, rels_assembled);
                }

                // Resolve coordinates
                let coords: Vec<[f64; 2]> = way.refs()
                    .filter_map(|nid| cache.get(nid))
                    .collect();

                // Check if this way is a member of any multipolygon relation
                let is_relation_member = manifest.way_to_relations.contains_key(&way.id());

                if is_relation_member && !coords.is_empty() {
                    // Cache geometry for relation assembly
                    let completed = assembler.add_way(way.id(), coords.clone(), &manifest);
                    for rel_id in completed {
                        if let Some((ring, tags, ftype)) = assembler.assemble(rel_id, &manifest) {
                            let extracted_tags = match ftype {
                                classify::FeatureType::Building => {
                                    let mut t = classify::Tags::new();
                                    for (k, v) in &tags {
                                        // Copy amenity/shop/healthcare/tourism/leisure from relation tags.
                                // WHY: Large buildings (hospitals, schools, malls) are often multipolygon
                                // relations. Without these tags, building_type_from_tags() can't classify
                                // them correctly — a hospital gets type 0 (residential) instead of 4.
                                if matches!(k.as_str(), "building" | "building:use" | "height" |
                                                     "building:levels" | "name" | "addr:street" | "addr:housenumber" |
                                                     "amenity" | "shop" | "healthcare" | "tourism" | "leisure") {
                                            t.insert(k.clone(), v.clone());
                                        }
                                    }
                                    if !t.contains_key("building") { t.insert("building".into(), "yes".into()); }
                                    t
                                }
                                classify::FeatureType::Industrial => {
                                    let mut t = classify::Tags::new();
                                    for (k, v) in &tags {
                                        // Copy operator/product/industrial from relation tags.
                                // WHY: Large industrial complexes are multipolygon relations.
                                // These tags enable NACE sector matching for emission profiles.
                                if matches!(k.as_str(), "landuse" | "man_made" | "name" |
                                                     "operator" | "product" | "industrial") {
                                            t.insert(k.clone(), v.clone());
                                        }
                                    }
                                    t
                                }
                                _ => tags.clone(),
                            };

                            let (clat, clon) = centroid(&ring);
                            if let Some(hex) = h3_res4(clat, clon) {
                                let wkb = if ring.len() >= 3 { Some(coords_to_wkb(&ring)) } else { None };
                                spiller.emit_polygon(&ftype, hex, rel_id, clat, clon,
                                    &extracted_tags, wkb.as_deref());
                                features_total += 1;
                                rels_assembled += 1;
                            }
                        }
                        assembler.cleanup(rel_id, &manifest);
                    }
                }

                // Also process the way itself if it has its own relevant tags
                // (a way can be both a relation member AND a standalone feature,
                //  but usually relation members don't have building= tags themselves)
                if let Some(ftype) = classify::classify_way(&way) {
                    // Skip if this way is an outer member of a building/industrial relation
                    // (the relation's tags take precedence)
                    if is_relation_member && matches!(ftype, classify::FeatureType::Building | classify::FeatureType::Industrial) {
                        return;
                    }

                    if ftype.is_linear() && coords.len() < 2 { return; }
                    if coords.is_empty() { return; }

                    let tags = classify::extract_way_tags(&way, &ftype);

                    if ftype.is_linear() {
                        let max_len = 250.0;
                        let segs = microsegment::split(&coords, max_len);
                        for (idx, seg) in segs.iter().enumerate() {
                            let mid_lat = (seg.0[0] + seg.1[0]) / 2.0;
                            let mid_lon = (seg.0[1] + seg.1[1]) / 2.0;
                            if let Some(hex) = h3_res4(mid_lat, mid_lon) {
                                spiller.emit_segment(&ftype, hex, way.id(), idx as i16, seg, &tags);
                                features_total += 1;
                            }
                        }
                    } else {
                        let (clat, clon) = centroid(&coords);
                        if let Some(hex) = h3_res4(clat, clon) {
                            let wkb = if coords.len() >= 3 { Some(coords_to_wkb(&coords)) } else { None };
                            spiller.emit_polygon(&ftype, hex, way.id(), clat, clon, &tags, wkb.as_deref());
                            features_total += 1;
                        }
                    }
                }
            }
            Element::Node(node) => {
                if classify::is_wind_turbine_node(&node) {
                    if let Some(hex) = h3_res4(node.lat(), node.lon()) {
                        let tags = classify::extract_turbine_tags_node(&node);
                        spiller.emit_polygon(
                            &classify::FeatureType::WindTurbine, hex, node.id(),
                            node.lat(), node.lon(), &tags, None,
                        );
                        features_total += 1;
                    }
                }
            }
            Element::DenseNode(node) => {
                if classify::is_wind_turbine_dense(&node) {
                    if let Some(hex) = h3_res4(node.lat(), node.lon()) {
                        let tags = classify::extract_turbine_tags_dense(&node);
                        spiller.emit_polygon(
                            &classify::FeatureType::WindTurbine, hex, node.id(),
                            node.lat(), node.lon(), &tags, None,
                        );
                        features_total += 1;
                    }
                }
            }
            _ => {}
        }
    })?;

    spiller.flush_all()?;
    eprintln!("  {:.1}M ways → {:.1}M features ({} multipolygon rels) in {:.1}s",
        ways_total as f64 / 1e6, features_total as f64 / 1e6, rels_assembled, t2.elapsed().as_secs_f64());

    // Free node cache before finalize (saves ~64 GB disk for planet)
    drop(cache);
    if cli.node_cache.exists() {
        eprintln!("  Deleting node cache to free disk...");
        std::fs::remove_file(&cli.node_cache).ok();
    }

    // ── Finalize ──
    eprintln!("\n── Finalize ──");
    let t3 = Instant::now();
    let hex_count = finalize::finalize(&cli.spill_dir, &cli.output, cli.num_buckets)?;
    eprintln!("  {} hex dirs in {:.1}s", hex_count, t3.elapsed().as_secs_f64());

    // node cache already deleted after Pass 2
    std::fs::remove_dir_all(&cli.spill_dir).ok();
    eprintln!("\n=== Done: {:.1}s ===", t0.elapsed().as_secs_f64());
    Ok(())
}

fn h3_res4(lat: f64, lon: f64) -> Option<u64> {
    use h3o::{LatLng, Resolution};
    let ll = LatLng::new(lat, lon).ok()?;
    Some(u64::from(ll.to_cell(Resolution::Four)))
}

fn centroid(coords: &[[f64; 2]]) -> (f64, f64) {
    let n = coords.len() as f64;
    (coords.iter().map(|c| c[0]).sum::<f64>() / n,
     coords.iter().map(|c| c[1]).sum::<f64>() / n)
}

fn coords_to_wkb(coords: &[[f64; 2]]) -> Vec<u8> {
    let n = coords.len() as u32 + 1;
    let mut w = Vec::with_capacity(9 + 4 + n as usize * 16);
    w.push(1);
    w.extend_from_slice(&3u32.to_le_bytes());
    w.extend_from_slice(&1u32.to_le_bytes());
    w.extend_from_slice(&n.to_le_bytes());
    for c in coords {
        w.extend_from_slice(&c[1].to_le_bytes());
        w.extend_from_slice(&c[0].to_le_bytes());
    }
    w.extend_from_slice(&coords[0][1].to_le_bytes());
    w.extend_from_slice(&coords[0][0].to_le_bytes());
    w
}
