// tools/verify-solar.mjs
//
// Validate web/solar.js against independent expectations:
//   1. planets     -> compare with astronomy-engine (VSOP87)
//   2. dwarf/asteroid -> heliocentric distance must stay within a(1-e) .. a(1+e)
//   3. comets      -> at the tabulated time of perihelion the distance must equal q
//   4. hyperbolic comets -> position must stay finite
//
// Usage: node tools/verify-solar.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// solar.js is an ES module but lives next to the page as .js, so hand Node a .mjs copy
const solarSrc = fs.readFileSync(path.join(ROOT, 'web', 'solar.js'), 'utf8');
const tmp = path.join(os.tmpdir(), `solar-verify-${Date.now()}.mjs`);
fs.writeFileSync(tmp, solarSrc, 'utf8');
const solar = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);

const AE = path.join(ROOT, 'data', 'raw', 'extracted', 'astronomy-engine-2.1.19', 'package', 'esm', 'astronomy.js');
const Astronomy = await import(pathToFileURL(AE).href);

const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'solar-system.json'), 'utf8'));
const AU_KM = 149597870.7;

const DATES = ['1900-01-01T00:00:00Z', '2000-01-01T12:00:00Z', '2026-10-16T12:00:00Z', '2050-12-31T00:00:00Z'];
let fails = 0;

// ---------------------------------------------------------------------------
console.log('=== 1. planets: solar.js  vs  astronomy-engine (VSOP87) ===');
let worst = 0, worstWhat = '';
for (const iso of DATES) {
  const ms = Date.parse(iso);
  const row = [];
  for (const b of doc.bodies.filter((x) => x.kind === 'planet' || x.kind === 'dwarf' && x.engine)) {
    if (!b.engine || !b.elements) continue;
    const aeName = { sol: 'Sun', lun: 'Moon', mer: 'Mercury', ven: 'Venus', ter: 'Earth', mar: 'Mars',
                     jup: 'Jupiter', sat: 'Saturn', ura: 'Uranus', nep: 'Neptune', plu: 'Pluto' }[b.engine];
    if (!aeName || aeName === 'Sun' || aeName === 'Moon') continue;
    const mine = solar.positionOf(b, ms);
    const ref = Astronomy.HelioVector(Astronomy.Body[aeName], Astronomy.MakeTime(new Date(ms)));
    const d = Math.hypot(mine.x - ref.x, mine.y - ref.y, mine.z - ref.z);
    if (d > worst) { worst = d; worstWhat = `${b.name} @ ${iso}`; }
    row.push(`${b.zh}=${d.toFixed(5)}`);
  }
  console.log(`  ${iso}  ${row.join('  ')}`);
}
console.log(`  worst: ${worst.toFixed(5)} AU (${(worst * AU_KM).toFixed(0)} km)  [${worstWhat}]`);
if (worst > 0.05) { console.log('  ** FAIL: worse than 0.05 AU **'); fails++; }
else console.log('  OK (all planets agree with VSOP87 to better than 0.05 AU)');

// ---------------------------------------------------------------------------
console.log('\n=== 2. dwarf planets / asteroids: distance must stay in [a(1-e), a(1+e)] ===');
for (const b of doc.bodies.filter((x) => x.elem === 'osc')) {
  const { a, e } = b.elements;
  let min = Infinity, max = -Infinity;
  for (let yr = 1900; yr <= 2050; yr += 5) {
    const p = solar.positionOf(b, Date.UTC(yr, 0, 1));
    const r = Math.hypot(p.x, p.y, p.z);
    min = Math.min(min, r); max = Math.max(max, r);
  }
  const lo = a * (1 - e), hi = a * (1 + e);
  const ok = min >= lo - 0.02 && max <= hi + 0.02;
  if (!ok) fails++;
  console.log(`  ${(b.zh || b.name).padEnd(10)} r=${min.toFixed(3)}..${max.toFixed(3)} AU   expected ${lo.toFixed(3)}..${hi.toFixed(3)}   ${ok ? 'OK' : '** FAIL **'}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. comets: distance at time of perihelion must equal q ===');
for (const b of doc.bodies.filter((x) => x.elem === 'comet').slice(0, 12)) {
  const q = b.elements.q;
  const tp = solar.parseTp(b.Tp);
  const p = solar.positionOf(b, tp);
  const r = Math.hypot(p.x, p.y, p.z);
  const d = Math.abs(r - q);
  const ok = d < 0.002;
  if (!ok) fails++;
  console.log(`  ${b.name.slice(0, 34).padEnd(36)} |r(Tp)|=${r.toFixed(4)}  q=${q.toFixed(4)}  Δ=${d.toExponential(1)}  ${ok ? 'OK' : '** FAIL **'}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. hyperbolic / interstellar comets stay finite ===');
for (const b of doc.bodies.filter((x) => x.elem === 'comet' && x.elements.e >= 1)) {
  let bad = 0;
  for (let yr = 1990; yr <= 2040; yr += 10) {
    const p = solar.positionOf(b, Date.UTC(yr, 0, 1));
    if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) bad++;
  }
  if (bad) fails++;
  const p = solar.positionOf(b, Date.parse('2026-10-16T00:00:00Z'));
  const r = Math.hypot(p.x, p.y, p.z);
  console.log(`  ${b.name.slice(0, 34).padEnd(36)} e=${b.elements.e.toFixed(3)}  r(2026)=${r.toFixed(2)} AU  ${bad ? '** FAIL (NaN) **' : 'OK'}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. known geometry sanity checks ===');
const earth = doc.bodies.find((b) => b.id === 'ter');
const mars = doc.bodies.find((b) => b.id === 'mar');
const p = solar.positionOf(earth, Date.parse('2026-10-16T00:00:00Z'));
const rE = Math.hypot(p.x, p.y, p.z);
console.log(`  Earth heliocentric distance now: ${rE.toFixed(4)} AU  (must be 0.983 .. 1.017)`);
if (rE < 0.98 || rE > 1.02) fails++;

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
