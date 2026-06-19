---
title: Cameroon
intro: Noise mapping data sources for Cameroon.
map: { center: [12, 6], zoom: 6 }
---

## Road traffic

### Class defaults only

MINTP (Ministère des Travaux Publics) publishes no open GIS. Fall back to CNOSSOS class defaults with Yaoundé + Douala Tier-1 boost — Cameroon is unique in Africa for having **two capital cities of effectively equal importance** (Yaoundé political, Douala economic).

### Cameroonian AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (A3 Yaoundé-Douala under construction) | 28,000 | 56,000 | 39,200 |
| 1 trunk (N-route paved) | 10,000 | 20,000 | 14,000 |
| 2 primary | 5,000 | 10,000 | 7,000 |
| 3 secondary | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,200 | 2,400 | 1,680 |
| 5 residential | 600 | 1,200 | 840 |

**Tier-1 metros** (×2.0, 2 metros — **unique dual-capital configuration in Africa**): **Yaoundé** (political capital, ~4M metro, built on seven hills) + **Douala** (economic capital, ~3.5M metro, Wouri estuary port, Central Africa's main commercial hub).

**Tier-2 cities** (×1.4, 20 cities): **Bamenda** (Anglophone NW, affected by separatist crisis since 2017), Garoua (North, Benue River), Maroua (Far North), Bafoussam (West Grassfields), **Ngaoundéré** (Adamawa plateau, Transcamerounais rail terminus), Bertoua (East), **Limbé** (Anglophone SW, SONARA refinery site), **Buéa** (Anglophone SW, foot of Mt. Cameroon, former German colonial capital), Ebolowa, Kumba, Dschang, **Edéa** (Alucam aluminium smelter + Edéa hydro), **Kribi** (new deep-water port + Hilli Episeyo FLNG), **Foumban** (Bamoun kingdom historic capital), Bafia, Mbalmayo, Nkongsamba (old rail end), Tiko, Mamfe (Nigeria border), Kumbo (NW highlands).

### Cameroonian vehicle split

Cameroon's urban transport has distinctive **yellow taxis** + dominant moto-taxis:

- **Taxis jaunes** — yellow shared intra-city taxis, not metered (negotiated flat rates), ubiquitous in Yaoundé and Douala
- **Opep / Clando** — shared taxi minivans (similar to Abidjan Gbaka)
- **Bendskins** (Yaoundé) / **clandos** (Douala) — **motorcycles**, major share, similar to Nigeria/Benin
- **SOCATUR / Le Bus** — official Douala city buses (limited)
- **Heavy trucks**: **CEMAC transit corridor** freight (Chad/CAR/RoC goods via Douala port) + timber exports → Douala

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Yaoundé/Douala) | 55% | 14% | 13% | **18%** |
| Tier-2 | 55% | 11% | 17% | 17% |
| Rural | 50% | 8% | 30% | 12% |
| **N3 Yaoundé↔Douala corridor** | 58% | 7% | **30%** | 5% |

### National route network

- **N1** — Douala ↔ Yaoundé ↔ Bertoua ↔ CAR border
- **N2** — Yaoundé ↔ Ebolowa ↔ Gabon border
- **N3** — Yaoundé ↔ Douala (main economic corridor, ~240 km; **A3 motorway under construction**)
- **N4** — Yaoundé ↔ Bafia ↔ Bafoussam ↔ Bamenda
- **N5** — Bafoussam ↔ Foumban (West highlands)
- **N9** — Ngaoundéré ↔ Garoua ↔ Maroua ↔ Lake Chad (North trunk)

## Railway

### Class defaults only

No Camrail GIS/GTFS, so the trains/day defaults below are applied by rail class over the OSM geometry — no per-corridor enrichment.

### Cameroonian rail context

Cameroon has one principal rail line, the **Transcamerounais**, operated under concession by **Camrail** (private concession since 1999, Bolloré Africa Logistics → now Africa Global Logistics / MSC).

### Transcamerounais main line
- **Douala ↔ Yaoundé ↔ Belabo ↔ Ngaoundéré** — **~1,000 km active track**, meter gauge
- Built in phases 1906-1974 by Germans (colonial 1906-1914), French (mandate 1926-1959), and post-independence
- **Douala ↔ Yaoundé south section** (~264 km) — main passenger/freight artery
- **Yaoundé ↔ Belabo ↔ Ngaoundéré north section** (~622 km) — freight-heavy; cargo continues to Chad and CAR hinterland via road from Ngaoundéré
- **Chad cotton + CAR timber** historically flow through this route
- **2016 Eséka train disaster** killed 79+ passengers (Intercity 152 derailment) — passenger service was suspended and partially revived 2019-2020

### Discontinued lines
- **Douala ↔ Nkongsamba** (historic western branch, now disused)
- **Mbanga ↔ Kumba** (short branch, ~29 km, disused)

**No metros, no trams, no urban commuter rail** in any Cameroonian city.

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Transcamerounais main line** (Douala↔Yaoundé↔Ngaoundéré) | 2 | 8 |
| Other/branch | 0 | 1 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 31 plants, 13 operating, ~1.9 GW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Cameroon'`

**Operating fuel**: hydropower 5 + solar 4 + oil/gas 3 + wind 1.

**Cameroon has a hydro-dominated grid** centred on the **Sanaga River cascade** (Edéa + Song Loulou + Nachtigal = **1,092 MW on one river** — 57% of national capacity).

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Nachtigal** | **420** | hydropower | **Sanaga River, opened 2024** — Cameroon's newest major hydro, built by EDF consortium. Now largest single plant |
| **Song Loulou** | 396 | hydropower | Sanaga River, 1988 |
| **Edéa** | 276 | hydropower | Sanaga River, **1953 — Cameroon's oldest major hydro**, historically dedicated to Alucam aluminium smelter (integrated hydro+smelter development) |
| **Kribi** | 216 | oil/gas CCGT | Kribi coastal — Cameroon's main gas plant, opened 2013, fed by domestic gas (Logbaba + Sanaga basin) |
| **Memve'ele** | 211 | hydropower | Ntem River (south), opened 2018 |
| **Cameroon Wind Farm** | 100 | wind | Central Cameroon |
| **Dibamba** | 88 | oil/gas | Douala area |
| **Lagdo** | 72 | hydropower | Benue River (north), 1982 — only major northern hydro |
| **Ahala** | 60 | oil/gas | Yaoundé |
| **Garoua/Guider/Maroua Solar** | 60 total | solar | 3 northern solar farms (30+15+15 MW) |

**Total operating: ~1,900 MW**.

All operating plants map to **NACE 35**.

### Cameroon does NOT have

- **No MINTP AADT** — zero open traffic data
- **No Camrail GTFS** — timetables corporate HTML only
- **SONARA refinery** (Limbé) not NACE 19 — 45k bpd, **partially destroyed by fire May 2019**, non-operational since
- **Alucam (Aluminium du Cameroun)** (Edéa) not NACE 24 — ~95 ktpa aluminium smelter, historically Rio Tinto/Alcan, now state-owned. Edéa hydro was built to feed this smelter (integrated power+industry development)
- **Hilli Episeyo Kribi FLNG** not NACE 06 — **Africa's first operational FLNG (2018)**, Golar LNG → New Fortress Energy. Floating liquefaction vessel moored offshore Kribi; predates Mozambique Coral South FLNG (2022)
- **Logbaba onshore gas field** (Douala, Victoria Oil & Gas) — domestic gas
- **Offshore oil**: Ebome, Moudi (Addax Petroleum, now CNPC/Sinopec)
- **Cocoa processing**: SIC Cacaos — **Cameroon is world's #5 cocoa producer** (~280 ktpa)
- **Palm oil**: SOCAPALM, CDC (Cameroon Development Corporation)
- **Cement**: Cimencam (Holcim), Dangote Cement Cameroon, Cimaf
- **Timber exports** — tropical hardwood via Douala and Kribi ports
- **Douala Port** — **Central Africa's main port for CEMAC transit** (Chad, CAR, RoC, Eq. Guinea)
- **Kribi deep-water port** (opened 2018, first Central African deep-water port)

## Validation

Cameroon implements environmental protection via:

- **MINEPDED** (Ministère de l'Environnement, Protection de la Nature et Développement Durable)
- **Loi n° 96/12** — framework environmental law
- **Décret n° 2012/2809** — noise pollution regulation
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60

Notable noise zones:

- **N3 Yaoundé↔Douala corridor** (+ A3 motorway under construction) — Cameroon's main economic artery
- **N1 Douala↔Yaoundé↔Bertoua↔CAR** — CEMAC freight transit
- **Yaoundé seven hills** + **Douala Wouri estuary** — dense urban cores
- **Transcamerounais rail corridor** (Douala↔Yaoundé↔Ngaoundéré)
- **Yaoundé Nsimalen (NSI/FKYS)**, **Douala International (DLA/FKKD)**, **Garoua (GOU/FKKR)**, **Maroua-Salak (MVR/FKKL)**, **Ngaoundéré (NGE/FKKN)**, **Bafoussam (BFX/FKKU)**, **Bamenda (BPC/FKKV)**, **Bertoua (BTA/FKKO)** — covered by global aircraft layer
- **Sanaga River hydro cascade** (Edéa 276 + Song Loulou 396 + **Nachtigal 420** = 1,092 MW)
- **Memve'ele hydro** (Ntem River, 211 MW)
- **Kribi Gas Power Plant** (216 MW CCGT)
- **Hilli Episeyo Kribi FLNG** (Africa's first operational FLNG, 2018)
- **SONARA refinery Limbé** (non-operational since May 2019 fire)
- **Alucam aluminium smelter Edéa**
- **Douala Port** + **Kribi Port**
- **Lagdo Dam** (Benue River, 72 MW — north's only major hydro)
- **Logbaba gas field** (Douala)
