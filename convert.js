// Shared OSM → game-tile conversion. Identical copy runs in the browser
// (public/convert.js) and on the server (lib/convert.js).

export const BOUNDS = { S: 44.72, N: 45.18, W: -93.556, E: -92.88 };
export const TLAT = 0.02, TLON = 0.028;
export const NX = Math.ceil((BOUNDS.E - BOUNDS.W) / TLON);
export const NY = Math.ceil((BOUNDS.N - BOUNDS.S) / TLAT);
const LAT0 = 44.94, LON0 = -93.21;
const KX = Math.cos(LAT0 * Math.PI / 180) * 111320, KZ = 110574;
export function proj(lat, lon) {
  return [Math.round((lon - LON0) * KX * 10) / 10, Math.round(-(lat - LAT0) * KZ * 10) / 10];
}
export function tileBox(x, y) {
  return { s: BOUNDS.S + y * TLAT, n: BOUNDS.S + (y + 1) * TLAT, w: BOUNDS.W + x * TLON, e: BOUNDS.W + (x + 1) * TLON };
}

export const CLS = ["motorway","trunk","primary","secondary","tertiary","unclassified","residential","living_street","motorway_link","trunk_link","primary_link","secondary_link","tertiary_link","service"];
const BAD_SERVICE = new Set(["driveway","parking_aisle","drive-through","emergency_access"]);
const HW = "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service)$";

export const POI_CATS = ["Food", "Coffee", "Gas", "Shop", "Grocery", "Health", "School", "Fun", "Park", "Hotel", "Bank", "Worship", "Civic"];
export const POI_ICONS = ["🍔", "☕", "⛽", "🛍️", "🛒", "🏥", "🎓", "🎟️", "🌳", "🏨", "🏦", "⛪", "🏛️"];
export function poiCat(t) {
  const a = t.amenity, s = t.shop, tr = t.tourism, l = t.leisure;
  if (!t.name) return -1;
  if (["restaurant","fast_food","food_court","bar","pub","ice_cream","biergarten"].includes(a)) return 0;
  if (a === "cafe") return 1;
  if (a === "fuel") return 2;
  if (s === "supermarket" || s === "convenience" || s === "grocery" || s === "greengrocer") return 4;
  if (s && s !== "vacant" && s !== "no") return 3;
  if (["hospital","clinic","pharmacy","doctors","dentist"].includes(a)) return 5;
  if (["school","university","college","library"].includes(a)) return 6;
  if (["cinema","theatre","arts_centre","nightclub","events_venue"].includes(a) ||
      ["museum","attraction","zoo","theme_park","aquarium","gallery"].includes(tr) ||
      ["stadium","sports_centre","golf_course","water_park","ice_rink","bowling_alley"].includes(l)) return 7;
  if (l === "park" || l === "nature_reserve") return 8;
  if (tr === "hotel" || tr === "motel") return 9;
  if (a === "bank") return 10;
  if (a === "place_of_worship") return 11;
  if (["police","fire_station","post_office","townhall","courthouse","community_centre"].includes(a)) return 12;
  return -1;
}

// land-use classes (ground surfaces)
export const LU = ["parking", "commercial", "industrial", "residential", "park", "wood", "pitch", "golf", "field", "campus", "dirt"];
export function luClass(t) {
  const l = t.landuse, a = t.amenity, le = t.leisure, n = t.natural;
  if (a === "parking" && t.parking !== "underground" && t.parking !== "multi-storey") return 0;
  if (l === "garages") return 0;
  if (l === "commercial" || l === "retail") return 1;
  if (l === "industrial" || l === "railway" || l === "port") return 2;
  if (l === "residential") return 3;
  if (le === "park" || le === "garden" || le === "playground" || le === "dog_park" || l === "grass" || l === "recreation_ground" || l === "village_green" || l === "cemetery" || a === "grave_yard") return 4;
  if (n === "wood" || l === "forest" || le === "nature_reserve" || n === "scrub" || n === "wetland") return 5;
  if (le === "pitch" || le === "track" || le === "stadium") return 6;
  if (le === "golf_course") return 7;
  if (l === "farmland" || l === "meadow" || n === "grassland" || l === "orchard") return 8;
  if (["school", "university", "college", "hospital"].includes(a) || l === "education" || l === "religious") return 9;
  if (l === "construction" || l === "brownfield" || l === "greenfield" || l === "landfill" || l === "quarry") return 10;
  return -1;
}

export function overpassQuery(kind, x, y) {
  const { s, n, w, e } = tileBox(x, y);
  const bb = `(${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)})`;
  if (kind === "b") return `[out:json][timeout:25];(way["building"]${bb};way["building:part"]${bb};rel["building"]["type"="multipolygon"]${bb};rel["building:part"]["type"="multipolygon"]${bb};way["leisure"="stadium"]${bb};rel["leisure"="stadium"]${bb};` +
    `way["highway"="footway"]["bridge"]["covered"="yes"]${bb};way["highway"="footway"]["bridge"]["indoor"="yes"]${bb};node["highway"~"^(traffic_signals|stop)$"]${bb};node["advertising"="billboard"]${bb};way["advertising"="billboard"]${bb};);out tags geom;`;
  if (kind === "l") return `[out:json][timeout:25];(way["landuse"]${bb};way["amenity"~"^(parking|school|university|college|hospital|grave_yard)$"]${bb};way["leisure"~"^(park|garden|playground|dog_park|pitch|track|stadium|golf_course|nature_reserve)$"]${bb};way["natural"~"^(wood|scrub|wetland|grassland)$"]${bb};);out tags geom;`;
  return `[out:json][timeout:25];(way["highway"~"${HW}"]${bb};way["natural"="water"]${bb};way["waterway"="river"]${bb};);out tags geom;` +
    `(node["name"]["amenity"]${bb};node["name"]["shop"]${bb};node["name"]["tourism"]${bb};node["name"]["leisure"]${bb};` +
    `way["name"]["amenity"]${bb};way["name"]["shop"]${bb};way["name"]["tourism"]${bb};way["name"]["leisure"~"^(park|stadium|sports_centre|golf_course|water_park|nature_reserve)$"]${bb};);out tags center;`;
}

function area(pts) {
  let a = 0;
  for (let i = 0, n = pts.length / 2; i < n; i++) { const j = (i + 1) % n; a += pts[i*2] * pts[j*2+1] - pts[j*2] * pts[i*2+1]; }
  return Math.abs(a) / 2;
}
function parseH(s) {
  if (!s) return 0;
  const m = /([\d.]+)/.exec(s); if (!m) return 0;
  let v = parseFloat(m[1]);
  if (/ft|'/.test(s)) v *= 0.3048;
  return v;
}
const KIND = { house:0, detached:0, residential:0, semidetached_house:0, terrace:0, bungalow:0, garage:0, garages:0, shed:0,
  commercial:1, retail:1, supermarket:1, kiosk:1, hotel:1,
  industrial:2, warehouse:2, manufacture:2, hangar:2, service:2,
  apartments:3, office:3, dormitory:3,
  school:4, church:4, university:4, college:4, hospital:4, civic:4, public:4, government:4, stadium:4, cathedral:4, chapel:4, mosque:4, synagogue:4, temple:4 };
const CSS_COLORS = { white:"#f2f0ea", black:"#2a2a2a", grey:"#9a9a9a", gray:"#9a9a9a", silver:"#b8bcc0", red:"#a3443a", brown:"#7d5a44", beige:"#d8c9a8", tan:"#c9ad84", yellow:"#d9c27a", blue:"#6d86a3", green:"#6e8a64", orange:"#c98a4b", cream:"#ece3c8", maroon:"#7a3b34", darkgray:"#6a6a6a", lightgray:"#c8c8c8" };
function colour(v) {
  if (!v) return "";
  v = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
  return CSS_COLORS[v.replace(/[\s_-]/g, "")] || "";
}

// mode "r": roads, water, rivers, POIs.  mode "b": buildings.  mode "l": land-use areas.
const DIRS = { N: 0, NNE: 22, NE: 45, ENE: 67, E: 90, ESE: 112, SE: 135, SSE: 157, S: 180, SSW: 202, SW: 225, WSW: 247, W: 270, WNW: 292, NW: 315, NNW: 337 };
function roofDir(v) { if (!v) return -1; if (DIRS[v.toUpperCase()] !== undefined) return DIRS[v.toUpperCase()]; const d = parseFloat(v); return isFinite(d) ? d : -1; }
function pointIn(x, z, p) {
  let c = false;
  for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
    const xi = p[i*2], zi = p[i*2+1], xj = p[j*2], zj = p[j*2+1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}
// stitch multipolygon member ways into closed rings (projected, closing point dropped)
function joinRings(geoms) {
  const segs = geoms.filter(g => g && g.length >= 2).map(g => g.filter(Boolean).map(q => q.lat.toFixed(7) + "," + q.lon.toFixed(7)));
  const rings = [];
  while (segs.length) {
    let cur = segs.shift();
    for (let guard = 0; cur[0] !== cur[cur.length - 1] && guard < 500; guard++) {
      const end = cur[cur.length - 1];
      const k = segs.findIndex(s => s[0] === end || s[s.length - 1] === end);
      if (k < 0) break;
      const s = segs.splice(k, 1)[0];
      cur = cur.concat((s[0] === end ? s : s.slice().reverse()).slice(1));
    }
    if (cur.length < 4 || cur[0] !== cur[cur.length - 1]) continue;
    const pts = [];
    for (let i = 0; i < cur.length - 1; i++) { const [la, lo] = cur[i].split(","); const p = proj(+la, +lo); pts.push(p[0], p[1]); }
    rings.push(pts);
  }
  return rings;
}
export function convertTile(j, mode) {
  const names = [], idx = new Map();
  const ni = s => { if (!s) return -1; let i = idx.get(s); if (i === undefined) { i = names.length; names.push(s); idx.set(s, i); } return i; };
  const roads = [], bld = [], water = [], rivers = [], pois = [], parts = [], venues = [], skyways = [], signals = [], billboards = [];
  const seenPoi = new Set();
  const addPoi = (t, lat, lon) => {
    const c = poiCat(t); if (c < 0) return;
    const p = proj(lat, lon);
    const k = t.name + "|" + Math.round(p[0] / 25) + "|" + Math.round(p[1] / 25);
    if (seenPoi.has(k)) return; seenPoi.add(k);
    pois.push([c, ni(t.name), Math.round(p[0]), Math.round(p[1])]);
  };
  if (mode === "l") {
    const areas = [];
    for (const el of (j.elements || [])) {
      if (el.type !== "way" || !el.geometry || el.geometry.length < 4) continue;
      const t = el.tags || {};
      if (t.building) continue;
      const c = luClass(t); if (c < 0) continue;
      const pts = [];
      for (const g of el.geometry) { if (!g) continue; const p = proj(g.lat, g.lon); pts.push(p[0], p[1]); }
      if (pts.length < 8 || pts[0] !== pts[pts.length - 2] || pts[1] !== pts[pts.length - 1]) continue; // closed areas only
      pts.length -= 2;
      if (area(pts) < 40) continue;
      areas.push([c, simplify(pts, 0.8)]);
    }
    return { v: 2, names: [], areas };
  }
  const addB = (t, pts, holes) => {
    if (t.advertising === "billboard" && !t.building) { // billboard mapped as a line (its panel) or an outline
      let cx = 0, cz = 0; const n = pts.length / 2; for (let i = 0; i < n; i++) { cx += pts[i * 2]; cz += pts[i * 2 + 1]; }
      billboards.push([Math.round(cx / n * 10) / 10, Math.round(cz / n * 10) / 10, Math.round(Math.atan2(pts[3] - pts[1], pts[2] - pts[0]) * 1000) / 1000]);
      return;
    }
    if (t.highway === "footway") { // skyway: enclosed pedestrian bridge between buildings
      if (t.bridge && t.bridge !== "no" && (t.covered === "yes" || t.indoor === "yes") && pts.length >= 4) skyways.push(pts);
      return;
    }
    if (t.leisure === "stadium" && !t.building && !t["building:part"]) { // open-air venue outline (ballparks, football stadiums)
      if (pts[0] === pts[pts.length-2] && pts[1] === pts[pts.length-1]) pts.length -= 2;
      if (pts.length >= 6 && area(pts) > 3000) venues.push([ni(t.name || ""), t.sport || "", pts]);
      return;
    }
    if (t["building:part"] && !t.building && !t.highway) { // 3D building part (towers, setbacks, domes)
      if (pts[0] === pts[pts.length-2] && pts[1] === pts[pts.length-1]) pts.length -= 2;
      if (pts.length < 6 || area(pts) < 4) return;
      let h = parseH(t.height);
      if (!h && t["building:levels"]) h = (parseFloat(t["building:levels"]) || 1) * 3.3;
      if (!h) return;
      let minH = parseH(t.min_height);
      if (!minH && t["building:min_level"]) minH = (parseFloat(t["building:min_level"]) || 0) * 3.3;
      if (minH >= h) return;
      let rh = parseH(t["roof:height"]); if (!rh && t["roof:levels"]) rh = (parseFloat(t["roof:levels"]) || 0) * 3;
      parts.push([Math.round(h * 10) / 10, Math.round(minH * 10) / 10, pts, colour(t["building:colour"]), colour(t["roof:colour"]), t["roof:shape"] || "", Math.round(rh * 10) / 10, roofDir(t["roof:direction"])]);
      return;
    }
    if (!t.building || t.highway) return;
    if (pts[0] === pts[pts.length-2] && pts[1] === pts[pts.length-1]) pts.length -= 2;
    if (pts.length < 6) return;
    const a = area(pts);
    if (a < 35) return;
    let kind = KIND[t.building]; if (kind === undefined) kind = a > 1500 ? 1 : 0;
    let h = parseH(t.height);
    if (!h && t["building:levels"]) h = (parseFloat(t["building:levels"]) || 1) * 3.3 + 1;
    const known = h ? 1 : 0;
    if (!h) h = kind === 0 ? (a < 70 ? 3.2 : 5) : kind === 3 ? 13 : kind === 2 ? 9 : kind === 4 ? 11 : (a > 3000 ? 10 : 7);
    const rec = [Math.round(h * 10) / 10, kind, pts];
    const wc = colour(t["building:colour"]), rc = colour(t["roof:colour"]), rs = t["roof:shape"] || "";
    let minH = parseH(t.min_height);
    if (!minH && t["building:min_level"]) minH = (parseFloat(t["building:min_level"]) || 0) * 3.3;
    if (!minH && (t.building === "bridge" || t.bridge === "yes")) minH = 5.3;
    rec.push(wc, rc, rs, Math.round(minH * 10) / 10, t.building, parseH(t["roof:height"]) || 0);
    rec.push(holes && holes.length ? holes : 0, ni(t.name || ""), known);
    bld.push(rec);
    return;
  };
  for (const el of (j.elements || [])) {
    const t = el.tags || {};
    if (el.type === "node") {
      if (mode === "r" && el.lat != null) addPoi(t, el.lat, el.lon);
      else if (mode === "b" && el.lat != null && t.advertising === "billboard") { const p = proj(el.lat, el.lon); billboards.push([p[0], p[1], 9]); }
      else if (mode === "b" && el.lat != null && (t.highway === "traffic_signals" || t.highway === "stop")) {
        const p = proj(el.lat, el.lon);
        signals.push([t.highway === "stop" ? 1 : 0, p[0], p[1], t.stop === "all" ? 1 : 0]);
      }
      continue;
    }
    if (el.type === "relation") {
      if (mode !== "b" || !el.members || !(t.building || t["building:part"] || t.leisure === "stadium")) continue;
      const outer = joinRings(el.members.filter(m => m.type === "way" && m.role !== "inner").map(m => m.geometry));
      const inner = joinRings(el.members.filter(m => m.type === "way" && m.role === "inner").map(m => m.geometry));
      for (const o of outer) {
        const hs = inner.filter(h => pointIn(h[0], h[1], o));
        addB(t, o, hs.length ? hs : null);
      }
      continue;
    }
    if (el.type !== "way") continue;
    if (el.center && !el.geometry) { if (mode === "r") addPoi(t, el.center.lat, el.center.lon); continue; }
    if (!el.geometry || el.geometry.length < 2) continue;
    const pts = [];
    let la = 0, lo = 0, cnt = 0;
    for (const g of el.geometry) { if (!g) continue; const p = proj(g.lat, g.lon); pts.push(p[0], p[1]); la += g.lat; lo += g.lon; cnt++; }
    if (pts.length < 4) continue;
    if (mode === "b") { addB(t, pts, null); continue; }
    if (t.highway) {
      const c = CLS.indexOf(t.highway); if (c < 0) continue;
      if (c === 13 && BAD_SERVICE.has(t.service)) continue;
      if (t.area === "yes") continue;
      let ow = (t.oneway === "yes" || t.oneway === "1" || t.oneway === "-1" || t.highway === "motorway" || t.junction === "roundabout") ? 1 : 0;
      if (t.oneway === "no") ow = 0;
      let ms = 0;
      if (t.maxspeed) { const m = /(\d+)/.exec(t.maxspeed); if (m) ms = +m[1]; if (/km/.test(t.maxspeed)) ms = Math.round(ms * 0.621); }
      const isBridge = t.bridge && t.bridge !== "no";
      let layer = parseInt(t.layer) || 0; if (isBridge && layer < 1) layer = 1;
      const flags = ow | (isBridge ? 2 : 0) | ((t.tunnel && t.tunnel !== "no") ? 4 : 0) | (Math.max(0, Math.min(7, layer)) << 3);
      roads.push([c, ni(t.name || ""), ni(t.ref || ""), flags, parseInt(t.lanes) || 0, ms, pts]);
    } else if (t.natural === "water") {
      if (pts[0] === pts[pts.length-2] && pts[1] === pts[pts.length-1]) { pts.length -= 2; if (pts.length >= 6) water.push(pts); }
    } else if (t.waterway === "river") {
      if (t.tunnel && t.tunnel !== "no") continue; // underground stretch
      rivers.push([ni(t.name || ""), pts]);
    } else if (cnt && t.name) {
      addPoi(t, la / cnt, lo / cnt);
    }
  }
  return mode === "b" ? { v: 5, names, bld, parts, venues, skyways, signals, billboards } : { v: 2, names, roads, water, rivers, pois };
}

// ── main OSM API (/api/0.6/map) fallback ──
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unesc = s => s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] ?? m;
});
const attr = (s, k) => { const m = new RegExp("\\b" + k + '="([^"]*)"').exec(s); return m ? m[1] : null; };
function tagsOf(body) {
  const tags = {}; const re = /<tag k="([^"]*)" v="([^"]*)"/g; let t;
  while ((t = re.exec(body))) tags[unesc(t[1])] = unesc(t[2]);
  return tags;
}
const keepWay = t => t.highway || t.building || t["building:part"] || t.advertising === "billboard" || t.natural === "water" || t.waterway === "river" || (t.name && poiCat(t) >= 0) || luClass(t) >= 0;
function parseXml(xml, raw) {
  const nodeRe = /<node\s([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g; let m;
  while ((m = nodeRe.exec(xml))) {
    const id = attr(m[1], "id"), lat = attr(m[1], "lat"), lon = attr(m[1], "lon");
    if (!id || !lat) continue;
    raw.nodes.set(id, [+lat, +lon]);
    if (m[2] && (m[2].includes("name") || m[2].includes("highway") || m[2].includes("advertising"))) {
      const tags = tagsOf(m[2]);
      if (poiCat(tags) >= 0 || tags.highway === "traffic_signals" || tags.highway === "stop" || tags.advertising === "billboard") raw.tagged.set(id, { lat: +lat, lon: +lon, tags });
    }
  }
  const wayRe = /<way\s([^>]*)>([\s\S]*?)<\/way>/g;
  while ((m = wayRe.exec(xml))) {
    const id = attr(m[1], "id"); if (!id || raw.ways.has(id)) continue;
    const tags = tagsOf(m[2]); if (!keepWay(tags)) continue;
    const refs = []; const re = /<nd ref="(\d+)"/g; let n;
    while ((n = re.exec(m[2]))) refs.push(n[1]);
    raw.ways.set(id, { refs, tags });
  }
}
export async function fetchOsmApi(s, w, n, e, fetchFn, split = 3, raw = { nodes: new Map(), ways: new Map(), tagged: new Map() }) {
  const boxes = [];
  for (let i = 0; i < split; i++) for (let j = 0; j < split; j++) {
    const bs = s + (n - s) * i / split, bn = s + (n - s) * (i + 1) / split;
    const bw = w + (e - w) * j / split, be = w + (e - w) * (j + 1) / split;
    boxes.push([bw, bs, be, bn]);
  }
  let k = 0, failed = 0;
  async function worker() {
    while (k < boxes.length) {
      const [bw, bs, be, bn] = boxes[k++];
      let ok = false;
      for (let a = 0; a < 2 && !ok; a++) {
        try {
          const r = await fetchFn(`https://api.openstreetmap.org/api/0.6/map?bbox=${bw.toFixed(6)},${bs.toFixed(6)},${be.toFixed(6)},${bn.toFixed(6)}`);
          if (r.ok) { parseXml(await r.text(), raw); ok = true; }
          else if (r.status === 400 || r.status === 509) { await fetchOsmApi(bs, bw, bn, be, fetchFn, 2, raw); ok = true; }
        } catch {}
      }
      if (!ok) failed++;
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  if (failed) throw new Error(`osm api: ${failed}/${boxes.length} pieces failed`);
  return raw;
}
export function rawToElements(raw) {
  const elements = [];
  for (const [, wv] of raw.ways) {
    const geometry = [];
    for (const r of wv.refs) { const p = raw.nodes.get(r); if (p) geometry.push({ lat: p[0], lon: p[1] }); }
    if (geometry.length >= 2) elements.push({ type: "way", tags: wv.tags, geometry });
  }
  for (const [, nd] of raw.tagged) elements.push({ type: "node", lat: nd.lat, lon: nd.lon, tags: nd.tags });
  return { elements };
}

// ── overview map (major roads, named lakes, rivers) by quadrant ──
export function majorQuery(q) {
  const midLat = (BOUNDS.S + BOUNDS.N) / 2, midLon = (BOUNDS.W + BOUNDS.E) / 2;
  const s = q < 2 ? BOUNDS.S : midLat, n = q < 2 ? midLat : BOUNDS.N;
  const w = q % 2 === 0 ? BOUNDS.W : midLon, e = q % 2 === 0 ? midLon : BOUNDS.E;
  const bb = `(${s},${w},${n},${e})`;
  return `[out:json][timeout:25];(way["highway"~"^(motorway|trunk|primary|secondary)$"]${bb};way["natural"="water"]["name"]${bb};way["waterway"="river"]${bb};);out tags geom;`;
}
export function simplify(pts, tol) {
  const n = pts.length / 2; if (n < 3) return pts;
  const keep = new Uint8Array(n); keep[0] = keep[n-1] = 1;
  const stack = [[0, n-1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a*2], az = pts[a*2+1], bx = pts[b*2], bz = pts[b*2+1];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1e-9;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i*2] - ax) * dz - (pts[i*2+1] - az) * dx) / L; if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i*2], pts[i*2+1]);
  return out;
}
export function convertMajor(j) {
  const names = [], idx = new Map();
  const ni = v => { if (!v) return -1; let i = idx.get(v); if (i === undefined) { i = names.length; names.push(v); idx.set(v, i); } return i; };
  const roads = [], water = [], rivers = [];
  for (const el of j.elements || []) {
    if (el.type !== "way" || !el.geometry) continue;
    const t = el.tags || {};
    const pts = [];
    for (const g of el.geometry) { if (!g) continue; const p = proj(g.lat, g.lon); pts.push(Math.round(p[0]), Math.round(p[1])); }
    if (pts.length < 4) continue;
    if (t.highway) roads.push([CLS.indexOf(t.highway), ni(t.ref || t.name || ""), simplify(pts, 10)]);
    else if (t.natural === "water") water.push(simplify(pts, 10));
    else rivers.push([ni(t.name || ""), simplify(pts, 15)]);
  }
  return { names, roads, water, rivers };
}

// light shape check used by the server before caching browser-submitted data
export function validTileData(kind, d) {
  if (!d || typeof d !== "object" || !Array.isArray(d.names)) return false;
  const arrNum = a => Array.isArray(a) && a.every(v => typeof v === "number" && isFinite(v));
  if (kind === "b") return Array.isArray(d.bld) && d.bld.every(b => Array.isArray(b) && typeof b[0] === "number" && arrNum(b[2]));
  if (kind === "m") return Array.isArray(d.roads) && d.roads.every(r => Array.isArray(r) && arrNum(r[2]));
  return Array.isArray(d.roads) && d.roads.every(r => Array.isArray(r) && r.length === 7 && arrNum(r[6])) &&
    Array.isArray(d.pois) && d.pois.every(p => arrNum(p));
}
