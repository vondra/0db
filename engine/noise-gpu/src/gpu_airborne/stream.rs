//! STREAM mode (`--stream`) for the gpu-airborne bin: the persistent warm worker the cluster
//! orchestrator feeds — parallel CPU prep ahead of a VRAM-gated two-stream GPU pool over R4 cells
//! read from stdin, reusing CUDA contexts + LUTs + rasters across cells (no process churn).

use anyhow::{bail, Context, Result};
use noise_gpu::airborne::{is_cell_unbuildable, AirborneGpu};
use raster_reader::fused_tile_z13::default_batch_size;
use raster_reader::RealRasters;
use tile_painter::r4_source_cache::R4SourceCache;
use tile_painter::region_runner::region_tiles;
use tile_painter::worklist::{any_source_arrow, resolve_n_days};

use crate::build::{gpu_build_cell_chunked, gpu_build_cell_one_pass, max_candidates_per_chunk};
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

/// Weighted device-memory admission for the two CUDA streams. Ordinary cells take one permit;
/// a cell above its per-stream candidate share (or the bounded megahub path) takes every permit
/// and therefore runs alone. This preserves the old one-cell VRAM safety for large cells while
/// allowing two small kernels to overlap their launch/sync gaps.
struct VramGate {
    state: std::sync::Mutex<VramState>,
    changed: std::sync::Condvar,
}

struct VramState {
    available: usize,
    total: usize,
    exclusive_waiters: usize,
}

impl VramGate {
    fn new(permits: usize) -> Self {
        Self {
            state: std::sync::Mutex::new(VramState {
                available: permits,
                total: permits,
                exclusive_waiters: 0,
            }),
            changed: std::sync::Condvar::new(),
        }
    }

    fn acquire(&self, permits: usize) -> VramLease<'_> {
        let mut state = self.state.lock().unwrap();
        let exclusive = permits == state.total;
        if exclusive {
            state.exclusive_waiters += 1;
            // Wake any ordinary waiter so it observes writer priority before consuming a newly
            // released permit. This also makes the state transition directly observable in tests.
            self.changed.notify_all();
        }
        while state.available < permits || (!exclusive && state.exclusive_waiters > 0) {
            state = self.changed.wait(state).unwrap();
        }
        if exclusive {
            state.exclusive_waiters -= 1;
        }
        state.available -= permits;
        VramLease {
            gate: self,
            permits,
        }
    }
}

struct VramLease<'a> {
    gate: &'a VramGate,
    permits: usize,
}

impl Drop for VramLease<'_> {
    fn drop(&mut self) {
        self.gate.state.lock().unwrap().available += self.permits;
        self.gate.changed.notify_all();
    }
}

#[derive(Default)]
struct PerfWindow {
    cells: u128,
    candidates_ms: u128,
    pack_ms: u128,
    dem_ms: u128,
    queue_ms: u128,
    vram_wait_ms: u128,
    build_ms: u128,
    chunked: u128,
}

impl PerfWindow {
    const CELLS: u128 = 64;

    fn add(
        &mut self,
        timings: crate::prep::PrepTimings,
        queue_ms: u128,
        vram_wait_ms: u128,
        build_ms: u128,
        chunked: bool,
    ) -> Option<String> {
        self.cells += 1;
        self.candidates_ms += timings.candidates.as_millis();
        self.pack_ms += timings.pack.as_millis();
        self.dem_ms += timings.dem.as_millis();
        self.queue_ms += queue_ms;
        self.vram_wait_ms += vram_wait_ms;
        self.build_ms += build_ms;
        self.chunked += u128::from(chunked);
        if self.cells < Self::CELLS {
            return None;
        }
        let n = Self::CELLS;
        let line = format!(
            "{} cells avg: candidates={}ms pack={}ms dem={}ms queue={}ms vram-wait={}ms \
             build={}ms chunked={}",
            Self::CELLS,
            self.candidates_ms / n,
            self.pack_ms / n,
            self.dem_ms / n,
            self.queue_ms / n,
            self.vram_wait_ms / n,
            self.build_ms / n,
            self.chunked,
        );
        *self = Self::default();
        Some(line)
    }
}

type PreparedReceiver =
    std::sync::Arc<std::sync::Mutex<std::sync::mpsc::Receiver<(u64, Result<PreparedCell>)>>>;

/// One warm CUDA stream. The shared receiver hands each prepared cell to exactly one worker; the
/// weighted gate keeps large/fallback builds exclusive and lets only VRAM-small cells overlap.
#[allow(clippy::too_many_arguments)]
fn run_gpu_worker(
    worker_id: usize,
    n_workers: usize,
    receiver: &PreparedReceiver,
    vram_gate: &VramGate,
    class_weights: &noise_compute::emission::aircraft::ClassWeights,
    args: &Args,
    n_days: u16,
    z: u8,
    bn: u32,
) {
    use std::io::Write;
    use std::time::Instant;

    let gpu = AirborneGpu::new(class_weights);
    let concurrent_candidate_limit = max_candidates_per_chunk(gpu.vram_total_bytes()) / n_workers;
    eprintln!(
        "stream: gpu={worker_id} ready; concurrent-candidate-limit={concurrent_candidate_limit}"
    );
    // Own cache + rasters for the M2 chunked fallback. Ordinary cells were fully prepared by the
    // coordinator and never touch these; only a host/VRAM-large cell re-loads its seven-cell ring.
    let mut gpu_cache = R4SourceCache::new(&args.h3r4_dir, args.r4_cache.max(7), SEL);
    let gpu_rasters = RealRasters::new(&args.prepared_dir);
    let mut perf = PerfWindow::default();

    loop {
        // Hold the receiver mutex only for `recv`: once a worker owns a message it releases the
        // lock and computes, so the peer can receive the next prepared cell concurrently.
        let message = receiver.lock().unwrap().recv();
        let Ok((r4, prepared)) = message else { break };
        let prep_meta = prepared.as_ref().ok().map(|p| (p.t_start, p.timings));
        let initial_permits = prepared
            .as_ref()
            .ok()
            .map(|p| {
                if p.too_big || p.nreg > concurrent_candidate_limit {
                    n_workers
                } else {
                    1
                }
            })
            .unwrap_or(1);

        let wait_start = Instant::now();
        let mut lease = Some(vram_gate.acquire(initial_permits));
        let mut vram_wait_ms = wait_start.elapsed().as_millis();
        let mut build_ms = 0u128;
        let mut used_chunked = prepared.as_ref().is_ok_and(|p| p.too_big);
        let tiles = region_tiles(r4, z);
        let built = match prepared {
            Err(e) => Err(e),
            Ok(p) if p.too_big => {
                let started = Instant::now();
                let result = gpu_build_cell_chunked(
                    &gpu,
                    &mut gpu_cache,
                    &gpu_rasters,
                    args,
                    n_days,
                    z,
                    bn,
                    r4,
                    &tiles,
                );
                build_ms += started.elapsed().as_millis();
                result
            }
            Ok(p) => {
                let started = Instant::now();
                let first = gpu_build_cell_one_pass(&gpu, args, n_days, p);
                build_ms += started.elapsed().as_millis();
                match first {
                    Err(e) if is_cell_unbuildable(&e) => {
                        // The estimate was deliberately conservative, but fragmentation or an
                        // unusually large classify list can still reject a shared one-pass build.
                        // Rebuild it chunked only after upgrading to exclusive VRAM ownership.
                        used_chunked = true;
                        if initial_permits < n_workers {
                            drop(lease.take());
                            let upgrade_start = Instant::now();
                            lease = Some(vram_gate.acquire(n_workers));
                            vram_wait_ms += upgrade_start.elapsed().as_millis();
                        }
                        let started = Instant::now();
                        let result = gpu_build_cell_chunked(
                            &gpu,
                            &mut gpu_cache,
                            &gpu_rasters,
                            args,
                            n_days,
                            z,
                            bn,
                            r4,
                            &tiles,
                        );
                        build_ms += started.elapsed().as_millis();
                        result
                    }
                    other => other,
                }
            }
        };
        drop(lease);

        let line = match built {
            Ok((written, skipped)) => {
                let (t_start, timings) = prep_meta.expect("successful prep metadata");
                let total_ms = t_start.elapsed().as_millis();
                let prep_ms = timings.total().as_millis();
                let queue_ms = total_ms
                    .saturating_sub(prep_ms)
                    .saturating_sub(vram_wait_ms)
                    .saturating_sub(build_ms);
                if let Some(summary) =
                    perf.add(timings, queue_ms, vram_wait_ms, build_ms, used_chunked)
                {
                    eprintln!("[perf gpu={worker_id}] {summary}");
                }
                format!(
                    "done {r4:x} {written} {skipped} {total_ms} prep_ms={prep_ms} \
                     candidates_ms={} pack_ms={} dem_ms={} queue_ms={queue_ms} \
                     vram_wait_ms={vram_wait_ms} build_ms={build_ms} chunked={}",
                    timings.candidates.as_millis(),
                    timings.pack.as_millis(),
                    timings.dem.as_millis(),
                    u8::from(used_chunked),
                )
            }
            // Exclusive chunking exhausted the card too: this cell is unbuildable here, but the
            // CUDA context remains usable and later cells continue.
            Err(e) if is_cell_unbuildable(&e) => format!("fail {r4:x} {e}"),
            Err(e) => {
                eprintln!("airborne: FATAL unrecoverable error on {r4:x}: {e:?}");
                std::process::exit(1);
            }
        };
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

/// STREAM mode (`--stream`): the persistent warm worker the cluster orchestrator feeds — the
/// answer to the per-chunk process spawn + inter-chunk staging stall (~39% of box wall-time)
/// that capped the cluster's GPU at ~61% effective (a warm process sustains ~88-100%, STEP 1).
/// One process: CUDA context + NPD LUTs + class-weights + RealRasters all resident; R4 cell IDs
/// stream in on stdin and each is built by one prep coordinator (its own `RealRasters` + R4 LRU;
/// candidate preparation fans across Rayon) ahead of TWO persistent CUDA streams. Two is the
/// fleet-safe maximum: small cells overlap launch/sync gaps; a weighted VRAM gate makes a large or
/// chunked cell acquire both permits and run alone, preserving the old one-cell OOM safety. The
/// stages are joined by a depth-1 channel, so prep cannot build an unbounded host-RAM backlog.
/// Result lines print as cells finish; stdout locking prevents interleave and the orchestrator may
/// ACK out of order. n_days + class_weights resolve once from `--seed-regions`.
///
/// Termination / deadlock-freedom: the reader (main scope thread) parses stdin onto the Morton
/// work queue; on EOF it sets the closed flag + `notify_all`. The prep thread drains contiguous
/// runs (PULL_BATCH) and on "closed + empty" returns and drops the only Sender. Both GPU workers
/// then observe receiver disconnect and exit. The receiver mutex is held only across `recv`, never
/// GPU work; the depth-1 `send` has a live consumer until every GPU worker has exited.
pub(crate) fn run_stream(args: &Args, z: u8) -> Result<()> {
    use std::collections::VecDeque;
    use std::io::BufRead;
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
    // One leaves small-cell launch gaps visible; the former rayon-thread-count pool opened 16-32
    // whole-region contexts and OOMed dense hubs. Keep 1 as a diagnostic override and clamp every
    // larger value to the reviewed two-stream ceiling.
    let n_workers = std::env::var("QM_GPU_STREAM_WORKERS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(2)
        .clamp(1, 2);
    eprintln!(
        "stream: n_days={n_days}, batch={bn}, parallel-prep + {n_workers} VRAM-gated GPU stream(s) — reading R4 cells from stdin"
    );

    // Morton-locality work queue. The single prep thread pulls a CONTIGUOUS run of up to
    // PULL_BATCH cells from the front of a shared queue the reader fills in arrival (= the
    // orchestrator's Morton) order, so its grid_disk(1) ring-cache stays warm across the run —
    // even better than the old per-worker pool, which split the Morton stream across K caches.
    // The mutex is held only to splice a run off the front (cheap); prep_cell runs unlocked.
    const PULL_BATCH: usize = 4;
    let work: StreamQueue = Arc::new((Mutex::new((VecDeque::new(), false)), Condvar::new()));
    // Depth-1: one prepared cell may wait behind the two device workers and the one being prepared.
    // Host RAM therefore stays bounded at roughly four ordinary cells.
    let (gpu_tx, gpu_rx) = sync_channel::<(u64, Result<PreparedCell>)>(1);
    let gpu_rx: PreparedReceiver = Arc::new(Mutex::new(gpu_rx));
    let vram_gate = VramGate::new(n_workers);

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

        for worker_id in 0..n_workers {
            let receiver = Arc::clone(&gpu_rx);
            let class_weights = &class_weights;
            let gate = &vram_gate;
            scope.spawn(move || {
                run_gpu_worker(
                    worker_id,
                    n_workers,
                    &receiver,
                    gate,
                    class_weights,
                    args,
                    n_days,
                    z,
                    bn,
                )
            });
        }

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

#[cfg(test)]
mod tests {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    use super::VramGate;

    #[test]
    fn waiting_exclusive_cell_precedes_new_small_cells() {
        let gate = Arc::new(VramGate::new(2));
        let first_small = gate.acquire(1);

        let (exclusive_acquired_tx, exclusive_acquired_rx) = mpsc::channel();
        let (release_exclusive_tx, release_exclusive_rx) = mpsc::channel();
        let exclusive_gate = Arc::clone(&gate);
        let exclusive = std::thread::spawn(move || {
            let _lease = exclusive_gate.acquire(2);
            exclusive_acquired_tx.send(()).unwrap();
            release_exclusive_rx.recv().unwrap();
        });

        // Wait for the exclusive request to enter the gate. The state inspection makes the test
        // deterministic; sleeping and hoping the spawned thread ran would make this race-prone.
        {
            let mut state = gate.state.lock().unwrap();
            while state.exclusive_waiters == 0 {
                state = gate.changed.wait(state).unwrap();
            }
        }

        let (second_small_tx, second_small_rx) = mpsc::channel();
        let second_gate = Arc::clone(&gate);
        let second_small = std::thread::spawn(move || {
            let _lease = second_gate.acquire(1);
            second_small_tx.send(()).unwrap();
        });

        assert!(second_small_rx
            .recv_timeout(Duration::from_millis(20))
            .is_err());
        drop(first_small);
        exclusive_acquired_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("exclusive cell should acquire both permits");
        assert!(second_small_rx
            .recv_timeout(Duration::from_millis(20))
            .is_err());

        release_exclusive_tx.send(()).unwrap();
        second_small_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("small cell should resume after the exclusive cell");
        exclusive.join().unwrap();
        second_small.join().unwrap();
    }
}
