//! Wall-clock progress ticker for long-running stage loops.
//!
//! Cadence is 10 s: 1 s would flood the log on hot loops (Stage 2B does
//! ~1 M segments/min on a global window) and a global run produces
//! useless noise; 60 s is too coarse to tell whether a stage is making
//! progress vs hung. 10 s gives ~6 lines/min — readable in `tail -F`
//! and rare enough to ignore by default.

use std::time::Instant;

/// 10-second wall-clock ticker. Keep one per loop; call
/// [`Ticker::maybe_tick`] every iteration with a closure that logs the
/// current state. The closure only fires when ≥10 s have elapsed since
/// the previous fire (or since construction), so call it eagerly.
pub struct Ticker {
    last: Instant,
}

impl Ticker {
    pub fn new() -> Self {
        Self { last: Instant::now() }
    }

    /// Run `log_fn` if ≥10 s have elapsed; otherwise no-op.
    pub fn maybe_tick(&mut self, log_fn: impl FnOnce()) {
        if self.last.elapsed().as_secs() >= 10 {
            log_fn();
            self.last = Instant::now();
        }
    }
}

impl Default for Ticker {
    fn default() -> Self {
        Self::new()
    }
}
