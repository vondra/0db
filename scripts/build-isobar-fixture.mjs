#!/usr/bin/env node
// Build a popup-validation fixture by sampling points on SHM 2022 isobar
// boundaries. For each Lden level (50, 55, 60, 65, 70, 75 dB) the script
// picks `--per-level` points along the polygon ring of the matching SHM
// feature class. The popup must reproduce the same Lden ±tolerance at
// each point — `validate-aircraft-vs-shm.mjs` checks the round-trip.
//
// Adds 10 manual receivers around Ruzyně for the component-gate suite
// (R1 must show ground ops, RWY24 touchdown vs 3 km approach corridor,
// etc.). Output is a JSON array of `{ lat, lon, expected_db, label }`.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';

function parseArgs(arr) {
  const out = { levels: [50, 55, 60, 65, 70, 75], perLevel: 5, manual: true };
  for (let i = 0; i < arr.length; i++) {
    const k = arr[i];
    const v = arr[i + 1];
    if (k === '--shm') { out.shm = v; i++; }
    else if (k === '--bbox') { out.bbox = v.split(',').map(Number); i++; }
    else if (k === '--levels') { out.levels = v.split(',').map(Number); i++; }
    else if (k === '--per-level') { out.perLevel = Number(v); i++; }
    else if (k === '--output') { out.output = v; i++; }
    else if (k === '--no-manual') { out.manual = false; }
  }
  return out;
}

const RUZYNE_MANUAL = [
  { lat: 50.1188, lon: 14.2823, label: 'R1 main terminal area' },
  { lat: 50.116, lon: 14.281, label: 'RWY24 touchdown' },
  { lat: 50.1075, lon: 14.265, label: 'RWY24 mid-runway' },
  { lat: 50.105, lon: 14.245, label: 'RWY24 west threshold' },
  { lat: 50.135, lon: 14.310, label: 'Approach corridor 3km east' },
  { lat: 50.125, lon: 14.292, label: 'Approach corridor 1km east' },
  { lat: 50.105, lon: 14.220, label: 'Approach corridor 3km west' },
  { lat: 50.092, lon: 14.265, label: '2km south, residential' },
  { lat: 50.140, lon: 14.260, label: '2km north, residential' },
  { lat: 50.120, lon: 14.180, label: '7km west, rural background' },
];

function* iterRings(geom) {
  if (!geom) return;
  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates) yield ring;
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      for (const ring of poly) yield ring;
    }
  }
}

function pickPointsOnRing(ring, n) {
  if (ring.length < 2) return [];
  const stride = Math.max(1, Math.floor(ring.length / Math.max(1, n)));
  const out = [];
  for (let i = 0; out.length < n && i < ring.length; i += stride) {
    const [lon, lat] = ring[i];
    out.push({ lat, lon });
  }
  return out;
}

function main() {
  const args = parseArgs(argv.slice(2));
  if (!args.shm || !args.output) {
    console.error('usage: build-isobar-fixture.mjs --shm <geojson> --output <json> [--levels 50,55,60] [--per-level 5] [--bbox lon0,lat0,lon1,lat1]');
    exit(1);
  }
  const fc = JSON.parse(readFileSync(args.shm, 'utf8'));
  const out = [];
  const inBbox = (lat, lon) => {
    if (!args.bbox) return true;
    const [a, b, c, d] = args.bbox;
    // bbox is lat,lon,lat,lon per plan
    return lat >= a && lat <= c && lon >= b && lon <= d;
  };

  for (const level of args.levels) {
    let kept = 0;
    for (const f of fc.features ?? []) {
      const props = f.properties ?? {};
      // SHM convention: `Lden` band field varies per layer; tolerate
      // common spellings (`db_lo`, `dB_LO`, `level_db`, `lden_class`).
      const lvl =
        props.db_lo ?? props.dB_LO ?? props.level_db ??
        props.lden_class ?? props.LDEN ?? props.lden;
      if (lvl !== level) continue;
      for (const ring of iterRings(f.geometry)) {
        const pts = pickPointsOnRing(ring, args.perLevel - kept);
        for (const p of pts) {
          if (!inBbox(p.lat, p.lon)) continue;
          out.push({
            lat: p.lat,
            lon: p.lon,
            expected_db: level,
            label: `isobar L${level}`,
          });
          kept++;
          if (kept >= args.perLevel) break;
        }
        if (kept >= args.perLevel) break;
      }
      if (kept >= args.perLevel) break;
    }
    console.error(`level ${level}: ${kept} points`);
  }

  if (args.manual) {
    for (const m of RUZYNE_MANUAL) {
      out.push({
        lat: m.lat,
        lon: m.lon,
        expected_db: null,
        label: m.label,
      });
    }
  }

  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, JSON.stringify(out, null, 2));
  console.error(`wrote ${out.length} fixture points → ${args.output}`);
}

main();
