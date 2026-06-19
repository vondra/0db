---
title: Europe
intro: EU noise mapping framework — standards, directives, and methodology.
map: { center: [15, 50], zoom: 4 }
---

## Environmental Noise Directive (END)

The EU [Environmental Noise Directive 2002/49/EC](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A32002L0049) requires member states to produce strategic noise maps for major roads, railways, airports, and cities. Quiet Map uses the same methodology but extends coverage to all sources and locations, not just those above the directive's thresholds.

## CNOSSOS-EU

The [Common Noise Assessment Methods](https://publications.jrc.ec.europa.eu/repository/handle/JRC72550) (CNOSSOS-EU) is the official EU reference method for strategic noise mapping. It defines:

- **Road emission model** — Noise power per vehicle category, speed, and road surface
- **Railway emission model** — Noise per train type, speed, track properties
- **Industrial emission model** — NACE sector-differentiated source power levels (21 sectors + 17 sub-types), calibrated against SHM contours using IRZ/E-PRTR facility registry data
- **Propagation model** — Sound attenuation through distance, ground, terrain, buildings, and atmosphere

Quiet Map implements CNOSSOS-EU emission models for road (Annex II), railway (Annex IV), and industrial sources, with ISO 9613-2 propagation. Aircraft noise uses an NPD-based approach inspired by ECAC Doc 29 (referenced by CNOSSOS-EU §2.7) but is not a certified implementation — see [methodology page](../index.md#aircraft) for details.

## ISO 9613-2

The propagation model follows [ISO 9613-2](https://www.iso.org/standard/61049.html) (Acoustics — Attenuation of sound during propagation outdoors), which defines octave-band calculation of:

- Geometric divergence
- Atmospheric absorption
- Ground effect
- Screening by obstacles (terrain, buildings, barriers)

## Propagation factors

Each factor can be toggled independently in the map's advanced settings, so you can see how much terrain, forest, or buildings affect noise at any location.

| Factor | What it does |
|--------|-------------|
| **Geometric divergence** | Sound energy spreads over a larger area with distance |
| **Atmospheric absorption** | Air absorbs sound energy (depends on temperature and humidity) |
| **Ground effect** | Soft ground (grass, soil) absorbs more than hard surfaces (concrete, water) |
| **Terrain diffraction** | Hills and ridges can block sound — a ridge can reduce noise by 10 dB or more |
| **Building screening** | Buildings between source and receiver block and reflect sound |
| **Forest attenuation** | Dense vegetation absorbs and scatters sound energy |
| **Meteorological** | Wind direction and temperature inversions affect sound paths |

Meteorological correction uses favourable propagation probability P_FAV = 0.5 (Central Europe default, per CNOSSOS-EU §2.5.21).

## How far noise travels

Different sources propagate different distances. A motorway is audible much further than a local road.

| Source | Maximum distance | Why |
|--------|-----------------|-----|
| Motorway | 10 km | High speed, heavy traffic, continuous noise |
| Trunk road | 7 km | Moderate-heavy traffic |
| Primary road | 5 km | Moderate traffic |
| Secondary road | 5 km | Local traffic, increased range for 10 dB threshold |
| Tertiary road | 4 km | Low traffic |
| Residential road | 3 km | Very low traffic |
| Main railway | up to 10 km | Heavy freight trains, high sound power |
| Local railway / tram | 5 km | Lower sound power |
| Aircraft corridor | Segment midpoint only (no lateral spread) | NPD proxy profiles; all altitudes included (extrapolated beyond 25,000 ft) |
| Industrial facility | up to 5 km | Varies by sector (NACE-differentiated), 10 dB threshold |
| Wind turbine | up to 5 km | Elevated point source (actual hub height), 100–107 dB |
| Settlement building | 1–2 km | Per-building acoustic capacity model, 14 OSM classes |

## WHO guidelines

The [WHO Environmental Noise Guidelines for the European Region](https://www.who.int/europe/publications/i/item/9789289053563) (2018) recommend:

| Source | Indicator | Recommended level |
|--------|-----------|-------------------|
| Road traffic | Average annual noise | Below 53 dB |
| Railway traffic | Average annual noise | Below 54 dB |
| Aircraft noise | Average annual noise | Below 45 dB |
| Wind turbines | Average annual noise | Below 45 dB |

These guidelines inform the color scale — locations above WHO thresholds appear in warmer colors.

## Noise indicators

- **Average annual noise (Lden)** — Day-evening-night weighted average over a full year. Evening noise gets a +5 dB penalty, night noise +10 dB, reflecting human sensitivity to noise during rest hours. Computed as: Lden = 10 × log₁₀((1/24) × (12 × 10^(Ld/10) + 4 × 10^((Le+5)/10) + 8 × 10^((Ln+10)/10))), where Ld is daytime (07:00-19:00), Le is evening (19:00-23:00), and Ln is nighttime (23:00-07:00).
- **Night noise (Lnight)** — Average noise during 23:00-07:00, used for sleep disturbance assessment.

## Continental enrichment

European noise data is enriched at three levels: global baseline → continental datasets → national data.

### Applied datasets

| Dataset | Coverage | Impact | Status |
|---------|----------|--------|--------|
| **EU city traffic (AADT)** | 36 cities across 16 countries | Road segments get real traffic counts instead of defaults | Applied — 335K+ segments |
| **E-PRTR industrial registry** | 32 EU/EEA countries, full NACE spectrum | Industrial sites get registry NACE sector (not just power plants) | Applied — 67,413 facilities |
| **GTFS railway timetables** | ~17 European countries (18 feeds) | Railway segments get real train frequencies | Applied |
| **GPPD power plants** | ~35K plants worldwide (EU subset) | Industrial sites get NACE 35 classification | Applied — direct to industrial.arrow |
| **Copernicus IMD** | Europe-wide 10m raster | Ground effect G-factor overlay on WorldCover | Applied — in raster pipeline |

### EU city traffic

Source: "Harmonized Annual Averaged Traffic Data at Street Segment Level for European Cities" (Nature Scientific Data, 2025), CC BY 4.0. Cities: Vienna, Brno, Copenhagen, Helsinki, Paris, Grenoble, Toulouse, Lyon, Lille, Bordeaux, Rennes, Marseille, Rouen, Montpellier, Tours, Berlin, Hamburg, Dublin, Milan, Luxembourg, Amsterdam, Oslo, Lisbon, Valencia, Barcelona, Madrid, Malmö, Stockholm, Zurich, Geneva, London, Birmingham, Manchester, Glasgow, Edinburgh, Cardiff.

### GTFS railway

Train frequencies from public GTFS feeds across ~17 European countries: DELFI (DE), opentransportdata.swiss (CH), ÖBB (AT), NS (NL), Trafikverket (SE), Entur (NO), Fintraffic (FI), NMBS/SNCB (BE), SNCF + Transilien (FR), CFL (LU), Hellenic Train (GR), Pasažieru Vilciens (LV), Peatus.ee (EE), Sofia Traffic (BG), HŽ (HR), MÁV-START (HU), ŽSR (SK). Busiest Wednesday selected as reference day.

### National road & rail enrichment

Beyond the harmonized 36-city dataset, several European countries carry their own country-specific road/rail enrichment. Data source and method vary by country (published surveys, corridor-tier, network-derived tuning) — see each country page:

- **Road enrichment applied** — Czechia, Germany, Spain, France, United Kingdom, Italy, Poland, Denmark, Finland, Norway, Ireland, Russia, Turkey, Ukraine.
- **Rail enrichment applied** — Czechia, Spain, Italy, Poland, Portugal, Sweden, Denmark, Finland, Ireland, Russia, Ukraine.

### Known gaps

- **Traffic outside enriched coverage**: Roads outside the 36 cities and the national AADT countries use default AADT by road class.

## Non-EU per-country enrichment

Enriched European countries outside the EU continental dataset:

- **Serbia, Bosnia, Montenegro, North Macedonia, Albania, Kosovo** (Western Balkans 6) — GEM + corridor railway defaults. See individual pages.
- **Ukraine, Belarus, Moldova** — GEM + corridor defaults. See individual pages.
- **Iceland** — GEM (100% renewable). No railway (never had one). See [Iceland](is).
- **Andorra** ✅ — 2 GEM plants / 46 MW (FEDA hydro). Pyrenees duty-free. **29k roads (68%)**. See [Andorra](ad).
- **Monaco** ✅ — 0 GEM plants. F1 Grand Prix. **0 roads (FR overlap)**. See [Monaco](mc).
- **San Marino** ✅ — 0 GEM plants. Oldest republic (301 AD). **0 roads (IT overlap)**. See [San Marino](sm).
- **Liechtenstein** ✅ — 0 GEM plants. Double-landlocked. Banking. **0 roads (CH/AT overlap)**. See [Liechtenstein](li).

## Validation

Model predictions are validated against reference measurements:

- **State noise monitoring** — Official strategic noise maps (e.g. SHM/CENIA in Czech Republic) serve as the primary reference. Target accuracy: mean absolute error below 3 dB.
- **Mobile measurements** (planned) — Users measure real noise with a phone app. AI classification separates natural sounds (birds, water, wind) from human noise (traffic, aircraft, industry).
- **Feedback loop** — Measurements improve the model, and the model guides where to measure next.
