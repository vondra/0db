---
title: China
intro: Noise mapping data sources for mainland China.
map: { center: [105.0, 35.0], zoom: 4 }
---

## Road traffic

### Highway Network + Chinese-tuned CNOSSOS defaults

No per-segment AADT is published openly for mainland China. The Ministry of Transport (交通运输部, MoT) publishes PDF yearbooks with provincial-level aggregates; `data.gov.cn` is unreachable from non-CN networks; Baidu/Gaode/Amap are commercial. The only machine-readable road-network dataset with classification is a community ArcGIS Online layer:

- **Source**: `services1.arcgis.com/ERdCHt0sNM6dENSD/.../China_Province_Cities_Highways_Network_WFL1/FeatureServer/0` (anonymous)
- **Records**: 8,690 CN polylines
- **Classification**:
  - Highway: 3,428 (National G-series expressways: G1 Beijing-Harbin, G4 Beijing-Hong Kong-Macau, G5 Beijing-Kunming, G50 Shanghai-Chongqing, etc.)
  - Major road: 5,099 (Provincial S-series + through-routes)
  - Local road: 185

### Chinese AADT defaults

China has world-class urban arterial loads. Beijing's 3rd Ring Road carries ~180,000 vehicles/day in peak sections; Shanghai's Inner Ring carries ~150,000. Our defaults (rural × Tier-1 ×2.0 × Tier-2 ×1.4):

| Class | Rural | Tier-1 metro | Tier-2 city |
|---|---:|---:|---:|
| Highway (G-expressways) | 60,000 | 120,000 | 84,000 |
| Major road | 25,000 | 50,000 | 35,000 |
| OSM motorway | 60,000 | 120,000 | 84,000 |
| OSM trunk | 25,000 | 50,000 | 35,000 |
| OSM primary | 12,000 | 24,000 | 16,800 |
| OSM secondary | 5,000 | 10,000 | 7,000 |
| OSM tertiary | 2,000 | 4,000 | 2,800 |
| OSM residential | 1,000 | 2,000 | 1,400 |

**Tier-1 cities** (×2.0): Beijing, Shanghai, Guangzhou, Shenzhen, Chengdu, Chongqing, Wuhan, Xi'an, Hangzhou, Nanjing, Suzhou, Tianjin.

**Tier-2 cities** (×1.4, 33 cities): Changsha, Qingdao, Dalian, Hefei, Zhengzhou, Jinan, Kunming, Fuzhou, Xiamen, Ningbo, Wuxi, Harbin, Shenyang, Nanchang, Hohhot, Urumqi, Lanzhou, Xining, Guiyang, Haikou, Nanning, Lhasa, Yinchuan, Taiyuan, Shijiazhuang, Dongguan, Foshan, Wenzhou, Shantou, Zhuhai, Zhongshan, Huizhou, Jinhua.

### Chinese vehicle split

Chinese urban traffic is **radically different from India**: gasoline motorcycles are banned in most major Tier-1/Tier-2 cities (Guangzhou banned in 2007, Shanghai 1996, etc.). Electric scooters dominate but are quiet and don't materially contribute to noise emission. Heavy trucks are restricted during daytime in inner cities.

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1/Tier-2 urban | 75% | 10% | 10% | 5% |
| Rural | 65% | 12% | 18% | 5% |

**Coverage**: 52.3M OSM road segments enriched across 4,892 hexes.

## Railway

### Mainland — CR + Metros (the jackpot dataset)

China operates the world's largest high-speed rail (HSR) network (~42,000 km as of 2024) and the world's largest urban metro system by total length (Shanghai Metro alone is ~830 km). The Mainland ArcGIS Online service by user `hanzheng1994` is the single richest national rail dataset in our entire pipeline.

**URL**: `services7.arcgis.com/m6uLpqj7MgjPU371/arcgis/rest/services/Mainland/FeatureServer`

#### National railway lines (layer 4)

- **2,328 polyline segments** with per-segment `TopSpeed`, `ServiceType`, `Operator`, `Status`
- **HSR coverage**: 127 segments at 350 km/h (Fuxing on Beijing-Shanghai), 242 at 300 km/h, 263 at 250 km/h, 296 at 200 km/h
- **Zones / Operators**:
  - CR-Beijing (Northern Railway Bureau)
  - CR-Shanghai (Shanghai Railway Bureau)
  - CR-Guangzhou (Guangzhou Railway Bureau)
  - CR-Chengdu, CR-Xi'an, CR-Urumqi, CR-Harbin, etc. (18 bureaux)
- **Major HSR corridors**:
  - Beijing↔Shanghai HSR (京沪高铁, 1,318 km, 350 km/h peak)
  - Beijing↔Guangzhou↔Hong Kong HSR (京广港高铁, 2,440 km)
  - Shanghai↔Kunming HSR / Hu-Kun Line (2,252 km)
  - Lanzhou↔Urumqi HSR (1,776 km — Xinjiang corridor)
  - Beijing↔Harbin HSR (1,249 km)
  - Coastal HSR (Hangzhou↔Shenzhen↔Hong Kong)

**Defaults by TopSpeed**:

| TopSpeed | Passenger | Freight |
|---|---:|---:|
| ≥350 km/h (Fuxing) | 180 | 0 |
| ≥300 | 150 | 0 |
| ≥250 | 120 | 0 |
| ≥200 | 80 | 10 |
| ≥150 | 50 | 20 |
| ≥100 | 30 | 20 |
| <100 | 15 | 10 |

#### Urban metro lines (layer 3)

- **1,256 polyline segments** across **50+ Chinese cities** with operational or under-construction metros
- **ServiceType classification**:
  - Metro Heavy Rail: 842 (standard mass transit — Beijing Line 1, Shanghai Line 2, Guangzhou Line 3, etc.)
  - Metro Express Heavy Rail: 167 (airport + suburban express)
  - LRT: 94
  - Metro Light Rail: 50
  - APM: 13 (automated people movers)
  - Streetcar: 16
  - BRT: 67 (excluded from rail enrichment — bus)
  - Tourist rail: 7

**Cities covered**:
- **Shanghai Metro** (20+ lines, ~830 km — world's longest metro network by total length)
- **Beijing Subway** (27 lines, ~830 km)
- **Guangzhou Metro**, **Shenzhen Metro**, **Chongqing Rail Transit**, **Chengdu Metro**, **Nanjing Metro**, **Wuhan Metro**, **Xi'an Metro**, **Hangzhou Metro**, **Suzhou Metro**, **Tianjin Metro**
- **Qingdao, Dalian, Harbin, Shenyang, Kunming, Zhengzhou, Changsha, Hefei, Ningbo, Fuzhou, Nanning, Nanchang, Taiyuan, Shijiazhuang, Guiyang, Lanzhou, Urumqi, Xiamen, Dongguan, Foshan, Wuxi, Changzhou, Jinan, Hohhot, Lhasa** metros
- **Defaults**: Metro Heavy Rail 500 pax/day, Metro Express 400, LRT/Light Rail 300, APM 500, Streetcar 200

### Chinese metros DODGE the subway extraction bug

**Unlike Dubai / Bangkok / Taipei / Singapore / Delhi / Seoul / Tokyo / Hong Kong / Mexico City**, Chinese urban metros in OSM are tagged `railway=rail` (not `railway=subway`). Confirmed via direct check on Guangzhou Metro Line 18 (广州地铁18号线). The pipeline's OSM extractor extracts them directly into `railways.arrow`.

This is one of the few countries where our subway-extraction bug does NOT apply, which makes the Mainland/3 spatial matching especially valuable — we get proper metro frequencies across Beijing/Shanghai/Guangzhou/Shenzhen/all 50+ cities.

### 12306.cn / GTFS — not available

No Chinese rail operator publishes GTFS. The national booking site (12306.cn) is anti-scrape and commercial. Mobility Database returns zero Chinese feeds. Transitland returns zero. All Chinese metro + HSR frequencies are CNOSSOS class defaults derived from the Mainland service's ServiceType + TopSpeed metadata.

**Coverage**: 1.66M rail segments enriched across 2,427 hexes. 888k via Mainland spatial match + 768k via class defaults.

## Buildings

GHSL Built-H R2023A 100 m global raster + Overture Maps Foundation building footprints. **Microsoft published 700 million Chinese building footprints** in 2024, now integrated into Overture Maps. No Chinese-specific building enhancement — GISTDA/Bhuvan-equivalents, municipal cadastres, and Natural Resources Ministry data are all auth-gated or behind Great Firewall.

## Industrial

### ces_ricegis (Rice University GIS / Global Energy Monitor) — 28,345 facilities

The richest industrial point registry in our entire pipeline. Rice University's Center for Energy Studies publishes Global Energy Monitor (GEM) datasets as public ArcGIS feature services covering the Chinese power sector far more comprehensively than WRI GPPD (which stopped updating in 2022):

**URL prefix**: `services.arcgis.com/lqRTrQp2HrfnJt8U/arcgis/rest/services/`

| Dataset | Records |
|---|---:|
| Coal power plants (Jan 2024) | **6,078** unit-phases |
| Wind power plants (GEM Jun 2024) | **8,281** |
| Solar power plants (GEM Jun 2024) | **13,489** |
| Gas power plants (2024) | 252 |
| Nuclear power plants (Sep 2024) | 163 |
| LNG terminals | 82 |
| **Total** | **28,345** |

All geocoded, with capacity (MW), fuel type, combustion technology (ultra-supercritical / supercritical / subcritical / CCGT), commissioning year, owner, province, status (operating / construction / cancelled / retired).

### Major Chinese industrial noise sources

**Coal plants**: Tuoketuo (Inner Mongolia, 6.72 GW — world's largest coal plant by installed capacity), Waigaoqiao III (Shanghai, 4.2 GW ultra-supercritical — world's first USC), Shangdu, Pingwei, Datang, Huaneng, Huadian, Guodian, CGN. Total ~1,100 GW operational coal fleet (largest in the world).

**Nuclear**: Taishan (EPR 1.75 GW × 2 — world's only operational EPR), Hongyanhe (Liaoning, 1.19 GW × 6), Yangjiang (Guangdong, 1.1 GW × 6), Daya Bay, Tianwan, Qinshan, Ling Ao, Fuqing, Fangchenggang, Haiyang, Ningde. Total ~55 GW operational + 30 GW under construction.

**Hydroelectric** (via WRI GPPD, not in ces_ricegis): Three Gorges Dam (22.5 GW — world's largest), Xiluodu (13.86 GW), Baihetan (16 GW, commissioned 2022), Wudongde (10.2 GW), Xiangjiaba (6.4 GW), Ertan (3.3 GW), Longtan, Nuozhadu, Jinping, Goupitan, Xiaowan.

**Wind** (8,281 farms): Jiuquan wind base (Gansu, ~20 GW), Inner Mongolia clusters (~35 GW), Hebei (~12 GW), Liaoning, Xinjiang Hami. China has the world's largest installed wind capacity (~400 GW).

**Solar PV** (13,489 plants): Qinghai Golmud, Xinjiang, Inner Mongolia, Gansu Gobi desert megaprojects. China has the world's largest installed solar capacity (~600 GW).

**Cement**: Anhui Conch (world's largest cement producer, 260 Mt/year), CNBM, Huaxin, Taiwan Cement. Not in ces_ricegis — visible only via OSM industrial polygons.

**Steel**: Baowu (world's largest steel producer, 120 Mt/year), HBIS, Ansteel, Shagang, Shougang. Same — OSM only.

**Petrochemicals**: Sinopec (Shanghai Gaoqiao, Maoming, Zhenhai, Hainan), PetroChina (Dushanzi, Yanshan, Lanzhou), CNOOC (Huizhou, Daxie).

## Validation

China implements noise regulation via:

- **Ministry of Ecology and Environment (生态环境部, MEE)** at [mee.gov.cn](https://www.mee.gov.cn/) — national environmental standards
- **GB 3096-2008 Environmental Quality Standard for Noise** — 70 dBA day / 55 night industrial, 60/50 residential, 55/45 cultural/educational zones
- **GB/T 17181-1997 Acoustic Measurement for Building Insulation**
- **Provincial EPB (Environmental Protection Bureaus)** — implementation + monitoring
- **City-level noise monitoring stations** — most Tier-1 metros publish annual reports (in Chinese)

Notable noise zones include:

- **Beijing 5th Ring Road (五环) + 6th Ring (六环)** — chronic congestion, 200k+ AADT peak
- **Shanghai Inner Ring + Outer Ring Expressway** — 150k+ AADT
- **Shenzhen Binhai Dadao + Coastal Road** — heavy container truck freight to Yantian Port
- **Guangzhou Huanshi Lu + Inner Ring Expressway** — dense urban congestion
- **G1 Beijing-Harbin Expressway, G4 Beijing-Hong Kong-Macau Expressway, G5 Beijing-Kunming Expressway** — national trunk corridors with 50-100k AADT rural, 150k+ urban approaches
- **Beijing-Shanghai HSR (京沪高铁)** — elevated viaduct for most of 1,318 km, 350 km/h peak, 200 trains/day — potentially significant railway noise
- **Beijing-Guangzhou HSR, Shanghai-Kunming HSR, Lanzhou-Urumqi HSR** — major HSR corridors
- **Shanghai Metro Line 2 + 9 + 10** elevated sections in suburban Pudong
- **Beijing Subway Line 13 + 15** elevated viaducts
- **Tuoketuo Power Plant (Inner Mongolia, 6.72 GW)** — world's largest coal plant
- **Three Gorges Dam area** — hydro station noise + spillway operations
- **Beijing Capital International Airport (PEK / ZBAA), Beijing Daxing (PKX / ZBAD), Shanghai Pudong (PVG / ZSPD), Guangzhou Baiyun (CAN / ZGGG)** — top 10 global airports by traffic, covered by the global aircraft layer
- **Jiuquan Satellite Launch Center + Wenchang + Taiyuan + Xichang** — sporadic rocket launch impulsive noise
