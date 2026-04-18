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

- **[CIS JR (Centrální informační systém jízdních řádů)](https://portal.cisjr.cz/pub/draha/celostatni/szdc/2026/)** — JR2026.zip national timetable: 13,252 train XML definitions, 8,556 trains running on a typical weekday, parsed into 6,742 station-pair segments (173,689 total passenger train movements per day)
- **Matching**: CZPTT station codes matched to OSM railway stations by name, adjacent station-pair segments mapped to OSM railway geometry by GPS triangulation
- **Result**: 528,123 Czech railway segments enriched with real passenger train counts (34.7% coverage on segments in matched hexes)
- **Busiest**: Praha hl.n. ↔ Pha hl.n. Lc105-102 at 276 trains/day, Brno hl.n. přednádr. ↔ Brno hl.n. at 246/day
- **[SŽ maximum line speeds](https://provoz.spravazeleznic.cz/portal/Show.aspx?path=/Data/Mapy/rychlosti.pdf)** — "Největší traťové rychlosti" map, used alongside OSM `maxspeed` tags
- **Speed-dependent emission** using CNOSSOS-EU Annex IV / RMR: `Lw'/m = Lw0 + 10·log₁₀(Q / (T·1000·v)) + 30·log₁₀(v/v_ref)` where `Q` = trains in the period (daily count split 65/20/15 day/evening/night), `T` = period hours, `v` = line speed in km/h. See `engine/noise-compute/SPEC.md §2` for the full derivation.
- Typical Czech corridor speeds: I. corridor (Praha–Brno) up to 160 km/h, regional lines 80–100 km/h, tram 40–60 km/h
- Vehicle mapping: RegioPanter/RegioShuttle → RMR Cat-8a (disc-braked EMU), older coaches → Cat-1 (cast iron), freight → Cat-4 (block-braked wagons — realistic for current Czech fleet)

### Freight data gap

The CIS JR JR2026.zip dataset contains **passenger trains only** (all 13,252 files are `PA_` prefix = passenger). Freight timetables (GVD) are managed internally by Správa železnic and **not publicly distributed** as machine-readable data. Only aggregated annual statistics are available in PDF form (Statistická ročenka SŽ).

For now, `trains_freight` remains 0 in the enriched data. CNOSSOS-EU defaults are applied for major freight corridors (Děčín–Praha–Břeclav E65, Praha–Plzeň–Cheb E55, Brno–Přerov–Ostrava E30). The Czech freight fleet remains predominantly RMR Cat-4 (block-braked wagons).

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

- **[Copernicus GLO-30 DEM](https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model)** — 30 m global DEM from TanDEM-X (<4 m LE90 accuracy), with [SRTM](https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-shuttle-radar-topography-mission-srtm-1) as fallback
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
