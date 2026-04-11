---
title: Poland
intro: Noise mapping data sources for Poland.
map: { center: [19.4, 52.0], zoom: 6 }
---

## Road traffic

### GDDKiA Generalny Pomiar Ruchu (GPR) 2020/2021

[GDDKiA](https://www.gov.pl/web/gddkia) (Generalna Dyrekcja Dróg Krajowych i Autostrad) runs the **Generalny Pomiar Ruchu** — a 5-yearly nationwide traffic census on motorways, expressways, and national roads. Provincial roads (DW) are surveyed in parallel.

- **Source**: [gov.pl/web/gddkia/generalny-pomiar-ruchu-20202021](https://www.gov.pl/web/gddkia/generalny-pomiar-ruchu-20202021)
- **National roads**: 2,290 measurement points (A motorways, S expressways, DK national roads), full vehicle class split (motorcycles, cars, light trucks, trucks without/with trailer, buses)
- **Provincial roads**: 3,124 segments on DW network — XLS only, no geometry (matched by ref + proximity)
- **Result**: 1,225,790 newly enriched road segments + 659,116 preserved continental EU city traffic
- **Top corridors**: S8 around Warszawa 197k veh/day, A4 motorway 105k, S2 Warszawa southern bypass 114k, A2 east-west 100k
- **Coverage**: 255 of 287 Polish hexes updated (88.8%)

### EU city traffic (continental)

Cerema-aggregated EU AADT for Warszawa, Kraków, Wrocław via `/enrich-continent europe`.

### Gaps

GPR does not cover "miasta na prawach powiatu" (cities with county rights — urban arterials in Warszawa, Kraków, Łódź, Wrocław, Gdańsk, Poznań, Katowice). Local sources (ZTM/ZDM) are fragmented and largely PDF-only.

## Railway

Five Polish rail/metro/tram GTFS feeds are merged for railway enrichment:

| Operator | Coverage | Source |
|---|---|---|
| **Polish Trains unified** | PKP Intercity, PolRegio, Koleje Mazowieckie, Koleje Śląskie, Koleje Dolnośląskie, Koleje Wielkopolskie, Koleje Małopolskie, ŁKA, SKM Trójmiasto, SKM Warszawa, Arriva — single daily-updated feed | [mkuran.pl/gtfs/polish_trains.zip](https://mkuran.pl/gtfs/polish_trains.zip) |
| **Warszawa ZTM** | Warszawa tram + 2 metro lines | [mkuran.pl/gtfs/warsaw.zip](https://mkuran.pl/gtfs/warsaw.zip) (101 MB) |
| **Kraków ZTP** | Kraków tram (28 lines) | [gtfs.ztp.krakow.pl/GTFS_KRK_T.zip](https://gtfs.ztp.krakow.pl/GTFS_KRK_T.zip) |
| **GZM Silesia** | Górnośląska Metropolia tram + bus (Katowice, Sosnowiec, Bytom, Gliwice, Zabrze, Chorzów, Świętochłowice) | [mkuran.pl/gtfs/gzm.zip](https://mkuran.pl/gtfs/gzm.zip) |
| **WKD** | Warszawska Kolej Dojazdowa (suburban Pruszków-Grodzisk-Milanówek) | [mkuran.pl/gtfs/wkd.zip](https://mkuran.pl/gtfs/wkd.zip) |

The unified `polish_trains.zip` is maintained by Mikołaj Kuranowski from PKP PLK Open Data API + Koleje Mazowieckie BIP. It is updated **daily**.

- **Merged**: 4,572 unique stops
- **Result**: 165,092 newly matched + 343,920 pre-existing preserved across 208 hexes
- **Busiest stops**:
  - Warszawa Wschodnia — 933 trains/day (PKP IC + KM + SKM hub)
  - Warszawa Zachodnia — 919 trains/day
  - Czerwone Maki P+R (Kraków) — 799 trains/day (tram terminus)
  - Klimeckiego (Kraków) — 786 trains/day (tram interchange)
  - Katowice Rondo — 768 trains/day (Silesian tram hub)

### City coverage

| City | % Enriched | Max trains/day |
|---|---|---|
| Kraków | 51.2% | 786 |
| Warszawa | 39.1% | 933 |
| Katowice | 34.6% | 768 |
| Gdańsk | 20.1% | 566 |
| Wrocław | 14.4% | 628 |
| Łódź | 13.1% | 387 |
| Poznań | 9.6% | 583 |
| Bydgoszcz | 8.5% | 225 |
| Szczecin | 7.3% | 218 |

### Gaps

- **PKP Cargo freight schedules** are not in any public GTFS feed (same as CZ). Polish freight corridors (E20 Berlin-Warszawa-Moscow, E30 Wrocław-Katowice, E59 Poznań-Wrocław, E65 Gdynia-Warszawa-Katowice-Vienna) use OSM defaults for freight loading.
- **Metro Warszawskie** (lines M1+M2) are partially covered via Warsaw ZTM feed but the bulk of Warsaw rail noise comes from PKP intercity + commuter, which IS covered.

## Buildings

OSM `building:levels` tag (extracted directly during osm-to-h3r4) provides substantial coverage in Polish cities thanks to Polish OSM community quality:

- **Warszawa**: 74% of buildings have floor counts
- **Łódź / Poznań / Gdańsk**: 25-50% coverage
- **Kraków / Wrocław / Katowice**: 15-25% coverage
- **Smaller cities and rural areas**: GHSL Built-H R2023A 100 m raster fallback

Polish national cadastre (BDOT10k, EGiB) is geo-portal protected and not openly downloadable.

## Industrial

- **E-PRTR**: ~1,500 Polish facilities receive NACE 2-digit codes via `/enrich-continent europe`. Major emitters (KGHM Polska Miedź copper smelters, ArcelorMittal steel mills, Lafarge cement, JSW coal mines, BOT Bełchatów lignite power plant — Europe's largest CO₂ emitter) are correctly classified.
- **Power plants**: Bełchatów, Kozienice, Opole, Turów, Połaniec lignite/coal plants — all covered by WRI Global Power Plant Database via `/enrich-global`.
- **Wind turbines**: Poland has ~7-8 GW installed wind capacity (10th in EU). URE (Urząd Regulacji Energetyki) wind installation registry returns HTTP 403 to programmatic requests, so per-turbine specs are not enriched. ~7,155 OSM wind turbines, ~52% have specs (from cross-border MaStR/USWTDB matches + OSM tags).

## Validation

Poland implements END (Environmental Noise Directive 2002/49/EC) via the Environmental Protection Act (Prawo ochrony środowiska). Strategic noise maps for agglomerations >100k inhabitants and major roads/railways/airports are produced by:

- **GIOŚ** (Główny Inspektorat Ochrony Środowiska) — national aggregator
- **Marshal offices (Urzędy Marszałkowskie)** of voivodeships — regional coordination
- **City offices** — Warszawa, Kraków, Łódź, Wrocław, Poznań, Gdańsk, Szczecin, Bydgoszcz, Lublin, Katowice publish per-municipality strategic noise maps

The Silesian conurbation (Katowice, Sosnowiec, Bytom, Gliwice, Zabrze) is one of Europe's most noise-affected metropolitan areas due to combined road + rail + heavy industry exposure.
