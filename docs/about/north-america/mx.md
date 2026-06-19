---
title: Mexico
intro: Noise mapping data sources for Mexico.
map: { center: [-99.0, 23.5], zoom: 5 }
---

## Road traffic

### SICT/IMT Datos Viales 2025 (TDPA)

The official **Datos Viales** of SICT (Secretaría de Infraestructura, Comunicaciones y Transportes) / IMT (Instituto Mexicano del Transporte) publishes per-segment TDPA (Tránsito Diario Promedio Anual = AADT) for the federal + state highway network, but only behind a Mongo-backed JS map app (`datosviales2020.routedev.mx`) with no bulk export. The pipeline consumes the CC-BY-4.0 community scrape that snapshotted it:

- **Source**: [github.com/iChocko/Datos-Viales-SICT](https://github.com/iChocko/Datos-Viales-SICT) — universe **U1** (Red Nacional de Carreteras Pavimentadas)
- **Records**: **4,790 segments** with real per-segment annual TDPA **plus native vehicle composition** (IMT classes A / B / C2 / C3 / T3S2… / M → CNOSSOS light/medium/heavy/moto). This is measured count data, not a class default — the strongest road input available for Mexico.
- **TDPA-weighted national split**: ~79.5 / 7.1 / 8.2 / 5.2 (light / medium / heavy / moto)
- **Matching**: OSM high-order roads (motorway/trunk/primary/secondary) take the nearest *type-compatible* SICT polyline within 200 m, gated by road type (Federal Cuota → motorway/trunk; Federal Libre → trunk/primary; Estatal → primary/secondary), and clipped to the Mexico polygon so a toll-road count cannot land on a US/Guatemala/Belize border road.
- **License**: CC-BY 4.0

The SICT U1 layer is federal + state highways only. **Local roads** (tertiary/residential/service) are not in the network and fall back to Mexico class defaults (seeded from this dataset's medians). The Tijuana area also receives some segments from continental EU city traffic data (US cross-border).

Other published counts remain non-scriptable: **INEGI Red Nacional de Caminos** (179,535 km network, geometry only — no TDPA, gated behind a Windows-only downloader) and **Capufe** toll statistics (PDF only).

## Railway

### CDMX SEMOVI unified GTFS

The [Secretaría de Movilidad CDMX (SEMOVI)](https://datos.cdmx.gob.mx/dataset/gtfs) publishes a unified GTFS containing all Mexico City public transport (Metro, Metrobús, Trolebús, Tren Ligero, Cablebús, Tren Suburbano, Pumabús, RTP).

- **Source**: [Mobility Database mdb-1830](https://storage.googleapis.com/storage/v1/b/mdb-latest/o/mx-unknown-pumabus-gtfs-1830.zip?alt=media) (origin `datos.cdmx.gob.mx` is firewalled from many networks)
- **Operators**:
  - **Sistema de Transporte Colectivo Metro** — 12 subway lines (largest metro system in Latin America, ~5M daily passengers)
  - **Metrobús** — 7 BRT lines
  - **Tren Ligero Tasqueña–Xochimilco** — light rail
  - **Cablebús** — Line 1 (Cuautepec) + Line 2 (Constitución de 1917)
  - **Ferrocarriles Suburbanos** — Cuautitlán↔Buenavista commuter rail
  - **Trolebús** — electric buses
- **Frequency-based expansion**: CDMX publishes Metro / Tren Ligero as headway-based service (a single template trip in `stop_times.txt` repeated every `headway_secs`). The enricher reads `frequencies.txt` and expands each trip to its real daily departure count, so Línea 1 reflects its true ~285–570 trains/day rather than the ~2 a raw stop-time count would imply.

### Other operators

- **Toluca**: bus-only feed via [datos.movimex.gob.mx](https://datos.movimex.gob.mx/gtfs/toluca.gtfs.zip), no rail content
- **Guadalajara Tren Ligero**: no open GTFS feed found
- **Monterrey Metrorrey**: no open GTFS feed found
- **Tren Maya** (Yucatán peninsula, opened 2023): no GTFS feed yet

## Buildings

GHSL Built-H R2023A 100 m global raster + Overture/Microsoft Building Footprints (already in `/enrich-global`). INEGI population census includes building counts but no heights.

## Industrial

### Wind turbines — OSM only

Mexico has ~7 GW installed wind capacity, mostly in the Tehuantepec corridor (Oaxaca), Tamaulipas, and Yucatán. No federal CRE/CFE/AMDEE per-turbine open dataset exists. OSM has 3,465 `power=generator + generator:source=wind` features (matches AMDEE's ~3,247 turbines claim) — locations only, no specs. All turbines use default 2 MW / 80 m hub.

### Power plants — GEM

CFE (Comisión Federal de Electricidad) and CENACE publish operational data in proprietary formats without machine-readable coordinates, so the pipeline uses **GEM Global Integrated Power** (Global Energy Monitor) — **448 operating plants** in Mexico — for power-plant NACE classification, superseding the global GPPD baseline:

- **Nuclear**: Laguna Verde (Veracruz, 2×800 MW — Mexico's only nuclear plant)
- **Hydroelectric**: Chicoasén (Manuel Moreno Torres, 2,400 MW — largest hydro), El Cajón 750 MW, La Yesca 750 MW
- **Gas CCGT**: Manzanillo 2,100 MW (largest), Altamira 1,036 MW
- **Solar**: Villanueva 754 MW (Coahuila — one of the largest in Latin America)
- **Wind**: Eólica del Sur 396 MW (Oaxaca Isthmus — largest wind farm), La Venta complex

PEMEX refineries (Salina Cruz, Tula, Salamanca, Minatitlán) and the Dos Bocas refinery appear as OSM industrial sites only.

### NACE/CNAE codes — RETC gap

Mexico's federal pollutant register (RETC, SEMARNAT) is at [apps1.semarnat.gob.mx:8443/retc/](https://apps1.semarnat.gob.mx:8443/retc/retc/index.php) but only serves a JavaScript consultation form — no bulk CSV/Excel export. Historical data on `historico.datos.gob.mx` is stale.

## Validation

Mexico does not implement END (the EU Environmental Noise Directive). Federal noise regulation is fragmented:

- **NOM-081-SEMARNAT-1994** — federal noise emission standard for fixed sources
- **CDMX, Guadalajara, Monterrey** municipal noise bylaws
- **INECC** (Instituto Nacional de Ecología y Cambio Climático) publishes urban environmental quality reports
- No national noise mapping equivalent to END strategic noise maps
