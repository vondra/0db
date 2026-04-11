---
title: Israel
intro: Noise mapping data sources for Israel.
map: { center: [35.0, 31.5], zoom: 7 }
---

## Road traffic

### No per-segment AADT in open form

Israel publishes traffic data but no per-segment AADT:

- **NTRA (Netivei Israel)** at [iroads.co.il](https://www.iroads.co.il/) — Imperva-gated (HTTP 403 to programmatic requests)
- **gov.il** — Cloudflare-gated (HTTP 403)
- **data.gov.il "sfirot" (ספירות תנועה)** — only 7,594 ad-hoc 15-minute traffic surveys with ITM coordinates. Too sparse for national segment-level coverage.

Israeli roads currently use OSM `maxspeed` + class defaults.

## Railway

### Israeli MoT unified GTFS

The Israeli Ministry of Transport publishes a single unified GTFS containing **all Israeli public transport** in one file (~154 MB), updated daily.

- **Source**: [data.gov.il](https://www.gov.il/he/pages/gtfs_general_transit_feed_specifications) → Mobility Database mirror [mdb-2519](https://storage.googleapis.com/storage/v1/b/mdb-latest/o/il-ministry-of-transport-and-road-safety-gtfs-2519.zip?alt=media) (origin returns HTML)
- **Operators**:
  - **Israel Railways (רכבת ישראל)** — national heavy rail (Tel Aviv ↔ Haifa, Tel Aviv ↔ Jerusalem high-speed, Beer Sheva, Modi'in, Carmiel, BGN Airport)
  - **Tel Aviv Light Rail (NTA)** — Red Line (opened 2023, Petah Tikva ↔ Bat Yam, future Purple/Green lines)
  - **Jerusalem Light Rail (CityPass)** — Red Line (Mount Herzl ↔ Heil HaAvir)
  - **Egged, Dan, Metropoline, Kavim, Superbus** — bus operators (excluded from rail enrichment)
- **Filtered**: 1,214 rail/tram routes from 7,988 total
- **Result**: 169 unique rail/tram stops, 6,703 segments enriched in 10 hexes
- **Busiest hubs**:
  - **תל אביב מרכז (Tel Aviv Savidor Center)** — 470 trains/day
  - **תל אביב ההגנה (Tel Aviv HaHagana)** — 448 trains/day
  - **השלום (HaShalom)** — 448 trains/day
  - **תל אביב אוניברסיטה (Tel Aviv University)** — 404 trains/day
  - **הרצליה (Herzliya)** — 358 trains/day
- **License**: Open data Israeli MoT (CC-BY)

The Israeli rail network is concentrated along the coastal Tel Aviv ↔ Haifa corridor, with the Jerusalem high-speed line (opened 2018), Beer Sheva spur, and Carmiel/Modi'in branches. Tel Aviv Light Rail Red Line connects 4 city centers along its 24 km route.

## Buildings

GHSL Built-H R2023A 100 m global raster + Overture Maps Foundation building footprints (already in `/enrich-global`). Israel's Survey of Israel (Mapi) cadastre is auth-gated.

## Industrial

### Power plants — GPPD

WRI Global Power Plant Database via `/enrich-global` covers Israeli plants:

- **Coal**: Hadera (Orot Rabin, 2.6 GW — Israel's largest), Rutenberg (Ashkelon)
- **Gas**: Reading (Tel Aviv), Eshkol, Tzafit, Hagit, Alon Tavor, Dorad
- **Nuclear**: None (Israel has no civilian nuclear power plants)
- **Solar**: Ashalim CSP (240 MW — Negev desert), various PV
- **Wind**: Emek HaBacha (Golan Heights) — minimal (~0.4 GW total)

### data.gov.il factory registry (gap)

- **`factory`** resource (UUID `88d1883c-3b7a-4580-9be9-6d54659666c3`) — 25,136 industrial site coordinates (ITM EPSG:2039) from Ministry of Environmental Protection
- **`maflasmultiannualforzover`** (UUID `7ad8ddc7-87f4-45f9-84e4-d7f972662153`) — 7,247 PRTR-equivalent declarants with NACE sector codes but no coordinates

Available via CKAN API but not yet implemented — would require ITM → WGS84 reprojection + factory↔PRTR name join for NACE codes.

## Validation

Israel's [Ministry of Environmental Protection (MoEP / המשרד להגנת הסביבה)](https://www.gov.il/en/departments/ministry_of_environmental_protection) regulates noise via:

- **Noise Prevention Regulations 2014** under the Abatement of Nuisances Law
- **Israel Standard 5237** for road traffic noise
- **MoEP noise maps** for major cities — published as static PDFs, not bulk GIS data
- **Tel Aviv Municipality** publishes urban noise complaints via [tel-aviv.gov.il](https://www.tel-aviv.gov.il/) but Hebrew-only

Notable noise zones include Highway 4 (Tel Aviv ↔ Hadera), Highway 1 (Tel Aviv ↔ Jerusalem), and the Tel Aviv Savidor rail interchange (470 trains/day).
