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
max: 15 dB per band
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

### Propulsion noise per band
```
L_WP,i = A_P,i + B_P,i × (v - v_ref) / v_ref
```
Coefficients A_P, B_P from CNOSSOS-EU Table 2.3.b.

### Surface correction (CNOSSOS-EU §2.4.8)
```
L_WR,i += ΔL_WR    (applied to rolling noise only, per band)
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

### Period traffic
Day (07-19), Evening (19-23), Night (23-07). Traffic flow Q differs per period:
- From census: actual day/evening/night split
- Default: TIME_DIST_MOTORWAY or TIME_DIST_URBAN ratios

---

## 2. Railway Emission (CNOSSOS-EU Annex IV / RMR)

### Source height
h_s = 0.5 m (wheel-rail contact)

### Emission per band
```
L_W,i = A_rolling,i + 30 × log₁₀(v / v_ref) + 10 × log₁₀(Q)
```
where:
- A_rolling from RMR reference spectrum per vehicle type
- v_ref depends on vehicle type (100 km/h passenger, 80 km/h freight, 50 km/h tram)
- Q = trains per day for this vehicle type
- 30 = B_rolling exponent (speed-dependent rolling noise)

### Period traffic
True per-period: separate passenger/freight counts × period distribution.
NOT fixed -3/-8 dB offsets.

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
G = path-averaged ground factor (from IMD raster). G=0 hard, G=1 soft.

With barrier (CNOSSOS-EU §2.5.21-22): ground effect fades linearly as diffraction increases.

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
δ = path_via_edge - direct_path    [m]

Single edge:
A_bar,i = min(20, 10 × log₁₀(3 + 20 × δ × f[i] / 340))

Double edge:
A_bar,i = min(25, 10 × log₁₀(3 + 20 × δ × f[i] / 340))
```
Terrain profile sampled from DEM (Copernicus GLO-30 primary, SRTM fallback). Receiver at **4.0m** above ground.

### 3.6 Building screening (ISO 9613-2, per-band)
Same diffraction formula as terrain. Samples building height at ~30m steps along entire source-receiver path (not just midpoint).
```
δ_bld = max building height along path - direct LOS height at that point
A_screen,i = min(10, 10 × log₁₀(3 + 20 × δ_bld × f[i] / 340))
```

### 3.7 Vegetation (ISO 9613-2:2024 A.2.2)
```
A_veg,i = min(15, α_veg[i] × depth_m)
```
where depth_m = cumulative forest depth along source-receiver path.

### 3.8 Urban reflection (ISO 9613-2 §7.5)
Per-RECEIVER boost based on building enclosure:
```
A_refl = -(number_of_enclosed_directions × 1.5)    [dB, max -5]
```
Sampled from building height raster in 8 directions around receiver.
Applied ONCE per receiver, not per source-receiver path.

### 3.9 Favourable meteorological conditions (CNOSSOS-EU §2.5.21)
```
boost = min(3, max(0, (d - 50) × 0.01))    [dB]
multiplier = P_FAV × 10^(boost/10) + (1 - P_FAV)
where P_FAV = 0.5 (Central Europe default)
```

### 3.10 Total received level per band
```
L_received,i = L_emission,i - A_div,i - A_atm,i - A_ground,i - A_bar,i - A_screen,i - A_veg,i + A_refl + FLC
```

### 3.11 A-weighted total
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

## 5. Aircraft (Doc 29 4th Edition)

SEPARATE from ISO 9613-2. Doc 29 is empirical NPD-based, not path-tracing.

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

### Per-flight energy
```
E_flight = Σ_segments 10^(SEL_seg / 10)
```

### Per-period Leq (§5, Eq. 5-1)
```
Leq_period = 10 × log₁₀(E_period / (n_days × T_period))
T_day = 43200s, T_evening = 14400s, T_night = 28800s
```

### Octave bands
❌ BROADBAND ONLY. NPD returns single SEL value. Do not fabricate per-band data.

---

## 6. Industrial Emission

### Source geometry
Receives PRE-DISCRETIZED point sources. Discretization done at import:
- Small (<10K m²): centroid
- Large open (quarry): interior grid (N = area/5000, max 200)
- Large enclosed (factory): perimeter (25m spacing) + interior
- Energy split: Lw_per_point = Lw_total - 10×log₁₀(N_points)

### Emission
```
Lw = baseLw + 10 × log₁₀(min(area_m², 500000) / 10000)
```
baseLw from NACE code profile (calibrated against Czech SHM 2022):
- Heavy industry (cement, steel, power): 99-100 dB
- Medium industry (chemical, food): 88-95 dB
- Light industry (warehouse, commercial): 70-86 dB
Area scaling capped at 50 ha (500,000 m²) to prevent OSM polygon artifacts.

### Source height
- Heavy industry (NACE 8/23/24/35): 10m
- Other industrial: 5m
- Wind turbine: hub_height

### Wind turbines (IEC 61400-11)
```
Lw = rating_lookup(rated_power_kw)    [98-107 dB by power class]
```
Spectrum: [-2, -1, 0, 1, 1, 0, -2, -5] dB relative to broadband.

### Propagation
ISO 9613-2 point source (same as roads but with point-source divergence).

---

## 7. Settlement (buildings)

### Source geometry
PRE-DISCRETIZED at import. Small buildings = centroid. Large = facade points.

### Emission (custom model, NOT standardized)
```
Lw = 10 × log₁₀(10^(Lw_fixed/10) + GFA × 10^(Lw_per_m²/10))
where GFA = area_m² × floors
```
11 building classes: residential, commercial, school, hospital, etc.
Spectral shapes: HVAC_DOMINANT, HUMAN_ACTIVITY, MIXED_URBAN, BROADBAND.

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
| **Surface correction** | One scalar ΔL_WR per surface type | CNOSSOS Table F-4: per-band αm + βm, speed-dependent | ±1 dB. Our scalars are band-averaged approximations. |
| **Ground effect** | CF[i] × G lookup | CNOSSOS §2.5.15-18: geometry-dependent Aground with height substitutions, separate source/middle/receiver zones | ±2 dB in complex terrain. Our CF model matches NoiseModelling v5 simplification. |
| **Diffraction** | 10·log₁₀(3 + 20·δ·f/340), caps 20/25 dB | CNOSSOS §2.5.21-23: Rayleigh criterion, C'' convexity factor, ground-barrier interaction | ±3 dB behind barriers. We over-simplify barrier+ground interaction. |
| **Building screening** | Max building height along path → per-band diffraction | ISO 9613-2: explicit obstacle modelling per edge | ±3 dB in complex urban. Our approach samples raster, not individual building edges. |
| **Urban reflection** | Per-receiver enclosure boost +0-5 dB | ISO 9613-2 §7.5: image-source reflection model | ±2 dB. Standard requires full reflection geometry, we use heuristic. |
| **Meteorology** | P_FAV=0.5 energy boost formula | ISO 9613-2: Cmet = C₀(1 - 10·h_s/r), subtracted from downwind | ±2 dB at long range. Both are approximations of wind/gradient effects. |
| **Road categories** | 4 categories (no 4a mopeds, no 5) | CNOSSOS: 5 categories (4a, 4b, 5) | <0.5 dB. Mopeds rare, cat 5 is open. |
| **Railway emission** | Simplified RMR (one rolling spectrum per type) | CNOSSOS Annex IV: component-based (roughness, transfer function per rail/wheel type) | ±2 dB. We use aggregate reference spectra, not full component model. |
| **Receiver height** | 4.0m (END facade) | END: 4.0m (facade). ISO: variable. | Matches END standard. |
| **Aircraft NPD** | 8 proxy profiles | Doc 29: official ANP database | ±3 dB per aircraft type. We approximate, not certify. |
