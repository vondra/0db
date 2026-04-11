---
title: Romania
intro: Noise mapping data sources for Romania.
map: { center: [25.0, 46.0], zoom: 7 }
---

## Railway

### CFR Călători XML timetables (cached, not yet parsed)

Romania publishes railway timetables as custom XML on [data.gov.ro](https://data.gov.ro). Five operators covered:

- SNTFC CFR Călători (national passenger rail)
- Regio Călători
- Interregional Călători
- Softrans S.R.L.
- Transferoviar Călători

Format is NOT GTFS — requires custom parser using schema `trnIfSchema_v4.xsd`. Cached at `data/enrichment/2025/ro/cfr-calatori-2025-2026.xml` (12 MB). Parsing deferred to future work.

## Road traffic

No public source found for per-segment AADT. CNAIR publishes END noise maps but no traffic count data. OSM road class defaults applied.

## Industrial

- GPPD power plants (NACE 35)

## Validation

Romania implements END via Hotărârea Guvernului 321/2005. Strategic noise maps produced by CNAIR for major roads and railways, by local authorities for agglomerations.
