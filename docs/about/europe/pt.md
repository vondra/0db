---
title: Portugal
intro: Noise mapping data sources for Portugal.
map: { center: [-8.0, 39.5], zoom: 7 }
---

## Road traffic

### EU city traffic (continental)

Portugal does **not publish open per-segment AADT data** at the national level. Infraestruturas de Portugal (IP) publishes only the road geometry SHP (`Rede Rodoviária Nacional`); IMT (Instituto da Mobilidade e dos Transportes) publishes quarterly aggregate reports as PDF only; Brisa (motorway concessionaire) publishes annual statistics as PDF.

Lisboa and Porto are covered by the Cerema-aggregated EU city traffic dataset via `/enrich-continent europe` — providing AADT + HGV share for major urban segments. Outside these cities, road traffic uses OSM `maxspeed` + class defaults.

## Railway

Four Portuguese rail/metro GTFS feeds are merged for railway enrichment:

| Operator | Coverage | Source |
|---|---|---|
| **CP — Comboios de Portugal** | National rail (Alfa Pendular high-speed, intercity, regional, Cascais/Sintra/Sado/Algarve commuter) | [publico.cp.pt/gtfs](https://publico.cp.pt/gtfs/gtfs.zip) |
| **Metro do Porto** | 6-line light metro (yellow, blue, green, red, violet, orange) | Mobility Database mdb-2357 |
| **Metro Sul do Tejo (MTS)** | Almada/Seixal light rail | [mts.pt/imt](https://mts.pt/imt/MTS-20240129.zip) |
| **Carris Metropolitana** | Lisboa metropolitan area (bus-only — no rail in feed) | [api.carrismetropolitana.pt/v2/gtfs](https://api.carrismetropolitana.pt/v2/gtfs) |

- **Merged**: 558 unique stops
- **Result**: 22,428 segments enriched across 39 hexes
- **Busiest hubs**:
  - Trindade (Porto) — 1,151 trains/day (Metro do Porto interchange)
  - Lapa, Casa da Música, Carolina Michaelis (Porto) — 736 trains/day each
  - Bento Gonçalves, Almada, S. João Baptista (Metro Sul Tejo) — 490 trains/day each

### City coverage

| City | % Enriched | Max trains/day |
|---|---|---|
| Porto | 51.1% | 1,151 |
| Braga | 44.1% | 68 |
| Lisboa/Almada | 35.0% | 490 |
| Coimbra | 29.6% | 150 |
| Faro | 28.5% | 53 |
| Setúbal | 10.3% | 90 |
| Évora | 8.0% | 22 |

### Rail GTFS gaps

- **Fertagus** (Lisboa Sul Pragal–Setúbal) — operates trains across the 25 de Abril bridge but has no separate open GTFS (covered partially by CP/Carris feeds)
- **Metro de Lisboa** (4 lines) — no open GTFS feed in Mobility Database for rail-route enrichment

## Buildings

GHSL Built-H R2023A 100 m global raster only. Portugal does **not publish a unified building cadastre with floor counts or heights**. The DGT (Direção-Geral do Território) Carta de Áreas Edificadas 2018 contains built-area polygons only — no heights. INE Censos 2011 building data is aggregated to BGRI/freguesia level, not per-building.

## Industrial

- **E-PRTR**: Portuguese facilities receive NACE 2-digit codes via `/enrich-continent europe`
- **Power plants**: Cogeneration plants, hydroelectric stations, the Galp Sines refinery — covered by WRI Global Power Plant Database via `/enrich-global`. (The Galp Matosinhos refinery and the Pego coal plant both closed in 2021; the WRI snapshot may still list them, but they no longer contribute active noise.)
- **Wind turbines**: ~5.5 GW installed capacity across 250+ wind parks (4th in EU per capita). DGEG does not publish per-turbine open data — all turbines use OSM defaults

## Validation

Portugal implements END (Environmental Noise Directive 2002/49/EC) via Decree-Law 146/2006. Strategic noise maps for agglomerations >100k inhabitants are produced by:

- **APA** (Agência Portuguesa do Ambiente) — national aggregator
- **Câmaras Municipais** — Lisboa, Porto, Coimbra, Braga, Aveiro, Setúbal, Funchal publish per-municipality strategic noise maps
- **Plano de Acção contra o Ruído (PACR)** — local action plans for hot zones

The 25 de Abril bridge (Lisboa) is one of Portugal's most studied rail noise sources due to combined road + rail traffic.
