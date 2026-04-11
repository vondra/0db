---
title: France
intro: Noise mapping data sources for France.
map: { center: [2.5, 46.6], zoom: 6 }
---

## Road traffic

### Cerema TMJA (Trafic Moyen Journalier Annuel)

National road traffic census from [Cerema](https://www.cerema.fr/) via data.gouv.fr.

- **Coverage**: ~5,500 counting sections on autoroutes (A) and routes nationales (N)
- **Data**: TMJA (AADT) + ratio_PL (heavy vehicle share %)
- **Coordinates**: Lambert-93 (EPSG:2154)
- **Year**: 2024 (concession motorways) + 2019 (full national network)
- **Result**: 494,005 road segments enriched
- **License**: Licence Ouverte (Etalab)
- **Gap**: No data for routes départementales (D) or communales

### EU city traffic (from /enrich-global)

Paris AADT from the harmonized EU city traffic dataset (Nature Sci. Data, 2025). 323,350 segments preserved.

## Railway

### SNCF GTFS (TGV + Intercités + TER + Transilien)

All SNCF rail services from [SNCF Open Data](https://data.sncf.com/).

- **SNCF combined**: 2,766 stops, 622 rail routes (TGV + Intercités + TER), 10,129 daily trains
- **Transilien**: 471 stops, 24 routes (Paris commuter rail), 5,200 daily trains
- **Busiest**: La Défense 1,440 trains/day, Strasbourg 652, Lille 564, Gare du Nord 1,279
- **Result**: 378K+ railway segments enriched
- **Gap**: Paris metro (RATP) not included — NeTEx format only, no GTFS

## Industrial

- GPPD power plants (~200 facilities, NACE 35)
- Georisques/IREP (French PRTR) — not yet processed

## Buildings

- Overture Maps: Paris 17.3% building height coverage
- IGN BD TOPO: Has building heights — requires Geoplateforme registration

## Validation

France implements END via the "Plan de Prévention du Bruit dans l'Environnement" (PPBE). Strategic noise maps produced by préfectures every 5 years. Calculation method: NMPB-2008 (French predecessor of CNOSSOS-EU, now superseded by CNOSSOS for 4th round mapping).
