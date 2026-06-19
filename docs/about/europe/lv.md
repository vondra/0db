---
title: Latvia
intro: Noise mapping data sources for Latvia.
map: { center: [24.1, 56.9], zoom: 7 }
---

## Railway

### Pasažieru Vilciens (Vivi)

Latvian national rail operator from [Pasažieru Vilciens](https://www.vivi.lv/).

- **Source**: Mobility Database cached feed (data.gov.lv)
- **Coverage**: 49 rail routes, 137 stops
- **Result**: 4,965 railway segments enriched across 23 hexes
- **License**: Open (data.gov.lv)

## Road traffic

LVC (Latvijas valsts ceļi) publishes only aggregate statistics. OSM defaults applied.

## Industrial

- **GPPD power plants** (NACE 35) via `/enrich-global` — the Rīga TEC-1/TEC-2 CHP stations and the Daugava hydro cascade (Pļaviņas, Rīga, Ķegums).
- **E-PRTR** — Latvian facilities receive NACE 2-digit sector codes via `/enrich-continent europe`.

## Validation

Latvia implements END via the Environmental Protection Law. Strategic noise maps produced by the State Environmental Service.
