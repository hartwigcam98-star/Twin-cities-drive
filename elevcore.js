// Ground elevation for one map tile from the USGS 3D Elevation Program (bare-earth DEM built from Minnesota's
// statewide lidar), shared by the browser and the GitHub tile-baking job. Narrow cuts and embankments (freeway
// trenches, gaps where bridges were removed) are filtered out — the road solver models those itself — and slopes are
// limited to ~16% so river bluffs stay drivable.
// → { v, n, s, w, nLat, eLon, h: [n*n decimetres above sea level, rows south→north, columns west→east] }
export const S0 = 44.72, W0 = -93.556, TLAT = 0.02, TLON = 0.028;
const N = 129, MLAT = 0.0024, MLON = 0.0034, PX = 280;
const SRC = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';

export function elevBox(tx, ty) {
  const s = S0 + ty * TLAT, w = W0 + tx * TLON, n = s + TLAT, e = w + TLON;
  return { s, w, n, e, bs: s - MLAT, bw: w - MLON, bn: n + MLAT, be: e + MLON };
}
export function elevUrl(tx, ty) {
  const { bs, bw, bn, be } = elevBox(tx, ty);
  return `${SRC}?bbox=${bw},${bs},${be},${bn}&bboxSR=4326&imageSR=4326&size=${PX},${PX}&format=bsq&pixelType=F32&noData=-9999&interpolation=RSP_BilinearInterpolation&f=image`;
}
// buf: the raw ArrayBuffer returned by elevUrl()
export function processElev(tx, ty, buf) {
  if (buf.byteLength < PX * PX * 4) throw new Error('3dep short ' + buf.byteLength);
  const { s, w, n, e, bs, bw, bn, be } = elevBox(tx, ty);
  const raw = new Float32Array(buf.slice(0, PX * PX * 4)); // rows north → south
  let sum = 0, cnt = 0;
  for (const v of raw) if (v > -1000 && v < 2000) { sum += v; cnt++; }
  if (!cnt) throw new Error('3dep empty');
  const mean = sum / cnt, g = new Float32Array(PX * PX);
  for (let i = 0; i < g.length; i++) g[i] = raw[i] > -1000 && raw[i] < 2000 ? raw[i] : mean;
  // 1) 7×7 median (~70 m): removes cuts, embankments and bridge gaps narrower than that
  const med = new Float32Array(PX * PX), win = new Float32Array(49), R = 3;
  for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) {
    let k = 0;
    for (let j = -R; j <= R; j++) { const yy = Math.min(PX - 1, Math.max(0, y + j)); for (let i = -R; i <= R; i++) win[k++] = g[yy * PX + Math.min(PX - 1, Math.max(0, x + i))]; }
    win.sort(); med[y * PX + x] = win[24];
  }
  // 2) gaussian blur (σ ≈ 30 m)
  const sig = 3, KR = 9, ker = []; let ks = 0;
  for (let i = -KR; i <= KR; i++) { const v = Math.exp(-(i * i) / (2 * sig * sig)); ker.push(v); ks += v; }
  for (let i = 0; i < ker.length; i++) ker[i] /= ks;
  const tmp = new Float32Array(PX * PX), out = new Float32Array(PX * PX);
  for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) { let a = 0; for (let i = -KR; i <= KR; i++) a += ker[i + KR] * med[y * PX + Math.min(PX - 1, Math.max(0, x + i))]; tmp[y * PX + x] = a; }
  for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) { let a = 0; for (let i = -KR; i <= KR; i++) a += ker[i + KR] * tmp[Math.min(PX - 1, Math.max(0, y + i)) * PX + x]; out[y * PX + x] = a; }
  // 3) slope limit (~16%): mean of the cut surface and the fill surface
  {
    const G = 0.16, lat = (bn + bs) / 2;
    const mx = (be - bw) * 111320 * Math.cos(lat * Math.PI / 180) / PX, my = (bn - bs) * 111320 / PX, md = Math.hypot(mx, my);
    const cut = Float32Array.from(out), fill = Float32Array.from(out);
    const nb = [[-1, 0, mx], [-1, -1, md], [0, -1, my], [1, -1, md]];
    for (let round = 0; round < 3; round++) for (const dirn of [1, -1]) {
      const y0 = dirn > 0 ? 0 : PX - 1, y1 = dirn > 0 ? PX : -1, x0 = dirn > 0 ? 0 : PX - 1, x1 = dirn > 0 ? PX : -1;
      for (let y = y0; y !== y1; y += dirn) for (let x = x0; x !== x1; x += dirn) {
        const i = y * PX + x;
        for (const [ddx, ddy, d] of nb) {
          const xx = x + ddx * dirn, yy = y + ddy * dirn; if (xx < 0 || yy < 0 || xx >= PX || yy >= PX) continue;
          const j = yy * PX + xx, st = G * d;
          if (cut[j] + st < cut[i]) cut[i] = cut[j] + st;
          if (fill[j] - st > fill[i]) fill[i] = fill[j] - st;
        }
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = (cut[i] + fill[i]) / 2;
  }
  // 4) resample onto the tile's N×N grid (south → north rows)
  const h = new Array(N * N);
  for (let r = 0; r < N; r++) {
    const lat = s + (r / (N - 1)) * TLAT, fy = (bn - lat) / (bn - bs) * PX - 0.5;
    for (let c = 0; c < N; c++) {
      const lon = w + (c / (N - 1)) * TLON, fx = (lon - bw) / (be - bw) * PX - 0.5;
      const x0 = Math.max(0, Math.min(PX - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(PX - 2, Math.floor(fy)));
      const u = Math.min(1, Math.max(0, fx - x0)), v = Math.min(1, Math.max(0, fy - y0));
      const a = out[y0 * PX + x0], b = out[y0 * PX + x0 + 1], c2 = out[(y0 + 1) * PX + x0], d = out[(y0 + 1) * PX + x0 + 1];
      h[r * N + c] = Math.round(((a * (1 - u) + b * u) * (1 - v) + (c2 * (1 - u) + d * u) * v) * 10);
    }
  }
  return { v: 2, n: N, s, w, nLat: n, eLon: e, h };
}
