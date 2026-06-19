---
title: Slovakia
intro: Noise mapping data sources for Slovakia.
map: { center: [19.7, 48.7], zoom: 7 }
---

## Railway

### ZSR GTFS

National railway timetable from [Železnice Slovenskej republiky](https://www.zsr.sk/).

- **Source**: NKOD national open-data portal (`data.slovensko.sk`) — the old direct `zsr.sk/files/…/gtfs.zip` endpoint went dead in 2026-06
- **Coverage**: 2,297 rail routes, 885 stops, 800 with train counts
- **Result**: 35,706 railway segments enriched across 53 hexes
- **Busiest stations**: Bratislava hl.st. 385 trains/day, Košice 235, Žilina 226, Trnava 224
- **License**: Open (data.slovensko.sk)

## Road traffic

Slovak [SSC (Slovenská správa ciest)](https://www.ssc.sk/) publishes traffic census data (CSD 2022-2023) but **only as PDF files per municipality** — not machine-readable. The ~2,752 counting profiles cannot be programmatically matched to OSM roads without manual PDF parsing or requesting CSV data from `cestna.databanka@ssc.sk`.

**Current status**: OSM road class defaults applied. No per-segment AADT enrichment.

## Industrial

- **E-PRTR** (European Pollutant Release and Transfer Register) — NACE 2-digit sector codes for Slovak industrial facilities (U. S. Steel Košice, Slovnaft refinery, cement, aluminium) via `/enrich-continent europe`
- **GPPD power plants** (NACE 35) via `/enrich-global`
- Slovak national PRTR (SHMÚ) not yet separately investigated

## Buildings

- Overture Maps global baseline only
- GKÚ cadastre likely requires license

## Validation

Slovakia implements END via Zákon č. 2/2005 Z.z. o posudzovaní a kontrole hluku. Strategic noise maps are produced by ÚRSO for major roads, railways, and airports.
