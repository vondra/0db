---
title: Iran
intro: Noise mapping data sources for Iran.
map: { center: [53, 33], zoom: 5 }
---

## Road traffic

### Class defaults only

RAH (Road and Housing Ministry) publishes no open AADT. Fall back to CNOSSOS class defaults with Tehran ×2.5 megacity boost. Iran has ~2,400 km of freeways (آزادراه).

### Iranian AADT defaults

| OSM class | Rural | Tier-1 (×2.5) | Tier-2 (×1.8) | Tier-3 (×1.4) |
|---|---:|---:|---:|---:|
| 0 motorway (Freeway/آزادراه) | 50,000 | 125,000 | 90,000 | 70,000 |
| 1 trunk | 20,000 | 50,000 | 36,000 | 28,000 |
| 2 primary | 11,000 | 27,500 | 19,800 | 15,400 |
| 3 secondary | 5,500 | 13,750 | 9,900 | 7,700 |
| 4 tertiary | 2,500 | 6,250 | 4,500 | 3,500 |
| 5 residential | 900 | 2,250 | 1,620 | 1,260 |

**Tier-1 megacity** (×2.5): **Tehran** (~16M — one of world's largest cities, extreme congestion on Tehran-Karaj Freeway, Hemmat, Chamran expressways).

**Tier-2 cities** (×1.8): **Isfahan** (~2M, cultural capital), **Mashhad** (~3.4M, **world's 2nd holiest Shia city** after Karbala — 20M+ pilgrims/year to Imam Reza Shrine), **Tabriz** (~1.7M, NW Azerbaijan), **Shiraz** (~1.9M), **Karaj** (~2M, Tehran satellite, Alborz Province).

**Tier-3 cities** (×1.4, 20 cities): Ahvaz (Khuzestan oil), Kerman, **Qom** (holy city), Urmia, Kermanshah, Zahedan (Sistan), Rasht (Gilan, Caspian), Hamadan, Arak, Yazd, Ardabil, **Bandar Abbas** (Hormozgan strait port), Sanandaj, Zanjan, Gorgan, Birjand, **Bushehr** (nuclear), Khorramabad, Sari, Bojnurd.

### Iranian vehicle split

Iran has **very high car ownership** — IKCO+SAIPA duopoly produces ~1M cars/year domestically (90% Peugeot-derived: 206/207/Samand/Dena due to Western sanctions blocking imports):

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Tehran) | 65% | 10% | 15% | 10% |
| Tier-2 | 65% | 8% | 19% | 8% |
| Rural | 55% | 5% | 33% | 7% |
| **Freeway** (آزادراه) | 74% | 3% | **21%** | 2% |
| **South Pars freight corridor** | 40% | 4% | **52%** | 4% |

### National route network

- **Tehran ↔ Isfahan ↔ Shiraz Freeway** — Iran's main N-S spine
- **Tehran ↔ Qom ↔ Isfahan** — most heavily used intercity
- **Tehran-Karaj Freeway** — one of world's most congested short motorways
- **Tehran ↔ Mashhad** — longest domestic route (~900 km), millions of pilgrims
- **Tehran ↔ Tabriz** — NW connection
- **Bandar Abbas ↔ Kerman ↔ Isfahan** — port-to-interior freight

## Railway

### Class defaults + corridor bbox boosts

### Iranian rail context

**RAI (Islamic Republic of Iran Railways)** operates ~13,000 km of standard gauge (1,435 mm). **5 urban metro systems** + extensive intercity network radiating from Tehran.

### Tehran Metro
- **7 lines, ~200 km, ~3M daily riders** — **one of world's busiest metro systems**
- Lines 1-5 operational, Line 6-7 extensions ongoing

### Other urban metros
- **Isfahan Metro** — 1 line, 20 km
- **Mashhad Metro** — 2 lines (serving pilgrims to Imam Reza Shrine)
- **Tabriz Metro** — 1 line
- **Shiraz Metro** — 1 line (opened 2014)

### RAI intercity network
- **Tehran ↔ Mashhad** — busiest intercity corridor (~12 trains/day, ~900 km)
- **Tehran ↔ Isfahan ↔ Shiraz** — central trunk
- **Tehran ↔ Tabriz** — NW connection (Azerbaijan link)
- **Tehran ↔ Bandar Abbas** — SE port link (~1,500 km, container freight)

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Tehran Metro (7 lines)** | 350 | 0 |
| **Other metros** (Isfahan/Mashhad/Tabriz/Shiraz) | 80 | 0 |
| **Tehran↔Mashhad** | 15 | 8 |
| **Tehran↔Isfahan↔Shiraz** | 8 | 10 |
| **Tehran↔Tabriz** | 5 | 8 |
| **Tehran↔Bandar Abbas** | 3 | 10 |
| Other/branch | 3 | 5 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 547 plants, 408 operating, ~89.3 GW

**Operating fuel**: oil/gas **281** + solar 90 + hydropower 24 + wind 11 + nuclear 1 + geothermal 1. **Overwhelmingly gas-dependent** — Iran has **world's 2nd largest gas reserves** after Russia.

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Karun-III** | 2,000 | hydropower | **Karun River** (Khuzestan) |
| **Shahid Abbaspuor (K-1)** | 2,000 | hydropower | Karun cascade |
| **Masjed Soleyman (K-2)** | 2,000 | hydropower | Karun cascade |
| **Karun-IV** | 1,000 | hydropower | |
| **Upper Gotvand** | 1,000 | hydropower | |
| **Siahbishe** | 1,000 | hydropower (pump) | Alborz mountains pumped storage |
| **Dez** | 520 | hydropower | Karun sub-basin — total **Karun cascade ~8,520 MW** |
| **Bushehr Nuclear** | **1,000** | nuclear | **Russian VVER-1000** — Iran's only nuclear plant (controversial under JCPOA) |
| **Mobarakeh Steel** | 914 | oil/gas (captive) | Captive for **Middle East's largest steel mill** (Isfahan) |
| **281 gas/oil plants** | ~70+ GW total | oil/gas | Massive CCGT fleet across all provinces |
| **90 solar plants** | ~3+ GW | solar | Yazd/Kerman desert belt + distributed |
| **11 wind farms** | ~500+ MW | wind | Manjil/Rudbar (Gilan — one of Iran's first wind farms) |

All operating plants map to **NACE 35**.

### Iran does NOT have

- **No RAH AADT** — zero open traffic data (sanctions + data isolation)
- **No RAI GTFS** — timetables are PDF/HTML only
- **South Pars gas** (shared with Qatar — **world's largest gas field**) not NACE 06/19
- **9+ refineries**: Isfahan (280k bpd), Abadan (400k bpd — Middle East's oldest, 1912), Bandar Abbas (300k bpd), Tehran, Tabriz, Arak, Shiraz, Lavan, Kermanshah — not NACE 19
- **Mobarakeh Steel** (Isfahan) not NACE 24 — **Middle East's largest steelmaker**, ~10 Mtpa
- **Khuzestan steel** (Ahvaz) + **South Pars petrochemical** (Asaluyeh/Bushehr, Mahshahr — one of world's largest petrochemical concentrations) not NACE 20/24
- **NIOC/NIGC** (National Iranian Oil/Gas Companies) — state hydrocarbons
- **IKCO + SAIPA** — domestic auto production ~1M cars/year (90% Peugeot-derived, sanctions)
- **Cement**: ~80 plants (Iran is one of world's top-10 producers)
- **Copper**: Sarcheshmeh (Kerman — world's 2nd largest copper mine by reserves)
- **Bandar Abbas + Imam Khomeini Port** — major commercial ports

## Validation

Iran implements environmental protection via:

- **DoE** (Department of Environment — reports to President)
- **Environmental Protection Organization** (1971, one of oldest in Middle East)
- Iranian noise standards follow WHO guidelines approximately
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60
- **Tehran is consistently ranked among world's most polluted capitals** (air quality; noise data sparse)
