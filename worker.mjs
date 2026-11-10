// worker.mjs — deux passes : statistiques légères (64 px) puis décodage à la taille finale.
// Cette séparation permet une tuile de 150 px (impression 300 dpi) sur 5 000 photos
// sans garder 5 000 fragments en mémoire.
import { tileStats, cellStats, solve } from './mosaic-core.mjs';

self.onmessage = async (ev) => {
  if (ev.data && ev.data.cmd === 'export') {
    const { type, quality } = ev.data;
    const canvas = self.__canvas;
    if (!canvas) { self.postMessage({ phase: 'exportError', message: 'aucun rendu en mémoire' }); return; }
    try {
      const blob = await canvas.convertToBlob({ type: type === 'jpeg' ? 'image/jpeg' : 'image/png', quality });
      const buf = await blob.arrayBuffer();
      self.postMessage({ phase: 'exported', type: type === 'jpeg' ? 'jpeg' : 'png', data: buf }, [buf]);
    } catch (e) {
      self.postMessage({ phase: 'exportError', message: e.message });
    }
    return;
  }
  const { files, targetPixels, tilePx, cols, rows, unique, strength, blend } = ev.data;
  const post = (o, tr) => self.postMessage(o, tr || []);
  const W = cols * tilePx, H = rows * tilePx;

  const statPx = Math.min(64, tilePx);
  const sc = new OffscreenCanvas(statPx, statPx);
  const sctx = sc.getContext('2d', { willReadFrequently: true });

  /* ---- passe 1 : moyennes et écarts-types de chaque photo, en petit ---- */
  const means = new Float32Array(files.length * 3);
  const stds = new Float32Array(files.length * 3);
  const valid = new Uint8Array(files.length);
  let kept = 0, failed = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      const bmp = await createImageBitmap(files[i], { resizeWidth: statPx, resizeHeight: statPx, resizeQuality: 'medium' });
      sctx.clearRect(0, 0, statPx, statPx);
      sctx.drawImage(bmp, 0, 0, statPx, statPx);
      const d = sctx.getImageData(0, 0, statPx, statPx).data;
      const st = tileStats(d, statPx);
      means[i * 3] = st.mean[0]; means[i * 3 + 1] = st.mean[1]; means[i * 3 + 2] = st.mean[2];
      stds[i * 3] = st.std[0]; stds[i * 3 + 1] = st.std[1]; stds[i * 3 + 2] = st.std[2];
      valid[i] = 1; kept++; bmp.close();
    } catch (e) { failed++; }
    if (i % 20 === 0 || i === files.length - 1) {
      post({ phase: 'decode', done: i + 1, total: files.length, kept, failed });
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (!kept) { post({ phase: 'error', message: 'Aucune photo lisible dans la sélection.' }); return; }

  // pool compact (photos valides seulement) pour l'appariement
  const idxMap = [];
  const pool = new Float32Array(kept * 3);
  for (let i = 0, k = 0; i < files.length; i++) {
    if (!valid[i]) continue;
    idxMap.push(i);
    pool[k * 3] = means[i * 3]; pool[k * 3 + 1] = means[i * 3 + 1]; pool[k * 3 + 2] = means[i * 3 + 2];
    k++;
  }

  const cells = cellStats(targetPixels, W, tilePx, cols, rows);
  post({ phase: 'solve', done: 0, total: 1 });
  const sol = solve(cells.mean, pool, { unique: !!unique });

  /* ---- passe 2 : décodage à la taille d'impression, une photo à la fois ---- */
  const out = new Uint8ClampedArray(W * H * 4);
  const jobs = new Map();                       // index photo -> cases à remplir
  for (let ci = 0; ci < cols * rows; ci++) {
    const j = sol.picks[ci];
    if (!jobs.has(j)) jobs.set(j, []);
    jobs.get(j).push(ci);
  }
  const big = new OffscreenCanvas(tilePx, tilePx);
  const bctx = big.getContext('2d', { willReadFrequently: true });
  let doneJobs = 0;
  for (const [j, list] of jobs) {
    const fileIndex = idxMap[j];
    let px = null;
    try {
      const bmp = await createImageBitmap(files[fileIndex], { resizeWidth: tilePx, resizeHeight: tilePx, resizeQuality: 'high' });
      bctx.clearRect(0, 0, tilePx, tilePx);
      bctx.drawImage(bmp, 0, 0, tilePx, tilePx);
      px = bctx.getImageData(0, 0, tilePx, tilePx).data;
      bmp.close();
    } catch (e) { px = null; }

    for (const ci of list) {
      const cx = ci % cols, cy = (ci / cols) | 0;
      const k = ci * 3;
      if (!px) {                              // photo illisible : on laisse du noir, compté comme manquant
        continue;
      }
      const pm = [means[fileIndex * 3], means[fileIndex * 3 + 1], means[fileIndex * 3 + 2]];
      const ps = [stds[fileIndex * 3], stds[fileIndex * 3 + 1], stds[fileIndex * 3 + 2]];
      for (let y = 0; y < tilePx; y++) {
        let so = y * tilePx * 4;
        let d0 = ((cy * tilePx + y) * W + cx * tilePx) * 4;
        for (let x = 0; x < tilePx; x++, so += 4, d0 += 4) {
          for (let c = 0; c < 3; c++) {
            const raw = px[so + c] / 255;
            let adj = ((raw - pm[c]) / (ps[c] + 1e-3)) * cells.std[k + c] * strength + cells.mean[k + c];
            adj = adj < 0 ? 0 : adj > 1 ? 1 : adj;
            out[d0 + c] = (blend * raw + (1 - blend) * adj) * 255;
          }
          out[d0 + 3] = 255;
        }
      }
    }
    doneJobs++;
    if (doneJobs % 10 === 0 || doneJobs === jobs.size) {
      post({ phase: 'compose', done: Math.min(100, Math.round((doneJobs / jobs.size) * 100)),
             total: 100, photos: jobs.size });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /* ---- rendu final : le canvas reste dans le worker, la page ne reçoit qu'un aperçu ---- */
  post({ phase: 'encode', done: 0, total: 1 });
  const full = new OffscreenCanvas(W, H);
  const fctx = full.getContext('2d');
  fctx.putImageData(new ImageData(out, W, H), 0, 0);
  self.__canvas = full;

  const pw = Math.min(1100, W), ph = Math.max(1, Math.round(H * pw / W));
  const pv = new OffscreenCanvas(pw, ph);
  const pctx = pv.getContext('2d');
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(full, 0, 0, pw, ph);
  const preview = pv.transferToImageBitmap();

  post({
    phase: 'done', width: W, height: H, previewW: pw, previewH: ph,
    distinct: sol.distinct, reused: sol.reused, kept, failed, cells: cols * rows,
    preview,
  }, [preview]);
};
