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
| **US/CA/MX road AADT** | US (HPMS, class-gated), Canada (Quebec), Mexico | Major roads get real traffic counts instead of defaults | Applied |
| **Amtrak GTFS** | US intercity rail (520 stops) | Railway segments get real train frequencies | Applied — 34.8K segments |
| **VIA Rail GTFS** | Canadian intercity rail (313 stops) | Railway segments get real train frequencies | Applied — with Amtrak batch |
| **Mexico urban rail** | CDMX GTFS (metro / light rail) | Urban rail segments get real train frequencies | Applied |
| **USWTDB** | 75,728 US wind turbines | Correct hub height + rated power | Applied in /enrich-global |
| **GPPD** | US/CA power plants (Mexico uses GEM) | NACE 35 industrial classification | Applied in /enrich-global |
| **Overture Buildings** | US cities (NYC 86%, Chicago 78%, Toronto 79%) | Per-building screening heights | Applied in /enrich-global |

### Amtrak (US)

Source: Amtrak GTFS (archived Oct 2021 via OpenMobilityData). 520 stops, 608 daily trains. Busiest: Chicago Union Station (269 trains/day), Penn Station NYC (202/day). Amtrak routes are stable year-to-year so archived data provides good frequency estimates.

### VIA Rail (Canada)

Source: VIA Rail GTFS from viarail.ca (current). 313 stops, 64 daily trains across the Toronto-Montreal-Ottawa corridor and transcontinental routes. Busiest: Toronto (45/day), Kingston (30/day), Ottawa/Montreal (28/day).

### Datasets cached for further per-country enrichment

| Dataset | Coverage | Format | Records | For |
|---------|----------|--------|---------|-----|
| **FRA Grade Crossings** | US railroad crossings with train freq | CSV (datahub.transportation.gov) | 438K | `/enrich-railway us` |
| **EPA ECHO** | US regulated industrial facilities | CSV ZIP (echo.epa.gov, 438 MB) | 1.5M+ | `/enrich-industrial us` |

### Known gaps

- **US commuter rail**: Only Amtrak intercity rail is enriched. City commuter rail needs per-operator GTFS feeds.
- **US freight rail counts**: FRA grade-crossing train frequencies are cached but not yet folded into rail emission.

## What the map uses

Global baseline (GLO-30 DEM, Overture/GHSL buildings, WorldCover forest + ground) applies everywhere — see [main methodology](/about). North-America-specific enrichment:

- **Traffic**: US (HPMS, class-gated), Canada (Quebec), and Mexico road AADT on major roads; minor roads use class defaults.
- **Railway**: Amtrak + VIA Rail + Mexico urban rail (CDMX + Toluca GTFS) real train frequencies; all other rail uses OSM defaults.
- **Wind turbines**: USWTDB (75.7K US turbines with hub height + rated power)
- **Buildings**: Overture Maps 30m height for major US/Canadian cities on top of GHSL 100m baseline.

## Per-country enrichment status

1. **Guatemala** ✅ — 53 GEM plants / 2,783 MW. Chixoy 300 MW hydro. Sugar bagasse cogeneration (15 plants). FEGUA railway defunct 2007. Chicken buses + mototaxis. **2.69M roads (94%)**. See [Guatemala](gt).
2. **Honduras** ✅ — 44 plants / 2,721 MW. El Cajón hydro. Maquila/banana. CA-5 corridor 45% heavy. **1.39M roads (73%)**. See [Honduras](hn).
3. **El Salvador** ✅ — 60 plants / 2,563 MW. **World #9 geothermal** (Ahuachapán, Berlín). Bitcoin legal tender. **73k roads (9% — GT overlap)**. See [El Salvador](sv).
4. **Nicaragua** ✅ — 31 plants / 1,033 MW. San Jacinto-Tizate geothermal. Lake Nicaragua. **297k roads (33%)**. See [Nicaragua](ni).
5. **Costa Rica** ✅ — 45 plants / 2,514 MW. **99% renewable!** Reventazón 305 MW. No army since 1948. **715k roads (97%)**. See [Costa Rica](cr).
6. **Panama** ✅ — 70 plants / 3,711 MW. **Panama Canal.** Fortuna 300 MW. Panama Metro 2014. **436k roads (92%)**. See [Panama](pa).
7. **Cuba** ✅ — 38 plants / 2,891 MW. Soviet-era thermal. **Only Caribbean operational railway** (Havana↔Santiago). Vintage cars. **699k roads (100%)**. See [Cuba](cu).
8. **Jamaica** ✅ — 13 plants / 885 MW. Bauxite/alumina. Old Harbour oil. Left-hand drive. **501k roads (100%)**. See [Jamaica](jm).
9. **Haiti** ✅ — **0 GEM plants.** Poorest Western Hemisphere. Tap-tap buses. **488k roads (98%)**. See [Haiti](ht).
10. **Dominican Republic** ✅ — 73 plants / 6,132 MW. **Largest Caribbean fleet.** Santo Domingo Metro 2009. Punta Cana. **949k roads (94%)**. See [Dominican Republic](do).
11. **Trinidad and Tobago** ✅ — 17 plants / 2,057 MW. Point Lisas complex. Atlantic LNG. **0 roads (VE overlap)**. See [Trinidad and Tobago](tt).
12. **Bahamas** ✅ — 2 plants / 184 MW. 700 islands. Tourism/cruise. **1.07M roads (77%)**. See [Bahamas](bs).
13. **Barbados** ✅ — 11 plants / 83 MW. Smallest area enriched (432 km²). **23k roads (100%)**. See [Barbados](bb).

