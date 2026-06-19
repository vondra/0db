---
title: Finland
intro: Noise mapping data sources for Finland.
map: { center: [25.5, 64.0], zoom: 5 }
---

## Road traffic

### Väylävirasto Liikennemäärät 2024

[Väylävirasto](https://vayla.fi/) (Finnish Transport Infrastructure Agency) publishes per-segment KVL (keskimääräinen vuorokausiliikenne = AADT) data via GeoServer WFS, with vehicle class breakdown going back to 2012.

- **Source**: [avoinapi.vaylapilvi.fi/vaylatiedot/wfs](https://avoinapi.vaylapilvi.fi/vaylatiedot/wfs) (`tiestotiedot:liikennemaarat_2024`)
- **Catalog**: [avoindata.suomi.fi/data/fi/dataset/liikennemaarat](https://avoindata.suomi.fi/data/fi/dataset/liikennemaarat)
- **Records**: 18,479 per-segment KVL features for 2024
- **Fields**: `kvl` (total AADT), `kvl_raskas` (heavy), `kvl_yhdistelma` (articulated/HGV), seasonal variation classes
- **Coverage**: All Finnish state highways (maantiet, ~85,000 km)
- **Result**: 243,142 road segments enriched, 266 of 440 Finnish hexes updated
- **Top corridors**:
  - **Tie 101** (Kehä I — Helsinki inner ring) — 108,372 KVL
  - **Tie 50** (Kehä III — Helsinki outer ring) — 89,457 KVL
  - **Tie 1** (E18 Helsinki–Turku motorway) — 74,506 KVL
  - **Tie 4** (E75 Helsinki–Lahti–Oulu) — 69,807 KVL
- **License**: CC-BY 4.0 (Väylävirasto)

### Gaps

Väylävirasto KVL covers state highways only — municipal streets in cities (Helsinki centrum, Espoo, Tampere) use OSM defaults outside the highway network.

## Railway

### Multi-feed Finnish GTFS

Four GTFS feeds merged for railway enrichment:

| Operator | Coverage | Source |
|---|---|---|
| **Fintraffic VR** | National passenger rail (VR intercity, Pendolino, IC, regional) | [rata.digitraffic.fi/api/v1/trains/gtfs-passenger.zip](https://rata.digitraffic.fi/api/v1/trains/gtfs-passenger.zip) (requires `Accept-Encoding: gzip`) |
| **HSL Helsinki** | Helsinki Region Transport — commuter rail (Kehärata, Rantarata) + Metro (M1/M2) + tram + bus | [infopalvelut.storage.hsldev.com/gtfs/hsl.zip](https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip) (69 MB, daily) |
| **Tampere Raitiotie** | Tampere tram (2 lines) + bus | [data.itsfactory.fi/journeys/files/gtfs/latest/gtfs_tampere.zip](http://data.itsfactory.fi/journeys/files/gtfs/latest/gtfs_tampere.zip) |
| **Föli Turku** | Turku — bus only (no tram) | [data.foli.fi/gtfs/gtfs.zip](http://data.foli.fi/gtfs/gtfs.zip) |

- **Merged**: 608 unique rail/tram stops
- **Result**: 19,066 railway segments enriched
- **Busiest hubs** (Helsinki Metro dominates):
  - **Helsinki Päärautatieasema** (Central Station) — 601 trains/day
  - **Ruoholahti** (Metro) — 570 trains/day
  - **Rautatientori** (Metro) — 570 trains/day
  - **Hakaniemi** (Metro) — 570 trains/day
  - **Sörnäinen** (Metro) — 570 trains/day

### City coverage

| City | % Enriched | Max trains/day |
|---|---|---|
| Espoo | 66.4% | 285 (HSL commuter) |
| Helsinki | 65.3% | 601 (Päärautatieasema) |
| Tampere | 33.1% | 272 (Raitiotie tram) |
| Oulu | — | 230 (VR intercity) |
| Turku | — | 0 (Föli is bus-only) |

### Rail GTFS gaps

- **Tampere/Turku rail (VR mainline)**: VR intercity serves both Tampere and Turku, but their station tiles show sparse matched rail — Tampere's per-tile figure reflects the Raitiotie tram, and Turku (no tram, only the Föli bus feed locally) has little matched rail despite the VR terminus.
- **Turku tram**: doesn't exist (Turku has buses only via Föli)

## Buildings

GHSL Built-H R2023A 100 m global raster + sparse OSM `building:levels`. Finland's NLS (Maanmittauslaitos) Maastotietokanta has world-class per-building data including footprint, use class, and `korkeussuhde` (elevation difference for height derivation), but bulk download requires a free Geotorget API key.

The **NLS INSPIRE WFS** at `inspire-wfs.maanmittauslaitos.fi/inspire-wfs/bu_mtk_polygon` provides 2D footprints without auth, but heights/floors are only in the full Maastotietokanta product.

## Industrial

- **E-PRTR**: Finnish facilities receive NACE 2-digit codes via `/enrich-continent europe` — the EU/EEA register that tracks Finland's large emitters: Stora Enso/UPM/Metsä Group pulp & paper, Outokumpu steel (Tornio), Neste refineries (Porvoo, Naantali), Yara fertilizers (Uusikaupunki, Siilinjärvi).
- **SYKE** publishes a 51 KB shapefile of 1,018 facilities at [wwwd3.ymparisto.fi/d3/gis_data/spesific/tuotantolaitokset.zip](https://wwwd3.ymparisto.fi/d3/gis_data/spesific/tuotantolaitokset.zip) (CC-BY 4.0) that would add finer national coverage (smaller sites below the E-PRTR reporting threshold), but is not yet ingested.
- **Wind turbines**: ~6 GW installed but no per-turbine open registry. NLS Maastotietokanta `tuulivoimala` feature class would have ~1,600 turbines but requires the same Geotorget API key.

## Validation

Finland implements END (Environmental Noise Directive 2002/49/EC) via the Environmental Noise Decree (Asetus ympäristömelusta 801/2004). Strategic noise maps for agglomerations >100k inhabitants and major roads/railways/airports are produced every 5 years by:

- **SYKE** (Suomen Ympäristökeskus / Finnish Environment Institute) — national aggregator
- **Väylävirasto** — for state roads and railways
- **Cities** — Helsinki, Espoo, Vantaa, Tampere, Turku, Oulu publish per-municipality noise maps

The Helsinki Metro extension (Länsimetro to Kivenlahti), the Kehärata airport rail loop, and the Helsinki–Tampere main line are notable noise sources documented in END Round 4. Väylävirasto pre-computed noise contours are published as `ratatiedot:melu_paiva_rautatiet_22` and `melu_yo_rautatiet_22` via the same WFS — useful as validation references.
