// mosaic-core.mjs — calcul pur (aucun DOM), testable sous Node.
// Convention couleur : sRGB 0..1 en entrée, CIELAB (D65) pour l'appariement.

export function srgbToLab(r, g, b) {
  const lin = (c) => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92);
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Statistiques d'un fragment RGBA (tilePx*tilePx*4) : {mean:[3], std:[3]} en 0..1. */
export function tileStats(px, tilePx) {
  const n = tilePx * tilePx;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n; i++) { r += px[i * 4]; g += px[i * 4 + 1]; b += px[i * 4 + 2]; }
  const mr = r / n / 255, mg = g / n / 255, mb = b / n / 255;
  let vr = 0, vg = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const dr = px[i * 4] / 255 - mr, dg = px[i * 4 + 1] / 255 - mg, db = px[i * 4 + 2] / 255 - mb;
    vr += dr * dr; vg += dg * dg; vb += db * db;
  }
  return { mean: [mr, mg, mb], std: [Math.sqrt(vr / n), Math.sqrt(vg / n), Math.sqrt(vb / n)] };
}

/** Moyennes et écarts-types par case de la cible. pixels RGBA de (cols*tilePx) x (rows*tilePx). */
export function cellStats(pixels, width, tilePx, cols, rows) {
  const mean = new Float32Array(cols * rows * 3);
  const std = new Float32Array(cols * rows * 3);
  const n = tilePx * tilePx;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let r = 0, g = 0, b = 0;
      for (let y = 0; y < tilePx; y++) {
        let o = ((cy * tilePx + y) * width + cx * tilePx) * 4;
        for (let x = 0; x < tilePx; x++, o += 4) { r += pixels[o]; g += pixels[o + 1]; b += pixels[o + 2]; }
      }
      const mr = r / n / 255, mg = g / n / 255, mb = b / n / 255;
      let vr = 0, vg = 0, vb = 0;
      for (let y = 0; y < tilePx; y++) {
        let o = ((cy * tilePx + y) * width + cx * tilePx) * 4;
        for (let x = 0; x < tilePx; x++, o += 4) {
          const dr = pixels[o] / 255 - mr, dg = pixels[o + 1] / 255 - mg, db = pixels[o + 2] / 255 - mb;
          vr += dr * dr; vg += dg * dg; vb += db * db;
        }
      }
      const k = (cy * cols + cx) * 3;
      mean[k] = mr; mean[k + 1] = mg; mean[k + 2] = mb;
      std[k] = Math.sqrt(vr / n); std[k + 1] = Math.sqrt(vg / n); std[k + 2] = Math.sqrt(vb / n);
    }
  }
  return { mean, std };
}

/**
 * Choisit un fragment par case. Retourne {picks, distinct, reused}.
 * targets : Float32Array cells*3 (moyennes RGB) ; pool : Float32Array n*3.
 */
export function solve(targets, pool, opts = {}) {
  const unique = opts.unique !== false;
  const wA = opts.chroma ?? 1.35;
  const cells = (targets.length / 3) | 0;
  const n = (pool.length / 3) | 0;
  if (!n) throw new Error('pool vide');
  const tl = new Float32Array(cells * 3), pl = new Float32Array(n * 3);
  for (let i = 0; i < cells; i++) {
    const v = srgbToLab(targets[i * 3], targets[i * 3 + 1], targets[i * 3 + 2]);
    tl[i * 3] = v[0]; tl[i * 3 + 1] = v[1]; tl[i * 3 + 2] = v[2];
  }
  for (let j = 0; j < n; j++) {
    const v = srgbToLab(pool[j * 3], pool[j * 3 + 1], pool[j * 3 + 2]);
    pl[j * 3] = v[0]; pl[j * 3 + 1] = v[1]; pl[j * 3 + 2] = v[2];
  }
  const used = new Uint8Array(n);
  const picks = new Int32Array(cells).fill(-1);
  const order = new Int32Array(cells);
  for (let i = 0; i < cells; i++) order[i] = i;
  let s = (opts.seed ?? 7) >>> 0;
  for (let i = cells - 1; i > 0; i--) {
    s = (1664525 * s + 1013904223) >>> 0;
    const k = s % (i + 1);
    const t = order[i]; order[i] = order[k]; order[k] = t;
  }
  let reused = 0;
  for (let oi = 0; oi < cells; oi++) {
    const i = order[oi];
    const L0 = tl[i * 3], A0 = tl[i * 3 + 1], B0 = tl[i * 3 + 2];
    let best = -1, bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (unique && used[j]) continue;
      const dl = pl[j * 3] - L0, da = pl[j * 3 + 1] - A0, db = pl[j * 3 + 2] - B0;
      const d = dl * dl + wA * (da * da + db * db);
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best < 0) { // pool épuisé : réutilisation tolérée, signalée à l'appelant
      reused++;
      for (let j = 0; j < n; j++) {
        const dl = pl[j * 3] - L0, da = pl[j * 3 + 1] - A0, db = pl[j * 3 + 2] - B0;
        const d = dl * dl + wA * (da * da + db * db);
        if (d < bestD) { bestD = d; best = j; }
      }
    }
    used[best] = 1;
    picks[i] = best;
  }
  let distinct = 0;
  for (let j = 0; j < n; j++) distinct += used[j];
  return { picks, distinct, reused };
}

/* ---------- export impression : métadonnées de résolution ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u32(n) {
  return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

function chunk(type, data) {
  const t = new Uint8Array(4);
  for (let i = 0; i < 4; i++) t[i] = type.charCodeAt(i);
  const body = new Uint8Array(4 + data.length);
  body.set(t, 0); body.set(data, 4);
  const crc = crc32(body);
  return Uint8Array.from([...u32(data.length), ...body, ...u32(crc)]);
}

/**
 * Ajoute (ou remplace) à un PNG les chunks pHYs (résolution en pixels par mètre)
 * et sRGB, sans quoi les imprimeurs considèrent le fichier à 72 dpi.
 */
export function pngWithDpi(bytes, dpi) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (src[i] !== sig[i]) throw new Error('pas un PNG');
  const ppu = Math.round(dpi / 0.0254);
  const phys = chunk('pHYs', Uint8Array.from([...u32(ppu), ...u32(ppu), 1]));
  const srgb = chunk('sRGB', Uint8Array.of(0));

  const out = [];
  out.push(src.subarray(0, 8));
  let p = 8;
  let inserted = false;
  while (p < src.length) {
    const len = (src[p] << 24 | src[p + 1] << 16 | src[p + 2] << 8 | src[p + 3]) >>> 0;
    const type = String.fromCharCode(src[p + 4], src[p + 5], src[p + 6], src[p + 7]);
    const end = p + 12 + len;
    if (type === 'pHYs') { p = end; continue; }   // on remplace l'existant
    out.push(src.subarray(p, end));
    if (type === 'IHDR' && !inserted) { out.push(phys, srgb); inserted = true; }
    p = end;
  }
  if (!inserted) throw new Error('IHDR introuvable');
  const total = out.reduce((a, b) => a + b.length, 0);
  const res = new Uint8Array(total);
  let o = 0;
  for (const b of out) { res.set(b, o); o += b.length; }
  return res;
}

/** Force la densité dans l'entête JFIF d'un JPEG (unités = dpi). */
export function jpegWithDpi(bytes, dpi) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (src[0] !== 0xFF || src[1] !== 0xD8) throw new Error('pas un JPEG');
  const res = new Uint8Array(src);
  let p = 2;
  while (p + 4 <= res.length && res[p] === 0xFF) {
    const marker = res[p + 1];
    if (marker === 0xDA || marker === 0xD9) break;      // début des données / fin
    const len = (res[p + 2] << 8) | res[p + 3];
    if (marker === 0xE0) {                               // APP0 JFIF
      res[p + 11] = 1;                                   // unités = points par pouce
      res[p + 12] = (dpi >> 8) & 255; res[p + 13] = dpi & 255;
      res[p + 14] = (dpi >> 8) & 255; res[p + 15] = dpi & 255;
      return res;
    }
    p += 2 + len;
  }
  // pas d'APP0 : on l'insère juste après SOI
  const app0 = Uint8Array.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x01, (dpi >> 8) & 255, dpi & 255, (dpi >> 8) & 255, dpi & 255, 0x00, 0x00]);
  const out = new Uint8Array(src.length + app0.length);
  out.set(src.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(src.subarray(2), 2 + app0.length);
  return out;
}

/** Lit la résolution déclarée d'un PNG (pour les tests et le diagnostic). */
export function readPngDpi(bytes) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let p = 8;
  while (p < src.length) {
    const len = (src[p] << 24 | src[p + 1] << 16 | src[p + 2] << 8 | src[p + 3]) >>> 0;
    const type = String.fromCharCode(src[p + 4], src[p + 5], src[p + 6], src[p + 7]);
    if (type === 'pHYs') {
      const ppu = (src[p + 8] << 24 | src[p + 9] << 16 | src[p + 10] << 8 | src[p + 11]) >>> 0;
      return Math.round(ppu * 0.0254 * 100) / 100;
    }
    p += 12 + len;
  }
  return null;
}

/**
 * Compose le rendu : transfert moyenne/écart-type par case, puis mélange avec le fragment brut.
 * tiles : Array<Uint8ClampedArray(tilePx*tilePx*4)> ; means/stds : Array<[3]> par fragment.
 */
export function compose(tiles, means, stds, picks, cellMean, cellStd, tilePx, cols, rows, opts = {}) {
  const strength = opts.strength ?? 0.9;
  const blend = opts.blend ?? 0.25;
  const width = cols * tilePx;
  const height = rows * tilePx;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let ci = 0; ci < cols * rows; ci++) {
    const cx = ci % cols, cy = (ci / cols) | 0;
    const j = picks[ci];
    const t = tiles[j], pm = means[j], ps = stds[j];
    const k = ci * 3;
    for (let y = 0; y < tilePx; y++) {
      let so = y * tilePx * 4;
      let d0 = ((cy * tilePx + y) * width + cx * tilePx) * 4;
      for (let x = 0; x < tilePx; x++, so += 4, d0 += 4) {
        for (let c = 0; c < 3; c++) {
          const raw = t[so + c] / 255;
          let adj = ((raw - pm[c]) / (ps[c] + 1e-3)) * cellStd[k + c] * strength + cellMean[k + c];
          adj = adj < 0 ? 0 : adj > 1 ? 1 : adj;
          out[d0 + c] = (blend * raw + (1 - blend) * adj) * 255;
        }
        out[d0 + 3] = 255;
      }
    }
  }
  return { data: out, width, height };
}
