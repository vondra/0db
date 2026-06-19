---
title: Australia
intro: Noise mapping data sources for Australia.
map: { center: [134.0, -25.0], zoom: 4 }
---

## Road traffic

Australia has no national HPMS-equivalent. Each state Department of Transport publishes traffic counts separately:

| State | Source | Format |
|---|---|---|
| **NSW** | [Transport for NSW](https://opendata.transport.nsw.gov.au/) yearly summary CSV (49 MB) + station reference | CSV + lat/lon |
| **Victoria** | [DTP Historical AADT](https://discover.data.vic.gov.au/dataset/historical-annual-average-daily-traffic-volume) GeoJSON (32 MB, 2019) | GeoJSON linestrings |
| **Queensland** | [TMR Traffic Census](https://www.data.qld.gov.au/dataset/traffic-census-for-the-queensland-state-declared-road-network) CSV | CSV (CloudFront WAF) |
| **WA** | [Main Roads Traffic Digest](https://catalogue.data.wa.gov.au/dataset/mrwa-traffic-digest) ArcGIS Hub | GeoJSON |
| **SA** | [DIT Traffic Volumes](https://data.sa.gov.au/data/dataset/traffic-volumes) Shapefile (4.4 MB) | SHP |

All 5 state sources are CC-BY 4.0 and have been verified working. **Per-state aggregation script not implemented** in this enrichment pass — Australian roads currently use OSM `maxspeed` + class defaults. Implementing the per-state AADT aggregator would unlock road traffic noise for ~95% of Australian population.

## Railway

### State-level multi-feed GTFS

Australia has 5 major rail-operating states. The pipeline applies state-level GTFS feeds:

| Operator | State | Coverage | Source |
|---|---|---|---|
| **Sydney Trains + NSW TrainLink + Sydney Metro + light rail** | NSW | Sydney metropolitan + intercity (Newcastle, Wollongong, Blue Mountains, Goulburn) | [opendata.transport.nsw.gov.au](https://opendata.transport.nsw.gov.au/) (310 MB) |
| **Metro Trains Melbourne + V/Line + Yarra Trams** | VIC | Melbourne suburban + Victorian regional + Melbourne tram (largest tram network in the world) | continental europe transit (au-vic) |
| **Translink Brisbane City Train + Gold Coast G:link + Cairns Cityrail** | QLD | Brisbane suburban + Gold Coast LRT + Cairns | continental europe transit (au-qld) |
| **Transperth Trains + Bus + Ferry** | WA | Perth suburban (5 lines) | [transperth.wa.gov.au](https://www.transperth.wa.gov.au/) (29.8 MB) |
| **Adelaide Metro Trains + Tram + Bus** | SA | Adelaide suburban + city tram | [gtfs.adelaidemetro.com.au](https://gtfs.adelaidemetro.com.au/) (12.8 MB) |

- **Script**: `pipeline/enrich-railway-au.ts`
- **Result**: 19,171 newly matched + 9,785 pre-existing preserved = 28,956 segments enriched in 73 hexes
- **Busiest hubs**:
  - **Beresfield/Thornton/Metford Stations** (NSW Hunter Line, Newcastle area) — 1,208 trains/day
  - **Telarah Station** (NSW) — 1,014 trains/day
  - **Adelaide Railway Station** — 673 trains/day

### City coverage

| City | % Enriched | Max trains/day |
|---|---|---|
| Brisbane | 52.2% | 423 (Translink) |
| Adelaide | 48.1% | 673 (Adelaide Railway Station) |
| Sydney | 27.8% | 562 (Sydney Trains) |
| Perth | 24.9% | 467 (Transperth) |
| Newcastle | 14.5% | 617 (Hunter Line) |
| Melbourne | 8.8% | 386 (Metro Trains) |
| Canberra | 2.0% | 6 (light rail only) |

## Buildings

GHSL Built-H R2023A 100 m global raster + Overture Maps Foundation building footprints (already in `/enrich-global`). Overture's 2026 release covers Australia fully via the Microsoft + Google + OSM merge. Geoscape Buildings (paid subscription) and PSMA cadastre are the authoritative Australian sources but not openly downloadable.

## Industrial

### Power plants — GEM

`pipeline/enrich-industrial-au.ts` filters the **GEM Global Integrated Power** database to Australia (822 operating plants) and stamps a power-generation NACE class onto the nearest OSM industrial site. (The global GPPD pass via `/enrich-global` also contributes.) Major sources of industrial noise:

- **Coal**: Eraring (NSW, ~2,880 MW — largest single plant), Bayswater (NSW), Loy Yang A/B (VIC), Callide (QLD), Stanwell (QLD), Vales Point (NSW), Mt Piper (NSW), Tarong (QLD)
- **Gas**: Torrens Island (SA), Darling Downs (QLD), Tallawarra (NSW), Hallett (SA), Kwinana (WA)
- **Hydroelectric**: Snowy 2.0 (under construction, NSW), Murray, Tumut, Gordon (Tasmania)
- **Wind**: Stockyard Hill (VIC), Macarthur (VIC), Snowtown (SA), Hornsdale (SA), Coopers Gap (QLD), Cathedral Rocks (SA), Collgar (WA)

### Wind turbines

Australia has ~10 GW installed wind capacity. **CER (Clean Energy Regulator)** publishes accredited power stations weekly CSV at [cer.gov.au](https://cer.gov.au/document/power-stations-and-projects-accredited) but only includes postcode-level location (no lat/lon, no per-turbine data).

OSM has good wind turbine coverage including major farms (Hornsdale, MacArthur, Snowtown, Coopers Gap). Used as primary source via `/enrich-global` global wind turbine pass.

### NPI (gap)

National Pollutant Inventory (NPI) at [data.gov.au/data/dataset/043f58e0](https://data.gov.au/data/dataset/043f58e0-a188-4458-b61c-04e5b540aea4) provides ~4,000 reporting facilities with coordinates and ANZSIC 2006 codes. Direct CSV download available (3.2 MB) but not yet implemented — would require ANZSIC → NACE crosswalk mapping.

## Validation

Australia does not implement END (the EU Environmental Noise Directive). Noise regulation is fragmented:

- **NEPM** (National Environment Protection Measure) for ambient noise
- **State EPA noise guidelines** — NSW EPA, EPA Victoria, Queensland DES, WA DWER, EPA SA
- **Airservices Australia ANEF** (Australian Noise Exposure Forecast) — airport noise contours, gated behind $5,950 AUD subscription
- **Council bylaws** — Sydney, Melbourne, Brisbane, Perth, Adelaide publish urban noise complaint data

The Sydney inner suburbs (Western Sydney M5/M7 motorways), Melbourne CBD trams, and Perth Mitchell Freeway are notable noise corridors documented in state EPA reports.
