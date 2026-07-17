---
title: Credits & terms
intro: Data sources and rendering credits behind the map, plus the terms for using it.
nav: hidden
---

## Attribution

- **Base map:** © [CARTO](https://carto.com/about-carto/), © [OpenStreetMap](https://www.openstreetmap.org/about/) contributors
- **Terrain basemap:** © [OpenTopoMap](https://opentopomap.org/)
- **Satellite imagery:** © [Esri](https://www.esri.com/), Maxar, Earthstar Geographics
- **Elevation data:** [Copernicus GLO-30 DEM](https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model) (ESA/Copernicus, primary), [SRTM](https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-shuttle-radar-topography-mission-srtm-1) (NASA/USGS, fallback)
- **Building height:** [Overture Maps](https://overturemaps.org/) building raster (30m), derived from Overture building footprints and height tags
- **Land cover & vegetation:** [ESA WorldCover 2021](https://worldcover2021.esa.int/) (ESA, CC BY 4.0)
- **Ground imperviousness:** [ESA WorldCover](https://worldcover2021.esa.int/) land-cover proxy (global), refined by [Copernicus Imperviousness Density](https://land.copernicus.eu/en/products/high-resolution-layer-imperviousness) (EEA) where sourced
- **Road, railway & airport geometry:** © [OpenStreetMap](https://www.openstreetmap.org/) contributors (ODbL)
- **Flight data:** [ADSBExchange](https://www.adsbexchange.com/) (airline traffic samples) + [adsb.lol](https://adsb.lol/) (ADS-B community feeds — GA & helicopters)
- **Aircraft noise profiles:** [EASA ANP](https://www.easa.europa.eu/en/domains/environment/policy-support-and-research/aircraft-noise-and-performance-anp-data) (Aircraft Noise and Performance database)
- **Traffic counts:** national road surveys (e.g. [US FHWA HPMS](https://www.fhwa.dot.gov/policyinformation/hpms.cfm)), EU harmonized city AADT, national rail statistics + public [GTFS](https://gtfs.org/) timetables
- **Industrial facilities:** [E-PRTR](https://industry.eea.europa.eu/) (EU pollution registry), [Global Power Plant Database](https://datasets.wri.org/dataset/globalpowerplantdatabase) (WRI), [Global Energy Monitor](https://globalenergymonitor.org/) trackers, national wind-turbine registries
- **Map rendering:** [MapLibre GL JS](https://maplibre.org/) (open source)

## Data license & terms of use

The map, tiles and API are provided as a **service**, free to use and embed with attribution:

- **You may** link to 0db.app, embed the map or screenshots in your articles, apps and projects — with a visible attribution "**0db.app**" linking back here, plus "© OpenStreetMap contributors" (our models build on OpenStreetMap and other open data).
- **You may not** bulk-download tiles, scrape or mirror the dataset, or republish a copy of the map as your own service.
- **Commercial or high-volume use** (resale, white-label, heavy API traffic): [contact us](mailto:hello@0db.app) — we're friendly.

Raw model data is not distributed. Noise values are model estimates (CNOSSOS-EU / ISO 9613-2 based), not measurements — see the [methodology](/about/methodology) for accuracy and limitations.

**No warranty.** 0db.app is offered as-is, for information and orientation — please don't rely on it alone for legal, health, safety, or property decisions.

**Affiliate disclosure.** Some links we may add in future (property, stays, travel) can be affiliate links that earn us a small commission at no extra cost to you. They never influence the noise numbers — the map is computed identically for everyone.

<details>
<summary><strong>Privacy</strong></summary>

0db.app uses **no cookies, no trackers, no analytics scripts** — which is why there is no consent banner to click away.

To open the map near you, the first view is approximated to **city level** from your IP address using an offline GeoIP database running on our own server ([IP Geolocation by DB-IP](https://db-ip.com)). The lookup happens in memory, the result is not stored, and your IP is never sent to any third party for this. Precise location is used only if you tap the locate button, via your browser's standard permission prompt.

Our web server keeps standard access logs (IP address, requested URL without query parameters, browser user-agent) for security and operations — the legal basis is legitimate interest (GDPR art. 6(1)(f)). Logs rotate automatically and are kept at most 30 days, then deleted. They are not shared with anyone and are not used for profiling.

Questions or requests: [hello@0db.app](mailto:hello@0db.app).

</details>
