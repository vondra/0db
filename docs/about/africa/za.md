---
title: South Africa
intro: Noise mapping data sources for South Africa.
map: { center: [24, -29], zoom: 5 }
---

## Road traffic

### Road defaults

South Africa publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by South Africa's traffic factor **≈ 1.115** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.115 ≈ 33,450 |
| Trunk | 15,000 × 1.115 ≈ 16,725 |
| Primary | 9,000 × 1.115 ≈ 10,035 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **N1** — Cape Town ↔ Beaufort West ↔ Bloemfontein ↔ Johannesburg ↔ Pretoria ↔ Polokwane ↔ Beitbridge (Zimbabwe border). Main north-south route, 1,985 km.
- **N2** — Cape Town ↔ George ↔ Port Elizabeth ↔ East London ↔ Durban ↔ Richards Bay ↔ Mozambique border. Coastal route, 2,253 km.
- **N3** — Durban ↔ Pietermaritzburg ↔ Harrismith ↔ Johannesburg. **Busiest freight corridor** (container + general freight from Durban port).
- **N4** — Maputo (Mozambique) ↔ Witbank ↔ Pretoria ↔ Botswana border (**Trans-Kalahari Highway**, Platinum Toll Road).
- **N5** Bethlehem ↔ Winburg · **N6** Bloemfontein ↔ East London · **N7** Cape Town ↔ Namibia · **N8** Bloemfontein ↔ Maseru · **N9** George ↔ Graaff-Reinet · **N10** PE ↔ Upington · **N11** Durban ↔ Mokopane · **N12** CT ↔ Witbank · **N14** Pretoria ↔ Springbok · **N17** Jhb ↔ Ermelo

## Railway

### No open rail geometry — OSM + corridor bbox defaults

Transnet Freight Rail (TFR, ~20,000 route-km), PRASA, Metrorail, and Gautrain all publish zero open geometry. University of Pretoria has a small Gauteng-only Metrorail dataset (14 lines) but it's bounded to Gauteng.

### Key South African rail corridors

- **Sishen-Saldanha Iron Ore Line (OREX)** — 861 km heavy haul, 40,000-tonne / 342-car trains. **World's most intensive iron ore railway.** Kumba Iron Ore (Sishen + Kolomela) → Saldanha Bay port.
- **Coal Line (N-line / "Coalex")** — 580 km Ermelo ↔ Richards Bay Coal Terminal (RBCT), ~80 Mtpa capacity.
- **NATCOR** — 700 km Durban ↔ Johannesburg container + general freight (busiest corridor).
- **Cape Mainline (CapeCor)** — Cape Town ↔ Johannesburg via Beaufort West ↔ Kimberley.
- **Metrorail Gauteng** — Johannesburg/Pretoria commuter (degraded post-2018).
- **Metrorail Western Cape** — Cape Town Southern/Northern/Central lines (best-maintained).
- **Metrorail KZN** — Durban commuter (**mostly non-operational post-2020** due to vandalism).
- **Metrorail Eastern Cape** — Port Elizabeth, very limited.
- **Gautrain** — 80 km high-speed commuter (OR Tambo ↔ Sandton ↔ Pretoria), opened 2010.

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints. eThekwini publishes 846,698 Durban building footprints but not integrated (Overture covers ZA globally).

## Industrial

### Eskom Power Stations (University of Pretoria mirror)

- **Source**: `services8.arcgis.com/ZhTpwEGNVUBxG9VW/arcgis/rest/services/Power_Stations/FeatureServer/0`
- **Owner**: `christel.hansen_uparcgis` (University of Pretoria GIS Research Group)
- **Records**: 33 Eskom power stations with `NAME`, `CATEGORY`, `LOAD_MW`

### Top operating Eskom plants

| Plant | MW | Category |
|---|---:|---|
| **Medupi** | 4,788 | BASELOAD COAL (Lephalale, Waterberg) |
| **Kusile** | 4,500 | COAL (Mpumalanga, Nkangala) |
| **Kendal** | 4,116 | BASELOAD COAL (Mpumalanga) |
| **Majuba** | 4,110 | BASELOAD COAL (Mpumalanga) |
| **Matimba** | 3,990 | BASELOAD COAL (Lephalale) |
| **Lethabo** | 3,708 | BASELOAD COAL (Free State) |
| **Tutuka** | 3,654 | BASELOAD COAL (Mpumalanga) |
| **Duvha** | 3,600 | BASELOAD COAL (Mpumalanga) |
| **Matla** | 3,600 | BASELOAD COAL (Mpumalanga) |
| **Kriel** | 3,000 | BASELOAD COAL (Mpumalanga) |
| **Arnot** | 2,100 | BASELOAD COAL (Mpumalanga) |
| **Hendrina** | 2,000 | BASELOAD COAL (Mpumalanga) |
| **Koeberg** | 1,800 | **BASELOAD NUCLEAR (Cape Town — Africa's only operating nuclear plant)** |
| **Camden** | 1,600 | STANDBY COAL |
| **Ingula** | 1,352 | PUMPED STORAGE |

**Mpumalanga Highveld** hosts the largest cluster of coal-fired plants in the world (~33 GW total installed coal-fired capacity).

### GEM Global Integrated Power August 2025

- **Source**: `services.arcgis.com/lqRTrQp2HrfnJt8U/arcgis/rest/services/Global_Integrated_Power_August_2025/FeatureServer/0?where=Country_area='South Africa'`
- **Records**: 502 total, **314 operating**
- **Operating fuel**: solar 151 (REIPPPP program since 2011) + coal 90 + wind 38 + oil 20 + hydro 7 + gas 6 + nuclear 2

### GEM Global Coal Mines 2024

- **Source**: `services7.arcgis.com/IyvyFk20mB7Wpc95/arcgis/rest/services/Global_Coal_Mines_2_view/FeatureServer/0?where=Country='South Africa'`
- **Records**: **137 coal mines** (79 Operating, 36 Proposed, 13 Mothballed)
- Geographic distribution: mostly **Mpumalanga Highveld Coalfield** (Emalahleni/Witbank) + **Limpopo Waterberg Coalfield** (Lephalale/Medupi area)
- All map to **NACE 05** (Mining of coal and lignite)

### South Africa does NOT have

- **No open SANRAL road data** — no TPDA/AADT anywhere
- **No open Transnet rail geometry** — OSM only
- **No Sasol Secunda polygon** — world's largest coal-to-liquids plant (~160k bpd oil-equivalent), only OSM tagging
- **No PGM/gold/iron ore mining registry** — Bushveld Complex platinum, Witwatersrand gold, Sishen iron ore rely on OSM only
- **No PRASA/Metrorail/Gautrain GTFS**

## Validation

South Africa implements noise regulation via:

- **SANS 10103** (South African Bureau of Standards) — ambient noise standards:
  - Residential day/night: 50/40 dBA (rural), 55/45 dBA (urban)
  - Commercial: 60/50 dBA
  - Industrial: 65/55 dBA
- **Department of Environmental Affairs (DEA)** — National Environmental Management: Air Quality Act (2004)
- **South African National Standards SANS 10103:2008** — noise impact assessment methodology
- **Provincial Environmental Implementation Plans**

Notable noise zones:

- **N3 Durban ↔ Johannesburg** — busiest freight corridor, ~50,000+ trucks/day container traffic
- **N1 Johannesburg ↔ Pretoria** — urban freeway, one of ZA's busiest
- **N2 Durban coastal ↔ Richards Bay** — industrial port access
- **N4 Maputo ↔ Pretoria ↔ Rustenburg** — Platinum Toll Road
- **Golden Highway / Ben Schoeman Highway** — Johannesburg arterials
- **R21 / M3 / M4** — Gauteng highways
- **OR Tambo International (JNB/FAOR Johannesburg)**, **Cape Town International (CPT/FACT)**, **King Shaka International (DUR/FALE Durban)**, **Chief Dawid Stuurman International (PLZ/FAPE Port Elizabeth)**, **Bram Fischer International (BFN/FABL Bloemfontein)**, **Lanseria (HLA/FALA)**, **Kruger Mpumalanga (MQP/FAKN Nelspruit)** — covered by global aircraft layer
- **Metrorail Gauteng Johannesburg↔Pretoria corridor** — commuter rail (degraded)
- **Gautrain** (OR Tambo ↔ Sandton ↔ Johannesburg ↔ Pretoria)
- **Sishen-Saldanha Iron Ore Line (OREX)** — 861 km, world's most intensive iron ore railway
- **Coal Line Ermelo↔Richards Bay** — 580 km heavy coal corridor
- **Mpumalanga Highveld coal cluster**: Medupi (4.8 GW) + Kusile (4.5 GW) + Kendal (4.1 GW) + Majuba (4.1 GW) + Matimba (4.0 GW) + Lethabo (3.7 GW) + Tutuka (3.7 GW) + Duvha (3.6 GW) + Matla (3.6 GW) + Kriel (3.0 GW) + Arnot (2.1 GW) + Hendrina (2.0 GW) — **largest cluster of coal plants in the world**
- **Koeberg Nuclear Power Station** (Cape Town, 1,800 MW — **Africa's only operating nuclear plant**)
- **Ingula Pumped Storage** (1,352 MW, KZN)
- **Sasol Secunda coal-to-liquids complex** (Mpumalanga) — world's largest CTL plant
- **Richards Bay Coal Terminal** (KZN) — world's largest coal export terminal
- **Saldanha Bay iron ore terminal** (Western Cape) — endpoint of OREX line
- **Bushveld Complex PGM mining** (Rustenburg/Limpopo) — world's largest platinum group metal reserves
- **Witwatersrand gold belt** (Johannesburg/Carletonville/Welkom)
- **Sishen iron ore mine** (Northern Cape, Kumba Iron Ore)
- **Grootegeluk coal mine** (Lephalale, feeds Medupi + Matimba)
- **Richards Bay Coal Terminal (RBCT)** coal export facility
