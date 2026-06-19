---
title: Estonia
intro: Noise mapping data sources for Estonia.
map: { center: [25.0, 58.6], zoom: 7 }
---

## Railway & transit

### Peatus.ee national transit

Estonian Transport Administration publishes all national transit as a single GTFS feed.

- **Source**: `peatus.ee/gtfs/gtfs.zip`
- **Coverage**: Elron national rail (27 routes) + Tallinn trams (5 routes) + 9 ferries + 2,278 bus routes
- **Stops**: 18,412 (314 rail/tram with train counts)
- **Result**: 3,918 railway/tram segments enriched across 21 hexes
- **Busiest**: Tondi 388 trains/day (Tallinn tram), Kadriorg 378, Hobujaama 310
- **License**: Open (Transpordiamet)

## Road traffic

Transpordiamet publishes only aggregate statistics. OSM defaults applied.

## Industrial

- **GPPD power plants** (NACE 35) via `/enrich-global` — the Narva oil-shale stations (Eesti, Balti) dominate Estonian generation.
- **E-PRTR** — Estonian facilities receive NACE 2-digit sector codes via `/enrich-continent europe` (oil-shale processing, cement, chemicals).

## Validation

Estonia implements END via the Atmospheric Air Protection Act. Strategic noise maps produced by the Ministry of Climate.
