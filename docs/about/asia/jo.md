---
title: Jordan
intro: Noise mapping data sources for Jordan.
map: { center: [36.5, 31.5], zoom: 7 }
---

## Road traffic

### Class defaults only

MPWH publishes no open AADT. Fall back to class defaults with Amman Tier-1 boost. **Jordan has NO significant operating railway** — railway enrichment skipped.

### Jordanian AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (Desert Highway) | 35,000 | 70,000 | 49,000 |
| 1 trunk (ring roads, trunk) | 16,000 | 32,000 | 22,400 |
| 2 primary | 8,000 | 16,000 | 11,200 |
| 3 secondary | 4,000 | 8,000 | 5,600 |
| 4 tertiary | 1,800 | 3,600 | 2,520 |
| 5 residential | 800 | 1,600 | 1,120 |

**Tier-1 metro** (×2.0): **Amman** (~4M metro — Jordan's dominant city, **~40% of population**, hilly terrain with 7+ jabals/hills, heavy congestion).

**Tier-2 cities** (×1.4): **Zarqa** (~500k, Amman satellite, industrial + JPRC refinery), **Irbid** (~400k, north, university city), **Aqaba** (~200k, **Jordan's only Red Sea port + SEZ + tourism**), Salt, Madaba, Mafraq, Karak, Jerash, **Ma'an** (south, one of MENA's largest solar clusters).

### Jordanian vehicle split

High car ownership (Jordan has very high per-capita vehicle ownership for Middle East):

| Tier | Light | Medium | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Amman) | 72% | 6% | 16% | 6% |
| Tier-2 | 70% | 5% | 20% | 5% |
| Rural | 60% | 3% | 33% | 4% |
| **Desert Highway (Amman↔Aqaba)** | 55% | 3% | **40%** | 2% |

### National route network

- **Desert Highway (Route 15)** — Amman ↔ Ma'an ↔ Aqaba (~330 km, **Jordan's main intercity corridor**, 40% heavy freight)
- **King's Highway (Route 35)** — historic route Amman ↔ Karak ↔ Tafila (scenic, parallels Desert Highway)
- **Jordan Valley Highway (Route 65)** — Dead Sea ↔ Jordan Valley ↔ Irbid
- **Amman Ring Roads** — inner + outer rings (heavy congestion)
- **Route 10** — Amman ↔ Mafraq ↔ Iraq border (Karameh/Trebil crossing)

## Railway

### Jordan has NO significant operating railway

The **Hejaz Railway** (1903 — built by Ottoman Empire for Hajj pilgrimage Amman→Medina, famously attacked by T.E. Lawrence/Lawrence of Arabia in WWI) is **defunct for regular service** (tourist/heritage only). The **Aqaba Railway Corporation** operates limited phosphate freight (Al-Abyad mines → Aqaba port, ~293 km narrow gauge). The **Amman-Zarqa Light Rail** is under construction but not yet operating. Railway enrichment is **skipped**.

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 167 plants, 159 operating, ~6.75 GW

**Operating fuel**: solar **134** + oil/gas 16 + wind 9. **Jordan is one of MENA's biggest solar success stories** — 134 operating solar plants driven by world-class solar irradiance (~5.5 kWh/m²/day) + extreme energy import dependency (Jordan imports ~95% of energy).

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **IPP3 ICE** | 574 | oil/gas | |
| **Zarqa** | 485 | oil/gas | NEPCO, near JPRC refinery |
| **Samra** | ~1,241 (429+300+300+212) | oil/gas | **Jordan's largest thermal complex** (4 units, near Zarqa) |
| **Amman East** | 400 | oil/gas | |
| **Al Qatrana** | 373 | oil/gas CCGT | IPP4, Ma'an area |
| **Attarat** | 470 (2× 235) | oil/gas (oil shale) | **Jordan's first oil shale power plant**, world's 2nd-largest (units online 2022/2023; Estonian Enefit / Malaysian YTL / Chinese Guangdong Energy) |
| **Rehab** | 300 | oil/gas | |
| **Baynouna Solar** | 200 | solar | Masdar (UAE)-financed, one of Jordan's largest |
| **Tafila Wind** | 117 | wind | **Middle East's first utility-scale wind farm** (2015, Masdar / InfraRed / Jordan Wind; Morocco & Egypt had earlier North-African wind) |
| **134 solar plants total** | ~2,500+ | solar | One of MENA's highest solar penetration rates |
| **Aqaba thermal** | 260 (2× 130) | oil/gas | Red Sea |

All operating plants map to **NACE 35**.

### Jordan does NOT have

- **No MPWH AADT** — zero open traffic data
- **No railway GTFS** (no significant rail)
- **JPRC refinery** (Zarqa) not NACE 19 — Jordan's only refinery, 100k bpd
- **JPMC phosphate mines** (Al-Abyad/Al-Hasa/Eshidiya) not NACE 07/08 — **world's ~6th-largest phosphate-rock producer + 2nd-largest exporter** (~11 Mtpa)
- **Arab Potash Company** (Dead Sea) not NACE 08 — **world's 8th largest potash producer**
- **Dead Sea Industries** (bromine, magnesium) — Dead Sea is one of world's most mineral-rich bodies
- **Cement**: Lafarge Jordan (Fuheis), Qatrana Cement — not NACE 23
- **Aqaba port** — Jordan's only sea outlet (Red Sea, ASEZA free zone)
- **No domestic oil/gas** — Jordan imports ~95% of energy (previously from Iraq, now LNG + pipeline from Egypt/Israel)
- **Attarat oil shale** — Jordan has among the world's largest oil shale reserves (~4th-8th globally) but only 1 operating plant

## Validation

Jordan implements environmental protection via:

- **Ministry of Environment**
- **Environment Protection Law No. 6 of 2017**
- **Jordan Environmental Noise Guidelines** — based on WHO
- Typical limits: residential 55/45 dBA day/night, commercial 65/55, industrial 70/60

Notable noise zones:

- **Amman** — hilly capital, extreme congestion (7+ jabals)
- **Desert Highway** (Amman↔Aqaba, 40% heavy freight)
- **Amman Ring Roads** (inner + outer, heavy commuter traffic)
- **Queen Alia International (AMM/OJAI Amman)**, **Aqaba King Hussein (AQJ/OJAQ)** — covered by global aircraft layer
- **Samra thermal complex** (~1,241 MW, near Zarqa)
- **Attarat oil shale** (470 MW — Jordan's first, world's 2nd-largest)
- **JPRC Zarqa refinery** (100k bpd)
- **JPMC phosphate mines** (Al-Abyad/Al-Hasa)
- **Arab Potash Dead Sea** operations
- **Ma'an solar cluster** (MENA's largest concentrated solar zone)
- **Tafila Wind** (117 MW — Middle East's first utility-scale wind)
- **Aqaba port + ASEZA** (Red Sea, only sea outlet)
