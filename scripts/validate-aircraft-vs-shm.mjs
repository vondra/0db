#!/usr/bin/env node
// Validate compute_aircraft_v6 popup output against SHM 2022 polygons +
// the component-gate suite from `build-isobar-fixture.mjs`.
//
// Three gates per plan:
//   A. Isobar test — per dB level: mean |error| ≤ 5 dB, p95 ≤ 8 dB,
//      no systematic bias > 3 dB. Thresholds match END/SHM noise-mapping
//      reproducibility — 5 dB band width × ~1 dB inter-method spread.
//   B. Monotonic ordering — pair violations ≤ 10 %, Spearman ρ ≥ 0.7.
//      Catches gross direction errors (e.g. swapped levels) that A might
//      tolerate via averaging.
//   C. Component gates — R1 must show a non-zero ground-ops contributor,
//      Ruzyně airport_key in top 3 ground ops, n_modeled_per_day > 0,
//      touchdown ≥ approach corridor, gradient monotonic from
//      touchdown → 1 km → 3 km. Surfaces structural bugs (missing
//      ground synthesis, wrong airport routing) that aggregate stats
//      can hide.
//
// Writes a CSV row per fixture point and a one-line PASS/FAIL summary.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';

function parseArgs(arr) {
  const out = { popupBase: 'http://localhost:8522', timeoutMs: 15000 };
  for (let i = 0; i < arr.length; i++) {
    const k = arr[i];
    const v = arr[i + 1];
    if (k === '--fixture') { out.fixture = v; i++; }
    else if (k === '--popup-base') { out.popupBase = v; i++; }
    else if (k === '--output') { out.output = v; i++; }
    else if (k === '--timeout-ms') { out.timeoutMs = Number(v); i++; }
  }
  return out;
}

// Popup contract (server/src/routes/noise-onfly-v2.ts flattens NoiseResult):
//   sources[i].{lden, lden_free, segment_count, displayed_count, source_type}
//   top_contributors[i].{received_lden, distance_m, name, subtype, metadata: {
//     kind: "aircraft", variant: "airborne"|"ground_ops",
//     airport_key, airport_name,
//     airborne?: {periods.lden_db, observed_flights_per_day, ...},
//     ground_ops?: {periods.lden_db, observed_movements_per_day, modeled_movements_per_day, ...}
//   }}
// /gg (Codex) caught a prior version that read `.periods.lden_db` nested
// — the popup has already flattened to `lden` / `received_lden`.
async function popupAircraftDb(base, lat, lon, timeoutMs) {
  const url = `${base}/api/noise-onfly-v2?lat=${lat}&lng=${lon}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const data = await r.json();
    const aircraftSrc = (data.sources || []).find((s) => s.source_type === 'aircraft');
    const topContribs = data.top_contributors || [];
    const airborneContrib = topContribs.find(
      (c) => c.source_type === 'aircraft' && c.subtype === 'airborne'
    );
    const groundContribs = topContribs
      .filter((c) => c.source_type === 'aircraft' && c.subtype === 'ground_ops')
      .map((c) => ({
        airport_key: c.metadata?.airport_key ?? null,
        airport_name: c.metadata?.airport_name ?? null,
        lden_db: c.received_lden ?? c.metadata?.ground_ops?.periods?.lden_db ?? null,
        observed_per_day: c.metadata?.ground_ops?.observed_movements_per_day ?? 0,
        modeled_per_day: c.metadata?.ground_ops?.modeled_movements_per_day ?? 0,
      }))
      .sort((a, b) => (b.lden_db ?? -Infinity) - (a.lden_db ?? -Infinity));
    // Aggregate ground stats across all ground contributors (one
    // aircraft_lden number is per-source, not per-bucket).
    const linToDb = (lin) => (lin > 0 ? 10 * Math.log10(lin) : null);
    const groundEnergy = groundContribs.reduce((acc, c) => {
      if (typeof c.lden_db !== 'number' || !Number.isFinite(c.lden_db)) return acc;
      return acc + Math.pow(10, c.lden_db / 10);
    }, 0);
    const ground_ops_lden = groundEnergy > 0 ? linToDb(groundEnergy) : null;
    const n_modeled_per_day = groundContribs.reduce((a, c) => a + (c.modeled_per_day || 0), 0);
    const n_observed_per_day = groundContribs.reduce((a, c) => a + (c.observed_per_day || 0), 0);
    return {
      aircraft_lden: aircraftSrc?.lden ?? null,
      ground_ops_lden,
      airborne_lden:
        airborneContrib?.metadata?.airborne?.periods?.lden_db ??
        airborneContrib?.received_lden ?? null,
      n_modeled_per_day,
      n_observed_per_day,
      ground_contribs: groundContribs,
    };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(t);
  }
}

// Lower-quartile-style quantile: pick the floor index of q*n. Adequate for
// our small samples (~5 points per dB level) where Hyndman-Fan refinements
// don't matter — all gates run with non-trivial slack vs the threshold.
function quantile(arr, q) {
  if (arr.length === 0) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.floor(q * a.length));
  return a[idx];
}

function mean(arr) {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Ordinal-rank Spearman; ties get distinct ranks rather than the textbook
// average-rank correction. Acceptable here: expected_db is discrete (50, 55,
// …, 75) so within-level ties shift rho by < 0.05 vs the 0.7 threshold.
function spearmanRho(xs, ys) {
  const n = xs.length;
  if (n < 3) return NaN;
  const rank = (vs) => {
    const idx = vs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    for (let i = 0; i < n; i++) r[idx[i][1]] = i + 1;
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  let sumD2 = 0;
  for (let i = 0; i < n; i++) sumD2 += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

async function probeFixture(fixture, popupBase, timeoutMs) {
  const rows = [];
  for (let i = 0; i < fixture.length; i++) {
    const fx = fixture[i];
    process.stderr.write(`\r${i + 1}/${fixture.length} ${fx.label || ''}              `);
    const p = await popupAircraftDb(popupBase, fx.lat, fx.lon, timeoutMs);
    rows.push({
      lat: fx.lat,
      lon: fx.lon,
      label: fx.label || '',
      expected_db: fx.expected_db,
      ...p,
    });
  }
  process.stderr.write('\n');
  return rows;
}

function gateAIsobar(rows) {
  const byLevel = new Map();
  for (const r of rows) {
    if (r.expected_db == null || !Number.isFinite(r.aircraft_lden)) continue;
    if (!byLevel.has(r.expected_db)) byLevel.set(r.expected_db, []);
    byLevel.get(r.expected_db).push(r.aircraft_lden - r.expected_db);
  }
  const stats = [];
  let pass = true;
  for (const [level, errs] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    const meanAbs = mean(errs.map(Math.abs));
    const p95 = quantile(errs.map(Math.abs), 0.95);
    const bias = mean(errs);
    const ok = meanAbs <= 5 && p95 <= 8 && Math.abs(bias) <= 3;
    stats.push({ level, n: errs.length, mean_abs: meanAbs, p95, bias, ok });
    if (!ok) pass = false;
  }
  return { stats, pass };
}

function gateBMonotonic(rows) {
  const pairs = rows
    .filter((r) => r.expected_db != null && Number.isFinite(r.aircraft_lden))
    .sort((a, b) => a.expected_db - b.expected_db);
  let viol = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      if (pairs[j].aircraft_lden < pairs[i].aircraft_lden) viol++;
    }
  }
  const totalPairs = (pairs.length * (pairs.length - 1)) / 2;
  const violRatio = totalPairs > 0 ? viol / totalPairs : 0;
  const rho = spearmanRho(
    pairs.map((r) => r.expected_db),
    pairs.map((r) => r.aircraft_lden)
  );
  return { violRatio, rho, pass: violRatio <= 0.10 && rho >= 0.7 };
}

function gateCComponent(rows) {
  const findByLabel = (substr) => rows.find((r) => r.label?.includes(substr));
  const r1 = findByLabel('R1 main');
  const touchdown = findByLabel('RWY24 touchdown');
  const corridor1 = findByLabel('Approach corridor 1km east');
  const corridor3 = findByLabel('Approach corridor 3km east');
  const finiteLden = (r) => !!r && Number.isFinite(r.aircraft_lden);

  const checks = {
    r1_has_ground_ops: !!r1 && Number.isFinite(r1.ground_ops_lden),
    // LKPR Ruzyně must dominate Prague-area ground contributions; we accept
    // any of the airport_key/name spellings the engine emits.
    ruzyne_in_top3_ground:
      !!r1 &&
      r1.ground_contribs
        .slice(0, 3)
        .some((c) => /LKPR|Ruzy|prague/i.test(`${c.airport_key} ${c.airport_name}`)),
    // Synthesis must have run for R1 to fill the sparse-ADS-B ground gap.
    n_modeled_positive: !!r1 && r1.n_modeled_per_day > 0,
    touchdown_ge_corridor:
      finiteLden(touchdown) && finiteLden(corridor3) &&
      touchdown.aircraft_lden >= corridor3.aircraft_lden,
    gradient_monotonic:
      finiteLden(touchdown) && finiteLden(corridor1) && finiteLden(corridor3) &&
      touchdown.aircraft_lden >= corridor1.aircraft_lden &&
      corridor1.aircraft_lden >= corridor3.aircraft_lden,
  };
  return { checks, pass: Object.values(checks).every(Boolean) };
}

function writeCsv(outputPath, rows) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const header = 'lat,lon,label,expected_db,aircraft_lden,ground_ops_lden,airborne_lden,n_observed_per_day,n_modeled_per_day,error_db';
  const csvRows = rows.map((r) => {
    const err =
      r.expected_db != null && Number.isFinite(r.aircraft_lden)
        ? r.aircraft_lden - r.expected_db
        : '';
    return [
      r.lat,
      r.lon,
      JSON.stringify(r.label),
      r.expected_db ?? '',
      r.aircraft_lden ?? '',
      r.ground_ops_lden ?? '',
      r.airborne_lden ?? '',
      r.n_observed_per_day ?? '',
      r.n_modeled_per_day ?? '',
      err,
    ].join(',');
  });
  writeFileSync(outputPath, [header, ...csvRows].join('\n') + '\n');
}

function printSummary(gateA, gateB, gateC) {
  console.log('=== Gate A — Isobar ===');
  for (const r of gateA.stats) {
    console.log(
      `  L${r.level} n=${r.n} mean|err|=${r.mean_abs.toFixed(2)} p95=${r.p95.toFixed(2)} bias=${r.bias.toFixed(2)} ${r.ok ? 'OK' : 'FAIL'}`
    );
  }
  console.log(`  ${gateA.pass ? 'PASS' : 'FAIL'}`);
  console.log();
  console.log('=== Gate B — Monotonic ordering ===');
  console.log(`  pair violations: ${(gateB.violRatio * 100).toFixed(1)} % (limit 10 %)`);
  console.log(`  Spearman rho:    ${gateB.rho.toFixed(3)} (limit ≥ 0.7)`);
  console.log(`  ${gateB.pass ? 'PASS' : 'FAIL'}`);
  console.log();
  console.log('=== Gate C — Component ===');
  for (const [k, v] of Object.entries(gateC.checks)) {
    console.log(`  ${k}: ${v ? 'OK' : 'FAIL'}`);
  }
  console.log(`  ${gateC.pass ? 'PASS' : 'FAIL'}`);
  console.log();
}

async function main() {
  const args = parseArgs(argv.slice(2));
  if (!args.fixture) {
    console.error(
      'usage: validate-aircraft-vs-shm.mjs --fixture <fixture.json> [--popup-base http://localhost:8522] [--output <csv>] [--timeout-ms 15000]'
    );
    exit(1);
  }

  let fixture;
  try {
    fixture = JSON.parse(readFileSync(args.fixture, 'utf8'));
  } catch (e) {
    console.error(`failed to read fixture ${args.fixture}: ${e.message}`);
    console.error('hint: run scripts/build-isobar-fixture.mjs first');
    exit(2);
  }
  if (!Array.isArray(fixture) || fixture.length === 0) {
    console.error(`fixture ${args.fixture} is empty or not an array`);
    exit(2);
  }

  const rows = await probeFixture(fixture, args.popupBase, args.timeoutMs);

  // Operator UX: bail loudly if the popup base is unreachable rather than
  // emitting confusing all-NaN gate stats below.
  const errored = rows.filter((r) => r.error).length;
  if (errored === rows.length) {
    console.error(`all ${rows.length} probes failed against ${args.popupBase}`);
    console.error(`first error: ${rows[0].error}`);
    console.error('hint: is the popup server running? PORT=8522 ./start.sh');
    exit(2);
  }
  if (errored > 0) {
    console.error(`warning: ${errored}/${rows.length} probes errored (continuing)`);
  }

  const gateA = gateAIsobar(rows);
  const gateB = gateBMonotonic(rows);
  const gateC = gateCComponent(rows);

  if (args.output) writeCsv(args.output, rows);

  printSummary(gateA, gateB, gateC);

  const overall = gateA.pass && gateB.pass && gateC.pass;
  console.log(overall ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  exit(overall ? 0 : 1);
}

main().catch((e) => {
  console.error('fatal:', e);
  exit(1);
});
