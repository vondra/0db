---
title: Japan
intro: Noise mapping data sources for Japan.
map: { center: [137.0, 36.5], zoom: 5 }
---

## Road traffic

### MLIT 道路交通センサス令和3年度 — orphan attribute data

[MLIT](https://www.mlit.go.jp/) (Ministry of Land, Infrastructure, Transport and Tourism) publishes the **道路交通センサス** (Road Traffic Census) every 5 years. The latest is **令和3年度** (Reiwa 3 = 2021) with ~230,000 road segments across all 47 prefectures.

- **Per-prefecture CSVs**: `https://www.mlit.go.jp/road/census/r3/data/csv/kasyo{01..47}.csv`
- **Cached**: `data/enrichment/global/mlit-census/kasyo01.csv` (Hokkaido, 4,883 records)
- **Encoding**: Shift-JIS, 159 columns including 24h AADT split by vehicle class, travel speed, lane count, speed limit, central divider, intersection density
- **License**: Government of Japan Standard Terms of Use v2.0 (CC-BY-4.0 compatible)

**Critical limitation**: The census CSVs are tabular only — there is **no open spatial join**. The 交通調査基本区間番号 (kasyo ID) keys into the proprietary **DRM (Digital Road Map)** by 道路地図センター, which is paid. KSJ N13-2024 (road network) has no kasyo ID. MLIT's R3 WebMap visualizer uses closed backend data.

Japanese roads currently use OSM `maxspeed` + class defaults. The road AADT data exists but cannot be applied without DRM licensing or manual scraping of the WebMap.

## Railway

### MLIT N02-2024 station-density proxy

[MLIT National Land Numerical Information](https://nlftp.mlit.go.jp/ksj/) publishes **N02-24 鉄道** (Railway 2024) with 21,932 rail line sections and 10,235 stations across all Japanese operators.

- **Source**: [N02-24 GML zip](https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-24/N02-24_GML.zip) (12.7 MB, JGD2011, CC-BY-4.0)
- **Cache**: `data/enrichment/global/mlit-census/N02-24_GML.zip`

Japan publishes no public GTFS for major rail operators without API key registration ([ODPT](https://developer.odpt.org/) requires auth). The script applies operator-class default frequencies based on N02 station presence:

| Operator | Trains/day |
|---|---|
| **東京地下鉄** (Tokyo Metro) | 600 |
| **東京都** (Toei Subway) / 大阪市 (Osaka Metro) | 500 |
| **京都市/札幌市/名古屋市/横浜市/福岡市 subways** | 400 |
| **東急/小田急/京王** (Tokyo major private) | 350 |
| **東武/京浜急行/西武** (Tokyo private) | 300 |
| **東日本旅客鉄道** (JR East) | 250 |
| **近畿日本鉄道/名古屋鉄道/阪急/京阪** | 200-250 |
| **東海旅客鉄道/西日本旅客鉄道** (JR Central, JR West) | 200 |
| **九州旅客鉄道** (JR Kyushu) | 100 |
| **北海道旅客鉄道** (JR Hokkaido) | 80 |
| **四国旅客鉄道** (JR Shikoku) | 60 |
| Other private / monorail | 100-150 |

- **Result**: 559,863 railway segments enriched across 290 hexes (69.24% of all rail in JP hexes)

### City coverage

| City | % Enriched | Max trains/day |
|---|---|---|
| Kyoto | 76.8% | 400 |
| Kobe | 76.3% | 500 |
| Nagoya | 73.0% | 400 |
| Osaka | 72.5% | 500 (Osaka Metro) |
| Tokyo | 70.8% | 600 (Tokyo Metro) |
| Yokohama | 70.1% | 400 |
| Fukuoka | 68.7% | 400 |
| Sapporo | 48.3% | 400 |

### Gap — actual GTFS frequencies

These are operator-class defaults, not real schedules. To unlock real train counts would require [ODPT](https://developer.odpt.org/) developer registration to access GTFS feeds for Tokyo Metro, Toei, JR East, JR West, JR Central, etc.

## Buildings

GHSL Built-H R2023A 100 m global raster + Overture/Microsoft Building Footprints (already in `/enrich-global`). GSI (Geospatial Information Authority of Japan) publishes building data via PSGI tiles but no per-building heights in open form.

## Industrial

### Power plants — GPPD

WRI Global Power Plant Database via `/enrich-global` covers Japanese plants. Major sources of industrial noise:

- **Nuclear**: Kashiwazaki-Kariwa (8.2 GW, world's largest by capacity), Fukushima Daiichi/Daini (decommissioning), Sendai, Genkai, Ikata, Ohi, Takahama
- **Thermal coal/gas**: Kashima, Hekinan, Hirono, Hitachinaka, Tachibanawan
- **Hydroelectric**: Kurobe Dam, Okutadami, Tagokura

### Wind turbines

Japan has ~5 GW installed wind capacity (small for a G7 country due to terrain + grid constraints). The KSJ P03-13 dataset (2013, 417 wind plants) is too stale to be useful — Japan's fleet has grown significantly post-FIT 2012.

OSM has ~14,320 wind turbines in Japan but only 8.6% currently have specs. No per-turbine open registry exists from NEDO/METI.

### PRTR-Japan (gap)

Environment Ministry PRTR (令和6年度, FY2024) is downloadable as Shift-JIS CSV from [env.go.jp/chemi/prtr/kaiji/data/R06PRTRdata.zip](https://www.env.go.jp/chemi/prtr/kaiji/data/R06PRTRdata.zip) (~35,000 facilities with NAICS-equivalent codes + coordinates). Not yet implemented — would require Shift-JIS parsing + Japan industry code → NACE mapping.

## Validation

Japan does not implement END (the EU Environmental Noise Directive). Domestic noise regulation is fragmented:

- **環境基本法** (Environment Basic Law) — federal noise standards
- **MOE 環境省** (Ministry of Environment) — environmental noise standards (50/55/60 dB Lden zones)
- **MLIT 国土交通省** — road and railway noise standards along major corridors
- **Prefectural and municipal noise bylaws** — Tokyo, Kanagawa, Osaka, Aichi publish per-municipality noise complaint statistics

Notable noise studies: Tokyo Metropolitan Government publishes Shinkansen noise contours along the Tokaido Shinkansen; Osaka Prefecture monitors Hanshin Expressway and Osaka Metro Midosuji Line.
