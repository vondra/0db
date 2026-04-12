---
title: Libya
intro: Noise mapping data sources for Libya.
map: { center: [17, 27], zoom: 5 }
---

## Road traffic

### Class defaults only

Libya's rival governments publish no AADT. CNOSSOS class defaults with Tripoli Tier-1 boost. High road dependency — Libya has **no operational railway** and a very sparse internal air network.

### Libyan AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (Tripoli–Misrata coastal highway) | 40,000 | 80,000 | 56,000 |
| 1 trunk (coastal highway + Sabha road) | 12,000 | 24,000 | 16,800 |
| 2 primary | 6,000 | 12,000 | 8,400 |
| 3 secondary | 2,500 | 5,000 | 3,500 |
| 4 tertiary | 1,000 | 2,000 | 1,400 |
| 5 residential | 500 | 1,000 | 700 |

**Tier-1 metros** (×2.0): **Tripoli** (~1.3M — GNU-controlled western capital + port), **Benghazi** (~700k — LNA-controlled eastern capital).

**Tier-2 cities** (×1.4): **Misrata** (~400k — western port + steel; independent militia city), **Zawiya** (~250k — western; oil refinery), **Tobruk** (~120k — far east; WWII; HoR parliament), **Sabha** (~200k — south; Fezzan; migration hub), **Al Bayda** (~250k — Green Mountain east).

### Libyan vehicle split

High car ownership (subsidised fuel historically); relatively low motorcycle share for Africa.

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Tripoli/Benghazi) | 70% | 10% | 16% | 4% |
| Tier-2 | 65% | 8% | 22% | 5% |
| Rural | 60% | 8% | 28% | 4% |
| **Coastal highway (Tripoli–Benghazi)** | 55% | 8% | 35% | 2% |

## Railway

### All projects suspended — no operational railway.

Gaddafi-era railway plans (China Railway Construction Corp contracts, 2008) included coastal Tripoli–Misrata–Sirte–Benghazi + south Misrata–Sabha–Niger routes. **All suspended after 2011** and never resumed. Libya remains one of Africa's largest countries by area with zero operational rail. Not modelled.

## Industrial

### GEM — 72 plants, operating, 14,417 MW

Libya has **Africa's largest proven oil reserves** (~48 billion barrels). The industrial fleet is dominated by gas turbines and combined-cycle plants fuelled by associated gas and LNG.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **West Libya Gas Project (Mellitah)** | 2,000+ | gas CCGT | ENI + NOC; Wafa gas field |
| **Khoms Power Station** | 1,000 | gas | East of Tripoli |
| **Zawiya Power Station** | 1,000 | gas/HFO | Western; adjacent to oil refinery |
| **Misrata Power Station** | 1,000 | gas | Western port city |
| **Benghazi North** | 900 | gas | Eastern grid |
| **Tripoli West** | 800 | gas/HFO | Capital supply |
| **Tobruk Power Station** | 400 | HFO/gas | Far eastern grid |
| **Sabha Power Station** | 200 | HFO | Southern Fezzan grid |

All operating plants map to **NACE 35**.

### Key infrastructure not NACE classified
- **National Oil Corporation (NOC)** — controls all upstream oil; Sarir, Sirte, Murzuq, Elephant fields
- **Zawiya Oil Refinery** (~120,000 bbl/day — largest in Libya)
- **Ras Lanuf Refinery + Petrochemical Complex** (eastern Libya; frequently contested/damaged)
- **Mellitah LNG + Greenstream Pipeline** (520 km undersea to Sicily; 8 Bcm/yr capacity)
- **Waha Oil Company** (ConocoPhillips + Marathon + Hess + NOC) — Sirte Basin
- **Akakus Oil Operations** (Repsol + OMV + NOC) — Murzuq Basin
- **Great Man-Made River (GMMR)** — 4,000 km buried pipe; Nubian Sandstone fossil water to coast; 6.5M m³/day
- **Mitiga International Airport** (MJI, Tripoli) + **Benina International** (BEN, Benghazi) — covered by global aircraft layer

### Libya does NOT have
- **No railway** — all Gaddafi-era CRCC contracts cancelled post-2011
- **No GTFS** — no public transit system
- **No AADT** — both governments publish no traffic data
