---
title: United Kingdom
intro: Noise mapping data sources for the United Kingdom.
map: { center: [-2.5, 54.5], zoom: 6 }
---

## Road traffic

### DfT AADF (Annual Average Daily Flow)

National road traffic statistics from [Department for Transport](https://roadtraffic.dft.gov.uk/).

- **Coverage**: 44,319 count points across all road types (M, A, B, C, unclassified)
- **Vehicle classes**: cars + taxis, LGVs, buses + coaches, 6 HGV subcategories, motorcycles
- **Coordinates**: WGS84 (native)
- **Years**: 2000-2024 (most recent year per count point used)
- **Result**: 2,392,032 road segments enriched (14.8% of all UK road segments)
- **License**: Open Government Licence v3.0
- **Top AADF**: M25 at 210,436 vehicles/day, M60 at 192,025, M1 at 179,502

### EU city traffic (from /enrich-global)

London, Birmingham, Manchester, Glasgow, Edinburgh, Cardiff AADT from EU harmonized dataset. 95,100 segments.

## Railway

UK rail GTFS requires registration with ATOC/RSP (data.atoc.org). Not yet applied. National Rail Open Data (opendata.nationalrail.co.uk) also requires registration.

## Industrial

- GPPD power plants (NACE 35)
- REPD (Renewable Energy Planning Database) available but not yet processed

## Buildings

- Overture Maps: London 65.5% building height coverage
- OS Buildings: Requires Ordnance Survey license

## Validation

UK implements END via The Environmental Noise (England) Regulations 2006. Defra produces strategic noise maps for major roads, railways, airports, and agglomerations. Scottish, Welsh, and NI governments produce their own maps.
