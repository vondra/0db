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

// Manual receivers for Gate C (component checks). Coordinates picked from
// the 2022 master plan of LKPR Ruzyně to exercise specific physics gates:
// R1 — first row of houses next to apron, must see ground_ops contributor.
// RWY24 touchdown/mid/west — sweeps the ground-roll energy band.
// Approach corridor 1/3 km east/west — checks the airborne descent gradient
// (touchdown ≥ 1 km ≥ 3 km is the monotonic-gradient gate).
// 2 km N/S residential — Doc 29 lateral attenuation in populated zones.
// 7 km west rural — background floor far from any active runway.
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

// Walk the ring with a stride so the n samples are spread around the
// polygon perimeter rather than clustered near coordinate index 0.
function pickPointsOnRing(ring, n) {
  if (ring.length < 2 || n <= 0) return [];
  const stride = Math.max(1, Math.floor(ring.length / n));
  const out = [];
  for (let i = 0; out.length < n && i < ring.length; i += stride) {
    const [lon, lat] = ring[i];
    out.push({ lat, lon });
  }
  return out;
}

// SHM Lden band field name varies per layer release. Tolerate the common
// spellings seen in geoportal.mzcr.cz exports across 2017/2022 vintages.
function readLdenBand(props) {
  return (
    props.db_lo ?? props.dB_LO ?? props.level_db ??
    props.lden_class ?? props.LDEN ?? props.lden
  );
}

function isobarPointsForLevel(features, level, perLevel, inBbox) {
  const out = [];
  for (const f of features) {
    if (out.length >= perLevel) break;
    if (readLdenBand(f.properties ?? {}) !== level) continue;
    for (const ring of iterRings(f.geometry)) {
      if (out.length >= perLevel) break;
      for (const p of pickPointsOnRing(ring, perLevel - out.length)) {
        if (!inBbox(p.lat, p.lon)) continue;
        out.push({ lat: p.lat, lon: p.lon, expected_db: level, label: `isobar L${level}` });
        if (out.length >= perLevel) break;
      }
    }
  }
  return out;
}

function main() {
  const args = parseArgs(argv.slice(2));
  if (!args.shm || !args.output) {
    console.error('usage: build-isobar-fixture.mjs --shm <geojson> --output <json> [--levels 50,55,60] [--per-level 5] [--bbox latMin,lonMin,latMax,lonMax] [--no-manual]');
    exit(1);
  }
  const fc = JSON.parse(readFileSync(args.shm, 'utf8'));
  const features = fc.features ?? [];
  // /gg (Codex) caught a silent-pass risk: an empty SHM file produced
  // a zero-isobar fixture and Gate A then validated only the manual
  // receivers and reported PASS on incomplete evidence. Fail loud
  // when the input has no features.
  if (features.length === 0) {
    console.error(
      `error: SHM file ${args.shm} has zero features. Re-run shm-paginate-fetch.py first?`
    );
    exit(1);
  }

  // Plan §C5 Step 2 specifies bbox as `latMin,lonMin,latMax,lonMax`
  // (e.g. `50.05,14.21,50.15,14.31` to clip to the LKPR Ruzyně extent).
  const inBbox = args.bbox
    ? (lat, lon) => {
        const [latMin, lonMin, latMax, lonMax] = args.bbox;
        return lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax;
      }
    : () => true;

  const out = [];
  const underCovered = [];
  for (const level of args.levels) {
    const points = isobarPointsForLevel(features, level, args.perLevel, inBbox);
    out.push(...points);
    console.error(`level ${level}: ${points.length} points`);
    if (points.length < args.perLevel) {
      underCovered.push({ level, got: points.length });
    }
  }
  if (underCovered.length > 0) {
    console.error(
      `error: ${underCovered.length} level(s) under-covered: ` +
        underCovered.map((u) => `L${u.level}=${u.got}/${args.perLevel}`).join(', ')
    );
    console.error(
      'Gate A would otherwise pass on incomplete evidence — widen --bbox, lower --per-level, or supply a denser SHM extract.'
    );
    exit(1);
  }

  if (args.manual) {
    for (const m of RUZYNE_MANUAL) {
      out.push({ lat: m.lat, lon: m.lon, expected_db: null, label: m.label });
    }
  }

  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, JSON.stringify(out, null, 2));
  console.error(`wrote ${out.length} fixture points → ${args.output}`);
}

main();
