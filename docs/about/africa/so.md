---
title: Somalia
intro: Noise mapping data sources for Somalia.
map: { center: [46, 6], zoom: 5 }
---

## Road traffic

### Class defaults only

Somalia Federal Government publishes no AADT. CNOSSOS class defaults with Mogadishu Tier-1 boost. Data quality is severely limited by conflict and state fragmentation.

### Somali AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (none) | 10,000 | 20,000 | 14,000 |
| 1 trunk (main inter-city paved) | 3,500 | 7,000 | 4,900 |
| 2 primary | 1,800 | 3,600 | 2,520 |
| 3 secondary | 700 | 1,400 | 980 |
| 4 tertiary | 280 | 560 | 392 |
| 5 residential | 140 | 280 | 196 |

**Tier-1 metro** (×2.0): **Mogadishu** (~2.5M — capital; fortified Green Zone; recovering from Al-Shabaab).

**Tier-2 cities** (×1.4): **Hargeisa** (~1.5M — Somaliland capital; de facto independent; stable), **Kismayo** (~250k — southern port), **Bosaso** (~300k — Puntland, Gulf of Aden), **Baidoa** (~300k — South West State capital), **Garowe** (~130k — Puntland capital).

### Somali vehicle split

Very high motorcycle share (tuk-tuks + bajaj + motorcycles dominant in low-income urban areas).

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Mogadishu) | 40% | 10% | 15% | 35% |
| Tier-2 | 38% | 8% | 18% | 36% |
| Rural | 30% | 6% | 28% | 36% |

## Railway

### Somalia has NEVER had an operational railway.

Italian and British colonial Somalia built no rail infrastructure. A Berbera–Hargeisa connection was proposed but never constructed. Not modelled.

## Industrial

### GEM — 7 plants, operating, 94 MW

Almost entirely diesel generators. No national grid — each city has isolated generation. Somaliland (Hargeisa) and Puntland (Bosaso/Garowe) have separate utility operations from FGS.

### Key infrastructure not NACE classified
- **Berbera Port** (Somaliland) — DP World 30-year concession (2017); UAE military base; strategic Bab-el-Mandeb position
- **Mogadishu Port** — rehabilitated 2013+; main FGS import hub
- **Bosaso Port** (Puntland) — major live-animal export port (camels + small ruminants); Somalia is among the world's largest livestock exporters to the Arabian Peninsula
- **Kismayo Port** — southern agricultural/charcoal export; Al-Shabaab revenue dispute
- **Egal International Airport** (Hargeisa, HCMH) + **Aden Adde Airport** (Mogadishu, HCMM) — covered by global aircraft layer
- **HOT OSM** — Humanitarian OpenStreetMap Team mapping; variable road accuracy
