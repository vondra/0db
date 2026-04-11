---
title: Asia
intro: Noise mapping overview for Asia — global baseline with per-country enrichment where data exists.
map: { center: [100, 35], zoom: 3 }
---

## Data situation

Asia has no continent-wide open data mandates comparable to Europe's Environmental Noise Directive. Each country publishes data independently, in different formats, and often behind registration or API keys. The noise map relies on the global baseline (OSM, GHSL, Copernicus DEM, WorldCover) supplemented by per-country enrichment where feasible.

## Continental enrichment

No multi-country Asian datasets exist (no equivalent of EU open data directives). Enrichment is per-country using the best available open data.

### Research findings (2026-04)

| Country | Dataset | What | Status |
|---------|---------|------|--------|
| **Japan** | MLIT road traffic census (R3/2021) | AADT by road section, light/heavy split | Available — CSV from mlit.go.jp, needs GIS join (no coordinates in CSV) |
| **Japan** | ODPT (Open Data for Public Transportation) | JR + metro GTFS timetables | Requires registration + API key |
| **South Korea** | data.go.kr transit feeds | GTFS for various operators | Requires Korean registration |
| **Taiwan** | TDX (Transport Data Exchange) | Rail + bus GTFS | Requires API key (returns 401) |
| **India** | Indian Railways | No national GTFS published | Not available |
| **China** | — | No open transit data | Not available |
| **SE Asia** | Individual city feeds | Fragmented, no country-level data | Per-city only |

### What the map uses (global baseline)

All Asian countries benefit from global enrichment:
- **DEM**: Copernicus GLO-30 (30m, 2021) — terrain diffraction
- **Buildings**: GHSL 100m + Overture Maps per-building heights where available (Tokyo 3%, limited elsewhere)
- **Forest**: ESA WorldCover 10m — vegetation attenuation
- **Ground**: WorldCover-derived G-factor (no Copernicus IMD outside Europe)
- **Industrial**: GPPD power plants (NACE 35) — sector-specific emission for power plants
- **Wind turbines**: USWTDB (US only — Asian turbines use OSM defaults)
- **Traffic**: OSM road class defaults (no AADT data applied outside Japan)
- **Railway**: Indian Railways GTFS — 8,495 stations, 150K segments enriched with real train frequencies. Other countries use OSM defaults.

### Per-country enrichment priority

1. **Japan** — richest open data (MLIT census + ODPT, both need processing)
2. **South Korea** — data.go.kr has GTFS but requires registration
3. **Taiwan** — TDX API has good data but needs API key
4. **India** — no national open transit/traffic data
5. **China** — no open data available

## Methodology

Same as global: CNOSSOS-EU emission + ISO 9613-2 propagation. No regional noise standards are applied — the model uses EU methodology worldwide for consistency.
