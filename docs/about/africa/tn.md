---
title: Tunisia
intro: Noise mapping data sources for Tunisia.
map: { center: [9.5, 34], zoom: 6 }
---

## Road traffic

### Class defaults only

DGPC (Direction Générale des Ponts et Chaussées) and Tunisie Autoroutes SA (A1/A3/A4/A19 operator) publish no open AADT. Fall back to CNOSSOS class defaults with Grand Tunis Tier-1 boost. Tunisian baseline higher than sub-Saharan (Mediterranean traffic patterns).

### Tunisian AADT defaults

| OSM class | Rural | Tier-1 (×2.0) | Tier-2 (×1.4) |
|---|---:|---:|---:|
| 0 motorway (A1/A3/A4/A19) | 35,000 | 70,000 | 49,000 |
| 1 trunk (RN routes) | 13,000 | 26,000 | 18,200 |
| 2 primary | 7,000 | 14,000 | 9,800 |
| 3 secondary | 3,500 | 7,000 | 4,900 |
| 4 tertiary | 1,500 | 3,000 | 2,100 |
| 5 residential | 700 | 1,400 | 980 |

**Tier-1 metros** (×2.0, 1 metro): **Grand Tunis** (~2.3M metro — Tunis + Ariana + Ben Arous + La Manouba governorates).

**Tier-2 cities** (×1.4, 24 cities): **Sfax** (2nd city, phosphate port), **Sousse** (tourism + manufacturing), Kairouan (religious + historic), **Bizerte** (northern port + STIR refinery), **Gabès** (chemical industry), **Gafsa** (phosphate mining), Monastir, Nabeul, Medenine, Tataouine (extreme south), **Tozeur** (oasis, Sahara tourism), Kasserine, Béja, El Kef, Jendouba, Mahdia, Zaghouan, Siliana, **Sidi Bouzid** (Arab Spring origin), Ariana, Ben Arous, La Marsa, **Hammamet** (coastal resort), **Djerba** (island tourism hub).

### Tunisian vehicle split

Tunisia's transport is **more European-Mediterranean than sub-Saharan African**:

- **Louage** — yellow shared taxis (8-seat intercity minibuses, Tunisia-specific — more structured than West African matatus)
- **Taxis individuels** — red-and-white metered city taxis
- **TRANSTU buses** — Tunis city buses (same agency as Métro léger and TGM)
- **SRTG** regional bus societies (Société Régionale de Transport de Gouvernorat) run intercity buses
- **Motorcycles** — low share (4-10%), Mediterranean/European pattern — much lower than sub-Saharan Africa
- **Vespa/scooters** popular in Tunis + Sousse + Sfax

| Tier | Light | Medium (louage/bus) | Heavy | Motorcycle |
|---|---:|---:|---:|---:|
| Tier-1 (Grand Tunis) | 65% | 12% | 13% | 10% |
| Tier-2 | 67% | 10% | 15% | 8% |
| Rural | 60% | 8% | 26% | 6% |
| **A1 Coastal Motorway (Tunis↔Sousse↔Sfax↔Gabès)** | 72% | 6% | **18%** | 4% |
| **Gafsa phosphate corridor (RN3/RN15)** | 40% | 6% | **48%** | 6% |

### National route network

- **A1** — Tunis ↔ Hammamet ↔ Sousse ↔ Sfax ↔ Gabès (coastal south, **flagship motorway ~560 km**)
- **A3** — Tunis ↔ Oued Zarga ↔ Béja ↔ Jendouba ↔ Algeria border (interior west, partial)
- **A4** — Tunis ↔ Bizerte (northern coastal)
- **A19** — Mhamdia ↔ Djebel Oust (short link)
- **RN1** — Tunis ↔ Kairouan ↔ Gafsa ↔ Ras Jedir (Libya border)
- **RN3** — Tunis ↔ Sfax ↔ Gabès (old national, parallel to A1)
- **RN15** — Sfax ↔ Gafsa (phosphate route)

## Railway

### Class defaults + corridor bbox boosts

### Tunisian rail context

Tunisia has **one of North Africa's most developed rail networks** (~2,165 km SNCFT) plus Tunis urban transit:

### Urban transit (Tunis metropolitan area)

- **Métro léger de Tunis** — **opened 1985**, Siemens-built. **Africa's first modern light rail/tram system** after Cairo Metro (1987 — but Tunis predates Cairo Metro opening). **6 lines, ~46 km, 63 stations**, standard gauge, electrified 750 V DC, 45 km/h, ~400k daily riders pre-COVID. Operated by **TRANSTU** (Société des Transports de Tunis).
- **TGM (Tunis-Goulette-Marsa)** — **opened 1872** (steam), **electrified 1905**. **One of the oldest operating electric railways in Africa**. 18.5 km, Tunis Marine ↔ La Goulette ↔ Carthage ↔ Sidi Bou Saïd ↔ La Marsa. TRANSTU operated.
- **RFR Tunis (Réseau Ferroviaire Rapide)** — modern commuter rail under construction, 5 lines planned. Phase 1 (Tunis ↔ Bougatfa via Borj Cedria) partially **opened 2024**. Electrified 25 kV AC.

### SNCFT intercity network

- **Sahel main line** — Tunis ↔ Hammamet ↔ Sousse ↔ Sfax ↔ Gabès (standard gauge, partially electrified). Main passenger + freight artery.
- **Tunis ↔ Bizerte** — Northern branch (standard gauge, electrified).
- **Tunis ↔ Ghardimaou** — international line to Algeria, limited freight.
- **Tunis ↔ Nabeul** — Cap Bon branch.

### Southern meter-gauge (phosphate freight)

- **Sfax ↔ Gafsa ↔ Metlaoui ↔ Redeyef ↔ Tozeur** — **meter gauge**, Gafsa phosphate corridor. SNCFT's **#1 freight commodity**. The famous **"Red Lizard" (Lézard Rouge) tourist train** runs on this line.

### trains/day defaults

| Context | pax/day | frt/day |
|---|---:|---:|
| **Métro léger de Tunis (1985)** | 200 | 0 |
| **TGM Tunis-Marsa (1872/1905)** | 80 | 0 |
| **RFR Tunis (2024)** | 50 | 0 |
| **SNCFT Sahel main line (Tunis-Sfax-Gabès)** | 15 | 10 |
| **SNCFT Tunis-Bizerte** | 6 | 4 |
| **SNCFT Gafsa phosphate corridor** | 1 | 15 |
| Other/branch | 1 | 2 |

## Buildings

GHSL Built-H R2023A 100m + Overture Maps Foundation global footprints.

## Industrial

### GEM Global Integrated Power — 80 plants, 39 operating

- **Source**: `services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Integrated_Power_v1/FeatureServer/0?where=Country_area='Tunisia'`

**Operating fuel**: oil/gas 27 + wind 6 + solar 6. **Tunisia's generation is ~94% natural gas** (STEG-owned), largely from domestic production supplemented by Algerian imports via Transmed pipeline (plus 15% royalty on Algeria↔Italy gas transit).

### Top operating plants

| Plant | MW | Type | Notes |
|---|---:|---|---|
| **Rades II** | **480** | oil/gas CCGT | Tunis port — Tunisia's largest single unit |
| **Rades C** | 450 | oil/gas | |
| **Sousse C** | 424 | oil/gas | Phase 3 |
| **Sousse D** | 424 | oil/gas | Phase 4 |
| **Ghannouch** | 400 | oil/gas CCGT | Gabès industrial zone |
| **Sousse B** | 357 | oil/gas | Phase 2 |
| **Mornaguia** | 624 (2× 312) | oil/gas CCGT | Near Tunis, dual-unit |
| **Rades A+B** | 700 (A 340 + B 360) | oil/gas | Older units at Rades complex |
| Sousse A | 320 (2× 160) | oil/gas | Phase 1 |
| Bir Mcherga | 256 (2× 128) | oil/gas | Zaghouan, open-cycle peakers |
| Bouchemma | 250 (2× 125) | oil/gas | Gabès region |
| Thyna | 246 (2× 123) | oil/gas | Sfax industrial zone |
| **Sidi Daoud Wind** | — | wind | Cap Bon — **Tunisia's first wind farm** |
| **Bizerte/Metline Wind** | — | wind | |
| **Borj Bourguiba + Tozeur Solar** | — | solar | First utility solar |

**Rades (≈1,630 MW) + Sousse (≈1,525 MW) + Mornaguia (624 MW) + Ghannouch (400 MW) + Bir Mcherga (256) + Bouchemma (250) + Thyna (246) = ~4,100 MW STEG thermal cluster** — concentrated along the Tunis↔Sousse↔Gabès coast.

All operating plants map to **NACE 35**.

### Tunisia does NOT have

- **No DGPC AADT** — zero open traffic data
- **No SNCFT or TRANSTU GTFS** — all timetables corporate HTML only
- **STIR refinery not NACE 19**: Société Tunisienne des Industries de Raffinage — Bizerte, **~34,000 bpd**, Tunisia's only oil refinery (modernization project ongoing)
- **Gafsa phosphate mining not NACE 07/08**: **CPG** (Compagnie des Phosphates de Gafsa) — **world's #5 phosphate producer** at Metlaoui/Redeyef/Mdhilla/Oum Larayes, ~8 Mtpa rock phosphate
- **GCT Gabès chemical complex not NACE 20**: Groupe Chimique Tunisien — phosphoric acid + DAP fertilizer. **One of Africa's largest chemical sites**. Major environmental contamination concerns ("Gabès pollution" is a nationally known issue with significant community protests)
- **Cement plants not NACE 23**: Ciments de Bizerte, Carthage Cement (Djebel Ressas), CIOK Tajerouine, Ciments d'Oum El Kélil, Les Ciments de Gabès
- **El Fouladh steel** (Menzel Bourguiba) not NACE 24
- **Offshore oil/gas fields**: Ashtart, **Miskar** (BG/Shell — Tunisia's main gas field), El Bibane, Didon, Cercina
- **Tataouine onshore fields**: Adam, Oued Zar, El Borma (desert)

## Validation

Tunisia implements noise regulation via:

- **ANPE** (Agence Nationale de Protection de l'Environnement) — pollution monitoring and EIA authority
- **Code de l'Environnement** — environmental framework law
- **Loi n° 2005-60** — noise pollution
- Typical limits: Residential 55/45 dBA day/night, commercial 65/55, industrial 70/60
- **ANME** (Agence Nationale de Maîtrise de l'Énergie) — energy efficiency authority

Notable noise zones:

- **A1 Coastal Motorway** — Tunis ↔ Sousse ↔ Sfax ↔ Gabès (flagship ~560 km)
- **A4 Tunis ↔ Bizerte** — northern motorway
- **RN3 + RN15 Gafsa phosphate corridor** — heavy-truck dominated
- **Avenue Habib Bourguiba** + **Tunis Medina** + **Le Bardo** — dense urban core
- **Métro léger de Tunis** — 6 lines, 46 km, Siemens light rail
- **TGM Tunis-Goulette-Marsa** — 18.5 km historic electric railway (1872/1905)
- **SNCFT Sahel line** — Tunis ↔ Sousse ↔ Sfax ↔ Gabès parallel to A1
- **SNCFT Gafsa phosphate corridor** — meter gauge freight artery
- **Tunis-Carthage International (TUN/DTTA)**, **Djerba-Zarzis (DJE/DTTJ)**, **Monastir Habib Bourguiba (MIR/DTMB)**, **Enfidha-Hammamet (NBE/DTNH)**, **Sfax-Thyna (SFA/DTTX)**, **Tozeur-Nefta (TOE/DTTZ)** — covered by global aircraft layer
- **Rades power + port industrial cluster** (≈1,630 MW, Tunis port)
- **Sousse thermal cluster** (A+B+C+D ≈ 1,525 MW)
- **Ghannouch + Bouchemma + Thyna thermal** (Gabès/Sfax region, ≈896 MW)
- **Mornaguia 624 MW CCGT** (near Tunis)
- **STIR refinery Bizerte** (34k bpd)
- **CPG phosphate mines Gafsa** (world's #5 producer)
- **GCT Gabès chemical complex** (Africa's largest phosphoric acid site)
- **Ports of Rades, Bizerte, Sfax, Gabès** — industrial shipping
- **Tunis Carthage airport** approach corridors
- **Sidi Daoud + Bizerte wind farms** (Cap Bon, Metline)
