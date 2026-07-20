//! Cross-process locks that make one working-store snapshot coherent.

use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

/// An exclusive BSD `flock` released automatically when the guard drops.
pub struct StoreFileLock {
    file: File,
}

impl StoreFileLock {
    /// Wait at most `timeout` for one stable lock-file inode.
    pub fn acquire_bounded(path: &Path, timeout: Duration) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create lock directory {}", parent.display()))?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("open store lock {}", path.display()))?;
        let started = Instant::now();
        loop {
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Ok(Self { file });
            }
            let error = std::io::Error::last_os_error();
            if !matches!(
                error.raw_os_error(),
                Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN
            ) {
                return Err(error).with_context(|| format!("flock {}", path.display()));
            }
            let elapsed = started.elapsed();
            if elapsed >= timeout {
                bail!(
                    "store lock {} stayed busy for {:.3}s",
                    path.display(),
                    timeout.as_secs_f64()
                );
            }
            thread::sleep((timeout - elapsed).min(Duration::from_millis(25)));
        }
    }
}

impl Drop for StoreFileLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

/// The stable per-`(layer, zoom)` inode used by every writable [`super::TileStore`]. Snapshot
/// readers lock the same inode, so copying an index can never race a direct writer that bypasses
/// the coarser master/ingest domains.
pub fn zoom_store_lock_path(layer_dir: &Path, zoom: u8) -> PathBuf {
    layer_dir.join(format!("z{zoom}.lock"))
}

/// A set of exclusive store locks acquired in one canonical order and released on drop.
pub struct StoreFileLocks {
    _locks: Vec<StoreFileLock>,
}

fn canonical_lock_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = paths.into_iter().collect();
    paths.sort();
    paths.dedup();
    paths
}

impl StoreFileLocks {
    /// Sort and deduplicate paths before acquiring them. One total timeout budget covers the
    /// whole set; a failed later acquisition drops every earlier guard before returning.
    pub fn acquire_canonical(
        paths: impl IntoIterator<Item = PathBuf>,
        timeout: Duration,
    ) -> Result<Self> {
        let paths = canonical_lock_paths(paths);
        let started = Instant::now();
        let mut locks = Vec::with_capacity(paths.len());
        for path in paths {
            let remaining = timeout.saturating_sub(started.elapsed());
            locks.push(
                StoreFileLock::acquire_bounded(&path, remaining)
                    .with_context(|| format!("wait for snapshot lock {}", path.display()))?,
            );
        }
        Ok(Self { _locks: locks })
    }
}

/// Existing combine/pyramid lock for one `tiles/<year>/store` root.
pub fn master_store_lock_path(store_root: &Path) -> Result<PathBuf> {
    if store_root.file_name().and_then(|name| name.to_str()) != Some("store") {
        bail!(
            "store root {} must end in /store to derive its master lock",
            store_root.display()
        );
    }
    let year_root = store_root
        .parent()
        .with_context(|| format!("store root {} has no year parent", store_root.display()))?;
    Ok(year_root.join("build/.stamps/.master._combine.lock"))
}

/// Existing Hub ingest lock for one `tiles/<year>/store` root.
pub fn ingest_store_lock_path(store_root: &Path) -> PathBuf {
    store_root.join(".ingest.lock")
}

/// Both working-store writer domains, always acquired in the one global order: master, then
/// ingest. Keeping the order here makes whole-store replacement and coherent snapshots safe
/// without relying on every binary to reimplement the deadlock contract correctly.
pub struct StoreMasterIngestLocks {
    // Fields drop in declaration order: ingest first, then master (reverse acquisition order).
    _ingest: StoreFileLock,
    _master: StoreFileLock,
}

impl StoreMasterIngestLocks {
    /// Acquire both outer writer domains within one bounded wait per lock.
    pub fn acquire_bounded(store_root: &Path, timeout: Duration) -> Result<Self> {
        let master_path = master_store_lock_path(store_root)?;
        let master = StoreFileLock::acquire_bounded(&master_path, timeout)
            .with_context(|| format!("wait for store master {}", master_path.display()))?;
        let ingest_path = ingest_store_lock_path(store_root);
        let ingest = StoreFileLock::acquire_bounded(&ingest_path, timeout)
            .with_context(|| format!("wait for Hub ingest {}", ingest_path.display()))?;
        Ok(Self {
            _ingest: ingest,
            _master: master,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_deployed_lock_paths_from_the_store_root() {
        let root = Path::new("/data/tiles/2026/store");
        assert_eq!(
            master_store_lock_path(root).unwrap(),
            Path::new("/data/tiles/2026/build/.stamps/.master._combine.lock")
        );
        assert_eq!(
            ingest_store_lock_path(root),
            Path::new("/data/tiles/2026/store/.ingest.lock")
        );
        assert!(master_store_lock_path(Path::new("/tmp/not-store")).is_err());
    }

    #[test]
    fn bounded_lock_excludes_a_second_open_file_description() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("writer.lock");
        let first = StoreFileLock::acquire_bounded(&path, Duration::from_secs(1)).unwrap();
        assert!(StoreFileLock::acquire_bounded(&path, Duration::ZERO).is_err());
        drop(first);
        StoreFileLock::acquire_bounded(&path, Duration::ZERO).unwrap();
    }

    #[test]
    fn canonical_set_deduplicates_and_releases_partial_acquisition_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("a.lock");
        let blocked = dir.path().join("b.lock");
        let held = StoreFileLock::acquire_bounded(&blocked, Duration::ZERO).unwrap();

        assert_eq!(
            canonical_lock_paths([blocked.clone(), first.clone(), first.clone()]),
            vec![first.clone(), blocked.clone()]
        );

        assert!(StoreFileLocks::acquire_canonical(
            [blocked.clone(), first.clone(), first.clone()],
            Duration::ZERO,
        )
        .is_err());
        StoreFileLock::acquire_bounded(&first, Duration::ZERO)
            .expect("failed set acquisition must release its earlier canonical locks");
        drop(held);
    }

    #[test]
    fn pair_waits_master_then_ingest_and_rolls_master_back_if_ingest_is_busy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("tiles/2026/store");
        let ingest_path = ingest_store_lock_path(&root);
        let held_ingest =
            StoreFileLock::acquire_bounded(&ingest_path, Duration::from_secs(1)).unwrap();

        assert!(StoreMasterIngestLocks::acquire_bounded(&root, Duration::ZERO).is_err());
        let master_path = master_store_lock_path(&root).unwrap();
        StoreFileLock::acquire_bounded(&master_path, Duration::ZERO)
            .expect("failed pair acquisition must release its already-acquired master");
        drop(held_ingest);
    }
}
