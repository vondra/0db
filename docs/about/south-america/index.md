---
title: South America
intro: Noise mapping overview for South America — per-country enrichment available for all 12 mainland countries.
map: { center: [-60, -15], zoom: 3 }
---

## Data situation

South America has no continent-wide open data initiatives for transport or environment. Transit operators rarely publish GTFS feeds, and national traffic count data is not openly available across the continent. **However, per-country enrichment has been completed for all 12 mainland countries** (Brazil, Argentina, Chile, Colombia, Peru, Ecuador, Uruguay, Paraguay, Bolivia, Venezuela, Suriname, Guyana), each leveraging country-specific open data portals or community mirrors (DNIT/SIGACONTROL for Brazil, IGN GeoServer/IDE Transporte for Argentina, MOP Vialidad/CNE/SERNAGEOMIN for Chile, INVIAS/ANM/ANH for Colombia, MTC Provías/INGEMMET/PERUMIN for Peru, CONGOPE/GEM for Ecuador, GEM-only for Uruguay, MOPC KMZ/GEM for Paraguay, MHE GeoServer/ABC community mirror for Bolivia, VE360 community mirror for Venezuela, GEM for Suriname and Guyana).

## Continental enrichment

No multi-country, continent-wide feed exists (no equivalent of the EU's Environmental Noise Directive mandating open data; metro/rail operators like MetroSP, CPTM, Subte BA and Metro Santiago don't consistently publish GTFS). Enrichment is instead assembled per country from national portals and community mirrors — see the per-country status below.

## What the map uses (global baseline)

Global baseline (GLO-30 DEM, GHSL buildings, WorldCover forest + ground) applies everywhere — see [main methodology](/about). South-America-specific notes: building heights come from **GHSL 100 m** (Overture has <1% height coverage for SA cities); WorldCover covers the Amazon basin well. Enrichment on top of the baseline:

- **Traffic**: Brazil, Argentina, Chile, Colombia, Peru and Ecuador carry real national road data (per-segment AADT for AR/CL/CO/PE where surveys exist), plus Bolivia, Paraguay and Venezuela via community/mirror sources; other countries use class defaults.
- **Industrial**: GPPD power plants (NACE 35) baseline — BR 255, AR 88, CL 69, CO 36 plants — overridden per country by national registries where available (ANEEL energy fleet in Brazil, ANM/SERNAGEOMIN/INGEMMET mining → NACE 05/07/08 in Colombia/Chile/Peru, ANH oil & gas in Colombia).
- **Railway**: Argentina rail enrichment (Buenos Aires commuter frequencies); other countries carry rail geometry only with class-default frequencies. All remaining rail uses OSM defaults.

## Per-country enrichment status

1. **Brazil** ✅ — DNIT federal highways (7,607 routes via ArcGIS Online mirror, class-based estimates — no per-segment counts), SIGACONTROL ANEEL energy fleet (11,182 wind turbines, 3,226 thermal, 1,138 hydro, 322 solar, 3 nuclear). Railways run on engine defaults (no Brazilian rail source integrated). See [Brazil page](br).
2. **Argentina** ✅ — IGN GeoServer DNV roads (2,723 RN + 12,936 RP), TMDA 2017-18 real AADT (1,234 segments), IGN railway lines (1,092 / 691 operational), Buenos Aires Subte/Trenes Argentinos commuter, GEM 263 operating power plants. 4.5M road segments enriched (39% of bbox). See [Argentina page](ar).
3. **Chile** ✅ — MOP Vialidad Red Vial (13,962 routes via Esri Chile mirror), **TMDA 2024-2025 real AADT (863 stations, freshest in pipeline)**, Red Ferroviaria (1,244 / 890 active), Metro de Santiago, CNE Centrales (203 thermal), GEM 422 operating, **SERNAGEOMIN Catastro Relaves (140 active mining tailings → NACE 07, unique to CL)**, CNE Substations (1,129 ≥110 kV). 4.7M road segments enriched (79% of bbox). See [Chile page](cl).
4. **Colombia** ✅ — INVIAS Red Vial Nacional (625 routes via Esri mirror), **TPDS_NUBE TPDA 2024 with PER-SEGMENT VEHICLE CLASS BREAKDOWN (1,271 segments, 822 with real AADT — UNIQUE TO CO in entire pipeline)**, Metro de Medellín stations, GEM 251 operating, **ANM Títulos Mineros (7,541 polygons with mineral classification → NACE 05/07/08)**, **ANH Hidrocarburos (445 oil/gas blocks → NACE 06)**. 3.6M road segments enriched (42% of bbox). See [Colombia page](co).
5. **Peru** ✅ — MTC Provías Red Vial Nacional 2024 (7,340 polylines, 866 with dIMD real AADT), Red Vial Departamental (3,150), Lima Metro Line 1, GEM 85 operating, INGEMMET Yacimientos Mineros (1,507 points), **PERUMIN_WFL1 — MOST DETAILED MINING POLYGON DATA IN PIPELINE** (27 open pits + 12 tailings dams + 17 leach pads + 37 waste dumps + 335 active concessions, all NACE 07). 4.0M road segments enriched (42% of bbox). See [Peru page](pe).
6. **Ecuador** ✅ — CONGOPE Red Vial Ecuador (28,328 polylines covering national + 24 GAD provincial networks, **densest rural network in pipeline**), Red Vial Estatal (711 polylines with ARTERIAL/COLECTORA classification), **Metro de Quito Line 1 (opened Dec 2023 — Ecuador's first metro)**, GEM 70 operating plants (hydropower-dominated, Coca Codo Sinclair 1,500 MW). **2.4M road segments enriched (90% of bbox — highest rate in pipeline)**. No per-segment IMD/AADT. See [Ecuador page](ec).
7. **Uruguay** ✅ — Class defaults only (MTOP GeoServer TCP/WAF-blocked — has TPDA tramos 2004-2017 + full Caminería Nacional + AFE rail geometry but all unreachable), Ferrocarril Central (273 km UPM2 pulp corridor opened 2023), GEM 64 operating (world's highest wind penetration per capita). All 3 pulp mills captured. 0.5M road segments enriched. See [Uruguay page](uy).
8. **Paraguay** ✅ — MOPC Rutas Nacionales KMZ (22 routes PY01–PY22, ~8,780 km) + minimal rail (essentially no operational rail) + GEM with **cross-border Itaipú (14 GW, flagged as Brazil) + Yacyretá (3.1 GW, flagged as Argentina) captured for PY context**. **1.33M road segments enriched (95.78% — highest rate in pipeline)**. Gran Asunción (~2.3M) is the only real metro. See [Paraguay page](py).
9. **Bolivia** ✅ — ABC Red Vial Fundamental (79 polylines community mirror, partial) + WCS RED_VIAL (556 primary roads) + tri-regional class defaults (Altiplano/Valles/Llanos) + two disjoint rail networks (FCA western + FCO eastern) + **MHE GeoServer** — richest Bolivian geodata with SIN 47 + AIS 35 + substations 230 + transmission 291. GeoBolivia SDI was shut down March 2023. 2.4M road segments enriched (74% of bbox). See [Bolivia page](bo).
10. **Venezuela** ✅ — All government portals blocked due to post-2014 crisis. **VE360 community mirror** (`proyecto.ve360`) preserves complete SIGOT 2013-2019 dataset: Vialidad 15,528 roads + Metro/Sistema Ferroviario 145 (Caracas Metro + Ezequiel Zamora + Ferrominera Orinoco iron ore corridor) + Power 289 (filter `OPERACIÓN_ACTUAL_MW > 0`: only **25% actually operating** — reflects collapse) + **20,714 oil wells** + 209 substations + Guri 10.2 GW from GEM (oil pipelines + gas flares are in the mirror but not ingested). 1.2M road segments enriched (32% of bbox — low because Essequibo + Colombian Llanos are large exclusion zones). See [Venezuela page](ve).
11. **Suriname** ✅ — 4 GEM plants / 250 MW. **Afobaka hydro 189 MW** (built for Suralco/Alcoa aluminium, flooded 1% of territory). Dutch-speaking. 93% forest (most forested country). **91k roads (96%)**. See [Suriname](sr).
12. **Guyana** ✅ — 2 GEM plants / 2 MW (tiny solar only). **ExxonMobil Stabroek oil boom** (offshore, not in GEM — one of world's largest recent discoveries). English-speaking cricket country. **147k roads (92%)**. See [Guyana](gy).

