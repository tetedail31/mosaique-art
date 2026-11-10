import { srgbToLab, tileStats, cellStats, solve, compose } from '../mosaic-core.mjs';
import assert from 'node:assert/strict';

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log('ok  ', name); };
const near = (a, b, tol, name) => ok(`${name} (${a.toFixed(2)}≈${b})`, Math.abs(a - b) <= tol);

/* 1. conversion LAB */
const white = srgbToLab(1, 1, 1);
near(white[0], 100, 0.5, 'blanc L=100');
near(white[1], 0, 0.5, 'blanc a=0');
near(white[2], 0, 0.5, 'blanc b=0');
const black = srgbToLab(0, 0, 0);
near(black[0], 0, 0.01, 'noir L=0');
ok('rouge a>0', srgbToLab(1, 0, 0)[1] > 50);

/* 2. stats d'un fragment uniforme */
const px = new Uint8ClampedArray(4 * 4 * 4).fill(0);
for (let i = 0; i < 16; i++) { px[i * 4] = 200; px[i * 4 + 1] = 100; px[i * 4 + 2] = 50; px[i * 4 + 3] = 255; }
const st = tileStats(px, 4);
near(st.mean[0], 200 / 255, 0.01, 'moyenne R');
near(st.std[0], 0, 0.001, 'écart-type nul');

/* 3. stats de cases : 4x4 px, tuile 2 -> 2x2 cases */
const img = new Uint8ClampedArray(4 * 4 * 4);
for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
  const o = (y * 4 + x) * 4;
  const v = (x < 2) ? 0 : 255;             // gauche noire, droite blanche
  img[o] = v; img[o + 1] = v; img[o + 2] = v; img[o + 3] = 255;
}
const cs = cellStats(img, 4, 2, 2, 2);
near(cs.mean[0], 0, 0.01, 'case haut-gauche noire');
near(cs.mean[3], 1, 0.01, 'case haut-droite blanche');
near(cs.std[0], 0, 0.001, 'case uniforme sans variance');

/* 4. appariement : chaque case trouve la bonne couleur */
const pool = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]); // rouge, vert, bleu, blanc
const targets = new Float32Array([0, 1, 0, 0, 0, 1]);                // vert puis bleu
const sol = solve(targets, pool, { unique: true });
ok('vert -> index 1', sol.picks[0] === 1);
ok('bleu -> index 2', sol.picks[1] === 2);
ok('2 fragments distincts', sol.distinct === 2);
ok('aucune réutilisation', sol.reused === 0);

/* 5. unicité : deux cases identiques ne prennent pas la même photo */
const same = new Float32Array([0, 1, 0, 0, 1, 0]);
const sol2 = solve(same, pool, { unique: true });
ok('deux cases vertes -> deux index différents', sol2.picks[0] !== sol2.picks[1]);
ok('deux fragments distincts', sol2.distinct === 2);
const sol3 = solve(same, pool, { unique: false });
ok('sans unicité, même fragment possible', sol3.picks[0] === sol3.picks[1]);

/* 6. pool épuisé : réutilisation signalée */
const many = new Float32Array(6 * 3);
for (let i = 0; i < 6; i++) { many[i * 3] = 0.5; many[i * 3 + 1] = 0.5; many[i * 3 + 2] = 0.5; }
const sol4 = solve(many, pool, { unique: true });
ok('6 cases / 4 fragments -> 2 réutilisations', sol4.reused === 2);

/* 7. composition : correction de couleur vers la case */
const tile = new Uint8ClampedArray(4 * 4 * 4).fill(255);
for (let i = 0; i < 16; i++) { tile[i * 4] = 128; tile[i * 4 + 1] = 128; tile[i * 4 + 2] = 128; }
const tstat = tileStats(tile, 4);
const onePick = new Int32Array([0]);
const cm = new Float32Array([0.8, 0.2, 0.2]);
const cstd = new Float32Array([0.1, 0.1, 0.1]);
const res = compose([tile], [tstat.mean], [tstat.std], onePick, cm, cstd, 4, 1, 1,
  { strength: 0.9, blend: 0 });
ok('sortie 4x4', res.width === 4 && res.height === 4);
near(res.data[0] / 255, 0.8, 0.02, 'case rouge : R suit la cible');
near(res.data[1] / 255, 0.2, 0.02, 'case rouge : G suit la cible');
ok('alpha opaque', res.data[3] === 255);

/* 8. pool vide : erreur explicite, pas un plantage silencieux */
let threw = false;
try { solve(new Float32Array([1, 1, 1]), new Float32Array([]), {}); } catch (e) { threw = true; }
ok('pool vide -> erreur', threw);

console.log(`\n${pass} assertions passées`);
