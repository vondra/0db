//! Durable fail-closed fences for coherent working-store transactions.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};

use super::{StoreFileLock, REBUILD_INCOMPLETE_MARKER, SCOPED_UPDATE_INCOMPLETE_MARKER};

const REBUILD_MUTEX: &str = ".rebuild.lock";
const REBUILD_LOCK_WAIT: Duration = Duration::from_secs(300);
const MAX_DESCRIPTOR_BYTES: usize = 4 * 1024;
static TOKEN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn new_owner_token() -> Result<String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let sequence = TOKEN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(format!("{}-{now:x}-{sequence:x}", std::process::id()))
}

fn validate_descriptor(descriptor: &str) -> Result<()> {
    if descriptor.is_empty() || descriptor.len() > MAX_DESCRIPTOR_BYTES {
        bail!("transaction descriptor must be 1..={MAX_DESCRIPTOR_BYTES} bytes");
    }
    Ok(())
}

fn marker_body(descriptor: &str, token: &str) -> String {
    serde_json::json!({ "descriptor": descriptor, "token": token }).to_string() + "\n"
}

fn read_marker(path: &Path) -> Result<(String, Option<String>)> {
    let body = fs::read_to_string(path)
        .with_context(|| format!("read transaction fence {}", path.display()))?;
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) {
        let descriptor = value
            .get("descriptor")
            .and_then(serde_json::Value::as_str)
            .context("transaction fence has no descriptor")?;
        let token = value
            .get("token")
            .and_then(serde_json::Value::as_str)
            .context("transaction fence has no owner token")?;
        return Ok((descriptor.to_string(), Some(token.to_string())));
    }

    // One-release migration for fences left by the previous `pid= operation=` format. A retry of
    // the same operation may adopt it; a different operation still fails closed.
    let descriptor = body
        .split_whitespace()
        .find_map(|field| field.strip_prefix("operation="))
        .context("transaction fence is neither JSON nor the legacy operation format")?;
    Ok((descriptor.to_string(), None))
}

fn write_marker_atomic(
    directory: &Path,
    marker: &Path,
    descriptor: &str,
    token: &str,
) -> Result<()> {
    let marker_name = marker
        .file_name()
        .and_then(|name| name.to_str())
        .context("transaction marker has no UTF-8 file name")?;
    let temporary = directory.join(format!("{marker_name}.{token}.tmp"));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .with_context(|| format!("create transaction fence staging {}", temporary.display()))?;
        file.write_all(marker_body(descriptor, token).as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, marker)
            .with_context(|| format!("publish transaction fence {}", marker.display()))?;
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn begin_owned_marker(directory: &Path, marker: &Path, descriptor: &str) -> Result<String> {
    validate_descriptor(descriptor)?;
    fs::create_dir_all(directory)
        .with_context(|| format!("create transaction directory {}", directory.display()))?;
    if marker.try_exists()? {
        let (stale_descriptor, _) = read_marker(marker)?;
        if stale_descriptor != descriptor {
            bail!(
                "incomplete transaction {} owns descriptor {stale_descriptor:?}; retry that exact operation before starting {descriptor:?}",
                marker.display()
            );
        }
    }
    let token = new_owner_token()?;
    write_marker_atomic(directory, marker, descriptor, &token)?;
    Ok(token)
}

fn finish_owned_marker(directory: &Path, marker: &Path, token: &str) -> Result<()> {
    let (_, current_token) = read_marker(marker)?;
    if current_token.as_deref() != Some(token) {
        bail!(
            "transaction fence {} is owned by another process; refusing to remove it",
            marker.display()
        );
    }
    File::open(directory)?.sync_all()?;
    fs::remove_file(marker)
        .with_context(|| format!("remove transaction fence {}", marker.display()))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

/// One layer's multi-level mutation. The stable mutex prevents two direct Rust callers from
/// sharing or removing each other's marker; a crashed owner releases the mutex but leaves the
/// descriptor, so only an exact retry may adopt and clear the incomplete transaction.
pub struct StoreRebuildFence {
    path: PathBuf,
    layer_dir: PathBuf,
    token: String,
    _mutex: StoreFileLock,
}

impl StoreRebuildFence {
    /// Fence one layer before its first mutation, waiting for an active owner to finish.
    pub fn begin(layer_dir: &Path, operation: &str) -> Result<Self> {
        Self::begin_bounded(layer_dir, operation, REBUILD_LOCK_WAIT)
    }

    fn begin_bounded(layer_dir: &Path, operation: &str, timeout: Duration) -> Result<Self> {
        fs::create_dir_all(layer_dir)
            .with_context(|| format!("create store layer {}", layer_dir.display()))?;
        let mutex = StoreFileLock::acquire_bounded(&layer_dir.join(REBUILD_MUTEX), timeout)
            .context("wait for layer rebuild transaction")?;
        let path = layer_dir.join(REBUILD_INCOMPLETE_MARKER);
        let token = begin_owned_marker(layer_dir, &path, operation)?;
        Ok(Self {
            path,
            layer_dir: layer_dir.to_path_buf(),
            token,
            _mutex: mutex,
        })
    }

    /// Assert that an outer operation fenced this layer before it mutated the base level.
    pub fn require_present(layer_dir: &Path) -> Result<()> {
        let path = layer_dir.join(REBUILD_INCOMPLETE_MARKER);
        if !path.try_exists()? {
            bail!(
                "pyramid for {} requires an existing transaction fence",
                layer_dir.display()
            );
        }
        read_marker(&path)?;
        Ok(())
    }

    /// Make completed files and directory entries durable, then remove only this owner's fence.
    pub fn finish(self) -> Result<()> {
        finish_owned_marker(&self.layer_dir, &self.path, &self.token)
    }
}

/// Durable root fence used by a manual scoped repaint across separate ingest, pyramid, and total
/// processes. The caller must hold the store master flock for the entire begin→finish bracket.
pub struct StoreUpdateFence;

impl StoreUpdateFence {
    /// Begin or adopt an exact crashed scoped update and return its fresh ownership token.
    pub fn begin(store_root: &Path, descriptor: &str) -> Result<String> {
        let marker = store_root.join(SCOPED_UPDATE_INCOMPLETE_MARKER);
        begin_owned_marker(store_root, &marker, descriptor)
    }

    /// Remove a scoped-update marker only when `token` is the current durable owner.
    pub fn finish(store_root: &Path, token: &str) -> Result<()> {
        finish_owned_marker(
            store_root,
            &store_root.join(SCOPED_UPDATE_INCOMPLETE_MARKER),
            token,
        )
    }
}

/// Reject any root transaction, or any selected layer rebuild, that did not finish durably.
/// An empty `only_layers` scans every layer directory, including one with no surviving qtsi yet.
pub fn reject_incomplete_store_transactions(
    store_root: &Path,
    only_layers: &[String],
) -> Result<()> {
    let root_marker = store_root.join(SCOPED_UPDATE_INCOMPLETE_MARKER);
    if root_marker.try_exists()? {
        let (descriptor, _) = read_marker(&root_marker)?;
        bail!(
            "scoped store update {descriptor:?} is incomplete at {}; retry that exact repaint",
            root_marker.display()
        );
    }

    let mut incomplete = Vec::new();
    if only_layers.is_empty() {
        for entry in fs::read_dir(store_root)
            .with_context(|| format!("read store root {}", store_root.display()))?
        {
            let entry = entry?;
            if entry.file_type()?.is_dir()
                && entry.path().join(REBUILD_INCOMPLETE_MARKER).try_exists()?
            {
                incomplete.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    } else {
        for layer in only_layers {
            if store_root
                .join(layer)
                .join(REBUILD_INCOMPLETE_MARKER)
                .try_exists()?
            {
                incomplete.push(layer.clone());
            }
        }
    }
    incomplete.sort();
    incomplete.dedup();
    if !incomplete.is_empty() {
        bail!(
            "layer transaction incomplete for {}; retry the exact failed rebuild before publishing",
            incomplete.join(", ")
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_fence_mutex_serializes_and_exact_retry_adopts_a_crash() {
        let directory = tempfile::tempdir().unwrap();
        let first =
            StoreRebuildFence::begin_bounded(directory.path(), "pyramid:tiles-a", Duration::ZERO)
                .unwrap();
        assert!(StoreRebuildFence::begin_bounded(
            directory.path(),
            "pyramid:tiles-a",
            Duration::ZERO,
        )
        .is_err());
        let first_token = first.token.clone();
        drop(first); // simulated process crash: marker remains, mutex releases

        let retry =
            StoreRebuildFence::begin_bounded(directory.path(), "pyramid:tiles-a", Duration::ZERO)
                .unwrap();
        assert_ne!(retry.token, first_token);
        retry.finish().unwrap();
        assert!(!directory.path().join(REBUILD_INCOMPLETE_MARKER).exists());
    }

    #[test]
    fn stale_layer_fence_rejects_a_different_operation() {
        let directory = tempfile::tempdir().unwrap();
        let fence = StoreRebuildFence::begin(directory.path(), "pyramid:bbox-a").unwrap();
        drop(fence);
        let error =
            StoreRebuildFence::begin_bounded(directory.path(), "pyramid:bbox-b", Duration::ZERO)
                .err()
                .expect("a different transaction descriptor must not be adopted");
        assert!(error.to_string().contains("retry that exact operation"));
    }

    #[test]
    fn scoped_update_finish_is_owner_checked_and_exact_retry_rotates_the_token() {
        let directory = tempfile::tempdir().unwrap();
        let first = StoreUpdateFence::begin(directory.path(), "z12|bbox-a|rail").unwrap();
        let retry = StoreUpdateFence::begin(directory.path(), "z12|bbox-a|rail").unwrap();
        assert_ne!(first, retry);
        assert!(StoreUpdateFence::finish(directory.path(), &first).is_err());
        assert!(directory
            .path()
            .join(SCOPED_UPDATE_INCOMPLETE_MARKER)
            .exists());
        StoreUpdateFence::finish(directory.path(), &retry).unwrap();
    }

    #[test]
    fn scoped_update_refuses_to_hide_an_unrepaired_different_scope() {
        let directory = tempfile::tempdir().unwrap();
        StoreUpdateFence::begin(directory.path(), "z12|bbox-a|rail").unwrap();
        let error = StoreUpdateFence::begin(directory.path(), "z12|bbox-b|road").unwrap_err();
        assert!(error.to_string().contains("retry that exact operation"));
    }
}
