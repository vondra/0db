#!/usr/bin/env node
// Validate compute_aircraft_v6 popup output against SHM 2022 polygons +
// the component-gate suite from `build-isobar-fixture.mjs`.
//
// Three gates per plan:
//   A. Isobar test — per dB level: mean |error| ≤ 5 dB, p95 ≤ 8 dB,
//      no systematic bias > 3 dB.
//   B. Monotonic ordering — pair violations ≤ 10 %, Spearman ρ ≥ 0.7.
//   C. Component gates — R1 must show a non-zero ground-ops contributor,
//      Ruzyně airport_key in top 3 ground ops, n_modeled_per_day > 0,
//      touchdown ≥ approach corridor, gradient monotonic from
//      touchdown → 1 km → 3 km.
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
    if (k === '--shm') { out.shm = v; i++; }
    else if (k === '--fixture') { out.fixture = v; i++; }
    else if (k === '--popup-base') { out.popupBase = v; i++; }
    else if (k === '--output') { out.output = v; i++; }
    else if (k === '--timeout-ms') { out.timeoutMs = Number(v); i++; }
  }
  return out;
}

async function popupAircraftDb(base, lat, lon, timeoutMs) {
  const url = `${base}/api/noise-onfly-v2?lat=${lat}&lng=${lon}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const data = await r.json();
    const aircraftSrc = (data.sources || []).find(
      (s) => s.source_type === 'aircraft'
    );
    const aircraftDetail = data.aircraft_detail || null;
    const groundContribs = (data.contributors || []).filter(
      (c) =>
        c.source_type === 'aircraft' &&
        (c.subtype === 'ground_ops' ||
          (c.metadata && c.metadata.variant === 'ground_ops'))
    );
    return {
      aircraft_lden: aircraftSrc ? aircraftSrc.periods?.lden_db ?? null : null,
      ground_ops_lden: aircraftDetail
        ? aircraftDetail.ground_ops?.periods?.lden_db ?? null
        : null,
      airborne_lden: aircraftDetail
        ? aircraftDetail.airborne?.periods?.lden_db ?? null
        : null,
      n_modeled_per_day: aircraftDetail
        ? aircraftDetail.ground_ops?.modeled_movements_per_day ?? 0
        : 0,
      n_observed_per_day: aircraftDetail
        ? aircraftDetail.ground_ops?.observed_movements_per_day ?? 0
        : 0,
      ground_contribs: groundContribs.map((c) => ({
        airport_key: c.metadata?.airport_key ?? null,
        airport_name: c.metadata?.airport_name ?? null,
        lden_db: c.periods?.lden_db ?? null,
      })),
    };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(t);
  }
}

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

async function main() {
  const args = parseArgs(argv.slice(2));
  if (!args.fixture) {
    console.error(
      'usage: validate-aircraft-vs-shm.mjs --fixture <fixture.json> [--shm <geojson>] [--popup-base http://localhost:8522] [--output <csv>]'
    );
    exit(1);
  }
  const fixture = JSON.parse(readFileSync(args.fixture, 'utf8'));

  const rows = [];
  for (let i = 0; i < fixture.length; i++) {
    const fx = fixture[i];
    process.stderr.write(`\r${i + 1}/${fixture.length} ${fx.label || ''}              `);
    const p = await popupAircraftDb(args.popupBase, fx.lat, fx.lon, args.timeoutMs);
    rows.push({
      lat: fx.lat,
      lon: fx.lon,
      label: fx.label || '',
      expected_db: fx.expected_db,
      ...p,
    });
  }
  process.stderr.write('\n');

  // Gate A — isobar
  const byLevel = new Map();
  for (const r of rows) {
    if (r.expected_db == null) continue;
    if (r.aircraft_lden == null || !Number.isFinite(r.aircraft_lden)) continue;
    if (!byLevel.has(r.expected_db)) byLevel.set(r.expected_db, []);
    byLevel.get(r.expected_db).push(r.aircraft_lden - r.expected_db);
  }
  const isobar = [];
  let isobarPass = true;
  for (const [level, errs] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    const meanAbs = mean(errs.map(Math.abs));
    const p95 = quantile(errs.map(Math.abs), 0.95);
    const bias = mean(errs);
    const ok = meanAbs <= 5 && p95 <= 8 && Math.abs(bias) <= 3;
    isobar.push({ level, n: errs.length, mean_abs: meanAbs, p95, bias, ok });
    if (!ok) isobarPass = false;
  }

  // Gate B — monotonic ordering: expected ↑ → measured ↑
  const lvlPairs = rows.filter((r) => r.expected_db != null && Number.isFinite(r.aircraft_lden));
  lvlPairs.sort((a, b) => a.expected_db - b.expected_db);
  let viol = 0;
  for (let i = 0; i < lvlPairs.length; i++) {
    for (let j = i + 1; j < lvlPairs.length; j++) {
      if (lvlPairs[j].aircraft_lden < lvlPairs[i].aircraft_lden) viol++;
    }
  }
  const totalPairs = (lvlPairs.length * (lvlPairs.length - 1)) / 2;
  const violRatio = totalPairs > 0 ? viol / totalPairs : 0;
  const rho = spearmanRho(
    lvlPairs.map((r) => r.expected_db),
    lvlPairs.map((r) => r.aircraft_lden)
  );
  const monotonicPass = violRatio <= 0.10 && rho >= 0.7;

  // Gate C — component
  const r1 = rows.find((r) => r.label && r.label.includes('R1 main'));
  const ruzyne = rows.find((r) => r.label && r.label.includes('RWY24 touchdown'));
  const corridor3 = rows.find((r) => r.label && r.label.includes('Approach corridor 3km east'));
  const corridor1 = rows.find((r) => r.label && r.label.includes('Approach corridor 1km east'));
  const componentChecks = {
    r1_has_ground_ops:
      !!r1 && !!r1.ground_ops_lden && Number.isFinite(r1.ground_ops_lden),
    ruzyne_in_top3_ground:
      !!r1 && r1.ground_contribs.slice(0, 3).some((c) => /LKPR|Ruzy|prague/i.test(`${c.airport_key} ${c.airport_name}`)),
    n_modeled_positive:
      !!r1 && r1.n_modeled_per_day > 0,
    touchdown_ge_corridor:
      !!ruzyne && !!corridor3 &&
      Number.isFinite(ruzyne.aircraft_lden) && Number.isFinite(corridor3.aircraft_lden) &&
      ruzyne.aircraft_lden >= corridor3.aircraft_lden,
    gradient_monotonic:
      !!ruzyne && !!corridor1 && !!corridor3 &&
      Number.isFinite(ruzyne.aircraft_lden) && Number.isFinite(corridor1.aircraft_lden) && Number.isFinite(corridor3.aircraft_lden) &&
      ruzyne.aircraft_lden >= corridor1.aircraft_lden &&
      corridor1.aircraft_lden >= corridor3.aircraft_lden,
  };
  const componentPass = Object.values(componentChecks).every(Boolean);

  // CSV output
  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
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
    writeFileSync(args.output, [header, ...csvRows].join('\n') + '\n');
  }

  // Summary
  console.log('=== Gate A — Isobar ===');
  for (const r of isobar) {
    console.log(
      `  L${r.level} n=${r.n} mean|err|=${r.mean_abs.toFixed(2)} p95=${r.p95.toFixed(2)} bias=${r.bias.toFixed(2)} ${r.ok ? 'OK' : 'FAIL'}`
    );
  }
  console.log(`  ${isobarPass ? 'PASS' : 'FAIL'}`);
  console.log();
  console.log('=== Gate B — Monotonic ordering ===');
  console.log(`  pair violations: ${(violRatio * 100).toFixed(1)} % (limit 10 %)`);
  console.log(`  Spearman rho:    ${rho.toFixed(3)} (limit ≥ 0.7)`);
  console.log(`  ${monotonicPass ? 'PASS' : 'FAIL'}`);
  console.log();
  console.log('=== Gate C — Component ===');
  for (const [k, v] of Object.entries(componentChecks)) {
    console.log(`  ${k}: ${v ? 'OK' : 'FAIL'}`);
  }
  console.log(`  ${componentPass ? 'PASS' : 'FAIL'}`);
  console.log();
  const overall = isobarPass && monotonicPass && componentPass;
  console.log(overall ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  exit(overall ? 0 : 1);
}

main().catch((e) => {
  console.error('fatal:', e);
  exit(1);
});
