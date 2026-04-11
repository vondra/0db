---
title: South Korea
intro: Noise mapping data sources for South Korea.
map: { center: [127.8, 36.0], zoom: 6 }
---

## Road traffic

### All Korean road data sources are geofenced

Korea publishes excellent road traffic data via:

- **KOTSA** (Korea Transportation Safety Authority) and **MOLIT Standard Node-Link** (~600,000 links nationwide)
- **KTDB** (Korea Transportation Database) — authoritative per-segment AADT
- **Korea Expressway Corporation TCS** API at [data.ex.co.kr/openapi](https://data.ex.co.kr/openapi/) for toll-segment counts

But **all Korean government data portals refuse connections from non-KR IPs** (data.go.kr, its.go.kr, ktdb.go.kr, road.re.kr). Signups require Korean i-PIN authentication via Korean mobile carrier. Korean roads currently use OSM `maxspeed` + class defaults.

## Railway

### Critical limitation: Korean subway lines not extracted

The pipeline's OSM extractor (`engine/osm-extract/src/classify.rs`) only accepts railway tags `rail | tram | light_rail | narrow_gauge | funicular`. Korean **subway** systems tagged as `railway=subway` in OSM are NOT in the extracted data:

- **Seoul Metropolitan Subway** — Lines 1-9, Sinbundang, Suin-Bundang, Gyeongui-Jungang, Airport Express, Gimpo Goldline, Sillim, Ui-Sinseol — the world's most extensive metro network by ridership
- **Busan Metro** — Lines 1-4 + Donghae Line
- **Daegu Metro** — Lines 1-3
- **Daejeon Metro** — Line 1
- **Gwangju Metro** — Line 1
- **Incheon Metro** — Lines 1, 2

This is a pipeline-level issue (not specific to enrichment). Adding `subway` to the railway accept list in classify.rs and re-extracting OSM would unlock the entire Korean metro network.

### KORAIL operator-class CNOSSOS defaults

For the rail segments that ARE extracted (KORAIL conventional rail + commuter), this script applies CNOSSOS-EU class defaults based on `rail_type` + `usage`:

| rail_type | usage | trains/day |
|---|---|---|
| 0 (rail) | 0 (main) | 200 (KORAIL trunk) |
| 0 (rail) | 1 (branch) | 80 (KORAIL branch) |
| 2 (light_rail) | * | 250 (urban light rail) |
| 1 (tram) | * | 200 |
| 3 (narrow_gauge) | * | 30 |

- **Result**: 109,967 KORAIL/commuter rail segments enriched (51.4%) across 124 KR hexes
- **Source**: derived from OSM extraction tags only — no external data
- **Note**: Korea publishes no public GTFS for KORAIL or any metro operator. KRIC (Korea Rail Network Authority) API at data.kric.go.kr provides train counts and timetables but requires Korean researcher account

## Buildings

GHSL Built-H R2023A 100 m global raster + Overture/Microsoft Building Footprints (already in `/enrich-global`). MOLIT GIS건물통합정보 has ~7.5M Korean buildings with floor counts (EPSG:5179) but requires KR access + data.go.kr signup.

## Industrial

### Power plants — GPPD

WRI Global Power Plant Database via `/enrich-global` covers ~132 Korean plants. Major sources of industrial noise:

- **Nuclear**: Hanul (5.9 GW), Hanbit (5.9 GW), Saeul, Wolseong, Gori (decommissioning)
- **Coal**: Dangjin, Boryeong, Hadong, Taean, Yeongheung
- **Hydroelectric**: Soyang Dam, Chungju Dam
- **Wind**: Gangwon, Jeju, Youngheung, Taebaek, Daegwallyeong (12 wind farms in GPPD)

### Wind turbines

Korea has ~1.7 GW installed wind capacity (very low for population due to terrain + grid constraints + offshore wind regulations). OSM has ~844 wind turbines in Korea. No per-turbine open registry from KEPCO/KEMCO.

### K-PRTR (gap)

Korean PRTR at [icis.me.go.kr/prtr](https://icis.me.go.kr/prtr/prtrdata.do) has ~4,000 facilities/year with chemical releases under OGL-Korea Type 1 license. Data is geofenced (KR IP only). Mirror at data.go.kr/15024756 requires API key.

## Validation

Korea does not implement END (the EU Environmental Noise Directive). Domestic noise regulation:

- **소음·진동관리법** (Noise and Vibration Control Act) — federal noise standard
- **환경부 (MOE)** publishes traffic noise standards (60-70 dB Lden zones)
- **국립환경과학원 (NIER)** monitors environmental noise nationally
- **Local governments** — Seoul, Busan, Daegu publish urban noise complaint statistics

The Seoul Metropolitan Government publishes detailed noise maps for the inner city via [stat.seoul.go.kr](https://stat.seoul.go.kr/) but in Korean only and not as bulk download. The Korea Environment Institute (KEI) publishes annual environmental noise reports.
