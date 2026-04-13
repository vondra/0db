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

### Vegetation attenuation (ISO 9613-2:2024 Annex A.2.2)
```
α_veg = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.09, 0.12] dB/m
max = [4, 6, 8, 10, 12, 16, 18, 24] dB per band
```

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
1. If Arrow contains `aadt_*` and `traffic_source > 0`, use those flows.
   - `traffic_source = 1`: matched census / external enrichment
   - `traffic_source > 1`: heuristic estimate (for example service-tree on local streets)
2. Otherwise use `default_road_traffic(road_class)`.

Speed priority:
- `maxspeed` from OSM if present
- otherwise `default_road_speed(road_class)`

Surface priority:
- recognized OSM `surface=*`
- otherwise asphalt (`ΔL_WR = 0`)

### Period traffic
Day (07-19), Evening (19-23), Night (23-07).

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
L_W,i = L_vehicle,i + 10 × log₁₀(Q)
```
where:
- A_rolling from RMR reference spectrum per vehicle type
- v_ref depends on vehicle type (100 km/h passenger, 80 km/h freight, 50 km/h tram)
- Q = trains per day for this vehicle type
- 30 = B_rolling exponent (speed-dependent rolling noise)

### Input priority (current implementation)
Passenger / freight counts:
1. `trains_passenger`, `trains_freight` from Arrow if `> 0`
2. otherwise `default_traffic(rail_type, usage)`

Speed:
1. OSM `maxspeed` if present
2. otherwise `300 km/h` when `highspeed=true`
3. otherwise `default_speed(rail_type)`

Post-adjustments applied even on real counts:
- `service > 0` → counts × **0.02**
- `parallel_divisor > 1` → counts divided by that factor

### Period traffic
Current implementation uses a fixed passenger/freight split for both real and default daily counts:
- day: **65%**
- evening: **20%**
- night: **15%**

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

Current implementation nuance:
- popup / source-reader line-source evaluation uses **path-averaged** `G_path`
- pipeline batch worker currently uses **receiver-local** `G` for both line and point sources

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

### 3.5 Terrain diffraction (ISO 9613-2 §7.3/7.4)
```
δ = path_via_edges - direct_path    [m]

Single edge (§7.3):
A_bar,i = min(20, 10 × log₁₀(3 + 20 × δ × f[i] / 340))

Double edge (§7.4):
C₃ = (1 + (5λ/e)²) / (1/3 + (5λ/e)²)    where e = edge-to-edge distance, λ = 340/f[i]
A_bar,i = min(25, 10 × log₁₀(3 + C₃ × 20 × δ × f[i] / 340))
```
C₃ accounts for thick barriers: 1.0 when edges are far apart, up to 3.0 when close.
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

### 3.7 Vegetation (ISO 9613-2:2024 A.2.2)
```
A_veg,i = min(MAX_VEG_ATTEN[i], α_veg[i] × depth_m)
```
where depth_m = cumulative forest depth along source-receiver path.

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
- **Private road access**: AADT × 0.1
- **Road access=no / motor_vehicle=no**: segment skipped
- **Destination road access**: currently NO reduction
- **Junction**: speed capped at 30 km/h (roundabouts)
- **Service railway** (yard/siding/spur): counts × 0.02
- **Parallel railway ways**: counts divided by `parallel_divisor`
- **Industrial exclusion radius**: R=√(area/π) — buildings within R of source point are not counted as screening (prevents self-screening from source's own footprint)

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
- **Λ**: Lateral attenuation (Eq. 4-18/19), NOT for helicopters
- **ΔF**: Finite segment dipole correction (Eq. 4-20, full α/(1+α²) terms)

### Geometry (§4.4.1)
CPA (Closest Point of Approach) computed on segment EXTENSION (unclamped).
d_p = slant distance at CPA. β = elevation angle.

### Input and preprocessing (current implementation)
- ADS-B supplies real segment geometry, altitude, speed, timestamp, and often `on_ground`
- aircraft `typecode` is mapped to one of **8 proxy NPD profiles**
- unknown / unmapped typecode falls back to **Generic**
- `is_departure` is inferred from median climb rate (`ROCD > 500 fpm`)
- day/evening/night period is approximated from timestamp using **UTC+1**
- airport context uses `airport_lines.arrow` + `airport_areas.arrow`
- candidate airport-ground segments are those with:
  - `on_ground = true`, or
  - both endpoints within **60 m AGL**
- stale ground / taxi remnants are filtered by:
  - `on_ground` with **no airport context**
  - fallback low-AGL test (`<= 15 m AGL`) with **no airport context**

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
  - taxi **2.5 km**
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
| **Ground effect** | CF[i] × G lookup; popup may use path-averaged G, pipeline currently uses receiver-local G | CNOSSOS §2.5.15-18: geometry-dependent Aground with height substitutions, separate source/middle/receiver zones | ±2 dB in complex terrain / mixed ground. |
| **Diffraction** | 10·log₁₀(3 + C₃·20·δ·f/340), caps 20/25 dB, C₃ for double edges | CNOSSOS §2.5.21-23: Rayleigh criterion, C'' convexity factor, ground-barrier interaction | ±3 dB behind barriers. C₃ now implemented; C'' convexity still simplified. |
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
