# 0db — Quiet Map

Global environmental noise atlas: computed sound levels (Lden) from roads, railways,
aircraft, industry, buildings and settlements, for the whole world at ~25 m resolution,
served as an interactive web map with per-point source breakdowns.

Live instance: <https://0db.app>

## What this repo is

The **public** half of the project: everything that turns raw open data into the noise
map and shows it to a visitor — the noise model and engine, the data pipeline that
extracts and enriches OSM / ADS-B / rasters, the tile builders, and the web app.
The private half (cluster orchestration, hosting, ops automation) is intentionally
not published.

```
engine/       Rust noise engine — CNOSSOS-EU surface sources, ISO 9613-2 propagation,
              Doc 29-inspired aircraft NPD (crate noise-compute is the shared kernel;
              tile-painter builds the tiles, noise-gpu the CUDA ports, SPEC.md is the model)
pipeline/     TypeScript enrichment — patches OSM defaults with measured/registry data
              (traffic, industry, buildings) per country, plus the validation suite
scripts/      Data build entry points: run-extraction.sh (rasters + OSM extract),
              build-heatmap.sh (whole tile build), osm-to-h3r4.sh, run-aircraft-extract.sh
server/       Fastify web server — tiles, popup noise queries, search, isochrones
frontend/     The map — React 19 + MapLibre + deck.gl (Vite build)
docs/about/   The public About pages (model, sources, per-country notes)
```

## Quick start

```bash
./start.sh                # builds the engine + frontend + server, serves on :8520
./scripts/check-fast.sh   # the quality gate: tests + builds, no big data needed
```

The map needs prepared data (DEM, building/forest/IMD rasters, OSM extracts) to render
anything real; `scripts/run-extraction.sh` fetches and prepares them, then
`scripts/build-heatmap.sh` computes tiles.

## Layout of the data (not in git)

`data/` is gitignored and large: prepared 1°×1° rasters (30 m), H3-res-4 arrow
extracts, and the computed tile stores. Rasters and DEM are shared; tiles are built
per dataset year (see `DATA_YEAR`).

## License & contact

See `docs/about/credits.md` for data-source attribution (OSM, GLO-30, SRTM, Overture,
WorldCover, IMD, ADS-B) and terms. hello@0db.app.
