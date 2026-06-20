---
title: Algeria
intro: Noise mapping data sources for Algeria.
map: { center: [3, 28], zoom: 5 }
---

## Road traffic

### Class defaults only

Ministère des Travaux Publics / ADA / ANA publish no open AADT. Fall back to CNOSSOS class defaults with Grand Alger Tier-1 boost. Algerian baseline higher than sub-Saharan (Mediterranean traffic patterns).

### Algerian AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (Autoroute Est-Ouest, Hauts Plateaux) | 35,000 | 70,000 | 49,000 |
| 1 trunk (RN paved) | 12,000 | 24,000 | 16,800 |
| 2 primary | 6,000 | 12,000 | 8,400 |
| 3 secondary | 3,000 | 6,000 | 4,200 |
| 4 tertiary | 1,500 | 3,000 | 2,100 |
| 5 residential | 700 | 1,400 | 980 |

**Tier-1 metros** (×2.0, 1 metro): **Grand Alger** (~4M metro — Africa's 4th largest metropolitan area, covering Algiers/Bab Ezzouar/El Harrach/Dar El Beïda).

**Tier-2 cities** (×1.4, 27 cities): **Oran** (2nd city, port), **Constantine** (3rd city, Rocher rock plateau), **Annaba** (port + El Hadjar steel), Blida, Batna (Aurès mountains), Djelfa, **Sétif** (+ tramway), **Sidi Bel Abbès** (+ tramway), Biskra (Sahara gateway), **Tébessa** (phosphate, Tunisia border), Tlemcen (Morocco border), Béjaïa (Kabyle port), Tiaret, Bechar (NW Sahara gateway), **Skikda** (port + LNG + refinery), Chlef, **Mostaganem** (+ tramway), **Ouargla** (Sahara oil hub + **southernmost tramway in Africa**), Ghardaïa (M'zab valley UNESCO), Laghouat, **Hassi Messaoud** (oil capital), **Hassi R'Mel** (gas hub — one of world's largest gas fields), Adrar (deep Sahara, wind farm), **Tamanrasset** (Ahaggar, deep south), Tizi Ouzou (Kabyle), El Oued (Souf oasis), Boumerdès.

### Algerian vehicle split

Algeria is **Mediterranean/European** in vehicle mix — low motorcycle share, high light-vehicle share:

- **Taxi clandestin (inter-wilayas)** — informal shared intercity taxis
- **ETUSA buses** — Algiers city buses (Entreprise de Transport Urbain et Suburbain d'Alger)
- **Fourgons** — minibus taxis in smaller cities
- **Motorcycles** — low share (4-9%), growing slightly post-2018
- **Heavy trucks** abundant on oil/gas corridors and Trans-Sahara

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Grand Alger) | 66% | 12% | 13% | 9% |
| Tier-2 | 66% | 10% | 16% | 8% |
| Rural | 58% | 7% | 29% | 6% |
| **Autoroute Est-Ouest** (coastal) | 74% | 5% | **17%** | 4% |
| **Hassi R'Mel/Messaoud oil-gas corridor** | 38% | 5% | **52%** | 5% |

### National route network

- **Autoroute Est-Ouest (A1)** — **1,216 km**, Tunisia border ↔ Annaba ↔ Constantine ↔ Sétif ↔ Algiers ↔ Blida ↔ Chlef ↔ Oran ↔ Tlemcen ↔ Morocco border — **one of Africa's longest motorways**, completed 2015
- **Autoroute des Hauts Plateaux (A2)** — ~1,020 km, Tébessa ↔ Tlemcen parallel inland (under construction)
- **Trans-Sahara Highway (RN1)** — Algiers ↔ Ghardaïa ↔ In Salah ↔ Tamanrasset ↔ Niger border (~2,400 km in DZ)
- **RN3** — Algiers ↔ Bou Saâda ↔ Ouargla ↔ Hassi Messaoud (oil corridor)
- **RN6** — Oran ↔ Sidi Bel Abbès ↔ Bechar

## Railway

### Algerian rail context

Algeria has **North Africa's 2nd largest rail network** (~4,200 km SNTF) plus 7 tramways and Algiers Metro.

### Urban transit

- **Algiers Metro Line 1** — **opened November 2011**. **Africa's 2nd heavy metro after Cairo (1987)**. 18.5 km, 19 stations, standard gauge, electrified 750 V DC third rail. Airport extension under construction. Operated by EMA / RATP El Djazaïr.
- **Algiers Tramway** (2011) — 23 km, 3 lines, ~110k daily riders. Alstom Citadis.
- **Oran Tramway** (2013) — 18 km
- **Constantine Tramway** (2013) — 8 km (plus historic Téléphérique cable car)
- **Sétif Tramway** (2018) — 15 km
- **Sidi Bel Abbès Tramway** (2017) — 14 km
- **Ouargla Tramway** (2018) — 10 km, **southernmost tramway in Africa**
- **Mostaganem Tramway** (2023) — 14 km, newest

All 7 tramways built by Alstom (Citadis), state-owned Setram operated.

### SNTF intercity network

- **Northern main line** — Oran ↔ Relizane ↔ Chlef ↔ Algiers ↔ Sétif ↔ Constantine ↔ Annaba ↔ Tunisia border. **Partially electrified 25 kV AC** — among Africa's longest electrified rail sections.
- **Commuter rail Algiers (SNTF Banlieue)** — Zéralda, Thenia, Dar El Beïda (airport), El Affroun
- **Oran ↔ Tlemcen ↔ Maghnia** (Moroccan border — cross-border rail closed since 1994)
- **Hauts Plateaux**: Constantine ↔ Biskra ↔ Touggourt, Tébessa branches
- **Phosphate line**: Tébessa (Djebel Onk) ↔ Annaba port (SNTF's #1 freight commodity)
- **Iron ore**: Ouenza ↔ Annaba (El Hadjar steel)

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Algiers Metro (2011)** | 150 | 0 |
| **Algiers Tramway (2011)** | 80 | 0 |
| **Oran Tramway (2013)** | 60 | 0 |
| Other tramways (Constantine/SBA/Ouargla/Mostaganem/Sétif) | 40 | 0 |
| **SNTF Northern main line** (Oran-Algiers-Annaba) | 15 | 12 |
| **Tébessa-Annaba phosphate+iron corridor** | 1 | 18 |
| Other/branch | 1 | 3 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 208 plants, 144 operating, ~24.6 GW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Algeria'`

**Operating fuel**: oil/gas 107 + solar 34 + hydropower 2 + wind 1. **Algeria has Africa's 2nd-largest thermal fleet after Egypt**, overwhelmingly natural gas from domestic Hassi R'Mel / Hassi Messaoud / In Salah fields.

### Top operating plants (per-unit GEM entries)

| Plant | MW total | Type | Notes |
|---|---:|---|---|
| **Bellara** | **1,398** (2× 699) | oil/gas CCGT | Jijel, El-Milia coastal |
| **Hadjret En Nouss** | **1,227** (3× 409) | oil/gas CCGT | Tipaza coastal — one of Algeria's largest single sites |
| **Koudiet Eddraouch** | **1,200** (3× 400) | oil/gas CCGT | El Taref, near Tunisian border |
| **Ras Djinet** | **1,200** (3× 400) | oil/gas | Boumerdes coastal |
| **Terga** | **1,200** (3× 400) | oil/gas CCGT | Aïn Témouchent, far west |
| **Naama** | **1,164** (2× 582) | oil/gas | Sud-Ouest single-cycle turbines |
| **Ain Arnet** | **1,014** (3× 338) | oil/gas | Sétif, high plateau |
| **Oumache** | **1,000** (2× 500) | oil/gas CCGT | Biskra |
| **Skikda CCGT** | 880 (2× 440) | oil/gas CCGT | Skikda industrial port |
| **Mostaganem** | 450 | oil/gas | Coastal |
| **Beni Haroun pumped storage** | 423 | hydropower | Mila — Algeria's largest pumped storage |
| **Boufarik 2** | 250 | oil/gas | Blida plain |
| **Kabertène Wind** | — | wind | Adrar — **Algeria's first wind farm** (2014) |
| **Hassi R'Mel ISCC, Boughezoul, Tihamam Solar** | — | solar | 34-plant CPV fleet built 2013-2020 |

**Total operating: ~24,573 MW** — **Africa's 2nd largest operating fleet after Egypt**.

All operating plants map to **NACE 35**.

### Algeria does NOT have

- **No DGPC/ADA AADT** — zero open traffic data
- **No SNTF/EMA/Setram GTFS** — all transit timetables corporate HTML
- **Sonatrach upstream + downstream** all generic OSM industrial (should be NACE 06/19/20):
  - **Hassi Messaoud oil field** (Algeria's main field since 1956, >80% of crude production)
  - **Hassi R'Mel gas field** — **one of the world's largest gas fields**, since 1956
  - **In Salah gas** (BP/Statoil-Sonatrach JV) and **In Amenas** (site of 2013 hostage crisis)
  - **Skikda refinery** (355k bpd) + **Skikda LNG** trains (since 1972)
  - **Arzew refinery + LNG + petrochemicals** — **world's first industrial-scale LNG export plant (1964)**, still operating
  - **Béjaïa, Algiers, Adrar refineries**
- **El Hadjar steel** (Annaba) not NACE 24 — **Africa's largest steel complex**, historic ArcelorMittal / now Imetal ~2 Mtpa
- **Cement plants not NACE 23**: LafargeHolcim (M'Sila, Oggaz), GICA state fleet, Biskria, many regional plants
- **Djebel Onk phosphate mines** (Tébessa) not NACE 08
- **Ports**: Algiers, Oran, Annaba, Arzew, Skikda, Béjaïa — industrial terminals
- **Trans-Med gas pipeline** (to Italy via Tunisia) — linear infrastructure

## Validation

Algeria implements environmental protection via:

- **ONEDD** (Observatoire National de l'Environnement et du Développement Durable) — monitoring
- **Loi n° 03-10** (2003) — environment protection framework law
- **Décret exécutif n° 93-184** — noise regulation
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60

Notable noise zones:

- **Autoroute Est-Ouest** — flagship corridor (1,216 km Tunisia border ↔ Morocco border)
- **RN1 Trans-Sahara** — Algiers ↔ Tamanrasset ↔ Niger border
- **Grand Alger** + **Bab Ezzouar** + **Kouba** + **El Harrach** — dense urban core
- **Algiers Metro Line 1** (2011) + **Algiers Tramway** (2011)
- **Oran + Constantine + Sétif + SBA + Mostaganem + Ouargla + Annaba tramways**
- **SNTF Northern main line** (Oran ↔ Algiers ↔ Annaba ↔ Tunisia border)
- **SNTF Tébessa-Annaba phosphate+iron corridor**
- **Houari Boumediene International (ALG/DAAG Algiers)**, **Es Sénia (ORN/DAOO Oran)**, **Mohamed Boudiaf (CZL/DABC Constantine)**, **Rabah Bitat (AAE/DABB Annaba)**, **Aguenar (TMR/DAAT Tamanrasset)**, **Hassi Messaoud (HME/DAUH)** — covered by global aircraft layer
- **Bellara 1,398 MW** (Jijel)
- **Hadjret En Nouss 1,227 MW** (Tipaza)
- **Koudiet Eddraouch + Ras Djinet + Terga** 3× 1,200 MW coastal cluster
- **Ain Arnet 1,014 MW** (Sétif)
- **Naama 1,164 MW + Oumache 1,000 MW** (Saharan interior peakers)
- **Skikda refinery + LNG complex** (355k bpd refinery + 4 LNG trains since 1972)
- **Arzew LNG + refinery + petrochemical complex** (world's first industrial LNG, 1964)
- **El Hadjar steel** (Annaba — Africa's largest steel complex)
- **Hassi Messaoud oil field + Hassi R'Mel gas hub** — Algeria's hydrocarbon heart
- **In Salah + In Amenas gas** — deep Sahara
- **Djebel Onk phosphate mines** (Tébessa)
- **Ports**: Algiers, Oran, Annaba, Arzew, Skikda, Béjaïa
- **Beni Haroun pumped storage** (Mila — Algeria's largest dam)
