---
title: Czech Republic
intro: Noise mapping data sources and validation for Czechia.
map: { center: [15.5, 49.8], zoom: 7 }
---

## Road traffic data

- **[Czech Road and Motorway Directorate (ŘSD)](https://www.rsd.cz/)** — [National traffic census](https://scitani.rsd.cz/) (Celostátní sčítání dopravy) with vehicle counts, speed, and heavy vehicle share for all classified roads (motorways, class I, II, III)
- **OpenStreetMap** — Road geometry, surface type, and speed limits
- Traffic volumes are assigned to road segments using ŘSD census points and interpolation

## Railway data

- **Czech Railway Infrastructure Administration (SŽ)** — Track geometry and classification
- **[SŽ daily train counts](https://provoz.spravazeleznic.cz/portal/ViewArticle.aspx?oid=2104272)** — "Počty vlaků" maps with actual daily train frequencies per line segment (2020–2025), used to calibrate emission tiers
- **[SŽ maximum line speeds](https://provoz.spravazeleznic.cz/portal/Show.aspx?path=/Data/Mapy/rychlosti.pdf)** — "Největší traťové rychlosti" map, used alongside OSM `maxspeed` tags
- **OpenStreetMap** — Railway lines with type (main, regional, tram), `usage` (main/branch/industrial), and `maxspeed` tags
- **Speed-dependent emission** using CNOSSOS-EU Annex IV / RMR: `Lw/m = Lw0 + 10·log₁₀(Q) + 30·log₁₀(v/v_ref)` where Q = trains/day from SZ data, v = line speed
- Tier classification: high-speed corridor (250 trains/day, ≥120 km/h), main line (100 trains/day, ≥80 km/h), regional (40 trains/day), branch (20 trains/day), freight industrial (3 trains/day)
- Typical Czech corridor speeds: I. corridor (Praha–Brno) up to 160 km/h, regional lines 80–100 km/h, tram 40–60 km/h
- Vehicle mapping: RegioPanter/RegioShuttle → RMR Cat-8a (disc-braked EMU), older coaches → Cat-1 (cast iron), freight → Cat-4 (block-braked wagons — realistic for current Czech fleet)
- Freight composition uses RMR Cat-4: block-braked wagons are still the majority of Czech freight fleet

## Industrial data

- **OpenStreetMap** — Industrial/commercial landuse polygons with `industrial=*` sub-tags (factory, warehouse, sawmill, scrap_yard, wastewater_plant, etc.)
- **[IRZ (Integrovaný registr znečišťování)](https://www.irz.cz/)** — Czech Integrated Pollution Register: ~3,400 regulated facilities with GPS coordinates and CZ-NACE sector codes, spatially joined to OSM polygons for sector-differentiated emission levels
- **[SHM 2022 industrial contours](https://geoportal.mzcr.cz/server/rest/services/SHM2022/INSPIRE/MapServer)** — Official industrial noise contours in 6 agglomerations (Praha, Brno, Ostrava, Plzeň, Olomouc, Liberec), used for model calibration and validation

## Wind turbines

- **OpenStreetMap** — ~260 wind turbines in Czech Republic with hub height, rotor diameter, and rated power metadata
- Emission model: literature-based Lw by rated power class (IEC 61400-11)

## Aircraft data

- **OpenSky Network** — Historical ADS-B trajectories over Czech airspace
- Flight paths, altitudes, and aircraft types extracted for noise computation
- Airport noise contours validated against official SHM measurements

## Terrain elevation

- **[DMR 5G](https://geoportal.cuzk.cz/) ([ČÚZK](https://www.cuzk.cz/))** — Czech national DEM at 5 m resolution, derived from airborne LiDAR
- Critical for accurate terrain diffraction — Czech landscape has many valleys and ridges that significantly affect noise propagation

## Noise barriers

- **SHM barrier database** — Known noise wall locations along major roads and railways
- **OpenStreetMap** — Additional barrier data from community mapping
- Barriers can reduce noise by 5–15 dB depending on height and position

## Reference measurements and validation

- **[Strategic Noise Maps (SHM)](https://shm.env.cz/) / [CENIA](https://www.cenia.cz/)** — Official strategic noise maps used as validation reference
- Target accuracy: mean absolute error below 3 dB compared to SHM reference data
- Validation runs automatically after each model update
- **[Prague Geoportal](https://atlas.geoportalpraha.cz/)** — Prague noise maps with layers:
  - Noise level — day (6:00–22:00) and night (22:00–6:00) per Czech national definition (differs from END standard 07–19/19–23/23–07; Quiet Map uses the END periods for its own Lden calculation)
  - Strategic noise map 2022 (SHM) — Ldvn bands (day) and Ln bands (night)
  - Useful for per-street validation in Prague area

## Real estate

Sources updated twice daily via cron:

| Source | Type | Listings | Notes |
|--------|------|----------|-------|
| [Sreality.cz](https://sreality.cz) | Agency listings | ~27k land plots | Largest CZ portal, owned by Seznam.cz |
| [Bezrealitky.cz](https://bezrealitky.cz) | Direct sellers | ~1.5k land plots | No agency fees (TODO: API integration) |

Categories: stavební pozemky, lesy, louky, pole, zahrady, komerční.

Properties displayed on the map with noise level at their location.
Default filter: properties below 45 dB Lden (WHO outdoor guideline).
Only listings with verified GPS coordinates are included.
