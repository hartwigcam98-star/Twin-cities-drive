// Bakes map tiles into data/ so the site loads instantly without a server:
//   data/r  streets, water, places   data/b  buildings, signals, skyways   data/l  land use
//   data/e  terrain (USGS 3DEP lidar DEM)   data/m  region overview map (4 quadrants)
// Run by .github/workflows/bake.yml; each run fills missing tiles for up to BAKE_MINUTES, nearest downtown first.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { convertTile, overpassQuery, majorQuery, convertMajor, fetchOsmApi, rawToElements, NX, NY } from '../convert.js';
import { elevUrl, processElev } from '../elevcore.js';

const MINUTES = +(process.env.BAKE_MINUTES || 40), KINDS = (process.env.BAKE_KINDS || 'e,r,l,b').split(',');
const t0 = Date.now(), timeLeft = () => MINUTES * 60e3 - (Date.now() - t0);
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let turn = 0;
async function timed(url, opts = {}, ms = 90000) {
  const c = new AbortController(), tm = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal, headers: { 'User-Agent': 'twin-cities-drive tile baker (github.com/hartwigcam98-star/twin-cities-drive)', ...(opts.headers || {}) } }); }
  finally { clearTimeout(tm); }
}
let opFails = 0; // Overpass often refuses CI machines: after a few failures, go straight to the OSM API
async function overpass(q) {
  if (opFails >= 4) throw new Error('overpass skipped');
  let err;
  for (let i = 0; i < 3; i++) {
    const url = OVERPASS[turn % OVERPASS.length];
    try {
      const r = await timed(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 60000);
      if (r.ok) { const j = await r.json(); if (!(j.remark && /error|timed out|out of memory/i.test(j.remark))) { opFails = 0; return j; } err = new Error('overpass remark ' + j.remark); }
      else err = new Error('overpass ' + r.status);
    } catch (e) { err = e; }
    turn++; await sleep(3000 * (i + 1));
  }
  opFails++;
  throw err;
}
const file = (k, name) => `data/${k}/${name}.json`;
const done = (k, name) => existsSync(file(k, name)) && (k !== 'b' || (() => { try { return JSON.parse(readFileSync(file(k, name), 'utf8')).v >= 5; } catch { return false; } })());
const save = (k, name, d) => { mkdirSync(`data/${k}`, { recursive: true }); writeFileSync(file(k, name), JSON.stringify(d)); };

const tiles = [];
for (let x = 0; x < NX; x++) for (let y = 0; y < NY; y++) tiles.push([x, y]);
tiles.sort((a, b) => Math.hypot(a[0] - 10, a[1] - 12) - Math.hypot(b[0] - 10, b[1] - 12)); // downtown Minneapolis first

let made = 0, failed = 0;
for (let q = 0; q < 4 && KINDS.includes('r'); q++) if (!done('m', String(q)) && timeLeft() > 60e3) {
  try { save('m', String(q), convertMajor(await overpass(majorQuery(q)))); made++; console.log('m', q); } catch (e) { failed++; console.log('m', q, 'failed', e.message); }
}
const log = [];
const { tileBox } = await import('../convert.js');
// terrain first (quick, one request a tile), then map data tile by tile, nearest downtown first
if (KINDS.includes('e')) for (const [x, y] of tiles) {
  if (timeLeft() < 90e3) break;
  const name = `${x}_${y}`; if (done('e', name)) continue;
  try { const r = await timed(elevUrl(x, y)); if (!r.ok) throw new Error('3dep ' + r.status); save('e', name, processElev(x, y, await r.arrayBuffer())); made++; }
  catch (e) { failed++; log.push(`e ${name} ${e.message}`); }
}
const queue = tiles.filter(([x, y]) => KINDS.some(k => k !== 'e' && !done(k, `${x}_${y}`)));
async function bakeTile([x, y]) {
  const name = `${x}_${y}`, need = KINDS.filter(k => k !== 'e' && !done(k, name)); if (!need.length) return;
  let raw = null; // one OSM API download serves all three layers
  for (const kind of need) {
    try {
      let d;
      try { d = convertTile(await overpass(overpassQuery(kind, x, y)), kind); await sleep(1500); }
      catch (e) {
        if (!raw) { const { s, n, w, e: ea } = tileBox(x, y); raw = rawToElements(await fetchOsmApi(s, w, n, ea, url => timed(url, {}, 60000), 3)); }
        d = convertTile(raw, kind);
      }
      save(kind, name, d); made++; console.log(kind, name);
    } catch (e) { failed++; log.push(`${kind} ${name} ${e.message}`); console.log(kind, name, 'failed', e.message); }
  }
}
// three tiles at a time: each tile is mostly waiting on the network
await Promise.all([0, 1, 2].map(async () => { while (queue.length && timeLeft() > 120e3) await bakeTile(queue.shift()); }));
const total = KINDS.reduce((n, k) => n + tiles.filter(([x, y]) => done(k, `${x}_${y}`)).length, 0);
const summary = `${new Date().toISOString()} baked ${made} files, ${failed} failed; ${total}/${tiles.length * KINDS.length} tiles done`;
console.log(summary);
writeFileSync('data/bake-log.txt', [summary, ...log.slice(0, 200)].join('\n') + '\n'); // committed with the tiles so progress can be checked
