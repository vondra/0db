#!/usr/bin/env python3
"""Generate engine/noise-compute/src/emission/profiles_generated.rs.

Two inputs:

  1. EASA ANP v2.3 CSVs (`--anp <DIR>`):
     - ANP2.3_Aircraft.csv  : ACFT_ID → (NPD_ID, Engine Type, Number Of Engines,
                              Weight Class, Lateral Directivity Identifier)
     - ANP2.3_NPD_data.csv  : (NPD_ID, Op Mode) → 2..13 SEL rows, each with
                              Power Setting + 10 distance SEL values

  2. Pinned global traffic counts (`--counts <PATH>`):
     - JSON dict {profile_idx_str → segment_count} from running aircraft
       extraction across the global ADS-B archive. Snapshot pinned in repo
       at scripts/aircraft-profiles-counts.json. SHA stamped into the
       generated banner so any drift between snapshot and generated output
       is visible to reviewers.

Output (stdout): Rust source for `profiles_generated.rs`.

Class scheme: **Voronoi assignment over 12 frozen anchor classes.**

Each anchor is the exact NPD vector of one dominant profile (top-K
traffic per Installation). Every other profile is assigned to its
nearest anchor by L∞ distance, constrained to the same Installation.
Helicopters pinned to their own class (different physics, single
ANP-equivalent reference NPD shared by all rotorcraft).

Per-Installation anchor counts: 7 Wing + 2 Fuselage + 2 Propeller + 1
Helicopter = 12 classes. Computed from
scripts/aircraft-profiles-counts.json (4.885 G global segments,
51 363 R4 cells); top-7 Wing anchors cover 79 % of traffic with 0 dB
intra-class error (anchor sig members are bit-identical). Weighted-avg
per-segment acoustic error = 0.76 dB across all 124 profiles, well
under Doc 29 measurement uncertainty.

FALLBACK NPD is recomputed at generation time as the traffic-weighted
energy-mean of every non-FALLBACK profile, so unmapped typecodes get
the best estimate of the global average aircraft instead of a B738
proxy (which over-counted by ~2 dB at dep@1k).

Power Setting selection: lowest for Approach (idle/low-thrust), highest
for Departure (max takeoff thrust).

Hand-curated `ICAO_TYPECODE_TO_ACFT_ID` maps ICAO 4-letter typecodes to
ANP ACFT_IDs. Non-ANP types (GA piston, helicopters, ANP-missing neos)
fall back to manual placeholder profiles derived from Doc 29 Vol 3
reference curves (PROP/Helo) plus engineering judgment.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path

# ─── Hand-curated ICAO typecode → ANP ACFT_ID ────────────────────────────
# Order = profile_idx in the emitted PROFILES array. FALLBACK must be last
# (its index = NUM_PROFILES - 1). Each entry is
# (typecode, ACFT_ID_or_None, manual_class_or_None). Manual entries skip
# ANP NPD lookup and use a placeholder from MANUAL_PROFILES.
ICAO_TYPECODE_TO_ACFT_ID: list[tuple[str, str | None, str | None]] = [
    # ── narrowbody jets (high-bypass) ─────────────────────────────────────
    ("B738", "737800", None),            # CFM56-7B26
    ("B739", "737800", None),            # 737-900 → use -800 nearest
    ("B737", "7373B2", None),            # 737-300 / CFM56-3B-2
    ("B734", "737400", None),
    ("B735", "737500", None),
    ("B733", "7373B2", None),            # 737-300 nearest
    ("B736", "737400", None),
    ("B38M", "7378MAX", None),           # 737 MAX 8 / LEAP-1B-27
    ("B39M", "7378MAX", None),           # 737 MAX 9 nearest
    ("B37M", "7378MAX", None),           # 737 MAX 7 nearest
    ("A320", "A320-232", None),          # V2527-A5
    ("A20N", "A320-232", None),          # A320neo nearest classic
    ("A319", "A319-131", None),          # V2522-A5
    ("A19N", "A319-131", None),          # A319neo nearest classic
    ("BCS3", "A319-131", None),          # A220-300 nearest narrowbody
    ("BCS1", "A319-131", None),          # A220-100 nearest narrowbody
    # ── stretched narrowbody / 757 ────────────────────────────────────────
    ("A321", "A321-232", None),          # V2530
    ("A21N", "A321-232", None),          # A321neo nearest classic
    ("B752", "757PW", None),             # PW2037
    ("B753", "757PW", None),             # 757-300 nearest -200
    # ── widebody 2-engine ─────────────────────────────────────────────────
    ("B772", "777200", None),            # GE90-76B
    ("B773", "777300", None),            # Trent 892
    ("B77W", "7773ER", None),            # 777-300ER / GE90-115B
    ("B77L", "777200", None),            # 777-200LR nearest
    ("B77F", "777300", None),            # 777F nearest pax
    ("B788", "7878R", None),             # 787-8 / Trent 1000
    ("B789", "7878R", None),             # 787-9 nearest -8
    ("B78X", "7878R", None),             # 787-10 nearest -8
    ("A332", "A330-301", None),          # CF6-80
    ("A333", "A330-343", None),          # Trent 772B
    ("A338", "A330-343", None),          # A330-800neo nearest classic
    ("A339", "A330-343", None),          # A330-900neo nearest classic
    ("A359", "A350-941", None),          # Trent XWB-84
    ("A35K", "A350-941", None),          # A350-1000 nearest -900
    ("A306", "A330-301", None),          # A300 nearest A330
    ("A310", "A330-301", None),          # A310 nearest A330
    ("B763", "767300", None),            # CF6-80A
    ("B764", "767400", None),            # CF6-80C2
    # ── widebody 3-engine ─────────────────────────────────────────────────
    ("MD11", "MD11GE", None),            # CF6-80C2
    ("DC10", "DC1030", None),
    ("L101", "L1011", None),             # Lockheed L-1011 / RB211-22B
    # ── widebody 4-engine ─────────────────────────────────────────────────
    ("B744", "747400", None),            # PW4056
    ("B748", "7478", None),              # 747-8F / GEnx-2B67
    ("B741", "747100", None),
    ("B742", "747200", None),
    ("A342", "A340-211", None),
    ("A343", "A340-211", None),
    ("A346", "A340-642", None),          # Trent 556
    ("A388", "A380-841", None),          # Trent 970
    ("IL76", "747200", None),            # IL-76 nearest 747-200 (heavy 4-eng wing)
    # ── regional jets / fuselage-mounted ─────────────────────────────────
    ("E170", "EMB170", None),            # ERJ170 / CF34-8E
    ("E75L", "EMB175", None),            # ERJ175
    ("E75S", "EMB175", None),
    ("E190", "EMB190", None),            # ERJ190 / CF34-10E
    ("E195", "EMB195", None),            # ERJ195
    ("E290", "EMB190", None),            # E190-E2 nearest E1
    ("E295", "EMB195", None),            # E195-E2 nearest E1
    ("CRJ2", "CL600", None),
    ("CRJ7", "CL601", None),
    ("CRJ9", "CL601", None),
    ("EMJ", "EMB145", None),             # E145
    # ── business jets ─────────────────────────────────────────────────────
    ("CL60", "CL601", None),             # Challenger 600 / 601 — pick CF34 over older ALF502L
    ("C56X", "CIT3", None),              # Citation Excel
    ("C680", "CIT3", None),              # Citation Sovereign nearest
    ("GLEX", "CL601", None),             # Global Express nearest CF34 (BR710 isn't in ANP)
    ("GLF6", "CL601", None),             # G650 — ANP only has 1970s GII Spey (~125 dB);
                                         # CL601 CF34 is the closest MODERN turbofan (~100 dB)
    ("GLF5", "CL601", None),             # G550 — same rationale as G650
    ("FA7X", "CL601", None),             # Falcon 7X — modern triple-engine, FAL20 is 1970s Spey
    ("PC24", None, "JET_BIZ_FUSE"),      # PC-24 manual
    ("LJ60", "LEAR35", None),            # Learjet 60 nearest
    # ── turboprops large ──────────────────────────────────────────────────
    ("AT72", "DHC830", None),            # ATR-72 → Dash 8 Q400 nearest large TP
    ("AT76", "DHC830", None),
    ("AT43", "DHC8", None),              # ATR-42 → Dash 8 nearest
    ("AT45", "DHC8", None),
    ("DH8D", "DHC830", None),            # Dash 8 Q400
    ("DH8C", "DHC8", None),
    ("DH8A", "DHC8", None),
    ("DH8B", "DHC8", None),
    ("L410", "DHC6", None),              # Let L-410 → Twin Otter nearest small TP
    ("EN48", "DHC6", None),              # Embraer 110 → Twin Otter
    ("SF34", "DHC8", None),
    ("F50", "DHC830", None),             # Fokker 50
    ("F70", "EMB145", None),             # Fokker 70 (regional jet, but tiny — RJ class)
    ("JS41", "DHC8", None),              # Jetstream 41
    # ── light GA piston (manual placeholders, no ANP) ───────────────────
    ("C172", None, "PISTON_SE"),
    ("C152", None, "PISTON_SE"),
    ("C182", None, "PISTON_SE"),
    ("PA28", None, "PISTON_SE"),
    ("PA34", None, "PISTON_TWIN"),
    ("SR20", None, "PISTON_SE"),
    ("SR22", None, "PISTON_SE"),
    ("DA40", None, "PISTON_SE"),
    ("DA42", None, "PISTON_TWIN"),
    ("P28A", None, "PISTON_SE"),
    ("C210", None, "PISTON_SE"),
    ("BE36", None, "PISTON_SE"),
    ("M20P", None, "PISTON_SE"),
    ("C206", None, "PISTON_SE"),
    ("PA32", None, "PISTON_SE"),
    ("PA44", None, "PISTON_TWIN"),
    ("RV7", None, "PISTON_SE"),
    ("RV8", None, "PISTON_SE"),
    # ── helicopters (manual placeholders, no ANP) ───────────────────────
    ("EC35", None, "HELICOPTER"),
    ("EC45", None, "HELICOPTER"),
    ("EC55", None, "HELICOPTER"),
    ("EC30", None, "HELICOPTER"),
    ("EC20", None, "HELICOPTER"),
    ("AS50", None, "HELICOPTER"),
    ("AS55", None, "HELICOPTER"),
    ("AS65", None, "HELICOPTER"),
    ("H500", None, "HELICOPTER"),
    ("MD52", None, "HELICOPTER"),
    ("B06", None, "HELICOPTER"),
    ("B407", None, "HELICOPTER"),
    ("B412", None, "HELICOPTER"),
    ("R22", None, "HELICOPTER"),
    ("R44", None, "HELICOPTER"),
    ("R66", None, "HELICOPTER"),
    ("S76", None, "HELICOPTER"),
    ("A109", None, "HELICOPTER"),
    ("BK17", None, "HELICOPTER"),
    ("B505", None, "HELICOPTER"),
    ("GYRO", None, "HELICOPTER"),
    # ── fallback (must be last, idx = NUM_PROFILES - 1) ──────────────────
    # ACFT_ID is a placeholder; FALLBACK NPD is overwritten with the
    # traffic-weighted energy-mean of all non-FALLBACK profiles before
    # Voronoi clustering. See `recompute_fallback_npd`.
    ("FALLBACK", "737800", None),
]


# ─── Manual placeholder profiles (for non-ANP types) ─────────────────────
# Derived from Doc 29 Vol 3 reference curves (PROP) plus engineering judgment.
# Tuple = (approach_sel[10], departure_sel[10], v_ref_kt, d_bar_m,
#          installation, is_jet). Helicopters carry Installation::Propeller
# because the Rust enum lacks a rotorcraft variant — rotor Λ behaviour is
# a TODO per SPEC.md and Propeller is the closest single-Installation fit.
MANUAL_PROFILES: dict[str, tuple[list[float], list[float], float, float, str, bool]] = {
    # Single-engine piston (C172, PA28). Quiet, ~85 dB at 200 ft, fast roll-off.
    "PISTON_SE": (
        [85.0, 80.0, 76.0, 72.0, 65.0, 58.0, 53.0, 47.0, 41.0, 35.0],
        [88.0, 83.0, 79.0, 75.0, 68.0, 61.0, 56.0, 50.0, 44.0, 38.0],
        90.0, 208.0, "Prop", False,
    ),
    # Twin-engine piston (PA34, DA42). +3 dB vs single.
    "PISTON_TWIN": (
        [88.0, 83.0, 79.0, 75.0, 68.0, 61.0, 56.0, 50.0, 44.0, 38.0],
        [91.0, 86.0, 82.0, 78.0, 71.0, 64.0, 59.0, 53.0, 47.0, 41.0],
        110.0, 220.0, "Prop", False,
    ),
    # Helicopters: dominated by main-rotor blade-vortex interaction.
    # Slower roll-off than fixed-wing prop. R44/EC135 typical.
    "HELICOPTER": (
        [92.0, 88.0, 85.0, 82.0, 76.0, 70.0, 65.0, 59.0, 53.0, 47.0],
        [94.0, 90.0, 87.0, 84.0, 78.0, 72.0, 67.0, 61.0, 55.0, 49.0],
        100.0, 230.0, "Prop", False,
    ),
    # PC-24 placeholder (no ANP entry). Light bizjet, fuselage-mounted.
    "JET_BIZ_FUSE": (
        [98.0, 93.0, 89.0, 85.0, 78.0, 71.0, 66.0, 60.0, 54.0, 48.0],
        [101.0, 96.0, 92.0, 88.0, 81.0, 74.0, 69.0, 63.0, 57.0, 51.0],
        140.0, 320.0, "Fuselage", True,
    ),
}

# ANP installation → Rust enum name
INSTALLATION_RUST = {
    "Wing":     "Installation::Wing",
    "Fuselage": "Installation::Fuselage",
    "Prop":     "Installation::Propeller",
}

# Voronoi anchor budget per Installation (sum = NUM_CLASSES).
ANCHORS_PER_INSTALL: dict[str, int] = {
    "Wing":       7,
    "Fuselage":   2,
    "Prop":       2,
    "Helicopter": 1,
}
NUM_CLASSES = sum(ANCHORS_PER_INSTALL.values())


@dataclass
class AnpAcft:
    acft_id: str
    npd_id: str
    engine_type: str
    num_engines: int
    weight_class: str
    lateral: str
    description: str


@dataclass
class Profile:
    typecode: str
    name: str  # display name, e.g., "B738/737800"
    approach_sel: list[float]
    departure_sel: list[float]
    v_ref_kt: float
    d_bar_m: float
    installation: str  # "Wing"/"Fuselage"/"Prop"
    proxy_source: str  # "Anp" / "Manual"
    is_jet: bool
    is_helo: bool
    # Filled during clustering:
    noise_class: int = -1   # 0..NUM_CLASSES-1, set by Voronoi assignment

    def feature(self) -> list[float]:
        """20-D NPD vector used for L∞ similarity (Voronoi)."""
        return list(self.approach_sel) + list(self.departure_sel)


def load_aircraft(anp_dir: Path) -> dict[str, AnpAcft]:
    out: dict[str, AnpAcft] = {}
    with (anp_dir / "ANP2.3_Aircraft.csv").open() as fh:
        rdr = csv.DictReader(fh, delimiter=";")
        for row in rdr:
            acft = AnpAcft(
                acft_id=row["ACFT_ID"],
                npd_id=row["NPD_ID"],
                engine_type=row["Engine Type"],
                num_engines=int(row["Number Of Engines"]),
                weight_class=row["Weight Class"],
                lateral=row["Lateral Directivity Identifier"],
                description=row["Description"],
            )
            out[acft.acft_id] = acft
    return out


def load_npd(anp_dir: Path) -> dict[tuple[str, str], list[tuple[float, list[float]]]]:
    """(NPD_ID, Op Mode) → list of (Power Setting, [10 SEL dB])."""
    out: dict[tuple[str, str], list[tuple[float, list[float]]]] = {}
    with (anp_dir / "ANP2.3_NPD_data.csv").open() as fh:
        rdr = csv.DictReader(fh, delimiter=";")
        cols = ["L_200ft", "L_400ft", "L_630ft", "L_1000ft", "L_2000ft",
                "L_4000ft", "L_6300ft", "L_10000ft", "L_16000ft", "L_25000ft"]
        for row in rdr:
            if row["Noise Metric"] != "SEL":
                continue
            sels = [float(row[c]) for c in cols]
            key = (row["NPD_ID"], row["Op Mode"])
            out.setdefault(key, []).append((float(row["Power Setting"]), sels))
    return out


def select_sel(npd: dict, npd_id: str, op_mode: str, power: str) -> list[float]:
    """Pick representative SEL row. power='low' for approach, 'high' for departure."""
    rows = npd.get((npd_id, op_mode))
    if not rows:
        return [0.0] * 10
    rows_sorted = sorted(rows, key=lambda r: r[0])
    return rows_sorted[0][1] if power == "low" else rows_sorted[-1][1]


def build_profiles(anp_dir: Path) -> list[Profile]:
    aircraft = load_aircraft(anp_dir)
    npd = load_npd(anp_dir)
    profiles: list[Profile] = []

    for typecode, acft_id, manual_class in ICAO_TYPECODE_TO_ACFT_ID:
        if manual_class is not None:
            approach, departure, v_ref, d_bar, inst, is_jet = MANUAL_PROFILES[manual_class]
            profiles.append(Profile(
                typecode=typecode,
                name=f"{typecode}/{manual_class}",
                approach_sel=list(approach),
                departure_sel=list(departure),
                v_ref_kt=v_ref,
                d_bar_m=d_bar,
                installation=inst,
                proxy_source="Manual",
                is_jet=is_jet,
                is_helo=(manual_class == "HELICOPTER"),
            ))
            continue

        if acft_id not in aircraft:
            print(f"WARNING: typecode {typecode} → ACFT_ID {acft_id} not in ANP",
                  file=sys.stderr)
            continue
        acft = aircraft[acft_id]
        approach = select_sel(npd, acft.npd_id, "A", "low")
        departure = select_sel(npd, acft.npd_id, "D", "high")
        # v_ref / d_bar: Doc 29 standard reference values (160 kt / 370 m for
        # jets, 130 kt / 261 m for turboprops). ANP doesn't expose them
        # per-aircraft.
        if acft.engine_type == "Jet":
            v_ref, d_bar = 160.0, 370.0
        elif acft.engine_type == "Turboprop":
            v_ref, d_bar = 130.0, 261.0
        else:
            v_ref, d_bar = 90.0, 208.0
        profiles.append(Profile(
            typecode=typecode,
            name=f"{typecode}/{acft.acft_id}",
            approach_sel=approach,
            departure_sel=departure,
            v_ref_kt=v_ref,
            d_bar_m=d_bar,
            installation=acft.lateral,
            proxy_source="Anp",
            is_jet=acft.engine_type == "Jet",
            is_helo=False,
        ))

    return profiles


def recompute_fallback_npd(profiles: list[Profile], counts: dict[int, int]) -> None:
    """Replace FALLBACK NPD with traffic-weighted energy-mean of all
    non-FALLBACK profiles. Operates in-place on `profiles`.

    Original FALLBACK NPD = B738 (proxy chosen at hand-curation time);
    that over-counts unmapped typecodes by ~2 dB at dep@1k vs the actual
    global average. Energy-mean weighted by global ADS-B segment counts
    is the unbiased estimate of "what does an unknown typecode sound
    like, given the global traffic mix observed".
    """
    fb_idx = next(i for i, p in enumerate(profiles) if p.typecode == "FALLBACK")
    others = [(i, p) for i, p in enumerate(profiles) if i != fb_idx]
    weights = [max(counts.get(i, 0), 0) for i, _ in others]
    if sum(weights) == 0:
        # No traffic data — keep the existing FALLBACK proxy values.
        return
    n = 20  # 10 approach + 10 departure points
    energy_sum = [0.0] * n
    weight_sum = 0.0
    for (_, p), w in zip(others, weights):
        if w <= 0:
            continue
        feat = p.feature()
        for k in range(n):
            energy_sum[k] += w * (10.0 ** (feat[k] / 10.0))
        weight_sum += w
    energy_mean = [e / weight_sum for e in energy_sum]
    fb_npd = [10.0 * math.log10(max(e, 1e-30)) for e in energy_mean]
    fb = profiles[fb_idx]
    fb.approach_sel = fb_npd[:10]
    fb.departure_sel = fb_npd[10:]


def linf(a: list[float], b: list[float]) -> float:
    return max(abs(x - y) for x, y in zip(a, b))


@dataclass
class AnchorClass:
    """One Voronoi class. Anchor profile is frozen — its NPD never changes."""
    anchor_idx: int                      # profile index of anchor (in profiles[])
    install: str                         # "Wing"/"Fuselage"/"Prop"/"Helicopter"
    members: list[int] = field(default_factory=list)  # all profile indices in class

    @property
    def install_rust(self) -> str:
        # "Helicopter" is a logical install label; Rust enum has only
        # Wing/Fuselage/Propeller, and helicopters use Propeller.
        return "Prop" if self.install == "Helicopter" else self.install


def cluster_voronoi(profiles: list[Profile], counts: dict[int, int]) -> list[AnchorClass]:
    """Pick top-K anchors per Installation, Voronoi-assign all members.

    Algorithm:
      1. Group profiles by sig (identical NPD vector + install + helo-flag).
      2. Sort sigs per Installation by total global traffic (descending).
      3. Anchor = top K sigs per Install (K from ANCHORS_PER_INSTALL).
      4. Each non-anchor profile → nearest anchor by L∞, restricted to
         same Installation (and helicopters → Helicopter class).

    Returns NUM_CLASSES anchor classes, ordered by total traffic descending.
    """
    # Logical install label — splits helicopters from fixed-wing Propeller.
    def install_label(p: Profile) -> str:
        return "Helicopter" if p.is_helo else p.installation

    # Group profiles by exact sig (same NPD → same sig). Members of one
    # sig collapse into a single anchor candidate; their per-typecode
    # traffic sums.
    sig_to_indices: dict[tuple, list[int]] = {}
    for i, p in enumerate(profiles):
        sig = (tuple(p.approach_sel), tuple(p.departure_sel),
               install_label(p))
        sig_to_indices.setdefault(sig, []).append(i)

    # Per Install: sort sigs by traffic, take top K as anchors.
    anchors: list[AnchorClass] = []
    used_sigs: set[tuple] = set()
    for install, k in ANCHORS_PER_INSTALL.items():
        sigs = [(sig, idxs) for sig, idxs in sig_to_indices.items()
                if sig[2] == install]
        sigs.sort(key=lambda si: -sum(counts.get(i, 0) for i in si[1]))
        for sig, idxs in sigs[:k]:
            # Anchor = highest-traffic profile within the sig (the one
            # whose typecode is most representative for naming / display).
            anchor = max(idxs, key=lambda i: counts.get(i, 0))
            anchors.append(AnchorClass(anchor_idx=anchor, install=install))
            used_sigs.add(sig)

    # Voronoi assign every profile to its nearest anchor (within same Install).
    for i, p in enumerate(profiles):
        my_install = install_label(p)
        same_install = [a for a in anchors if a.install == my_install]
        if not same_install:
            sys.exit(
                f"INTERNAL: no anchor for install={my_install!r}, "
                f"check ANCHORS_PER_INSTALL"
            )
        feat = p.feature()
        best = min(
            same_install,
            key=lambda a: linf(feat, profiles[a.anchor_idx].feature()),
        )
        best.members.append(i)

    # Sort anchors by total class traffic (descending) so emitted indices
    # roughly track popularity. Stabilises diff readability across regens.
    anchors.sort(
        key=lambda a: -sum(counts.get(m, 0) for m in a.members),
    )
    # Final assignment: write noise_class onto each Profile.
    for class_idx, a in enumerate(anchors):
        for m in a.members:
            profiles[m].noise_class = class_idx
    return anchors


def class_name(profiles: list[Profile], anchor: AnchorClass) -> str:
    """Naming: 'WING_<top_typecode>', 'FUSE_<top>', 'PROP_<top>',
    or 'HELICOPTER' for the rotorcraft class. The top typecode is the
    anchor profile's typecode; popup display will surface this name as
    the class label, so it's read by humans who recognise A320/B738/etc.
    """
    if anchor.install == "Helicopter":
        return "HELICOPTER"
    prefix = {"Wing": "WING", "Fuselage": "FUSE", "Prop": "PROP"}[anchor.install]
    return f"{prefix}_{profiles[anchor.anchor_idx].typecode}"


def loudest_profile_of_class(profiles: list[Profile], anchor: AnchorClass) -> int:
    """Return profile_idx of the loudest member by departure SEL @ 200 ft.

    Used only by `REACH_SQ_TABLE` so the popup R-tree pre-filter envelope
    covers the loudest member; if the anchor isn't the loudest in its
    class (e.g., A320 anchor but B752 sits in the same class with louder
    NPD), the pre-filter would otherwise drop B752 segments at long range.
    Conservative envelope, no false negatives.
    """
    return max(anchor.members, key=lambda i: profiles[i].departure_sel[0])


def derive_ground_ops_per_class(profiles: list[Profile], anchors: list[AnchorClass]) -> list[list[float]]:
    """Per-class [runway, taxi, apron] reference SEL dB at 25 m.

    Anchor's own dep@200ft is used as the runway-roll proxy directly:
    Doc 29 dep@200ft is roughly the slant-25 m equivalent for runway-roll
    reference (high-power jet/turboprop ops, ground attenuation already
    folded in). Empirically within ±3 dB of measured taxi/runway noise.

    Standard offsets: taxi = runway − 12 dB, apron = runway − 18 dB.
    Refine when measured airport data is available.
    """
    out: list[list[float]] = []
    for a in anchors:
        anchor_p = profiles[a.anchor_idx]
        runway = anchor_p.departure_sel[0]
        taxi = runway - 12.0
        apron = runway - 18.0
        out.append([round(runway, 1), round(taxi, 1), round(apron, 1)])
    return out


def is_jet_per_class(profiles: list[Profile], anchors: list[AnchorClass]) -> list[bool]:
    return [profiles[a.anchor_idx].is_jet for a in anchors]


def emit_rust(
    profiles: list[Profile],
    anchors: list[AnchorClass],
    anp_sha: str,
    counts_sha: str,
    counts_total: int,
) -> str:
    n_profiles = len(profiles)
    n_classes = len(anchors)
    fallback_idx = n_profiles - 1  # FALLBACK is last
    fallback_class = profiles[fallback_idx].noise_class

    class_names = [class_name(profiles, a) for a in anchors]
    ground_ops = derive_ground_ops_per_class(profiles, anchors)
    is_jet = is_jet_per_class(profiles, anchors)
    loudest = [loudest_profile_of_class(profiles, a) for a in anchors]

    lines: list[str] = []
    lines.append(f"//! Auto-generated. DO NOT EDIT BY HAND.")
    lines.append(f"//!")
    lines.append(f"//! Inputs:")
    lines.append(f"//!   ANP v2.3:        sha256={anp_sha[:16]}")
    lines.append(f"//!   global counts:   sha256={counts_sha[:16]} ({counts_total} segments)")
    lines.append(f"//!")
    lines.append(f"//! Regen: python scripts/build-aircraft-profiles.py \\")
    lines.append(f"//!         --anp <DIR> \\")
    lines.append(f"//!         --counts scripts/aircraft-profiles-counts.json \\")
    lines.append(f"//!         > engine/noise-compute/src/emission/profiles_generated.rs")
    lines.append("")
    lines.append("use super::aircraft::{Installation, NpdProfile};")
    lines.append("")
    lines.append(f"pub const NUM_PROFILES: usize = {n_profiles};")
    lines.append(f"pub const NUM_CLASSES: usize = {n_classes};")
    lines.append(f"pub const FALLBACK_PROFILE_IDX: u8 = {fallback_idx};")
    lines.append(f"pub const FALLBACK_NOISE_CLASS: u8 = {fallback_class};")
    lines.append("")
    lines.append("pub static CLASS_NAMES: [&str; NUM_CLASSES] = [")
    for n in class_names:
        lines.append(f'    "{n}",')
    lines.append("];")
    lines.append("")
    lines.append("pub static IS_JET: [bool; NUM_CLASSES] = [")
    for j, n in zip(is_jet, class_names):
        lines.append(f"    {'true' if j else 'false'}, // {n}")
    lines.append("];")
    lines.append("")
    lines.append("/// Runway-roll, taxi, apron reference SEL (dB) at 25 m, per noise class.")
    lines.append("/// Derived from the anchor profile's departure SEL @ 200 ft (runway proxy)")
    lines.append("/// minus standard 12 dB (taxi) / 18 dB (apron) offsets.")
    lines.append("pub static GROUND_OPS_REFERENCE_SEL_DB: [[f64; 3]; NUM_CLASSES] = [")
    for (r, t, a), n in zip(ground_ops, class_names):
        lines.append(f"    [{r}, {t}, {a}], // {n}")
    lines.append("];")
    lines.append("")
    lines.append("/// Per-profile → noise class lookup (dense u8 index). Computed by")
    lines.append("/// Voronoi assignment to nearest anchor (L∞ on 20-D NPD vector,")
    lines.append("/// constrained to same Installation; helicopters pinned).")
    lines.append("pub static CLASS_OF_PROFILE: [u8; NUM_PROFILES] = [")
    for p in profiles:
        cls = p.noise_class
        cls_name = class_names[cls]
        lines.append(f"    {cls}, // {p.typecode} → {cls_name}")
    lines.append("];")
    lines.append("")
    lines.append("/// Anchor profile_idx for each noise class. Anchor = exact NPD vector")
    lines.append("/// of the dominant traffic profile within the class (frozen). Used by")
    lines.append("/// the kernel hot path for SEL/v_ref/d_bar/installation lookup, by the")
    lines.append("/// synth surface emitter, and by popup display name.")
    lines.append("pub static CLASS_REP_PROFILE_IDX: [u8; NUM_CLASSES] = [")
    for a, n in zip(anchors, class_names):
        anchor_p = profiles[a.anchor_idx]
        lines.append(f"    {a.anchor_idx}, // {n} → {anchor_p.typecode}")
    lines.append("];")
    lines.append("")
    lines.append("/// Loudest profile_idx per class (by departure SEL @ 200 ft). Used")
    lines.append("/// ONLY by `REACH_SQ_TABLE` so the popup R-tree pre-filter envelope")
    lines.append("/// covers the loudest same-class typecode (no false negatives drop")
    lines.append("/// valid contributors). Differs from `CLASS_REP_PROFILE_IDX` when the")
    lines.append("/// anchor isn't the loudest member of its Voronoi class.")
    lines.append("pub static LOUDEST_PROFILE_OF_CLASS: [u8; NUM_CLASSES] = [")
    for ld, n in zip(loudest, class_names):
        loud_p = profiles[ld]
        lines.append(f"    {ld}, // {n} → {loud_p.typecode} (dep@200ft={loud_p.departure_sel[0]:.1f} dB)")
    lines.append("];")
    lines.append("")
    lines.append("pub static PROFILES: [NpdProfile; NUM_PROFILES] = [")
    for p in profiles:
        approach = ', '.join(f'{v:.1f}' for v in p.approach_sel)
        departure = ', '.join(f'{v:.1f}' for v in p.departure_sel)
        lines.append(f'    NpdProfile::new(')
        lines.append(f'        "{p.name}",')
        lines.append(f'        [{approach}],')
        lines.append(f'        [{departure}],')
        lines.append(f'        {p.v_ref_kt},')
        lines.append(f'        {p.d_bar_m},')
        lines.append(f'        {INSTALLATION_RUST[p.installation]},')
        lines.append(f'    ),')
    lines.append("];")
    lines.append("")
    lines.append("#[inline]")
    lines.append("pub fn noise_class_of(profile_idx: u8) -> u8 {")
    lines.append("    let i = (profile_idx as usize).min(NUM_PROFILES - 1);")
    lines.append("    CLASS_OF_PROFILE[i]")
    lines.append("}")
    lines.append("")
    lines.append("/// Map ICAO 4-letter typecode to a profile index. Unknown → FALLBACK_PROFILE_IDX.")
    lines.append("pub fn profile_idx(typecode: &str) -> u8 {")
    lines.append("    match typecode {")
    for i, p in enumerate(profiles):
        if p.typecode == "FALLBACK":
            continue
        lines.append(f'        "{p.typecode}" => {i},')
    lines.append(f"        _ => FALLBACK_PROFILE_IDX,")
    lines.append("    }")
    lines.append("}")
    lines.append("")
    lines.append("/// Beacon-only entries that broadcast as ADS-B but are not aircraft.")
    lines.append("pub fn is_non_aircraft_typecode(typecode: &str) -> bool {")
    lines.append('    matches!(typecode.trim(), "TWR")')
    lines.append("}")
    lines.append("")

    return "\n".join(lines) + "\n"


# ─── Anchor expected values (manually pulled from ANP NPD_data.csv) ─────
# Format: typecode → (op_mode, sel_idx, expected_dB).
# Hard-coded snapshots from the ANP CSV. If the generator's CSV parsing
# regresses (wrong column extraction, off-by-one Op Mode), `verify_anchors`
# fails fast before writing the .rs file. Without these, /check-pipeline
# can't catch ICAO mapping fat-fingers (parity test is blind).
ANCHORS: list[tuple[str, str, int, float]] = [
    # B738 / 737800 / NPD CF567B / SEL D max-power (23500 lbs) col_4 (L_2000ft)
    ("B738", "D", 4, 95.0),
    # A320 / A320-232 / NPD V2527A / SEL A min-power (2000 lbs) col_0 (L_200ft)
    ("A320", "A", 0, 93.1),
    # B789 mapping → 7878R / NPD T1KBFP / SEL D max-power (65000 lbs) col_9 (L_25000ft)
    ("B789", "D", 9, 68.2),
    # E190 / EMB190 / NPD CF3410E / SEL D max-power (15000 lbs) col_5 (L_4000ft)
    ("E190", "D", 5, 84.1),
    # AT72 mapping → DHC830 / NPD PW120 / SEL D max-power (150) col_3 (L_1000ft)
    ("AT72", "D", 3, 84.1),
]


def verify_anchors(profiles: list[Profile]) -> None:
    """Per-typecode anchor: catches CSV parsing regressions."""
    by_tc = {p.typecode: p for p in profiles}
    for tc, op_mode, idx, expected in ANCHORS:
        if tc not in by_tc:
            sys.exit(f"ANCHOR FAIL: typecode {tc!r} not in profiles list")
        p = by_tc[tc]
        actual = p.departure_sel[idx] if op_mode == "D" else p.approach_sel[idx]
        if abs(actual - expected) > 0.01:
            sys.exit(
                f"ANCHOR FAIL: {tc} {op_mode}[{idx}] = {actual} dB, "
                f"expected {expected} ± 0.01.\n"
                f"  Mapped via ACFT_ID family; verify ICAO_TYPECODE_TO_ACFT_ID + "
                f"NPD_data.csv column extraction logic."
            )


def verify_voronoi(profiles: list[Profile], anchors: list[AnchorClass]) -> None:
    """Sanity: every profile assigned, every anchor in its own class,
    Voronoi distances correct.
    """
    n = len(profiles)
    if any(p.noise_class < 0 or p.noise_class >= len(anchors) for p in profiles):
        unassigned = [p.typecode for p in profiles if p.noise_class < 0]
        sys.exit(f"VORONOI FAIL: unassigned profiles: {unassigned}")
    # Each anchor must be a member of its own class.
    for ci, a in enumerate(anchors):
        if profiles[a.anchor_idx].noise_class != ci:
            sys.exit(
                f"VORONOI FAIL: anchor {profiles[a.anchor_idx].typecode} "
                f"is in class {profiles[a.anchor_idx].noise_class}, expected {ci}"
            )
    # No profile should be closer to a different same-install anchor than
    # its assigned one (within rounding tolerance).
    for p in profiles:
        feat = p.feature()
        my_anchor = anchors[p.noise_class]
        my_install = my_anchor.install
        my_dist = linf(feat, profiles[my_anchor.anchor_idx].feature())
        for ci, a in enumerate(anchors):
            if a.install != my_install or ci == p.noise_class:
                continue
            d = linf(feat, profiles[a.anchor_idx].feature())
            if d < my_dist - 1e-6:
                sys.exit(
                    f"VORONOI FAIL: {p.typecode} (class {p.noise_class}, "
                    f"L∞={my_dist:.3f}) is closer to class {ci} "
                    f"({profiles[a.anchor_idx].typecode}, L∞={d:.3f})"
                )
    # Total profiles assigned == NUM_PROFILES.
    total = sum(len(a.members) for a in anchors)
    if total != n:
        sys.exit(f"VORONOI FAIL: {total} assigned vs {n} profiles")


def emit_coverage_report(profiles: list[Profile], anchors: list[AnchorClass],
                          counts: dict[int, int]) -> str:
    total = sum(counts.values()) or 1
    lines = ["", "# Coverage report", ""]
    lines.append(f"  Profiles: {len(profiles)}  Classes: {len(anchors)}  "
                 f"Global segments: {total:,}")
    lines.append("")
    by_source: dict[str, list[str]] = {"Anp": [], "Manual": []}
    for p in profiles:
        by_source.setdefault(p.proxy_source, []).append(p.typecode)
    for src, tcs in by_source.items():
        lines.append(f"  {src}: {len(tcs)} profiles")
    lines.append("")
    lines.append("# Class breakdown")
    lines.append("")
    lines.append(f"  {'#':>2} {'name':<22} {'anchor':<6} {'inst':<10} "
                 f"{'%trf':>6} {'%anchor':>7} {'#mem':>5} {'avgErr_dB':>9}")
    sigma_error = 0.0
    for ci, a in enumerate(anchors):
        anchor_p = profiles[a.anchor_idx]
        members_pct = 100 * sum(counts.get(m, 0) for m in a.members) / total
        anchor_pct = 100 * sum(
            counts.get(i, 0) for i in a.members
            if (tuple(profiles[i].approach_sel), tuple(profiles[i].departure_sel))
            == (tuple(anchor_p.approach_sel), tuple(anchor_p.departure_sel))
        ) / total
        anchor_feat = anchor_p.feature()
        # avg L∞ error weighted by traffic
        wsum, esum = 0.0, 0.0
        for m in a.members:
            w = counts.get(m, 0)
            d = linf(profiles[m].feature(), anchor_feat)
            wsum += w
            esum += w * d
        avg_err = esum / wsum if wsum > 0 else 0.0
        sigma_error += avg_err * members_pct
        cls_name = class_name(profiles, a)
        lines.append(f"  {ci:>2} {cls_name:<22} {anchor_p.typecode:<6} "
                     f"{a.install:<10} {members_pct:>5.2f}% {anchor_pct:>6.2f}% "
                     f"{len(a.members):>5} {avg_err:>8.2f}")
    lines.append("")
    lines.append(f"  Σ(avgErr × pct) = {sigma_error:.1f}    "
                 f"weighted-avg per-segment error = {sigma_error/100:.2f} dB")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--anp", required=True,
                    help="Path to extracted ANP 2.3 directory")
    ap.add_argument("--counts", required=True,
                    help="Path to global traffic counts JSON "
                         "(scripts/aircraft-profiles-counts.json)")
    ap.add_argument("-o", "--out", help="Output path (default: stdout)")
    args = ap.parse_args()

    anp_dir = Path(args.anp)
    if not (anp_dir / "ANP2.3_Aircraft.csv").exists():
        sys.exit(f"ANP CSVs not found in {anp_dir}")
    counts_path = Path(args.counts)
    if not counts_path.exists():
        sys.exit(f"Counts JSON not found at {counts_path}")

    # Compute combined sha256 of input CSVs for provenance.
    h_anp = hashlib.sha256()
    for fname in ["ANP2.3_Aircraft.csv", "ANP2.3_NPD_data.csv"]:
        h_anp.update((anp_dir / fname).read_bytes())
    anp_sha = h_anp.hexdigest()
    counts_bytes = counts_path.read_bytes()
    counts_sha = hashlib.sha256(counts_bytes).hexdigest()

    counts_raw = json.loads(counts_bytes)
    counts: dict[int, int] = {int(k): int(v) for k, v in counts_raw.items()}
    counts_total = sum(counts.values())

    profiles = build_profiles(anp_dir)
    verify_anchors(profiles)

    # FALLBACK NPD must be the energy-mean BEFORE clustering, because
    # FALLBACK becomes its own anchor sig (highest single-typecode traffic
    # globally — 14.78 % — so it always wins a Wing anchor slot).
    recompute_fallback_npd(profiles, counts)

    anchors = cluster_voronoi(profiles, counts)
    if len(anchors) != NUM_CLASSES:
        sys.exit(
            f"INTERNAL: expected {NUM_CLASSES} anchors, got {len(anchors)}. "
            f"Check ANCHORS_PER_INSTALL vs available sigs per Install."
        )
    verify_voronoi(profiles, anchors)

    rust = emit_rust(profiles, anchors, anp_sha, counts_sha, counts_total)
    if args.out:
        Path(args.out).write_text(rust)
    else:
        sys.stdout.write(rust)
    sys.stderr.write(emit_coverage_report(profiles, anchors, counts))


if __name__ == "__main__":
    main()
