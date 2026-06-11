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

---

## How the map works

The map computes environmental noise in three steps:

1. **Sources emit noise** — roads, trains, planes, factories, wind turbines, and buildings all produce sound. We model each one using real data: traffic counts, flight tracks, building types, and industrial classifications from OpenStreetMap and national registries.

2. **Sound travels and fades** — noise gets quieter with distance. Hills block it, buildings screen it, forests absorb it. We simulate this physics for every source-receiver pair using ISO 9613-2 propagation with 8 octave bands.

3. **You see the result** — the map shows noise at every ~12-meter raster cell, colored from green (quiet, ~10 dB) through yellow and orange to red and purple (very loud, 80+ dB). Each source layer is independent — toggle them to see roads alone, railways alone, or everything combined.

![Quiet Map — noise visualization](map-overview.jpg)

<!-- MAP -->

---

## Five noise layers

Each source is modelled independently — toggle, compare, and explore them in the UI.

### Roads

Road traffic is the dominant source of environmental noise, affecting 60–80% of exposed population in most countries. We model each road segment using the European CNOSSOS-EU standard with 4 vehicle categories (light vehicles, medium trucks, heavy trucks, motorcycles) and compute rolling noise + propulsion noise per octave band.

- **Data:** OpenStreetMap geometry + measured/enriched traffic counts where available; otherwise class-based defaults (see country pages)
- **Key variables:** traffic volume (AADT), vehicle mix (especially heavy vehicle share), speed, road surface
- **Impact:** Doubling traffic = +3 dB. One truck is as loud as ~10 cars. Surface type shifts noise by up to 4 dB.

<details>
<summary>Technical: road emission (CNOSSOS-EU Annex II)</summary>

[CNOSSOS-EU Annex II](../standards/cnossos-eu-2021-1226.pdf), 4 vehicle categories (light / medium-heavy / heavy / motorcycles) per 8 octave bands (63–8000 Hz). Rolling + propulsion components combined per band; line-source density `L_W'/m = L_W + 10·log₁₀(Q/(1000·v))`. Surface correction applied to rolling: asphalt 0 / cobblestone +4 / concrete +1 / unpaved +2 dB.

**Default traffic volumes** (when no census data available):

| Road class | Total AADT | Light | Medium | Heavy | Moto | Speed | Time split |
|-----------|-----------|-------|--------|-------|------|-------|------------|
| Motorway | 30 000 | 21 600 | 2 400 | 5 700 | 300 | 100 km/h | 65/20/15% |
| Trunk | 15 000 | 11 700 | 1 200 | 1 800 | 300 | 70 km/h | 65/20/15% |
| Primary | 9 000 | 7 470 | 540 | 810 | 180 | 50 km/h | 70/18/12% |
| Secondary | 3 000 | 2 640 | 120 | 180 | 60 | 50 km/h | 70/18/12% |
| Tertiary | 800 | 720 | 26 | 38 | 16 | 50 km/h | 70/18/12% |
| Residential | 500 | 480 | 5 | 10 | 5 | 30 km/h | 70/18/12% |
| Living street | 100 | 98 | 0 | 1 | 1 | 20 km/h | 70/18/12% |

Time split = day (07–19) / evening (19–23) / night (23–07). Measured AADT overrides the totals; the per-period split stays fixed by class.

→ Full derivation, all coefficients: `engine/noise-compute/SPEC.md` §1.

</details>

### Railways

Rail noise affects fewer people than roads but at higher severity — a single freight corridor can dominate nighttime exposure for kilometres. Freight wagons with cast-iron block brakes are ~10 dB louder than disc-braked passenger stock, making the passenger/freight split critical.

- **Data:** OpenStreetMap rail geometry + precomputed passenger/freight counts where available; otherwise line-type defaults (see country pages)
- **Key variables:** train count per day, passenger vs freight split, speed
- **Impact:** Speed enters as 30×log₁₀ — twice the sensitivity of roads. One freight train at night can outweigh 10 daytime passenger trains in Lden.

<details>
<summary>Technical: railway emission (CNOSSOS-EU Annex IV / RMR)</summary>

[CNOSSOS-EU Annex IV](../standards/cnossos-eu-2021-1226.pdf) RMR methodology. Per-band rolling (speed-dependent, `30·log₁₀(v/v_ref)`) + constant traction. Line density expressed per-hour, not per-day. Four vehicle types: Passenger (disc brake, v_ref 100 km/h), Freight (cast iron, v_ref 80 km/h — ~10 dB louder), Tram (50 km/h), Light rail / DMU (80 km/h). HSR > 200 km/h uses the same passenger spectrum scaled by speed — no dedicated aerodynamic model.

**Default train frequencies** (when no line counts available):

| Line type | Pass/day | Freight/day | Default speed |
|-----------|---------:|------------:|---------------|
| Main line | 80 | 20 | 80 km/h |
| Branch | 30 | 5 | 80 km/h |
| Industrial siding | 0 | 15 | 80 km/h |
| Rail, unknown usage | 40 | 10 | 80 km/h |
| Tram | 120 | 0 | 40 km/h |
| Light rail | 80 | 0 | 60 km/h |
| Narrow gauge | 10 | 0 | 40 km/h |
| Funicular | 40 | 0 | 20 km/h |

Measured counts override defaults; the 65/20/15 day/eve/night split stays fixed by class. Source height 0.5 m (wheel-rail contact).

→ Full derivation, coefficients, simplifications: `engine/noise-compute/SPEC.md` §2.

</details>

### Aircraft

The aircraft layer combines two models: airborne overflights from ADS-B radar trajectories, processed through NPD (Noise-Power-Distance) profiles inspired by ECAC Doc 29, and airport ground operations (runway roll, taxi, apron movement) extracted directly from low-altitude / on-ground ADS-B trajectories with the nearest mapped aerodrome attached for identity. The map shows everything together; the popup splits aircraft into three tabs — ground paths, airborne sub-segments, and cruise hexes.

- **Data:** ADS-B trajectories from [adsb.lol](https://adsb.lol) (full year, all altitudes) + OSM aeroway lines (runways / taxiways) and aerodrome polygons. ADS-B ground legs project onto OSM microsegments to derive per-microsegment movements.
- **Per-typecode aircraft profiles** auto-generated from EASA ANP v2.3 (Aircraft Noise and Performance database) — covers Boeing 737/747/757/767/777/787, Airbus A319/A320/A321/A330/A340/A350/A380, Embraer E-Jets, ATR, Dash 8, plus light GA and helicopter placeholders for types not in ANP.
- **Limitations:** Most modern jets (737 MAX, A320neo, A321neo) have dedicated profiles from EASA ANP v2.3 + supplementary v9 sources; less-common variants fall back to a similarity-based mapping by engine type and size class. Ground ops show what ADS-B observed — no synthetic backfill, so movements outside the receiver coverage don't appear. Day/evening/night periods are derived from the segment-midpoint coordinate using an IANA timezone database (DST-aware). Atlas-scale patterns, not certified airport contouring.

<details>
<summary>Technical: aircraft layer (Doc 29 + airport ground ops)</summary>

**Airborne** [ECAC Doc 29](https://www.ecac-ceac.org/activities/environment/european-aviation-and-environment-working-group-eaeg/airmod) ([Vol 1](../standards/ecac-doc-29-vol1.pdf) · [Vol 2](../standards/ecac-doc-29-vol2.pdf) · [Vol 3](../standards/ecac-doc-29-vol3.pdf)). Not certified. Per-segment SEL combines NPD lookup at slant distance + speed correction + engine-installation directivity + lateral attenuation + finite-segment correction. Auto-generated from EASA ANP v2.3 (+ v9 for modern types); unknown typecodes route to the nearest anchor by engine/size class.

**Sample anchor profiles** (Approach SEL dB at 200–25 000 ft):

| Class | Anchor | Approach SEL |
|------|---------|----|
| Narrowbody jet | B738 | 94.5, 90.4, 87.4, 84.1, 78.7, 72.4, 67.5, 62.3, 54.9, 48.5 |
| Narrowbody jet | A320 | 93.1, 89.1, 86.1, 82.9, 77.7, 71.7, 67.1, 61.9, 55.8, 49.2 |
| Regional jet | CRJ9 | 90.9, 86.7, 83.3, 79.9, 74.1, 67.4, 62.4, 56.9, 50.7, 43.9 |
| Turboprop | DH8D (Dash 8) | 88.9, 84.4, 81.1, 77.7, 71.9, 65.8, 62.3, 58.7, 55.6, 52.8 |
| Light GA | C172 (Cessna) | 85.0, 80.0, 76.0, 72.0, 65.0, 58.0, 53.0, 47.0, 41.0, 35.0 |
| Helicopter | EC35 | 92.0, 88.0, 85.0, 82.0, 76.0, 70.0, 65.0, 59.0, 53.0, 47.0 |

**Airport ground ops** — per-microsegment model on OSM aeroway geometry. Each ADS-B ground leg projects onto runway / taxiway microsegments (50 m perpendicular buffer); `ops_kind` comes from OSM `aeroway_type` (no speed classifier). Per-event SEL anchored at 25 m, propagated through Section 3 path effects. Runway-roll departures get Doc 29's +2 dB. DBSCAN auto-discovery covers OSM-missing airfields. Movements outside the ADS-B receiver footprint don't appear (no synthetic backfill).

**Popup tabs**: *Ground* (per airport microsegment + movement kind), *Airborne* (per Stage 2A sub-segment), *Cruise* (per crossed H3-R7 hex).

**Lden** per [END 2002/49/EC](../standards/end-2002-49-ec.pdf): day 12 h, evening 4 h +5 dB, night 8 h +10 dB.

→ Full derivation, filters, ground-ops kernel, simplifications: `engine/noise-compute/SPEC.md` §5.

</details>

### Industrial and wind turbines

Industrial noise is spatially concentrated but locally dominant — a single cement plant or wind farm can define the noise environment for kilometres. We classify each site by registry NACE sector when available, otherwise by OSM industrial subtype or coarse source type. The range across sectors is ~30 dB: a farm (70 dB) vs a cement plant (100 dB).

- **Data:** OpenStreetMap industrial landuse + NACE codes from national pollution registries (IRZ, E-PRTR, GPPD)
- **Wind turbines:** IEC 61400-11 model, emission based on rated power (98–106.5 dB(A) Lw)
- **Formula:** `Lw = base_sector + 10 × log₁₀(area / 10,000 m²)` — area capped at 500,000 m²

<details>
<summary>Technical: industrial emission profiles (ISO 8297 + NACE)</summary>

[ISO 8297](https://www.iso.org/standard/15401.html), [CNOSSOS-EU §2.4](../standards/cnossos-eu-2021-1226.pdf). Reference area 10 000 m² (a 100 000 m² factory adds 10 dB to its base). Profile priority: registry `nace_4digit` → OSM subtype → coarse source type. Base values were authored against Czech SHM 2022 + EU Directive 2000/14/EC limits + 3M Noise Navigator measurements before the 2026-06 band normalization; they are now honest dB(A) totals (effective emission −4.9..−6.4 vs pre-audit), re-calibration pending.

**By OSM site type** (when no registry NACE):

| Type | Base Lw | Evening | Night |
|------|---------|---------|-------|
| Generic industrial | 93 dB | -3 | -10 |
| Quarry | 99 dB | -5 | -20 |
| Farmyard | 70 dB | -5 | -20 |
| Works/factory | 94 dB | -3 | -8 |
| Wastewater plant | 89 dB | 0 | 0 (24/7) |

**By NACE sector** (when enriched with registry data):

| Sector | NACE | Base Lw | Evening | Night |
|--------|------|---------|---------|-------|
| Cement / glass / minerals | 23 | 100 dB | -2 | -4 |
| Metallurgy | 24 | 100 dB | -2 | -4 |
| Mining / quarrying | 08 | 99 dB | -8 | -20 |
| Power generation | 35 | 97 dB | -1 | -2 |
| Waste / recycling | 38 | 95 dB | -3 | -8 |
| Chemical industry | 20 | 94 dB | -2 | -4 |
| Metal fabrication | 25 | 93 dB | -5 | -10 |
| Motor vehicles | 29/30 | 93 dB | -5 | -12 |
| Wood / paper | 16/17 | 93 dB | -5 | -15 |
| Food / beverage | 10/11 | 90 dB | -5 | -12 |
| Electrical / mechanical | 27/28 | 90 dB | -5 | -12 |
| Rubber / plastics | 22 | 90 dB | -5 | -10 |
| Textiles / leather | 13-15 | 88 dB | -5 | -15 |
| Wastewater | 37 | 89 dB | 0 | 0 |
| Warehousing | 52 | 86 dB | -3 | -8 |
| Retail / logistics | 46/47 | 84 dB | -8 | -20 |
| Agriculture | 1-3 | 70 dB | -5 | -20 |

Emission bands are normalized so the A-weighted band sum equals Base Lw exactly (audit 2026-06) — Base Lw is the radiated dB(A) total, not a pre-spectrum scalar.

Source height: 8 m (quarry), 10 m (heavy industry NACE 8/23/24/35), 5 m (other), hub height for wind turbines (default 105 m, tag errors clamped at 175 m).

**Wind turbines** (IEC 61400-11): published max LwA is nearly flat across ratings — 98 dB(A) (< 1 MW), 104 (1–2 MW), 105 (2–3 MW + unknown default), 106 (3–5 MW), 106.5 (≥ 5 MW); ratings above 8 MW are treated as OSM tag errors (unknown).

→ Full emission/area/height resolution chains: `engine/noise-compute/SPEC.md` §6.

</details>

### Buildings and settlements

Noise from everyday building activity — HVAC systems, human activity, deliveries, playgrounds. Each building is an individual noise source classified by its OpenStreetMap type. This is a custom model — not a CNOSSOS-EU standard source.

- **Data:** OpenStreetMap building polygons with type, height, floors, area
- **Model:** Two-component Lw: fixed sources (HVAC, loading dock) + distributed sources scaling with gross floor area
- **Formula:** `Lw = 10 × log₁₀(10^(Lw_fixed/10) + GFA × 10^(Lw_per_m²/10))` where GFA = footprint × floors

<details>
<summary>Technical: building emission profiles</summary>

10 building types classified from OSM tags (`building=*`, `amenity=*`, `shop=*`):

| Type | OSM tags | Lw fixed | Lw/m² | Evening | Night |
|------|----------|----------|-------|---------|-------|
| Residential | apartments, house, detached | 45 dB | 15 | -5 | -15 |
| Commercial | commercial, retail, shop | 55 dB | 20 | -3 | -20 |
| Warehouse | warehouse, industrial building | 40 dB | 15 | -5 | -15 |
| School | school, kindergarten | 60 dB | 22 | -10 | -25 |
| Hospital | hospital, clinic | 50 dB | 18 | -3 | -5 |
| Church | church, chapel | 50 dB | 20 | -5 | -20 |
| Hotel | hotel, hostel | 48 dB | 16 | -2 | -10 |
| Garage | garage, parking | 35 dB | 12 | -5 | -15 |
| Farm | farm, barn | 40 dB | 14 | -5 | -20 |
| Public | civic, office, government | 52 dB | 18 | -8 | -20 |

Since the 2026-06 audit the engine constants carry a +5.6..+7.0 dB(A) per-class bump on top of these bases — it compensates the emission-band normalization exactly (radiated levels unchanged, units now honest dB(A); table in `settlement.rs::building_profile`).

Industrial / warehouse buildings inside industrial landuse polygons are handled by the industrial pipeline, not double-counted. Source at building height / 2 (mid-facade), propagated as ISO 9613-2 point source.

Calibration sources: EU Reg 626/2011 (residential AC units), ASHRAE Handbook Ch.48 (HVAC Lw vs capacity), BS 4142:2014 (commercial noise assessment).

→ Discretization (centroid vs interior grid), fallback chains: `engine/noise-compute/SPEC.md` §7.

</details>

---

## How sound travels

Sound gets quieter as it travels. On flat open ground, a road drops about 3 dB every time you double your distance. But the real world has hills, buildings, and forests that block sound further — and hard surfaces like asphalt that reflect it.

We simulate these effects for every source-receiver pair using [ISO 9613-2](https://www.iso.org/standard/74047.html) ([PDF](../standards/iso-9613-2-2024.pdf)) and [CNOSSOS-EU](https://eur-lex.europa.eu/eli/dir_del/2021/1226) ([PDF](../standards/cnossos-eu-2021-1226.pdf)), computed per 8 octave bands (63–8000 Hz), then A-weighted.

Road, railway, industrial, settlement, and aircraft ground ops use the same propagation engine. Airborne aircraft uses NPD tables where atmospheric absorption is already included.

| Effect | What it does | Data source | Max effect |
|--------|-------------|-------------|-----------|
| Distance | Sound spreads out — 3 dB per doubling (line), 6 dB (point) | Geometry | Baseline |
| Atmosphere | Air absorbs high frequencies over long distances | ISO 9613-1 (15°C, 70% RH) | Baseline |
| Ground | Soft ground (grass) absorbs; hard ground (asphalt) reflects | Copernicus IMD raster → G-factor | ~3 dB |
| Terrain | Hills block sound via diffraction | Copernicus GLO-30 DEM (30m) | 20–25 dB |
| Buildings | Buildings screen sound like walls | Overture building-height raster (30m) | 20 dB/band |
| Vegetation | Forests absorb sound, especially high frequencies | ESA WorldCover 2021 | 2–12 dB/band |
| Reflections | Urban canyons bounce sound, increasing levels | Building enclosure heuristic | +5 dB |
| Weather | Downwind/inversion conditions can carry sound further | Not currently modelled | — |

**Key rule:** When a barrier (hill or building) is present, it replaces the ground effect — you get the larger of the two, not both (ISO 9613-2 §7.3.1). Vegetation attenuation is always additive.

<details>
<summary>Technical: propagation</summary>

**Total received level per band:**
```
L_received,i = L_emission,i − A_div,i − A_atm,i − max(A_ground,i, A_terrain,i + A_screen,i) − A_veg,i + A_refl + FLC
```

**Geometric divergence**: line source `A_div = 10·log₁₀(2π·d_slant)`; point source `A_div = 20·log₁₀(d_slant) + 11`.

**Atmospheric absorption** (ISO 9613-1, 15°C 70% RH, dB/km):

| 63 Hz | 125 | 250 | 500 | 1k | 2k | 4k | 8 kHz |
|-------|-----|-----|-----|-----|-----|------|-------|
| 0.1 | 0.4 | 1.0 | 1.9 | 3.7 | 8.7 | 22.0 | 58.4 |

**A-weighting** (IEC 61672-1): `[-26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1]` dB.

**Diffraction**: DEM + building heights + explicit barriers merge into one composite top-profile sampled along source→receiver; diffraction computed once over the composite so a building on a hill can't double-count Fresnel. Single edge capped at 20 dB; double/triple at 25 dB (CNOSSOS C″ thick-barrier correction). The popup splits the combined attenuation back into `terrain` + `screening` for UI breakdown, but the physics is computed together. Building reflections (§7.5) are +0–5 dB boost from local enclosure.

**Vegetation** (ISO 9613-2:2024 A.2.2 × 0.5 Central Europe calibration):

| | 63 Hz | 125 | 250 | 500 | 1k | 2k | 4k | 8 kHz |
|--|-----|-----|-----|-----|-----|-----|-----|------|
| dB/m | 0.01 | 0.015 | 0.02 | 0.025 | 0.03 | 0.04 | 0.045 | 0.06 |
| Max | 2 | 3 | 4 | 5 | 6 | 8 | 9 | 12 dB |

× 0.5 reflects that WorldCover binary forest raster fires at ≥ 10 % tree cover but ISO defaults assume dense canopy.

**Ground**: G = 1 − IMD/100 (G = 0 hard, G = 1 soft). Per-band correction factors `[-1.5, -0.7, 1.5, 2.5, 2.0, 1.3, 0.7, 0.2]` × G.

**Favourable weather**: not currently applied. `P_FAV = 0.5` placeholder in code; no wind / inversion boost.

→ Full derivation, edge selection, Rayleigh δ\* gate, simplifications: `engine/noise-compute/SPEC.md` §3.

</details>

---

## What you see on the map

### The noise indicator: Lden

The map shows **Lden** (day-evening-night level), the European standard from [END 2002/49/EC](https://eur-lex.europa.eu/eli/dir/2002/49/oj/eng) ([PDF](../standards/end-2002-49-ec.pdf)). It weights evening noise +5 dB and night noise +10 dB to reflect the greater annoyance of noise during rest periods:

```
Lden = 10 × log₁₀((12 × 10^(Ld/10) + 4 × 10^((Le+5)/10) + 8 × 10^((Ln+10)/10)) / 24)
```

Day: 07:00–19:00, evening: 19:00–23:00, night: 23:00–07:00.

[WHO 2018 guidelines](https://www.who.int/europe/publications/i/item/9789289053563) recommend: road < 53 dB, rail < 54 dB, aircraft < 45 dB Lden.

### Grid

A Web-Mercator raster at zoom 13 (~12 m per pixel at 50°N, varies with latitude) — fine enough to distinguish the street-facing vs garden side of a building. A zoom pyramid (z6–13) serves coarser tiles when zoomed out.

### Color scale

Green (quiet, ~10 dB) → yellow (~45 dB) → orange (~55 dB) → red (~65 dB) → dark purple (very loud, 80+ dB). Transparent where there is no computed noise.

### Toggles

- **Source layers:** Roads, Railways, Industrial, Buildings, and Aircraft (ground ops, airborne, cruise) — each toggleable independently
- **Overlays:** Quiet zones (areas below a threshold), Properties (real estate filtered by noise)

---

## Overlays

### Real estate

The map can display real estate listings filtered by noise level. Each country has its own data sources — see individual country pages.

- Each property's noise is sampled from the z13 noise raster at its location
- Default filter: show only properties below 60 dB Lden
- Focus: land plots — building plots, forests, meadows, gardens

### Quiet zones

Highlights contiguous areas below a configurable noise threshold (default 55 dB). Useful for identifying quiet retreats, parks, and areas suitable for noise-sensitive development.

---

## What we measure

Human-made noise is not the same as natural sound. A forest at 50 dB with birdsong feels quiet. A road at 50 dB with traffic feels loud. Quiet Map measures environmental noise from human sources — transport, industry, and urban activity — not nature.

---

## Simplifications

This model is an engineering approximation for a continental-scale noise atlas — not a certified implementation of CNOSSOS-EU or ISO 9613-2.

| Area | Standard says | We do | Impact |
|------|-------------|-------|--------|
| Source height (roads) | CNOSSOS-EU: 0.05 m (rolling) / 0.30 m (propulsion) | 0.05 m for both | Minor — propulsion height difference negligible at atlas scale |
| Terrain profile | Professional SW: 5–10 m spacing | Adaptive 30 m spacing (8–50 points) | May miss narrow barriers (<30 m wide) |
| Aircraft type mapping | Doc 29 / ANP: aircraft-specific certified profiles + procedural steps + weights | Per-ICAO-typecode NPD profiles auto-generated from EASA ANP v2.3 (+ v9 supplement), bucketed at a fixed set of noise classes for aggregation (see SPEC §5) | ±1-2 dB for ANP-mapped types; similarity fallback for unmapped typecodes routes to closest anchor by engine/size class |
| Aircraft timing | Airport-local time and operational preprocessing | Segment midpoint → IANA timezone (tzf-rs) → DST-aware local time (chrono-tz); END default period boundaries | Global local time; only airport-local operational-preprocessing differences remain |
| Aircraft ground ops | Curated surface-movement inventories + airport-local operational data | ADS-B legs projected onto OSM aeroway microsegments (runway/taxiway); per-microsegment movement counters; DBSCAN auto-discovery for OSM-missing airfields | Near-runway levels depend on ADS-B coverage; movements outside the receiver footprint don't appear (no synthetic backfill) |
| Tile propagation | Operational studies may expose a per-effect propagation breakdown | Tiles store one combined full-propagation Lden per source layer (z13 HM3); the click popup's `traces` expose per-leg / per-sub-segment detail | No per-effect (terrain/screening/vegetation) isolation at tile resolution |
| Receiver grid | END: facade receivers (4 m height, 2 m from wall) | z13 Web-Mercator raster pixel centers (~12 m at 50°N, 4 m height) | Area average, not per-facade |
| Road corrections | CNOSSOS-EU: gradient, intersection, temperature | Not implemented | ±1–3 dB on steep/cold roads |
| Building reflections | ISO 9613-2 §7.5: image-source ray tracing | Simplified: local enclosure heuristic, 0–5 dB boost | May underestimate in complex geometries |
| Settlement noise | Not standardised (END covers road/rail/aircraft/industry only) | Custom per-building model, 10 OSM building types | Novel — no standard reference values |
| Atmospheric conditions | Variable: temperature, humidity, wind speed | Fixed: 15°C, 70% RH; favourable-weather boost not applied | Seasonal/hourly variation not captured |

Despite these simplifications, the model achieves MAE < 3 dB against national strategic noise maps for road noise (see country validation pages). Aircraft noise has not yet been formally validated.

---

## Validation

- **Reference:** National strategic noise maps (see country pages for specifics)
- **Methodology:** [WG-AEN Good Practice Guide](https://sicaweb.cedex.es/docs/documentacion/Good-Practice-Guide-for-Strategic-Noise-Mapping.pdf) ([PDF](../standards/wg-aen-good-practice-guide.pdf)), [EPA Ireland Guide v4](https://www.epa.ie/publications/monitoring--assessment/noise/) ([PDF](../standards/epa-ireland-noise-mapping-guide-2025.pdf))
- **Target:** MAE < 3 dB, broken down by road class and distance band

---

Quiet Map is an open-source project. All computations are transparent and reproducible from public data.

## Attribution

- **Base map:** © [CARTO](https://carto.com/about-carto/), © [OpenStreetMap](https://www.openstreetmap.org/about/) contributors
- **Terrain basemap:** © [OpenTopoMap](https://opentopomap.org/)
- **Satellite imagery:** © [Esri](https://www.esri.com/), Maxar, Earthstar Geographics
- **Elevation data:** [Copernicus GLO-30 DEM](https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model) (ESA/Copernicus, primary), [SRTM](https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-shuttle-radar-topography-mission-srtm-1) (NASA/USGS, fallback)
- **Building height:** [Overture Maps](https://overturemaps.org/) building raster (30m), derived from Overture building footprints and height tags
- **Land cover & vegetation:** [ESA WorldCover 2021](https://worldcover2021.esa.int/) (ESA, CC BY 4.0)
- **Ground imperviousness:** [Copernicus Imperviousness Density](https://land.copernicus.eu/en/products/high-resolution-layer-imperviousness) (EEA, Europe)
- **Road, railway & airport geometry:** © [OpenStreetMap](https://www.openstreetmap.org/) contributors (ODbL)
- **Flight data:** [adsb.lol](https://adsb.lol/) (ADS-B community feeds)
- **Map rendering:** [MapLibre GL JS](https://maplibre.org/) (open source)
