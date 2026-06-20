use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use arrow::array::UInt16Array;
use arrow::datatypes::Schema;
use arrow::ipc::reader::FileReader;
use arrow::ipc::writer::FileWriter;
use arrow::record_batch::RecordBatch;
use noise_compute::sources::provenance_of;
use rayon::prelude::*;

#[derive(Default, Clone, Copy)]
struct Totals {
    hexes: usize,
    rows: usize,
    default_segments: usize,
    matched_external_segments: usize,
    estimated_service_tree_segments: usize,
}

fn usage() -> ! {
    eprintln!("Usage: road-arrow-upgrade <prepared_h3r4_dir> [hex_file]");
    std::process::exit(2);
}

fn main() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let prepared_dir = PathBuf::from(args.next().unwrap_or_else(|| usage()));
    let hex_file = args.next().map(PathBuf::from);
    if args.next().is_some() {
        usage();
    }

    let target_hexes = target_hexes(&prepared_dir, hex_file.as_deref())?;
    if target_hexes.is_empty() {
        eprintln!("no target roads.arrow files found");
        return Ok(());
    }

    let run_at_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs()
        .to_string();

    let totals = target_hexes
        .par_iter()
        .map(|hex_id| upgrade_hex(&prepared_dir, hex_id, &run_at_unix))
        .try_reduce(Totals::default, |a, b| {
            Ok(Totals {
                hexes: a.hexes + b.hexes,
                rows: a.rows + b.rows,
                default_segments: a.default_segments + b.default_segments,
                matched_external_segments: a.matched_external_segments
                    + b.matched_external_segments,
                estimated_service_tree_segments: a.estimated_service_tree_segments
                    + b.estimated_service_tree_segments,
            })
        })?;

    eprintln!(
        "upgraded {} hexes, {} rows | default={} matched_external={} estimated_service_tree={}",
        totals.hexes,
        totals.rows,
        totals.default_segments,
        totals.matched_external_segments,
        totals.estimated_service_tree_segments
    );
    Ok(())
}

fn target_hexes(prepared_dir: &Path, hex_file: Option<&Path>) -> Result<Vec<String>, String> {
    if let Some(hex_file) = hex_file {
        let content = std::fs::read_to_string(hex_file).map_err(|e| e.to_string())?;
        let mut hexes = Vec::new();
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if prepared_dir.join(trimmed).join("roads.arrow").exists() {
                hexes.push(trimmed.to_string());
            }
        }
        hexes.sort();
        hexes.dedup();
        return Ok(hexes);
    }

    let mut hexes = Vec::new();
    for entry in fs::read_dir(prepared_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.path().join("roads.arrow").exists() {
            hexes.push(name);
        }
    }
    hexes.sort();
    Ok(hexes)
}

fn upgrade_hex(prepared_dir: &Path, hex_id: &str, run_at_unix: &str) -> Result<Totals, String> {
    let path = prepared_dir.join(hex_id).join("roads.arrow");
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let reader = FileReader::try_new(file, None).map_err(|e| e.to_string())?;

    let old_schema = reader.schema();
    let mut metadata = old_schema.metadata().clone();
    let mut batches = Vec::new();
    let mut default_segments = 0usize;
    let mut matched_external_segments = 0usize;
    let mut estimated_service_tree_segments = 0usize;
    let mut rows = 0usize;

    for batch in reader {
        let batch = batch.map_err(|e| e.to_string())?;
        rows += batch.num_rows();

        // source_id replaced the `traffic_source` column the rename deleted
        // (that dead read silently bucketed every row `default` — the bug this
        // fixes). Fold through the canonical `legacy_traffic_source_str()`, the
        // same fold the engine uses (traces.rs:529). These are coverage counts
        // (segments per source tier) — unlike the engine they skip the
        // `aadt_light > 0` gate, so a stamped zero-AADT row counts enriched here
        // but shows as default in the popup (intended: this audits enricher reach).
        if let Some(sids) = batch
            .column_by_name("source_id")
            .and_then(|arr| arr.as_any().downcast_ref::<UInt16Array>())
        {
            for i in 0..batch.num_rows() {
                match provenance_of(sids.value(i)).legacy_traffic_source_str() {
                    "matched_external" => matched_external_segments += 1,
                    "estimated_service_tree" => estimated_service_tree_segments += 1,
                    "default_by_class" => default_segments += 1,
                    // An unknown bucket means the fold's contract changed — fail
                    // loud, don't silently miscount (the bug class this kills).
                    other => {
                        return Err(format!(
                        "unexpected traffic_source bucket {other:?} (source_id {}, hex {hex_id})",
                        sids.value(i)
                    ))
                    }
                }
            }
        } else {
            default_segments += batch.num_rows();
        }

        batches.push(batch);
    }

    metadata.insert("road_traffic_source_schema".to_string(), "v1".to_string());
    metadata.insert("road_service_tree_version".to_string(), "v2".to_string());
    metadata.insert(
        "road_service_tree_run_at_unix".to_string(),
        run_at_unix.to_string(),
    );
    metadata.insert("road_segments_total".to_string(), rows.to_string());
    metadata.insert(
        "road_segments_default_by_class".to_string(),
        default_segments.to_string(),
    );
    metadata.insert(
        "road_segments_matched_external".to_string(),
        matched_external_segments.to_string(),
    );
    metadata.insert(
        "road_segments_estimated_service_tree".to_string(),
        estimated_service_tree_segments.to_string(),
    );

    let new_schema = Arc::new(Schema::new_with_metadata(
        old_schema.fields().clone(),
        metadata,
    ));

    let upgraded_batches: Vec<RecordBatch> = batches
        .into_iter()
        .map(|batch| {
            RecordBatch::try_new(new_schema.clone(), batch.columns().to_vec())
                .map_err(|e| e.to_string())
        })
        .collect::<Result<_, _>>()?;

    let tmp_path = path.with_extension("arrow.tmp");
    let file = File::create(&tmp_path).map_err(|e| e.to_string())?;
    let mut writer = FileWriter::try_new(file, &new_schema).map_err(|e| e.to_string())?;
    for batch in &upgraded_batches {
        writer.write(batch).map_err(|e| e.to_string())?;
    }
    writer.finish().map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;

    Ok(Totals {
        hexes: 1,
        rows,
        default_segments,
        matched_external_segments,
        estimated_service_tree_segments,
    })
}
