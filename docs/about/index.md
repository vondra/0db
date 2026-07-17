---
title: 0db.app
intro: Find your quiet place. A world atlas of environmental noise — roads, railways, aircraft, and industry.
map: { center: [15, 30], zoom: 2 }
---

## Mission

**Make noise visible. Make quiet possible.**

0db.app shows how loud the world really is — and helps you find the quiet.

1. **Find quiet places** — search any address, explore the map, discover where to live, work, or relax without noise
2. **Understand noise** — see which sources contribute (roads, railways, aircraft, industry) and how terrain, buildings, and forests reduce it
3. **Track change over time** — noise maps updated regularly make noise visible and measurable. By tracking it transparently over time, governments and communities have the data to act — and everyone can see whether things are getting quieter

Human-made noise is not the same as natural sound. A forest at 50 dB with birdsong feels quiet. A road at 50 dB with traffic feels loud. 0db.app measures environmental noise from human sources — transport, industry, and urban activity — not nature.

## How the map works

The map computes noise in three steps: **sources emit it** (roads, trains, planes, factories, buildings — modelled from real traffic counts, flight tracks and registries), **it travels and fades** (hills, buildings and forests block it, simulated with ISO 9613-2 physics), and **you see the result** on a ~12-meter raster, colored from pale (quiet) through yellow and orange to deep purple (80+ dB, very loud). Each of the five source layers — roads, railways, aircraft, industrial, buildings — is modelled independently and toggles on its own in the UI.

![0db.app — noise visualization](map-overview.jpg)

→ **[Read the full methodology](/about/methodology)** — per-layer emission standards (CNOSSOS-EU, Doc 29, IEC 61400-11), the propagation physics, where the model simplifies vs the standards, and the ongoing accuracy validation against real measurement stations.

## Defaults and enrichment

Each layer's [methodology](/about/methodology) page lists **fallback defaults** — what we assume when no measured data exists. Where real data is available it overrides them, resolved through a four-tier cascade: **city → country → continent → world**. A place with a local traffic survey uses it; otherwise it inherits its country's value, then its continent's, then a global default.

**Enrichment is class-aware.** A measured motorway count is matched only to motorway-class segments, so a residential street never inherits a neighbouring highway's traffic and a tram siding never inherits a mainline's train count (a systemic class-blind bug fixed 2026-06/07). Coverage today (and growing):

- **Roads** — 53 countries with national traffic data (US HPMS, EU 36-city harmonized AADT, national surveys), plus the global service-tree estimate for minor roads.
- **Railways** — ~50 countries from GTFS passenger timetables + national freight-corridor estimates, family-aware (tram / siding / mainline kept separate).
- **Industrial** — ~124 countries with industrial enrichment: the EU-wide E-PRTR pollution registry (~30k facilities), the Global Power Plant Database, and national wind-turbine and power-plant registries; wind turbines from a global turbine inventory.

Everything else falls back to the class-defaults. Each country page lists its specific sources.

### Explore by region

<!-- REGION_CHILDREN -->

## What you see on the map

### The noise indicator: Lden

The map shows **Lden** (day-evening-night level), the European standard from [END 2002/49/EC](https://eur-lex.europa.eu/eli/dir/2002/49/oj/eng). It weights evening noise +5 dB and night noise +10 dB to reflect the greater annoyance of noise during rest periods:

```
Lden = 10 × log₁₀((12 × 10^(Ld/10) + 4 × 10^((Le+5)/10) + 8 × 10^((Ln+10)/10)) / 24)
```

Day: 07:00–19:00, evening: 19:00–23:00, night: 23:00–07:00.

[WHO 2018 guidelines](https://www.who.int/europe/publications/i/item/9789289053563) recommend: road < 53 dB, rail < 54 dB, aircraft < 45 dB Lden.

### Grid

A Web-Mercator raster at zoom 12 (512-pixel tiles, ~12 m per pixel at 50°N, varies with latitude) — fine enough to distinguish the street-facing vs garden side of a building. A zoom pyramid (z2–12) serves coarser tiles when zoomed out.

### Color scale

The published, user-tested scheme from Weninger, ["A Color Scheme for the Presentation of Sound Immission in Maps"](https://www.researchgate.net/publication/280488890_A_color_scheme_for_the_presentation_of_sound_immission_in_maps), EuroNoise 2015 (232 respondents, see also [coloringnoise.com](https://www.coloringnoise.com/)) — reused unmodified, hex for hex, dB for dB. Below 35 dB is transparent (Weninger's own "no color"); 80 dB is the paper's terminal shade, and the map holds that color flat above it rather than inventing a darker one. Colors interpolate smoothly between rows — a cell at 62 dB gets a blended shade between the 60 and 65 dB rows, never a hard jump — and opacity rises alongside color, quiet cells fading into the basemap rather than fogging it.

| Lden | Swatch | Hex | Opacity |
|------|--------|-----|---------|
| < 35 dB | — | — | 0% — not shown |
| 35 dB | <span style="display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;border:1px solid rgba(0,0,0,.15);background:#A0BABF"></span> | `#A0BABF` | 20% |
| 40 dB | <span style="display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;border:1px solid rgba(0,0,0,.15);background:#B8D6D1"></span> | `#B8D6D1` | 26% |
| 45 dB | <span style="display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;border:1px solid rgba(0,0,0,.15);background:#CEE4CC"></span> | `#CEE4CC` | 32% |
| 50 dB | <span style="display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;border:1px solid rgba(0,0,0,.15);background:#E2F2BF"></span> | `#E2F2BF` | 38% |
| 55 dB | <span style="display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;border:1px solid rgba(0,0,0,.15);background:#F3C683"></span> | `#F3C683` | 46% |
| 60 dB | <span style="display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;border:1px solid rgba(0,0,0,.15);background:#E87E4D"></span> | `#E87E4D` | 54% |
| 65 dB | <span style="display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;border:1px solid rgba(0,0,0,.15);background:#CD463E"></span> | `#CD463E` | 62% |
| 70 dB | <span style="display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;border:1px solid rgba(0,0,0,.15);background:#A11A4D"></span> | `#A11A4D` | 69% |
| 75 dB | <span style="display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;border:1px solid rgba(0,0,0,.15);background:#75085C"></span> | `#75085C` | 75% |
| 80+ dB | <span style="display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:middle;border:1px solid rgba(0,0,0,.15);background:#430A4A"></span> | `#430A4A` | 80% |

### Toggles

- **Source layers:** Roads, Railways, Industrial, Buildings, and Aircraft (ground ops, airborne, cruise) — each toggleable independently
- **Overlays:** Quiet zones (areas below a threshold)

## Overlays

### Real estate — in preparation

Real-estate listings filtered by noise level are planned but not available yet — we are preparing the data sources. The feature will sample each property's noise from the published z12 noise raster (the same tiles the map shows) and filter listings by a configurable Lden threshold.

### Quiet zones

Shades every map pixel below a configurable noise threshold (default 35 dB, slider 20–45) green. Useful for identifying quiet retreats, parks, and areas suitable for noise-sensitive development.

## Who builds this

0db.app is built by one person working with three AI coding agents: **Claude** as lead developer, **Codex** as second developer and code reviewer, and **Gemini** for an independent second opinion and review. Development started in June 2025 on Opus 4; every major Opus, GPT, and Gemini release since has been tried on this codebase — progress accelerated markedly with [OpenClaw](https://openclaw.ai/) and Opus 4.6, and it's kept getting better since.

0db.app is an internal project of [Miton](https://www.miton.cz/en/).

The code will be open-sourced once the repository is cleaned up for public release. The computations themselves are already transparent and reproducible from public data.

## Credits & terms

0db.app builds on the open geodata ecosystem — OpenStreetMap, Copernicus, ESA WorldCover, ADS-B community feeds, and more — and is free to use and embed with attribution, no cookies or trackers.

→ **[Data credits, usage terms & privacy](/about/credits)**

## Contact & status

- **Email:** [hello@0db.app](mailto:hello@0db.app)
- **Service status:** [status.0db.app](https://status.0db.app) — live uptime of the map and tiles
