// tools/verify-planets.mjs
//
// Cross-check the project's own Kepler propagation (built from the NASA/JPL
// "Approximate Positions of the Planets" elements that ship inside d3-celestial's
// planets.json) against astronomy-engine, which uses VSOP87 + JPL long-term theory.
//
// If the two agree to a small fraction of an AU, then the elements and the
// propagator are both sound and the web app can use them for the dwarf planets
// and comets that astronomy-engine does not cover.
//
// Usage: node tools/verify-planets.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AE = path.join(ROOT, 'data', 'raw', 'extracted', 'astronomy-engine-2.1.19', 'package', 'esm', 'astronomy.js');
const PLANETS = path.join(ROOT, 'data', 'raw', 'extracted', 'd3-celestial-0.7.35', 'package', 'data', 'planets.json');

const Astronomy = await import(pathToFileURL(AE).href);
const { Body, MakeTime, HelioVector, HelioDistance } = Astronomy;

const planets = JSON.parse(fs.readFileSync(PLANETS, 'utf8'));

const D2R = Math.PI / 180;
const OBLIQUITY = 23.4392911 * D2R;   // J2000 mean obliquity

// JPL elements are "for the epoch 2000.0" and are linear in T (centuries past J2000)
const AE_NAME = {
  mer: Body.Mercury, ven: Body.Venus, ter: Body.Earth, mar: Body.Mars,
  jup: Body.Jupiter, sat: Body.Saturn, ura: Body.Uranus, nep: Body.Neptune, plu: Body.Pluto,
};

/** Solve Kepler's equation and return the heliocentric ecliptic-J2000 position in AU. */
function keplerFromJpl(el, T) {
  const a = el.a + el.da * T;
  const e = el.e + el.de * T;
  const I = (el.i + el.di * T) * D2R;
  const L = (el.L + el.dL * T) * D2R;
  const W = (el.W + el.dW * T) * D2R;
  const N = (el.N + el.dN * T) * D2R;
  const w = W - N;

  let M = L - W;
  M = Math.atan2(Math.sin(M), Math.cos(M));          // normalise to [-pi, pi]

  let E = M + e * Math.sin(M);
  for (let k = 0; k < 60; k++) {
    const dM = M - (E - e * Math.sin(E));
    const dE = dM / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);

  const cw = Math.cos(w), sw = Math.sin(w), cN = Math.cos(N), sN = Math.sin(N);
  const cI = Math.cos(I), sI = Math.sin(I);

  // ecliptic J2000
  const x = (cw * cN - sw * sN * cI) * xp + (-sw * cN - cw * sN * cI) * yp;
  const y = (cw * sN + sw * cN * cI) * xp + (-sw * sN + cw * cN * cI) * yp;
  const z = (sw * sI) * xp + (cw * sI) * yp;

  // rotate ecliptic -> equatorial J2000 so it can be compared with astronomy-engine
  const ye = y * Math.cos(OBLIQUITY) - z * Math.sin(OBLIQUITY);
  const ze = y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY);
  return { x, y: ye, z: ze, a, e, M };
}

const DATES = [
  '2026-01-01T00:00:00Z',
  '2026-10-16T12:00:00Z',
  '2000-01-01T12:00:00Z',
  '2050-06-15T00:00:00Z',
  '1900-03-01T00:00:00Z',
];

console.log('element source: d3-celestial planets.json (NASA/JPL approximate elements)');
console.log('reference     : astronomy-engine 2.1.19 (VSOP87 + JPL)\n');

const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
let worst = 0;
let worstWhat = '';

for (const iso of DATES) {
  const date = new Date(iso);
  const T = (date.getTime() - J2000) / (36525 * 86400000);
  console.log(`--- ${iso}   (T = ${T.toFixed(4)} centuries)`);
  for (const [key, body] of Object.entries(AE_NAME)) {
    if (key === 'ter') continue;              // Earth == -EMB; skip, same method applies
    const el = planets[key].elements[0];
    const mine = keplerFromJpl(el, T);
    const ref = HelioVector(body, MakeTime(date));
    const d = Math.hypot(mine.x - ref.x, mine.y - ref.y, mine.z - ref.z);
    const rMine = Math.hypot(mine.x, mine.y, mine.z);
    const rRef = HelioDistance(body, date);
    if (d > worst) { worst = d; worstWhat = `${planets[key].name} @ ${iso}`; }
    console.log(
      `  ${planets[key].name.padEnd(9)} |mine|=${rMine.toFixed(5)}  |ref|=${rRef.toFixed(5)}  ` +
      `|Δ|=${d.toFixed(6)} AU  (${(d * 149597870.7).toFixed(0)} km)`
    );
  }
}

console.log(`\nlargest disagreement: ${worst.toFixed(6)} AU = ${(worst * 149597870.7).toFixed(0)} km  (${worstWhat})`);
console.log('for scale, Earth is 1 AU from the Sun and is 12742 km across');
