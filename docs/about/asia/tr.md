---
title: Turkey
intro: Noise mapping data sources for Turkey (Türkiye).
map: { center: [35, 39], zoom: 5 }
---

## Road traffic

### Class defaults only

KGM (Karayolları Genel Müdürlüğü) publishes no open AADT. Fall back to CNOSSOS class defaults with Istanbul ×2.5 megacity boost. Turkey's O-road motorways are among Europe's busiest.

### Turkish AADT defaults

| OSM class | Rural | Tier-1 (×2.5) | Tier-2 (×1.8) | Tier-3 (×1.4) |
|---|---:|---:|---:|---:|
| 0 motorway (O-1/O-2/O-3/O-4) | 55,000 | 137,500 | 99,000 | 77,000 |
| 1 trunk (D-routes) | 22,000 | 55,000 | 39,600 | 30,800 |
| 2 primary | 12,000 | 30,000 | 21,600 | 16,800 |
| 3 secondary | 6,000 | 15,000 | 10,800 | 8,400 |
| 4 tertiary | 3,000 | 7,500 | 5,400 | 4,200 |
| 5 residential | 1,000 | 2,500 | 1,800 | 1,400 |

**Tier-1 megacity** (×2.5): **Istanbul** (~16M — straddles Bosphorus, Europe + Asia, one of world's most congested cities, **Eurasia's largest city**).

**Tier-2 cities** (×1.8): **Ankara** (~5.7M, capital, central Anatolia), **İzmir** (~4.4M, Aegean coast, Turkey's 3rd city).

**Tier-3 cities** (×1.4, 19 cities): **Bursa** (~3.1M, automotive capital — Tofaş/Fiat, Renault/Karsan), **Antalya** (~2.6M, Mediterranean tourism), **Adana** (~2.2M, Çukurova), **Gaziantep** (~2.1M, SE industrial), **Konya** (~2.3M, agricultural heartland), Kayseri, **Mersin** (port), Eskişehir, Diyarbakır, Samsun, Trabzon, Şanlıurfa, Malatya, Erzurum, Van, Denizli, Manisa, **Kocaeli** (Ford Otosan, petrochemical), **Sakarya** (Toyota Turkey).

### Turkish vehicle split

Turkey has a **European-style vehicle mix** — moderate motorcycle share (unlike South Asia), high car ownership:

- **Cars** — dominant (~62% Tier-1). Turkey is Europe's 6th largest car market
- **Minibuses (dolmuş)** — shared route taxis (iconic Istanbul/Ankara transport)
- **Heavy trucks** — large TIR fleet (Turkey is a major international transit country)
- **Motorcycles** — moderate share (~7-8%), lower than Asian average

| Tier | Light | Medium (dolmuş) | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Istanbul) | 62% | 12% | 18% | 8% |
| Tier-2 (Ankara/İzmir) | 64% | 10% | 19% | 7% |
| Rural | 55% | 6% | 32% | 7% |
| **O-motorway** (O-1/O-4 Istanbul) | 72% | 4% | **22%** | 2% |
| **D-400 Mediterranean transit** | 55% | 5% | **35%** | 5% |

### National route network

- **O-1 / O-2** — Istanbul ring motorways (European and Asian sides)
- **O-4** — Istanbul ↔ Ankara (530 km, Turkey's busiest intercity motorway)
- **O-31 / O-32** — İzmir ring motorways
- **O-52** — Ankara ↔ Konya
- **D-400** — Mediterranean coast trunk (İzmir ↔ Antalya ↔ Mersin ↔ Adana ↔ Gaziantep)
- **D-010** — Istanbul ↔ Bulgarian border (Edirne, European side — Thrace)
- **D-750** — Istanbul ↔ Ankara (old trunk, parallel to O-4)

## Railway

### Turkish rail context

**TCDD** operates ~12,500 km of **standard gauge (1,435 mm)** — one of the world's larger rail networks. Turkey has invested heavily in high-speed rail and urban metros since the 2000s.

### YHT (Yüksek Hızlı Tren — High-Speed Rail)
- **Ankara ↔ Eskişehir** (2009, first section, 250 km/h)
- **Ankara ↔ Konya** (2011, 1.5 hours)
- **Ankara ↔ Istanbul** (2014, Pendik terminus, 4.5 hours, 250 km/h)
- **Konya ↔ Karaman** (2022, extension)
- **Ankara ↔ Sivas** (2024, newest, via Yozgat/Kırıkkale)

### Istanbul Metro + Marmaray
- **Istanbul Metro** — 7+ lines, ~115 km, ~1.5M daily riders (M1/M2/M3/M4/M5/M6/M7)
- **Marmaray** — **undersea Bosphorus rail tunnel** (2013 — connects Asian and European Istanbul, 76.6 km total incl. suburban rail, world's deepest immersed tube tunnel at 60m below sea level)
- Istanbul tram (T1 Kabataş↔Bağcılar), funicular (F1/F2), Metrobus BRT (50 km, 800k daily)

### Other urban metros
- **Ankara Metro** — Ankaray LRT + M1/M2/M3/M4
- **İzmir Metro** — 2 lines + **IZBAN** commuter rail (80 km, one of Turkey's busiest suburban)
- **Bursa Metro** — BursaRay (2 lines)
- **Tramways**: Kayseri, Konya, Antalya, Gaziantep, Samsun, Eskişehir

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Istanbul Metro (7+ lines)** | 350 | 0 |
| **Marmaray Bosphorus tunnel** | 150 | 0 |
| **YHT high-speed corridor** (Ankara hub) | 30 | 0 |
| **Ankara/İzmir/Bursa Metro** | 100 | 0 |
| **TCDD conventional main line** | 10 | 15 |
| Other/branch/tramway | 3 | 5 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 1,451 plants, 1,049 operating, ~91 GW

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Türkiye'` (GEM uses Türkiye)

**Operating fuel**: wind **373** + solar 323 + hydropower 117 + oil/gas 88 + coal 78 + **geothermal 68** + bioenergy 2. **Largest and most diverse operating fleet of any enriched country**. Turkey is **#4 globally in geothermal** (after US, Indonesia, Philippines).

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Atatürk Dam** | **2,405** | hydropower | **Euphrates River, GAP project** — Turkey's largest hydroelectric plant, 8th largest earth-fill dam in the world |
| **Karakaya** | 1,800 | hydropower | Euphrates |
| **Keban** | 1,330 | hydropower | Euphrates (cascade total ~5,535 MW) |
| **Ilısu** | 1,209 | hydropower | **Tigris River, 2020** — controversial (flooded ancient Hasankeyf) |
| **Karapınar YEKA Solar** | **1,079** | solar | Konya — **one of world's largest utility solar farms** (Kalyon/Hanwha) |
| **Bandırma** | 936 | oil/gas CCGT | Marmara |
| **Yahşihan** | 927 | oil/gas | Kırıkkale |
| **Erzin** | 904 | oil/gas | Hatay |
| **Massive gas CCGT fleet** | ~20+ GW | oil/gas | Gebze/Ambarlı/Aliağa/Adapazarı/Ankara — concentrated in Marmara+Aegean |
| **Afşin-Elbistan** | ~2,800+ | coal (lignite) | **Turkey's largest lignite complex** (K. Maraş) |
| **Soma + Yeniköy + Kemerköy** | various | coal | Aegean lignite belt |
| **Kızıldere + Efeler + Germencik** | various | geothermal | **Aydın/Denizli geothermal belt** — 68 plants, 1.7 GW |
| **373 wind farms** | ~11 GW | wind | Aegean/Marmara wind corridor — Turkey is Europe's 5th largest wind market (modelled as rotating turbine sources, not via the industrial NACE layer) |

The enricher stamps each GEM operating plant onto a nearby OSM industrial footprint with an electricity NACE code (NACE division **35**): thermal/coal/gas/geothermal/bioenergy → 3511, hydropower → 3512, solar → 3599. The 373 wind farms are excluded here — wind turbines are already modelled as their own rotating-source profile, so they are not stamped onto the industrial layer.

### Turkey does NOT have

- **No KGM AADT** — zero open traffic data (despite Turkey being an EU candidate)
- **No TCDD GTFS** — timetables available as PDF only
- **TÜPRAŞ refineries** (İzmit/Aliağa/Kırıkkale/Batman — Turkey's only refinery group, Koç Holdings) not NACE 19
- **Erdemir steel** (Ereğli — Turkey's largest steelmaker) + **İskenderun steel** (İSDEMİR) not NACE 24
- **Automotive**: Bursa (Tofaş/Fiat, Renault/Karsan), Kocaeli (Ford Otosan), Sakarya (Toyota Turkey) — **Turkey is Europe's 5th largest automotive producer** (~1.5M vehicles/year). Not NACE 29
- **Cement**: Oyak, Sabancı, LafargeHolcim — Turkey is a **top-10 global cement producer**. Not NACE 23
- **Textiles**: İstanbul, Gaziantep, Denizli, Bursa — Turkey is a major global textile exporter. Not NACE 13
- **Mining**: Eti Maden (world's largest boron producer — 73% of global reserves), Koza gold
- **Port of Mersin, Ambarlı, İzmir/Alsancak** — major container ports

## Validation

Turkey implements environmental protection via:

- **Çevre, Şehircilik ve İklim Değişikliği Bakanlığı** (Ministry of Environment, Urbanization and Climate Change)
- **Çevre Kanunu (2006)** — Environmental Law
- **Çevresel Gürültünün Değerlendirilmesi ve Yönetimi Yönetmeliği** — Strategic Noise Map regulation (EU-compatible, as EU candidate)
- Typical limits (EU-aligned): residential 55/45 dBA Lden/Lnight, commercial 65/55, industrial 70/60

Notable noise zones:

- **O-1/O-2 Istanbul motorway ring** — among Europe's busiest
- **O-4 Istanbul↔Ankara** — Turkey's main intercity motorway
- **D-400 Mediterranean corridor** (İzmir↔Adana↔Gaziantep)
- **Istanbul** mega-city (Bosphorus both sides, Metrobus 800k daily)
- **Istanbul Metro (7+ lines)** + **Marmaray undersea Bosphorus tunnel** (2013)
- **YHT high-speed rail** (Ankara hub — İstanbul/Konya/Sivas)
- **TCDD conventional** (transcontinental network)
- **Istanbul Airport (IST/LTFM — world's busiest airport by some metrics 2024)**, **Istanbul Sabiha Gökçen (SAW/LTFJ)**, **Ankara Esenboğa (ESB/LTAC)**, **İzmir Adnan Menderes (ADB/LTBJ)**, **Antalya (AYT/LTAI — Europe's busiest charter airport)** — covered by global aircraft layer
- **Atatürk Dam** (Euphrates, 2,405 MW)
- **Karapınar YEKA Solar** (1,079 MW)
- **Aydın/Denizli geothermal belt** (68 plants, 1.7 GW — #4 globally)
- **Afşin-Elbistan lignite complex** (2,800+ MW)
- **Bursa automotive district** (Tofaş/Renault/Karsan)
- **Kocaeli/Sakarya automotive** (Ford Otosan, Toyota Turkey)
- **TÜPRAŞ İzmit refinery** (Turkey's largest)
- **Erdemir Ereğli + İSDEMİR steel**
