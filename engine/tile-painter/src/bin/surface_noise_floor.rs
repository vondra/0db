//! Coarse-middle surface-heatmap accuracy harness — measures the per-cell Lden
//! error of the coarse-MIDDLE ray cadence (`fill_t_values_coarse_mid`) against
//! the method's OWN raster-phase NOISE FLOOR, on real CZ fixture tiles.
//!
//! The owner's accuracy bar is NOT "≤1 dB vs full-res": full-res itself jitters
//! 1–9 dB at obstacle edges from raster phase (base px ≈12 m vs 30 m DEM). So we
//! render the EXACT cadence at two raster phases (a half-cell halo-origin shift)
//! and require the coarse-middle error distribution to sit WITHIN that jitter
//! envelope. Per fixture/layer we print mean / p50 / p95 / p99 / max of both
//! FLOOR (= |exact_A − exact_B|) and DEV (= |coarse − exact_A|), the
//! ray-sample-count reduction, and a stride-axis artifact check (per-row error
//! autocorrelation at the stride lag — must show no periodic structure).
//!
//!   surface_noise_floor --h3r4-dir DIR --prepared-dir DIR [--stride N] \
//!                       [--src-zone-m M] [--rx-zone-m M] [--min-db D]
//!
//! Fixtures (CZ): dense LKPR rail z12/2210/1386, mixed Dobříš z12/2209/1393,
//! sparse rural z12/2208/1394 — the trio the quadtree what-if spike used.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use h3o::CellIndex;

use noise_compute::admin;
use noise_compute::periods::compute_lden;
use noise_compute::propagation::path_profile::{
    fill_t_values, fill_t_values_coarse_mid, CoarseMid,
};
use raster_reader::fused_tile_z13::{FusedTileZ13, TileBbox, TILE_PX};
use raster_reader::{FusedGrid, RealRasters};
use tile_painter::accumulator::{TileAccumulator, NUM_PERIODS};
use tile_painter::scatter_line::scatter_tile_with_cfg;
use tile_painter::scatter_point::scatter_tile_with_cfg as scatter_point_with_cfg;
use tile_painter::source_line::LineRow;
use tile_painter::source_loader_barrier::BarrierData;
use tile_painter::source_loader_industrial::IndustrialData;
use tile_painter::source_loader_rail::RailData;
use tile_painter::source_loader_road::RoadData;
use tile_painter::source_point::PointRow;

/// The same per-layer reach halo the surface builder uses (road 10 km, rail
/// 7 km, industrial 4 km) — a wider halo leaves output unchanged.
const ROAD_HALO_M: f64 = 10_000.0;
const RAIL_HALO_M: f64 = noise_compute::constants::RAILWAY_REACH_CEILING;
const INDUSTRIAL_HALO_M: f64 = noise_compute::constants::INDUSTRIAL_MAX_RADIUS;
/// 1 arc-second in degrees — the DEM cell. Half of it is the noise-floor phase.
const CELL_DEG: f64 = 1.0 / 3600.0;

#[derive(Parser, Debug)]
struct Args {
    #[arg(long)]
    h3r4_dir: PathBuf,
    #[arg(long)]
    prepared_dir: PathBuf,
    /// Coarse-middle stride to test (default 2 = the shipped default).
    #[arg(long, default_value_t = 2)]
    stride: usize,
    #[arg(long, default_value_t = 0.0)]
    src_zone_m: f64,
    #[arg(long, default_value_t = 0.0)]
    rx_zone_m: f64,
    /// Only cells ≥ this Lden are scored (audibility floor; matches the gate).
    #[arg(long, default_value_t = 30.0)]
    min_db: f64,
    #[arg(long, default_value_t = 12)]
    zoom: u8,
}

#[derive(Clone, Copy)]
enum Layer {
    Road,
    Rail,
    Industrial,
}
impl Layer {
    fn name(self) -> &'static str {
        match self {
            Layer::Road => "road",
            Layer::Rail => "rail",
            Layer::Industrial => "indus",
        }
    }
    fn halo_m(self) -> f64 {
        match self {
            Layer::Road => ROAD_HALO_M,
            Layer::Rail => RAIL_HALO_M,
            Layer::Industrial => INDUSTRIAL_HALO_M,
        }
    }
}

fn main() -> Result<()> {
    let args = Args::parse();
    let rasters = RealRasters::new(&args.prepared_dir);
    let _ = admin::init_admin_table(&admin::default_admin_path(&args.h3r4_dir));

    let cfg = CoarseMid {
        src_zone_m: args.src_zone_m,
        rx_zone_m: args.rx_zone_m,
        mid_stride: args.stride,
    };

    // (label, tile_x, tile_y) — same fixtures the quadtree what-if used.
    let fixtures = [
        ("dense_LKPR", 4420u32, 2773u32),
        ("mixed_Dobris", 4418, 2786),
        ("sparse_rural", 4416, 2788),
    ];

    println!(
        "coarse-middle harness · stride={} src_zone={:.0}m rx_zone={:.0}m · min_db={:.0}",
        args.stride, args.src_zone_m, args.rx_zone_m, args.min_db
    );
    report_cadence_reduction(&cfg);
    println!(
        "\n{:<14} {:<5} | {:>7} {:>7} {:>7} {:>7} {:>7} | {:>7} {:>7} {:>7} {:>7} {:>7} | {:>6} {:>8}",
        "fixture", "layer",
        "flr.mean", "flr.p50", "flr.p95", "flr.p99", "flr.max",
        "dev.mean", "dev.p50", "dev.p95", "dev.p99", "dev.max",
        "exceed", "artifact"
    );

    for (label, tx, ty) in fixtures {
        for layer in [Layer::Road, Layer::Rail, Layer::Industrial] {
            match score_tile(&rasters, &args, layer, args.zoom, tx, ty, cfg) {
                Ok(Some(r)) => r.print(label, layer),
                Ok(None) => println!("{label:<14} {:<5} | (no sources in reach)", layer.name()),
                Err(e) => println!("{label:<14} {:<5} | ERROR {e:#}", layer.name()),
            }
        }
    }
    Ok(())
}

/// Print the ray-sample-count reduction the coarse middle buys across distances.
fn report_cadence_reduction(cfg: &CoarseMid) {
    print!("ray-sample reduction:");
    for d in [1000.0, 3000.0, 5000.0, 7000.0, 10_000.0] {
        let mut a = Vec::new();
        let mut c = Vec::new();
        fill_t_values(d, &mut a);
        fill_t_values_coarse_mid(d, &mut c, *cfg);
        let red = 100.0 * (1.0 - c.len() as f64 / a.len() as f64);
        print!(
            "  {:.0}km {}->{} (-{:.0}%)",
            d / 1000.0,
            a.len(),
            c.len(),
            red
        );
    }
    println!();
}

struct Scored {
    floor: Stats,
    dev: Stats,
    exceed_pct: f64,
    /// `ac[stride] − max(neighbour-lag ac)`: a stride-banding artifact peaks here
    /// (>0). ≤0 ⇒ smooth error, no stride-aligned structure.
    artifact_peak: f64,
    /// Per-row error autocorrelation at lags 1..4 (lag 0 slot unused) — the raw
    /// curve behind `artifact_peak`, so a reader sees the monotonic decay.
    artifact_acs: [f64; 5],
    n_scored: usize,
}
impl Scored {
    fn print(&self, label: &str, layer: Layer) {
        let f = &self.floor;
        let d = &self.dev;
        println!(
            "{label:<14} {:<5} | {:>7.3} {:>7.3} {:>7.3} {:>7.3} {:>7.2} | {:>7.3} {:>7.3} {:>7.3} {:>7.3} {:>7.2} | {:>5.2}% {:>+8.3}",
            layer.name(),
            f.mean, f.p50, f.p95, f.p99, f.max,
            d.mean, d.p50, d.p95, d.p99, d.max,
            self.exceed_pct, self.artifact_peak,
        );
        println!(
            "{:<20} (n={}) err-autocorr lag1..4 = [{:.3} {:.3} {:.3} {:.3}]  (stride lag must NOT peak)",
            "", self.n_scored,
            self.artifact_acs[1], self.artifact_acs[2], self.artifact_acs[3], self.artifact_acs[4],
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn score_tile(
    rasters: &RealRasters,
    args: &Args,
    layer: Layer,
    zoom: u8,
    tx: u32,
    ty: u32,
    cfg: CoarseMid,
) -> Result<Option<Scored>> {
    let sources = load_sources(rasters, args, layer, zoom, tx, ty)?;
    if sources.is_empty() {
        return Ok(None);
    }
    let barriers = load_barriers(args, zoom, tx, ty)?;

    // Build the tile with its TRUE-phase halo + a half-cell-shifted-phase halo.
    let halo = Arc::new(build_halo(rasters, zoom, tx, ty, layer.halo_m()));
    let halo_shift = Arc::new(halo.with_origin_shift(0.5 * CELL_DEG, 0.5 * CELL_DEG));
    let tile_a = FusedTileZ13::build_with_halo(zoom, tx, ty, rasters, halo.clone());
    let tile_b = FusedTileZ13::build_with_halo(zoom, tx, ty, rasters, halo_shift);

    // Three renders: exact at phase A, exact at phase B (the floor), coarse at A.
    let lden_a = render_lden(&tile_a, &sources, &barriers, None);
    let lden_b = render_lden(&tile_b, &sources, &barriers, None);
    let lden_c = render_lden(&tile_a, &sources, &barriers, Some(cfg));

    let n = TILE_PX * TILE_PX;
    let mut floor = Vec::new();
    let mut dev = Vec::new();
    let mut exceed = 0usize;
    // Per-row dev grid for the artifact autocorrelation (NaN = unscored cell).
    let mut dev_grid = vec![f64::NAN; n];
    for idx in 0..n {
        let (a, b, c) = (lden_a[idx], lden_b[idx], lden_c[idx]);
        // Score a cell only where the EXACT field is audible (≥ min_db).
        if !a.is_finite() || a < args.min_db {
            continue;
        }
        let fl = if b.is_finite() { (a - b).abs() } else { 0.0 };
        let dv = if c.is_finite() { (a - c).abs() } else { a }; // coarse dropped it → full miss
        floor.push(fl);
        dev.push(dv);
        dev_grid[idx] = dv;
        // The bar: coarse DEV must not exceed max(FLOOR, 0.5 dB) (tiles quantize
        // 0.5 dB/step, so sub-quantum error in open cells where FLOOR≈0 is free).
        if dv > fl.max(0.5) {
            exceed += 1;
        }
    }
    if floor.is_empty() {
        return Ok(None);
    }
    let n_scored = floor.len();
    let exceed_pct = 100.0 * exceed as f64 / n_scored as f64;
    // Artifact probe: a stride-aligned banding pattern would show a PEAK in the
    // per-row error autocorrelation AT the stride lag, standing out above the
    // neighbouring lags. A naturally-smooth error field instead DECAYS
    // monotonically with lag (no peak). We report ac at lags 1..4 so a stride
    // peak (ac[stride] > ac[stride-1] AND > ac[stride+1]) is visible; the headline
    // `artifact` number is `ac[stride] − max(neighbour lags)` (≤0 ⇒ no peak ⇒ no
    // banding; >0 ⇒ investigate).
    let acs: [f64; 5] = std::array::from_fn(|lag| autocorr_x(&dev_grid, lag.max(1)));
    let s = cfg.mid_stride.clamp(1, 4);
    let neighbour = acs[(s - 1).max(1)].max(acs[(s + 1).min(4)]);
    let artifact_peak = acs[s] - neighbour;

    Ok(Some(Scored {
        floor: Stats::of(&mut floor),
        dev: Stats::of(&mut dev),
        exceed_pct,
        artifact_peak,
        artifact_acs: acs,
        n_scored,
    }))
}

/// Loaded sources for one (fixture, layer) — line (road/rail) or point (indus).
enum Sources {
    Line(Vec<LineRow>),
    Point(Vec<PointRow>),
}
impl Sources {
    fn is_empty(&self) -> bool {
        match self {
            Sources::Line(v) => v.is_empty(),
            Sources::Point(v) => v.is_empty(),
        }
    }
}

/// Run the real LINE or POINT kernel and collapse to FLOAT Lden per cell (no u8
/// quantise — the noise-floor compares sub-quantum error).
fn render_lden(
    tile: &FusedTileZ13,
    sources: &Sources,
    barriers: &[noise_compute::types::Barrier],
    cfg: Option<CoarseMid>,
) -> Vec<f64> {
    let mut acc = TileAccumulator::new();
    match sources {
        Sources::Line(rows) => {
            scatter_tile_with_cfg(tile, rows, barriers, &mut acc, cfg);
        }
        Sources::Point(rows) => {
            scatter_point_with_cfg(tile, rows, barriers, &mut acc, cfg);
        }
    }
    let n = TILE_PX * TILE_PX;
    let mut out = vec![f64::NEG_INFINITY; n];
    // `idx` maps a cell to both `out[idx]` and the flat `acc.energy[base + …]`
    // stripe (`base = idx * NUM_PERIODS`) — kept as a range index for that reason.
    #[allow(clippy::needless_range_loop)]
    for idx in 0..n {
        let base = idx * NUM_PERIODS;
        let (e0, e1, e2) = (
            acc.energy[base] as f64,
            acc.energy[base + 1] as f64,
            acc.energy[base + 2] as f64,
        );
        if e0 <= 0.0 && e1 <= 0.0 && e2 <= 0.0 {
            continue;
        }
        // Surface steady-power collapse: period level = 10·log10(power).
        let ld = if e0 > 0.0 {
            10.0 * e0.log10()
        } else {
            f64::NEG_INFINITY
        };
        let le = if e1 > 0.0 {
            10.0 * e1.log10()
        } else {
            f64::NEG_INFINITY
        };
        let ln = if e2 > 0.0 {
            10.0 * e2.log10()
        } else {
            f64::NEG_INFINITY
        };
        out[idx] = compute_lden(ld, le, ln);
    }
    out
}

fn load_sources(
    rasters: &RealRasters,
    args: &Args,
    layer: Layer,
    zoom: u8,
    tx: u32,
    ty: u32,
) -> Result<Sources> {
    let ring = region_ring(zoom, tx, ty);
    let _ = rasters;
    Ok(match layer {
        Layer::Road => {
            let bbox = TileBbox::from_xyz(zoom, tx, ty);
            let (lat, lon) = (
                0.5 * (bbox.north_lat + bbox.south_lat),
                0.5 * (bbox.west_lon + bbox.east_lon),
            );
            Sources::Line(
                RoadData::load_for_r4s(&args.h3r4_dir, &ring, admin::admin_for_latlng(lat, lon))
                    .context("load roads")?
                    .into_rows(),
            )
        }
        Layer::Rail => {
            let bbox = TileBbox::from_xyz(zoom, tx, ty);
            let (lat, lon) = (
                0.5 * (bbox.north_lat + bbox.south_lat),
                0.5 * (bbox.west_lon + bbox.east_lon),
            );
            Sources::Line(
                RailData::load_for_r4s(&args.h3r4_dir, &ring, admin::admin_for_latlng(lat, lon))
                    .context("load railways")?
                    .into_rows(),
            )
        }
        Layer::Industrial => Sources::Point(
            IndustrialData::load_for_r4s(&args.h3r4_dir, &ring)
                .context("load industrial")?
                .into_rows(),
        ),
    })
}

fn load_barriers(
    args: &Args,
    zoom: u8,
    tx: u32,
    ty: u32,
) -> Result<Vec<noise_compute::types::Barrier>> {
    let ring = region_ring(zoom, tx, ty);
    let bbox = TileBbox::from_xyz(zoom, tx, ty);
    let data = BarrierData::load_for_r4s(&args.h3r4_dir, &ring).context("load barriers")?;
    Ok(data.for_tile(&bbox, ROAD_HALO_M))
}

/// The tile's centre R4 grid_disk(1) as u64 hexes — the loader's region ring.
fn region_ring(zoom: u8, tx: u32, ty: u32) -> Vec<u64> {
    let bbox = TileBbox::from_xyz(zoom, tx, ty);
    let lat = 0.5 * (bbox.north_lat + bbox.south_lat);
    let lon = 0.5 * (bbox.west_lon + bbox.east_lon);
    let ll = h3o::LatLng::new(lat, lon).expect("valid latlng");
    let r4 = ll.to_cell(h3o::Resolution::Four);
    let _: CellIndex = r4;
    r4.grid_disk::<Vec<_>>(1)
        .into_iter()
        .map(u64::from)
        .collect()
}

fn build_halo(rasters: &RealRasters, zoom: u8, tx: u32, ty: u32, halo_m: f64) -> FusedGrid {
    use noise_compute::constants::{m_per_deg_lon, M_PER_DEG_LAT};
    let bbox = TileBbox::from_xyz(zoom, tx, ty);
    let centre_lat = 0.5 * (bbox.north_lat + bbox.south_lat);
    let halo_lat_deg = halo_m / M_PER_DEG_LAT;
    let halo_lon_deg = halo_m / m_per_deg_lon(centre_lat.to_radians()).max(1.0);
    FusedGrid::build(
        rasters,
        bbox.south_lat - halo_lat_deg,
        bbox.north_lat + halo_lat_deg,
        bbox.west_lon - halo_lon_deg,
        bbox.east_lon + halo_lon_deg,
    )
}

/// Mean (over rows) per-row error autocorrelation at horizontal lag `lag` — the
/// stride axis. A stride-aligned banding artifact would PEAK at `lag = stride`
/// above the neighbouring lags; a naturally-smooth error field decays
/// monotonically (no peak). Each row is centred on its OWN finite-cell mean/var
/// (a global mean would inject a low-frequency trend that fakes high lag-k
/// correlation). Rows averaged so a few noisy short rows don't dominate.
fn autocorr_x(dev_grid: &[f64], lag: usize) -> f64 {
    let lag = lag.max(1);
    let mut sum_ac = 0.0;
    let mut n_rows = 0usize;
    for py in 0..TILE_PX {
        let row = &dev_grid[py * TILE_PX..(py + 1) * TILE_PX];
        let vals: Vec<f64> = row.iter().copied().filter(|v| v.is_finite()).collect();
        if vals.len() < 4 * lag + 4 {
            continue;
        }
        let mean = vals.iter().sum::<f64>() / vals.len() as f64;
        let var = vals.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / vals.len() as f64;
        if var < 1e-12 {
            continue;
        }
        let mut cov = 0.0;
        let mut npair = 0usize;
        for px in 0..(TILE_PX - lag) {
            let (a, b) = (row[px], row[px + lag]);
            if a.is_finite() && b.is_finite() {
                cov += (a - mean) * (b - mean);
                npair += 1;
            }
        }
        if npair >= 8 {
            sum_ac += (cov / npair as f64) / var;
            n_rows += 1;
        }
    }
    if n_rows == 0 {
        0.0
    } else {
        sum_ac / n_rows as f64
    }
}

struct Stats {
    mean: f64,
    p50: f64,
    p95: f64,
    p99: f64,
    max: f64,
}
impl Stats {
    fn of(v: &mut [f64]) -> Stats {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = v.len();
        let mean = v.iter().sum::<f64>() / n as f64;
        let pct = |p: f64| v[((n as f64 * p) as usize).min(n - 1)];
        Stats {
            mean,
            p50: pct(0.50),
            p95: pct(0.95),
            p99: pct(0.99),
            max: v[n - 1],
        }
    }
}
