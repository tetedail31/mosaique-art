// worker.mjs — décodage des photos + assemblage, hors du thread d'affichage.
import { tileStats, cellStats, solve, compose } from './mosaic-core.mjs';

self.onmessage = async (ev) => {
  const { files, targetPixels, targetW, tilePx, cols, rows, unique, strength, blend } = ev.data;
  const post = (o, tr) => self.postMessage(o, tr || []);

  const canvas = new OffscreenCanvas(tilePx, tilePx);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const tiles = [], means = [], stds = [];
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      const bmp = await createImageBitmap(files[i], {
        resizeWidth: tilePx, resizeHeight: tilePx, resizeQuality: 'medium',
      });
      ctx.clearRect(0, 0, tilePx, tilePx);
      ctx.drawImage(bmp, 0, 0, tilePx, tilePx);
      const d = ctx.getImageData(0, 0, tilePx, tilePx);
      const st = tileStats(d.data, tilePx);
      tiles.push(new Uint8ClampedArray(d.data));
      means.push(st.mean); stds.push(st.std);
      bmp.close();
    } catch (e) {
      failed++;
    }
    if (i % 20 === 0 || i === files.length - 1) {
      post({ phase: 'decode', done: i + 1, total: files.length, kept: tiles.length, failed });
      await new Promise((r) => setTimeout(r, 0)); // laisse respirer le worker
    }
  }
  if (!tiles.length) { post({ phase: 'error', message: 'Aucune photo lisible dans la sélection.' }); return; }

  const poolMeans = new Float32Array(tiles.length * 3);
  for (let j = 0; j < tiles.length; j++) {
    poolMeans[j * 3] = means[j][0]; poolMeans[j * 3 + 1] = means[j][1]; poolMeans[j * 3 + 2] = means[j][2];
  }
  const cells = cellStats(targetPixels, cols * tilePx, tilePx, cols, rows);
  post({ phase: 'solve', done: 0, total: 1 });
  const sol = solve(cells.mean, poolMeans, { unique: !!unique });
  post({ phase: 'compose', done: 0, total: 1 });
  const out = compose(tiles, means, stds, sol.picks, cells.mean, cells.std, tilePx, cols, rows,
    { strength, blend });

  post({
    phase: 'done', data: out.data.buffer, width: out.width, height: out.height,
    picks: sol.picks.buffer, distinct: sol.distinct, reused: sol.reused,
    kept: tiles.length, failed, cells: cols * rows,
  }, [out.data.buffer, sol.picks.buffer]);
};
