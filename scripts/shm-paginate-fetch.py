#!/usr/bin/env python3
"""Paginated download of SHM 2022 polygons from ArcGIS FeatureServer.

The Czech Ministry of Health (`geoportal.mzcr.cz`) publishes the SHM
strategic noise map polygons via an ESRI FeatureServer. Per-feature
pagination is capped at `maxRecordCount` (typically 2000), so a full
country layer needs many requests. This script paginates with
`resultOffset`/`resultRecordCount` and concatenates the results into a
single GeoJSON FeatureCollection.

Usage:
    scripts/shm-paginate-fetch.py \
        --service "https://geoportal.mzcr.cz/server/rest/services/SHM2022/INSPIRE/FeatureServer" \
        --layer-id 10 \
        --bbox 12,49,16,51 \
        --output data/source/shm/2022/cz_aircraft_lden.geojson

Provide --layer-id from a prior `?f=json` discovery call. The bbox
filters by the layer's spatial reference; the script forwards it via
the `geometry` + `geometryType=esriGeometryEnvelope` parameters.
"""

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path


def fetch_page(service: str, layer_id: int, params: dict, retries: int = 3) -> dict:
    url = f"{service}/{layer_id}/query?{urllib.parse.urlencode(params)}"
    last_err = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            last_err = e
            print(f"  retry {attempt + 1}/{retries}: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)
    raise RuntimeError(f"all {retries} retries failed for {url}: {last_err}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Paginated SHM 2022 polygon fetch")
    ap.add_argument("--service", required=True, help="FeatureServer base URL")
    ap.add_argument("--layer-id", type=int, required=True, help="Layer ID (from /?f=json)")
    ap.add_argument("--bbox", required=True, help="lon_min,lat_min,lon_max,lat_max")
    ap.add_argument("--output", required=True, help="Output GeoJSON path")
    ap.add_argument("--page-size", type=int, default=2000)
    ap.add_argument("--max-pages", type=int, default=200)
    args = ap.parse_args()

    bbox = [float(x) for x in args.bbox.split(",")]
    if len(bbox) != 4:
        print("--bbox must be 'lon_min,lat_min,lon_max,lat_max'", file=sys.stderr)
        return 1

    geometry = json.dumps(
        {
            "xmin": bbox[0],
            "ymin": bbox[1],
            "xmax": bbox[2],
            "ymax": bbox[3],
            "spatialReference": {"wkid": 4326},
        }
    )

    base_params = {
        "where": "1=1",
        "geometry": geometry,
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "outSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*",
        "returnGeometry": "true",
        "f": "geojson",
        "resultRecordCount": str(args.page_size),
    }

    out_features = []
    page = 0
    while page < args.max_pages:
        params = dict(base_params)
        params["resultOffset"] = str(page * args.page_size)
        print(f"page {page}: offset={params['resultOffset']}", file=sys.stderr)
        body = fetch_page(args.service, args.layer_id, params)
        feats = body.get("features", [])
        if not feats:
            print(f"  empty page → done", file=sys.stderr)
            break
        out_features.extend(feats)
        if len(feats) < args.page_size:
            print(f"  partial page ({len(feats)}) → done", file=sys.stderr)
            break
        page += 1

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fc = {"type": "FeatureCollection", "features": out_features}
    out_path.write_text(json.dumps(fc), encoding="utf-8")
    print(f"wrote {len(out_features)} features → {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
