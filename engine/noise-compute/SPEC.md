# Noise Compute Engine — Specification

Engineering formulas inspired by CNOSSOS-EU 2021/1226, ISO 9613-2:2024, and ECAC Doc 29 4th Edition. This is NOT a certified implementation of any standard. Simplifications are documented in each section.

**Purpose**: Global noise atlas for public information ("where do I hear noise"). Not regulatory END mapping.

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

### Rolling noise per band (CNOSSOS-EU §2.4.6)
```
L_WR,i = A_R,i + B_R,i × log₁₀(v / v_ref)
```
where v_ref = 70 km/h. Coefficients A_R, B_R from CNOSSOS-EU Table 2.3.a.

**Known issue:** Current coefficients may not match the latest CNOSSOS-EU 2019 amendment (2019/1010). Cat1 A_R at 63 Hz is 83.1 in our code vs 79.7 in the amended standard. Updating requires revalidation of all reference test cases (K1, K2).

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

### Input priority (current implementation)
1. If Arrow contains `aadt_*` and `traffic_source > 0` **and** `aadt_light > 0`, use those flows (oneway × 0.5, private-access × 0.1 still applied).
   - `traffic_source = 1`: matched external traffic dataset
   - `traffic_source = 2`: service-tree estimate on local streets
   - `traffic_source > 2`: reserved for other heuristic estimates
2. Otherwise use `default_road_traffic(road_class)` combined with the lane-ratio boost (see below).

Speed priority:
- `maxspeed` from OSM if present
- otherwise `default_road_speed(road_class)` (see table)
- junction flag caps speed at 30 km/h (roundabouts)

Surface priority:
- recognized OSM `surface=*`
- otherwise asphalt (`ΔL_WR = 0`)

### Default traffic per `road_class` (used when `traffic_source = 0` or `aadt_light = 0`)
| `class_idx` | Name | Light | Medium | Heavy | Moto |
|-------------|------|-------|--------|-------|------|
| 0 | motorway | 21600 | 2400 | 5700 | 300 |
| 1 | trunk | 11700 | 1200 | 1800 | 300 |
| 2 | primary | 7470 | 540 | 810 | 180 |
| 3 | secondary | 2640 | 120 | 180 | 60 |
| 4 | tertiary | 720 | 26 | 38 | 16 |
| 5 | residential / living_street | 480 | 5 | 10 | 5 |
| 6 | unknown | 98 | 0 | 1 | 1 |

### Default speeds per `road_class`
motorway 100 / trunk 70 / primary 50 / secondary 50 / tertiary 50 / residential 30 / living_street 20 km/h.

### Lane-ratio boost (applied ONLY on defaults, not on Arrow AADT)
When Arrow traffic is missing and a default is used, per-lane count is boosted above 2 lanes:
- motorway 3-lane oneway × 1.42
- primary 3-lane two-way × 1.37; 4-lane × 2.13
- secondary 3-lane two-way × 1.83

2-lane segments, residential and living_street classes: no boost. This lane boost is NEVER applied on real Arrow AADT (it already reflects the observed lane layout).

### Period traffic
Day (07–19 / 12 h), Evening (19–23 / 4 h), Night (23–07 / 8 h).

Current implementation ALWAYS splits AADT by fixed class-based ratios:
- motorway / trunk: **65 / 20 / 15**
- primary / secondary / tertiary / residential / living_street: **70 / 18 / 12**

Note: even when daily AADT comes from real census/enrichment data, per-period road counts are not currently measured from source data.

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

### Input priority (current implementation)
Passenger / freight counts:
1. `trains_passenger`, `trains_freight` from Arrow if `> 0`
2. otherwise `default_traffic(rail_type, usage)` (see table below)

Speed:
1. OSM `maxspeed` if present
2. otherwise `300 km/h` when `highspeed=true`
3. otherwise `default_speed(rail_type)` (see table below)

Post-adjustments applied even on real counts:
- `service > 0` → counts × **0.02**
- `parallel_divisor > 1` → counts divided by that factor

### Default train counts and speeds (when Arrow `trains_* = 0`)
| `rail_type` | `usage` | pax/day | frt/day | Default speed |
|-------------|---------|---------|---------|---------------|
| Rail (0) | 0 (main) | 80 | 20 | 80 km/h |
| Rail (0) | 1 (branch) | 30 | 5 | 80 km/h |
| Rail (0) | 2 (siding) | 0 | 15 | 80 km/h |
| Rail (0) | other | 40 | 10 | 80 km/h |
| Tram (1) | any | 120 | 0 | 40 km/h |
| LightRail (2) | any | 80 | 0 | 60 km/h |
| NarrowGauge (3) | any | 10 | 0 | 40 km/h |
| Funicular (4) | any | 40 | 0 | 20 km/h |

### Period traffic
Day (07–19 / 12 h), Evening (19–23 / 4 h), Night (23–07 / 8 h).

Fixed **65 / 20 / 15** split is applied **identically** to daily passenger and freight counts — there is no separate asymmetric split for night-biased freight even where it would be realistic. (Note: the `lden_free_distances` offline benchmark in `pipeline-worker` uses a different asymmetric split for sensitivity analysis; that split is not production.)

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
d1 = horizontal distance from receiver to nearest endpoint of segment
d2 = horizontal distance from receiver to far endpoint
d_perp = perpendicular horizontal distance from receiver to segment line

θ = atan(d1/d_perp) + atan(d2/d_perp)    [radians]
FLC = 10 × log₁₀(θ / π)                  [dB, always ≤ 0]
```
Note: Uses HORIZONTAL distances, not 3D slant. This is a fix from V33/V44 which incorrectly used 3D.

### 3.5 Terrain diffraction (ISO 9613-2 §7.3/7.4 + CNOSSOS-EU §2.5.6(c))
```
δ = path_via_edges - direct_path    [m]

Single edge (§7.3):
A_bar,i = min(20, 10 × log₁₀(3 + 20 × δ × f[i] / 340))

Double edge (§7.4 / CNOSSOS §2.5.23):
C₃ = (1 + (5λ/e)²) / (1/3 + (5λ/e)²)    where e = edge-to-edge distance, λ = 340/f[i]
A_bar,i = min(25, 10 × log₁₀(3 + C₃ × 20 × δ × f[i] / 340))

Rayleigh gate (CNOSSOS-EU §2.5.6(c)):
if δ ≤ λ/4 − δ*  then  A_bar,i = 0
```
C₃ (identical to CNOSSOS `C"`) accounts for thick barriers: 1.0 when edges are far apart, up to 3.0 when close.

δ* is the path-length difference computed using the same dominant edge D but with mirror source S\* and mirror receiver R\* reflected **vertically** across their respective mean ground planes. Each mean ground plane is an unweighted least-squares line fit over the DEM profile samples on that side (including D itself). D is chosen as the edge with the larger excess above the direct line of sight (this matches the single-edge path difference and is well-defined in the double-edge case).

Simplifications vs. strict CNOSSOS:
- We use **vertical** reflection across the fitted plane (standard acoustic practice in NMPB / NoiseModelling), not perpendicular-to-plane.
- The **−λ/20** near-miss clause is not implemented — the 5-point LOS fast-path in `path_effects.rs` and the early return in `compute_path_difference` collapse all non-blocked paths to zero before diffraction is considered.
- `Δground` additive combination (CNOSSOS §2.5.31) is not implemented — we still combine ground and barrier via `max(A_ground, A_terrain + A_screen)` in §3.3.
- Favourable-conditions curved rays (§2.5.24) are not implemented — see §3.9.
- Lateral diffraction around vertical edges (§2.5.6(i)) is not implemented.

Terrain profile sampled from DEM (Copernicus GLO-30 primary, SRTM fallback). Receiver at **4.0m** above ground.

### 3.6 Building screening (ISO 9613-2, per-band)
Samples Overture Maps 30m building raster along the full source-receiver path.

Current implementation:
- sampling step is adaptive: about **30 m** up to 1 km, **90 m** up to 3 km, **180 m** beyond
- explicit `noise_barrier` geometries compete with raster buildings
- the dominant obstacle is the **tallest candidate on the path**, not an explicit multi-edge building model
- for industrial sources, screening samples inside the source's own footprint are skipped via an exclusion radius

Then path difference is computed using full 3D geometry:
```
S = (0, src_elev),  B = (d_horiz, bld_top),  R = (dist_m, rcv_alt)
δ_bld = |S→B| + |B→R| - |S→R|    (3D detour minus direct slant path)
A_screen,i = min(20, 10 × log₁₀(3 + 20 × δ_bld × f[i] / 340))
```

### 3.7 Vegetation (ISO 9613-2:2024 A.2.2, Central Europe × 0.5 calibration)
```
A_veg,i = min(MAX_VEG_ATTEN[i], α_veg[i] × depth_m)
```
where depth_m = cumulative forest depth along source-receiver path.

Constants (`ALPHA_VEG`, `MAX_VEG_ATTEN`) are ISO 9613-2:2024 Table A.1 values × 0.5 — see
the constants block at the top of this SPEC. Rationale: binary WorldCover forest raster
treats any canopy ≥ 10 % as dense foliage; scalar compensates for over-application.

### 3.8 Urban reflection (ISO 9613-2 §7.5)
Per-RECEIVER boost based on building enclosure:
```
A_refl = clamp(enclosure_db, 0, 5)    [dB]
```
Current implementation estimates `enclosure_db` from local building density in a 3×3 raster sample around the receiver, then applies it ONCE per receiver, not per source-receiver path.

### 3.9 Favourable meteorological conditions (CNOSSOS-EU §2.5.21)
❌ NOT IMPLEMENTED.

`P_FAV = 0.5` constant exists in code, but no wind / inversion / favourable-propagation correction is applied in current propagation.

### 3.10 Transport-specific adjustments
Applied in pipeline and popup:
- **Bridge**: G=0 (hard surface, overrides IMD raster)
- **Tunnel**: segment skipped entirely (sound contained inside)
- **Oneway road**: AADT × 0.5 (approximation: half the traffic of two-way)
- **Junction**: speed capped at 30 km/h (roundabouts)
- **Service railway** (yard/siding/spur): counts × 0.02
- **Parallel railway ways**: counts divided by `parallel_divisor`
- **Industrial exclusion radius**: R=√(area/π) — buildings within R of source point are not counted as screening (prevents self-screening from source's own footprint)

Road `access` column (u8) encoding:
| code | OSM meaning | Effect |
|------|-------------|--------|
| 0 | public / default | no change |
| 1 | private | AADT × 0.1 |
| 2 | no / `motor_vehicle=no` | segment skipped |
| 3 | destination | no reduction applied (known simplification) |
| 4 | other restricted | segment skipped |

### 3.11 Total received level per band
```
L_received,i = L_emission,i - A_div,i - A_atm,i - A_ground_or_barrier,i - A_veg,i + A_refl + FLC

where A_ground_or_barrier,i = max(A_ground,i, A_terrain,i + A_screen,i) if barrier exists
```

### 3.12 A-weighted total
```
L_A = 10 × log₁₀(Σ_i 10^((L_received,i + A[i]) / 10))
```

---

## 4. Lden (END 2002/49/EC)

```
Lden = 10 × log₁₀((12 × 10^(Ld/10) + 4 × 10^((Le+5)/10) + 8 × 10^((Ln+10)/10)) / 24)
```

Penalty: +5 dB evening, +10 dB night.

---

## 5. Aircraft

Current public `aircraft` layer is a HYBRID of:
- **Airborne overflights**: Doc 29-inspired empirical NPD model
- **Airport ground ops**: runway / taxi / apron line sources propagated through Section 3 ISO 9613-2 path effects

### 5.1 Airborne aircraft (Doc 29 4th Edition)

SEPARATE from ISO 9613-2. Airborne Doc 29 is empirical NPD-based, not path-tracing.

### Master equation (Eq. 4-8b)
```
SEL_seg = L_E(d_p) + ΔV + ΔI(φ) - Λ(β, l) + ΔF
```

- **L_E**: NPD lookup at slant distance d_p (feet). 8 proxy profiles.
- **ΔV**: Speed/duration correction (Eq. 4-14)
- **ΔI**: Engine installation angle correction (Eq. 4-15)
- **Λ**: Lateral attenuation (Eq. 4-18/19), applied to all profiles including rotorcraft (see note below)
- **ΔF**: Finite segment dipole correction (Eq. 4-20, full α/(1+α²) terms)

Lateral attenuation note: profile 6 is a mixed LightGA+Rotorcraft bucket. Doc 29
skips Λ for rotorcraft, but our implementation applies it to profile 6 because
fixed-wing GA dominates the bucket; skipping Λ overestimates GA noise by up to
~11 dB at low β. A pure-helicopter cluster submodel would split this correctly.

### Geometry (§4.4.1)
CPA (Closest Point of Approach) computed on segment EXTENSION (unclamped).
d_p = slant distance at CPA. β = elevation angle.

### Input and preprocessing (current implementation)
- ADS-B supplies real segment geometry, altitude, speed, timestamp, and often `on_ground`
- aircraft `typecode` is mapped to one of **8 proxy NPD profiles**
- unknown / unmapped typecode falls back to **Generic** (profile 7)
- `is_departure` is inferred from median climb rate (`ROCD > 500 fpm`)
- day/evening/night period is approximated from timestamp using **UTC+1**
  (global atlas TODO: convert to receiver-local time at tile generation)
- airport context uses `airport_lines.arrow` + `airport_areas.arrow`
- candidate airport-ground segments are those with:
  - `on_ground = true`, or
  - both endpoints within **60 m AGL**
- stale ground / taxi remnants are filtered by:
  - `on_ground` with **no airport context**
  - fallback low-AGL test (`<= 15 m AGL`) with **no airport context**
- **segment length cap at extraction: 10 km** (`MAX_SEGMENT_LENGTH_M`). Longer
  cruise segments from sparse traces are split along actual trace points (no
  synthetic interpolation). Legacy pre-cap data can still contain longer segments.

### Data-quality gating (`is_valid_airborne_segment`)
Shared single-source-of-truth filter used by both pipeline and popup. Applied
to airborne segments (`on_ground = false`, `ground_context = NONE`). Ground and
airport-context segments bypass this filter (handled by the ground-ops submodel).

Universal impossibility checks (all airborne profiles):
- **midpoint underground**: `max(start_alt, end_alt) < midpoint_terrain - 30 m`
- **endpoint AGL**: `start_agl < -30 m` or `end_agl < -30 m` (DEM-relative, so
  subsea-level airports like Schiphol/Atyrau pass the filter)
- **line goes under terrain**: 25%/75% interpolated samples ≤ terrain - 30 m

Jet-only (profiles 0, 1, 2, 3, 5, 7; Turboprop/LightGA/Rotorcraft exempt):
- **impossible jet speed**: `speed_kt < 80`
- **jet too low**: `max_alt < midpoint_terrain + 150 m`
- **legacy long-segment stitching guards** (legacy pre-10-km-cap data):
  - 30 km line extrapolation crossing sea level within ±50% of length
  - 30 km segment with both endpoints under 2000 m AGL
  - 100 km segment mixing near-ground and cruise altitudes

### Filter D — per-receiver sub-terrain extrapolation rejection
`compute_cpa` uses the infinite-line (unclamped) CPA for all outputs: d_p,
lateral, rel_alt, β, q. This is Doc 29 §4.4.1 verbatim. The unclamped parametric
foot `t` is also returned in `CpaResult` for downstream filtering.

Filter D (`segment_sel_with_overrides` in noise-compute, `segment_energy` and
`segment_energy_fast` in pipeline-worker) rejects a (segment × receiver) pair
when BOTH:
1. `t ∉ [0, 1]` — the CPA foot falls outside the observed endpoints (the
   implied aircraft position is a straight-line projection, not a recorded
   trace sample), AND
2. The linearly-extrapolated altitude at the foot is **> 30 m below terrain**
   at `(foot_lat, foot_lon)`. Airport-ground segments bypass the filter.

Why the `t ∈ [0, 1]` gate matters: legitimate cases keep their CPA inside the
observed segment — Schiphol-style sub-sea descents (CPA within descent segment),
hill-top receivers with aircraft in a valley (CPA within cruise segment). Only
fictional extrapolations past touchdown or beyond the last cruise sample can
land outside `[0, 1]`.

Why the 30 m margin: DEM error plus short-segment extrapolation uncertainty.
A descending landing whose line would put the aircraft 200 m below ground at
t = 1.1 is clearly fiction; a cruise segment whose line grazes 5 m below a
ridge at t = 1.05 is likely real data-thinning.

Implementation cost: one branch per kernel call (always false for `t ∈ [0,1]`),
plus two pre-computed `terrain_[start|end]_cut_m` thresholds per segment at hex
load. Airborne pipeline segments hold these; ground segments set them to
`f64::MIN` so the branch never fires.

Historical note: an earlier blanket filter at `CPA rel_alt < -50 m` / jet
`rel_alt < 30 m AGL` was tried and removed after independent review — it
created spatial discontinuities for valid hill-top receivers. Filter D is
the geometry-aware replacement.

### Pipeline approximations (batch kernel only; popup uses exact NPD)
- `fast_atan`: Padé [3/2] approximation, max error 0.0034 rad (~0.19°).
- `fast_delta_f`: ΔF via `fast_atan`, max error < 0.05 dB per segment.
- `fast_lateral_attenuation`: Λ with `fast_atan` (no `atan2`).
- NPD LUT: 64-bin log₁₀(d_ft) table spanning 2.0 to 5.5, linear interp.
- Combined max error vs exact NPD: ~0.15 dB per segment.

### Cross-flight bucket merge (pipeline-only)
After ring-1 R4 load, airborne segments are merged into buckets keyed by
quantized geometry + profile + direction + period + speed. `count_weight` is
summed across the bucket (exact annual energy for acoustically-identical flights).

Bucket widths (calibrated against ±50-100 m ADS-B jitter):
- lat/lon: ~100 m (factor 1113)
- altitude: 60 m
- speed: 20 kt

`date_id` is NOT part of the key — output tiles are permanently annual. Sub-annual
reporting would require reintroducing date_id OR running the pipeline on daily
partitions. Popup reads raw per-flight segments for the "top flights" UI.

### Cross-hex visibility (ring-1 loading)
Pipeline loads the target R4 hex plus its 6 H3 grid-disk ring-1 neighbors before
filtering segments by target-hex bounding capsule. Popup uses the same data via
bbox-indexed R-tree (not midpoint) so long/cross-hex segments are always found.
Antimeridian-crossing segments (|Δlon| > 180°) are excluded from the R-tree to
avoid degenerate global bboxes.

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
❌ BROADBAND ONLY. NPD returns single SEL value. Do not fabricate per-band data.

### 5.2 Airport ground ops (current implementation)

Airport ground ops are a separate submodel inside the `aircraft` layer.

Inputs:
- observed ADS-B segments flagged `on_ground` or low-AGL near airports
- airport geometry from `airport_lines.arrow` and `airport_areas.arrow`

Ground-context classification:
- contexts: `airport_line`, `airport_area`, `inferred`
- airport line matching uses OSM width when present, otherwise default widths:
  - runway / stopway **45 m**
  - taxiway **18 m**
- airport areas use polygon containment when available, otherwise area-based fallback radii
- repeated multi-day clusters of `on_ground` segments with no OSM match can be upgraded to `inferred` airport context

Ground-ops classes:
- **runway_roll**
- **taxi**
- **apron_movement**

Class fallback without explicit aeroway match:
- `speed >= 40 kt` or `segment_length >= 500 m` → runway_roll
- `speed >= 8 kt` → taxi
- otherwise apron_movement

Synthetic fill of missing ground coverage:
- airports are grouped from airport lines / areas by airport key or coarse spatial cluster
- only enabled when observed flights for a group >= **12**
- missing coverage scale = `1 - covered_observed / all_observed`
- if missing coverage > **5%**, synthetic surface segments are emitted from airport geometry:
  - runway share **70%** at **70 kt**
  - taxiway share **20%** at **18 kt**
  - apron share **10%** at **12 kt**
  - helipad / heliport apron speed **6 kt**
- apron polygons are sampled on ~**90 m** grid, capped at **8** points
- apron point emitters become short **24 m** micro-segments
- tiny synthetic weights `< 0.05` are dropped

Ground-ops line-source emission:
- source height = **4.0 m**
- profile-specific reference SEL table by aircraft family × class (`runway / taxi / apron`)
- runway departure gets **+2 dB**
- speed adjustment relative to nominal class speed is clamped to **±3 dB**
- max radius:
  - runway_roll **5 km**
  - taxi **3 km**
  - apron_movement **1.5 km**

Ground-ops propagation:
- converted to octave-band line-source emission
- then propagated with the same Section 3 engine as other ground line sources
- terrain / screening / vegetation ARE applied

Pipeline/output note:
- batch tiles merge airborne + ground ops into one `aircraft` layer (`source_type = 4`)
- aircraft `.adj.bin` tiles are NOT currently emitted, even though popup breakdown computes path-effect variants for airport ground ops

---

## 6. Industrial Emission

### Source geometry
Receives PRE-DISCRETIZED point sources. Discretization done at import:
- **Wind turbine**: single point at centroid
- **Non-wind, area ≤ 5000 m²**: centroid
- **Non-wind, area > 5000 m² and polygon available**: H3 interior grid points
- fallback to centroid if polygon/grid generation fails
- Energy split: Lw_per_point = Lw_total - 10×log₁₀(N_points)

Each discretized point also carries:
```
R_excl = √(area_per_point / π)
```
This exclusion radius is used only for self-screening suppression.

### Emission
```
Lw = baseLw + 10 × log₁₀(min(area_m², 500000) / 10000)
```
Current profile priority:
1. `nace_4digit` baked into `industrial.arrow`
2. OSM-derived `site_subtype`
3. coarse `source_type`

baseLw from NACE / subtype / source-type profile (calibrated against Czech SHM 2022):
- Heavy industry (cement, steel, power): 99-100 dB
- Medium industry (chemical, food): 88-95 dB
- Light industry (warehouse, commercial): 70-86 dB
Area scaling capped at 50 ha (500,000 m²) to prevent OSM polygon artifacts.

Area priority:
1. `area_m2` from Arrow if present
2. polygon area from WKB
3. fallback `10000 m²`

### Source height
- quarry (`source_type = 1`): 8m
- heavy industry (NACE 8/23/24/35): 10m
- other industrial: 5m
- wind turbine: `hub_height`

### Wind turbines (IEC 61400-11)
```
Lw = rating_lookup(rated_power_kw)    [98-107 dB by power class]
```
Spectrum: [-2, -1, 0, 1, 1, 0, -2, -5] dB relative to broadband.

Fallbacks:
- `hub_height` default = **80 m**
- `rated_power_kw` default = **2000 kW**

### Propagation
ISO 9613-2 point source (same as roads but with point-source divergence).

---

## 7. Settlement (buildings)

### Source geometry
PRE-DISCRETIZED at import.

Current implementation:
- small / missing-polygon buildings: centroid
- buildings with `area > 2000 m²` and polygon available: interior grid at **30 m** spacing
- if grid generation yields only one point, fallback to centroid

Each source gets a fade-out radius from emitted Lw, capped at **2 km**.

### Emission (custom model, NOT standardized)
```
Lw = 10 × log₁₀(10^(Lw_fixed/10) + GFA × 10^(Lw_per_m²/10))
where GFA = area_m² × floors
```
Current implementation has **10 building classes + default fallback**:
- residential
- commercial
- warehouse / industrial building
- school
- hospital
- church / worship
- hotel
- garage / parking
- farm building
- public / civic

Type priority:
1. `amenity` / `shop` / `healthcare` / `tourism` / `leisure`
2. fallback to `building=*`
3. default residential

Geometry priority:
1. `height`
2. `floors × 3 m`
3. fallback `8 m`

Area priority:
1. `area_m2` from Arrow
2. polygon area from WKB
3. fallback `100 m²`

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
| K7 | Double barrier 200m, δ=1.0m, G=0.5 | 16.30 dB barrier atten | ISO 9613-2 |
| K8 | Lden: Ld=60, Le=55, Ln=50 | 60.00 dB | END 2002/49/EC |

---

## Documented Simplifications vs Standards

| Simplification | What we do | What the standard says | Impact |
|---|---|---|---|
| **Line source + FLC** | Cylindrical divergence + end-angle finite-line correction | ISO 9613-2: point sources only, subdivide line into representative points | ±1-2 dB near segment endpoints. Standard practice in noise mapping software. |
| **Road inputs** | Real `aadt_*` if present, otherwise class defaults; local heuristics may write `traffic_source > 1` | CNOSSOS expects external traffic inputs, not atlas-side fallback heuristics | Coverage stays global, but low-class roads may be approximate where counts are missing. |
| **Road period split** | Fixed 65/20/15 or 70/18/12 split of daily AADT | Regulatory workflows may use measured day/evening/night counts | Bias possible on commuter / nightlife corridors. |
| **Surface correction** | One scalar ΔL_WR per surface type | CNOSSOS Table F-4: per-band αm + βm, speed-dependent | ±1 dB. Our scalars are band-averaged approximations. |
| **Ground effect** | CF[i] × G lookup; path-averaged G for line sources, receiver-local G for point sources (popup and pipeline match in both cases) | CNOSSOS §2.5.15-18: geometry-dependent Aground with height substitutions, separate source/middle/receiver zones | ±2 dB in complex terrain / mixed ground. |
| **Diffraction** | 10·log₁₀(3 + C₃·20·δ·f/340), caps 20/25 dB, C₃ for double edges, Rayleigh gate per band via δ* with vertical mirroring across OLS-fitted per-side mean ground planes | CNOSSOS §2.5.6(c): Rayleigh criterion; §2.5.23: C" (identical to our C₃); §2.5.31: Δground additive combination; §2.5.24: favourable-conditions curved rays | ±1 dB behind shallow hills at low bands. Not implemented: Δground additive combination, curved rays, −λ/20 near-miss clause, lateral diffraction. |
| **Building / barrier screening** | Tallest raster obstacle or explicit noise barrier along the path | ISO 9613-2: explicit obstacle modelling per edge / geometry | ±3 dB in complex urban. Our approach samples raster, not individual building edges. |
| **Urban reflection** | Per-receiver enclosure boost +0-5 dB | ISO 9613-2 §7.5: image-source reflection model | ±2 dB. Standard requires full reflection geometry, we use a local heuristic. |
| **Meteorology** | NOT IMPLEMENTED (P_FAV exists but unused) | ISO 9613-2: Cmet = C₀(1 - 10·h_s/r), subtracted from downwind | ±2 dB at long range. TODO: implement. |
| **Road categories** | 4 categories (no 4a mopeds, no 5) | CNOSSOS: 5 categories (4a, 4b, 5) | <0.5 dB. Vehicle mix is slightly flattened. |
| **Road corrections** | No gradient / intersection / temperature corrections | CNOSSOS includes extra source-side corrections | ±1-3 dB on steep links, cold weather, or stop-go junctions. |
| **Railway emission** | Simplified RMR (one rolling spectrum per type, train/day scaling) | CNOSSOS Annex IV: component-based (roughness, transfer function per rail/wheel type) | ±2 dB. We use aggregate reference spectra, not full component model. |
| **Railway period split** | Fixed 65/20/15 split of daily passenger/freight counts | Measured per-period rail traffic would be more accurate | Night freight corridors can be biased if only daily counts are known. |
| **Receiver height** | 4.0m (END facade) | END: 4.0m (facade). ISO: variable. | Matches END standard. |
| **Settlement noise** | Custom per-building source model | END / CNOSSOS do not standardize this source class | Useful for atlas context, but not regulatory-comparable. |
| **Industrial profiles** | `nace_4digit -> site_subtype -> source_type` fallback chain | Standard inventories usually use audited source inventories / measured facility data | Keeps global coverage, but facility class can be approximate when registry match is missing. |
| **Aircraft NPD** | 8 proxy profiles + heuristic typecode mapping | Doc 29: official ANP database | ±3 dB per aircraft type. We approximate, not certify. |
| **Aircraft local time / ground filtering** | UTC+1 period approximation + airport-context stale-ground filter | Operational studies use airport-local time and curated trajectory cleaning | Timing and near-runway behaviour can be biased. |
| **Aircraft ground ops** | ADS-B low-AGL / on-ground segments matched to airport geometry, plus synthetic runway/taxi/apron fill when coverage is incomplete | Airport studies usually use curated surface movement inventories and local operations data | Near-runway levels depend on airport geometry quality and ADS-B ground coverage. |
| **Aircraft tile adjustments** | Aircraft ground propagation could expose separate terrain / screening / vegetation variants | Batch `aircraft` tiles currently bake ground-ops path effects into final Lden and do not emit `.adj.bin` | Map propagation toggles cannot isolate aircraft ground-ops attenuation separately. |
| **Bridge/tunnel** | Bridge G=0, tunnel skip | No standard specifies this directly | Physically correct — bridge is hard surface, tunnel contains sound. |
| **Oneway roads** | AADT × 0.5 | No standard | Approximation: one-way carries ~50% of two-way equivalent. |
| **Private / service access heuristics** | Private roads ×0.1, service rail ×0.02 | No standard | Atlas-scale approximation where access restrictions imply low traffic. |
| **Industrial self-screening** | Exclusion radius R=√(area/π) | ISO 9613-2: explicit geometry | Prevents false screening from source's own building footprint. |
