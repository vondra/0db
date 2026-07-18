#!/usr/bin/env python3
# cpu_rates.py — shared per-thread CPU-rate table for the Vast offer-scoring workload model.
# Data lives in cpu-rates.json (PassMark CPU Mark / threads); this module loads it and resolves a CPU
# name to a rate. Imported by world/vast-offers.py. Real on-box check-heatmap seconds are cached separately in
# box-timings.json (see box_timing.py), NOT folded into these priors. See cpu-rates.json "_doc".
import json
import os

RATES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cpu-rates.json")


def load_table():
    """The parsed cpu-rates.json (dict with 'rates' list + '_default_unknown_rate')."""
    with open(RATES_PATH) as f:
        return json.load(f)


def entry_rate(e):
    """Per-thread rate: an explicit pm (family fallback) else PassMark CPU Mark / threads.
    Real on-box timings live separately in box-timings.json — they are NOT folded in here."""
    return e["pm"] if "pm" in e else round(e["mark"] / e["threads"])


def find_entry(name, table=None):
    """Best entry whose 'match' substring is in name: a real (non-est) entry beats an est
    family-fallback, then the LONGEST match wins. Order-independent — the data file needn't be
    hand-sorted, and 'i9-7900X' beats AMD '7900X' for an Intel string because it matches longer."""
    table = table or load_table()
    nl = (name or "").lower()
    best = best_key = None
    for e in table["rates"]:
        if e["match"].lower() in nl:
            k = (1 if e.get("est") else 0, -len(e["match"]))
            if best_key is None or k < best_key:
                best, best_key = e, k
    return best


def cpu_rate(name, table=None):
    """(rate, known) for a CPU name. Unknown -> (_default_unknown_rate, False)."""
    table = table or load_table()
    e = find_entry(name, table)
    if e:
        return entry_rate(e), True
    return table.get("_default_unknown_rate", 1100), False
