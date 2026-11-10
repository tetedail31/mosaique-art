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

/* 9. export impression : résolution inscrite dans le fichier */
import { crc32, pngWithDpi, jpegWithDpi, readPngDpi } from '../mosaic-core.mjs';
import zlib from 'node:zlib';

ok('crc32 de référence (0xCBF43926)', crc32(new TextEncoder().encode('123456789')) === 0xCBF43926);

function makePng(withPhys) {
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const raw = Buffer.alloc(4 * 3, 0);            // 1 ligne, 3 octets par pixel + filtre
  for (let i = 0; i < raw.length; i++) raw[i] = i % 4 === 0 ? 0 : 200;
  const mk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const body = Buffer.concat([t, Buffer.from(data)]);
    const b = Buffer.alloc(4); b.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body));
    return Buffer.concat([b, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [sig, mk('IHDR', ihdr)];
  if (withPhys) {
    const ph = Buffer.alloc(9); ph.writeUInt32BE(2835, 0); ph.writeUInt32BE(2835, 4); ph[8] = 1;
    parts.push(mk('pHYs', ph));
  }
  parts.push(mk('IDAT', zlib.deflateSync(raw)), mk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(parts));
}

const base = makePng(false);
const tagged = pngWithDpi(base, 300);
near(readPngDpi(tagged), 300, 0.5, 'PNG 300 dpi relu');
ok('PNG reste valide (IEND présent)', String.fromCharCode(...tagged.slice(-8, -4)) === 'IEND');
ok('un seul pHYs', tagged.length && (() => {
  let n = 0, p = 8;
  while (p < tagged.length) {
    const len = (tagged[p] << 24 | tagged[p + 1] << 16 | tagged[p + 2] << 8 | tagged[p + 3]) >>> 0;
    if (String.fromCharCode(tagged[p + 4], tagged[p + 5], tagged[p + 6], tagged[p + 7]) === 'pHYs') n++;
    p += 12 + len;
  }
  return n;
})() === 1);
const retagged = pngWithDpi(pngWithDpi(base, 300), 240);
near(readPngDpi(retagged), 240, 0.5, 'PNG repassé à 240 dpi sans doublon');

function makeJpeg(withApp0) {
  const soi = Uint8Array.from([0xFF, 0xD8]);
  const app0 = Uint8Array.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);     // unités = 0, densité 1
  const sos = Uint8Array.from([0xFF, 0xDA, 0x00, 0x08, 1, 2, 3, 4, 5, 6]);
  const eoi = Uint8Array.from([0xFF, 0xD9]);
  return new Uint8Array([...(withApp0 ? [...soi, ...app0] : [...soi]), ...sos, ...eoi]);
}

const j1 = jpegWithDpi(makeJpeg(true), 300);
ok('JPEG : unités = dpi', j1[13] === 1);
ok('JPEG : densité X = 300', (j1[14] << 8 | j1[15]) === 300);
ok('JPEG : densité Y = 300', (j1[16] << 8 | j1[17]) === 300);
const j2 = jpegWithDpi(makeJpeg(false), 240);
ok('JPEG sans APP0 : en-tête inséré', j2[2] === 0xFF && j2[3] === 0xE0);
ok('JPEG sans APP0 : densité X = 240', (j2[14] << 8 | j2[15]) === 240);
ok('JPEG : SOS préservé', j2.includes(0xDA));

/* 10. encodeur PNG autonome (impression sans canvas) */
import { encodePng } from '../mosaic-core.mjs';

const W3 = 3, H2 = 2;
const rgba = new Uint8Array(W3 * H2 * 4);
for (let i = 0; i < W3 * H2; i++) {
  rgba[i * 4] = (i * 40) & 255; rgba[i * 4 + 1] = (255 - i * 30) & 255;
  rgba[i * 4 + 2] = (i * 11) & 255; rgba[i * 4 + 3] = 255;
}
const encoded = await encodePng(rgba, W3, H2, 300);
ok('PNG encodeur : signature', encoded[0] === 137 && encoded[1] === 80);
near(readPngDpi(encoded), 300, 0.5, 'PNG encodeur : 300 dpi déclarés');

// structure + dimensions + retour des pixels
let q = 8, idat = null, dims = null;
while (q < encoded.length) {
  const len = (encoded[q] << 24 | encoded[q + 1] << 16 | encoded[q + 2] << 8 | encoded[q + 3]) >>> 0;
  const t = String.fromCharCode(encoded[q + 4], encoded[q + 5], encoded[q + 6], encoded[q + 7]);
  if (t === 'IHDR') dims = [(encoded[q + 8] << 24 | encoded[q + 9] << 16 | encoded[q + 10] << 8 | encoded[q + 11]) >>> 0,
                            (encoded[q + 12] << 24 | encoded[q + 13] << 16 | encoded[q + 14] << 8 | encoded[q + 15]) >>> 0];
  if (t === 'IDAT') idat = encoded.subarray(q + 8, q + 8 + len);
  q += 12 + len;
}
ok('PNG encodeur : dimensions 3x2', dims && dims[0] === 3 && dims[1] === 2);
const raw = zlib.inflateSync(Buffer.from(idat));
ok('PNG encodeur : taille des scanlines', raw.length === H2 * (W3 * 4 + 1));
ok('PNG encodeur : filtre Up', raw[0] === 2 && raw[W3 * 4 + 1] === 2);
let firstRowOk = true;
for (let i = 0; i < W3 * 4; i++) if (raw[1 + i] !== rgba[i]) firstRowOk = false;
ok('PNG encodeur : première ligne identique', firstRowOk);
let upOk = true;
for (let y = 1; y < H2; y++) {
  for (let i = 0; i < W3 * 4; i++) {
    const expected = (rgba[y * W3 * 4 + i] - rgba[(y - 1) * W3 * 4 + i]) & 0xFF;
    if (raw[y * (W3 * 4 + 1) + 1 + i] !== expected) upOk = false;
  }
}
ok('PNG encodeur : filtre Up réversible', upOk);

console.log(`\n${pass} assertions passées`);