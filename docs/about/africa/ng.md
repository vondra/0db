---
title: Nigeria
intro: Noise mapping data sources for Nigeria.
map: { center: [8, 9], zoom: 5 }
---

## Road traffic

### Class defaults only — all gov portals dead

Nigerian FERMA, FMW, FRSC, LAMATA publish no open GIS. No TPDA/AADT anywhere. Use CNOSSOS class defaults with aggressive Lagos boost.

### Nigerian AADT defaults

**Lagos uses ×2.5 multiplier** (same as Cairo) to reflect Africa's largest city density (~22M, extreme gridlock on Lagos-Ibadan Expressway, Third Mainland Bridge, Apapa-Oshodi).

| OSM class | Rural | Tier-1 Lagos (×2.5) | Tier-1 other (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|---:|
| 0 motorway | 35,000 | 87,500 | 70,000 | 49,000 |
| 1 trunk (Federal A-route) | 12,000 | 30,000 | 24,000 | 16,800 |
| 2 primary | 6,000 | 15,000 | 12,000 | 8,400 |
| 3 secondary | 3,000 | 7,500 | 6,000 | 4,200 |
| 4 tertiary | 1,500 | 3,750 | 3,000 | 2,100 |
| 5 residential | 700 | 1,750 | 1,400 | 980 |

**Tier-1 metros**: **Greater Lagos** ×2.5 (~22M, Africa's largest), **Kano** ×2.0 (~4M north), **Abuja (FCT)** ×2.0 (~3.5M federal capital), **Ibadan** ×2.0 (~3.6M southwest).

**Tier-2 cities** (×1.4, 20 cities): Port Harcourt, Benin City, Kaduna, Jos, Maiduguri, Enugu, Onitsha, Aba, Ilorin, Abeokuta, Zaria, Warri, Sokoto, Oyo, Akure, Bauchi, Calabar, Ogbomosho, Osogbo, Lokoja.

### Nigerian vehicle split

**Very high motorcycle/tricycle share** (~30-40%) — "okada" motorcycle taxis and "keke napep" tricycles dominate urban transport.

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 | 45% | 5% | 15% | **35%** |
| Tier-2 | 45% | 6% | 14% | **35%** |
| Rural | 50% | 8% | 22% | 20% |
| **Lagos-Ibadan / Apapa container corridor** | **35%** | 5% | **45%** | 15% |

### National route network

- **A1** — Lagos ↔ Ibadan ↔ Ilorin ↔ Jebba ↔ Abuja ↔ Kaduna ↔ Kano — **main north-south spine**
- **A2** — Lagos ↔ Benin City ↔ Warri ↔ Port Harcourt (coastal)
- **A3** — Enugu ↔ Port Harcourt ↔ Calabar ↔ Cameroon border
- **A4** — Abuja ↔ Jos ↔ Bauchi ↔ Gombe ↔ Maiduguri (NE)
- **Lagos-Ibadan Expressway (A121)** — Nigeria's busiest freight corridor (~40% of container volume)

## Railway

### Class defaults + corridor bbox boosts

NRC publishes no GIS/GTFS. Use OSM + corridor bbox defaults.

### Nigerian rail context

- **Lagos-Ibadan SGR** (standard gauge, 157 km, opened 2021) — passenger + freight
- **Abuja-Kaduna SGR** (187 km, opened 2014) — passenger, suspended multiple times due to kidnappings
- **Itakpe-Warri iron ore line** (327 km, opened 2020) — iron ore freight to Warri port (for Ajaokuta Steel)
- **Lagos Blue Line** (LRMT Phase 1 Mile 2 ↔ Marina, opened 2023) — Lagos's first metro
- **Lagos Red Line** (Oyingbo ↔ Agbado, opened 2024) — Lagos's second metro
- **Abuja Metro (Abuja Rail Mass Transit)** — light rail, opened 2018

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Lagos-Ibadan SGR (2021)** | 16 | 20 |
| **Abuja-Kaduna SGR (2014)** | 8 | 6 |
| **Itakpe-Warri iron ore (2020)** | 2 | 20 |
| **Lagos Blue + Red Line (light_rail)** | 250 | 0 |
| **Abuja Metro (light_rail)** | 60 | 0 |
| NRC narrow gauge (mostly defunct) | 1 | 4 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 289 plants, 95 operating

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Nigeria'`

**Operating fuel**: oil/gas 73 + hydropower 5 + solar 5 + coal 4 + wind 1.

### Top operating plants

| Plant | MW | Type | Location |
|---|---:|---|---|
| **Kainji hydro** | 760 | hydropower | Niger River, Nigeria's largest hydro |
| **Zungeru hydro** | 700 | hydropower | Niger State (2024 commissioning) |
| **Afam VI** | 650 | oil/gas CCGT | Rivers State |
| **Shiroro hydro** | 600 | hydropower | Niger State |
| **Jebba hydro** | 578 | hydropower | Niger River |
| **Lekki Refinery PS** | 570 | oil/gas | Lagos (Dangote self-gen) |
| **Oando Kwale** | 480 | oil/gas | Delta State |
| **Olorunsogo II** | 2 × 377 | oil/gas | Ogun State |
| **Egbin** | 6 × 220 | oil/gas | Lagos State (1,320 MW total) |

All operating plants map to **NACE 35** (Electricity generation). Nigeria has installed capacity ~13 GW but **available capacity is typically 4-6 GW** due to gas supply disruptions and grid reliability.

### Nigerian industrial legacy (OSM-only)

Not captured by GEM — rely on OSM `landuse=industrial`:

- **Dangote Refinery Lekki** (Lagos) — **Africa's largest refinery** (650k bpd), opened 2023
- **NNPC refineries**: Port Harcourt (210k bpd, restart 2024), Warri (125k bpd), Kaduna (110k bpd)
- **NLNG Bonny Island** — 6 LNG trains + Train 7 (one of world's largest LNG complexes, ~22 Mtpa)
- **Dangote Cement** — including **Obajana** (world's largest cement plant), Ibese, Gboko
- **BUA Cement**, **Lafarge Cement** (Ewekoro, Sagamu, Calabar)
- **Ajaokuta Steel** (Kogi state — largely inoperative since 1980s construction)
- **Indorama Eleme petrochemicals** (Port Harcourt)

### Nigeria does NOT have

- **No TPDA/AADT** — zero traffic data
- **No NRC/Lagos Blue-Red/Abuja Metro GTFS**
- **No Dangote Refinery / NLNG / cement classification** — Africa's largest refinery, one of world's largest LNG complexes, and world's largest cement plant all rely on OSM only
- **No Niger Delta oilfield infrastructure** — thousands of flow stations, terminals not classified

## Validation

Nigeria implements noise regulation via:

- **NESREA** (National Environmental Standards and Regulations Enforcement Agency) at nesrea.gov.ng
- **National Environmental (Noise Standards and Control) Regulations, 2009** — sets ambient noise standards
- Typical limits: Residential day/night 55/45 dBA, commercial 65/55 dBA, industrial 70/60 dBA
- Enforcement is weak in practice

Notable noise zones:

- **Lagos-Ibadan Expressway (A121)** — Nigeria's busiest freight corridor (~40% of container traffic)
- **Third Mainland Bridge** Lagos — 11.8 km bridge over Lagos Lagoon
- **Apapa-Oshodi Expressway** Lagos — extreme truck congestion serving Apapa/Tin Can Island ports
- **Kano-Kaduna-Abuja corridor** (A1) — northern spine
- **Eko Bridge** Lagos Island
- **Lagos Blue Line + Red Line** — Nigeria's first metros
- **Lagos-Ibadan SGR** — parallel standard gauge railway
- **Abuja-Kaduna SGR** — federal capital commuter/freight
- **Itakpe-Warri iron ore corridor** — heavy freight
- **Murtala Muhammed (LOS/DNMM Lagos)**, **Nnamdi Azikiwe (ABV/DNAA Abuja)**, **Mallam Aminu Kano (KAN/DNKN)**, **Port Harcourt (PHC/DNPO)**, **Akanu Ibiam (ENU/DNEN Enugu)** — covered by global aircraft layer
- **Kainji Dam** (Niger River, 760 MW) — Nigeria's largest hydroelectric
- **Zungeru hydro** (700 MW, 2024)
- **Shiroro** (600 MW), **Jebba** (578 MW) — Niger River cascade
- **Egbin power station** (Lagos, 1,320 MW) — Nigeria's largest thermal
- **Afam VI** (Rivers State, 650 MW)
- **Dangote Refinery Lekki** — Africa's largest refinery (650k bpd), opened 2023
- **NLNG Bonny Island** — one of world's largest LNG complexes (~22 Mtpa)
- **Dangote Cement Obajana** — world's largest cement plant by capacity
- **NNPC refinery complex**: Port Harcourt, Warri, Kaduna
- **Niger Delta oil infrastructure** — scattered flow stations, terminals (Bonga, Forcados, Qua Iboe, Brass, Bonny)
- **Apapa Port / Tin Can Island Port** Lagos — Nigeria's main container gateway
