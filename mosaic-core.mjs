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
