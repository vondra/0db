# Noise Compute Engine — Specification

Engineering formulas inspired by CNOSSOS-EU 2021/1226, ISO 9613-2:2024, and ECAC Doc 29 4th Edition. This is NOT a certified implementation of any standard. Simplifications are documented in each section.

**Purpose**: Global noise atlas for public information ("where do I hear noise"). Not regulatory END mapping.

*Last verified against code: 2026-06-10 (whole-file audit of `noise-compute`, `source-reader`, `aircraft-extract`, `raster-reader`).*

## Constants

### Receiver
- **Height**: 4.0 m (END standard facade height)
- **Temperature**: 15 °C
- **Humidity**: 70% RH
- **Pressure**: 101.325 kPa

### Octave bands
8 bands: 63, 125, 250, 500, 1000, 2000, 4000, 8000 Hz

### A-weighting (IEC 61672-1)
```
A = [-26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1] dB
```

### Atmospheric absorption (ISO 9613-1, 15°C 70%RH)
```
α_atm = [0.1, 0.4, 1.0, 1.9, 3.7, 8.7, 22.0, 58.4] dB/km
```

### Vegetation attenuation (ISO 9613-2:2024 Annex A.2.2 × 0.5 Central Europe calibration)
```
α_veg = [0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.045, 0.06] dB/m
max = [2, 3, 4, 5, 6, 8, 9, 12] dB per band
```
Reason for × 0.5: ESA WorldCover class 10 covers canopy ≥ 10 %; ISO A.2.2 calibrated for dense
foliage in full leaf. Scalar approximates average Central European mixed forest canopy density
(~50 %). See `docs/future-plans/forest-continuous-density.md` for the continuous-density plan
(Copernicus HRL TCD + Hansen GFC) that replaces the scalar with per-pixel canopy fraction.

### Ground correction factors (CNOSSOS-EU §2.5.15)
```
CF = [-1.5, -0.7, 1.5, 2.5, 2.0, 1.3, 0.7, 0.2]
A_ground[i] = CF[i] × G    where G = 1 - IMD/100 (from imperviousness raster)
```

---

## 1. Road Emission (CNOSSOS-EU Annex II)

### Source height
h_s = 0.05 m

### Vehicle categories
| Category | Code | Description | Speed cap |
|----------|------|-------------|-----------|
| 1 | cat1 | Light vehicles (cars, vans) | — |
| 2 | cat2 | Medium heavy (delivery trucks) | — |
| 3 | cat3 | Heavy (HGV, buses) | 80 km/h |
| 4b | cat4b | Motorcycles | — |

Note: Category 4a (mopeds) and 5 (open category) not implemented. Known simplification.

Emission speed is clamped to **[20, 130] km/h** before the rolling/propulsion formulas (`road.rs`); cat3 additionally capped at 80 km/h per the table above.

OSM `maxspeed` is parsed unit-aware at extract (`osm-extract::classify::parse_maxspeed_kmh`: first `;`-token; `mph`/`knots`/`walk`; numeric clamp ≤ 400; `signals`/garbage → 0). The roads column stays u8: `maxspeed=none` (derestricted) stores sentinel **255** (`SPEED_LIMIT_DERESTRICTED`), real limits clamp to 254; `normalize_road` resolves the sentinel to **130 km/h** (`DERESTRICTED_SPEED_KMH` — BASt 2025 measured 124.1 km/h mean on derestricted Autobahn; CNOSSOS validity cap 130).

### Rolling noise per band (CNOSSOS-EU §2.4.6)
```
L_WR,i = A_R,i + B_R,i × log₁₀(v / v_ref)
```
where v_ref = 70 km/h. Coefficients A_R, B_R from CNOSSOS-EU Annex II Table 2.3.a (2021/1226 consolidation).

### Propulsion noise per band
```
L_WP,i = A_P,i + B_P,i × (v - v_ref) / v_ref
```
Coefficients A_P, B_P from CNOSSOS-EU Table 2.3.b.

### Surface correction (CNOSSOS-EU §2.4.8)
```
L_WR,i += ΔL_WR    (same scalar applied to rolling noise only in all bands)
```
| Surface | ΔL_WR |
|---------|-------|
| asphalt (default) | 0 dB |
| sett/cobblestone | +4 dB |
| concrete | +1 dB |
| gravel/unpaved | +2 dB |

### Combined emission per band
```
L_W,i = 10 × log₁₀(10^(L_WR,i/10) + 10^(L_WP,i/10))
```

### Line source power density per meter
```
L_W'/m,i = L_W,i + 10 × log₁₀(Q / (1000 × v))
```
where Q = vehicles/hour, v = speed in km/h. The `1/(1000·v)` term converts flow to vehicle density per meter.

**Simplification**: ISO 9613-2 is point-source only — it requires subdividing line sources into representative point sources. We use a line-source approximation with finite-line correction (FLC), which is standard practice in noise mapping software (NoiseModelling, LIMA, SoundPLAN) though not literally ISO 9613-2.

### Total emission (all categories)
```
L_W_total,i = 10 × log₁₀(Σ_cat 10^(L_W'/m,cat,i / 10))
```

### Day/evening/night split

Fixed per-class: 65/20/15 % for motorway-class roads, 70/18/12 % otherwise. Applied even on measured AADT — sub-daily census not currently sourced.

`access_factor` reductions are bypassed only when `Provenance::is_measured()` (NationalMeasured / ContinentalMeasured / GlobalMeasured); Heuristic / Baseline rows still get access reductions.

A row counts as enriched only when `provenance.has_data() && aadt_light > 0` (`normalize.rs::has_enriched_traffic`) — an enriched row with zero light but nonzero heavy AADT falls back to full class defaults (known edge case). Un-enriched rows with ≥ 3 lanes get a `lane_ratio` default multiplier (ŘSD-calibrated bucket medians, `normalize.rs::lane_ratio`): motorway oneway 3 lanes ×1.42; primary 3/4 lanes ×1.37/×2.13; secondary 3 lanes ×1.83; all other buckets ×1.0. Measured rows bypass it.

---

## 2. Railway Emission (CNOSSOS-EU Annex IV / RMR)

### Source height
h_s = 0.5 m (wheel-rail contact)

### Emission per band
```
L_vehicle,i = 10 × log₁₀(10^((A_rolling,i + 30 × log₁₀(v / v_ref))/10) + 10^(A_traction,i / 10))
L_W'/m,i   = L_vehicle,i + 10 × log₁₀(Q / (T_h × 1000 × v))
```
where:
- A_rolling / A_traction: entire-train A-weighted reference spectrum per vehicle type, peaked at 500–1000 Hz (ISO 3095 / CNOSSOS rail spectrum)
- v in km/h, clamped to `[20, v_max]`
- v_ref per vehicle type (see Rail vehicle types below)
- Q = trains **in the period** after the 65 / 20 / 15 day-evening-night split of the daily count
- T_h = period hours: 12 day / 4 evening / 8 night
- B_rolling = 30 (speed-dependent rolling noise exponent)

This is the CNOSSOS Annex IV line-source density (NoiseModelling-compatible).

**Known issue / history**: a prior revision used `L_W = L_vehicle + 10·log₁₀(Q_per_day)` with SRM-II-style coefficients peaked at 4 kHz. Because 4 kHz carries ~22 dB/km atmospheric absorption, rail signal collapsed at range. Current coefficients are calibrated so a typical mainline corridor matches EU END reference levels in the 0–5 km range. See the header comment in `src/emission/railway.rs`.

### Rail vehicle types
| `rail_type` | Enum | v_ref (km/h) | v_max (km/h) | Coefficient table |
|-------------|------|--------------|--------------|-------------------|
| 0 | Rail (mixed pax + freight) | 100 (pax) / 80 (frt) | 300 / 120 | PASSENGER + FREIGHT |
| 1 | Tram | 50 | 70 | TRAM |
| 2 | LightRail | 80 | 120 | LIGHT_RAIL |
| 3 | NarrowGauge | 80 | 120 | LIGHT_RAIL (reused) |
| 4 | Funicular | 100 | 300 | PASSENGER (fallback) |

High-speed passenger (`v > 200 km/h`) is served by the passenger rolling spectrum scaled via `30·log₁₀(v/v_ref)` — not a dedicated aerodynamic model.

### Day/evening/night split

Fixed 65/20/15 % applied identically to passenger and freight — no asymmetric split for night-biased freight where it would be realistic.

Post-adjustments applied even on measured counts: `service > 0` → counts × **0.02**; `parallel_divisor > 1` → counts divided by that factor.

### Defaults when un-enriched (`railway.rs::default_traffic` / `default_speed`)

| `rail_type` / usage | trains/day (pax + freight) | default speed |
|---|---|---|
| Rail, main line | 80 + 20 | 80 km/h |
| Rail, branch | 30 + 5 | 80 km/h |
| Rail, industrial siding | 0 + 15 | 80 km/h |
| Rail, unknown usage | 40 + 10 | 80 km/h |
| Tram | 120 + 0 | 40 km/h |
| LightRail | 80 + 0 | 60 km/h |
| NarrowGauge | 10 + 0 | 40 km/h |
| Funicular | 40 + 0 | 20 km/h |

`maxspeed` tag wins when present (unit-aware parse at extract — mph postings like WCML "125 mph" now convert instead of dropping to 0); missing `maxspeed` with `highspeed=yes` → 300 km/h (`normalize.rs::normalize_rail`). The railways `maxspeed` column is **UInt16** since 2026-06 (300+ km/h overflowed u8); readers (`hex_store::col_u16_or_u8`, `source_loader_rail`) also accept legacy UInt8 arrows until the next world OSM re-extract.

---

## 3. Propagation (ISO 9613-2)

### 3.1 Geometric divergence

**Line source**:
```
A_div,i = 10 × log₁₀(2π × d_slant)
```

**Point source**:
```
A_div,i = 20 × log₁₀(d_slant) + 11
```

where d_slant = √(d_horizontal² + Δh²), Δh = (h_source + z_source) - (h_receiver + z_receiver)

### 3.2 Atmospheric absorption
```
A_atm,i = α_atm,i × d_slant / 1000    [dB]
```

### 3.3 Ground effect (CNOSSOS-EU §2.5.15)
```
A_ground,i = CF[i] × G
```
where G = `1 - IMD/100`, from the imperviousness raster. G=0 hard, G=1 soft.

Water is hard (ISO 9613-2 §7.3.1 groups water with paving/concrete): the
WorldCover→IMD LUT maps water to 100; snow/ice stays 0 (porous snow cover →
soft). A missing IMD tile defaults to 100 — the converted set has a tile for
every land tile, so an absent tile is open ocean. Partial-tree caveat: ry177
carries only 34–59°N (+synced Scandinavia), where missing northern LAND reads
hard too; he84's complete raster tree is the production truth.

Current implementation:
- **Line sources** (roads, railways, aircraft-ground): both popup and pipeline
  use **path-averaged** `G_path` from closest-point to receiver — identical
  evaluation at an R11 hex center.
- **Point sources** (buildings, industrial): both popup and pipeline use
  **receiver-local** `G` at the receiver coordinate — also identical.

Barrier interaction:
```
A_ground_or_barrier,i = max(A_ground,i, A_terrain,i + A_screen,i)   if barrier exists
                      = A_ground,i                                   otherwise
```
Ground and barrier attenuation are **not** added together.

### 3.4 Finite-line correction (line sources only)
Uses **HORIZONTAL** distance and angle subtended:
```
d1, d2 = along-segment horizontal offsets from the foot of the receiver's
         perpendicular to the two segment endpoints
d_perp = perpendicular horizontal distance from receiver to segment line

θ = atan(d1/d_perp) + atan(d2/d_perp)    [radians]
FLC = 10 × log₁₀(θ / π)                  [dB, always ≤ 0]
```
Note: Uses HORIZONTAL distances, not 3D slant. This is a fix from V33/V44 which incorrectly used 3D.

### 3.5 Terrain diffraction (ISO 9613-2 §7.3 + CNOSSOS-EU §2.5.6(c), single-edge)
```
δ = path_via_edge - direct_path    [m]

Single edge (§7.3):
A_bar,i = min(20, 10 × log₁₀(3 + 20 × δ × f[i] / 340))

Rayleigh gate (CNOSSOS-EU §2.5.6(c)):
if δ ≤ λ/4 − δ*  then  A_bar,i = 0
```

**Edge selection (N = 1, single-edge model):** among profile samples above the
source→receiver line-of-sight, the edge with the **largest path-length
difference δ** wins (`propagation/horizon.rs::max_delta_idx`). Max-δ ranking
deliberately replaced LOS-excess ranking, which systematically under-weighted
barriers close to either endpoint. The multi-edge upper-convex-hull cascade
(double/triple Fresnel, C₃ thick-barrier term, 25 dB cap) was **removed
2026-06-01** in the single-edge δ rewrite (commits `efba2c1b`…`f2b526ce`); the
double-edge band math survives in `diffraction.rs::maekawa_bands` but is
unreachable. The GPU kernel (`noise-gpu/kernels/scatter.cu`) mirrors the same
single-edge selection. The attenuation cap is therefore **20 dB in all cases**.

δ* is the path-length difference computed using the same dominant edge D but with mirror source S\* and mirror receiver R\* reflected **vertically** across their respective mean ground planes. Each mean ground plane is an unweighted least-squares line fit over the DEM profile samples on that side (including D itself). D is the single max-δ edge selected above.

**δ\* fits on bare-earth elevation only.** When the combined-screening entrypoint (`combined` terrain+building+barrier top profile) invokes diffraction, δ* continues to fit on `elevation_m` so the mean-ground planes represent the *ground reflection* surface that CNOSSOS §2.5.6(c) physically defines. Feeding building heights to the OLS fit would drag the mean-ground plane up to rooftops and silently break ground-reflection physics.

Simplifications vs. strict CNOSSOS:
- **Single edge only (N = 1)** — multiple diffraction (ISO §7.4 / CNOSSOS §2.5.23) removed 2026-06-01, see above.
- We use **vertical** reflection across the fitted plane (standard acoustic practice in NMPB / NoiseModelling), not perpendicular-to-plane.
- The **−λ/20** near-miss clause is not implemented — the path-difference scan early-returns zero when no sampled elevation sits above the line-of-sight, collapsing all non-blocked paths to zero before diffraction is considered.
- `Δground` additive combination (CNOSSOS §2.5.31) is not implemented — we still combine ground and barrier via `max(A_ground, A_terrain + A_screen)` in §3.3.
- Favourable-conditions curved rays (§2.5.24) are not implemented — see §3.9.
- Lateral diffraction around vertical edges (§2.5.6(i)) is not implemented.

See §3.5a for the shared path-sampling scheme.

### 3.5a Unified path sampler

DEM, Overture building height, WorldCover forest cover and IMD imperviousness are all sampled along the source→receiver line by a single bilateral cadence — density highest near endpoints (Fresnel zone narrowest), coarsest in the middle. Implementation + cadence rationale: `propagation::path_profile::fill_t_values`. Terrain diffraction, building screening, vegetation depth, and ground-effect G all read from the resulting `PathProfile`.

### 3.5b Combined terrain + building + barrier screening

Diffraction is computed once over a composite top profile (`elevation + max(building_h, barrier_h)`), avoiding the terrain+screening double-count that would otherwise occur when a building sits on a hill. The δ* OLS mean-ground fit stays on bare-earth elevation. Implementation + caller API split (`terrain_attenuation` vs `screening_attenuation`): `propagation::path_effects::screening_attenuation_with_meta`. Ground G and vegetation depth are path integrals weighted by interval length so non-uniform bilateral spacing doesn't bias endpoints.

### 3.6 Building screening (ISO 9613-2, per-band)
Samples Overture Maps 30m building raster at the same bilateral cadence (§3.5a). Explicit `noise_barrier` geometries compete with raster buildings. For industrial sources, screening samples inside the source's own footprint are skipped via an exclusion radius.

**Barrier consumers (B8/C9, 2026-06-11).** Popup and ALL CPU surface heatmap kernels (road/rail `scatter_line`, industrial/building `scatter_point`, aircraft `ground_ops`) feed `barriers.arrow` vector barriers into the §3.5b composite via the shared `screening_attenuation`; the heatmap prepares one slice per z13 tile (`heatmap-aircraft::source_loader_barrier::BarrierData::for_tile` — sorted ascending by a conservative lower-bound distance; contract documented on `types::Barrier`). The **GPU line kernels (`noise-gpu`, road/rail on GPU cluster boxes) screen the SAME vector barriers behind the `QM_GPU_BARRIERS` gate** (default OFF): the per-tile `for_tile` slice is uploaded and the kernel applies the identical projection-and-snap (`scatter.cu` `line_source`; measured on RTX 5070 mean 0.002 / max 1.5 dB vs the CPU truth). Burning barriers into the 30 m cover raster was the rejected alternative — it was measured acoustically unsound, the §3.5a bilateral cadence (≥ ~30 m sample spacing) stepping over a one-cell-thin burned wall on most paths (mean +3.7 / max +13.8 dB under-screening at wall-adjacent shadow pixels vs the vector path; decision record: `heatmap-aircraft/tests/barrier_screening.rs`). With the gate OFF the GPU lane uploads no barriers and the C9 orchestrator gate (build-heatmap.sh / cluster-build-chunk.sh) routes barrier-carrying R4s (~1.5% of hexes) to the CPU builders, as before; flipping `QM_GPU_BARRIERS=1` keeps them on the GPU (default-on awaits per-box barrier-fixture validation).

**Screening is not computed standalone.** Buildings and barriers are merged into the §3.5b composite top profile (`elevation + max(building_h, barrier_h)`) and diffraction is computed once by the §3.5 single-edge algorithm (max-δ edge, Rayleigh gate). The per-band screening cap inherits from §3.5 — 20 dB — not a dedicated building-only cap.

The popup-facing `screening_attenuation` value returned by the engine is the increment of the combined result over bare-earth terrain diffraction, i.e. `atten_combined − atten_terrain` (clamped ≥ 0). With that definition `A_terrain + A_screen ≡ A_combined`, which is what §3.3 feeds into the ground/barrier combination. See §3.5b for the motivating double-count problem the merge fixes.

### 3.7 Vegetation (ISO 9613-2:2024 A.2.2, Central Europe × 0.5 calibration)
```
A_veg,i = min(MAX_VEG_ATTEN[i], α_veg[i] × depth_m)
```
where depth_m = cumulative forest depth along source-receiver path, integrated trapezoidally over intervals where the WorldCover raster is forested (see §3.5a). Contiguous runs shorter than 10 m are discarded to avoid scattered-tree false positives.

Constants (`ALPHA_VEG`, `MAX_VEG_ATTEN`) are ISO 9613-2:2024 Table A.1 values × 0.5 — see
the constants block at the top of this SPEC. Rationale: binary WorldCover forest raster
treats any canopy ≥ 10 % as dense foliage; scalar compensates for over-application.

### 3.8 Urban reflection (ISO 9613-2 §7.5)
Per-RECEIVER boost based on building enclosure (`raster-reader::building_enclosure`):
3×3 probe at 75 m metric spacing around the receiver; buildings taller than 5 m count.
```
density > 0.5 → A_refl = +3.0 dB;  density > 0.2 → +1.5 dB;  else 0 dB
```
Applied ONCE per receiver, not per source-receiver path. Maximum is 3 dB — the
`clamp(enclosure_db, 0, 5)` helper (`reflection.rs`) is dead code.

### 3.9 Favourable meteorological conditions (CNOSSOS-EU §2.5.21)
❌ NOT IMPLEMENTED.

`P_FAV = 0.5` constant exists in code, but no wind / inversion / favourable-propagation correction is applied in current propagation.

### 3.10 Transport-specific adjustments
Applied in pipeline and popup:
- **Bridge**: G=0 (hard surface, overrides IMD raster)
- **Tunnel**: segment skipped entirely (sound contained inside)
- **Access codes 2 (no) / 4 (legacy motor_vehicle=no)**: segment dropped entirely, like tunnels
- **Oneway road**: AADT × 0.5 (approximation: half the traffic of two-way)
- **Junction**: speed capped at 30 km/h (junction code 1 = roundabout; mini-roundabouts (code 2) currently NOT capped — known gap)
- **Service railway** (yard/siding/spur): counts × 0.02
- **Parallel railway ways**: counts divided by `parallel_divisor`
- **Industrial exclusion radius**: R=√(area/π) — buildings within R of source point are not counted as screening (prevents self-screening from source's own footprint)

Road `access` and `road_class` u8 enums (codes, OSM mappings, AADT-reduction factors): see `engine/osm-extract/src/classify.rs` and the consumer in `engine/noise-compute/src/normalize.rs::access_factor`. The reduction is bypassed only when `Provenance::is_measured()` is true (NationalMeasured / ContinentalMeasured / GlobalMeasured); `Heuristic`, `Baseline` and `None` rows still get access reductions.

Link rationale (codes 10-12, `*_link` slip roads / ramps carry 15% of mainline AADT — HCM 7 / FEHRL / CERTU lower-range, validated against Pasito Blanco GC-1 popup): see `defaults.rs` ramp rows. `secondary_link` / `tertiary_link` stay on mainline codes (3/4) because their flow is closer to regular urban streets. For `highway=track` without a `surface` tag, the extractor defaults to `unpaved` (+2 dB rolling correction — §1 surface table).

### 3.11 Total received level per band
```
L_received,i = L_emission,i - A_div,i - A_atm,i - A_ground_or_barrier,i - A_veg,i + A_refl + FLC

where A_ground_or_barrier,i = max(A_ground,i, A_terrain,i + A_screen,i) if barrier exists
```

### 3.12 A-weighted total
```
L_A = 10 × log₁₀(Σ_i 10^((L_received,i + A[i]) / 10))
```

### 3.13 Audibility cutoffs (output-affecting)

Per-source maximum propagation radii (`constants.rs`) — beyond these a source
is not evaluated at all:

| Source | Max radius |
|---|---|
| Road (by class) | motorway 10 km · trunk 7 km · primary 5 km · secondary 3 km · unclassified 2 km · tertiary 1.6 km · motorway_link 1.2 km · trunk_link 900 m · residential 800 m · primary_link 600 m · service 500 m · living_street 400 m · track 300 m |
| Railway (all types) | 7 km |
| Industrial | 4 km |
| Building | fade radius from Lw, capped 2 km |
| Aircraft ground ops | runway 5 km · taxi 3 km · apron 1.5 km |
| Aircraft airborne/cruise | 16 km horizontal envelope + per-class slant reach (§5.1) |

Additionally a **free-field early-exit**
(`geo.rs::below_free_field_threshold[_line]`): when emission minus a
conservative divergence + atmospheric bound is already below the caller's
threshold, the full path computation is skipped (provably no audible loss —
path effects only attenuate further). Both gates trade the strict "compute at
all distances" principle for speed; radii are sized so the dropped
contribution sits well below audibility for that class's maximum plausible
emission.

---

## 4. Lden (END 2002/49/EC)

```
Lden = 10 × log₁₀((12 × 10^(Ld/10) + 4 × 10^((Le+5)/10) + 8 × 10^((Ln+10)/10)) / 24)
```

Penalty: +5 dB evening, +10 dB night.

---

## 5. Aircraft

Aircraft splits into THREE public layers (separate tile trees + popup sub-tabs):
- **Airborne overflights** (`aircraft-airborne`): Doc 29-inspired empirical NPD model, terminal-area traffic
- **Airport ground ops** (`aircraft-ground`): runway / taxi / apron line sources propagated through Section 3 ISO 9613-2 path effects
- **Cruise** (`aircraft-cruise`): FL100+ overflight, Doc 29 NPD over per-R7 hex buckets

### 5.1 Airborne aircraft (Doc 29 4th Edition)

SEPARATE from ISO 9613-2. Airborne Doc 29 is empirical NPD-based, not path-tracing.

### Master equation (Eq. 4-8b)
```
SEL_seg = L_E(d_p) + ΔV + ΔI(φ) - Λ(β, l) + ΔF
```

- **L_E**: NPD lookup at slant distance d_p (feet). 124 per-typecode profiles auto-generated from EASA ANP v2.3, bucketed at 14 aircraft noise classes (9 Wing + 2 Fuselage + 2 Prop + 1 Helicopter — `NUM_CLASSES` in `profiles_generated.rs`). The kernel evaluates the **class anchor curve**, not the per-typecode curve (mean within-class spread ~0.8 dB); unknown typecodes route through a similarity table before falling back to `FALLBACK_PROFILE_IDX` (B738-equivalent). See `scripts/build-aircraft-profiles.py`.
- **ΔV**: Speed/duration correction (Eq. 4-14)
- **ΔI**: Engine installation angle correction (Eq. 4-15)
- **Λ**: Lateral attenuation (Eq. 4-18/19) — Wing-mounted jets only per Doc 29 §4.5.4 / FAA AEDT TM §6.2.4. Fuselage-mounted, propeller, and helicopter installations get Λ = 0 (gated by `installation` parameter in `fast_lateral_attenuation` / `lateral_attenuation`).
- **ΔF**: Finite segment dipole correction (Eq. 4-20, full α/(1+α²) terms)

### Geometry (§4.4.1)
CPA (Closest Point of Approach) computed on segment EXTENSION (unclamped).
d_p = slant distance at CPA. β = elevation angle.

Energy uses the unclamped CPA everywhere (ΔF needs it). **Display** outputs
(popup Lmax, distance, altitude) use `clamped_display_cpa` — CPA clamped to
the observed endpoints — so curving departures don't show phantom near-passes
(2026-05-27 popup-honesty sweep). Lmax NPD lookup uses the clamped distance.

### Input and preprocessing

Non-obvious thresholds, periods, and routing rules (constants live in
`aircraft-extract`):

- **Typecode → NPD profile**: unknown typecode falls back to
  `FALLBACK_PROFILE_IDX` (B738/737800-equivalent).
- **`is_departure`**: per-sample-pair, ±5-sample smoothed ROCD median
  thresholded against Doc 29 §A.3.2 — climb > 500 fpm = Departure, and
  shallow cruise descents (`avg_alt > 10 000 ft && rocd > -500 fpm`)
  also use Departure NPD because en-route thrust ≈ T/O thrust.
- **Period**: segment-midpoint → IANA timezone (tzf-rs + chrono-tz,
  DST-aware) → END 2002/49/EC boundaries (day 07-19, eve 19-23,
  night 23-07).
- **Airport-ground candidacy** (Stage 1 `ground_inference.rs`, layered):
  the raw transponder ground bit is trusted only when AGL ≤ 80 ft (≈ 24.4 m)
  AND speed ≤ 140 kt AND |baro rate| ≤ 2000 fpm; without the bit, a surface
  signature (AGL ≤ 30 ft ≈ 9.1 m, speed ≤ 90 kt, |baro rate| ≤ 1200 fpm) can
  mark ground; strong-airborne neighbours (AGL ≥ 165 ft OR speed ≥ 130 kt)
  veto edge points within a 32-point window. (The old "60 m AGL both
  endpoints" predicate survives in `segment_filters.rs` as dead code.)
- **Stale-ground filter**: `on_ground` or `≤ 15 m AGL` with no airport
  context → dropped.
- **Derived-speed plausibility**: implied `length_m / dt_s >
  MAX_PLAUSIBLE_SPEED_KT` (1500 kt) dropped as mode-S decode errors.
  A 200 km/30 min oceanic gap survives; 200 km/30 s does not.
- **Phase-aware gap budget**: Cruise 3600 s (oceanic dropouts OK),
  Airborne 120 s (terminal area should be dense), Ground 60 s.
- **Phase priority at transitions**: Airborne wins over Ground and
  Cruise so takeoff / flare stays audible and Cruise→Airborne descents
  get the approach NPD, not forced-Departure cruise routing.
- **Flight split**: `split_flights` splits the trace at on-ground rests
  ≥ `MIN_TURNAROUND_S` (5 min); airborne dropouts of any duration
  preserve `flight_id`.

### Data-quality gating (post-K3 split)

Since the v16/K3 refactor the gates are split by stage; the historical
`is_valid_airborne_segment` bundle is **no longer applied to airborne
segments** in either popup or heatmap (the function survives in
`segment_filters.rs` and still serves cruise checks).

Enforced at Stage 1 (extract) for airborne pairs:
- **endpoint AGL**: `start_agl < -30 m` or `end_agl < -30 m` rejected
  (DEM-relative, so subsea-level airports like Schiphol/Atyrau pass)
- **impossible jet speed**: `speed_kt < 80` for jet classes
  (`IS_JET[noise_class]`; Turboprop / LightGA / Rotorcraft exempt)

Enforced only for cruise synthetic segments (`cruise.rs`):
- **midpoint underground**: `max(start_alt, end_alt) < midpoint_terrain - 30 m`
- **line goes under terrain**: 25%/75% interpolated samples ≤ terrain - 30 m
- **jet too low**: `max_alt < midpoint_terrain + 150 m`

⚠ **Known gap (under review)**: the chord (25/75) and jet-too-low checks were
dropped for airborne segments during K3 with the intent to re-add them in
Stage 2A (`stage_1.rs` comment); Stage 2A never received them, and six stale
comments cite a non-existent `airborne_chord_clears_peaks`. Filter D (below)
covers part of the exposure.

### Filter D — per-receiver sub-terrain extrapolation rejection

`compute_cpa` uses the infinite-line (unclamped) CPA for all outputs (Doc 29
§4.4.1). Filter D then rejects (segment × receiver) pairs whose CPA foot falls
outside the observed endpoints AND whose extrapolated altitude lies > 30 m below
terrain. Airport-ground segments bypass the filter. Full rationale (geometry,
30 m margin, replaced-blanket-filter history) lives in the rustdoc on
`segment_energy_kernel` (`emission/aircraft/doc29.rs`).

### Shared kernel approximations

`compute_aircraft_v6` runs the same Doc 29 kernel
(`segment_energy_kernel` in `aircraft/doc29.rs`) on every airborne sub-
segment and every cruise synthetic segment; see its rustdoc for the
four approximations (NPD via 128-bin LUT, ΔF via `fast_delta_f`, Λ via
`fast_lateral_attenuation`, ΔI via inline `u²/v²`) and the < 0.15 dB
per-segment combined error. ΔF applies at every slant range — the
CFFK far-field fast path (slant > 7.62 km) keeps Λ and ΔI skipped but
retains ΔF so that N collinear per-sample sub-segments correctly sum
to one event (regression: `cffk_partition_preserves_linear_energy` in
`doc29.rs`).

Output-affecting kernel gates: segments whose SEL lands **< 20 dB** return no
energy (`doc29.rs`, both CFFK and full paths); per-class × direction slant
**reach envelopes** at the 40 dB NPD threshold (`REACH_SQ_TABLE`, `npd.rs`)
reject far geometry before evaluation; NPD lookup distance floors at 100 ft.
The heatmap additionally routes far receivers through a coarse lattice
(`NEAR_SLANT_M = 500 m` exact zone, coarse bands at 2 km / 8 km) — heatmap-only
approximation; the popup is always exact.

### Cross-flight aggregation

Stage 2A/2B/2C produce three per-R4 popup arrows: `airborne.arrow`
(per-flight sub-segments with bbox envelope + per-pair period/date_id/
flags), `cruise.arrow` (per-R7/FL-bin/class/period bucket; v14 carries a
bounded `top_candidates` list + scalar `unique_count` instead of the old
full `cruise_flight_ids` — tail flight ids undercount band counters;
annual-only — no `date_id`), and
`airport_traffic.arrow` (sparse per-microsegment counters — see §5.2).
Schemas in `aircraft-extract/src/arrow_schemas.rs`. Consumers:
`compute_aircraft_v6` (popup), `heatmap-aircraft`, and `noise-gpu` read the
same arrows.

### Cross-hex visibility

Popup loads target R4 + 6 ring-1 neighbours so R4-straddling rows stay
visible. Per-row prune radius: `AIRCRAFT_MAX_HORIZONTAL_REACH_M = 16 km`
(in `aircraft/npd.rs`); airborne uses baked per-row bbox, cruise uses
R7-cell-centre + half-diagonal. Antimeridian-crossing rows skip the
bbox prune (degenerate global envelopes).

### Per-period energy
```
E_period = Σ_segments_in_period 10^(SEL_seg / 10)
```

### Per-period Leq (§5, Eq. 5-1)
```
Leq_period = 10 × log₁₀(E_period / (n_days × T_period))
T_day = 43200s, T_evening = 14400s, T_night = 28800s
```

### Octave bands
**Airborne / cruise**: ❌ BROADBAND ONLY. Doc 29 NPD returns a single SEL
value; per-band data is not fabricated for the airborne kernel. Path
effects (Section 3) skip the per-band chain — the airborne kernel uses
only NPD lookup + Δv/ΔI/Λ/ΔF and lateral attenuation, never terrain /
screening / vegetation per band.

**Ground ops**: 8-band emission via per-class spectrum templates
(`GROUND_OPS_RUNWAY_SPECTRUM_SHAPE` / `GROUND_OPS_TAXI_SPECTRUM_SHAPE` /
`GROUND_OPS_APRON_SPECTRUM_SHAPE` in `aircraft/ground_ops.rs`). Popup
runs `propagate_variants_full` per leg with full Section 3 path effects
on every band — see §5.2.

### Per-event peak Lmax (informational only)

```
Lmax_event = lookup_lmax(class_idx, is_departure, log10(d_display_ft))
```
where `d_display` is the clamped display CPA distance (see Geometry above).

Per-class LAmax NPD LUTs ingested from the ANP CSVs alongside the SEL
NPDs (`build_lmax_lut` in `emission/aircraft/npd.rs`). 200–25 000 ft
log-linear interpolation; below 200 ft extends the first-two-point slope;
above 25 000 ft extrapolates as `−20·log10(d/d_ref)` + per-profile
`alpha_eff` (same fit as SEL — LAmax and SEL share source spectrum).
Popup `peak_lmax` per flight = max across segments.

**Dropped vs full Doc 29 Eq. 4-12**: ΔI and Λ are NOT applied to
`Lmax_event` — only the NPD curve. Doc 29 applies them per segment; the
residual at low elevation angles for wing-mounted jets is < 2 dB,
acceptable for informational peak ranking and avoids a second kernel
pass.

**Sources**: ECAC Doc 29 4th Ed §A.3.1 (LAmax NPDs), FAA AEDT Tech
Manual §6.4 (LAmax interpolation), EASA ANP v2.3 + v9 supplement
L_MAX_A / L_MAX_D tables.

### 5.2 Airport ground ops (per-microsegment model, `airport_traffic.arrow`)

Separate submodel inside the aircraft layer. Inputs: Stage-1
`Phase::Ground` segments + OSM aeroway microsegments
(`airport_lines.arrow`, ≤ 250 m pieces) + aerodrome polygons
(`airport_areas.arrow`) + Stage-1.5 DBSCAN synthetic strips for
OSM-missing airfields.

**Row semantics** (`airport_traffic.arrow` v7, keyed by `airport_key,
osm_id, segment_idx, ops_kind, is_departure, veh_kind, class_idx,
period`):

- `band_energy_lin[8]`: linear Z-weighted source energy, raw Σ over
  n_days. Storage units branch on `veh_kind`:
  - aircraft (`veh_kind = 0`): density-weighted per-metre `LW'`
    (= LW'_lin × `overlap / line.length_m`). Refinement-invariant by
    Chasles theorem at receiver.
  - GSE (`veh_kind = 1`): per-event SEL@25m from the kinematic
    moving-point integral over `length_within_segment_m`.
  Consumer divides by `n_days × period_seconds` via `period_leq`.
- Scalar `unique_*_count` columns: distinct `flight_id`s touching this
  row, segmented by ops_kind/is_dep/veh_kind/class_idx.
- Row-replicated `microseg_unique_*` columns: UNION across all rows
  sharing the same `(osm_id, segment_idx)`.

**Leg-to-microsegment projection**: buffer each microsegment by
`AIRPORT_LINE_SNAP_BUFFER_M = 50 m` perpendicular; the leg's overlap
inside that rectangle contributes. When a leg covers multiple segments
their overlap lengths are renormalised **downward** when Σ overlap exceeds
the leg length (prevents +3 dB inflation on adjacent parallel taxiways; legs
partially off the network keep Σ < leg length). Legs that
miss every microsegment are dropped (no fallback emission); coverage
for OSM-missing airfields comes from the Stage 1.5 DBSCAN synthetic
strips below.

**`ops_kind` from OSM** `aeroway_type` (`ops_kind_from_aeroway` in
`airport_traffic_writer.rs`): runway / stopway / airstrip →
`runway_roll`, taxiway → `taxi`. Aprons are area features (in
`airport_areas.arrow`), not lines, so the writer doesn't emit
`apron_movement` rows; any other aeroway value is corrupt input and
skipped. No speed classifier — OSM geometry is the source of truth.

**Emission kernel** (`emission/airport_traffic.rs`):
- Aircraft (`compute_aircraft_lw_per_meter_lin`): per-class anchor
  `GROUND_OPS_REFERENCE_LW_PER_METER_DB[class][ops_kind]` (= legacy
  1 km event-SEL anchor + `+9.01 dB = 10·log10(25/π)`; taxi = runway
  −12 dB, apron = −18 dB); dwell speed adjust `−10·log10(v/v_nom)`
  (Doc 29 Eq 4-14: per-metre energy ∝ 1/v, slower → louder), ±3 dB
  clamp vs nominals 70/18/12 kt, applied only when `speed_kt > 1`;
  runway departure
  +2 dB (Doc 29 §A.3); spectrum shape per `ops_kind`; source height
  4 m. Returns per-metre `LW'` density.
- GSE (`compute_gse_band_energy_lin`): closed-form kinematic
  moving-point integral over `segment_length_m` at perpendicular
  distance 25 m. One term replaces stationary-Lp + duration + FLC.

**Receiver math** (`compute/aircraft_v6/airport_traffic/mod.rs`):
- Aircraft rows: `received_band_lin[i] = row.band_energy_lin[i] × (θ /
  d_perp_extended)` per CNOSSOS-EU §2.5.5 line-source formula, with
  signed-fraction `θ` math so receivers past either endpoint get the
  correct (small) angle.
- GSE rows: `received_band_lin[i] = row.band_energy_lin[i] × (25 /
  d_endpoint)` (point-source divergence from the 25 m anchor).
  ⚠ Known issue: the kinematic model's own far field decays ~1/d²; the
  1/d scaling over-estimates GSE at range (~12 dB at 1.5 km for a 250 m
  segment). Bounded by GSE being ≪ 5 % of microsegment energy and the
  ground-ops reach caps.
- Both apply shared CNOSSOS-EU §2.5 path effects (atmospheric, ground,
  terrain, screening, vegetation, reflection). Variants are built inline
  per row from a per-microsegment path-effect cache. `d_perp` /
  `d_endpoint` are floored at half a z13 pixel for heatmap parity
  (popup would otherwise read ~5-8 dB hot directly on the line).
  Per-`ops_kind` reach caps: runway 5 km, taxi 3 km, apron 1.5 km
  (`ground_ops_max_radius`, shared popup + heatmap; see §3.13).

Airport-level `arrivals_per_day` / `departures_per_day` come from
HashSet UNION over `flight_ids` — one rotation crossing 30 microsegments
counts once per direction. The UNION runs at extract time (per-R4
`airport_summary_parts/` → global reduce → `airport_summary.arrow`
sidecar); only RUNWAY_ROLL touches count toward arr/dep. The popup reads
the sidecar and **refuses** (renders zeros / "—") when it is missing —
per-row re-summing is forbidden (would over-count ~N×).

**Stage 1.5 DBSCAN auto-discovery**: miss-snap ground vertices
clustered (eps = 200 m, min_samples = 5). Accepted clusters emit
synthetic strips into `synth_airport_lines.arrow` /
`synth_airport_areas.arrow` sidecars, unioned with real OSM lines in
the Stage 2C cache (consumed identically). Clusters near an existing
airport reattribute to the **real** airport key; standalone ones get
`airport_key = "auto-<R11-hex>"`; lines with no aerodrome within range
get `strip:<R7>`. Accept gates: line-shaped, ≤ 4 km, ≤ 20 k vertices;
GSE vertices excluded.

### 5.3 Aircraft contribution to confidence

Confidence rubric in `confidence.rs::assess`. Aircraft quirk:
`compute_at_point_inner` runs the rubric with `has_aircraft = false`
because the popup arrows aren't visible at that stage; the bump and
note removal are applied post-merge by
`source-reader::aircraft_v6::add_v6_aircraft_to_result`.

### 5.4 Per-receiver SegmentTrace breakdown (popup output)

`aircraft_subtype: u8` splits the popup into three sub-tabs:
1. **Ground** — one trace per (airport microsegment × `ops_kind`); geometry = microsegment polyline.
2. **Airborne sub-segment** — one per Stage 2A sub-segment.
3. **Cruise R7 hex** — one per crossed R7 cell (hex polygon).

`received_lden.full` is per-segment: per-period energy / `(n_days ×
T_period)` through the standard `variants_to_lden` mix. Energy-summing
the visible segments approaches source-aggregate Lden modulo per-sub-tab
top-K cap. Path-effect variants (`no_terrain`, `no_screening`, …) stay
zero — aircraft propagation does not expose them per-event — so the
popup gates path-effect detail rows for `aircraft_subtype` 2/3.

`apply_segment_top_k_with_cap` (`source-reader/src/lib.rs`) budgets
top-K separately per `aircraft_subtype` so a loud sub-tab (e.g. ground
ops) can't crowd quieter sub-tabs out.

Airborne sub-segments with event `Lmax < 25 dB` are skipped at trace level
(`AIRBORNE_TRACE_CUTOFF_DB` — display-only; period energy still accumulates,
and an `airborne_above_cutoff` counter feeds the truncation flag).

---

## 6. Industrial Emission

### Source geometry
Discretized at load/query time in `normalize.rs::prepare_industrial_points`
(shared by popup and heatmap — parity by construction):
- **Wind turbine** (`source_type = 10`): single point at centroid
- **Non-wind, area ≤ 5000 m²**: centroid
- **Non-wind, area > 5000 m² and polygon available**: **75 m square metric
  grid, area-weighted** (`wkb::wkb_area_grid_points`, 5×5-subsampled cells;
  cell areas renormalised so Σ = polygon area)
- fallback to centroid if polygon/grid generation fails
- Energy split per point: `Lw_point = Lw_total − 10×log₁₀(area_total /
  area_point)` — area-weighted; equals −10·log₁₀(N) only for equal cells
- Sources with resolved Lw < 10 dB are dropped; missing area defaults to
  10 000 m² (→ Lw = baseLw exactly)

Each discretized point also carries:
```
R_excl = √(area_per_point / π)
```
R_excl both suppresses self-screening (§3.6) and floors the propagation
distance (`geo.rs::effective_area_source_dist` — prevents the 1/r²
singularity for receivers inside the source polygon).

### Emission
```
Lw = baseLw + 10 × log₁₀(clamp(area_m², 100, 500000) / 10000)
```

**Normalization invariant** (audit 2026-06 B4+B6, `emission/spectrum.rs`):
emission bands are `Lw + spectrum_i − a_weighted_total(spectrum)`, so
`a_weighted_total(bands) == Lw` — Lw IS the radiated dB(A) total.
Pre-fix the relative spectra silently added +4.9..+6.4 dB(A) per profile
family (audit I-03); effective industrial emission dropped by exactly that
much. Test-locked at 1e-9 for every profile.

baseLw from a resolution chain — NACE 4-digit → NACE 2-digit → OSM
`site_subtype` (13 profiles) → `source_type`. Values were authored against
Czech SHM 2022 while the bands still carried the hidden spectrum surplus —
post-normalization they undershoot by that surplus; re-calibration is
backlog (C8a, area-density model I-04):
- Heavy industry (cement, steel, mining, quarry): 99-100 dB
- Power: thermal (NACE 3511) 97 dB, hydro 90 dB, solar (synthetic NACE 3599) 55 dB
- Medium industry (chemical, food, works): 88-95 dB
- Light industry (warehouse, commercial, farm): 55-86 dB (office/commercial 60)

Every profile carries `evening_offset` / `night_offset` (e.g. quarry −20 dB
night, wastewater 0 = 24/7, school −25 dB night); wind turbines are flat 24/7.

Area scaling clamped to [100 m², 50 ha] to prevent OSM polygon artifacts.

### Source height
- quarry (`source_type = 1`): 8m
- heavy industry (NACE 8/23/24/35): 10m
- other industrial: 5m
- wind turbine: `hub_height`

### Wind turbines (IEC 61400-11)
```
LwA = rating_lookup(rated_power_kw)
```
Published max LwA is a flat band, nearly independent of rating across
1.8–6.6 MW (audit I-10 — per-type sources cited in `wind.rs::turbine_lw`):

| rated power | LwA | anchors |
|---|---|---|
| < 1 MW | 98 | pre-audit value kept |
| 1–2 MW | 104 | V90-2.0 = 104.0, E-82 E2 = 104.0 |
| 2–3 MW | 105 | E-92 (2.35 MW) = 105.0 |
| 3–5 MW | 106 | V112-3.0 = 106.5, N149 = 106.1 |
| ≥ 5 MW | 106.5 | N163 = 106.4, E-160 = 106.0, V150-6.0 = 104.9 |
| unknown (0) | 105 | mid-band |

Spectrum: [-2, -1, 0, 1, 1, 0, -2, -5] dB relative, normalized so
`a_weighted_total(bands) == LwA` (pre-fix the shape added +6.4 dB(A)).

Fallbacks + tag-error clamps (audit I-10b):
- `hub_height` default = **105 m** (known-data median in our arrows;
  context: WindGuard DE 2024 avg 143 m, LBNL US 2023 avg 103.4 m);
  clamp ≤ 175 m (4,792 OSM hubs >170 m are tag errors)
- `rated_power_kw` default = **2000 kW**; values > 8000 kW treated as
  unknown (23 OSM powers ≥20 MW are tag errors)

### Propagation
ISO 9613-2 point source (point-source divergence; distance floored at
R_excl). Max radius 4 km (§3.13); popup queries sources within 5 km.

---

## 7. Settlement (buildings)

### Source geometry
Discretized at load/query time in `normalize.rs::prepare_building_points`
(shared by popup and heatmap):
- small / missing-polygon buildings: centroid
- buildings with `area > 2000 m²` and polygon available: interior grid at **30 m** spacing
- if grid generation yields only one point, fallback to centroid
- energy split is uniform: `Lw_point = Lw − 10×log₁₀(N)` (unlike industrial's
  area-weighted split)
- missing area defaults to 100 m²; missing height → floors × 3 m → 8 m;
  missing floors → ceil(height / 3); sources with Lw < 10 dB are dropped

Each source gets a fade-out radius from emitted Lw, capped at **2 km**
(popup query radius 2 km). The radius is solved against the
pre-normalization scalar (`Lw − a_weighted_total(spectrum)`) to keep the
pre-B4+B6 cull behavior exactly (W7 net-zero); the honest-Lw radius
(~×2.1 for small buildings, <1e-3 dB acoustic effect) is deferred to the
C8a recalibration.

### Emission (custom model, NOT standardized)
```
Lw = 10 × log₁₀(10^(Lw_fixed/10) + GFA × 10^(Lw_per_m²/10))
where GFA = area_m² × floors
```
Current implementation has **10 building classes + default fallback** (residential, commercial, warehouse, school, hospital, church, hotel, garage, farm, public). Type / geometry / area resolution chains live in `settlement.rs`.

Bands carry the same normalization invariant as industrial
(`a_weighted_total(bands) == Lw`). To keep the audit wave acoustically
net-zero for settlement (/gg verdict W7), every class's
`Lw_fixed`/`Lw_per_m²` was bumped by exactly its spectrum's A-weighted
offset (+5.6..+7.0 dB — old→new table in `settlement.rs::building_profile`),
so radiated dB(A) is unchanged; honest units now, real recalibration is
backlog C8a. Test-locked by the
`building_radiated_dba_unchanged_by_normalization` pin.

### Source height
height/2 (mid-facade). Consistent in emission AND propagation (fix V33 mismatch).

### Propagation
ISO 9613-2 point source.

---

## Reference Test Vectors

| Test | Input | Expected | Source |
|------|-------|----------|--------|
| K1 | Cat1, 50 km/h, asphalt, 10000 AADT, day | 79.11 dB(A)/m | CNOSSOS-EU |
| K2 | Cat3, 80 km/h, cobblestone (+4dB), 500 AADT, day | 80.07 dB(A)/m | CNOSSOS-EU |
| K4 | Propagation 100m, G=0, line source | 28.58 dB attenuation | ISO 9613-2 |
| K5 | Propagation 100m, G=1, line source | 31.66 dB attenuation | ISO 9613-2 |
| K6 | Single barrier 50m, δ=0.5m, G=0 | 15.28 dB barrier atten | ISO 9613-2 |
| K7 | retired 2026-06-01 — double-edge unreachable in the single-edge model; test retargeted to Maekawa-only (~17.9 dB) | — | ISO 9613-2 §7.4 |
| K8 | Lden: Ld=60, Le=55, Ln=50 | 60.00 dB | END 2002/49/EC |

---

## Research Archive

Provenance for the numbers sprinkled through the atlas that are **not**
direct standard quotes. Each row is either a cited external source or an
explicitly-pragmatic heuristic with a one-line rationale. Target audience
is the next reviewer who asks "where did this number come from?".

### Trip generation per dwelling

The service-tree enricher (`pipeline/enrich-roads-service-tree.ts`)
converts building occupants to road trips via
`TRIPS_PER_DWELLING = BASE × OCCUPANCY = 4.0 × 0.92 ≈ 3.68`.

| Region | Trips / dwelling / day | Source |
|---|---|---|
| US | 9.43 (single-family home, ITE 210) | ITE Trip Generation Manual 11th Ed, 2021 |
| UK | 5.8 (all vehicle trips / household) | NTS 2023 table NTS0205 (DfT) |
| Germany | 3.8 (Pkw-Fahrten / HH) | MiD 2017 (BMVI / infas) |
| France | 3.6 (déplacements en voiture / ménage) | EMP 2019 (SDES) |
| South Korea | 2.9 (car trips / household) | KTDB 2022 national travel survey |
| Japan | 2.5 (vehicle trips / household) | PT survey 2015 (MLIT) |

**Chosen base = 4.0.** Explicitly a world-mean skewed toward EU values
because (a) the engine's class defaults are EU-calibrated, (b) NA rates are
a known outlier, (c) East Asia underestimates are partly offset by higher
building density. Occupancy multiplier 0.92 folds in the ~8 % of dwellings
that are vacant at any time (OECD Affordable Housing indicator **HM1-1**
"Dwelling stock and vacancy rates", 2022 release).

Pragmatic — *not* re-derived per continent. Continent-level trip-rate
tuning is an out-of-scope follow-up (see plan v5 §"Out of scope").

### Dwelling inference from floor area (ITE codes)

`estimateDwellings` turns GFA = footprint × floors into an equivalent
dwelling count for each non-residential type, using ITE Trip Generation
Manual 11th Ed land-use codes and their published daily-trip rates.

| Class | ITE code | Name | GFA / dwelling | Cap |
|---|---|---|---|---|
| 1 commercial | 820 | Shopping Center | 92 m² | 400 |
| 2 industrial | 110 | General Light Industrial | 686 m² | 200 |
| 3 school | 520 | Elementary School (staff-only) | 800 m² | 100 |
| 4 hospital | 610 | Hospital | 11 m² | 300 |
| 5 church | 560 | Church (peak only) | fixed 2 | — |
| 6 hotel | 310 | Hotel × 0.5 occupancy × 0.6 car mode | 38 m² | 400 |
| 7 garage | — | fixed 1 | — | — |
| 8 farm | — | Outbuildings + occasional delivery | 200 m² | 50 |
| 9 civic | — | Government / cultural | 300 m² | 100 |
| _ residential | 210 | Single-Family Detached | 80 m² | 200 |

The per-class divisor is chosen so that `divisor × 3.68` (base trip rate)
reproduces ITE's published peak-hour or daily trips per 1000 ft² (converted
to m²). Caps are pragmatic — a 50 000 m² mall would otherwise synthesise
thousands of dwellings and saturate the service-tree cap per-class.

Non-obvious coefficients:
- **Hotel × 0.5 × 0.6**: half the rooms occupied at any time, of which
  60 % arrive by car (industry-average ratio, see Promotur 2018 "Tourist
  transport modal split, Canary Islands", used as the only publicly-
  calibrated number for a resort destination).
- **School staff-only**: school buses and parents dropping off don't
  contribute AADT on the school's access road — only the ~20 staff
  teachers do. ITE 520 gives daily trip rate per student, which is much
  higher than the steady load the access road sees.

### Cascade defaults (city → country → continent → world)

`engine/noise-compute/src/defaults.rs` implements a four-level cascade.
Each non-world row comes from an actual national enricher table (spatial
or ref-level data) converted to a class-default tuple; the world row is
an EU-generic fall-back.

| Level | Source table | Derivation |
|---|---|---|
| City São Paulo / Rio (class 0) = 100 000 | BR `CLASS_AADT` × `tierMultiplier(1)` × `splitVehicles(tier=1)` | `pipeline/enrich-roads-br.ts` (DNIT 2023 federal AADT estimates + IBGE metro tier) |
| City Bangkok (class 0) = 90 000 | TH `DOH_MOTORWAY_AADT` averaged over Bangkok refs × `thaiClassSplit(isBangkok=true)` | `pipeline/enrich-roads-th.ts` (DOH 2023 motorway traffic report) |
| Country BR rural (class 0) = 50 000 | BR `CLASS_AADT` × `tierMultiplier(0)` × `splitVehicles(tier=0)` | same source, rural (tier-0) arm |
| Country TH rural (class 0) = 60 000 | TH_RURAL class defaults × `thaiClassSplit(isBangkok=false)` | DOH 2023 rural motorway monitoring stations |
| Continent Africa (class 0) ≈ 31 700 | EU baseline × continent_scale(Africa) = 30 000 × 1.057 | `country_defaults_generated.rs::continent_scale()`. Pop-density-weighted blend of wiki + density indexes (see `scripts/gen-country-defaults-rs.mjs`). |
| World (class 0) = 30 000 | EU-generic motorway | Pragmatic: spans the 20 000-40 000 band of BAST-Zählstellen / TMC / MOBIS national censuses |

On top of the cascade, a **242-country scaling layer** (Wikipedia
vehicles-per-km fleet density relative to DE,
`country_defaults_generated.rs`) multiplies motorway / trunk / primary
(+ link) class defaults, clamped to **[0.7, 1.3]**. Lane-count default
multipliers: see §1 (`lane_ratio`).

All cascade arms in `defaults.rs` carry a `// Source:` comment pointing at
the TypeScript enricher they were derived from. When an enricher
re-calibrates, the defaults table must be regenerated to stay in sync
(no build-time check today — tracked as a future follow-up).

### Link AADT as fraction of mainline

| Reference | Link fraction of mainline AADT |
|---|---|
| HCM 7th Ed (TRB 2022) Exhibit 15-4 | 0.10 – 0.30 |
| FEHRL *TASK-CS* 2011 ramp study | 0.12 – 0.28 |
| CERTU *Les bretelles d'autoroute* 2008 | 0.15 – 0.25 |

**Chosen = 0.15** (A.6). Lower-range of the published band, based on
Pasito Blanco GC-1 popup validation (user perception). Previous 0.20 was
the published mid-range; feedback from popup testing indicated the
mid-range over-estimates a typical quiet regional link.

### Track access factor

`engine/noise-compute/src/normalize.rs::access_factor` collapses
`highway=track` segments with `access=0` (untagged) to the same
multiplier as explicit `access=agricultural` (×0.1 of the class-8
default = 0.5 veh/day). Rationale:

| OSM class-8 `access` distribution | Count | Share |
|---|---|---|
| access=0 (untagged) | 475 M | 94.7 % |
| access=yes (1) | 12 M | 2.4 % |
| access=agricultural (7) | 8 M | 1.6 % |
| access=forestry (8) | 5 M | 1.0 % |
| other | 1.5 M | 0.3 % |

Pragmatic — not an OSM-convention citation. The long tail of untagged
tracks in practice carries about the same as explicit agricultural; only
the minority that mappers actively tag as `yes` are public. Validated on
Kytín "alej loupežníka Babinského" (49.8467°N, 14.2182°E) → effective
~0.5/day post-fix (was 24/day with `access_factor=1.0`).

### Service-tree per-class cap

`SERVICE_TREE_CAP_PER_CLASS` in `pipeline/enrich-roads-service-tree.ts`
caps dwelling-driven Dijkstra flow to prevent pathological accumulations
where a minor road carries disproportionate stamped flow.

| Class | Cap (veh/day) | Rationale |
|---|---|---|
| 5 residential | 1 200 | 2.4× the world default (480 → 1 200). Dense Prague Karlín blocks can legitimately sit at this level. Matches observed urban residential at AADT stations in medium Czech cities. |
| 6 living_street | 250 | 2.5× the world default (98 → 250). Shared-surface street would saturate around ~300 vehicles/day before it stops feeling shared. |
| 7 service | 400 | 1.7× the world default (240 → 400). Apartment driveway / parking aisle hard cap; OSM `service=*` sub-tag would let us split apartment driveway vs aisle but extractor doesn't preserve it. |
| 9 unclassified | 2 000 | ~1.7× the world default (1 200 → 2 000). Rural connector between two villages with real through-traffic. |

All four caps are pragmatic — they set an upper bound so a service-tree
flow accumulation cannot exceed what a human observer on the road would
call plausible. Validated by the "no urban residential > 2 000 veh/day"
rule of thumb used by several city AADT-modelling agencies (e.g. TfL
LATA 2019 §3.2.1, which caps residential model outputs similarly).

### Natural Earth geopolitical policy

`scripts/build-h3-admin.ts` + `data/prepared/h3r4-admin.bin` use
Natural Earth 1:10 m `admin_0_countries` for country polygons, plus
hand-curated metro polygons in `scripts/h3-admin-metros.json`.

**Natural Earth encodes a specific view of disputed boundaries**:
- Crimea → Russia (not Ukraine)
- Kashmir → fragmented (India / Pakistan / China line-of-control)
- Taiwan → separate entity
- Western Sahara → fragmented
- Golan Heights → Israel

This is **project policy, accepted as a practical simplification** — the
hex-centroid PIP is a best-effort approximation for traffic-default
lookup, not a political statement. Users who need a different boundary
view can regenerate `h3r4-admin.bin` from a different polygon source
(e.g. GADM, official national cadastres) without touching arrow data.

### Full source URLs

| Tag | URL / reference |
|---|---|
| ITE Trip Gen 11 | https://www.ite.org/technical-resources/topics/trip-and-parking-generation/ |
| NHTS 2022 | https://nhts.ornl.gov/ |
| UK NTS 2023 | https://www.gov.uk/government/statistics/national-travel-survey-2023 |
| MiD 2017 | https://www.mobilitaet-in-deutschland.de/ |
| EMP 2019 (FR) | https://www.statistiques.developpement-durable.gouv.fr/enquete-mobilite-des-personnes-2018-2019 |
| KTDB 2022 | https://www.ktdb.go.kr/ |
| OECD HM1-1 | https://www.oecd.org/housing/data/affordable-housing-database/ |
| HCM 7 TRB 2022 | https://www.trb.org/Main/Blurbs/175169.aspx |
| Promotur tourism | https://turismodeislascanarias.com/en/analysis-tourism-canary-islands |
| Natural Earth 10 m | https://www.naturalearthdata.com/downloads/10m-cultural-vectors/ |
| DNIT (BR AADT) | https://servicos.dnit.gov.br/vmt/ |
| DOH (TH motorway) | https://www.doh.go.th/ |
| BAST Zählstellen (DE) | https://www.bast.de/ |
| TMC traffic data | https://tmcconsortium.org/ |

The table above is a pointer, not a reproduction — numbers above cite the
**year / table / section** within each source so future reviewers can
re-verify. If a link rots, the underlying paper is still traceable via
the tag.
