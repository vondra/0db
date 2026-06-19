---
title: Italy
intro: Noise mapping data sources for Italy.
map: { center: [12.5, 42.5], zoom: 6 }
---

## Road traffic

### Anas TGM (national motorways & state roads)

[Anas](https://www.stradeanas.it/) (Azienda Nazionale Autonoma delle Strade) compiles the **Traffico Giornaliero Medio** (TGM) census; we ingest the Nov-2015 release published on the MIT open-data portal ([dati.mit.gov.it](https://dati.mit.gov.it/)), with 653 monitoring stations across the Italian motorway (A-*) and state highway (SS-*) network.

- **Matching**: ref-based (e.g. `A1 Milano–Napoli`) with proximity filter
- **Result**: 148,809 road segments enriched across 188 hexes
- **Gap**: regional and urban streets rely on OSM class defaults; Italian regions do not publish harmonized per-segment AADT

### EU harmonized traffic (from `/enrich-continent europe`)

The harmonized EU city traffic dataset (Nature Sci. Data, 2025) provides AADT + HGV share for Milan, the one Italian city in the dataset.

## Railway

Italy has **no unified national rail GTFS**. The map stitches together five regional feeds:

| Operator | Coverage | Feed source |
|---|---|---|
| **Trenitalia (Toscana aggregator)** | Central Italy: Toscana, Marche, Umbria, Lazio N | [dati.toscana.it](https://dati.toscana.it/dataset/8bb8f8fe-fe7d-41d0-90dc-49f2456180d1) (mdb-1319) |
| **Trenord** | Lombardia (Milano, Lago di Como, Garda) | [dati.lombardia.it](https://www.dati.lombardia.it/) (mdb-855) |
| **GTT Servizio Ferroviario** | Piemonte (3 SFM lines) | [gtt.to.it open data](https://www.gtt.to.it/open_data/) (mdb-2687) |
| **Ferrotramviaria** | Puglia (Bari–Barletta) | Mobility Database (mdb-1058) |
| **Trenitalia Sardegna** | Sardinia | [sardegnamobilita.it](https://www.sardegnamobilita.it/) (mdb-2997) |

- **Merged**: 797 unique stops, 121,581 enriched railway segments
- **Busiest stop**: Milano Bovisa Politecnico (870 trains/day from Trenord)
- **Top intercity**: Firenze SMN 376/day, Saronno 570/day, Milano Cadorna 495/day

### Rail GTFS gaps

No open rail GTFS is published for these regions — they fall back to OSM class defaults with no train-frequency data:

- **Lazio (Roma)** — ATAC publishes metro/bus GTFS only
- **Campania (Napoli)** — EAV / Circumvesuviana no open feed
- **Sicilia (Palermo, Catania)** — no open rail feed in Mobility Database
- **Veneto (Venezia)** — regional SFMR no open feed
- **Piemonte (Torino national trains)** — GTT covers only 3 local lines; Trenitalia Torino feed is deprecated

## Industrial

- **E-PRTR** (European Pollutant Release and Transfer Register) — NACE 2-digit sector codes for Italian industrial facilities via `/enrich-continent europe`
- **Wind turbines**: OSM `power=generator` with default specs (no per-turbine open registry — GSE/Terna data is aggregated)

## Buildings

GHSL Built-H R2023A 100 m global raster. Italian cadastral LoD1 (AGEA/Agenzia delle Entrate) is not open data.

## Notes

Italy's rail noise hotspots concentrate in Lombardy (Milano hub has ~18% of national rail traffic). The Firenze–Roma high-speed Direttissima, Milano–Bologna, and Torino–Milano are the primary freight + passenger corridors — these remain partially enriched via the Toscana aggregator which covers northbound intercity routes through Tuscany.

## Validation

Italy implements END via Legislative Decree 194/2005. Strategic noise maps are produced by ARPA regional agencies; national aggregate data is published by ISPRA. Per-agglomeration maps (Milano, Roma, Napoli, Torino, Palermo) are available but not harmonized as a single dataset.
