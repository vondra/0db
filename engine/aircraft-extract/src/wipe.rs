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
//! Safety: `filename` MUST be a single basename (no path separators)
//! and the removal is restricted to direct children of
//! `h3r4_dir/<R4>/`. The function panics if `filename`
//! contains `/` — enforced in both debug and release builds because
//! a path traversal here would delete arbitrary files outside the
//! intended `h3r4/` tree.

use std::path::Path;

use anyhow::{Context, Result};

use crate::scope::ScopeBbox;

/// Remove `h3r4_dir/<R4>/<filename>` for every in-scope R4 hex
/// subdir of `h3r4_dir`. `scope = None` matches every R4 subdir.
///
/// Returns the number of files actually removed (for log + test).
/// Missing `h3r4_dir` or missing per-R4 files are NOT errors —
/// the wipe is best-effort cleanup.
///
/// Logs one line per deletion to stderr so operators see exactly
/// which stale files were dropped during a reextract.
pub fn wipe_stale_arrows_for_scope(
    h3r4_dir: &Path,
    filename: &str,
    scope: Option<&ScopeBbox>,
) -> Result<usize> {
    assert!(
        !filename.contains('/') && !filename.contains('\\'),
        "filename must be a single basename, got {filename:?}",
    );
    let read = match std::fs::read_dir(h3r4_dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => {
            return Err(e).with_context(|| format!("read_dir {}", h3r4_dir.display()))
        }
    };
    let mut removed = 0usize;
    for entry in read {
        let entry = entry.with_context(|| format!("read_dir entry in {}", h3r4_dir.display()))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // The directory name is the R4 hex (`r4_hex_str` output). A
        // non-hex name means this subdir was created by an unrelated
        // tool — leave it alone.
        let Ok(r4) = u64::from_str_radix(name, 16) else {
            continue;
        };
        if let Some(s) = scope {
            if !s.contains_r4(r4) {
                continue;
            }
        }
        let stale = path.join(filename);
        if !stale.exists() {
            continue;
        }
        std::fs::remove_file(&stale)
            .with_context(|| format!("remove {}", stale.display()))?;
        eprintln!("[wipe] removed stale {}", stale.display());
        removed += 1;
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

    #[test]
    #[should_panic(expected = "filename must be a single basename")]
    fn rejects_filename_with_separator() {
        let tmp = tempfile::tempdir().unwrap();
        let _ = wipe_stale_arrows_for_scope(tmp.path(), "sub/path.arrow", None);
    }
}
