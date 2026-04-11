---
title: Hungary
intro: Noise mapping data sources for Hungary.
map: { center: [19.5, 47.2], zoom: 7 }
---

## Railway

### MÁV GTFS

National railway timetable from [MÁV-START](https://www.mavcsoport.hu/) covering MÁV + GYSEV services.

- **Source**: Community mirror at gtfs.menetbrand.com/download/mav/ (official endpoint requires auth)
- **Coverage**: 9,700 rail routes, 1,198 stops, 1,120 with train counts
- **Result**: 24,887 railway segments enriched across 65 hexes
- **Busiest**: Budapest-Nyugati 555 trains/day, Budapest-Kelenföld 518, Keleti 389
- **License**: Open (MÁV publishes GTFS for developers)

## Road traffic

Magyar Közút publishes annual traffic reports only in PDF/aggregate form. No per-segment AADT CSV or shapefile found. OSM road class defaults applied.

## Industrial

- GPPD power plants (NACE 35)

## Buildings

- Overture Maps global baseline only

## Validation

Hungary implements END via Kormányrendelet 280/2004. Strategic noise maps produced by ITM (Ministry of Innovation and Technology) for major roads, railways, and Budapest agglomeration.
