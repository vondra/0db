---
title: Greece
intro: Noise mapping data sources for Greece.
map: { center: [23.7, 38.5], zoom: 7 }
---

## Railway

### Hellenic Train (TrainOSE, archived 2019)

Cached GTFS from TrainOSE (now Hellenic Train after FS Italiane acquisition in 2022).

- **Coverage**: 52 rail routes, 220 stops (Athens, Thessaloniki, regional)
- **Result**: 4,944 railway segments enriched across 34 hexes
- **Busiest**: Αθήνα (Athens) 112 trains/day, Άγιοι Ανάργυροι 96
- **Note**: 2019 archived data — Hellenic Train does not publish current GTFS. Routes haven't changed significantly.

## Road traffic

Greek road authority publishes only aggregate statistics. OSM defaults applied.

## Industrial

- **GPPD power plants** (NACE 35) via `/enrich-global` — thermal stations and the large lignite plants of Western Macedonia (Ptolemaida/Kozani).
- **E-PRTR** — Greek facilities receive NACE 2-digit sector codes via `/enrich-continent europe` (cement, metals, refining, etc.).

## Validation

Greece implements END via Joint Ministerial Decision 211773/2012. Strategic noise maps produced by the Ministry of Environment.
