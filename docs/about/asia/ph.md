---
title: Philippines
intro: Noise mapping data sources for the Philippines.
map: { center: [122.0, 12.0], zoom: 6 }
---

## Road traffic

### DPWH Road Classification + Philippine-tuned CNOSSOS defaults

No per-segment AADT is published openly for the Philippines. The DPWH RTI (Road Traffic Information) portal at [dpwh.gov.ph/dpwh/gis/rti](https://dpwh.gov.ph/dpwh/gis/rti) is Incapsula-blocked from non-PH IPs; data.gov.ph is a JS SPA with no public REST API.

However, the **Department of Public Works and Highways (DPWH)** operates a publicly accessible ArcGIS Server with the national road network classified by road section class:

- **Source**: [DPWH Road Classification FeatureServer](https://services1.arcgis.com/IwZZTMxZCmAmFYvF/arcgis/rest/services/Road_Classification/FeatureServer/1)
- **Records**: 4,476 polyline segments
- **Classification** (ROAD_SEC_CLASS):
  - Primary: 689 segments (expressways + major arterials — NLEX, SLEX, SCTEX, TPLEX, STAR, Skyway, etc.)
  - Secondary: 1,570 segments
  - Tertiary: 2,217 segments
- **Fields**: `ROAD_NAME`, `ROAD_SEC_CLASS`, `ROUTE_NO`
- **Updated**: February 2026

### AADT defaults

| DPWH class | Rural | Metro Manila (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| Primary | 50,000 | 100,000 | 70,000 |
| Secondary | 20,000 | 40,000 | 28,000 |
| Tertiary | 8,000 | 16,000 | 11,200 |
| OSM motorway | 50,000 | 100,000 | 70,000 |
| OSM trunk | 20,000 | 40,000 | 28,000 |
| OSM primary | 10,000 | 20,000 | 14,000 |
| OSM secondary | 4,000 | 8,000 | 5,600 |
| OSM tertiary | 1,500 | 3,000 | 2,100 |
| OSM residential | 800 | 1,600 | 1,120 |

The PH enricher writes AADT only where an OSM motorway/trunk/primary segment spatially matches a DPWH section (within 300 m) — using the DPWH-class row above, tier-multiplied. Segments with no DPWH match fall back to the engine's country-tier class defaults (the OSM rows shown for reference).

**Tier-1 metro** (×2.0): Metro Manila (NCR + Bulacan/Rizal/Cavite/Laguna immediate) — bbox `[14.3–14.85°N, 120.8–121.2°E]`.

**Tier-2 cities** (×1.4, 19 cities): Cebu, Davao, Quezon City, Iloilo, Bacolod, Zamboanga, Cagayan de Oro, Baguio, General Santos, Angeles, Bataan/Mariveles, Cavite City, Calamba, Tacloban, Dagupan, Olongapo, Naga, Butuan, Iligan.

### Philippine vehicle split (motorcycle- and jeepney-heavy)

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Metro Manila | 35% | 8% | 7% | **50%** |
| Tier-2 cities | 45% | 8% | 7% | **40%** |
| Rural | 55% | 10% | 10% | **25%** |

## Railway

### CNOSSOS class defaults

No Philippine rail enricher runs — rail noise uses CNOSSOS class defaults by OSM `railway` type (metro/light_rail vs heavy rail), not ingested service frequencies. There is no machine-readable PH rail traffic feed: the one open Manila GTFS (the community [sakayph/gtfs](https://github.com/sakayph/gtfs) repo, mirrored on the [TUMI Datahub](https://hub.tumidata.org/) as `manila.zip`) has a 2013-2020 pre-pandemic calendar and is not ingested. The Metro Manila rail corridors below are documented as context for the elevated viaducts that drive the highest urban rail noise:

| Line | Operator | Length | Stations |
|---|---|---|---|
| **LRT 1** (Yellow Line, Baclaran ↔ Roosevelt/FPJ) | LRTA | 20.7 km | 20 |
| **LRT 2** (Purple Line, Recto ↔ Antipolo) | LRTA | ~17.6 km | 13 |
| **MRT 3** (Blue Line, Taft Ave ↔ North Ave) | MRTC | 16.9 km | 13 |
| **PNR Metro Commuter** (Tutuban ↔ Alabang/Calamba) | PNR | 38 km | ~14 |

### Under-construction rail (not in feed)

- **Metro Manila Subway** (~33 km, Valenzuela ↔ NAIA via FTI) — target 2028+. Will be tagged `railway=subway` in OSM → pipeline extraction bug applies.
- **LRT 1 Cavite Extension** (11.7 km) — Baclaran to Bacoor extension
- **MRT 7** (23 km) — Commonwealth Avenue to San Jose del Monte, Bulacan
- **NSCR (North-South Commuter Railway)** (147 km, Clark ↔ Calamba via Manila) — the biggest ongoing rail project, JICA-funded
- **PNR Bicol Railway** rehabilitation (south of Manila)

## Buildings

GHSL Built-H R2023A 100 m + Overture Maps Foundation global footprints. No Philippine-specific building cadastre is open (LRA / Land Registration Authority is auth-gated). Overture includes Microsoft's Philippines building footprints from 2024.

## Industrial

### GEM Global Integrated Power — 995 PH plants

The PH industrial enricher spatial-joins power-plant points from the **Global Energy Monitor (GEM) Global Integrated Power** dataset ([Rice University CES GIS](https://services.arcgis.com/lqRTrQp2HrfnJt8U) mirror), filtered to **995 Philippine power plants** (255 currently operating). (GEM Global Integrated Power supersedes the lower-priority global GPPD baseline; only operating plants are stamped.)

**Fuel breakdown** (all units):
- **Coal**: 147 — Sual (Pangasinan, 1.2 GW), Masinloc (Zambales, 1.34 GW), Pagbilao (Quezon, 1.04 GW), Calaca (Batangas), Ilijan, Mariveles
- **Gas CCGT**: 61 — Ilijan (Batangas, 1.2 GW), San Gabriel, Santa Rita
- **Oil**: 17 — legacy diesel plants on outer islands
- **Hydroelectric**: 63 — Angat (218 MW, Bulacan), San Roque (411 MW, Pangasinan), Kalayaan pumped storage (734 MW), Pantabangan (136 MW, Nueva Ecija), Caliraya, Botocan
- **Geothermal**: 65 — **3rd-largest installed geothermal capacity globally** (~1.9 GW operational; behind the US and Indonesia). Major fields: **Tiwi (Albay)**, **Mak-Ban (Laguna, 442 MW)**, **Palinpinon (Negros, 193 MW)**, the **Greater Tongonan / Leyte field (~700 MW total)**, **Bacman (Albay)**, Mindanao
- **Solar**: 359 — rapidly growing, Calatagan, Bais, various farms
- **Wind**: 271 — Bangui (Ilocos Norte, 33 MW — first PH wind farm, 2005), Burgos (Ilocos Norte, 150 MW), Nabas, Caparispisan
- **Bioenergy**: 10 — sugarcane cogeneration
- **Nuclear**: 2 — Bataan Nuclear Power Plant (mothballed, never operated)

All mapped to **NACE 35** (Electricity generation).

### DTI Economic Zones (PEZA)

95 points from the **Department of Trade and Industry / Philippine Economic Zone Authority (PEZA)** ArcGIS layer. Mapped to NACE 25 (general manufacturing). Supplements OSM `landuse=industrial` tagging in BPO / Clark / Cavite / Laguna industrial belts.

## Validation

Philippines implements noise regulation via:

- **Department of Environment and Natural Resources (DENR) / Environmental Management Bureau (EMB)** at [denr.gov.ph](https://www.denr.gov.ph/) / [emb.gov.ph](https://emb.gov.ph/)
- **DENR Administrative Order 80-22** on ambient noise standards
- **Ambient noise quality standards** (per zone):
  - Residential day/night: 55/45 dBA
  - Commercial day/night: 65/55 dBA
  - Industrial day/night: 70/60 dBA
  - Area AA (reservoir/school/hospital): 50/40 dBA
- **LGU (Local Government Unit)** enforcement at city/municipality level

Notable noise zones:

- **EDSA (Epifanio de los Santos Avenue)** — Metro Manila's main circumferential road, 200,000+ vehicles/day at peak sections, flanked by MRT 3 elevated viaduct
- **Taft Avenue / LRT 1 elevated corridor** (Baclaran ↔ Roosevelt)
- **Commonwealth Avenue / Quezon Avenue** — wide arterials in Quezon City
- **Commonwealth-MRT 7 corridor** (under construction)
- **SLEX (South Luzon Expressway)** and **NLEX (North Luzon Expressway)** — interurban freight corridors
- **Subic-Clark-Tarlac Expressway (SCTEX)** — heavy container freight to/from Clark and Subic ports
- **Manila International Airport (NAIA / RPLL)**, **Cebu-Mactan (CEB / RPVM)**, **Davao (DVO / RPMD)** — covered by the global aircraft layer
- **Limay Petron Refinery (Bataan)** and **Tabangao Shell Refinery (Batangas)** — major industrial noise
- **Sual coal power complex** (Pangasinan), **Masinloc coal power complex** (Zambales)
- **Tiwi/Mak-Ban/Palinpinon geothermal fields** — steam venting noise
- **Bangui wind farm** (Ilocos Norte) — a tourist landmark as well
- **Jeepney + tricycle** traffic in Metro Manila — acoustic character unique to Philippine urban zones (open-sided vehicles with loud diesel engines)
