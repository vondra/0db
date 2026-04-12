---
title: Lebanon
intro: Noise mapping data sources for Lebanon.
map: { center: [35.8, 33.9], zoom: 8 }
---

## Road traffic

### Class defaults only

MoPWT publishes no open AADT. Fall back to class defaults with Beirut Tier-1 boost. **Lebanon has NO railway and NO public transit system** — one of the most car-dependent countries in the Middle East.

### Lebanese AADT defaults

Lebanon is **tiny** (10,452 km²) but densely populated along the coast. Traffic is extreme in Beirut and the coastal corridor.

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (A1 Beirut-Tripoli, A3 Beirut-Sidon) | 35,000 | 70,000 | 49,000 |
| 1 trunk | 18,000 | 36,000 | 25,200 |
| 2 primary | 10,000 | 20,000 | 14,000 |
| 3 secondary | 5,000 | 10,000 | 7,000 |
| 4 tertiary | 2,200 | 4,400 | 3,080 |
| 5 residential | 900 | 1,800 | 1,260 |

**Tier-1 metro** (×2.0): **Beirut** (~2.4M metro — Mediterranean coast, extreme congestion, **NO public transit system** beyond informal minibuses and "service" shared taxis. **August 4, 2020 port explosion** (218 killed, 7,000 injured, $15B damage) devastated central port area.)

**Tier-2 cities** (×1.4): **Tripoli** (~500k, 2nd city, north), **Sidon/Saida** (~250k, south), **Tyre/Sour** (~200k, south, UNIFIL zone), Jounieh (~100k, Keserwan coast), **Byblos/Jbeil** (one of world's oldest continuously inhabited cities, ~7,000 years), **Zahle** (~100k, Bekaa Valley), **Baalbek** (~80k, Bekaa, UNESCO Roman ruins — Temple of Jupiter, one of world's largest Roman structures).

### Lebanese vehicle split

**Extreme car dominance** — no public transit:

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Beirut) | **74%** | 6% | 14% | 6% |
| Tier-2 | 72% | 5% | 18% | 5% |
| Rural | 65% | 3% | 28% | 4% |
| **A1 Coastal motorway** | 70% | 3% | 24% | 3% |

## Railway

### Lebanon has NO railway

Lebanon's **entire railway system was destroyed in the 1975-1990 civil war** and has **never been rebuilt**. The historic Beirut-Tripoli line, Beirut-Damascus rack railway (one of the steepest in the world), and Tripoli-Homs line are all **complete ruins**. Station buildings in Beirut (Mar Mikhaël), Tripoli, and along the coast still exist but are abandoned/repurposed. No metro, no tram, no BRT.

Railway enrichment is **skipped entirely**.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 49 plants, 19 operating, ~2.84 GW

**Operating fuel**: oil/gas **17** + hydropower 2. **Almost entirely oil-fired** — NO coal, NO nuclear, NO wind, NO solar in operating fleet. **EDL (Électricité du Liban) is BANKRUPT** since 2019 — **12-20 hour daily blackouts**. **Most of Lebanon's actual electricity comes from ~6,000+ private diesel generators** (neighborhood-level, not in GEM).

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Zouk Mosbeh** | **805** (5 units) | oil | 1960s oil-fired — **one of Middle East's most polluted power plants** (Keserwan coast north of Beirut). Chronic respiratory complaints from neighbors |
| **Jieh** | 540 (4 units) | oil | 1960s, south of Beirut coast. **Damaged in 2006 Israel-Lebanon war** (oil spill into Mediterranean) |
| **Deir Ammar** | 465 | oil/gas | Newer, Tripoli area |
| **Zahrani** | 465 | oil/gas | Newer, Sidon area |
| **Litani cascade** | ~200 | hydropower | Litani River — Lebanon's only significant hydro (Boulous Arqash 108 + smaller units) |
| **Hraishe** | 75 | oil/gas | Beirut area |

All operating plants map to **NACE 35**.

### Lebanon does NOT have

- **No open AADT** — MoPWT publishes nothing (state institutions barely functional in crisis)
- **No railway** (destroyed 1975-1990, never rebuilt)
- **Tripoli oil refinery** not NACE 19 — 1950s, **closed 2020** (was Lebanon's only)
- **Cement**: Sibline (Ciments de Siblin), **Chekka** (Cimenterie Nationale, Holcim — dominant Lebanese industry)
- **Beirut Port** — devastated by **August 4, 2020 ammonium nitrate explosion** (218 killed, one of largest non-nuclear explosions in history)
- **NO solar, NO wind** in operating fleet — despite excellent Mediterranean solar resource. Lebanon is severely behind on energy transition due to crisis.
- **~6,000+ private diesel generators** — not in GEM but **provide most of Lebanon's actual electricity** (one of the most unusual energy systems globally)

## Validation

Lebanon has minimal functioning environmental regulation during the ongoing crisis:

- **Ministry of Environment** (barely functional since 2019 crisis)
- **Environmental Protection Law (2002, law 444)**
- Noise standards: poorly enforced, nominally WHO-based
- **Beirut is one of the noisiest cities in the Mediterranean** — diesel generators on every block + extreme car congestion + construction + no public transit

Notable noise zones:

- **Beirut** — extreme congestion, no public transit, **diesel generators running 12-20h/day on every block** (unique noise source — not in CNOSSOS model but extremely dominant in reality)
- **A1 Beirut↔Tripoli coastal motorway**
- **A3 Beirut↔Sidon**
- **Beirut-Rafic Hariri International (BEY/OLBA)** — covered by global aircraft layer
- **Zouk Mosbeh power plant** (805 MW oil — Middle East's most polluted)
- **Jieh power plant** (540 MW)
- **Chekka cement** (Cimenterie Nationale — coastal industrial)
- **Beirut Port** (post-2020 explosion reconstruction zone)
- **Bekaa Valley** (agricultural + Hezbollah presence)
