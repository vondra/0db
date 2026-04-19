---
title: India
intro: Noise mapping data sources for India.
map: { center: [78.0, 22.0], zoom: 5 }
---

## Road traffic

### Bharatmala Road Network + Indian-tuned CNOSSOS defaults

No per-segment AADT is published openly for India. NHAI traffic census data is PDF-only and the official NHAI / MoRTH / data.gov.in portals are WAF-blocked for programmatic access from non-Indian IPs. However, the **Esri Living Atlas India** (`livingatlas.esri.in`) public ArcGIS Server mirrors 300+ official government datasets under anonymous access — the same workaround pattern that worked for Saudi Arabia and Thailand.

**Bharatmala Road Network** (National Highway Masterplan):

- **Source**: [Esri Living Atlas India — Road Centerline Bharatmala](https://livingatlas.esri.in/server/rest/services/Road_Network/Road_Centerline_Bharatmala/MapServer/0)
- **Records**: 28,372 polyline segments (WGS84, LineString)
- **Fields**: `rdtype`, `baratmlatp1`, `rdname1`, `rdcodeprm`, `state`, `roadlength` (km)
- **Classification breakdown**:
  - National Highway: 16,525 segments
  - State Highway: 11,356 segments
  - Expressway: 486 segments
  - Ring Road: 5 segments

**AADT defaults by road class** (rural → Tier-1 city ×2.0 → Tier-2 city ×1.3):

| Class | Rural AADT | Tier-1 metro | Tier-2 city |
|---|---:|---:|---:|
| Expressway | 80,000 | 160,000 | 104,000 |
| National Highway | 35,000 | 70,000 | 45,500 |
| State Highway | 15,000 | 30,000 | 19,500 |
| Ring Road | 50,000 | 100,000 | 65,000 |
| OSM motorway | 70,000 | 140,000 | 91,000 |
| OSM trunk | 30,000 | 60,000 | 39,000 |
| OSM primary | 12,000 | 24,000 | 15,600 |
| OSM secondary | 5,000 | 10,000 | 6,500 |
| OSM tertiary | 2,000 | 4,000 | 2,600 |
| OSM residential | 1,000 | 2,000 | 1,300 |

**Tier-1 metros** (×2.0): Delhi NCR, Mumbai, Bangalore, Hyderabad, Chennai, Kolkata, Ahmedabad, Pune.

**Tier-2 cities** (×1.3, 33 total): Jaipur, Lucknow, Kanpur, Nagpur, Indore, Thane, Bhopal, Visakhapatnam, Patna, Vadodara, Ghaziabad, Ludhiana, Agra, Nashik, Faridabad, Meerut, Rajkot, Kalyan, Varanasi, Srinagar, Amritsar, Prayagraj, Ranchi, Howrah, Coimbatore, Jabalpur, Gwalior, Vijayawada, Jodhpur, Madurai, Kochi, Thiruvananthapuram, Surat.

**Indian vehicle split** — dominated by motorcycles (India has ~200M+ two-wheelers, more than any other country):

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 metros | 45% | 8% | 7% | **40%** |
| Tier-2 cities | 50% | 9% | 10% | **31%** |
| Rural | 55% | 10% | 15% | **20%** |

### Additional reference data (cached, not applied)

- **India Toll Plazas** ([Living Atlas](https://livingatlas.esri.in/server/rest/services/India_Toll/FeatureServer/0)) — 1,766 toll plaza locations with NH number, per-axle rates. Cached for reference.

### Blocked sources

- **NHAI** at [nhai.gov.in](https://nhai.gov.in) — TCP-blocked from non-IN IPs
- **MoRTH** at [morth.gov.in](https://morth.gov.in) — same
- **data.gov.in** — Cloudflare WAF blocks bot UA
- **IRC, RRDA, PMGSY, BHURASTA Bharatmala, FASTag** — published but not machine-readable, mostly PDF tables

## Railway

### Living Atlas IN Railway Network

India has the **fourth-largest rail network in the world** (~68,000 km route, ~126,000 km track) operated by Indian Railways. The Esri Living Atlas India mirrors the full network geometry with per-segment speed, gauge type, and zone attribution — the richest national rail dataset we've seen for any country.

- **Source**: [Living Atlas IN Railway Line](https://livingatlas.esri.in/server1/rest/services/Railway/IN_Railway_Line/MapServer/1)
- **Records**: **119,446 polyline segments** (68 MB GeoJSON)
- **Per-segment fields**: `fromjunction`, `tojunction`, `speed` (km/h), `type` (gauge class), `railwayzone`, `nooflanes`, `bridge_yn`, `tunnel_yn`
- **Gauge distribution**:
  - **Broad Gauge** (1676mm): 114,968 (96%) — the Indian standard, unique to the subcontinent
  - Metre Gauge: 2,123 (heritage + limited regional)
  - Narrow Gauge: 1,864 (hill railways — Darjeeling, Shimla, Nilgiri, Matheran — UNESCO World Heritage)
  - Standard Gauge: 81 (some metros + freight dedicated corridors)
- **Speed distribution**:
  - Vande Bharat / Rajdhani corridors (≥100 km/h): 53,123 segments
  - Secondary lines (60-99 km/h): 7,361 segments
  - Local / station / yard (0-59 km/h): 58,579 segments

### Indian Railways zones

| Zone | HQ | Segments |
|---|---|---:|
| South Central Railway | Secunderabad | 14,242 |
| Western Railway | Mumbai Central | 13,761 |
| South Western Railway | Hubli | 8,475 |
| Southern Railway | Chennai | 8,011 |
| North Western Railway | Jaipur | 7,768 |
| Northern Railway | New Delhi | 6,862 |
| West Central Railway | Jabalpur | 6,829 |
| East Coast Railway | Bhubaneswar | 6,632 |
| East Central Railway | Hajipur | 6,385 |
| North Central Railway | Prayagraj | 6,035 |
| Central Railway | Mumbai CST | 6,018 |
| Northeast Frontier Railway | Guwahati | 6,232 |
| South Eastern Railway | Kolkata | 4,794 |
| South East Central Railway | Bilaspur | 4,464 |
| North Eastern Railway | Gorakhpur | 3,715 |
| Eastern Railway | Kolkata | 3,521 |
| Konkan Railway | Navi Mumbai | 1,426 |

### Trains/day defaults by context

| Context | Passenger | Freight |
|---|---:|---:|
| **Mumbai Suburban** (Central/Western Railway within Mumbai bbox) | **1,300** | 30 |
| **Kolkata Suburban** (Eastern/SE Railway within Kolkata bbox) | 500 | 25 |
| **Delhi Suburban** (Northern Railway within NCR) | 350 | 20 |
| **Chennai Suburban** (Southern Railway within Chennai bbox) | 350 | 20 |
| Bangalore/Hyderabad/Ahmedabad/Pune (no dedicated suburban rail) | 60 | 20 |
| Broad Gauge ≥120 km/h (Vande Bharat / Rajdhani corridors) | 30 | 15 |
| Broad Gauge 100-119 km/h | 25 | 15 |
| Broad Gauge 60-99 km/h | 15 | 10 |
| Broad Gauge <60 km/h | 8 | 5 |
| Metre/Narrow Gauge (heritage lines) | 5 | 0 |

**Mumbai Suburban Railway** (Western Railway + Central Railway + Harbour Line) is the **world's busiest commuter rail system** by passenger volume, carrying ~7.5 million passengers per weekday on 2,342 scheduled services.

### Metro systems in India

**India Metro Network** ([Living Atlas](https://livingatlas.esri.in/server1/rest/services/MetroNetwork/India_Metro_Network/MapServer)):

- **83 metro lines** + 1,401 metro stations across 14+ cities:
  - **Delhi Metro** (DMRC) — 10 lines, ~390 km — largest Indian metro
  - **Mumbai Metro** — multiple lines under expansion (Line 1 blue operational 2014, Line 2A/7 yellow, Line 3 aqua underground)
  - **Bangalore Namma Metro** (BMRCL) — Blue/Pink/Purple/Green/Yellow lines
  - **Chennai Metro** — Green/Blue lines
  - **Kolkata Metro** — the first Indian metro (Blue Line 1984)
  - **Hyderabad Metro** — Red/Blue/Green
  - **Kochi Metro, Nagpur Metro, Lucknow Metro, Jaipur Metro, Ahmedabad Metro, Pune Metro, Bhopal Metro, Bhubaneswar Metro**
- **Applied default**: 400 trains/day per matched OSM segment (typical UTO metro with 2-3 min peak headway)
- **Namo Bharat RRTS** (Regional Rapid Transit System) — Delhi-Meerut first phase operational 2024

### Critical pipeline limitation: Indian metros mostly NOT extracted

**Most Indian metros are tagged `railway=subway` in OSM.** The pipeline's OSM extractor only accepts `rail | tram | light_rail | narrow_gauge | funicular`, so **Delhi Metro underground, Kolkata Metro tunnels, Mumbai Metro Line 3 (Aqua), Chennai Metro underground, Bangalore Namma Metro Purple underground sections** are NOT in `railways.arrow`. Elevated sections tagged `railway=light_rail` DO get extracted and match the 400/day metro default.

This is the same bug affecting Dubai Metro, Bangkok MRT, Taipei Metro, Singapore MRT, Seoul Metro, Tokyo Metro, Hong Kong MTR, Mexico City Metro. Adding `"subway"` to the extractor accept list would unlock all 9+ metros simultaneously.

## Buildings

GHSL Built-H R2023A 100 m global raster + Overture Maps Foundation building footprints. Microsoft published 105 million Indian building footprints in 2024, now integrated into Overture Maps. No India-specific building enhancement applied; ISRO Bhuvan + BBMP/MCD/BMC municipal cadastres are auth-gated.

## Industrial

### Power Plants (Living Atlas India)

**1,459 georeferenced power plants** across India — the most comprehensive national power registry in our pipeline. Supplements WRI GPPD (which stopped updating in 2022, missing Sudair / NEOM / newer Indian megaprojects).

- **Source**: [Living Atlas Power Plants in India](https://livingatlas.esri.in/server/rest/services/India/Power_Plants/MapServer/0)
- **Fuel breakdown**:
  - **Coal**: 251 plants (135 ≥500 MW) — Mundra, Vindhyachal (4.8 GW), Talcher, Sipat, Sasan, Anpara, Rihand, Tiroda, Wanakbori, Singrauli, Kahalgaon, Farakka, Korba, Chandrapur
  - **Gas CCGT**: 68 plants — Dadri, Anta, Kawas, Dhuvaran, Trombay
  - **Oil**: 16 plants
  - **Hydro**: 231 plants — Tehri, Bhakra, Sardar Sarovar, Nathpa Jhakri, Srisailam, Nagarjuna Sagar, Koyna, Idukki, Kadamparai
  - **Nuclear**: Kudankulam (VVER-1000), Tarapur, Kakrapar, Rawatbhata, Kaiga, Narora, Madras (Kalpakkam)
  - **Wind**: 106 wind farms — Muppandal Tamil Nadu (1.5 GW), Jaisalmer Rajasthan (1.1 GW), Kutch Gujarat (2+ GW combined), Andhra Pradesh coast, Karnataka Gadag
  - **Solar PV**: 737 plants — Bhadla (2.3 GW), Pavagada Solar Park (2 GW), Kurnool (1 GW), Kamuthi (648 MW)
  - **Biomass**: 50 plants

### Industrial Parks with CPCB pollution classification — the gem

**4,924 industrial parks** classified by Central Pollution Control Board (CPCB) emission category:

- **Red category** (641 parks) — cement, chemicals, metallurgy, thermal power, paper, distilleries. Mapped to NACE 24 (basic metals) in enrichment.
- **Orange category** (645 parks) — chemicals, pharmaceuticals, textiles, food processing. Mapped to NACE 20 (chemicals).
- **Green category** (1,443 parks) — light manufacturing, assembly, packaging. Mapped to NACE 13 (textiles).
- **White category** (297 parks) — IT parks, service-sector SEZs. Mapped to NACE 62 (IT services).

- **Source**: [Living Atlas Industrial Land Park](https://livingatlas.esri.in/server/rest/services/Industry/Industrial_Land_Park/MapServer/0)

### Cement Plants

**341 cement plants** with production capacity ([Living Atlas](https://livingatlas.esri.in/server/rest/services/Cement_Plants_in_India_2024/MapServer/0)). India is the world's second-largest cement producer; major clusters in Rajasthan, Madhya Pradesh, Chhattisgarh, Andhra Pradesh.

### Enrichment result

- **100,096 OSM industrial sites** scanned across 2,288 IN-bbox hexes
- **5,397 matched** to Living Atlas (priority: cement > power > park)
- **4,636 new NACE entries** written to `industrial.arrow` `nace_4digit` column
- Total enriched `nace_4digit` entries after IN: 122,197

## Validation

India implements noise regulation via:

- **Central Pollution Control Board (CPCB)** at [cpcb.nic.in](https://cpcb.nic.in/) — Noise Pollution (Regulation and Control) Rules 2000
- **Ministry of Environment, Forest and Climate Change (MoEFCC)**
- **State Pollution Control Boards (SPCB)** in each state
- **Noise zones**: Industrial (75 dBA day / 70 night), Commercial (65/55), Residential (55/45), Silence (50/40)
- **Supreme Court orders on noise pollution** (Anupam Mishra case, 2005)

Notable noise zones include:

- **Mumbai Suburban Railway** — the world's busiest commuter rail (7.5 M passengers/day on 2,342 services)
- **Delhi Ring Road + Outer Ring Road** — massive arterial traffic, 40%+ motorcycle share
- **Bangalore Outer Ring Road / NICE Road** — peak tech corridor congestion
- **National Highway 44 (Srinagar–Kanyakumari)** — longest NH, 4,112 km
- **NH 48 (Delhi–Mumbai)** / Golden Quadrilateral — heavy freight
- **Delhi Metro elevated viaducts** (Blue, Red, Yellow, Violet, Magenta lines) — noise impact on Delhi residential areas
- **Kolkata Howrah–Sealdah rail hub** — one of the busiest rail interchanges globally
- **Jamshedpur / Rourkela / Bhilai / Durgapur steel plants** — industrial noise
- **Vindhyachal, Mundra, Talcher power plant complexes** — coal + ash transport
- **Mumbai CST + Chhatrapati Shivaji Maharaj International Airport (VABB)** — train + flight noise
