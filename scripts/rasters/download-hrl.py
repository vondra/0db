#!/usr/bin/env python3
"""Download Copernicus HRL VLCC rasters from WEkEO for the EU field-raster
upgrades (geodata-v2 Phase 2): Tree Cover Density 2023 and Imperviousness
Density 2024, both native 10 m, EEA38+UK coverage (835 / 887 tiles of the
100 km EPSG:3035 grid, ~20 GB / ~4 GB zipped COGs).

    ~/.local/venvs/hda/bin/python scripts/rasters/download-hrl.py tcd [--workers 4]
    ~/.local/venvs/hda/bin/python scripts/rasters/download-hrl.py imd [--workers 4]

Auth: ~/.hdarc (WEkEO user/password; the hda client reads it itself — no
credentials in code or logs). Direct S3 GETs on the result `localpath` 401,
so every item goes through the hda order+download flow.

Destinations follow the layout `convert-imd-overlay.sh` already consumes
(`data/source/imd/{year}/*.tif`); TCD mirrors it at `data/source/tcd/2023/`.
Idempotent: each extracted tile leaves a `.done/<location>` marker and is
skipped on re-run; zips are extracted then deleted; stale partial zips
(>24 h) are swept at startup. Workers stride the deterministic search-result
order, each with its own client session.
"""

import argparse
import multiprocessing
import sys
import time
import zipfile
from pathlib import Path

# EEA38+UK incl. Azores/Canaries — matches the HRL VLCC production extent.
EU_BBOX = [-32.0, 26.0, 45.0, 72.5]

REPO_ROOT = Path(__file__).resolve().parents[2]

PRODUCTS = {
    "tcd": {
        "dataset_id": "EO:EEA:DAT:HRL:TCF",
        "productType": "Tree Cover Density",
        "year": "2023",
        "dest": REPO_ROOT / "data/source/tcd/2023",
    },
    "imd": {
        "dataset_id": "EO:EEA:DAT:HRL:IMP",
        "productType": "Imperviousness Density",
        "year": "2024",
        "dest": REPO_ROOT / "data/source/imd/2024",
    },
}


def product_query(spec: dict) -> dict:
    return {
        "dataset_id": spec["dataset_id"],
        "bbox": EU_BBOX,
        "productType": spec["productType"],
        "resolution": "10m",
        "year": spec["year"],
    }


def sweep_stale_zips(zips_dir: Path) -> None:
    """Partial zips from a crashed run have unique order-ids and would
    otherwise accumulate forever; anything older than a day is garbage."""
    cutoff = time.time() - 24 * 3600
    for z in zips_dir.glob("*.zip"):
        if z.stat().st_mtime < cutoff:
            z.unlink()
            print(f"[sweep] removed stale partial {z.name}", flush=True)


def extract_tifs(zip_path: Path, dest: Path) -> list[str]:
    names = []
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.namelist():
            if member.lower().endswith((".tif", ".tiff")) and "/" not in member.strip("/"):
                zf.extract(member, dest)
                names.append(member)
            elif member.lower().endswith((".tif", ".tiff")):
                # nested path: flatten to the basename
                base = Path(member).name
                with zf.open(member) as src, open(dest / base, "wb") as out:
                    out.write(src.read())
                names.append(base)
    return names


def worker(product: str, offset: int, stride: int) -> None:
    from hda import Client  # per-process session

    spec = PRODUCTS[product]
    dest = spec["dest"]
    done_dir = dest / ".done"
    zips_dir = dest / ".zips"
    client = Client()
    results = client.search(product_query(spec))
    n = len(results.results)
    for i in range(offset, n, stride):
        loc = results.results[i]["properties"]["location"]
        marker = done_dir / loc
        if marker.exists():
            continue
        size_mb = results.results[i]["properties"].get("size", 0) / 1e6
        print(f"[w{offset}] {i + 1}/{n} {loc} ({size_mb:.0f} MB)", flush=True)
        # hda's SearchResults.download SWALLOWS task exceptions (logger.error
        # + continue), and WEkEO order quotas surface as a crash inside the
        # client's own quota-message formatter ("year 58542 is out of range":
        # X-Quota-Reset is epoch-MILLISECONDS). The only reliable success
        # signal is a NEW file on disk — anything else retries on a
        # quota-scale backoff (quota windows reset hourly).
        # 14 attempts × (quadratic → 1 h cap) backoff ≈ 11 h of patience per
        # item: WEkEO's order quota window looks DAILY, not hourly — the
        # observed pattern is ~470 orders then a hard wall.
        for attempt in range(1, 15):
            try:
                before = set(zips_dir.iterdir())
                results[i].download(str(zips_dir))
                new_files = set(zips_dir.iterdir()) - before
                if not new_files:
                    raise RuntimeError("download produced no file (order quota?)")
                got_tif = False
                for f in new_files:
                    if f.suffix.lower() in (".tif", ".tiff"):
                        f.rename(dest / f.name)  # small tiles ship unzipped
                        got_tif = True
                    else:
                        got_tif |= bool(extract_tifs(f, dest))
                        f.unlink()
                if not got_tif:
                    raise RuntimeError(f"{loc}: download had no .tif payload")
                marker.write_text("")
                break
            except Exception as e:  # noqa: BLE001 — quota / transient order/net fault
                print(f"[w{offset}] {loc} attempt {attempt} failed: {e}", flush=True)
                if attempt == 14:
                    raise
                time.sleep(min(90 * attempt * attempt, 3600))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("product", choices=sorted(PRODUCTS))
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    spec = PRODUCTS[args.product]
    dest = spec["dest"]
    (dest / ".done").mkdir(parents=True, exist_ok=True)
    (dest / ".zips").mkdir(parents=True, exist_ok=True)
    sweep_stale_zips(dest / ".zips")
    # Invalidate markers whose tile never landed (the pre-fix runs wrote
    # markers on silently-failed downloads): marker ⇒ dest/<location>.tif.
    stale = [m for m in (dest / ".done").iterdir() if not (dest / f"{m.name}.tif").exists()]
    for m in stale:
        m.unlink()
    if stale:
        print(f"[{args.product}] invalidated {len(stale)} markers without tiles", flush=True)

    from hda import Client

    n = len(Client().search(product_query(spec)).results)
    done = len(list((dest / ".done").iterdir()))
    print(f"[{args.product}] {n} tiles total, {done} already done → {dest}", flush=True)
    if done >= n:
        print(f"[{args.product}] complete", flush=True)
        return 0

    procs = [
        multiprocessing.Process(target=worker, args=(args.product, off, args.workers))
        for off in range(args.workers)
    ]
    for p in procs:
        p.start()
    for p in procs:
        p.join()
    failed = [p.exitcode for p in procs if p.exitcode != 0]
    done = len(list((dest / ".done").iterdir()))
    print(f"[{args.product}] finished: {done}/{n} tiles, {len(failed)} worker failures", flush=True)
    return 1 if failed or done < n else 0


if __name__ == "__main__":
    sys.exit(main())
