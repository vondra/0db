#!/usr/bin/env python3
# gpu_rates_build.py — one-off recipe: scripts/gpu-benchmarks.csv (PassMark G3DMark, owner-supplied
# 2026-07-04) -> scripts/gpu-rates.json (the perfqmap GPU physics-baseline table, mirrors cpu-rates.json).
# NOT imported at runtime — perfqmap reads gpu-rates.json via gpu_rates.py only.
#
# Match-direction gotcha (found in /gg review, both models independently): cpu_rates.find_entry()'s
# contract is `stored_match_key ⊂ offered_name`. For CPUs this works because vast's cpu_name is the
# FULLER string. For GPUs it's REVERSED — vast's gpu_name is terse ("RTX 4060 Ti"), the CSV's Name is
# fuller marketing text ("GeForce RTX 4060 Ti", "GeForce RTX 4060 Ti 16GB", "Tesla V100-PCIE-16GB") — so
# CSV names must be normalized DOWN to vast's vocabulary here, at build time, not by flipping find_entry
# (kept shared/reused as-is). Getting this wrong fails SILENTLY: no exception, every card just resolves
# to unknown (g3d_known=False) and the physics leg falls to 0 for the whole fleet.
#
# Usage:
#   python3 scripts/gpu_rates_build.py            # CSV -> gpu-rates.json
#   python3 scripts/gpu_rates_build.py --check     # regenerate + diff against the committed JSON; exit 1 on drift
import csv
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(HERE, "gpu-benchmarks.csv")
JSON_PATH = os.path.join(HERE, "gpu-rates.json")

BRAND_PREFIX = re.compile(r"^(geforce|nvidia)\s+", re.IGNORECASE)
MEM_SUFFIX = re.compile(r"\s+\d+\s*gb$", re.IGNORECASE)          # "RTX 4060 Ti 16GB" -> "RTX 4060 Ti"
MOBILE_MARK = re.compile(r"laptop|mobile", re.IGNORECASE)         # never suffix-collapse these (stay distinct, weaker)

# Explicit multi-SKU collapses for known datacenter cards whose CSV rows differ only by interconnect/
# memory (verified against the CSV: "Tesla V100-PCIE-16GB", "Tesla V100-SXM2-16GB", "Tesla V100-PCIE-32GB").
# Deliberately NOT a blanket "-PCIE.*/-SXM.*" regex for every card: A100 has exactly ONE CSV row
# ("A100-SXM4-40GB") and must NOT be generalized down to bare "A100" — that would make find_entry() match
# it against an "A100 PCIE" vast offer too (the plan explicitly leaves that gap for a future CSV refresh;
# the empirical per-model layer in box_timing.model_ratios() covers A100 PCIE from real data instead).
# The prefix regex requires a delimiter (space/hyphen/end) right after "v100" (/gg Codex) — a bare
# `startswith("tesla v100")` would ALSO collapse a real distinct future SKU like "Tesla V100S..." (not in
# today's CSV, but cheap to guard against now rather than silently mis-collapsing it on a later refresh).
CANONICAL_PREFIX = [(re.compile(r"^tesla v100(?:[\s-]|$)", re.IGNORECASE), "Tesla V100")]


def normalize(raw_name):
    n = BRAND_PREFIX.sub("", raw_name.strip())
    for pattern, canon in CANONICAL_PREFIX:
        if pattern.match(n):
            return canon
    if not MOBILE_MARK.search(n):
        n = MEM_SUFFIX.sub("", n)
    return n


def build():
    rows = []
    with open(CSV_PATH, newline="") as f:
        for row in csv.DictReader(f):
            name = (row.get("Name") or "").strip()
            g3d = row.get("G3DMark") or ""
            samples = row.get("Samples") or "0"
            if not name or not g3d:
                continue
            try:
                g3d = float(g3d)
                samples = int(samples)
            except ValueError:
                continue
            rows.append((normalize(name), g3d, samples, name))

    buckets = {}
    for canon, g3d, samples, raw in rows:
        b = buckets.setdefault(canon, {"total": 0.0, "samples": 0, "raw": []})
        b["total"] += g3d * max(samples, 1)
        b["samples"] += max(samples, 1)
        b["raw"].append(raw)

    entries = []
    for canon, b in sorted(buckets.items()):
        entry = {"match": canon, "g3dmark": round(b["total"] / b["samples"]), "samples": b["samples"]}
        if len(b["raw"]) > 1:
            entry["note"] = "samples-weighted mean of: " + ", ".join(sorted(b["raw"]))
        entries.append(entry)

    return {
        "_doc": "Per-card GPU strength for perfqmap's physics-baseline GPU term (g3dmark / REF_GPU_G3DMARK). "
                "Matching (gpu_rates.find_entry, shared with cpu_rates.py): a match key is a substring of the "
                "offered gpu_name -- so CSV names are normalized DOWN to vast's terser vocabulary at build time "
                "(see gpu_rates_build.py's normalize()), the OPPOSITE direction from cpu-rates.json. This is a "
                "PRIOR only: box_timing.model_ratios() (real box-timings.json measurements, per GPU model) "
                "supersedes it via perfqmap's confidence-weighted blend as real samples accumulate.",
        "_g3dmark_source": "PassMark G3D Mark (gpu_benchmarks.csv, owner-supplied 2026-07-04, cpubenchmark.net export)",
        "rates": entries,
    }


if __name__ == "__main__":
    data = build()
    if "--check" in sys.argv[1:]:
        with open(JSON_PATH) as f:
            committed = json.load(f)
        if data != committed:
            sys.exit("gpu_rates_build: gpu-rates.json is STALE vs gpu-benchmarks.csv — re-run without --check to regenerate")
        print(f"gpu_rates_build: gpu-rates.json matches gpu-benchmarks.csv ({len(data['rates'])} entries)")
        sys.exit(0)
    with open(JSON_PATH, "w") as f:
        json.dump(data, f, indent=1, sort_keys=True)
        f.write("\n")
    print(f"gpu_rates_build: wrote {len(data['rates'])} entries -> {JSON_PATH}")
