---
title: Mexico
intro: Noise mapping data sources for Mexico.
map: { center: [-99.0, 23.5], zoom: 5 }
---

## Road traffic

### No scriptable open AADT/TDPA data

Mexico is one of the weakest countries in the pipeline for road data. Despite SCT (Secretaría de Comunicaciones y Transportes) and INEGI publishing traffic counts, neither offers a scriptable bulk download:

- **SCT/SICT Datos Viales** — ~40,000+ federal highway segments with TDPA (Tránsito Diario Promedio Anual = AADT), published via [appdatosviales.sctcloud.com.mx](http://appdatosviales.sctcloud.com.mx/) JavaScript map viewer. Per-segment exports as PDF/Excel only — no bulk URL.
- **INEGI Red Nacional de Caminos (RNC)** — 179,535 km national road network published by [INEGI](https://www.inegi.org.mx/programas/rnc/), but downloads gated behind interactive viewer + Windows-only DescargaMasivaApp.exe. RNC publishes geometry only, no TDPA.
- **Capufe** (federal toll road operator) — annual statistical reports as PDF only.
- **State DOTs** — fragmented, no harmonized open data.

Mexican roads currently use OSM `maxspeed` + class defaults. The Tijuana area receives ~6,000 segments from continental EU city traffic data (US cross-border).

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
- **Result**: 225 rail/tram stops captured, 1,544 segments enriched in 3 hexes
- **Calendar limitation**: Only 30 active rail trips on the target Wednesday — the CDMX GTFS calendar is sparse/stale, capping frequency at 2 trains/day per stop. **Real Mexico City Metro frequencies are ~225× higher** (Línea 1 carries ~1.6M trips/day across 19 stations). Recommendation: clamp `findTargetWednesday` to start_date + 7 days, or pick the busiest day from calendar_dates.

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

### Power plants — GPPD

WRI Global Power Plant Database covers ~700 Mexican plants via `/enrich-global`:

- **PEMEX refineries**: Cadereyta, Madero, Minatitlán, Salina Cruz, Tula, Salamanca
- **CFE thermal plants**: Tuxpan, Petacalco, Manzanillo
- **Nuclear**: Laguna Verde (Veracruz, 1.6 GW)
- **Hydroelectric**: Chicoasén (Manuel Moreno Torres, 2.4 GW), Malpaso, Aguamilpa
- **Wind**: La Venta II/III (Oaxaca), Bii Hioxo, Sureste

### NACE/CNAE codes — RETC gap

Mexico's federal pollutant register (RETC, SEMARNAT) is at [apps1.semarnat.gob.mx:8443/retc/](https://apps1.semarnat.gob.mx:8443/retc/retc/index.php) but only serves a JavaScript consultation form — no bulk CSV/Excel export. Historical data on `historico.datos.gob.mx` is stale.

## Validation

Mexico does not implement END (the EU Environmental Noise Directive). Federal noise regulation is fragmented:

- **NOM-081-SEMARNAT-1994** — federal noise emission standard for fixed sources
- **CDMX, Guadalajara, Monterrey** municipal noise bylaws
- **INECC** (Instituto Nacional de Ecología y Cambio Climático) publishes urban environmental quality reports
- No national noise mapping equivalent to END strategic noise maps
