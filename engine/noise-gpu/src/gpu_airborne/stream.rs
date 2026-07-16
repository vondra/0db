//! STREAM mode (`--stream`) for the gpu-airborne bin: the persistent warm worker the cluster
//! orchestrator feeds — an A2 CPU-prep / GPU-build double-buffer over R4 cells read from stdin,
//! reusing one CUDA context + LUTs + rasters across cells (no per-chunk process spawn).

use anyhow::{bail, Context, Result};
use noise_gpu::airborne::{is_cell_unbuildable, AirborneGpu};
use raster_reader::fused_tile_z13::default_batch_size;
use raster_reader::RealRasters;
use tile_painter::r4_source_cache::R4SourceCache;
use tile_painter::region_runner::region_tiles;
use tile_painter::worklist::{any_source_arrow, resolve_n_days};

use crate::build::build_prepared_cell;
use crate::prep::{prep_cell, PreparedCell};
use crate::{ring_union, Args, SEL};

/// Shared streaming work queue: (pending Morton-ordered cells, stream-closed flag) under a mutex,
/// plus a condvar to park idle workers. Workers drain a contiguous run off the front; the stdin
/// reader pushes to the back and wakes one. (Factored to a type alias so the `let` below isn't a
/// clippy `type_complexity` lint.)
type StreamQueue = std::sync::Arc<(
    std::sync::Mutex<(std::collections::VecDeque<u64>, bool)>,
    std::sync::Condvar,
)>;

/// STREAM mode (`--stream`): the persistent warm worker the cluster orchestrator feeds — the
/// answer to the per-chunk process spawn + inter-chunk staging stall (~39% of box wall-time)
/// that capped the cluster's GPU at ~61% effective (a warm process sustains ~88-100%, STEP 1).
/// One process: CUDA context + NPD LUTs + class-weights + RealRasters all resident; R4 cell IDs
/// stream in on stdin and each is built by an A2 CPU-prep / GPU-build double-buffer — ONE prep
/// thread (its own `RealRasters` + R4 LRU) packs the NEXT cell while ONE GPU thread (one CUDA
/// stream, so exactly one cell's region in VRAM — no OOM, no cell loss) builds the current one.
/// The two stages are joined by a depth-1 `sync_channel`, so the prep thread runs at most one
/// cell ahead (host RAM stays ~2-3 cells) and the GPU stays saturated across each cell's CPU
/// prep instead of idling ~25% as in the serial per-worker loop. One `done <r4hex> <written>
/// <skipped> <ms>` (or `fail <r4hex> <err>`) line prints per cell AS IT FINISHES (the GPU thread
/// is the sole writer → no interleave), so the orchestrator can ACK + advance its lease without
/// waiting for the whole stream. n_days + class_weights resolve ONCE from `--seed-regions` (the
/// orchestrator's representative source set); the streamed cells inherit that build-wide value,
/// exactly as every chunk did in the batch cluster.
///
/// Termination / deadlock-freedom: the reader (main scope thread) parses stdin onto the Morton
/// work queue; on EOF it sets the closed flag + `notify_all`. The prep thread drains contiguous
/// runs (PULL_BATCH) and on "closed + empty" breaks its loop, returns, and DROPS its `Sender`.
/// `gpu_tx` was moved into the prep thread, so when prep exits the channel closes; the GPU
/// thread's `for msg in rx` then ends, and the scope joins both. No stage can block forever: the
/// bounded `send` only blocks while the channel is full, which the GPU thread always eventually
/// drains (it never blocks except on that same `rx`); the prep `cv.wait` is always woken by the
/// reader's per-cell `notify_one` or the EOF `notify_all`.
pub(crate) fn run_stream(args: &Args, z: u8) -> Result<()> {
    use std::collections::VecDeque;
    use std::io::{BufRead, Write};
    use std::sync::mpsc::sync_channel;
    use std::sync::{Arc, Condvar, Mutex};

    let seed = args.seed_regions.as_ref().context(
        "--stream requires --seed-regions (resolves the build-wide n_days + class_weights)",
    )?;
    let seed_r4s = tile_painter::region_runner::read_r4_file(seed)?;
    let source_r4s = ring_union(seed_r4s.iter().copied());
    if !any_source_arrow(&args.h3r4_dir, &source_r4s, SEL)? {
        bail!("--seed-regions has no airborne source — cannot resolve class_weights");
    }
    let resolved = resolve_n_days(&args.h3r4_dir, &source_r4s, SEL)?;
    let n_days = match args.n_days {
        Some(cli) if cli != resolved => {
            bail!("--n-days {cli} disagrees with arrow metadata ({resolved})")
        }
        _ => resolved,
    };
    let class_weights =
        tile_painter::worklist::resolve_class_weights(&args.h3r4_dir, &source_r4s, SEL, n_days)?;
    let bn = if args.batch_size == 0 {
        default_batch_size()
    } else {
        args.batch_size
    };
    eprintln!(
        "stream: n_days={n_days}, batch={bn}, A2 prep+GPU pipeline — reading R4 cells from stdin"
    );

    // Morton-locality work queue. The single prep thread pulls a CONTIGUOUS run of up to
    // PULL_BATCH cells from the front of a shared queue the reader fills in arrival (= the
    // orchestrator's Morton) order, so its grid_disk(1) ring-cache stays warm across the run —
    // even better than the old per-worker pool, which split the Morton stream across K caches.
    // The mutex is held only to splice a run off the front (cheap); prep_cell runs unlocked.
    const PULL_BATCH: usize = 4;
    let work: StreamQueue = Arc::new((Mutex::new((VecDeque::new(), false)), Condvar::new()));
    // Depth-1: the prep thread may have 1 cell buffered in the channel + 1 in flight (its `send`
    // blocks on the 2nd), while the GPU thread holds the 1 it is building → host RAM ≈ 3 cells.
    let (gpu_tx, gpu_rx) = sync_channel::<(u64, Result<PreparedCell>)>(1);

    std::thread::scope(|scope| {
        // PREP THREAD (CPU only — no device touch). Owns its own RealRasters + R4 LRU (PER-prep,
        // not shared: it then locks only its OWN tile-store mutexes, the fix that broke the flat
        // 41%-CPU airborne ceiling — see 7746b452). Pulls Morton-contiguous runs, prep_cells each,
        // and sends `(r4, Result<PreparedCell>)` (the depth-1 `send` blocks when the channel is
        // full — the desired backpressure). Owns the ONLY Sender, so on exit the channel closes.
        let prep_work = Arc::clone(&work);
        scope.spawn(move || {
            let rasters = RealRasters::new(&args.prepared_dir);
            let mut cache = R4SourceCache::new(&args.h3r4_dir, args.r4_cache.max(7), SEL);
            loop {
                let batch: Vec<u64> = {
                    let (lock, cv) = &*prep_work;
                    let mut g = lock.lock().unwrap();
                    loop {
                        if !g.0.is_empty() {
                            let take = g.0.len().min(PULL_BATCH);
                            break g.0.drain(..take).collect();
                        }
                        if g.1 {
                            break Vec::new(); // stream closed + drained → exit
                        }
                        g = cv.wait(g).unwrap();
                    }
                };
                if batch.is_empty() {
                    break; // → return → drop gpu_tx → channel closes → GPU thread's `for` ends
                }
                for r4 in batch {
                    let tiles = region_tiles(r4, z);
                    let prepared = prep_cell(&rasters, &mut cache, z, bn, r4, &tiles);
                    // A prep error (CPU/IO/source-load) is forwarded so the GPU thread reports it
                    // through the SAME A1 classification (non-OOM → exit(1)). If the GPU thread has
                    // already gone (rx dropped), send fails → drop the work and exit gracefully.
                    if gpu_tx.send((r4, prepared)).is_err() {
                        return;
                    }
                }
            }
        });

        // GPU THREAD (the only device-touching stage). Owns ONE AirborneGpu — one CUDA stream, so
        // exactly one cell's region is resident in VRAM at a time (A2 overlaps CPU prep, NOT GPU
        // concurrency: the threads=1 VRAM-safety is preserved). Sole stdout writer. Owns the ONLY
        // Receiver; the loop ends when the prep thread drops the Sender.
        let class_weights = &class_weights;
        scope.spawn(move || {
            let gpu = AirborneGpu::new(class_weights);
            // Own cache + rasters for the M2 chunked fallback (a too-big cell never crossed the prep
            // channel with a SoA, so the GPU thread re-loads its sources here). Idle for the common
            // one-pass cells — only the ~5 densest touch it.
            let mut gpu_cache = R4SourceCache::new(&args.h3r4_dir, args.r4_cache.max(7), SEL);
            let gpu_rasters = RealRasters::new(&args.prepared_dir);
            for (r4, prepared) in gpu_rx {
                // ms = prep+build wall time per cell (t_start stamped at the START of prep_cell),
                // matching the serial `done` line. Read it before gpu_build_cell consumes the cell.
                let line = match prepared.and_then(|p| {
                    let t_start = p.t_start;
                    // Production stream worklist = the whole cell, so the chunked fallback's `tiles`
                    // is `region_tiles(r4,z)` (matches what the prep thread built this cell against).
                    build_prepared_cell(
                        &gpu,
                        &mut gpu_cache,
                        &gpu_rasters,
                        args,
                        n_days,
                        z,
                        bn,
                        r4,
                        p,
                        &region_tiles(r4, z),
                    )
                    .map(|(w, s)| (w, s, t_start))
                }) {
                    Ok((w, s, t_start)) => {
                        format!("done {r4:x} {w} {s} {}", t_start.elapsed().as_millis())
                    }
                    // A per-cell VRAM OOM / too-dense region: report THIS cell failed and keep
                    // streaming (the hub leaves it unstamped → uncomputed). A clean alloc failure
                    // leaves the CUDA context usable, so the next cell is fine.
                    Err(e) if is_cell_unbuildable(&e) => format!("fail {r4:x} {e}"),
                    // Anything else — a non-OOM CUDA error (illegal address, launch/sync failure ⇒
                    // possibly corrupted device state) or a CPU/IO failure (tile write, source
                    // load, on either thread) — is NOT safely skippable: abort so provision
                    // restarts a clean engine instead of silently failing every later cell.
                    Err(e) => {
                        eprintln!("airborne: FATAL unrecoverable error on {r4:x}: {e:?}");
                        std::process::exit(1);
                    }
                };
                // One locked writeln+flush so each cell's result reaches the orchestrator at once.
                let mut out = std::io::stdout().lock();
                let _ = writeln!(out, "{line}");
                let _ = out.flush();
            }
        });

        // Reader on the main scope thread (StdinLock is !Send): parse hex R4s onto the queue tail in
        // arrival order, waking the prep thread per cell. On EOF flag done + wake it so it drains + exits.
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let s = line.trim();
            if s.is_empty() {
                continue;
            }
            match u64::from_str_radix(s, 16) {
                Ok(r4) => {
                    let (lock, cv) = &*work;
                    lock.lock().unwrap().0.push_back(r4);
                    cv.notify_one();
                }
                Err(_) => eprintln!("stream: skip non-hex line: {s}"),
            }
        }
        let (lock, cv) = &*work;
        lock.lock().unwrap().1 = true;
        cv.notify_all();
    });
    Ok(())
}
