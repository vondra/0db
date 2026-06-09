#!/usr/bin/env python3
"""Per-layer code_ver for the cluster's incremental-regen stamps (build-heatmap-cluster.sh, regen
plan Part A). code_ver[L] = a CONTENT set-hash over SHARED ∪ L's EXCLUSIVE files, where SHARED = the
heatmap COMPUTE closure (the 4 compute crates' production *.rs/*.cu/Cargo.{toml,lock} + the global
build config .cargo/config.toml / rust-toolchain) MINUS every layer's exclusive files. A content hash,
NOT a max-mtime: a backdated git checkout or an rsync -a that preserves an old mtime still flips it
(/gg: codex). SHARED-by-subtraction is the safety property: no production file can be silently missed,
so editing shared physics rebuilds ALL layers (safe over-invalidation) while editing a layer-exclusive
loader/compute/emission rebuilds ONLY that layer. When unsure whether a file is single-layer, leave it
OUT of the exclusives → it lands in SHARED → over-invalidates safely.

Usage:
  layer-codever.py <engine_dir> <layer>=<space-sep paths> ...   → prints CODE_VER[layer]=<epoch>
  layer-codever.py <engine_dir> --check <layer>=<paths> ...      → tripwire: exit 1 if an exclusive
      path is missing, lives outside the closure, or two layers claim the same file (the disjoint
      partition that makes stale tiles impossible). Run it as a gate before relying on the stamps.
"""
import os, sys, hashlib

# the heatmap COMPUTE crates — NOT aircraft-extract / osm-extract (data prep; their edits change DATA,
# bumping data_ver via arrow mtimes, not code). Validator-only bins are dropped (not production output).
CRATES = ("heatmap-aircraft", "noise-compute", "noise-gpu", "raster-reader")
EXCLUDE_BINS = {"compare_floats.rs", "compare_hm3.rs", "e2_full.rs"}
# Global build inputs OUTSIDE the crates that still change produced tiles (e.g. rustflags=target-cpu).
GLOBAL_BUILD = (".cargo/config.toml", ".cargo/config", "rust-toolchain.toml", "rust-toolchain")


def closure_files(engine):
    out = set()
    for cr in CRATES:
        for dp, _, fns in os.walk(os.path.join(engine, cr)):
            if "/target/" in dp or dp.rstrip("/").endswith("/tests") or "/tests/" in dp:
                continue
            for fn in fns:
                if fn in EXCLUDE_BINS:
                    continue
                if fn.endswith((".rs", ".cu")) or fn in ("Cargo.toml", "Cargo.lock"):
                    out.add(os.path.join(dp, fn))
    repo = os.path.dirname(os.path.abspath(engine))
    for g in GLOBAL_BUILD:
        p = os.path.join(repo, g)
        if os.path.exists(p):
            out.add(p)   # SHARED (not any layer's exclusive) → an edit rebuilds every layer
    return out


def expand(engine, spec):
    """A spec is a file or a dir (recurse over its .rs/.cu); paths relative to engine/. A missing
    path is returned as-is so --check can flag it (a stale mapping after a rename)."""
    p = os.path.join(engine, spec)
    if os.path.isdir(p):
        return {os.path.join(dp, fn) for dp, _, fns in os.walk(p)
                for fn in fns if fn.endswith((".rs", ".cu"))}
    return {p}


_sig = {}


def file_sig(f):
    """Content hash of one file (computed once). Content, not mtime, so a backdated/preserved-mtime
    change still flips it — the data side already set-hashes, the code side must match that rigor."""
    if f not in _sig:
        try:
            with open(f, "rb") as fh:
                _sig[f] = hashlib.sha1(fh.read()).hexdigest()[:16]
        except OSError:
            _sig[f] = "0"
    return _sig[f]


def set_hash(files):
    return hashlib.sha1("\n".join(f"{f}\t{file_sig(f)}" for f in sorted(files)).encode()).hexdigest()[:16]


def main():
    engine = sys.argv[1]
    check = "--check" in sys.argv
    specs = [a for a in sys.argv[2:] if a != "--check"]
    excl = {}
    for a in specs:
        name, _, paths = a.partition("=")
        fs = set()
        for s in paths.split():
            fs |= expand(engine, s)
        excl[name] = fs

    allf = closure_files(engine)
    if check:
        ok = True
        seen = {}
        for L, fs in excl.items():
            for f in fs:
                if not os.path.exists(f):
                    print(f"MISSING exclusive {f} (layer {L})", file=sys.stderr); ok = False
                elif f not in allf:
                    print(f"OUT-OF-CLOSURE exclusive {f} (layer {L})", file=sys.stderr); ok = False
                if f in seen and seen[f] != L:
                    print(f"DUPLICATE {f}: layers {seen[f]} and {L}", file=sys.stderr); ok = False
                seen[f] = L
        sys.exit(0 if ok else 1)

    shared = (allf - set().union(*excl.values())) if excl else allf
    for L, fs in excl.items():
        # content set-hash over SHARED ∪ L's exclusives: a shared-physics edit flips every layer's hash;
        # a layer-exclusive edit flips only that layer's. (file_sig caches → each file is read once.)
        print(f"CODE_VER[{L}]={set_hash(shared | fs)}")


main()
