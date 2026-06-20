---
title: Mozambique
intro: Noise mapping data sources for Mozambique.
map: { center: [36, -18], zoom: 5 }
---

## Road traffic

### Road defaults

Mozambique publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Mozambique's traffic factor **≈ 1.157** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.157 ≈ 34,710 |
| Trunk | 15,000 × 1.157 ≈ 17,355 |
| Primary | 9,000 × 1.157 ≈ 10,413 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **EN1** — **coastal N↔S trunk**, Maputo to Pemba (~2,500 km — **Mozambique's backbone**, parts not continuously paved)
- **EN6 Beira Corridor** — Beira ↔ Chimoio ↔ Machipanda (Zimbabwe border)
- **EN7** — Tete ↔ Changara ↔ Nyamapanda (Zimbabwe border), plus coal trucks from Moatize
- **EN10** — Maputo ↔ Ressano Garcia (RSA border)
- **N4 / CN4 Maputo Corridor** — toll motorway (TRAC concession, continuous with RSA N4 Johannesburg-Komatipoort)

## Railway

### Mozambican rail context

Mozambique has **3 completely separate rail networks** — a legacy of Portuguese colonial planning where each port served a different hinterland without internal connection. Total ~3,000 km with no cross-network interchange between south/center/north.

### CFM-South (Southern Network) — Maputo + Matola
- **Ressano Garcia Line** — Maputo ↔ Moamba ↔ Ressano Garcia ↔ Komatipoort (RSA, Johannesburg main line). **Busiest rail line in Mozambique**. Cape gauge.
- **Goba Line** — Maputo ↔ Goba ↔ Mbabane (Eswatini)
- **Limpopo Line** — Maputo ↔ Chibuto ↔ Chicualacuala (Zimbabwe border). Alternative to RSA Beitbridge for Zimbabwe freight.
- **Maputo commuter rail** — small CFM Sul suburban service

### CFM-Central (Beira Corridor)
- **Machipanda Line / Beira Corridor** — Beira ↔ Dondo ↔ Chimoio ↔ Machipanda ↔ Zimbabwe (Harare main line). **Key export route for landlocked Zimbabwe and Zambia**. Historically strategic during Rhodesian sanctions era.
- **Sena Line** — Beira ↔ Dondo ↔ Marromeu ↔ Dona Ana ↔ Moatize (Tete coal basin). **Rehabilitated 2010 by Vale** for Moatize coal export. Crosses Zambezi at historic Sena Bridge.

### CFM-North (Nacala Corridor) — the newest major African rail
- **Nacala Corridor** — Nacala port ↔ Nampula ↔ Cuamba ↔ Entre Lagos (Malawi border) ↔ **through Malawi** ↔ re-enters MZ at Moatize (Tete coal basin)
- **912 km total** across MZ+MW+MZ
- **Built 2014-2017 by Vale** for Moatize coal export via Nacala deep-water port, bypassing the Beira Sena Line bottleneck
- **Africa's largest privately-financed rail project of the 2010s**
- Now operated by **Vulcan International** (Jindal Steel/Power, took over from Vale 2021)
- **Nacala ↔ Cuamba passenger train** — one of few operating passenger services in MZ (~2 per week)

**No metros, no trams** in any Mozambican city.

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 78 plants, 12 operating, ~2.94 GW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Mozambique'`

**Operating fuel**: oil/gas 5 + solar 4 + hydropower 3.

**Cahora Bassa alone accounts for ~70% of Mozambique's installed capacity** — extreme concentration of generation on a single Zambezi River plant.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Cahora Bassa** | **2,075** | hydropower | **Zambezi River, Tete province** — **one of Africa's largest hydropower**, built 1969-1979 by Portuguese colonial govt. **Exports majority of power to South Africa** via Apollo HVDC link (Matimba↔Apollo, 533 kV — one of world's earliest major HVDC transmission systems, commissioned 1979) |
| **Ressano Garcia** | 175 | oil/gas | Matola — Sasol-linked, supplies Maputo thermal |
| **Karpowership "Mehmet Bey"** | 125 | oil/gas | **Turkish floating powership**, anchored off Nacala (Cabo Delgado) |
| **Maputo** | 121 | oil/gas | Maputo thermal |
| **Gigawatt Park** | 119 | oil/gas | Matola — IPP |
| **Gigawatt Mozambique** | 117 | oil/gas | Ressano Garcia — IPP |
| **Mavuzi** | 52 | hydropower | Smaller Zambezi tributary |
| **Chicamba** | 44 | hydropower | Smaller hydro |
| **Metoro Substation Solar** | 41 | solar | Cabo Delgado |
| **Mocuba Solar** | 40 | solar | Zambezia |
| **Cuamba Solar** | 19 | solar | Niassa |
| **Balama Graphite Mine Solar** | 11 | solar | On-site Syrah Resources mine |

**Under construction (not counted)**:
- **Mphanda Nkuwa ~1,500 MW** — Zambezi, planned next mega-dam, ~100 km downstream of Cahora Bassa

All operating plants map to **NACE 35**.

### Mozambique does NOT have

- **No ANE AADT** — zero open traffic data
- **No CFM GTFS** — all timetables corporate HTML only
- **Mozal Aluminium Smelter** (Matola) not NACE 24 — **Africa's largest aluminium smelter**, ~580 ktpa, started 2000 by BHP Billiton (now South32). Paradoxically uses power from South African grid (reverse of Cahora Bassa export flow to South Africa)
- **Moatize Coal Basin** (Tete) not NACE 05 — **world-class coking coal**, Vale operated 2011-2021, now Vulcan International (Jindal Steel/Power)
- **Mozambique LNG / Area 1 / Golfinho-Atum** (TotalEnergies, offshore Rovuma basin, Cabo Delgado) — **~$20B project**, paused since March 2021 due to Cabo Delgado insurgency (Palma attack), resuming 2024/2025
- **Coral South FLNG** (ENI, offshore Rovuma) — **first LNG operation 2022**, floating liquefaction (only 2nd FLNG in Africa after Cameroon's Kribi)
- **Sasol Temane gas** (Inhambane) — supplies gas to Sasol Secunda (RSA) via 900 km pipeline
- **Kenmare Resources Moma** (Nampula coast) — **world-class heavy mineral sands** (ilmenite/zircon/rutile for titanium)
- **Cement plants not NACE 23**: Cimentos de Moçambique (Matola), Cinac (Nacala), Dugongo Cement (Dondo)
- **Ports**: Maputo, Beira, Nacala, Pemba, Quelimane

## Validation

Mozambique implements environmental protection via:

- **AQUA** (Agência Nacional de Qualidade Ambiental) — pollution monitoring
- **Lei n.º 20/97** — Lei do Ambiente (environmental framework law)
- **Regulamento sobre Normas de Qualidade Ambiental e Emissão de Efluentes (2004)**
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60

Notable noise zones:

- **N4 Maputo Corridor toll motorway** — Maputo ↔ Ressano Garcia ↔ RSA
- **EN1 coastal trunk** — Maputo to Pemba (2,500 km backbone)
- **EN6 Beira Corridor** — Beira ↔ Chimoio ↔ Machipanda (Zimbabwe)
- **EN7 Tete coal corridor** — Moatize ↔ Zimbabwe/Zambia
- **Greater Maputo + Matola** — dense urban core
- **Beira Corridor rail** — Beira↔Machipanda (Zimbabwe)
- **Sena Line rail** — Beira↔Moatize coal
- **Nacala Corridor rail** — Nacala↔Moatize via Malawi (Vulcan coal)
- **Maputo commuter rail** (CFM Sul)
- **Maputo International (MPM/FQMA)**, **Beira (BEW/FQBR)**, **Nampula (APL/FQNP)**, **Tete-Chingozi (TET/FQTT)**, **Pemba (POL/FQPB)**, **Quelimane (UEL/FQQL)**, **Vilankulo (VNX/FQVL)** — covered by global aircraft layer
- **Cahora Bassa hydroelectric plant** (Zambezi River, 2,075 MW — one of Africa's largest)
- **Ressano Garcia + Gigawatt thermal cluster** (Maputo area gas IPPs)
- **Karpowership "Mehmet Bey"** (floating 125 MW, Nacala anchorage)
- **Mozal Aluminium Smelter** (Matola — Africa's largest aluminium smelter)
- **Moatize coal basin** (Tete — world-class coking coal)
- **Mozambique LNG** (Palma, Cabo Delgado — TotalEnergies, paused due to insurgency)
- **Coral South FLNG** (offshore Rovuma — ENI, operating since 2022)
- **Kenmare Moma heavy sands** (Nampula coast — titanium minerals)
- **Ports**: Maputo, Beira, Nacala, Pemba
- **Balama Graphite Mine** (Cabo Delgado — Syrah Resources, one of world's largest graphite mines)
