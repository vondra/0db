---
title: Cyprus
intro: Noise mapping data sources for Cyprus.
map: { center: [33.4, 35.1], zoom: 9 }
---

## Railway

**Cyprus has no railway network.** The Cyprus Government Railway closed in 1951 and no replacement has been built. Public transport is entirely bus-based.

## Road traffic

Cyprus public works department does not publish per-segment AADT. OSM road class defaults applied. Cyprus is car-dependent with dense road networks around Nicosia, Limassol, Larnaca, and Paphos.

## Public transit (bus)

Five GTFS feeds available from motionbuscard.org.cy covering all districts:
- OSYPA (Paphos)
- OSEA (Famagusta)
- NPT (Nicosia)
- LPT (Larnaca)
- Intercity buses

Not applied to noise map (buses are not separate emission source in our CNOSSOS-EU model — their contribution is included in aadt_medium road traffic).

## Industrial

- GPPD power plants (NACE 35)

## Validation

Cyprus implements END via the Law on Assessment and Management of Environmental Noise. Strategic noise maps produced by the Department of Labour Inspection for major roads and airports.
