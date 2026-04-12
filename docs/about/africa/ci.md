---
title: Côte d'Ivoire
intro: Noise mapping data sources for Côte d'Ivoire.
map: { center: [-5.5, 7.5], zoom: 6 }
---

## Road traffic

### Class defaults only

AGEROUTE-CI (Agence de Gestion des Routes) publishes no open AADT. Fall back to CNOSSOS class defaults with Abidjan Tier-1 boost.

### Ivorian AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (A1 Abidjan-Yamoussoukro, A3 Abidjan-Bassam) | 28,000 | 56,000 | 39,200 |
| 1 trunk (A-routes + major nat'l) | 10,000 | 20,000 | 14,000 |
| 2 primary | 5,000 | 10,000 | 7,000 |
| 3 secondary | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,200 | 2,400 | 1,680 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metros** (×2.0, 1 metro): **Abidjan** (~5-6M, Ébrié Lagoon, **Africa's 4th largest francophone city** after Kinshasa/Casablanca/Algiers — economic capital of Côte d'Ivoire; Yamoussoukro is the official political capital since 1983).

**Tier-2 cities** (×1.4, 20 cities): **Yamoussoukro** (official political capital, **Basilique de Notre-Dame de la Paix** — world's largest basilica), **Bouaké** (2nd city, cocoa hub), Daloa (cocoa belt), **San Pédro** (world's largest cocoa export port), Korhogo (northern hub), Man (western mountains), Divo, Gagnoa, Abengourou, Anyama, **Grand-Bassam** (UNESCO colonial capital), Bingerville, Agboville, Odienné, Bondoukou, Soubré, Sassandra, Ferkessédougou, Dabou, Adzopé.

### Ivorian vehicle split

Côte d'Ivoire's urban transport mixes minibuses and shared taxis more than motorcycles:

- **Gbaka** — informal minibus taxis of Abidjan periphery, ~14 seat
- **Woro-Woro** — shared taxis, yellow + **commune-color-coded** (classic Abidjan)
- **Orange taxis** — city taxis, metered
- **SOTRA** — Société des Transports Abidjanais (official city buses + **Bateaux-Bus lagoon ferries** connecting Plateau ↔ Treichville ↔ Yopougon ↔ Abobo across Ébrié Lagoon)
- **Abidjan BRT** — under construction, not yet operating
- **Moto-taxis (Zémidjan)** — less dominant than in Benin/Togo but growing

| Tier | Light | Medium (Gbaka/SOTRA) | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Abidjan) | 60% | **16%** | 13% | 11% |
| Tier-2 | 60% | 12% | 16% | 12% |
| Rural | 55% | 10% | 25% | 10% |
| **A1 Abidjan↔Yamoussoukro motorway** | 70% | 7% | **17%** | 6% |

### National route network

- **A1** Abidjan ↔ Yamoussoukro ↔ Tiébissou — **Côte d'Ivoire's flagship motorway** (~230 km)
- **A3** Abidjan ↔ Grand-Bassam ↔ Aboisso ↔ Ghana border (coastal east)
- **A100** Yamoussoukro ↔ Bouaké extension (ongoing)
- **RN1** Abidjan ↔ Yamoussoukro ↔ Bouaké ↔ Ferkessédougou ↔ Burkina border (main north trunk)
- **RN2** Yamoussoukro ↔ Daloa ↔ Man ↔ Guinea border (western mountains)
- **RN7** Abidjan ↔ San Pédro (cocoa export corridor)

## Railway

### Class defaults + corridor bbox boosts

### Ivorian rail context

- **Sitarail Abidjan ↔ Ouagadougou Railway** — **1,260 km, meter gauge**, built 1905-1954 by French colonial Empire. Only operating rail line in Côte d'Ivoire. Operated by **Sitarail** (Bolloré Africa Logistics → Africa Global Logistics / MSC) under 1995 concession. **West Africa's most important inland freight corridor**, linking landlocked Burkina Faso to Abidjan port. Carries cotton, cattle, fuel, cement, vehicles. Passenger service 2-3 trains/week (overnight Abidjan ↔ Ouagadougou). Key CI cities served: Agboville → Dimbokro → Bouaké → Katiola → Ferkessédougou.
- **Abidjan Metro Line 1** — under construction, 37.9 km N↔S (Anyama ↔ Port-Bouët airport). French consortium (Bouygues/Colas/Alstom/Keolis/RATP), ~$1.9B, originally planned 2019 but delayed to **~2026-2027**. Standard gauge, electrified. **NOT YET OPERATING**.
- **San Pédro planned freight rail** — to open up nickel/iron mines in western mountains. Not yet built.

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Sitarail main line** (Abidjan↔Bouaké↔Burkina) | 1 | 6 |
| Other | 0 | 1 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 42 plants, 13 operating

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Côte d''Ivoire'` (note escaped apostrophe)

**Operating fuel**: oil/gas 6 + hydropower 5 + solar 2.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Azito** | **713** (460+253) | oil/gas CCGT | Azito district Abidjan — **Côte d'Ivoire's largest thermal plant**. Globeleq/IFC. Phase 1 1999 + phase 4 2015 |
| **CIPREL** | **366** (255+111) | oil/gas | Compagnie Ivoirienne de Production d'Électricité, Vridi Abidjan — ENI/EDF/IFC consortium |
| **Soubré** | 275 | hydropower | Sassandra River, **opened 2017** — Côte d'Ivoire's newest major hydro (China-financed, Sinohydro built) |
| **Taabo** | 210 | hydropower | Bandama River, 1979 |
| **Agrekko Vridi** | 200 (2× 100) | oil/gas | Emergency rental gas, Vridi Abidjan |
| **Kossou** | 174 | hydropower | Bandama River, 1972. **Lake Kossou** is Côte d'Ivoire's largest artificial lake (1,780 km²) |
| **Buyo** | 165 | hydropower | Sassandra River, 1980 |
| **Gribo-Popoli** | 112 | hydropower | Sassandra River, opened 2021 |
| **Boundiali Solar** | 38 | solar | **Côte d'Ivoire's first utility-scale solar farm**, opened 2023 |
| Savanes Solar | 19.7 | solar | |

**Azito + CIPREL + Agrekko** thermal cluster in Abidjan's Vridi/Azito district = **1,279 MW concentrated gas generation** — largest thermal cluster in francophone West Africa. CCGT plants use natural gas from offshore Foxtrot field + new Baleine field (ENI discovery 2021-2023, first production 2023).

**Sassandra River hydro cascade** = Buyo 165 + Gribo-Popoli 112 + Soubré 275 = **552 MW** along one river, Côte d'Ivoire's main hydro artery.

All operating plants map to **NACE 35**.

### Côte d'Ivoire does NOT have

- **No AGEROUTE-CI traffic data** — zero open AADT
- **No Sitarail GTFS** — freight schedules not public
- **SIR refinery not NACE 19**: Société Ivoirienne de Raffinage, Vridi/Abidjan, **~80,000 bpd**, Côte d'Ivoire's only oil refinery — **supplies fuel for 7 West African countries** (Burkina Faso, Mali, Niger, etc.)
- **Cement plants not NACE 23**: LafargeHolcim, SCA (Société des Ciments d'Abidjan)
- **Cocoa processing not NACE 10**: Yopougon and San Pédro — Côte d'Ivoire is the **world's #1 cocoa producer (~40% of global supply, ~2.2 Mtpa)**
- **Palm oil** (Palmci, Sania) and **rubber** (SAPH, SOGB) processing not classified — Côte d'Ivoire is Africa's #1 rubber producer
- **Offshore oil/gas fields** (Foxtrot, **Baleine — ENI major 2021-2023 discovery**, first production 2023)
- **Port of Abidjan** — West Africa's 2nd largest container port after Lagos
- **Port of San Pédro** — **world's largest cocoa export port**
- **Lake Kossou** dam/reservoir

## Validation

Côte d'Ivoire implements environmental protection via:

- **ANDE** (Agence Nationale de l'Environnement) — EIA and environmental permitting
- **CIAPOL** (Centre Ivoirien Anti-Pollution) — pollution monitoring
- **Code de l'Environnement (1996)** — Loi n° 96-766 du 3 octobre 1996
- Noise standards: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60

Notable noise zones:

- **A1 Abidjan ↔ Yamoussoukro motorway** — flagship corridor
- **RN1 Abidjan ↔ Yamoussoukro ↔ Bouaké ↔ Ferkessédougou ↔ Burkina** — main north trunk
- **Abidjan Plateau + Treichville + Yopougon + Abobo + Cocody + Marcory** — dense urban core
- **Sitarail corridor** (Abidjan ↔ Bouaké ↔ Burkina) — parallel to RN1
- **Félix-Houphouët-Boigny International (ABJ/DIAP Abidjan)**, **Yamoussoukro (ASK/DIYO)**, **Bouaké (BYK/DIBK)**, **San Pédro (SPY/DISP)**, **Korhogo (HGO/DIKO)**, **Man (MJC/DIMN)** — covered by global aircraft layer
- **Azito + CIPREL + Agrekko Vridi thermal cluster** (1,279 MW concentrated in Abidjan's Vridi/Azito district)
- **Soubré + Buyo + Gribo-Popoli hydros** (Sassandra River cascade)
- **Kossou + Taabo hydros** (Bandama River)
- **SIR refinery Vridi** (80k bpd, supplies 7 West African countries)
- **Port of Abidjan** — West Africa's 2nd largest container port
- **Port of San Pédro** — world's largest cocoa export port
- **Yopougon industrial zone** (Abidjan's main manufacturing cluster)
- **Cocoa processing plants** (San Pédro, Yopougon)
- **LafargeHolcim / SCA cement plants**
