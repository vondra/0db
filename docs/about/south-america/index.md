---
title: South America
intro: Noise mapping overview for South America — per-country enrichment available for Brazil, Argentina, Chile, Colombia, Peru, Ecuador, Uruguay, and Paraguay.
map: { center: [-60, -15], zoom: 3 }
---

## Data situation

South America has no continent-wide open data initiatives for transport or environment. Transit operators rarely publish GTFS feeds, and national traffic count data is not openly available across the continent. **However, per-country enrichment has been completed for Brazil, Argentina, Chile, Colombia, Peru, Ecuador, Uruguay, and Paraguay**, each leveraging country-specific open data portals (DNIT/SIGACONTROL for Brazil, IGN GeoServer/IDE Transporte for Argentina, MOP Vialidad/CNE/SERNAGEOMIN for Chile, INVIAS/ANM/ANH for Colombia, MTC Provías/INGEMMET/PERUMIN for Peru, CONGOPE/GEM for Ecuador, GEM-only for Uruguay, MOPC KMZ/GEM for Paraguay).

## Continental enrichment

No multi-country datasets found. Research conducted 2026-04-10:

| Country | Dataset | Status |
|---------|---------|--------|
| **Brazil** | CPTM (São Paulo trains) GTFS | Empty download (0 bytes) |
| **Brazil** | Metro SP GTFS | 404 / HTML redirect |
| **Chile** | DTPM Santiago GTFS | Bus-only (372 routes, no rail) |
| **Argentina** | Buenos Aires subte GTFS (2019) | Frequency-based, missing link tables |
| **Colombia** | TransMilenio Bogotá | 404 |

### Why South America is harder

- No equivalent of EU Environmental Noise Directive mandating open data
- Metro/rail operators (MetroSP, CPTM, Subte BA, Metro Santiago) don't consistently publish GTFS
- National road traffic census data is not openly downloadable
- Industrial facility registries are not publicly geocoded

## What the map uses (global baseline)

- **DEM**: Copernicus GLO-30 (30m) — terrain diffraction
- **Buildings**: GHSL 100m (Overture has <1% height coverage for SA cities)
- **Forest**: ESA WorldCover 10m — vegetation attenuation (Amazon basin well covered)
- **Ground**: WorldCover-derived G-factor
- **Industrial**: GPPD power plants (NACE 35) — BR 255, AR 88, CL 69, CO 36 plants
- **Traffic**: OSM road class defaults only
- **Railway**: OSM rail type defaults only (no train frequency data)

## Per-country enrichment status

1. **Brazil** ✅ — DNIT federal highways (7,607 routes via ArcGIS Online mirror), PRUMO rail network (2,893 segments), SIGACONTROL ANEEL energy fleet (11,182 wind turbines, 3,226 thermal, 1,138 hydro, 322 solar, 3 nuclear). 32M road segments enriched. See [Brazil page](br).
2. **Argentina** ✅ — IGN GeoServer DNV roads (2,723 RN + 12,936 RP), TMDA 2017-18 real AADT (1,234 segments), IGN railway lines (1,092 / 691 operational), Buenos Aires Subte/Trenes Argentinos commuter, GEM 263 operating power plants. 4.5M road segments enriched (39% of bbox). See [Argentina page](ar).
3. **Chile** ✅ — MOP Vialidad Red Vial (13,962 routes via Esri Chile mirror), **TMDA 2024-2025 real AADT (863 stations, freshest in pipeline)**, Red Ferroviaria (1,244 / 890 active), Metro de Santiago, CNE Centrales (203 thermal), GEM 422 operating, **SERNAGEOMIN Catastro Relaves (140 active mining tailings → NACE 07, unique to CL)**, CNE Substations (1,129 ≥110 kV). 4.7M road segments enriched (79% of bbox). See [Chile page](cl).
4. **Colombia** ✅ — INVIAS Red Vial Nacional (625 routes via Esri mirror), **TPDS_NUBE TPDA 2024 with PER-SEGMENT VEHICLE CLASS BREAKDOWN (1,271 segments, 822 with real AADT — UNIQUE TO CO in entire pipeline)**, Metro de Medellín stations, GEM 251 operating, **ANM Títulos Mineros (7,541 polygons with mineral classification → NACE 05/07/08)**, **ANH Hidrocarburos (445 oil/gas blocks → NACE 06)**. 3.6M road segments enriched (42% of bbox). See [Colombia page](co).
5. **Peru** ✅ — MTC Provías Red Vial Nacional 2024 (7,340 polylines, 866 with dIMD real AADT), Red Vial Departamental (3,150), Lima Metro Line 1, GEM 85 operating, INGEMMET Yacimientos Mineros (1,507 points), **PERUMIN_WFL1 — MOST DETAILED MINING POLYGON DATA IN PIPELINE** (27 open pits + 12 tailings dams + 17 leach pads + 37 waste dumps + 335 active concessions, all NACE 07). 4.0M road segments enriched (42% of bbox). See [Peru page](pe).
6. **Ecuador** ✅ — CONGOPE Red Vial Ecuador (28,328 polylines covering national + 24 GAD provincial networks, **densest rural network in pipeline**), Red Vial Estatal (711 polylines with ARTERIAL/COLECTORA classification), **Metro de Quito Line 1 (opened Dec 2023 — Ecuador's first metro)**, GEM 70 operating plants (hydropower-dominated, Coca Codo Sinclair 1,500 MW). **2.4M road segments enriched (90% of bbox — highest rate in pipeline)**. No per-segment IMD/AADT. See [Ecuador page](ec).
7. **Uruguay** ✅ — Class defaults only (MTOP GeoServer TCP/WAF-blocked — has TPDA tramos 2004-2017 + full Caminería Nacional + AFE rail geometry but all unreachable), Ferrocarril Central (273 km UPM2 pulp corridor opened 2023), GEM 64 operating (world's highest wind penetration per capita). All 3 pulp mills captured. 0.5M road segments enriched. See [Uruguay page](uy).
8. **Paraguay** ✅ — MOPC Rutas Nacionales KMZ (22 routes PY01–PY22, ~8,780 km) + minimal rail (essentially no operational rail) + GEM with **cross-border Itaipú (14 GW, flagged as Brazil) + Yacyretá (3.1 GW, flagged as Argentina) captured for PY context**. **1.33M road segments enriched (95.78% — highest rate in pipeline)**. Gran Asunción (~2.3M) is the only real metro. See [Paraguay page](py).
9. **Venezuela, Bolivia, Guyana, Suriname** — pending.

## Methodology

Same as global: CNOSSOS-EU emission + ISO 9613-2 propagation.
