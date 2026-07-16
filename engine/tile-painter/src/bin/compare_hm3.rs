//! Compare two HM3 tiles cell-by-cell and report Lden drift.
//! Used to gate approximations (coarse-grid, 1 Hz aggregation) against an
//! exact baseline under the engine's ±0.5 dB tile tolerance.
//!
//! Usage: `compare_hm3 <baseline.bin> <candidate.bin>`

use std::path::Path;

use tile_painter::wire_hm3::{self, NO_DATA};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: compare_hm3 <baseline.bin> <candidate.bin>");
        std::process::exit(2);
    }
    let base = wire_hm3::read_tile(Path::new(&args[1]))?;
    let cand = wire_hm3::read_tile(Path::new(&args[2]))?;
    assert_eq!(base.len(), cand.len(), "tile cell counts differ");

    let mut both = 0usize;
    let mut diff_sum = 0.0f64;
    let mut max_diff = 0.0f64;
    let mut over_05 = 0usize;
    let mut over_10 = 0usize;
    let mut presence_changed = 0usize;
    for (&a, &b) in base.iter().zip(cand.iter()) {
        let a_data = a != NO_DATA;
        let b_data = b != NO_DATA;
        if a_data != b_data {
            presence_changed += 1;
            continue;
        }
        if a_data {
            both += 1;
            let d = (i16::from(a) - i16::from(b)).unsigned_abs() as f64 * 0.5;
            diff_sum += d;
            max_diff = max_diff.max(d);
            over_05 += usize::from(d > 0.5);
            over_10 += usize::from(d > 1.0);
        }
    }
    let mean = if both > 0 {
        diff_sum / both as f64
    } else {
        0.0
    };
    println!(
        "both={both} mean_abs_db={mean:.4} max_abs_db={max_diff:.3} \
         cells>0.5dB={over_05} cells>1.0dB={over_10} presence_changed={presence_changed}"
    );
    Ok(())
}
