//! Per-R4 stale-arrow wipe for Stage 2B/2C reextracts.
//!
//! Stage 2B writes `cruise.arrow` and Stage 2C writes
//! `airport_traffic.arrow` ONLY into `h3r4/<R4>/` cells that have
//! traffic in the current run. R4s inside the scope bbox but without
//! traffic this run retain whatever `*.arrow` a previous run wrote —
//! including files stamped with an older `schema_version` if the
//! schema was bumped in the meantime. The popup reader rejects on
//! version mismatch and the receiver fatal-fails.
//!
//! [`wipe_stale_arrows_for_scope`] runs once per stage, before the
//! writer's `par_iter`, and deletes the matching `*.arrow` from every
//! in-scope `h3r4/<R4>/` subdir. Workers then write the current-run
//! file into the same path; R4s with no traffic stay empty.
//!
//! Out-of-scope R4s are intentionally left alone: a partial re-extract
//! refreshes only the bbox the operator passed, and out-of-scope cells
//! continue to serve their last full run. The trade-off: after a
//! schema bump, operators MUST re-extract globally (or accept that
//! out-of-scope R4s with stale files will still fatal-fail at popup
//! time). This wipe only converts stale-in-scope to absent-in-scope;
//! it is not a schema-migration tool.
//!
//! Safety guards (all enforced in release builds; the function is
//! `pub` and deletes data):
//! - `filename` is checked at runtime for `/`, `\\`, and empty.
//! - Directory subentries are validated via `entry.file_type()`
//!   (does NOT follow symlinks) — a symlink named like an R4 hex
//!   cannot redirect deletes outside `h3r4_dir`.
//! - Subdir names must parse as `h3o::CellIndex` at `Resolution::Four`
//!   (not just valid hex), so unrelated hex-named directories like
//!   `"deadbeef"` are skipped even when `scope == None`.

use std::path::Path;

use anyhow::{Context, Result};
use h3o::{CellIndex, Resolution};

use crate::scope::ScopeBbox;

/// Remove `h3r4_dir/<R4>/<filename>` for every in-scope R4 hex subdir
/// of `h3r4_dir`. `scope = None` matches every real R4 subdir.
///
/// Returns the number of files actually removed (for log + test).
/// Missing `h3r4_dir` or missing per-R4 files are NOT errors — the
/// wipe is best-effort cleanup. Logs one line per deletion to stderr.
pub fn wipe_stale_arrows_for_scope(
    h3r4_dir: &Path,
    filename: &str,
    scope: Option<&ScopeBbox>,
) -> Result<usize> {
    // Runtime guard, not `debug_assert!` — this is a `pub` data-
    // deleting helper, and the check must survive release builds
    // against any future caller that computes `filename` dynamically.
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        anyhow::bail!("filename must be a non-empty single basename, got {filename:?}");
    }
    let read = match std::fs::read_dir(h3r4_dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e).with_context(|| format!("read_dir {}", h3r4_dir.display())),
    };
    let mut removed = 0usize;
    for entry in read {
        let entry = entry.with_context(|| format!("read_dir entry in {}", h3r4_dir.display()))?;
        // `file_type()` does NOT follow symlinks; `path.is_dir()`
        // would. A symlink named like an R4 hex must not redirect the
        // delete outside `h3r4_dir`.
        let ft = entry
            .file_type()
            .with_context(|| format!("file_type {}", entry.path().display()))?;
        if !ft.is_dir() {
            continue;
        }
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // Directory name is the R4 hex (`r4_hex_str` output).
        // Validate via `h3o::CellIndex` at Resolution::Four, not just
        // `u64::from_str_radix` — that rejects unrelated hex-named
        // scratch directories like `"deadbeef"`.
        let Ok(r4_u64) = u64::from_str_radix(name, 16) else {
            continue;
        };
        let Ok(cell) = CellIndex::try_from(r4_u64) else {
            continue;
        };
        if cell.resolution() != Resolution::Four {
            continue;
        }
        if let Some(s) = scope {
            if !s.contains_r4(r4_u64) {
                continue;
            }
        }
        let stale = path.join(filename);
        // No `exists()` probe — concurrent unlink between check and
        // remove would upgrade NotFound into a fatal error. Treat
        // NotFound as a no-op; any other error is fatal.
        match std::fs::remove_file(&stale) {
            Ok(()) => {
                eprintln!(
                    "{} [wipe] removed stale {}",
                    crate::progress::ts(),
                    stale.display()
                );
                removed += 1;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                return Err(e).with_context(|| format!("remove {}", stale.display()));
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geo::r4_hex_str;
    use h3o::{LatLng, Resolution};

    fn r4_for(lat: f64, lon: f64) -> u64 {
        u64::from(LatLng::new(lat, lon).unwrap().to_cell(Resolution::Four))
    }

    #[test]
    fn missing_h3r4_dir_is_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let absent = tmp.path().join("does-not-exist");
        let n = wipe_stale_arrows_for_scope(&absent, "x.arrow", None).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn wipes_all_when_scope_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        let h3r4 = tmp.path().join("h3r4");
        let r4_a = r4_hex_str(r4_for(50.10, 14.26));
        let r4_b = r4_hex_str(r4_for(27.93, -15.39));
        for r4 in [&r4_a, &r4_b] {
            let d = h3r4.join(r4);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("airport_traffic.arrow"), b"stale").unwrap();
            // Adjacent file that MUST survive — only the target
            // basename is wiped.
            std::fs::write(d.join("airport_lines.arrow"), b"keep").unwrap();
        }
        let removed = wipe_stale_arrows_for_scope(&h3r4, "airport_traffic.arrow", None).unwrap();
        assert_eq!(removed, 2);
        for r4 in [&r4_a, &r4_b] {
            assert!(!h3r4.join(r4).join("airport_traffic.arrow").exists());
            assert!(
                h3r4.join(r4).join("airport_lines.arrow").exists(),
                "non-target basenames must survive"
            );
        }
    }

    #[test]
    fn wipes_only_in_scope_cells() {
        let tmp = tempfile::tempdir().unwrap();
        let h3r4 = tmp.path().join("h3r4");
        let cz = r4_hex_str(r4_for(50.10, 14.26)); // Praha
        let canary = r4_hex_str(r4_for(27.93, -15.39)); // Gran Canaria
        for r4 in [&cz, &canary] {
            let d = h3r4.join(r4);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("airport_traffic.arrow"), b"stale").unwrap();
        }
        // Praha scope only — Canary must keep its file.
        let praha = ScopeBbox::parse("48.65,12.00,51.55,16.90").unwrap();
        let removed =
            wipe_stale_arrows_for_scope(&h3r4, "airport_traffic.arrow", Some(&praha)).unwrap();
        assert_eq!(removed, 1, "only the in-scope R4 should be wiped");
        assert!(
            !h3r4.join(&cz).join("airport_traffic.arrow").exists(),
            "in-scope R4 must be wiped"
        );
        assert!(
            h3r4.join(&canary).join("airport_traffic.arrow").exists(),
            "out-of-scope R4 must NOT be wiped"
        );
    }

    #[test]
    fn missing_target_file_is_silently_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let h3r4 = tmp.path().join("h3r4");
        let r4 = r4_hex_str(r4_for(50.10, 14.26));
        std::fs::create_dir_all(h3r4.join(&r4)).unwrap();
        // No airport_traffic.arrow inside — wipe should be a no-op.
        let removed = wipe_stale_arrows_for_scope(&h3r4, "airport_traffic.arrow", None).unwrap();
        assert_eq!(removed, 0);
    }

    #[test]
    fn non_hex_subdirs_are_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let h3r4 = tmp.path().join("h3r4");
        let weird = h3r4.join("not-an-r4-hex");
        std::fs::create_dir_all(&weird).unwrap();
        std::fs::write(weird.join("airport_traffic.arrow"), b"keep").unwrap();
        let removed = wipe_stale_arrows_for_scope(&h3r4, "airport_traffic.arrow", None).unwrap();
        assert_eq!(removed, 0);
        assert!(weird.join("airport_traffic.arrow").exists());
    }

    /// `u64::from_str_radix` accepts arbitrary hex strings; without
    /// the extra `CellIndex` + `Resolution::Four` validation, a
    /// scratch directory called `"deadbeef"` would have its
    /// `airport_traffic.arrow` wiped on a `scope = None` run.
    #[test]
    fn valid_hex_but_not_h3_r4_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let h3r4 = tmp.path().join("h3r4");
        // "deadbeef" parses as a u64 but is not a valid H3 index.
        let bogus = h3r4.join("deadbeef");
        std::fs::create_dir_all(&bogus).unwrap();
        std::fs::write(bogus.join("airport_traffic.arrow"), b"keep").unwrap();
        let removed = wipe_stale_arrows_for_scope(&h3r4, "airport_traffic.arrow", None).unwrap();
        assert_eq!(removed, 0);
        assert!(bogus.join("airport_traffic.arrow").exists());
    }

    /// An H3 cell at a different resolution (here R7) parses as a
    /// `CellIndex` but its resolution is not Four — wipe must reject
    /// it so an unrelated per-R7 scratch tree under `h3r4_dir`
    /// cannot have its `*.arrow` deleted.
    #[test]
    fn h3_cell_at_wrong_resolution_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let h3r4 = tmp.path().join("h3r4");
        let r7 = u64::from(
            LatLng::new(50.10, 14.26)
                .unwrap()
                .to_cell(Resolution::Seven),
        );
        let r7_dir = h3r4.join(format!("{r7:015x}"));
        std::fs::create_dir_all(&r7_dir).unwrap();
        std::fs::write(r7_dir.join("airport_traffic.arrow"), b"keep").unwrap();
        let removed = wipe_stale_arrows_for_scope(&h3r4, "airport_traffic.arrow", None).unwrap();
        assert_eq!(removed, 0);
        assert!(r7_dir.join("airport_traffic.arrow").exists());
    }

    #[test]
    fn rejects_filename_with_forward_slash() {
        let tmp = tempfile::tempdir().unwrap();
        let err = wipe_stale_arrows_for_scope(tmp.path(), "sub/path.arrow", None).unwrap_err();
        assert!(
            err.to_string().contains("basename"),
            "error must mention basename invariant, got: {err}",
        );
    }

    #[test]
    fn rejects_filename_with_backslash() {
        let tmp = tempfile::tempdir().unwrap();
        let err = wipe_stale_arrows_for_scope(tmp.path(), "sub\\path.arrow", None).unwrap_err();
        assert!(err.to_string().contains("basename"), "got: {err}");
    }

    #[test]
    fn rejects_empty_filename() {
        let tmp = tempfile::tempdir().unwrap();
        let err = wipe_stale_arrows_for_scope(tmp.path(), "", None).unwrap_err();
        assert!(err.to_string().contains("basename"), "got: {err}");
    }
}
