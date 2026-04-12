---
title: Morocco
intro: Noise mapping data sources for Morocco.
map: { center: [-7, 32], zoom: 5 }
---

## Road traffic

### Class defaults only — all gov portals dead

**Every Moroccan government portal is unreachable or paywalled**:

| Portal | Status |
|---|---|
| `mtpnet.gov.ma`, `equipement.gov.ma` | Connection refused |
| `oncf.ma` (ONCF state rail) | DNS timeout |
| `onhym.com` (oil/gas/mining) | SSL cert errors |
| `add.gov.ma` | Timeout |
| `ancfcc.gov.ma` (cadastre) | HTTP 403 + paid |
| `adm.co.ma` (Autoroutes du Maroc) | HTTP 301 corporate, no API |
| `data.gov.ma` | HTTP 200 but Drupal/PDF only, no GIS |

**ADM publishes no toll road AADT** despite operating 1,800 km of autoroutes. Despite Morocco having **the best transport infrastructure in Africa**, it has the worst open data culture in the MENA region.

### Moroccan AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (A-autoroute toll) | 30,000 | 60,000 | 42,000 |
| 1 trunk (RN paved) | 12,000 | 24,000 | 16,800 |
| 2 primary | 6,000 | 12,000 | 8,400 |
| 3 secondary | 3,000 | 6,000 | 4,200 |
| 4 tertiary | 1,500 | 3,000 | 2,100 |
| 5 residential | 700 | 1,400 | 980 |

**Tier-1 metros** (×2.0, 5 metros): **Casablanca** (~4M, economic capital), **Rabat** (~1.8M, political capital), **Marrakech** (~1M, tourism), **Fez** (~1.2M, ancient), **Tangier** (~1.1M, Strait of Gibraltar).

**Tier-2 cities** (×1.4, 20 cities): Meknes, Oujda, Kenitra, Tetouan, Salé, Agadir, Nador, Safi, El Jadida, Khouribga, Béni Mellal, Taza, Khemisset, Laâyoune, Mohammedia, Settat, Larache, Ouarzazate, Taourirt, Essaouira.

### Moroccan vehicle split

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 | 65% | 6% | 12% | 17% |
| Tier-2 | 65% | 8% | 12% | 15% |
| Rural | 62% | 8% | 20% | 10% |
| **Phosphate corridor (Khouribga/Jorf/Safi)** | **50%** | 8% | **35%** | 7% |

### National route network

Morocco has the **longest autoroute network in Africa** (~1,800 km):

- **A1** — Rabat ↔ Tangier (incl. Tangier Med port)
- **A2** — Rabat ↔ Fez ↔ Oujda (Algeria border)
- **A3** — Casablanca ↔ Marrakech (tourism)
- **A5** — Casablanca ↔ El Jadida (port)
- **A7** — Marrakech ↔ Agadir (Atlantic south)
- **RN1** Rabat ↔ Al Hoceima (coastal) · **RN8** Casablanca ↔ Marrakech (legacy) · **RN9/10/11/12/13/14** national routes

## Railway

### Class defaults + corridor bbox boosts

ONCF and Casa/Rabat Tramway publish no open geometry/GTFS. Use OSM rail + corridor bbox boosts.

### Moroccan rail context

- **Al Boraq HSR** — **AFRICA'S FIRST AND ONLY HIGH-SPEED RAIL** (phase 1 Tangier ↔ Kenitra, 186 km at 320 km/h + continuing to Casablanca, 323 km total). Opened November 2018. Phase 2 Kenitra ↔ Marrakech planned.
- **ONCF conventional** — 2,295 km total. Mainlines:
  - Casablanca ↔ Rabat ↔ Kenitra ↔ Meknes ↔ Fez ↔ Taza ↔ Oujda (eastern, ~860 km)
  - Casablanca ↔ Marrakech
  - Casablanca ↔ El Jadida / Safi
- **OCP phosphate railway** — **world's largest mineral railway for a single commodity** (~40 Mtpa phosphate rock moved on Khouribga ↔ Jorf Lasfar ↔ Safi corridors). Privately owned and operated by OCP.
- **Casa Tramway** — 2 lines (L1 Sidi Moumen↔Facultés, L2 Ain Diab↔Mly Rchid). Opened 2012, RATP Dev.
- **Rabat-Salé Tramway** — 2 lines (L1 Hay Karima↔Hôpital Cheikh Zaid, L2 Harhoura↔Madinat El Irfane). Opened 2011.

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Al Boraq HSR** | 60 | 0 |
| **Atlantic mainline (Tangier↔Casablanca conventional)** | 40 | 8 |
| **Eastern mainline Casablanca↔Fez↔Oujda** | 40 | 15 |
| **Casablanca↔Marrakech** | 30 | 10 |
| **OCP phosphate corridor (Khouribga↔Jorf/Safi)** | 0 | 60 |
| **Casa Tramway (tram)** | 300 | 0 |
| **Rabat-Salé Tramway (tram)** | 250 | 0 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 138 plants, 65 operating

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Morocco'`

**Operating fuel**: solar 19 + wind 16 + oil/gas 11 + coal 11 + hydropower 8.

### Top operating plants

| Plant | MW | Type | Location |
|---|---:|---|---|
| **Safi (Units 1+2)** | 2 × 693 | coal supercritical | Safi — newest Moroccan coal |
| **Ain Beni Mathar** | 470 | **hybrid solar/gas ISCC** | Jerada province |
| **Afourer** | 466 | pumped storage hydro | Ain Hajar |
| **Tahaddart** | 400 | oil/gas CCGT | Asilah |
| **Jorf Lasfar (Units 1-6)** | 4×350 + 2×348 | coal | El Jadida (~2.05 GW total — Morocco's largest) |
| **Jerada** | 350 | coal | Oujda region |

**Noor Ouarzazate Solar Complex**:
- Noor I + Noor II + Noor III + Noor IV = **510 MW total CSP** — **world's largest concentrated solar power plant**, ~3,000 hectares, uses molten-salt storage for extended generation hours. Commissioning phases 2016-2018.
- Additional Noor Midelt + Noor Atlas + Noor PV plants

**Wind**: Tarfaya 300 MW, Tangier, Aftissat, Koudia Al Baida, Essaouira, Laayoune, Midelt, Jbel Khalladi — Morocco is one of world's top renewable energy adopters.

### Morocco does NOT have

- **No TPDA/AADT** — zero traffic data open
- **No ONCF/Al Boraq GTFS/geometry** — Africa's only HSR not in open data
- **No OCP phosphate mining polygons** — OCP has never released Khouribga/Benguerir/Youssoufia/Jorf/Safi concessions despite being state-owned
- **No auto plant classification** — Renault Tangier (400k cars/yr, Africa's largest) + Stellantis Kenitra (600k capacity) not NACE 29 tagged
- **No SAMIR refinery** — Mohammedia refinery closed 2015

## Validation

Morocco implements noise regulation via:

- **Ministère de l'Environnement** (Ministry of Environment)
- **Loi 11-03** — Environmental Protection Law (2003)
- **Décret 2-09-286** — Air quality and noise standards
- Residential day/night: 55/45 dBA
- Commercial: 60/50 dBA
- Industrial: 65/55 dBA

Notable noise zones:

- **A1 Rabat ↔ Tangier** toll autoroute — includes Tangier Med port access
- **A3 Casablanca ↔ Marrakech** — tourism corridor
- **A7 Marrakech ↔ Agadir** — Atlantic south
- **Boulevard Mohammed V / Corniche Aïn Diab** Casablanca
- **Al Boraq HSR** — Africa's first HSR, Tangier ↔ Casablanca
- **ONCF mainline** Casablanca ↔ Fez ↔ Oujda
- **OCP phosphate railway** Khouribga ↔ Jorf Lasfar ↔ Safi (~40 Mtpa heavy freight)
- **Casa Tramway** (Sidi Moumen ↔ Facultés + Ain Diab ↔ Mly Rchid)
- **Rabat-Salé Tramway**
- **Mohammed V International (CMN/GMMN Casablanca)**, **Tangier Ibn Battouta (TNG/GMTT)**, **Marrakech Menara (RAK/GMMX)**, **Rabat-Salé (RBA/GMME)**, **Fes Saïss (FEZ/GMFF)**, **Agadir Al Massira (AGA/GMAD)**, **Nador (NDR/GMMW)** — covered by global aircraft layer
- **Jorf Lasfar coal complex** (El Jadida, ~2.05 GW — Morocco's largest power plant)
- **Safi supercritical coal** (2 × 693 MW — newest Moroccan coal)
- **Noor Ouarzazate CSP** — world's largest concentrated solar power complex
- **Tarfaya wind farm** (300 MW, Atlantic south)
- **OCP Khouribga phosphate mine** — world's largest phosphate mine
- **OCP Jorf Lasfar fertilizer complex** — one of world's largest phosphoric acid / DAP plants
- **Renault-Nissan Tangier Med plant** (400k cars/yr — Africa's largest auto plant)
- **Stellantis Kenitra plant** (600k cars/yr capacity)
- **Tangier Med port** — Africa's largest container port (9+ Mt TEU capacity)
