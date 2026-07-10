//! rebatch-arrow: rewrite EXISTING per-hex arrow files through the
//! spatially-batched writer path (engine/arrow-batching) into a scratch H3R4
//! dir — the parity harness for popup batch pruning
//! (docs/dev/popup-batch-pruning.md §Verification). The live extract stays
//! untouched; a second server instance pointed at the scratch dir must
//! produce identical popup numbers (0.000 dB) on the reference cells, which
//! proves the NEW multi-batch format + reader pruning end to end without
//! waiting for a world re-extract.
//!
//! Usage: rebatch-arrow <src_h3r4_dir> <dst_h3r4_dir> <hex> [<hex>...]

use std::fs;
use std::path::Path;
use std::process::ExitCode;

use arrow::array::{Array, BinaryArray, Float32Array, Float64Array};
use arrow::compute::concat_batches;
use arrow::ipc::reader::FileReader;
use arrow::ipc::writer::FileWriter;
use arrow::record_batch::RecordBatch;
use arrow_batching::RowBbox;

// Standalone like road-arrow-upgrade: importing the lib would link the napi
// rlib into a plain binary (undefined node symbols). Three tiny accessors
// beat that.
fn col_f64<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a Float64Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
fn col_f32<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a Float32Array> {
    b.column_by_name(name)?.as_any().downcast_ref()
}
fn col_binary<'a>(b: &'a RecordBatch, name: &str) -> Option<&'a BinaryArray> {
    b.column_by_name(name)?.as_any().downcast_ref()
}

/// How to derive each row's bbox — mirrors what the real writers do.
enum BboxMode {
    /// f64 start/end lat/lon columns (roads, railways, barriers, airport_lines).
    SegmentF64,
    /// f32 start/end lat/lon columns (airport_traffic).
    SegmentF32,
    /// centroid + optional WKB footprint (buildings, industrial, leisure).
    Polygon,
    /// f32 per-row bbox columns (airborne).
    AirborneColumns,
    /// Writer unchanged (cruise, synth_airport_lines) — copy byte-identical.
    Verbatim,
}

const FILES: [(&str, BboxMode); 11] = [
    ("roads.arrow", BboxMode::SegmentF64),
    ("railways.arrow", BboxMode::SegmentF64),
    ("buildings.arrow", BboxMode::Polygon),
    ("barriers.arrow", BboxMode::SegmentF64),
    ("industrial.arrow", BboxMode::Polygon),
    ("leisure.arrow", BboxMode::Polygon),
    ("airborne.arrow", BboxMode::AirborneColumns),
    ("cruise.arrow", BboxMode::Verbatim),
    ("airport_traffic.arrow", BboxMode::SegmentF32),
    ("airport_lines.arrow", BboxMode::SegmentF64),
    ("synth_airport_lines.arrow", BboxMode::Verbatim),
];

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("usage: rebatch-arrow <src_h3r4_dir> <dst_h3r4_dir> <hex> [<hex>...]");
        return ExitCode::FAILURE;
    }
    let src_root = Path::new(&args[0]);
    let dst_root = Path::new(&args[1]);
    // Hermetic-harness guards (Codex /gg 2026-07-10): the destination is a
    // throwaway scratch — refuse aliasing the live extract, refuse adopting
    // a stale destination hex (leftover layers would poison the parity).
    let src_canon = fs::canonicalize(src_root).unwrap_or_else(|_| src_root.to_path_buf());
    if let Ok(dst_canon) = fs::canonicalize(dst_root) {
        if dst_canon.starts_with(&src_canon) || src_canon.starts_with(&dst_canon) {
            eprintln!("rebatch-arrow: src and dst overlap ({src_canon:?} vs {dst_canon:?}) — refusing to touch the live extract");
            return ExitCode::FAILURE;
        }
    }
    for hex in &args[2..] {
        if hex.len() != 15 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            eprintln!("rebatch-arrow: {hex} is not a 15-hex-digit H3 R4 id");
            return ExitCode::FAILURE;
        }
        if let Err(e) = rebatch_hex(&src_root.join(hex), &dst_root.join(hex)) {
            eprintln!("rebatch {hex} FAILED: {e}");
            return ExitCode::FAILURE;
        }
        println!("rebatched {hex}");
    }
    ExitCode::SUCCESS
}

fn rebatch_hex(src_dir: &Path, dst_dir: &Path) -> Result<(), String> {
    if !src_dir.exists() {
        return Err(format!("missing source hex dir {}", src_dir.display()));
    }
    if dst_dir.exists() {
        return Err(format!(
            "destination hex dir {} already exists — use a fresh scratch dir",
            dst_dir.display()
        ));
    }
    fs::create_dir_all(dst_dir).map_err(|e| e.to_string())?;
    for (name, mode) in FILES {
        let src = src_dir.join(name);
        if !src.exists() {
            continue;
        }
        let dst = dst_dir.join(name);
        match mode {
            BboxMode::Verbatim => {
                fs::copy(&src, &dst).map_err(|e| e.to_string())?;
            }
            _ => rebatch_file(&src, &dst, &mode)?,
        }
        println!("  {name}");
    }
    Ok(())
}

fn rebatch_file(src: &Path, dst: &Path, mode: &BboxMode) -> Result<(), String> {
    let file = fs::File::open(src).map_err(|e| e.to_string())?;
    let reader = FileReader::try_new(file, None).map_err(|e| e.to_string())?;
    let schema = reader.schema();
    let batches: Vec<RecordBatch> = reader
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    if total_rows == 0 {
        fs::copy(src, dst).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let merged = concat_batches(&schema, &batches).map_err(|e| e.to_string())?;
    let row_bboxes = derive_bboxes(&merged, mode)?;
    let (schema, out_batches) = arrow_batching::spatially_batched(
        (*schema).clone(),
        merged.columns().to_vec(),
        &row_bboxes,
    )
    .map_err(|e| e.to_string())?;
    let tmp = dst.with_extension("arrow.tmp");
    let out = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut writer = FileWriter::try_new(out, &schema).map_err(|e| e.to_string())?;
    for b in &out_batches {
        writer.write(b).map_err(|e| e.to_string())?;
    }
    writer.finish().map_err(|e| e.to_string())?;
    fs::rename(&tmp, dst).map_err(|e| e.to_string())?;
    Ok(())
}

fn derive_bboxes(batch: &RecordBatch, mode: &BboxMode) -> Result<Vec<RowBbox>, String> {
    let n = batch.num_rows();
    let mut out = Vec::with_capacity(n);
    match mode {
        BboxMode::SegmentF64 => {
            let (Some(sla), Some(slo), Some(ela), Some(elo)) = (
                col_f64(batch, "start_lat"),
                col_f64(batch, "start_lon"),
                col_f64(batch, "end_lat"),
                col_f64(batch, "end_lon"),
            ) else {
                return Err("segment columns missing".into());
            };
            for i in 0..n {
                let (a, b, c, d) = (sla.value(i), slo.value(i), ela.value(i), elo.value(i));
                out.push([a.min(c), b.min(d), a.max(c), b.max(d)]);
            }
        }
        BboxMode::SegmentF32 => {
            let (Some(sla), Some(slo), Some(ela), Some(elo)) = (
                col_f32(batch, "start_lat"),
                col_f32(batch, "start_lon"),
                col_f32(batch, "end_lat"),
                col_f32(batch, "end_lon"),
            ) else {
                return Err("segment f32 columns missing".into());
            };
            for i in 0..n {
                let (a, b) = (sla.value(i) as f64, slo.value(i) as f64);
                let (c, d) = (ela.value(i) as f64, elo.value(i) as f64);
                out.push([a.min(c), b.min(d), a.max(c), b.max(d)]);
            }
        }
        BboxMode::Polygon => {
            let (Some(cla), Some(clo)) = (
                col_f64(batch, "centroid_lat"),
                col_f64(batch, "centroid_lon"),
            ) else {
                return Err("centroid columns missing".into());
            };
            let wkb = col_binary(batch, "polygon_wkb");
            for i in 0..n {
                let bbox = wkb
                    .filter(|w| w.is_valid(i))
                    .and_then(|w| {
                        let hex = hex_encode(w.value(i));
                        noise_compute::wkb::WkbFootprint::parse(&hex)
                    })
                    .map(|fp| {
                        let (min_lat, max_lat, min_lon, max_lon) = fp.bbox();
                        [min_lat, min_lon, max_lat, max_lon]
                    })
                    .unwrap_or([cla.value(i), clo.value(i), cla.value(i), clo.value(i)]);
                out.push(bbox);
            }
        }
        BboxMode::AirborneColumns => {
            let (Some(mla), Some(xla), Some(mlo), Some(xlo)) = (
                col_f32(batch, "bbox_min_lat"),
                col_f32(batch, "bbox_max_lat"),
                col_f32(batch, "bbox_min_lon"),
                col_f32(batch, "bbox_max_lon"),
            ) else {
                return Err("airborne bbox columns missing".into());
            };
            for i in 0..n {
                out.push([
                    mla.value(i) as f64,
                    mlo.value(i) as f64,
                    xla.value(i) as f64,
                    xlo.value(i) as f64,
                ]);
            }
        }
        BboxMode::Verbatim => unreachable!("verbatim files never reach derive_bboxes"),
    }
    Ok(out)
}

/// Local copy of the crate-private `hex_store::hex_encode` — bins link the
/// rlib and only see pub items; 8 lines beat widening the lib surface.
fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}
