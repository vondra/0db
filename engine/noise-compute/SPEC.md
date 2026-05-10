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

### Input priority (current implementation)
1. If Arrow has `aadt_*` with `aadt_light > 0` and the row's `provenance` (derived from `source_id` via `sources::provenance_of()`, see `Provenance` enum in `sources.rs`) is non-`None`, use those flows (oneway × 0.5 still applied; `access_factor` reductions are bypassed only for `Provenance::is_measured()` — i.e. `NationalMeasured`, `ContinentalMeasured`, `GlobalMeasured`. `Heuristic` and `Baseline` rows still get access reductions). Provenance values: `NationalMeasured`, `ContinentalMeasured`, `GlobalMeasured`, `Heuristic`, `Baseline`.
2. Otherwise use `default_road_traffic(road_class)` combined with the lane-ratio boost (see below).

Speed priority:
- `maxspeed` from OSM if present
- otherwise `default_road_speed(road_class)` (see `normalize.rs`)
- junction flag caps speed at 30 km/h (roundabouts)

Surface priority:
- recognized OSM `surface=*`
- otherwise asphalt (`ΔL_WR = 0`)

### Defaults, lane boost, period split

Per-class AADT defaults live in `defaults.rs` (`WORLD_DEFAULT` + city/country/continent cascade). Default speeds (`default_road_speed`) and lane-count boost above 2 lanes (`lane_ratio`) live in `normalize.rs`. Day/evening/night split (65/20/15 for motorway-class, 70/18/12 for everything else) lives in `emission/road.rs` (`TIME_DIST_MOTORWAY`, `TIME_DIST_URBAN`). Even with measured AADT, per-period counts use the same fixed split — sub-daily census data is not currently measured from source.

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
2. otherwise `default_traffic(rail_type, usage)` (see `railway.rs`)

Speed:
1. OSM `maxspeed` if present
2. otherwise `300 km/h` when `highspeed=true`
3. otherwise `default_speed(rail_type)` (see `railway.rs`)

Post-adjustments applied even on real counts:
- `service > 0` → counts × **0.02**
- `parallel_divisor > 1` → counts divided by that factor

### Defaults and period split

Per-`rail_type` × `usage` train-count and speed defaults: see
`engine/noise-compute/src/emission/railway.rs`. Day/evening/night uses the
same 65/20/15 split for passenger and freight — there is no asymmetric
split for night-biased freight even where it would be realistic.

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

Triple edge (project simplification — ISO/CNOSSOS silent for N=3):
δ = |S→E1| + |E1→E2| + |E2→E3| + |E3→R| − |S→R|
e = |E1 → E3|    first-to-last edge path distance (per CNOSSOS wording for multiple diffraction)
A_bar,i = min(25, 10 × log₁₀(3 + C₃ × 20 × δ × f[i] / 340))

C'' = 1 floor (CNOSSOS §2.5.23): C₃ is clamped to 1 when e ≤ 0.3 m.

Rayleigh gate (CNOSSOS-EU §2.5.6(c)):
if δ ≤ λ/4 − δ*  then  A_bar,i = 0
```
C₃ (identical to CNOSSOS `C"`) accounts for thick barriers: 1.0 when edges are far apart, up to 3.0 when close.

**Edge selection (N ∈ {1, 2, 3}):** upper convex hull of the sampled (t·dist, elevation) profile, filtered to samples above the source→receiver line-of-sight. If more than 3 hull vertices remain, keep the top-3 by LOS excess and rebuild the hull over `{endpoints ∪ top-3}` to guarantee a geometrically valid S→E1→…→R path (no straight-line segment dips below the dropped vertex's terrain).

**3-edge cap is a project simplification.** ISO 9613-2 §7.4 defines cascade Fresnel for N≤2; CNOSSOS-EU §2.5.6 describes the shape of the multiple-diffraction correction without explicitly capping the edge count. Our N=3 implementation uses the first-to-last path distance as `e` and the double-edge 25 dB cap. N=3 covers practically all real terrain profiles within ~10 km; beyond that the Rayleigh gate typically dominates and the correction saturates.

δ* is the path-length difference computed using the same dominant edge D but with mirror source S\* and mirror receiver R\* reflected **vertically** across their respective mean ground planes. Each mean ground plane is an unweighted least-squares line fit over the DEM profile samples on that side (including D itself). D is chosen as the edge with the larger excess above the direct line of sight (for N≥2 this is the edge with the largest LOS excess of all).

**δ\* fits on bare-earth elevation only.** When the combined-screening entrypoint (`combined` terrain+building+barrier top profile) invokes diffraction, δ* continues to fit on `elevation_m` so the mean-ground planes represent the *ground reflection* surface that CNOSSOS §2.5.6(c) physically defines. Feeding building heights to the OLS fit would drag the mean-ground plane up to rooftops and silently break ground-reflection physics.

Simplifications vs. strict CNOSSOS:
- We use **vertical** reflection across the fitted plane (standard acoustic practice in NMPB / NoiseModelling), not perpendicular-to-plane.
- The **−λ/20** near-miss clause is not implemented — `compute_path_difference` early-returns zero when no sampled elevation sits above the line-of-sight, collapsing all non-blocked paths to zero before diffraction is considered.
- `Δground` additive combination (CNOSSOS §2.5.31) is not implemented — we still combine ground and barrier via `max(A_ground, A_terrain + A_screen)` in §3.3.
- Favourable-conditions curved rays (§2.5.24) are not implemented — see §3.9.
- Lateral diffraction around vertical edges (§2.5.6(i)) is not implemented.
- **Multi-edge capped at N=3** (project simplification, see above).

See §3.5a for the shared path-sampling scheme.

### 3.5a Unified path sampler

DEM, Overture building height, WorldCover forest cover and IMD imperviousness are all sampled along the source→receiver line by a single bilateral cadence — density highest near endpoints (Fresnel zone narrowest), coarsest in the middle. Implementation + cadence rationale: `propagation::path_profile::fill_t_values`. Terrain diffraction, building screening, vegetation depth, and ground-effect G all read from the resulting `PathProfile`.

### 3.5b Combined terrain + building + barrier screening

Diffraction is computed once over a composite top profile (`elevation + max(building_h, barrier_h)`), avoiding the terrain+screening double-count that would otherwise occur when a building sits on a hill. The δ* OLS mean-ground fit stays on bare-earth elevation. Implementation + caller API split (`terrain_attenuation` vs `screening_attenuation`): `propagation::path_effects::screening_attenuation_with_meta`. Ground G and vegetation depth are path integrals weighted by interval length so non-uniform bilateral spacing doesn't bias endpoints.

### 3.6 Building screening (ISO 9613-2, per-band)
Samples Overture Maps 30m building raster at the same bilateral cadence (§3.5a). Explicit `noise_barrier` geometries compete with raster buildings. For industrial sources, screening samples inside the source's own footprint are skipped via an exclusion radius.

**Screening is not computed standalone.** Buildings and barriers are merged into the §3.5b composite top profile (`elevation + max(building_h, barrier_h)`) and diffraction is computed once by the §3.5 multi-edge algorithm (upper convex hull, up to 3 edges, CNOSSOS C₃ / Rayleigh gate). The per-band screening cap inherits from §3.5 — 20 dB when the composite yields a single edge, 25 dB for 2–3 edges — not a dedicated building-only cap.

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

Road `access` and `road_class` u8 enums (codes, OSM mappings, AADT-reduction factors): see `engine/osm-extract/src/classify.rs` and the consumer in `engine/noise-compute/src/normalize.rs::access_factor`. The reduction is bypassed only when `Provenance::is_measured()` is true (NationalMeasured / ContinentalMeasured / GlobalMeasured); `Heuristic`, `Baseline` and `None` rows still get access reductions.

Link rationale (codes 10-12, `*_link` slip roads / ramps carry 15% of mainline AADT — HCM 7 / FEHRL / CERTU lower-range, validated against Pasito Blanco GC-1 popup): see `defaults.rs` ramp rows. `secondary_link` / `tertiary_link` stay on mainline codes (3/4) because their flow is closer to regular urban streets. For `highway=track` without a `surface` tag, the extractor defaults to `unpaved` (+3 dB rolling correction).

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

- **L_E**: NPD lookup at slant distance d_p (feet). ~124 per-typecode profiles auto-generated from EASA ANP v2.3, bucketed at 12 aircraft noise classes for aggregation (`NUM_CLASSES` in `profiles_generated.rs`). See `scripts/build-aircraft-profiles.py`.
- **ΔV**: Speed/duration correction (Eq. 4-14)
- **ΔI**: Engine installation angle correction (Eq. 4-15)
- **Λ**: Lateral attenuation (Eq. 4-18/19) — Wing-mounted jets only per Doc 29 §4.5.4 / FAA AEDT TM §6.2.4. Fuselage-mounted, propeller, and helicopter installations get Λ = 0 (gated by `installation` parameter in `fast_lateral_attenuation` / `lateral_attenuation`).
- **ΔF**: Finite segment dipole correction (Eq. 4-20, full α/(1+α²) terms)

### Geometry (§4.4.1)
CPA (Closest Point of Approach) computed on segment EXTENSION (unclamped).
d_p = slant distance at CPA. β = elevation angle.

### Input and preprocessing (current implementation)
- ADS-B supplies real segment geometry, altitude, speed, timestamp, and often `on_ground`
- aircraft `typecode` is mapped to one of **~124 per-typecode NPD profiles**
  (auto-generated from EASA ANP v2.3) clustered at 12 aircraft noise classes for
  bucket-key aggregation
- unknown / unmapped typecode falls back to **`FALLBACK_PROFILE_IDX`** (a
  B738/737800-equivalent profile)
- `is_departure` is inferred from median climb rate (`ROCD > 500 fpm`)
- day/evening/night period is derived from the segment-midpoint coordinate via
  **tzf-rs IANA timezone lookup + chrono-tz** (DST-aware UTC → local wall-clock).
  Boundaries follow END 2002/49/EC defaults: day [07:00, 19:00), evening
  [19:00, 23:00), night [23:00, 07:00). Historical DST rules come from
  tzdata 2024a+.
- airport context uses `airport_areas.arrow` (nearest-aerodrome identity)
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

`compute_cpa` uses the infinite-line (unclamped) CPA for all outputs (Doc 29
§4.4.1). Filter D then rejects (segment × receiver) pairs whose CPA foot falls
outside the observed endpoints AND whose extrapolated altitude lies > 30 m below
terrain. Airport-ground segments bypass the filter. Full rationale (geometry,
30 m margin, replaced-blanket-filter history) lives in the rustdoc on
`segment_energy_kernel` (`emission/aircraft.rs`).

### Shared kernel approximations

The popup and the pipeline batch path use the same Doc 29 kernel
(`segment_energy_kernel`); see its rustdoc for the four approximations
(NPD via 128-bin LUT, ΔF via `fast_delta_f`, Λ via `fast_lateral_attenuation`,
ΔI via inline `u²/v²`) and the < 0.15 dB per-segment combined error.

### Cross-flight bucket merge

Two paths exist: **v4** bucketed at ~100 m lat/lon × 60 m altitude × 20 kt
(`engine/noise-compute/src/emission/aircraft_bucket.rs`, calibrated against
±50-100 m ADS-B jitter), and **v5** bucketed at R5 hex × 12 noise classes ×
heading × altitude bin (`engine/aircraft-tracks/src/aggregate.rs`).
`count_weight` summed across the bucket gives exact annual energy for
acoustically-identical flights. `date_id` is not in either key — output tiles
are permanently annual; sub-annual reporting would require daily partitions.
Popup reads the same arrow as the pipeline, so popup ↔ tile parity is a
structural property of consuming the baked output.

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

### Per-event peak Lmax (informational only)

The popup's per-flight `Lmax` and the band-classification thresholds (>30 / >45 / >60 dB) come from per-class LAmax NPD LUTs ingested directly from the ANP CSVs alongside the SEL NPDs.

```
Lmax_event = lookup_lmax(class_idx, is_departure, log10(d_p_ft))
```

Implementation: `engine/noise-compute/src/lib.rs:1874` calls `NpdLuts::lookup_lmax`; the LUTs are built by `build_lmax_lut` in `engine/noise-compute/src/emission/aircraft.rs`. Inside the 200 ft – 25 000 ft NPD table the LUT log-linearly interpolates between adjacent NPD points; below 200 ft it extends the first-two-point slope; above 25 000 ft it extrapolates via spherical divergence (`−20·log10(d/d_ref)`) plus the per-profile `alpha_eff` for atmospheric absorption (same fit used for SEL, since LAmax and SEL share the same source spectrum). `peak_lmax` per flight = max across segments of `Lmax_event`.

**What is dropped vs full Doc 29 Eq. 4-12**: ΔI (installation directivity) and Λ (lateral attenuation) are not applied to `Lmax_event` — only the NPD curve. Doc 29 applies them per segment to `Lmax,seg`, which would give a small additional reduction at low elevation angles for wing-mounted jets. For popup peak ranking and band-count thresholds the residual is < 2 dB; this is acceptable for an informational display and avoids a second per-segment kernel pass.

**Sources**: ECAC Doc 29 4th Ed §A.3.1 (LAmax NPDs), FAA AEDT Tech Manual §6.4 (LAmax interpolation procedure), EASA ANP v2.3 + v9 published L_MAX_A / L_MAX_D NPD tables.

### 5.2 Airport ground ops (raw-ADS-B-paths model, schema v10)

Airport ground ops are a separate submodel inside the `aircraft` layer.

Inputs:
- observed ADS-B segments classified `Phase::Ground` by Stage 1
  (low-AGL on-ground rolls + taxi traces)
- aerodrome polygons from `airport_areas.arrow` (filtered to
  `aeroway_type == AERODROME`) for nearest-aerodrome identity only —
  **no snap onto runway / taxi / apron geometry**

Path extraction (one row of `ground.arrow` = one aircraft × one
contiguous ground run):
- group `FlightSegment`s by `flight_id`, walk in time order
- a "path" is a maximal run of consecutive `Phase::Ground` segments
  where `segN+1.start = segN.end` (Stage 1 enforces touching at
  frame boundaries; non-touching pairs split a new path)
- vertices = sequence of consecutive segment endpoints
- airport identity = nearest `aeroway = aerodrome` polygon within
  `max(3000, area_radius_m × 1.5)` of the path centroid; when no
  aerodrome is in range, an `airport_key = "strip:{r7_hex}"` (H3
  res-7 ≈ 1.2 km cell) anchors anonymous strips so distinct grass
  fields don't merge into one `(no airport)` cluster

Per-leg `ops_kind` (one leg = one `FlightSegment` end-to-end):
- speed-based classifier: `speed_kt ≥ 40 OR length_m ≥ 500` →
  `runway_roll`; `speed_kt ≥ 8` → `taxi`; else `apron_movement`
- smoothing pass: a leg whose `ops_kind` differs from BOTH neighbours
  AND is short (< 10 s OR < 30 m) inherits the neighbour's kind, so
  a slow taxi pause in a runway-hold queue doesn't mis-classify as
  apron

Per-leg `count_weight = 1 / n_legs_of_this_kind_in_path`:
- distributes one movement's reference-SEL energy across the
  same-kind legs of one path
- Σ count_weight across same-kind legs of one path = 1.0 — summing
  per-leg energy × count_weight reconstructs one movement's energy
- `build_ground_ops_line_emission` is called with `count_weight=1.0`
  so the stored `em_bands` represents one full event's emission;
  the popup applies the per-leg `count_weight` exactly once

Ground-ops line-source emission (per leg):
- source height = **4.0 m**
- profile-specific reference SEL table by aircraft family × class
  (`runway / taxi / apron`)
- runway departure gets **+2 dB**
- speed adjustment relative to nominal class speed is clamped to
  **±3 dB**

Ground-ops propagation (popup):
- per-path bbox prefilter at **16 km** envelope, per-leg prefilter
  at the same conservative cap (the kernel's
  `below_free_field_threshold_line` does the precise per-band
  rejection inside)
- per leg: `propagate_variants_full` with `SourceGeometry::Line`,
  finite-line correction, and full Section 3 path effects (terrain
  / screening / vegetation / ground)

Synthetic fill (was active pre-v10 when ADS-B coverage missed parts
of an airport's footprint) is **not part of the v10 model**. The
v10 design choice: the popup faithfully shows what ADS-B saw, and
unobserved ground ops simply don't appear. Tier 3 backlog #4
tracks the schedule-synth driver that would re-introduce a
coverage-fill driver on top of curated schedules.

Pipeline/output note:
- batch tiles merge airborne + ground ops into one `aircraft` layer
  (`source_type = 4`)
- aircraft `.adj.bin` tiles are NOT currently emitted, even though
  popup breakdown computes path-effect variants for airport ground
  ops

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
| **Road inputs** | Real `aadt_*` if present (any non-`None` `Provenance`), otherwise class defaults; local heuristics flagged as `Provenance::Heuristic` | CNOSSOS expects external traffic inputs, not atlas-side fallback heuristics | Coverage stays global, but low-class roads may be approximate where counts are missing. |
| **Road period split** | Fixed 65/20/15 or 70/18/12 split of daily AADT | Regulatory workflows may use measured day/evening/night counts | Bias possible on commuter / nightlife corridors. |
| **Surface correction** | One scalar ΔL_WR per surface type | CNOSSOS Table F-4: per-band αm + βm, speed-dependent | ±1 dB. Our scalars are band-averaged approximations. |
| **Ground effect** | CF[i] × G lookup; path-averaged G for line sources, receiver-local G for point sources (popup and pipeline match in both cases) | CNOSSOS §2.5.15-18: geometry-dependent Aground with height substitutions, separate source/middle/receiver zones | ±2 dB in complex terrain / mixed ground. |
| **Diffraction** | 10·log₁₀(3 + C₃·20·δ·f/340), caps 20/25 dB, C₃ for double edges, Rayleigh gate per band via δ* with vertical mirroring across OLS-fitted per-side mean ground planes | CNOSSOS §2.5.6(c): Rayleigh criterion; §2.5.23: C" (identical to our C₃); §2.5.31: Δground additive combination; §2.5.24: favourable-conditions curved rays | ±1 dB behind shallow hills at low bands. Not implemented: Δground additive combination, curved rays, −λ/20 near-miss clause, lateral diffraction. |
| **Building / barrier screening** | Composite top profile (`elevation + max(building_h, barrier_h)`) sampled at the unified bilateral cadence; upper-convex-hull edge detection up to 3 edges with CNOSSOS C″ | ISO 9613-2: explicit obstacle modelling per edge / geometry | ±3 dB in complex urban. Raster sampling, not individual building edges. |
| **Urban reflection** | Per-receiver enclosure boost +0-5 dB | ISO 9613-2 §7.5: image-source reflection model | ±2 dB. Standard requires full reflection geometry, we use a local heuristic. |
| **Meteorology** | NOT IMPLEMENTED (P_FAV exists but unused) | ISO 9613-2: Cmet = C₀(1 - 10·h_s/r), subtracted from downwind | ±2 dB at long range. TODO: implement. |
| **Road categories** | 4 categories (no 4a mopeds, no 5) | CNOSSOS: 5 categories (4a, 4b, 5) | <0.5 dB. Vehicle mix is slightly flattened. |
| **Road corrections** | No gradient / intersection / temperature corrections | CNOSSOS includes extra source-side corrections | ±1-3 dB on steep links, cold weather, or stop-go junctions. |
| **Railway emission** | Simplified RMR (one rolling spectrum per type, train/day scaling) | CNOSSOS Annex IV: component-based (roughness, transfer function per rail/wheel type) | ±2 dB. We use aggregate reference spectra, not full component model. |
| **Railway period split** | Fixed 65/20/15 split of daily passenger/freight counts | Measured per-period rail traffic would be more accurate | Night freight corridors can be biased if only daily counts are known. |
| **Receiver height** | 4.0m (END facade) | END: 4.0m (facade). ISO: variable. | Matches END standard. |
| **Settlement noise** | Custom per-building source model | END / CNOSSOS do not standardize this source class | Useful for atlas context, but not regulatory-comparable. |
| **Industrial profiles** | `nace_4digit -> site_subtype -> source_type` fallback chain | Standard inventories usually use audited source inventories / measured facility data | Keeps global coverage, but facility class can be approximate when registry match is missing. |
| **Aircraft NPD** | ~124 per-typecode profiles auto-generated from EASA ANP v2.3, 12 aircraft noise classes for bucket aggregation | Doc 29: official ANP database with full procedural-step profiles, weights, aerodynamic coefficients | ±1-2 dB per aircraft type for ANP-mapped types; similarity_fallback for unmapped typecodes (~70-80% of long-tail traffic) routes to closest anchor by engine type / size class. |
| **Aircraft local time / ground filtering** | Per-coordinate IANA TZ lookup (tzf-rs + chrono-tz, DST-aware) + airport-context stale-ground filter | Operational studies use airport-local time (same principle) and curated trajectory cleaning | Near-runway behaviour can still be biased by trajectory-cleaning simplifications. |
| **Aircraft ground ops** | Raw ADS-B trajectories per aircraft × contiguous ground run; nearest-aerodrome identity from `airport_areas.arrow`; per-leg `ops_kind` from speed/length classifier with smoothing pass | Airport studies usually use curated surface movement inventories and local operations data | Near-runway levels depend on ADS-B ground coverage; unobserved movements are not synthesised in v10 (was synth-fill pre-v10; deferred to a schedule-driven driver in Tier 3 backlog #4). |
| **Aircraft tile adjustments** | Aircraft ground propagation could expose separate terrain / screening / vegetation variants | Batch `aircraft` tiles currently bake ground-ops path effects into final Lden and do not emit `.adj.bin` | Map propagation toggles cannot isolate aircraft ground-ops attenuation separately. |
| **Bridge/tunnel** | Bridge G=0, tunnel skip | No standard specifies this directly | Physically correct — bridge is hard surface, tunnel contains sound. |
| **Oneway roads** | AADT × 0.5 | No standard | Approximation: one-way carries ~50% of two-way equivalent. |
| **Private / service access heuristics** | Private roads ×0.1, service rail ×0.02 | No standard | Atlas-scale approximation where access restrictions imply low traffic. |
| **Industrial self-screening** | Exclusion radius R=√(area/π) | ISO 9613-2: explicit geometry | Prevents false screening from source's own building footprint. |

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
