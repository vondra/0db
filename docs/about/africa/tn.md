---
title: Tunisia
intro: Noise mapping data sources for Tunisia.
map: { center: [9.5, 34], zoom: 6 }
---

## Road traffic

### Road defaults

Tunisia publishes no open per-segment AADT, so roads fall back to the global class defaults scaled by Tunisia's traffic factor **≈ 1.260** (vehicles-per-km). Only the major classes (motorway, trunk, primary, and their on/off-ramps) are scaled; local roads and the vehicle mix use the global default — the engine applies no per-city tiers or country-specific splits.

| OSM class | Default AADT |
|---|---:|
| Motorway | 30,000 × 1.260 ≈ 37,800 |
| Trunk | 15,000 × 1.260 ≈ 18,900 |
| Primary | 9,000 × 1.260 ≈ 11,340 |
| Secondary / tertiary / residential | 3,000 / 800 / 500 (world default) |
| Service / track / unclassified | 250 / 5 / 1,340 (world default) |

### National route network

- **A1** — Tunis ↔ Hammamet ↔ Sousse ↔ Sfax ↔ Gabès (coastal south, **flagship motorway ~560 km**)
- **A3** — Tunis ↔ Oued Zarga ↔ Béja ↔ Jendouba ↔ Algeria border (interior west, partial)
- **A4** — Tunis ↔ Bizerte (northern coastal)
- **A19** — Mhamdia ↔ Djebel Oust (short link)
- **RN1** — Tunis ↔ Kairouan ↔ Gafsa ↔ Ras Jedir (Libya border)
- **RN3** — Tunis ↔ Sfax ↔ Gabès (old national, parallel to A1)
- **RN15** — Sfax ↔ Gafsa (phosphate route)

## Railway

### Tunisian rail context

Tunisia has **one of North Africa's most developed rail networks** (~2,165 km SNCFT) plus Tunis urban transit:

### Urban transit (Tunis metropolitan area)

- **Métro léger de Tunis** — **opened October 1985**, Siemens-built. **Africa's first modern light rail/tram system** (predates the Cairo Metro, opened 1987). **6 lines, ~46 km, 63 stations**, standard gauge, electrified 750 V DC, 45 km/h, ~400k daily riders pre-COVID. Operated by **TRANSTU** (Société des Transports de Tunis).
- **TGM (Tunis-Goulette-Marsa)** — **opened 1872** (steam), **electrified 1905**. **One of the oldest operating electric railways in Africa**. 18.5 km, Tunis Marine ↔ La Goulette ↔ Carthage ↔ Sidi Bou Saïd ↔ La Marsa. TRANSTU operated.
- **RFR Tunis (Réseau Ferroviaire Rapide)** — modern commuter rail, 5 lines planned, long-delayed. **Line E opened March 2023** (Place Barcelone ↔ Bougatfa); **Line D opened January 2025** (Bardo section). Electrified 25 kV AC.

### SNCFT intercity network

- **Sahel main line** — Tunis ↔ Hammamet ↔ Sousse ↔ Sfax ↔ Gabès (standard gauge, partially electrified). Main passenger + freight artery.
- **Tunis ↔ Bizerte** — Northern branch (standard gauge, electrified).
- **Tunis ↔ Ghardimaou** — international line to Algeria, limited freight.
- **Tunis ↔ Nabeul** — Cap Bon branch.

### Southern meter-gauge (phosphate freight)

- **Sfax ↔ Gafsa ↔ Metlaoui ↔ Redeyef ↔ Tozeur** — **meter gauge**, Gafsa phosphate corridor. SNCFT's **#1 freight commodity**. The famous **"Red Lizard" (Lézard Rouge) tourist train** runs on this line.

### Rail defaults

No measured/GTFS frequencies, so rail uses the engine's per-type class defaults
(identical worldwide): main line 80 pax + 20 freight/day, branch 30/5, industrial
siding 0/15, unknown 40/10, tram 120/0, light rail 80/0, narrow gauge 10/0,
funicular 40/0. Country-specific counts need GTFS or measured data.

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

**Rades (≈1,630 MW) + Sousse (≈1,525 MW) + Mornaguia (624 MW) + Ghannouch (400 MW) + Bir Mcherga (256) + Bouchemma (250) + Thyna (246) = ~4,930 MW STEG thermal cluster** — concentrated along the Tunis↔Sousse↔Gabès coast.

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
