---
title: Indonesia
intro: Noise mapping data sources for Indonesia.
map: { center: [118.0, -2.0], zoom: 4 }
---

## Road traffic

### Bina Marga GIS portal — real per-segment AADT (first non-EU Asian success)

**Indonesia is a surprise winner for open road data.** The **Directorate General of Highways** (Bina Marga, under the Ministry of Public Works and Housing / PUPR) operates a publicly accessible ArcGIS Server at [`gisportal.binamarga.pu.go.id`](https://gisportal.binamarga.pu.go.id/arcgis/rest/services) with no auth, no geofence, and WGS84 output. This is the first non-EU Asian country in our pipeline with real per-segment AADT.

### Regional Roads (with LHRT / real AADT)

- **Source**: [Bina Marga Jalan_Daerah layer](https://gisportal.binamarga.pu.go.id/arcgis/rest/services/Jalan/Jalan_Daerah/MapServer/0)
- **Records**: **27,127 polyline segments** covering Jalan Provinsi (provincial, 1,006) + Jalan Kabupaten (regency, 17,215) + Jalan Kota (city, 7,036)
- **17,198 segments with LHRT > 0** (LHRT = Lalu Lintas Harian Rata-rata = Average Daily Traffic)
- **Per-segment fields**: `LHRT`, `VCR` (volume/capacity ratio), `STATUS`, `FUNGSI` (road function), `TIPE_JLN`, `LBR_KERAS` (paved width), condition percentages, `PROVINSI`, `NM_RUAS` (segment name)
- **Spatial match**: nearest polyline within 200m of OSM road segment

### National Roads (Jalan Nasional)

- **Source**: [Bina Marga Road_Network_National](https://gisportal.binamarga.pu.go.id/arcgis/rest/services/Jalan/Road_Network_National/MapServer/0)
- **Records**: 3,921 polyline segments (national arterials, e.g. Pantura north coast of Java, Trans-Sumatra, Trans-Kalimantan, Trans-Sulawesi)
- **No LHRT** → class default (30,000 AADT × tier multiplier)

### Toll Roads (Jalan Tol)

- **Source**: [Bina Marga Jalan_Tol_Operasi](https://gisportal.binamarga.pu.go.id/arcgis/rest/services/Tol/Jalan_Tol_Operasi/MapServer/0)
- **Records**: 158 operating toll segments
- **Coverage**: Trans-Java Toll Road (Jakarta ↔ Surabaya, ~1,000 km), **Jakarta Outer Ring Road (JORR)**, Jakarta-Cikampek, Bali Mandara (Denpasar), Padaleunyi (Bandung), Semarang-Solo, Trans-Sumatra (partial)
- Applied as 80,000 AADT × tier multiplier (Indonesian toll road typical)

### Indonesian-tuned CNOSSOS class defaults

| Class | Rural | Tier-1 metro | Tier-2 city |
|---|---:|---:|---:|
| motorway | 50,000 | 100,000 | 70,000 |
| trunk | 20,000 | 40,000 | 28,000 |
| primary | 10,000 | 20,000 | 14,000 |
| secondary | 4,000 | 8,000 | 5,600 |
| tertiary | 1,500 | 3,000 | 2,100 |
| residential | 800 | 1,600 | 1,120 |

**Tier-1 cities** (×2.0, 8 metros): Jakarta Jabodetabek (Jakarta + Bogor + Depok + Tangerang + Bekasi), Surabaya Gerbangkertosusila, Bandung Raya, Medan Mebidang, Semarang, Makassar, Palembang, Denpasar Sarbagita.

**Tier-2 cities** (×1.4, 32 cities): Yogyakarta, Malang, Padang, Pekanbaru, Jambi, Bengkulu, Bandar Lampung, Serang, Banjarmasin, Balikpapan, Samarinda, Pontianak, Palangkaraya, Mataram, Kupang, Manado, Gorontalo, Kendari, Palu, Ambon, Jayapura, Ternate, Cirebon, Tasikmalaya, Sukabumi, Pekalongan, Tegal, Solo, Magelang, Madiun, Kediri, Probolinggo, Pasuruan.

### Indonesian vehicle split — the MOST motorcycle-heavy in our pipeline

Indonesia has the highest motorcycle share of any country in the pipeline, **even higher than India**:

| Tier | Light | Medium | Heavy | **Motorcycle** |
|---|---:|---:|---:|---:|
| Tier-1 (Jakarta, etc.) | 30% | 5% | 5% | **60%** |
| Tier-2 | 40% | 6% | 4% | **50%** |
| Rural | 50% | 8% | 7% | **35%** |

Jakarta alone has ~17 million registered motorcycles. Two-wheelers are the dominant vehicle class in all Indonesian cities and account for the majority of traffic noise in Tier-1 metros.

## Railway

### No open GTFS for any Indonesian rail operator

All Indonesian rail operators lock their schedules behind commercial anti-scrape paywalls:

- **PT Kereta Api Indonesia (KAI)** at [kai.id](https://kai.id/) — operates the entire national network
- **KAI Commuter (KCI)** — Jabodetabek commuter rail (~1.2M passengers/day — one of Asia's busiest suburban rail systems)
- **Jakarta MRT** (Moda Raya Terpadu Jakarta) at [jakartamrt.co.id](https://jakartamrt.co.id/) — Phase 1 operational since March 2019 (Lebak Bulus ↔ Bundaran HI, 16 km)
- **LRT Jakarta** — Kelapa Gading ↔ Velodrome, opened 2019
- **Jabodebek LRT** (by KAI) — Jakarta-Bogor-Depok-Bekasi LRT, opened 2023
- **Whoosh (Kereta Cepat Indonesia China / KCIC)** — Jakarta-Bandung high-speed rail, 142 km, 350 km/h, opened October 2023 — Indonesia's only HSR line
- **MobilityData / Transitland**: 0 Indonesian rail feeds

Only **TransJakarta BRT GTFS** is available ([gtfs.transjakarta.co.id](https://gtfs.transjakarta.co.id/files/file_gtfs.zip)) but BRT is bus, not rail.

### CNOSSOS class defaults applied

| rail_type | usage | highspeed | pax/day | frt/day | Use case |
|---|---|---|---:|---:|---|
| 0 (rail) | main in Jakarta bbox | - | 300 | 5 | **KAI Commuter** (Jabodetabek) |
| 0 (rail) | main | true | 20 | 0 | **Whoosh HSR** Jakarta-Bandung |
| 0 (rail) | main | - | 20 | 10 | KAI Java mainline (Jakarta↔Surabaya via Semarang/Cirebon/Surabaya, Jakarta↔Yogyakarta, Jakarta↔Bandung) + Sumatra networks |
| 0 (rail) | branch | - | 8 | 5 | branch lines |
| 0 (rail) | industrial | - | 0 | 10 | Sumatra coal rail (e.g. Babat-Tarahan) |
| 2 (light_rail) | - | - | 300 | 0 | **Jakarta MRT, LRT Jakarta, Jabodebek LRT** elevated sections |

## Buildings

GHSL Built-H + Overture Maps Foundation global baseline. Microsoft contributed Indonesian building footprints in 2024. No Indonesian cadastre is open (BIG = Badan Informasi Geospasial has some data but most is auth-gated).

## Industrial

### GEM Global Integrated Power (974 plants)

- **Source**: [GEM Global Integrated Power (August 2025)](https://services.arcgis.com/lqRTrQp2HrfnJt8U/arcgis/rest/services/Global_Integrated_Power_August_2025/FeatureServer/0) via Rice University CES GIS mirror, filtered by `Country_area='Indonesia'`
- **974 power plants**, 479 currently operating
- **Fuel breakdown**:
  - **Coal**: Paiton (Java, 3.4 GW), Suralaya (Banten, 4.0 GW), Cirebon, Tanjung Jati B (Central Java), Labuhan Angin (North Sumatra), Celukan Bawang (Bali), Pelabuhan Ratu
  - **Gas CCGT**: Grati (East Java), Priok, Muara Karang, Tanjung Priok (Jakarta), Gilimanuk (Bali), Belawan (Medan)
  - **Geothermal** — Indonesia has the **world's 2nd-largest geothermal installed capacity (~2.4 GW)**: Kamojang (West Java), Darajat, Salak, Wayang Windu, Patuha, Karaha, Lahendong (North Sulawesi), Sibayak (Sumatra), Ulubelu (Lampung), Ulumbu (Flores), Mataloko
  - **Hydroelectric**: Cirata (1.0 GW, West Java), Saguling (0.7 GW), Jatiluhur (0.19 GW), Jatigede, Koto Panjang, Sigura-gura, Tangga
  - **Solar PV**: Tolo, Likupang, Cirata floating solar, increasingly deployed
  - **Wind**: Tolo-1 (Sulawesi), Sidrap — minimal (~150 MW total)

### Enrichment result
- 20,784 OSM industrial sites scanned across 962 hexes
- 511 matched to GEM (2.5% match rate — lower than India/China because Indonesian OSM industrial tagging is more diffuse across thousands of islands)
- 438 new NACE entries added to `nace-lookup.json`

### Major Indonesian industrial noise sources (not in GEM)

- **Palm oil refineries**: Wilmar International, Sinar Mas, Asian Agri, Musim Mas — hundreds of facilities across Sumatra + Kalimantan (visible only via OSM landuse=industrial)
- **Cement**: Semen Indonesia (Gresik, Tuban), Indocement (Citeureup), Holcim Cilacap, Semen Padang
- **Steel**: Krakatau Steel Cilegon (Java), Gunung Garuda, PT Indonesia Morowali Industrial Park (Sulawesi)
- **Petrochemicals / Refineries**: Pertamina (Cilacap, Balikpapan, Balongan, Dumai, Plaju, Kasim, Cepu), Chandra Asri Petrochemical (Cilegon)
- **Nickel / Aluminum smelters**: Morowali (Sulawesi), Weda Bay (Halmahera), Konawe — major noise sources in remote areas

## Validation

Indonesia implements noise regulation via:

- **Kementerian Lingkungan Hidup dan Kehutanan (Ministry of Environment and Forestry, KLHK)** at [menlhk.go.id](https://www.menlhk.go.id/)
- **Keputusan Menteri Negara Lingkungan Hidup No. 48/1996** — noise standard thresholds:
  - Residential: 55 dBA day / 45 night
  - Industrial: 70 dBA day / 60 night
  - Commercial: 65 dBA day / 60 night
  - Hospital/school: 55 dBA day / 45 night
- **AMDAL (Analisis Mengenai Dampak Lingkungan)** — environmental impact assessment required for major infrastructure
- **BPLHD / DLH** — provincial environmental agencies

Notable noise zones include:

- **Jakarta Outer Ring Road (JORR)** — chronic congestion, ~200k AADT in peak sections
- **Trans-Java Toll Road** — Jakarta ↔ Cikampek ↔ Semarang ↔ Surabaya
- **Jakarta 3-in-1 zones** + Sudirman-Thamrin corridor
- **Surabaya Suramadu Bridge** and Middle-East Ring Road (MERR)
- **Bandung Padalarang-Cileunyi Toll (Padaleunyi)**
- **Denpasar-Sanur-Kuta Bypass** (tourism congestion)
- **KAI Commuter (KCI) Jabodetabek** — ~1.2M pax/day on Red/Blue/Yellow/Green lines
- **Jakarta MRT elevated viaduct** (Lebak Bulus ↔ ASEAN station)
- **Whoosh HSR elevated viaduct** between Jakarta Halim and Bandung Tegalluar
- **Soekarno-Hatta International Airport (CGK / WIII)** — busiest in Indonesia, 66M+ annual pax; **Juanda (SUB), Ngurah Rai Bali (DPS), Kuala Namu Medan (KNO), Sultan Hasanuddin Makassar (UPG)** all covered by the global aircraft layer
- **Paiton coal power complex** (~4.5 GW) in East Java
- **Suralaya coal power complex** (~4 GW) in Banten
- **Bintan / Batam Free Trade Zone** — heavy port noise + industrial
- **Tanjung Priok Port (Jakarta)** and **Tanjung Perak (Surabaya)** — major container + bulk freight hubs
