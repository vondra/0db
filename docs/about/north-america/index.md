---
title: North America
intro: Noise mapping overview for North America — USWTDB wind turbines + Amtrak/VIA Rail enrichment.
map: { center: [-100, 45], zoom: 3 }
---

## Data situation

North America has good global baseline coverage plus specific enrichments for US wind turbines and intercity rail.

## Continental enrichment

### Applied datasets

| Dataset | Coverage | Impact | Status |
|---------|----------|--------|--------|
| **Amtrak GTFS** | US intercity rail (520 stops) | Railway segments get real train frequencies | Applied — 34.8K segments |
| **VIA Rail GTFS** | Canadian intercity rail (313 stops) | Railway segments get real train frequencies | Applied — with Amtrak batch |
| **USWTDB** | 75,728 US wind turbines | Correct hub height + rated power | Applied in /enrich-global |
| **GPPD** | US/CA/MX power plants | NACE 35 industrial classification | Applied in /enrich-global |
| **Overture Buildings** | US cities (NYC 86%, Chicago 78%, Toronto 79%) | Per-building screening heights | Applied in /enrich-global |

### Amtrak (US)

Source: Amtrak GTFS (archived Oct 2021 via OpenMobilityData). 520 stops, 608 daily trains. Busiest: Chicago Union Station (269 trains/day), Penn Station NYC (202/day). Amtrak routes are stable year-to-year so archived data provides good frequency estimates.

### VIA Rail (Canada)

Source: VIA Rail GTFS from viarail.ca (current). 313 stops, 64 daily trains across the Toronto-Montreal-Ottawa corridor and transcontinental routes. Busiest: Toronto (45/day), Kingston (30/day), Ottawa/Montreal (28/day).

### Datasets cached for per-country enrichment

| Dataset | Coverage | Format | Records | For |
|---------|----------|--------|---------|-----|
| **HPMS** | US road AADT per segment | GeoJSON via REST API (geo.dot.gov) | Millions | `/enrich-roads us` |
| **FRA Grade Crossings** | US railroad crossings with train freq | CSV (datahub.transportation.gov) | 438K | `/enrich-railway us` |
| **EPA ECHO** | US regulated industrial facilities | CSV ZIP (echo.epa.gov, 438 MB) | 1.5M+ | `/enrich-industrial us` |

### Known gaps

- **HPMS road AADT**: Available via geo.dot.gov ArcGIS REST API (no registration) but requires per-state crawling with pagination. Deferred to `/enrich-roads us`.
- **Mexico**: CDMX has city-level GTFS but no national data. Connection timeouts from our server.
- **US commuter rail**: Only Amtrak intercity rail is enriched. City commuter rail needs per-operator GTFS feeds.
- **Canadian roads**: No national traffic count data. StatCan transit database exists but connection timed out.

## What the map uses

- **DEM**: Copernicus GLO-30 (30m) — terrain diffraction
- **Buildings**: GHSL 100m + Overture Maps 30m for major US/Canadian cities
- **Forest**: ESA WorldCover 10m — vegetation attenuation
- **Ground**: WorldCover-derived G-factor (no Copernicus IMD outside Europe)
- **Wind turbines**: USWTDB (75.7K US turbines with hub height + rated power)
- **Industrial**: GPPD power plants (NACE 35)
- **Railway**: Amtrak + VIA Rail real train frequencies; all other rail uses OSM defaults
- **Traffic**: OSM road class defaults (no AADT enrichment yet)

## Methodology

Same as global: CNOSSOS-EU emission + ISO 9613-2 propagation.
