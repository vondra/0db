---
title: Vietnam
intro: Noise mapping data sources for Vietnam.
map: { center: [107.5, 15.5], zoom: 5 }
---

## Road traffic

### No open road data — CNOSSOS class defaults only

No per-segment AADT is published openly for Vietnam. Unlike India / China / Indonesia / Philippines / Saudi Arabia, there is **no ArcGIS Online / community mirror for Vietnamese roads**. Research confirmed:

- `owner:esri_Vietnam` on ArcGIS Online returns zero items
- No community road network FeatureServer exists
- **GDRV (General Department of Roads, Tổng cục Đường bộ)** at `mt.gov.vn` publishes yearbooks and statistical reports but no machine-readable data
- **Vietnam Expressway Corporation (VEC)** does not publish traffic counts
- OD Mekong Datahub has a 2019 classification dataset but it's stale (pre-dates most expressway expansion)

Vietnamese roads use OSM `highway` classification + Vietnamese-tuned CNOSSOS defaults with Tier-1 (Hanoi/HCMC) and Tier-2 city multipliers.

### AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| motorway (CT / đường cao tốc) | 50,000 | 100,000 | 70,000 |
| trunk (QL / quốc lộ) | 20,000 | 40,000 | 28,000 |
| primary | 10,000 | 20,000 | 14,000 |
| secondary | 4,000 | 8,000 | 5,600 |
| tertiary | 1,500 | 3,000 | 2,100 |
| residential | 800 | 1,600 | 1,120 |

**Tier-1 cities (×2.0)**: Hanoi, Ho Chi Minh City (HCMC / Sài Gòn).

**Tier-2 cities (×1.4, 20 cities)**: Haiphong, Da Nang, Can Tho, Bien Hoa, Nha Trang, Vung Tau, Hue, Nam Dinh, Vinh, Qui Nhon, Rach Gia, Long Xuyen, My Tho, Thai Nguyen, Thanh Hoa, Buon Ma Thuot, Da Lat, Phan Thiet, Pleiku, Bac Lieu.

### Vietnamese vehicle split

Vietnam has the **highest motorcycle share of any country in this pipeline** (tied with Indonesia):

| Tier | Light | Medium | Heavy | **Motorcycle** |
|---|---:|---:|---:|---:|
| Hanoi / HCMC | 25% | 5% | 5% | **65%** |
| Tier-2 cities | 35% | 6% | 4% | **55%** |
| Rural | 45% | 8% | 7% | **40%** |

Motorcycles/scooters dominate Vietnamese urban traffic — Hanoi alone has ~6M+ registered motorcycles and HCMC ~8.5M+, forming the soundscape backbone of Vietnamese cities.

### National expressway network (CT / đường cao tốc)

Vietnam is rapidly building a **2,000+ km north-south expressway** ("Trans-Vietnam Expressway") in phases:

- **CT.01 Noi Bai – Lao Cai** (245 km, Hanoi ↔ Chinese border)
- **CT.02 Hanoi – Hai Phong** (105 km)
- **CT.03 Hai Phong – Mong Cai** (under construction)
- **CT.04 Phap Van – Cau Gie** (30 km, Hanoi southern exit)
- **CT.05 Cau Gie – Ninh Binh** (50 km)
- **CT.06 Ninh Binh – Thanh Hoa** (63 km, opened 2023)
- **CT.08 Da Nang – Quang Ngai** (131 km, central coast)
- **CT.14 Ho Chi Minh City – Long Thanh – Dau Giay** (51 km, HCMC eastbound)
- **CT.16 HCMC – Trung Luong** (40 km, Mekong Delta)
- Ring Roads around Hanoi (1/2/3) and HCMC (1/2/3/4)

## Railway

### No open GTFS for any Vietnamese operator

- **Vietnam Railways (VNR / Đường sắt Việt Nam)** at [vr.com.vn](https://vr.com.vn/) — operates the 1,726 km Reunification Express (Hanoi ↔ HCMC, metre gauge) + branches to Haiphong, Lao Cai, Dong Dang. No GIS / GTFS published.
- **Hanoi Metro Line 2A (Cat Linh ↔ Ha Dong)** — 13 km, **opened November 2021**, Vietnam's first urban metro. Operated by Hanoi Metro Company. No GTFS.
- **Hanoi Metro Line 3 (Nhon ↔ Hanoi)** — 12.5 km, partial opening August 2024, full 2025. No GTFS.
- **HCMC Metro Line 1 (Ben Thanh ↔ Suoi Tien)** — 19.7 km, **opened December 2024** (brand new). No GTFS.
- **HCMC Metro Line 2 (Ben Thanh ↔ Tham Luong)** — under construction, target 2030+
- **Hanoi bus GTFS** (via World Bank Data Catalog, 2020-2023 vintage) is **bus-only**, not rail

### CNOSSOS class defaults applied

| rail_type | usage | Context | pax/day |
|---|---|---|---:|
| 0 (rail) | main in Hanoi/HCMC | commuter / station approach boost | 40 |
| 0 (rail) | main elsewhere | **VNR Reunification Express** (~6 daily trips each dir) | 15 |
| 0 (rail) | branch | Lao Cai / Dong Dang / Haiphong spurs | 5 |
| 2 (light_rail) | - | **Hanoi Metro 2A**, **HCMC Metro Line 1** | 250 |

## Buildings

GHSL Built-H R2023A 100 m + Overture Maps Foundation global footprints. Microsoft contributed ~50M Vietnamese building footprints in their 2024 release (now in Overture). No Vietnamese cadastre open.

## Industrial

### GEM Global Integrated Power — 1,492 VN plants

- **Source**: [GEM Global Integrated Power (August 2025)](https://services.arcgis.com/lqRTrQp2HrfnJt8U/arcgis/rest/services/Global_Integrated_Power_August_2025/FeatureServer/0) via Rice University CES GIS mirror, filtered by `Country_area='Vietnam'`
- **1,492 plants**, **874 operating** (59% — the highest operating share of any country enriched so far, reflecting Vietnam's 2019-2024 renewable energy boom)

**Fuel breakdown**:

| Fuel | Plants | Notable facilities |
|---|---:|---|
| **Solar PV** | 683 | Ninh Thuan, Binh Thuan, Dak Lak, Long An — Vietnam added ~20 GW between 2019 and 2021 during the FIT scheme |
| **Wind** | 398 | Bac Lieu offshore (Mekong Delta), Soc Trang, Ca Mau, Quang Tri, central coast ~5 GW operational |
| **Coal** | 197 | Pha Lai (Hai Duong), Quang Ninh, Hai Phong, Mong Duong, Vinh Tan (Binh Thuan), Duyen Hai (Tra Vinh), Vung Ang (Ha Tinh) |
| **Gas CCGT** | 115 | **Phu My complex** (Ba Ria-Vung Tau — Vietnam's largest power complex, ~3.9 GW), Nhon Trach (Dong Nai), Ca Mau, Ba Ria |
| **Hydroelectric** | 86 | **Son La (2.4 GW — Southeast Asia's largest hydro plant)**, **Lai Chau (1.2 GW)**, **Hoa Binh (1.92 GW)**, Tuyen Quang, Ban Ve, **Yaly (720 MW)**, **Tri An (400 MW)** |
| **Nuclear** | 8 | All **cancelled** (Ninh Thuan-1 and Ninh Thuan-2 projects shelved in 2016, never operational) |
| **Bioenergy** | 5 | sugarcane bagasse cogeneration |

All mapped to **NACE 35** (Electricity generation).

### Vietnam does NOT have

- **No nuclear power** (planned but never operational)
- **No geothermal** (unlike Indonesia/Philippines)
- **No offshore oil refineries in-pipeline** — Nghi Son + Dung Quat refineries are listed elsewhere (downstream oil, not captured as power plant)

## Validation

Vietnam implements noise regulation via:

- **Ministry of Natural Resources and Environment (MONRE / Bộ Tài nguyên và Môi trường)** at [monre.gov.vn](https://monre.gov.vn/)
- **QCVN 26:2010/BTNMT** — National Technical Regulation on Noise (ambient standards):
  - Normal area day/night: 70/55 dBA
  - Special area (near schools/hospitals/residential): 55/45 dBA
- **Provincial DONREs** (Departments of Natural Resources and Environment) for local enforcement

Notable noise zones:

- **Hanoi Ring Road 3 (Vành đai 3)** — 65 km elevated expressway, ~200,000 AADT in peak sections
- **HCMC Ring Road 2 / Ring Road 3** — similar volumes
- **EDSA-equivalent arterials**: Nguyen Van Cu, Nguyen Hue, Le Loi (HCMC); Hang Bai, Tran Hung Dao, Giai Phong (Hanoi)
- **North-South Expressway corridor** (under ongoing construction, eventually Hanoi ↔ HCMC ~1,700 km)
- **Hanoi Metro 2A elevated viaduct** — Cat Linh ↔ Ha Dong (13 km), elevated for most of its length
- **HCMC Metro Line 1 elevated viaduct** — Ba Son ↔ Suoi Tien (underground Ben Thanh, elevated rest)
- **VNR Reunification Express corridor** — 1,726 km north-south, meter gauge, mixed passenger + freight
- **Tan Son Nhat (SGN / VVTS)**, **Noi Bai (HAN / VVNB)**, **Da Nang (DAD / VVDN)**, **Cam Ranh (CXR / VVCR)** — covered by the global aircraft layer
- **Phu My gas-CCGT complex** (Ba Ria-Vung Tau, 3.9 GW) — Vietnam's largest power complex
- **Son La Hydropower Dam** (2.4 GW — Southeast Asia's largest hydro station)
- **Formosa Ha Tinh steel + Vung Ang power complex** — major industrial noise in Ha Tinh province
- **Phu My industrial park + deep-water port** (Ba Ria-Vung Tau) — major container + bulk freight hub
