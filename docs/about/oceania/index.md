---
title: Oceania
intro: Noise mapping overview for Oceania — Australian rail enrichment + Overture building heights.
map: { center: [140, -25], zoom: 3 }
---

## Data situation

Australia has excellent open data infrastructure — GTFS feeds are freely available for most states. New Zealand data exists but URLs have changed. Pacific Island nations have no transit data.

## Continental enrichment

### Applied datasets

| Dataset | Coverage | Impact | Status |
|---------|----------|--------|--------|
| **PTV Metro Trains** | Melbourne metro + V/Line regional (109 stops) | Real train frequencies | Applied — 16.7K segments |
| **TransLink QLD** | Brisbane CityTrain + QR regional (331 stops) | Real train frequencies | Applied — with VIC batch |
| **Overture Buildings** | Sydney 57.7% height coverage | Per-building screening heights | Applied in /enrich-global |

### Victoria (Melbourne)

Source: PTV (Public Transport Victoria) GTFS from data.ptv.vic.gov.au. 13 rail routes, 109 stops, 392 daily trains. Busiest: Southern Cross Station (386 trains/day), Footscray (289), Sunshine (228).

### Queensland (Brisbane / SEQ)

Source: TransLink GTFS from translink.com.au. 682 rail routes (CityTrain + QR regional), 331 stops, 843 daily trains. Busiest: South Brisbane (423 trains/day), Fortitude Valley (269), Bowen Hills (268).

### Known gaps

- **NSW (Sydney)** — Transport for NSW GTFS requires API key registration at opendata.transport.nsw.gov.au. Would cover Sydney Trains, NSW TrainLink, Sydney Metro.
- **South Australia (Adelaide)** — GTFS URL changed (404). Adelaide Metro has limited rail.
- **Western Australia (Perth)** — Transperth GTFS URL changed (404). Perth has Transperth rail.
- **New Zealand** — Auckland AT GTFS and Wellington Metlink both returned 404/timeout. NZ has good open data but URLs change frequently.
- **Pacific Islands** — No transit data.

## What the map uses

- **DEM**: Copernicus GLO-30 (30m) — terrain diffraction
- **Buildings**: GHSL 100m + Overture Maps 30m (Sydney 57.7% height coverage)
- **Forest**: ESA WorldCover 10m — vegetation attenuation
- **Ground**: WorldCover-derived G-factor
- **Industrial**: GPPD power plants — AU 203, NZ 34 plants
- **Railway**: Melbourne Metro + Brisbane CityTrain real frequencies; other rail uses OSM defaults
- **Traffic**: OSM road class defaults (no AADT enrichment)

## Per-country enrichment priority

1. **Australia (NSW)** — Sydney Trains GTFS (needs API registration). NSW has the most rail traffic in AU.
2. **New Zealand** — Find current GTFS URLs for Auckland AT and Wellington Metlink.
3. **Australia (WA/SA)** — Find current Perth Transperth and Adelaide Metro GTFS URLs.

## Methodology

Same as global: CNOSSOS-EU emission + ISO 9613-2 propagation.
