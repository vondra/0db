---
title: Quiet Map
intro: World noise atlas — find quiet places to live, work, and relax.
map: { center: [15, 30], zoom: 2 }
---

## Mission

Quiet Map shows how loud the world really is — and helps you find the quiet.

1. **Find quiet places** — search any address, explore the map, discover where to live, work, or relax without noise
2. **Understand noise** — see which sources contribute (roads, railways, aircraft, industry) and how terrain, buildings, and forests reduce it
3. **Track change over time** — noise maps updated regularly make noise visible and measurable. By tracking it transparently over time, governments and communities have the data to act — and everyone can see whether things are getting quieter

<!-- MAP -->

## Noise Model

We compute environmental noise using a model **inspired by CNOSSOS-EU** ([Commission Delegated Directive 2021/1226](https://eur-lex.europa.eu/eli/dir_del/2021/1226) · [PDF](../standards/cnossos-eu-2021-1226.pdf)) and **ISO 9613-2** ([ISO](https://www.iso.org/standard/74047.html) · [PDF](../standards/iso-9613-2-2024.pdf)). Emission formulas follow CNOSSOS-EU Annex II–IV. Propagation uses ISO 9613-2 geometric divergence, atmospheric absorption, and diffraction, combined with CNOSSOS-EU ground absorption and meteorological corrections. The noise indicator is **Lden** as defined by [END 2002/49/EC](https://eur-lex.europa.eu/eli/dir/2002/49/oj/eng) ([PDF](../standards/end-2002-49-ec.pdf)). This is an engineering approximation for a continental-scale noise atlas — not a certified implementation of either standard. See [Simplifications](#simplifications) below. Four layers:

### 1. Emission (sources)

Each source stored independently — toggle, attribute, and trend them in the UI.

#### Roads

- **Standard:** CNOSSOS-EU Annex II, 5 vehicle categories
- **Data:** OpenStreetMap (geometry, surface), national traffic census (AADT) — see country pages for specifics
- **Formula:** Rolling + propulsion per octave band, then energy sum

```
L_WR = A_R + B_R × log₁₀(v / 70)     [rolling noise]
L_WP = A_P + B_P × (v - 70) / 70      [propulsion noise]
L_W  = 10 × log₁₀(10^(L_WR/10) + 10^(L_WP/10))
```

<details>
<summary>Road emission coefficients (CNOSSOS-EU, 1 kHz band)</summary>

| Category | Description | A_R | B_R | A_P | B_P |
|----------|-------------|-----|-----|-----|-----|
| Cat 1 | Light vehicles (cars, vans ≤3.5t) | 100.1 | 32.5 | 84.7 | 8.0 |
| Cat 2 | Medium-heavy (buses, 2-axle trucks) | 101.7 | 30.1 | 101.0 | 6.5 |
| Cat 3 | Heavy-duty (3+ axle trucks) | 105.1 | 31.8 | 102.6 | 5.0 |
| Cat 4a | Mopeds ≤50cc | — | — | 97.2 | 15.7 |
| Cat 4b | Motorcycles >50cc | — | — | 95.2 | 11.5 |

Surface corrections (dB, rolling noise): sett +3, cobblestone +4, paving_stones +2, concrete +1, gravel -2, unpaved -3.

</details>

<details>
<summary>Default traffic volumes by road class</summary>

| Road class | AADT | Light | Medium | Heavy | Moto |
|-----------|------|-------|--------|-------|------|
| Motorway | 30,000 | 21,600 | 2,400 | 5,700 | 300 |
| Trunk | 15,000 | 11,700 | 1,200 | 1,800 | 300 |
| Primary | 9,000 | 7,470 | 540 | 810 | 180 |
| Secondary | 3,000 | 2,640 | 120 | 180 | 60 |
| Tertiary | 800 | 720 | 26 | 38 | 16 |
| Residential | 500 | 480 | 5 | 10 | 5 |

</details>

#### Railways

- **Standard:** CNOSSOS-EU Annex IV, RMR (Railway Modelling Reference) methodology
- **Data:** OpenStreetMap (`railway=rail`, `maxspeed` tags)
- **Emission:** Speed-dependent, per octave band — rolling noise + traction noise
- **Coefficients:** [NoiseModelling v5](https://github.com/Universite-Gustave-Eiffel/NoiseModelling) RMR vehicle database (EU reference implementation)

```
L_W,roll(f) = A_R(f) + 30 × log₁₀(v / v_ref)    [rolling noise, speed-dependent]
L_W,traction(f) = A_T(f)                           [traction noise, constant]
L_W(f) = 10 × log₁₀(10^(L_roll/10) + 10^(L_traction/10))
```

<details>
<summary>Railway vehicle categories and RMR mapping</summary>

| Our type | RMR category | v_ref | Brake type | Wheel |
|----------|-------------|-------|-----------|-------|
| Freight corridor | Cat-4 (block-braked freight wagons) | 80 km/h | Cast iron — loudest | 920 mm |
| Passenger | Cat-3 (disc-braked coaches) + Cat-2b (electric loco) | 100 km/h | Disc | 920 mm |
| Tram | Cat-8a (modern EMU, light) | 50 km/h | Disc | 840 mm |
| Light rail / DMU | Cat-6 (diesel multiple unit) | 80 km/h | Disc | 840 mm |

Per-band reference levels derived from CNOSSOS-EU components: wheel roughness (cast iron vs disc brake profiles) × vehicle transfer function × rail roughness (classic ballasted line) × track transfer. Speed correction ≈ 30 dB per speed decade (rolling noise dominant). v_ref in the table is the RMR reference speed for the formula — actual operating speeds (often higher) are used in the calculation.

Finite-line correction: `10 × log₁₀((2/π) × atan(segLen / (2 × dist)))`.
Time-of-day: evening -3 dB, night -8 dB.
Favourable conditions boost (CNOSSOS §2.5.21): `P_FAV = 0.5` (Central Europe).

</details>

#### Aircraft

- **Inspired by:** [ECAC Doc 29](https://www.ecac-ceac.org/activities/environment/european-aviation-and-environment-working-group-eaeg/airmod) ([Vol 1](../standards/ecac-doc-29-vol1.pdf) · [Vol 2](../standards/ecac-doc-29-vol2.pdf) · [Vol 3](../standards/ecac-doc-29-vol3.pdf)). NPD (Noise-Power-Distance) methodology with per-flight ADS-B trajectories — not a certified Doc 29 implementation
- **Data:** ADS-B trajectories from [adsb.lol](https://adsb.lol) (full year, all altitudes including cruise)
- **NPD profiles:** 8 proxy profiles (B738, A320, A321, Widebody, Turboprop, BizJet, LightGA, Generic) approximating [ANP database](https://www.easa.europa.eu/en/domains/environment/policy-support-and-research/aircraft-noise-and-performance-anp-data) trends. Not the official ANP values — no power/configuration axis, approach and departure energy-averaged 50/50 when flight phase is unknown
- **Segment processing:** ADS-B points merged into segments (~1–20 km). Per-segment: SRTM terrain elevation for AGL altitude, NPD SEL lookup, ΔV speed correction (Doc 29 §4.5.1)
- **Tile pipeline:** Energy deposited at segment midpoint hex only. No receiver-side lateral propagation — corridor width on map is narrower than real-world noise contours. Lateral spread will be added in a future update
- **Popup:** Computes lateral propagation in real time via slant_distance = sqrt(lateral² + altitude²)
- **Missing Doc 29 corrections:** ΔI engine installation effect, Λ lateral attenuation, ΔF finite-segment correction, ground-roll segments (on_ground filtered out, AGL clamped to min 100 ft)
- **Lden:** Per-period (day 12h, evening 4h +5 dB, night 8h +10 dB), standard END 2002/49/EC formula

<details>
<summary>Aircraft NPD proxy profiles (SEL in dB at standard distances)</summary>

Distances: 200, 400, 630, 1000, 2000, 4000, 6310, 10000, 16000, 25000 ft. Values beyond 25,000 ft extrapolated using boundary slope.

| Type | Example | Approach SEL (200–25000 ft) |
|------|---------|----------------------------|
| Narrowbody | B738 | 104, 99, 95, 91, 84, 77, 72, 66, 60, 54 |
| Narrowbody | A320 | 103, 98, 94, 90, 83, 76, 71, 65, 59, 53 |
| Widebody | B777/A330 | 108, 103, 99, 95, 88, 81, 76, 70, 64, 58 |
| Turboprop | ATR/L410 | 96, 91, 87, 83, 76, 69, 64, 58, 52, 46 |
| Business jet | CRJ/Citation | 99, 94, 90, 86, 79, 72, 67, 61, 55, 49 |
| Light GA | Cessna 172 | 88, 83, 79, 75, 68, 61, 56, 50, 44, 38 |

These are project approximations, not official ANP data. The 50/50 approach/departure energy average biases approach +2.4 dB and departure -1.6 dB.

</details>

#### Industrial

- **Standard:** ISO 8297, CNOSSOS-EU §2.4
- **Data:** OpenStreetMap industrial/commercial landuse, enriched with [IRZ](https://www.irz.cz/) (Czech Integrated Pollution Register) NACE sector codes for ~3,000 regulated facilities
- **Formula:** `L_site = base_sector + 10 × log₁₀(area / 10000)`
- **Emission library:** 21 NACE sector profiles + 17 OSM sub-type profiles, each with sector-specific base level, octave spectrum, and day/evening/night temporal profile
- **Calibration:** Initial values from [EU Directive 2000/14/EC](https://eur-lex.europa.eu/eli/dir/2000/14/oj/eng) equipment limits, [3M Noise Navigator](https://multimedia.3m.com/mws/media/888553O/noise-navigator-sound-level-hearing-protection-database.pdf) measurements, and academic studies; calibrated against SHM 2022 industrial contours
- **Confidence levels:** Each emission entry is tagged `measured`, `literature`, or `estimate` with citation

<details>
<summary>Industrial emission levels by sector (NACE-based)</summary>

| Sector | NACE | Base level | Evening | Night | Spectrum | Source |
|--------|------|-----------|---------|-------|----------|--------|
| Metallurgy | 24 | 72 dB | -2 | -4 | Low-freq heavy | EU 2000/14 + area scaling |
| Cement/glass/minerals | 23 | 70 dB | -2 | -4 | Low-freq heavy | FHWA RCNM |
| Chemical industry | 20 | 65 dB | -2 | -4 | Mechanical | 3M Navigator |
| Metal fabrication | 25 | 65 dB | -5 | -10 | Mechanical | 3M Navigator |
| Motor vehicles | 29 | 65 dB | -5 | -12 | Mechanical | 3M Navigator |
| Power generation | 35 | 65 dB | -1 | -2 | Low-freq heavy | 3M Navigator (24/7) |
| Waste/recycling | 38 | 68 dB | -3 | -8 | Broadband | 3M Navigator |
| Mining/quarrying | 08 | 70 dB | -8 | -20 | Broadband | EU 2000/14 + FHWA |
| Wastewater | 37 | 58 dB | 0 | -2 | Mechanical | Academic study (measured) |
| Food processing | 10 | 58 dB | -5 | -12 | Mechanical | 3M Navigator |
| Warehousing | 52 | 52 dB | -3 | -8 | Commercial | Estimate (trucks as roads) |
| Retail trade | 47 | 50 dB | -8 | -20 | Commercial | Estimate (HVAC + loading) |
| Generic industrial | — | 60 dB | -5 | -15 | Mechanical | Baseline |

Reference area: 10,000 m². A 100,000 m² factory emits 10 dB more than its base level.

</details>

#### Wind Turbines

- **Standard:** IEC 61400-11
- **Data:** OpenStreetMap (`generator:source=wind`, `man_made=wind_turbine`) — ~260 turbines in CZ with hub height and rated power metadata
- **Emission:** Literature-based Lw by rated power class (98–107 dB LwA)
- **Spectrum:** `[-2, -1, 0, +1, +1, 0, -2, -5]` (broadband, slight mid-frequency emphasis)
- **Propagation:** Elevated point source (hub height from OSM, default 80 m), full ISO 9613-2
- **Period:** 0 / 0 / 0 (continuous 24/7 when wind blows)

#### Settlements (building noise)

Noise from everyday building activity — HVAC systems, human activity through windows, children in playgrounds, commercial operations. Each building is an individual noise source classified by its OSM type. Excludes transport and industry (modelled separately).

- **Model:** Per-building acoustic capacity (project estimate, not a CNOSSOS-EU standard source). Two-component Lw: fixed sources (HVAC unit, delivery bay) + distributed sources scaling with floor area.
- **Data:** OpenStreetMap buildings — 5M+ polygon footprints with type, height, floors, area, and addresses (via spatial join with OSM addr nodes)
- **Classification:** 11 building classes from OSM tags (`building=*`, `amenity=*`, `shop=*`)
- **Propagation:** Full ISO 9613-2 model (terrain, buildings, vegetation, ground) — same as road/railway
- **Detail popup:** Click shows individual buildings with name/address, type, emission level, polygon highlight

<details>
<summary>Building emission classes</summary>

Formula: `Lw = 10 × log₁₀(10^(Lw_fixed/10) + GFA × 10^(Lw_per_m²/10))`

| Class | OSM tags | Lw fixed | Lw/m² | Evening | Night |
|-------|----------|----------|-------|---------|-------|
| Apartment | apartments, dormitory | 35 dB | 18 | -3 | -10 |
| House | house, detached | 33 dB | 12 | -5 | -15 |
| Commercial | commercial, retail | 65 dB | 35 | -10 | -15 |
| School | school, kindergarten | 70 dB | 28 | -15 | -25 |
| Hospital | hospital, clinic | 65 dB | 35 | -3 | -5 |
| Restaurant | restaurant, bar, pub | 62 dB | 35 | +3 | -10 |
| Church | church, chapel | 50 dB | 20 | -5 | -20 |
| Public | civic, office | 58 dB | 30 | -10 | -15 |
| Garage | garage, parking | 30 dB | 18 | -5 | -15 |

Industrial/warehouse buildings excluded — handled by the industrial pipeline with NACE-specific emission data.

Sources: [EU Reg 626/2011](https://eur-lex.europa.eu/eli/reg_del/2011/626/oj/eng) (residential AC units 58–67 dB Lw), [ASHRAE Handbook Ch.48](https://www.ashrae.org/) (HVAC Lw vs capacity), [VDI 2571](https://www.vdi.de/) (facade breakout), [BS 4142:2014](https://www.bsi-global.com/) (commercial noise assessment), [EHPA/AVTČ](https://www.ehpa.org/) (CZ 2025: ~25% heat pump penetration).

</details>

---

### 2. Propagation (source → receiver)

**Standards:** [ISO 9613-2:2024](https://www.iso.org/standard/74047.html) ([PDF](../standards/iso-9613-2-2024.pdf)), [CNOSSOS-EU §2.5](https://eur-lex.europa.eu/eli/dir_del/2021/1226) ([PDF](../standards/cnossos-eu-2021-1226.pdf)). Computed per 8 octave bands (63–8000 Hz), then A-weighted.

**A-weighting:** `[-26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1]` dB

All ground sources (road, railway, industrial, settlement) use the same per-band propagation engine (ISO 9613-2 + CNOSSOS-EU). Aircraft uses NPD tables where atmospheric absorption is already included — no separate ISO 9613-2 propagation is applied. The tile pipeline deposits aircraft noise at segment midpoints only; the popup route computes slant-distance propagation to receivers in real time.

| Factor | Standard | Method | Toggleable |
|--------|----------|--------|-----------|
| Geometric divergence | ISO 9613-2 | Line: 10×log₁₀(d/d₀), Point: 20×log₁₀(d/d₀) | No (baseline) |
| Atmospheric absorption | ISO 9613-1 | Per-band α (temperature 15°C, humidity 70% RH) | No (baseline) |
| Ground effect | CNOSSOS-EU §2.5.15 | G-factor from Copernicus IMD raster (imperviousness → G) | No (baseline) |
| Terrain diffraction | ISO 9613-2 §7.4 | DEM elevation profile, path difference δ, max 20/25 dB | Yes |
| Building screening | ISO 9613-2 §7.4 | Per-band diffraction using max building height along path | Yes |
| Vegetation | ISO 9613-2 Annex A.2.2 | Forest depth along path × per-band α, max 15 dB | Yes |
| Noise barriers | ISO 9613-2 | Barrier height injected into terrain profile | Included in terrain |
| Favourable conditions | CNOSSOS-EU §2.5.21 | P_FAV = 0.5, energy boost for long-distance propagation | No (climate) |
| Urban reflections | ISO 9613-2 §7.5 | Building enclosure around receiver → +0–5 dB | No (baseline) |

<details>
<summary>Atmospheric absorption coefficients (dB/km)</summary>

ISO 9613-1, standard atmosphere (15°C, 70% RH, 101.325 kPa):

| 63 Hz | 125 Hz | 250 Hz | 500 Hz | 1 kHz | 2 kHz | 4 kHz | 8 kHz |
|-------|--------|--------|--------|-------|-------|-------|-------|
| 0.1 | 0.4 | 1.0 | 1.9 | 3.7 | 8.7 | 22.0 | 58.4 |

</details>

<details>
<summary>Terrain diffraction formula (ISO 9613-2 §7.4)</summary>

DEM profile sampled between source and receiver (h=4.0 m). Source heights:
- **Line sources** (road, rail): h=0.5 m (ISO 9613-2 convention; CNOSSOS-EU specifies 0.05 m for rolling noise — our value reduces barrier screening by ~2–3 dB)
- **Point sources** (industrial, settlement, wind turbine): actual structure height (roof, stack, hub) elevated into terrain profile before computing diffraction

Single and double diffraction supported.

```
δ = d_source_barrier + d_barrier_receiver - d_direct  [path difference]
A_bar = 10 × log₁₀(3 + 20 × δ × f / 340)           [per frequency]
```

Max 20 dB for single diffraction, 25 dB for double (two distinct edges).
Noise barriers are injected into the DEM profile before computing diffraction.

</details>

<details>
<summary>Building screening (ISO 9613-2 §7.4)</summary>

Buildings act as barriers. Max building height along source→receiver path used to compute diffraction path difference:

```
h_eff = building_height - line_of_sight_height
δ = 2 × sqrt((d/2)² + h_eff²) - d
A_screen[i] = 10 × log₁₀(3 + 20 × δ × f[i] / 340)  [per band, max 20 dB single / 25 dB double]
```

Effect: low frequencies (63 Hz) ~3 dB screening, high frequencies (8 kHz) ~15–20 dB.
Building reflections (ISO 9613-2 §7.5) are also included in the Screening toggle: disabling it removes both barrier diffraction and urban canyon reflection.

</details>

<details>
<summary>Vegetation attenuation (ISO 9613-2 Annex A.2.2)</summary>

Forest depth measured by sampling forest cover raster along propagation path.

| 63 Hz | 125 Hz | 250 Hz | 500 Hz | 1 kHz | 2 kHz | 4 kHz | 8 kHz |
|-------|--------|--------|--------|-------|-------|-------|-------|
| 0.02 | 0.03 | 0.04 | 0.05 | 0.06 | 0.08 | 0.09 | 0.12 dB/m |

Example: 100m of forest → 2 dB at 63 Hz, 6 dB at 1 kHz, 12 dB at 8 kHz. Max 15 dB per band.

</details>

<details>
<summary>Ground G-factor (CNOSSOS-EU §2.5.15)</summary>

G = 0 (hard: asphalt, water) to G = 1 (soft: grass, forest floor). Derived from Copernicus IMD raster: `G = 1 - IMD/100`. Soft ground absorbs 2–5 dB at mid-frequencies (250–500 Hz). Hard ground can add 1–2 dB constructive interference at low frequencies.

</details>

<details>
<summary>Urban reflections (ISO 9613-2 §7.5, simplified)</summary>

Sound reflects off building facades, increasing noise in urban areas. Enclosure detection: sample building height raster in 8 directions around receiver at ~20m radius.

| Enclosure | Boost |
|-----------|-------|
| Open field | 0 dB |
| One building nearby | 0.5 dB |
| One side of street | 1.5 dB |
| Street canyon | 3 dB |
| Semi-enclosed courtyard | 4 dB |
| Fully enclosed courtyard | 5 dB |

</details>

<details>
<summary>Favourable meteorological conditions (CNOSSOS-EU §2.5.21)</summary>

Central European climate: P_FAV = 0.5 probability of downwind or temperature-inversion conditions that enhance long-distance propagation. Applied as energy boost ramping 0→3 dB over 50→350m distance.

</details>

<details>
<summary>Propagation ranges</summary>

Maximum propagation distance per source, sized so noise is tracked down to 10 dB (near silence). Hard caps prevent excessive computation; dynamic distances are computed from emission level + geometric divergence + atmospheric absorption at 1 kHz.

| Source | Geometry | Typical emission | Max range |
|--------|----------|-----------------|-----------|
| Motorway | Line (10·log) | 80 dB @ 15m | 10 km (cap) |
| Trunk road | Line | 73 dB | 7 km (cap) |
| Primary road | Line | 69 dB | 5 km (cap) |
| Secondary road | Line | 62 dB | 5 km (cap) |
| Tertiary road | Line | 55 dB | 4 km (cap) |
| Residential road | Line | ~50 dB | 3 km (cap) |
| Living street | Line | ~45 dB | 2 km (cap) |
| High-speed railway | Line | 78 dB | up to 10 km |
| Regional railway | Line | 65 dB | up to 10 km |
| Tram / light rail | Line | 62 dB | 5 km (cap) |
| Steelworks (NACE 24) | Point (20·log) | 72 dB @ 100m | up to 5 km |
| Quarry (NACE 08) | Point | 70 dB @ 100m | up to 5 km |
| Generic factory | Point | 63 dB @ 100m | up to 5 km |
| Warehouse | Point | 52 dB @ 100m | up to 5 km |
| Wind turbine | Point (elevated) | 103 dB @ hub | up to 5 km |
| Settlement building | Point | 20–70 dB @ 15m | up to 2 km |
| Aircraft | NPD | SEL 91 dB | 5–8 km lateral |

10 dB minimum threshold — all noise above ~10 dB is included, filling gaps between sources that were invisible at the previous 25 dB threshold.

</details>

---

### 3. Immission (where you hear it)

- **Grid:** [H3](https://h3geo.org/) hexagonal, resolution 11 (24 m edge) — can distinguish street-facing vs garden side of a building for ground sources with full propagation; aircraft spatial resolution is currently lower (segment midpoint deposit)
- **Aggregation:** res-10, res-9, res-8 for lower zoom levels
- **Per-source** contributions stored independently (toggle in UI)
- **Note:** H3 hex noise represents the area-average level, not the most-exposed-facade value. END requires facade receivers (4 m height, 2 m from wall) for regulatory noise maps — this atlas uses grid-based assessment suitable for overview and exploration, not building-specific compliance
- **Rendering:** [deck.gl](https://deck.gl/) H3HexagonLayer + [MapLibre GL](https://maplibre.org/) + [CARTO Positron](https://carto.com/basemaps/) basemap
- **Propagation toggles:** Terrain, Screening (buildings + reflection), Vegetation — each can be toggled off to see noise without that attenuation effect
- **Routing:** [Valhalla](https://github.com/valhalla/valhalla) isochron engine for travel time areas
- **Color scale:** green (10 dB, near silence) → yellow → orange → red (80 dB, very loud)

**Lden formula** ([END 2002/49/EC](https://eur-lex.europa.eu/eli/dir/2002/49/oj/eng) · [PDF](../standards/end-2002-49-ec.pdf)):

```
Lden = 10 × log₁₀((1/24) × (12 × 10^(Ld/10) + 4 × 10^((Le+5)/10) + 8 × 10^((Ln+10)/10)))
```

Day: 07:00–19:00, evening: 19:00–23:00 (+5 dB penalty), night: 23:00–07:00 (+10 dB penalty).

---

### 4. Validation

- **Reference:** National strategic noise maps (see country pages for specifics)
- **Methodology:** [WG-AEN Good Practice Guide](https://sicaweb.cedex.es/docs/documentacion/Good-Practice-Guide-for-Strategic-Noise-Mapping.pdf) ([PDF](../standards/wg-aen-good-practice-guide.pdf)), [EPA Ireland Guide v4](https://www.epa.ie/publications/monitoring--assessment/noise/) ([PDF](../standards/epa-ireland-noise-mapping-guide-2025.pdf))
- **Target:** MAE < 3 dB, broken down by road class and distance band
- **[WHO Guidelines 2018](https://www.who.int/europe/publications/i/item/9789289053563):** road < 53 dB, rail < 54 dB, aircraft < 45 dB Lden

---

## Real estate overlay

The map can display real estate listings filtered by noise level.
Each country has its own data sources — see individual country pages.

- Properties are geocoded to H3 hex cells and joined with noise data
- Default filter: show only properties below 45 dB Lden (WHO outdoor guideline)
- Data refreshed twice daily via cron
- Focus: land plots (pozemky) — building plots, forests, meadows, gardens

---

## Simplifications

This model is an engineering approximation. Key simplifications compared to full CNOSSOS-EU / ISO 9613-2:

| Area | Standard says | We do | Impact |
|------|-------------|-------|--------|
| Propagation model | CNOSSOS-EU: separate homogeneous + favourable conditions, mix with P_FAV | ISO 9613-2 baseline + P_FAV energy boost (0–3 dB) as post-hoc correction | ±1–2 dB at distances >350 m |
| Source height (roads) | CNOSSOS-EU: 0.05 m (rolling) / 0.30 m (propulsion) | 0.5 m (ISO 9613-2 convention) | Behind barriers: ~2–3 dB less screening |
| Source height (point) | Actual structure height | Actual height from data (roof, stack, hub) elevated into terrain profile | Correct — elevated sources see less terrain screening |
| Terrain profile | Professional SW: 5–10 m spacing | Adaptive 30 m spacing (8–50 points) | May miss narrow barriers (<30 m wide) |
| Aircraft lateral atten. | Doc 29 §4.5.4: Λ(β,l) lateral + ΔI engine installation | Slant distance NPD only (no Λ or ΔI correction) | 2–4 dB underestimate at large lateral angles |
| Aircraft spatial model | Doc 29 §4.3: receiver-side summation of finite segments (ΔF) | Segment midpoint deposited into one 24m hex | Map corridors narrower than real contours |
| Aircraft ground roll | Doc 29 §3.6.2: takeoff roll segments at TOGA thrust | Excluded (on_ground filter); AGL clamped to 100 ft min | Near-runway noise underestimated ~5–10 dB |
| Aircraft flight phase | Doc 29: separate approach/departure NPD per power setting | 50/50 energy average when phase unknown | Approach +2.4 dB, departure -1.6 dB bias |
| Receiver grid | END: facade receivers (4 m height, 2 m from wall) | H3 res-11 hex centers (24 m edge, 4 m height) | Area average, not per-facade |
| Road corrections | CNOSSOS-EU: gradient, intersection, temperature | Not implemented | ±1–3 dB on steep/cold roads |
| Building reflections | ISO 9613-2 §7.5: image-source ray tracing | Simplified: 8-direction enclosure, 0–5 dB boost | May underestimate in complex geometries |
| Settlement noise | Not standardised (END covers road/rail/aircraft/industry only) | Custom per-building acoustic capacity model, 11 OSM building classes | Novel — no standard reference values for residential/commercial building emission |
| Atmospheric conditions | Variable: temperature, humidity, wind speed | Fixed: 15°C, 70% RH, P_FAV=0.5 | Seasonal/hourly variation not captured |

Despite these simplifications, the model achieves MAE < 3 dB against national strategic noise maps for road noise (see country validation pages). Aircraft noise has not yet been formally validated — the current implementation is an experimental corridor proxy, not a Doc 29-compliant contour model.

---

## What we measure

Human-made noise is not the same as natural sound. A forest at 50 dB with birdsong feels quiet. A road at 50 dB with traffic feels loud. Quiet Map measures environmental noise from human sources — transport, industry, and urban activity — not nature.

---

Quiet Map is an open-source project. All computations are transparent and reproducible from public data.

## Attribution

- **Base map:** © [CARTO](https://carto.com/about-carto/), © [OpenStreetMap](https://www.openstreetmap.org/about/) contributors
- **Terrain basemap:** © [OpenTopoMap](https://opentopomap.org/)
- **Satellite imagery:** © [Esri](https://www.esri.com/), Maxar, Earthstar Geographics
- **Elevation data:** [SRTM](https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-shuttle-radar-topography-mission-srtm-1) (NASA/USGS, public domain)
- **Road & railway data:** © [OpenStreetMap](https://www.openstreetmap.org/) contributors (ODbL)
- **Flight data:** [adsb.lol](https://adsb.lol/) (ADS-B community feeds)
- **Map rendering:** [MapLibre GL JS](https://maplibre.org/) (open source)
