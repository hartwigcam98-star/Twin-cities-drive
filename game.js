import * as THREE from './vendor/three.module.min.js';
import { convertTile, overpassQuery, tileBox, fetchOsmApi, rawToElements, majorQuery, convertMajor, POI_ICONS, POI_CATS } from './convert.js?v=19';

// ───────────────────────── geography ─────────────────────────
const API = (window.__HATCHABLE__ && window.__HATCHABLE__.api) || '/api';
// standalone build (GitHub Pages): no server — map data comes from files baked into the site (data/), then from a
// cache in this browser, then live from OpenStreetMap / USGS
const STATIC = !!window.TCD_STATIC;
const idb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => { const q = indexedDB.open('tcd-cache', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }));
  const tx = (mode, fn) => open().then(db => new Promise((res, rej) => { const t = db.transaction('kv', mode), r = fn(t.objectStore('kv')); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }));
  return { get: k => tx('readonly', st => st.get(k)).catch(() => undefined), put: (k, v) => tx('readwrite', st => st.put(v, k)).catch(() => {}) };
})();
const staticJson = path => fetch(path).then(r => r.ok ? r.json() : null).catch(() => null);
const B = { S: 44.72, N: 45.18, W: -93.556, E: -92.88 };
const TLAT = 0.02, TLON = 0.028;
const NX = Math.ceil((B.E - B.W) / TLON), NY = Math.ceil((B.N - B.S) / TLAT);
const LAT0 = 44.94, LON0 = -93.21;
const KX = Math.cos(LAT0 * Math.PI / 180) * 111320, KZ = 110574;
const proj = (lat, lon) => [(lon - LON0) * KX, -(lat - LAT0) * KZ];
const unproj = (x, z) => [LAT0 - z / KZ, LON0 + x / KX];
const tileOf = (x, z) => { const [lat, lon] = unproj(x, z); return [Math.floor((lon - B.W) / TLON), Math.floor((lat - B.S) / TLAT)]; };
const tileFrac = (x, z) => { const [lat, lon] = unproj(x, z); return [(lon - B.W) / TLON, (lat - B.S) / TLAT]; };
const [MINX, MAXZ] = proj(B.S, B.W);
const [MAXX, MINZ] = proj(B.N, B.E);

const PLACES = [
  ['Downtown Minneapolis', 44.9765, -93.2700],
  ['Downtown St. Paul', 44.9497, -93.0925],
  ['Mall of America', 44.8549, -93.2422],
  ['U.S. Bank Stadium', 44.9736, -93.2575],
  ['Maple Grove', 45.0725, -93.4558],
  ['Plymouth', 45.0105, -93.4555],
  ['Brooklyn Park', 45.0941, -93.3563],
  ['Brooklyn Center', 45.0761, -93.3327],
  ['Golden Valley', 45.0097, -93.3491],
  ['Robbinsdale', 45.0322, -93.3386],
  ['Crystal', 45.0327, -93.3602],
  ['New Hope', 45.0380, -93.3866],
  ['St. Louis Park', 44.9483, -93.3480],
  ['Hopkins', 44.9247, -93.4180],
  ['Minnetonka', 44.9133, -93.4700],
  ['Edina', 44.8897, -93.3499],
  ['Richfield', 44.8833, -93.2830],
  ['Bloomington', 44.8408, -93.2983],
  ['Eden Prairie', 44.8547, -93.4708],
  ['Burnsville', 44.7677, -93.2777],
  ['Savage', 44.7792, -93.3366],
  ['Eagan', 44.8041, -93.1669],
  ['Mendota Heights', 44.8836, -93.1383],
  ['West St. Paul', 44.9161, -93.1016],
  ['South St. Paul', 44.8927, -93.0350],
  ['Inver Grove Heights', 44.8480, -93.0427],
  ['Woodbury', 44.9239, -92.9594],
  ['Maplewood', 44.9530, -92.9952],
  ['Oakdale', 44.9630, -92.9649],
  ['North St. Paul', 45.0125, -92.9919],
  ['Roseville', 45.0061, -93.1566],
  ['Falcon Heights', 44.9916, -93.1663],
  ['Shoreview', 45.0791, -93.1472],
  ['Arden Hills', 45.0502, -93.1566],
  ['New Brighton', 45.0655, -93.2019],
  ['Mounds View', 45.1050, -93.2086],
  ['Fridley', 45.0861, -93.2633],
  ['Columbia Heights', 45.0408, -93.2630],
  ['St. Anthony', 45.0205, -93.2180],
  ['Little Canada', 45.0269, -93.0877],
  ['Vadnais Heights', 45.0575, -93.0738],
  ['White Bear Lake', 45.0847, -93.0099],
  ['Uptown', 44.9490, -93.2980],
  ['MSP Airport', 44.8848, -93.2223],
].map(([n, la, lo]) => { const [x, z] = proj(la, lo); return { n, x, z }; });
const nearPlace = (x, z) => { let b = null, bd = 1e18; for (const p of PLACES) { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; b = p; } } return b; };

// ───────────────────────── settings ─────────────────────────
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const settings = Object.assign({ radius: 1, buildings: true, trees: true, shadows: true, color: '#d6332a', car: 'sport' }, (() => { try { return JSON.parse(localStorage.getItem('tcd-settings') || '{}'); } catch { return {}; } })());
// ── life mode: your money, home and cars (saved on this device) ──
const LIFE_KEY = 'tcd-life';
const LIFE = (() => {
  let d = null; try { d = JSON.parse(localStorage.getItem(LIFE_KEY) || 'null'); } catch {}
  return Object.assign({ v: 1, money: 3500, hours: 8, home: null, cars: [{ id: 1, type: 'beater', year: 2009, color: '#8a8f96', loan: null, name: '2009 Midsize Sedan' }], active: 0, log: [], nextId: 2, lastBill: 0, pos: null }, d || {});
})();
const LIFE_ON = () => settings.mode !== 'free';
function vType() { if (LIFE_ON() && (LIFE.jobCar || LIFE.hot)) return (LIFE.jobCar || LIFE.hot).type; const c = LIFE_ON() && LIFE.cars[LIFE.active]; return c ? c.type : settings.car; }
function vColor() { if (LIFE_ON() && (LIFE.jobCar || LIFE.hot)) return (LIFE.jobCar || LIFE.hot).color; const c = LIFE_ON() && LIFE.cars[LIFE.active]; return c ? c.color : settings.color; }
// graphics: "light" (default on phones) trims roadside clutter, trees and fine detail so the game fits in a phone's memory
const LOW = (settings.gfx || (isTouch ? 'low' : 'high')) === 'low';
const saveSettings = () => { try { localStorage.setItem('tcd-settings', JSON.stringify(settings)); } catch {} };

// ───────────────────────── renderer / scene ─────────────────────────
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isTouch, powerPreference: 'high-performance', stencil: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, LOW ? 1.25 : isTouch ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const SKY = new THREE.Color('#cddfee'); // horizon haze; the sky dome fades to deeper blue overhead
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 300, 1700);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 4000);
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); sizeMap(); });

// ── light: a warm afternoon sun from the south-west that casts shadows around the car, soft sky fill ──
const hemi = new THREE.HemisphereLight('#d3e3fb', '#5b604d', 0.82); scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff0d6', 2.25);
const SUN_DIR = new THREE.Vector3(-0.52, 0.76, 0.4).normalize();
sun.position.copy(SUN_DIR);
scene.add(sun); scene.add(sun.target);
renderer.shadowMap.enabled = settings.shadows !== false;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
sun.castShadow = true;
{ const SM = isTouch ? 1024 : 2048, sc = sun.shadow.camera; sun.shadow.mapSize.set(SM, SM);
  sc.left = -140; sc.right = 140; sc.top = 140; sc.bottom = -140; sc.near = 20; sc.far = 1000; sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.7; }
function updateSun(x, y, z) {
  x = Math.round(x * 2) / 2; z = Math.round(z * 2) / 2; y = Math.round(y);
  sun.target.position.set(x, y, z); sun.position.set(x + SUN_DIR.x * 500, y + SUN_DIR.y * 500, z + SUN_DIR.z * 500);
  sun.target.updateMatrixWorld();
}
// sky dome: deep blue overhead fading to the hazy horizon (fog colour)
const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
  uniforms: { top: { value: new THREE.Color('#3f7cc4') }, hor: { value: SKY.clone() }, sunD: { value: new THREE.Vector3(-0.52, 0.76, 0.4).normalize() }, sunC: { value: new THREE.Color('#fff0d6') }, moonD: { value: new THREE.Vector3(0.35, 0.75, -0.3).normalize() }, night: { value: 0 }, cloud: { value: 0 } },
  vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform vec3 top; uniform vec3 hor; uniform vec3 sunD; uniform vec3 sunC; uniform vec3 moonD; uniform float night; uniform float cloud; varying vec3 vP;
void main(){
  vec3 n = normalize(vP); float h = clamp(n.y, 0.0, 1.0);
  vec3 c = mix(hor, top, pow(h, 0.6));
  float sd = max(dot(n, sunD), 0.0);
  c += sunC * (pow(sd, 900.0) * 2.5 * (1.0 - cloud) + pow(sd, 10.0) * 0.22 * (1.0 - 0.7 * cloud)) * (1.0 - night) * smoothstep(-0.08, 0.02, n.y);
  if (night > 0.01 && n.y > 0.0 && cloud < 0.95) { // stars and the moon (hidden by cloud)
    vec3 q = floor(n * 420.0); float r = fract(sin(dot(q, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
    c += vec3(step(0.9982, r) * (0.5 + 0.5 * fract(r * 91.7))) * night * smoothstep(0.02, 0.25, n.y) * (1.0 - cloud);
    float md = dot(n, moonD); c += vec3(0.92, 0.94, 1.0) * (smoothstep(0.99955, 0.99975, md) + pow(max(md, 0.0), 60.0) * 0.08) * night * (1.0 - cloud);
  }
  gl_FragColor = vec4(c, 1.0);
#include <colorspace_fragment>
}`,
}));
sky.frustumCulled = false; sky.renderOrder = -100; sky.userData.terrBS = true; sky.userData.shadowSet = true; scene.add(sky);
const NIGHT = { value: 0 }; // 0 = daylight … 1 = full night; shared by every night-time effect (windows, street lights, headlights)
// weather: cloud cover, how hard it's coming down, and what it has left on the ground (wet roads, snow cover)
const WX = { kind: 'clear', cloud: 0, precip: 0, snowing: 0, wet: { value: 0 }, snow: { value: 0 }, next: 0 };

// textures
function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
function noise(ctx, w, h, base, amt, n) {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = (Math.random() - 0.5) * amt;
    ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}
const grassTex = canvasTex(256, 256, (c, w, h) => { noise(c, w, h, '#6f8f4e', 0.16, 9000); });
grassTex.repeat.set(4000 / 30, 4000 / 30);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000, 200, 200), new THREE.MeshLambertMaterial({ map: grassTex }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// ───────────────────────── terrain (USGS 3DEP elevation, from Minnesota's statewide lidar) ─────────────────────────
// The world is built flat; every vertex is lifted by the ground height at its x/z in the vertex shader, so roads,
// buildings, signs, trees and cars all ride the hills without being rebuilt. terrainAt() is the CPU copy (camera,
// bridge decks, physics). Heights are metres relative to E0.
const E0 = 256, TN = 129;
const terr = new Map(), terrPending = new Set();
let terrFallback = 0, terrDirty = false;
function terrainAt(x, z) {
  const lat = LAT0 - z / KZ, lon = LON0 + x / KX;
  const tx = Math.floor((lon - B.W) / TLON), ty = Math.floor((lat - B.S) / TLAT);
  const g = terr.get(tx + ',' + ty); if (!g) return terrFallback;
  const fx = (lon - (B.W + tx * TLON)) / TLON * (TN - 1), fy = (lat - (B.S + ty * TLAT)) / TLAT * (TN - 1);
  const x0 = Math.max(0, Math.min(TN - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(TN - 2, Math.floor(fy)));
  const u = Math.min(1, Math.max(0, fx - x0)), v = Math.min(1, Math.max(0, fy - y0)), i = y0 * TN + x0;
  return (g[i] * (1 - u) + g[i + 1] * u) * (1 - v) + (g[i + TN] * (1 - u) + g[i + TN + 1] * u) * v;
}
function wantTerrain(tx, ty) {
  const k = tx + ',' + ty;
  if (tx < 0 || ty < 0 || tx >= NX || ty >= NY || terr.has(k) || terrPending.has(k)) return;
  terrPending.add(k);
  const get = STATIC ? (async () => {
    const d = (await staticJson(`data/e/${tx}_${ty}.json`)) || (await idb.get(`e:${tx}:${ty}`)); if (d) return d;
    const { elevUrl, processElev } = await import('./elevcore.js');
    const r = await fetch(elevUrl(tx, ty)); if (!r.ok) throw new Error('3dep ' + r.status);
    const e = processElev(tx, ty, await r.arrayBuffer()); idb.put(`e:${tx}:${ty}`, e); return e;
  })() : fetch(`${API}/elev?x=${tx}&y=${ty}`).then(r => r.ok ? r.json() : Promise.reject(new Error('elev ' + r.status)));
  get.then(d => {
    const a = new Float32Array(TN * TN); for (let i = 0; i < a.length; i++) a[i] = d.h[i] / 10 - E0;
    terr.set(k, a); terrPending.delete(k); terrDirty = true;
    // bridge decks are straightened against the terrain when built: redo the ones already standing nearby
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const t = tiles.get((tx + i) + ',' + (ty + j)); if (t && t.roadMeshes && !t.dead && t.roads.some(r => r.raised)) rebuildRoadGeometry(t); }
  }).catch(() => setTimeout(() => terrPending.delete(k), 20000));
}
// GPU copy: a 12.8 km window around the player, 20 m per texel, sampled bilinearly in the shader
const TW = 640, TSPAN = 12780, TD = TSPAN / (TW - 1);
const terrData = new Float32Array(TW * TW);
const terrTex = new THREE.DataTexture(terrData, TW, TW, THREE.RedFormat, THREE.FloatType); terrTex.needsUpdate = true;
const TU = { uTerr: { value: terrTex }, uTerrB: { value: new THREE.Vector4(0, 0, 1 / TD, 0) }, uCarP: { value: new THREE.Vector2() } };
let terrCX = NaN, terrCZ = NaN;
function updateTerrainWindow(x, z) {
  const cx = Math.round(x / 2000) * 2000, cz = Math.round(z / 2000) * 2000;
  if (cx === terrCX && cz === terrCZ && !terrDirty) return;
  terrCX = cx; terrCZ = cz; terrDirty = false;
  const here = terr.has(tileOf(x, z).join(',')); if (here) terrFallback = terrainAt(x, z);
  const x0 = cx - TSPAN / 2, z0 = cz - TSPAN / 2;
  for (let j = 0; j < TW; j++) for (let i = 0; i < TW; i++) terrData[j * TW + i] = terrainAt(x0 + i * TD, z0 + j * TD);
  TU.uTerrB.value.set(x0, z0, 1 / TD, 0); terrTex.needsUpdate = true;
}
const TERR_GLSL = `uniform sampler2D uTerr; uniform vec4 uTerrB;
float terrH(vec2 p) {
  vec2 q = clamp((p - uTerrB.xy) * uTerrB.z, vec2(0.0), vec2(${(TW - 1.001).toFixed(3)}));
  ivec2 i = ivec2(floor(q)); vec2 f = q - vec2(i); ivec2 j = min(i + 1, ivec2(${TW - 1}));
  float a = texelFetch(uTerr, i, 0).r, b = texelFetch(uTerr, ivec2(j.x, i.y), 0).r, c = texelFetch(uTerr, ivec2(i.x, j.y), 0).r, d = texelFetch(uTerr, j, 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;
const TERR_PROJ = `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
vec4 terrW = modelMatrix * mvPosition;
terrW.y += terrH(terrW.xz);
#if defined( TERR_N ) && !defined( FLAT_SHADED )
if (normalize(mat3(modelMatrix) * objectNormal).y > 0.8) { // ground-facing surfaces take the slope's normal
  float e = 8.0;
  vec3 tn = normalize(vec3(terrH(terrW.xz - vec2(e, 0.0)) - terrH(terrW.xz + vec2(e, 0.0)), 2.0 * e, terrH(terrW.xz - vec2(0.0, e)) - terrH(terrW.xz + vec2(0.0, e))));
  vNormal = normalize(mat3(viewMatrix) * tn);
}
#endif
mvPosition = viewMatrix * terrW;
gl_Position = projectionMatrix * mvPosition;`;
// shadow lookups use the lifted position too
const TERR_WORLDPOS = `#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
	vec4 worldPosition = terrW;
#endif`;
const TERR_SPRITE = 'vec4 terrW = modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ); terrW.y += terrH(terrW.xz); vec4 mvPosition = viewMatrix * terrW;';
function terrainize(mat) {
  if (!mat || mat.userData.terr || mat.isShaderMaterial) return;
  mat.userData.terr = true;
  // rigid: the player's car is lifted as one piece (to the ground under its centre) and tilted in JS, instead of
  // every vertex following the ground, which sheared the body on side slopes
  const rigid = !!mat.userData.rigid;
  const lit = !rigid && !!(mat.isMeshLambertMaterial || mat.isMeshPhongMaterial || mat.isMeshStandardMaterial);
  const wxOn = !rigid && !!(mat.isMeshLambertMaterial || mat.isMeshPhongMaterial) && mat.userData.snowK !== 0;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    sh.uniforms.uTerr = TU.uTerr; sh.uniforms.uTerrB = TU.uTerrB; sh.uniforms.uCarP = TU.uCarP;
    if (wxOn) { // snow settles on whatever faces up; rain darkens it (roads most)
      sh.uniforms.uSnow = WX.snow; sh.uniforms.uWet = WX.wet;
      sh.uniforms.uSnowK = { value: mat.userData.snowK ?? 0.85 }; sh.uniforms.uWetK = { value: mat.userData.wetK ?? 0.35 };
      sh.fragmentShader = 'uniform float uSnow; uniform float uWet; uniform float uSnowK; uniform float uWetK; varying float vUp;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  { float up = smoothstep(0.55, 0.9, vUp);
    diffuseColor.rgb *= 1.0 - 0.42 * uWet * uWetK * up;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.92, 0.95), uSnow * uSnowK * up); }`);
    }
    let vs = sh.vertexShader;
    if (mat.isSpriteMaterial) vs = vs.replace('vec4 mvPosition = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );', TERR_SPRITE);
    else vs = vs.replace('#include <project_vertex>', (lit ? '#define TERR_N\n' : '') + (rigid ? TERR_PROJ.replace('terrH(terrW.xz);', 'terrH(uCarP);') : TERR_PROJ)).replace('#include <worldpos_vertex>', TERR_WORLDPOS);
    if (wxOn) vs = 'varying float vUp;\n' + vs.replace('#include <fog_vertex>', '#include <fog_vertex>\nvUp = normalize(mat3(modelMatrix) * objectNormal).y;');
    sh.vertexShader = TERR_GLSL + 'uniform vec2 uCarP;\n' + vs;
  };
  const pk = mat.customProgramCacheKey && mat.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : null;
  mat.customProgramCacheKey = () => (pk ? pk() : '') + '|terr' + (lit ? 'n' : '') + (rigid ? 'r' : '') + (wxOn ? 'w' : '');
  mat.needsUpdate = true;
}
// shadow maps are drawn with a depth material that is lifted onto the terrain as well
const terrDepthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
terrainize(terrDepthMat);
const carDepthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }); carDepthMat.userData.rigid = true;
terrainize(carDepthMat);

// ───────────────────────── time of day ─────────────────────────
// The sun crosses the sky (rises in the east, low and to the south in Minnesota), sky/fog/light colours follow its
// height, and after dusk the moon takes over the shadows while street lights, windows and headlights come on.
const TIME_PRESETS = { morning: 8.5, midday: 12.5, afternoon: 15.5, sunset: 18.05, night: 22.5 };
let tod = TIME_PRESETS[settings.time] ?? 15.5; // hours, 0–24
const DAY_KEYS = [ // keyed by the sun's elevation (sine): light colour/intensity, sky light, ground bounce, sky top, horizon
  [-0.3, '#93a9e0', 0.38, '#2e3c60', '#0e1018', 0.62, '#040912', '#111a2c'],
  [-0.1, '#93a9e0', 0.28, '#3d4b72', '#16171d', 0.62, '#0f1d3d', '#3a3f5e'],
  [0.0, '#ff8a40', 0.35, '#7a83aa', '#36302e', 0.58, '#284684', '#e3956a'],
  [0.1, '#ffaa66', 1.3, '#a9b8de', '#4b443d', 0.68, '#3765ad', '#eec09d'],
  [0.3, '#ffe0b4', 2.0, '#c6d7f1', '#56594b', 0.78, '#3d76c0', '#d3dde8'],
  [0.55, '#fff0d6', 2.25, '#d3e3fb', '#5b604d', 0.82, '#3f7cc4', '#cddfee'],
].map(k => ({ e: k[0], sun: new THREE.Color(k[1]), si: k[2], hs: new THREE.Color(k[3]), hg: new THREE.Color(k[4]), hi: k[5], top: new THREE.Color(k[6]), hor: new THREE.Color(k[7]) }));
const MOON_DIR = new THREE.Vector3(0.35, 0.75, -0.3).normalize(), sunD = new THREE.Vector3(), tmpGray = new THREE.Color();
let todApplied = -1;
function applyTime(h) {
  const th = (h - 6.5) / 12 * Math.PI, sn = Math.sin(th); // sunrise 6:30, sunset 6:30
  sunD.set(Math.cos(th), sn, 0.45 * Math.max(0, sn) + 0.15).normalize();
  const e = sunD.y;
  let i = 0; while (i < DAY_KEYS.length - 2 && e > DAY_KEYS[i + 1].e) i++;
  const A = DAY_KEYS[i], B = DAY_KEYS[i + 1], f = Math.max(0, Math.min(1, (e - A.e) / (B.e - A.e)));
  sun.color.copy(A.sun).lerp(B.sun, f); sun.intensity = A.si + (B.si - A.si) * f;
  hemi.color.copy(A.hs).lerp(B.hs, f); hemi.groundColor.copy(A.hg).lerp(B.hg, f); hemi.intensity = A.hi + (B.hi - A.hi) * f;
  sky.material.uniforms.top.value.copy(A.top).lerp(B.top, f);
  SKY.copy(A.hor).lerp(B.hor, f); sky.material.uniforms.hor.value.copy(SKY); scene.fog.color.copy(SKY);
  sky.material.uniforms.sunD.value.copy(sunD); sky.material.uniforms.sunC.value.copy(sun.color);
  NIGHT.value = Math.max(0, Math.min(1, (0.06 - e) / 0.16));
  sky.material.uniforms.night.value = NIGHT.value;
  // weather: clouds dim and flatten the sun, grey the sky; rain and snow pull the fog in
  const cl = WX.cloud, pr = WX.precip;
  if (cl > 0.001) {
    sun.intensity *= 1 - 0.78 * cl; hemi.intensity *= 1 + 0.12 * cl;
    const gray = (c, k) => { const l = c.r * 0.3 + c.g * 0.55 + c.b * 0.15; c.lerp(tmpGray.setRGB(l, l * 1.02, l * 1.06), k); };
    gray(sky.material.uniforms.top.value, 0.85 * cl); gray(SKY, 0.8 * cl); SKY.multiplyScalar(1 - 0.12 * cl);
    sky.material.uniforms.top.value.lerp(SKY, 0.55 * cl);
    sky.material.uniforms.hor.value.copy(SKY); scene.fog.color.copy(SKY); hemi.color.lerp(SKY, 0.4 * cl);
  }
  sky.material.uniforms.cloud.value = cl;
  const fogFar = settings.radius > 1 ? 2600 : 1700;
  scene.fog.far = fogFar * (1 - pr * (0.55 + 0.2 * WX.snowing)); scene.fog.near = 300 * (1 - pr * 0.8);
  // the shadow-casting light: the sun by day, the moon once the sun is down (kept above ~7° so shadows stay sane)
  SUN_DIR.copy(e > -0.03 ? sunD : MOON_DIR); if (SUN_DIR.y < 0.12) { SUN_DIR.y = 0.12; SUN_DIR.normalize(); }
  todApplied = h;
}
function tickTime(dt) {
  if ((settings.time ?? 'cycle') === 'cycle') tod = (tod + dt / 60 * (typeof jobs === 'object' ? jobs.clockRate() : 1)) % 24; // one game hour per real minute
  tickWeather(dt);
  applyTime(tod);
}
// ── weather ──
const WX_TARGET = { clear: [0, 0, 0], cloudy: [0.85, 0, 0], rain: [1, 1, 0], snow: [1, 1, 1] }; // cloud, precip, snowing
function tickWeather(dt) {
  const mode = settings.weather || 'clear';
  if (mode === 'changing') { // a new sky every 3–6 minutes
    if ((WX.next -= dt) <= 0) { const opts = ['clear', 'clear', 'cloudy', 'rain', 'rain', 'snow']; WX.kind = opts[(Math.random() * opts.length) | 0]; WX.next = 180 + Math.random() * 180; }
  } else WX.kind = mode;
  const [tc, tp, ts] = WX_TARGET[WX.kind] || WX_TARGET.clear, k = Math.min(1, dt / 6);
  WX.cloud += (tc - WX.cloud) * k; WX.precip += (tp - WX.precip) * k; WX.snowing += (ts - WX.snowing) * Math.min(1, dt / 2);
  if (dt === 0 && WX.init !== mode) { WX.init = mode; WX.cloud = tc; WX.precip = tp; WX.snowing = ts; WX.wet.value = tp * (1 - ts); WX.snow.value = ts; } // menu: jump straight there
  const raining = WX.precip * (1 - WX.snowing), snowing = WX.precip * WX.snowing;
  WX.wet.value = Math.max(0, Math.min(1, WX.wet.value + (raining > 0.3 ? dt / 25 : -dt / 120)));
  WX.snow.value = Math.max(0, Math.min(1, WX.snow.value + (snowing > 0.3 ? dt / 45 : WX.kind === 'snow' ? 0 : -dt / 240)));
  precipObj.update(raining, snowing);
}
// grip left on the road: wet roads lose some, snow a lot
const wxGrip = () => (1 - 0.18 * WX.wet.value) * (1 - 0.48 * WX.snow.value);
// precipitation: rain streaks (line segments) and snowflakes (points) in a box that wraps around the camera
const precipObj = (() => {
  const BOX = new THREE.Vector3(44, 26, 44), N = isTouch ? 6000 : 12000;
  const seeds = new Float32Array(N * 3); for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  const uni = { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uBox: { value: BOX }, uAmt: { value: 0 }, uWind: { value: new THREE.Vector2(1.5, 0.6) }, uNight: NIGHT, uScale: { value: 400 } };
  const head = 'uniform vec3 uCam; uniform float uTime; uniform vec3 uBox; uniform float uAmt; uniform vec2 uWind; uniform float uNight; uniform float uScale; attribute vec3 seed; varying float vA;\n';
  const wrap = 'vec3 w = uCam + mod(p - uCam, uBox) - uBox * 0.5; w.y += uBox.y * 0.25;\n';
  // rain: two vertices per drop (the second one higher up, back along the fall direction)
  const rg = new THREE.BufferGeometry(), rs = new Float32Array(N * 6), re = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) { rs.set(seeds.subarray(i * 3, i * 3 + 3), i * 6); rs.set(seeds.subarray(i * 3, i * 3 + 3), i * 6 + 3); re[i * 2 + 1] = 1; }
  rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3)); rg.setAttribute('seed', new THREE.BufferAttribute(rs, 3)); rg.setAttribute('endp', new THREE.BufferAttribute(re, 1));
  const rain = new THREE.LineSegments(rg, new THREE.ShaderMaterial({
    uniforms: { ...uni, uAmt: { value: 0 } }, transparent: true, depthWrite: false,
    vertexShader: head + 'attribute float endp; void main(){ if (seed.x * 0.37 + seed.z * 0.63 > uAmt) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }\n vec3 p = seed * uBox; p.y -= uTime * 11.0; p.xz += uWind * uTime;\n' + wrap + ' w += endp * vec3(-uWind.x, 11.0, -uWind.y) * 0.06; vA = 0.36 + 0.3 * (1.0 - uNight); gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }',
    fragmentShader: 'varying float vA; void main(){ gl_FragColor = vec4(0.78, 0.82, 0.88, vA); }',
  }));
  // snow: soft flakes drifting down and swaying
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3)); sg.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));
  const snow = new THREE.Points(sg, new THREE.ShaderMaterial({
    uniforms: { ...uni, uAmt: { value: 0 } }, transparent: true, depthWrite: false,
    vertexShader: head + 'void main(){ if (seed.y * 0.5 + seed.x * 0.5 > uAmt) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }\n vec3 p = seed * uBox; p.y -= uTime * 1.3; p.xz += uWind * uTime * 0.6 + vec2(sin(uTime * 1.1 + seed.z * 40.0), cos(uTime * 0.9 + seed.x * 30.0)) * 0.6;\n' + wrap + ' vec4 mv = viewMatrix * vec4(w, 1.0); gl_PointSize = clamp((0.06 + 0.05 * seed.z) * uScale / max(0.5, -mv.z), 1.5, 7.0); vA = 0.9; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'varying float vA; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; if (d > 1.0) discard; gl_FragColor = vec4(0.97, 0.98, 1.0, vA * (1.0 - d * d)); }',
  }));
  for (const o of [rain, snow]) { o.frustumCulled = false; o.visible = false; o.renderOrder = 5; o.userData.terrBS = true; o.material.userData.terr = true; scene.add(o); }
  return {
    update(r, sn) { rain.visible = r > 0.02; snow.visible = sn > 0.02; rain.material.uniforms.uAmt.value = r; snow.material.uniforms.uAmt.value = sn; }, // each material has its own uAmt
    frame(t) { uni.uTime.value = t % 1000; uni.uCam.value.copy(camera.position); uni.uScale.value = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360)); },
  };
})();
const clockText = () => { const h = Math.floor(tod), m = Math.floor((tod - h) * 60); return `${(h + 11) % 12 + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
// soft radial light textures: a pool under a street light, and a headlight beam on the road
const glowTex = canvasTex(128, 128, (c, w) => { const g = c.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(0, 0, w, w); }, false);
const beamTex = canvasTex(64, 128, (c, w, h) => {
  const id = c.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = y / h, u = Math.abs(x / w - 0.5) * 2, a = Math.pow(1 - v, 1.6) * Math.min(1, v * 8) * Math.max(0, 1 - u * u); const o = (y * w + x) * 4; id.data[o] = id.data[o + 1] = id.data[o + 2] = 255; id.data[o + 3] = a * 255; }
  c.putImageData(id, 0, 0);
}, false);
const nightAdd = (color, map, k) => { const m = new THREE.MeshBasicMaterial({ color, map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -16 }); m.userData.noCast = true; m.userData.nightK = k; return m; };
const poolMat = nightAdd('#ffc27a', glowTex, 0.95), beamMat = nightAdd('#fff0d0', beamTex, 0.5);
// a headlight beam lying on the road: 1.8 m wide at the bumper, ~8 m wide 28 m out
const beamGeo = (() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([-0.9, 0.06, 2.3, 0.9, 0.06, 2.3, 4, 0.06, 30, -4, 0.06, 30], 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute([0.36, 0, 0.64, 0, 1, 1, 0, 1], 2)); g.setIndex([0, 2, 1, 0, 3, 2]); return g; })();
// street-light halos: camera-facing glow sprites sized in metres, lifted onto the terrain
const haloMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 400 }, uNight: NIGHT, ...TU }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: TERR_GLSL + 'uniform float uScale; uniform float uNight; varying float vN; void main(){ vN = uNight; vec4 w = modelMatrix * vec4(position, 1.0); w.y += terrH(w.xz); vec4 mv = viewMatrix * w; gl_PointSize = uNight > 0.01 ? 2.6 * uScale / max(0.5, -mv.z) : 0.0; gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'varying float vN; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; if (d > 1.0) discard; float a = pow(1.0 - d, 2.2); gl_FragColor = vec4(vec3(1.0, 0.86, 0.62) * (a * 1.3 + smoothstep(0.25, 0.0, d)), 1.0) * vN; }',
});
haloMat.userData.terr = true;
// the player's headlights: a real spot light (lights the road, signs and walls), off in daylight
const headL = new THREE.SpotLight('#fff1dc', 0, 140, 0.5, 0.6, 1.25); headL.castShadow = false; scene.add(headL, headL.target);
// hook every material in the scene (new tiles, cars, effects) and widen bounding spheres for the lift;
// solid things cast shadows, flat things (roads, lots, markings) only receive them
function terrainizeScene() {
  scene.traverse(o => {
    if (o.isMesh && !o.userData.shadowSet) {
      o.userData.shadowSet = true; o.receiveShadow = true;
      const g = o.geometry; if (g && !g.boundingBox) g.computeBoundingBox();
      const m = Array.isArray(o.material) ? o.material[0] : o.material, bb = g && g.boundingBox;
      const flat = !o.isInstancedMesh && bb && bb.max.y - bb.min.y < 0.8;
      o.castShadow = o !== ground && !flat && !(m && (m.userData.noCast || m.transparent || m.alphaTest > 0 || m.isMeshBasicMaterial));
      if (o.castShadow) o.customDepthMaterial = terrDepthMat;
    }
    if (o.material) { if (Array.isArray(o.material)) o.material.forEach(terrainize); else terrainize(o.material); }
    if ((o.isMesh || o.isPoints) && !o.userData.terrBS) {
      o.userData.terrBS = true;
      if (o.isInstancedMesh) o.frustumCulled = false;
      else if (o.geometry && !o.geometry.userData.terrBS) { o.geometry.userData.terrBS = true; if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); if (o.geometry.boundingSphere) o.geometry.boundingSphere.radius += 90; }
    }
  });
}
// long straight edges would cut through hills between their ends: split them
function densify(pts, hs, step) {
  const n = pts.length / 2; let need = false;
  for (let i = 0; i < n - 1 && !need; i++) need = Math.hypot(pts[i * 2 + 2] - pts[i * 2], pts[i * 2 + 3] - pts[i * 2 + 1]) > step * 1.5;
  if (!need) return { p: pts, h: hs };
  const p = [], h = hs ? [] : null;
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3], k = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / step));
    for (let s = 0; s < k; s++) { const f = s / k; p.push(ax + (bx - ax) * f, az + (bz - az) * f); if (h) h.push(hs[i] + (hs[i + 1] - hs[i]) * f); }
  }
  p.push(pts[n * 2 - 2], pts[n * 2 - 1]); if (h) h.push(hs[n - 1]);
  return { p, h };
}
// a bridge deck runs straight between its ends instead of following the valley below: heights are pre-compensated
// so that after the shader adds the terrain the deck sits on the line between its abutments
function deckProfile(pts, hs) {
  const n = pts.length / 2, out = Array.from(hs), T = [], cum = [0];
  for (let i = 0; i < n; i++) { T.push(terrainAt(pts[i * 2], pts[i * 2 + 1])); if (i) cum.push(cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1])); }
  for (let i = 0; i < n;) {
    if (hs[i] <= 0.3) { i++; continue; }
    let j = i; while (j + 1 < n && hs[j + 1] > 0.3) j++;
    const a = Math.max(0, i - 1), b = Math.min(n - 1, j + 1), L = cum[b] - cum[a] || 1;
    for (let k = a + 1; k < b; k++) { const lin = T[a] + (T[b] - T[a]) * (cum[k] - cum[a]) / L; out[k] = Math.max(hs[k], hs[k] + lin - T[k]); }
    i = j + 1;
  }
  return out;
}
// split triangles of a flat polygon until no edge is longer than maxE (so big lots and lakes follow the ground)
function subdivTris(contour, tris, maxE) {
  const P = contour.slice(), out = [], mid = new Map();
  const m = (a, b) => { const k = a < b ? a + ',' + b : b + ',' + a; let i = mid.get(k); if (i === undefined) { i = P.length; P.push(new THREE.Vector2((P[a].x + P[b].x) / 2, (P[a].y + P[b].y) / 2)); mid.set(k, i); } return i; };
  const stack = tris.map(t => [t[0], t[1], t[2], 0]);
  while (stack.length) {
    const [a, b, c, d] = stack.pop();
    const ab = P[a].distanceTo(P[b]), bc = P[b].distanceTo(P[c]), ca = P[c].distanceTo(P[a]), mx = Math.max(ab, bc, ca);
    if (mx <= maxE || d > 7 || out.length > 20000) { out.push([a, b, c]); continue; }
    if (mx === ab) { const k = m(a, b); stack.push([a, k, c, d + 1], [k, b, c, d + 1]); }
    else if (mx === bc) { const k = m(b, c); stack.push([a, b, k, d + 1], [a, k, c, d + 1]); }
    else { const k = m(c, a); stack.push([a, b, k, d + 1], [k, b, c, d + 1]); }
  }
  return { pts: P, tris: out };
}

// road textures: one texture per (marking style, lane count). u spans width, v = metres/16
const roadMats = new Map();
// road surface: lanes, shoulders / parking lanes, edge lines, rumble strips and concrete gutters, laid out in
// metres across the full width (u 0 = left edge in the way's direction, 1 = right edge)
function roadMat(spec) {
  const { style, lanes, prio, width, laneW, shL, shR, kind, conc } = spec;
  const key = [style, lanes, prio, width.toFixed(1), shL, shR, kind, conc ? 1 : 0].join(':');
  if (roadMats.has(key)) return roadMats.get(key);
  const PXM = 12, W = Math.max(16, Math.round(width * PXM)), H = 256, X = m => Math.round(m * PXM);
  const tex = canvasTex(W, H, (c) => {
    const base = conc ? '#8b8a85' : style === 'svc' ? '#5d6066' : style === 'minor' ? '#4b4e54' : kind === 'fwy' ? '#43464b' : '#3c3f45';
    noise(c, W, H, base, conc ? 0.08 : 0.12, W * 14);
    const PXV = H / 16; // texture rows per metre along the road
    if (conc) { // concrete slabs: a transverse joint every 4 m, the odd patched or stained slab
      c.fillStyle = 'rgba(0,0,0,.22)'; for (let y = 0; y < H; y += 4 * PXV) c.fillRect(0, y, W, 1.5);
      for (let k = 0; k < 3; k++) { c.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,.07)' : 'rgba(255,255,255,.06)'; const sx = Math.floor(Math.random() * Math.max(1, lanes)), sy = Math.floor(Math.random() * 4); c.fillRect(X(shL) + sx * X(laneW), sy * 4 * PXV, X(laneW), 4 * PXV); }
    } else if (style !== 'svc') {
      // asphalt: patched rectangles and tar-sealed cracks ("tar snakes")
      for (let k = 0; k < (style === 'minor' ? 2 : 1); k++) if (Math.random() < 0.7) { c.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.05)'; c.fillRect(Math.random() * W * 0.7, Math.random() * H * 0.8, W * (0.15 + Math.random() * 0.3), H * (0.06 + Math.random() * 0.12)); }
      c.strokeStyle = 'rgba(15,15,17,.55)'; c.lineWidth = 1.6; c.lineJoin = 'round';
      for (let k = 0; k < 2 + (style === 'minor' ? 2 : 0); k++) { c.beginPath(); let x = Math.random() * W, y = Math.random() * H; c.moveTo(x, y); for (let j = 0; j < 7; j++) { x += (Math.random() - 0.5) * W * 0.25; y += Math.random() * 22; c.lineTo(x, y); } c.stroke(); }
    }
    // tyre wear: darker (asphalt) or polished (concrete) wheel paths in each lane
    if (style !== 'svc' && style !== 'minor') {
      c.fillStyle = conc ? 'rgba(0,0,0,.06)' : 'rgba(0,0,0,.09)';
      for (let i = 0; i < lanes; i++) { const cx = X(shL) + (i + 0.5) * (W - X(shL) - X(shR)) / lanes; for (const o of [-0.85, 0.85]) c.fillRect(cx + X(o) - X(0.35), 0, X(0.7), H); }
    } else if (style === 'minor') { c.fillStyle = 'rgba(0,0,0,.07)'; for (const o of [-2.6, -1, 1, 2.6]) c.fillRect(W / 2 + X(o) - X(0.3), 0, X(0.6), H); }
    const gutter = (x0, x1) => { c.fillStyle = '#8f8c85'; c.fillRect(x0, 0, x1 - x0, H); c.fillStyle = 'rgba(0,0,0,.18)'; for (let y = 0; y < H; y += 32) c.fillRect(x0, y, x1 - x0, 1); };
    if (kind === 'city' || style === 'minor') { gutter(0, X(0.45)); gutter(W - X(0.45), W); } // curb-side concrete gutter
    if (style === 'minor' || style === 'svc') return;
    const dash = (x, col, wd = 3) => { for (let y = 0; y < H; y += 128) { if (conc) { c.fillStyle = 'rgba(30,31,33,.75)'; c.fillRect(x - wd / 2, y + 48, wd, 14); } c.fillStyle = col; c.fillRect(x - wd / 2, y, wd, 48); } }; // contrast tabs on concrete
    const solid = (x, col, wd = 3) => { c.fillStyle = col; c.fillRect(x - wd / 2, 0, wd, H); };
    const WHITE = '#e8e8e8', YEL = '#e3b52c';
    // freeway shoulders: a touch lighter, with rumble strips just outside the edge line
    if (kind === 'fwy') {
      c.fillStyle = 'rgba(255,255,255,.06)'; c.fillRect(0, 0, X(shL), H); c.fillRect(W - X(shR), 0, X(shR), H);
      c.fillStyle = 'rgba(0,0,0,.35)';
      for (let y = 0; y < H; y += 6) { if (shL > 0.8) c.fillRect(X(shL) - X(0.75), y, X(0.45), 2); if (shR > 0.8) c.fillRect(W - X(shR) + X(0.3), y, X(0.45), 2); }
    }
    const L0 = X(shL), L1 = W - X(shR), lw = (L1 - L0) / lanes; // the travel lanes
    const edgeIn = x => Math.min(Math.max(x, 3), W - 3);
    if (style === 'two') {
      if (kind !== 'city') { solid(edgeIn(L0), WHITE, 4); solid(edgeIn(L1), WHITE, 4); }
      if (lanes >= 3 && lanes % 2 === 1) { // centre two-way left-turn lane
        const a = L0 + lw * (lanes - 1) / 2, b = a + lw;
        solid(a + 2, YEL, 2.5); dash(a + 7, YEL, 2.5); solid(b - 2, YEL, 2.5); dash(b - 7, YEL, 2.5);
        for (let i = 1; i < (lanes - 1) / 2; i++) { dash(L0 + lw * i, WHITE); dash(L1 - lw * i, WHITE); }
      } else {
        const per = Math.max(1, Math.floor(lanes / 2)), mid = L0 + lw * per;
        solid(mid - 3, YEL, 2.5); solid(mid + 3, YEL, 2.5);
        for (let i = 1; i < per; i++) { dash(L0 + lw * i, WHITE); dash(L1 - lw * i, WHITE); }
      }
    } else { // one-way (and each side of a divided road): yellow on the left, white on the right
      solid(edgeIn(L0), YEL, 4); solid(edgeIn(L1), WHITE, 4);
      for (let i = 1; i < lanes; i++) dash(L0 + lw * i, WHITE);
    }
  });
  const m = new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -1 - prio, polygonOffsetUnits: -2 - prio * 2 });
  m.userData.snowK = 0.14; m.userData.wetK = 1; // ploughed: only a little slush stays on the road, but it gets properly wet
  m.userData.noCast = true; // road surfaces only receive shadows
  roadMats.set(key, m);
  return m;
}
const waterMat = new THREE.MeshLambertMaterial({ color: '#4f7fa8', polygonOffset: true, polygonOffsetFactor: -0.5, polygonOffsetUnits: -1 });
waterMat.userData.snowK = 0;
const bldMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const walkMat = new THREE.MeshLambertMaterial({ map: canvasTex(64, 64, (c, w, h) => { noise(c, w, h, '#b4b0a7', 0.1, 900); c.fillStyle = 'rgba(0,0,0,.12)'; c.fillRect(0, 0, w, 1); }), polygonOffset: true, polygonOffsetFactor: -0.8, polygonOffsetUnits: -1.5 });
walkMat.userData.snowK = 0.7; walkMat.userData.wetK = 0.6;

// road classes: style family, priority, minimap colour, minimap width, default lanes two-way / one-way
const RC = [
  { st: 'hw', p: 10, c: '#f2a33a', mw: 4.5, l2: 4, l1: 2 },   // motorway
  { st: 'mj', p: 9, c: '#f5bd55', mw: 4, l2: 4, l1: 2 },      // trunk
  { st: 'mj', p: 8, c: '#f8d37a', mw: 3.5, l2: 2, l1: 2 },    // primary
  { st: 'mj', p: 7, c: '#fbe7a8', mw: 3, l2: 2, l1: 2 },      // secondary
  { st: 'mj', p: 6, c: '#ffffff', mw: 2.6, l2: 2, l1: 1 },    // tertiary
  { st: 'minor', p: 4, c: '#ffffff', mw: 2, w: 7.5 },         // unclassified
  { st: 'minor', p: 4, c: '#ffffff', mw: 2, w: 7.5 },         // residential
  { st: 'minor', p: 3, c: '#ffffff', mw: 1.8, w: 6 },         // living street
  { st: 'mj', p: 9.5, c: '#f2a33a', mw: 2.5, l2: 2, l1: 1 },  // motorway_link
  { st: 'mj', p: 8.5, c: '#f5bd55', mw: 2.5, l2: 2, l1: 1 },
  { st: 'mj', p: 7.5, c: '#f8d37a', mw: 2.2, l2: 2, l1: 1 },
  { st: 'mj', p: 6.5, c: '#fbe7a8', mw: 2, l2: 2, l1: 1 },
  { st: 'mj', p: 5.5, c: '#ffffff', mw: 2, l2: 2, l1: 1 },
  { st: 'svc', p: 2, c: '#e9e9e9', mw: 1.3, w: 4.5 },         // service
];
const ROAD_NAMES = ['Freeway', 'Highway', 'Primary road', 'Secondary road', 'Street', 'Road', 'Residential street', 'Street', 'Freeway ramp', 'Highway ramp', 'Ramp', 'Ramp', 'Ramp', 'Service road'];

// real-world cross sections: 3.7 m (12 ft) lanes plus what goes beside them — freeway shoulders (3 m right,
// 1.2–1.8 m left), suburban shoulders, parking lanes with a gutter on city streets, ~9.5 m residential streets
function roadSpec(r) {
  const [c, , , flags, lanesTag] = r;
  const k = RC[c] || RC[6];
  const oneway = flags & 1;
  const minor = (w, st) => ({ width: w, style: st, lanes: 1, prio: k.p, laneW: w / 2, shL: 0, shR: 0, kind: 'minor' });
  if (k.st === 'svc') return minor(lanesTag > 2 ? lanesTag * 3.5 : 5, 'svc');
  if (k.st === 'minor') return minor(lanesTag > 2 ? lanesTag * 3.5 + 4.4 : c === 7 ? 7 : 9.5, 'minor');
  let lanes = lanesTag || (oneway ? k.l1 : k.l2);
  lanes = Math.max(1, Math.min(8, lanes));
  const laneW = 3.7;
  let shL, shR, kind;
  if (c === 0 || c === 1) { kind = 'fwy'; shR = c === 0 ? 3 : 2.6; shL = oneway ? (c === 0 ? 1.8 : 1.2) : shR; }
  else if (c === 8 || c === 9) { kind = 'fwy'; shR = 2.4; shL = oneway ? 1.2 : 2.4; }
  else if (c === 2 || c === 3) { kind = 'sub'; shR = 1.8; shL = oneway ? 0.6 : 1.8; }
  else if (c === 4) { kind = 'city'; shR = 2.4; shL = oneway ? 0.6 : 2.4; }
  else { kind = 'sub'; shR = 1.5; shL = oneway ? 0.6 : 1.5; }
  return { width: lanes * laneW + shL + shR, style: oneway ? 'one' : 'two', lanes, prio: k.p, laneW, shL, shR, kind, conc: c <= 1 }; // MN freeways: mostly concrete
}

// ───────────────────────── geometry builders ─────────────────────────
function freeAfterUpload(g) {
  const free = function () { this.array = null; };
  for (const k in g.attributes) g.attributes[k].onUpload(free);
  if (g.index) g.index.onUpload(free);
}
class GeoBuf {
  constructor() { this.p = []; this.uv = []; this.n = []; this.i = []; this.c = []; this.cl = []; }
  get vc() { return this.p.length / 3; }
  mesh(mat, withColor) {
    if (!this.i.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    if (this.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (this.cl.length) g.setAttribute('aCell', new THREE.Float32BufferAttribute(this.cl, 1));
    g.setIndex(this.vc > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    freeAfterUpload(g); // the GPU keeps its own copy: don't hold every vertex twice (phones run out of memory)
    const m = new THREE.Mesh(g, mat);
    m.matrixAutoUpdate = false;
    return m;
  }
}

function ribbon(buf, pts, width, y, lanes, hs) {
  ({ p: pts, h: hs } = densify(pts, hs, 12)); // follow the terrain between far-apart points
  const n = pts.length / 2; if (n < 2) return;
  const hw = width / 2, base = buf.vc;
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], z = pts[i * 2 + 1];
    // segment directions
    let dx0 = 0, dz0 = 0, dx1 = 0, dz1 = 0;
    if (i > 0) { dx0 = x - pts[i * 2 - 2]; dz0 = z - pts[i * 2 - 1]; const l = Math.hypot(dx0, dz0) || 1; dx0 /= l; dz0 /= l; }
    if (i < n - 1) { dx1 = pts[i * 2 + 2] - x; dz1 = pts[i * 2 + 3] - z; const l = Math.hypot(dx1, dz1) || 1; dx1 /= l; dz1 /= l; }
    if (i === 0) { dx0 = dx1; dz0 = dz1; }
    if (i === n - 1) { dx1 = dx0; dz1 = dz0; }
    let tx = dx0 + dx1, tz = dz0 + dz1; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    // left normal of tangent; miter scale
    let nx = -tz, nz = tx;
    const dot = Math.max(0.35, nx * -dz1 + nz * dx1);
    const s = hw / dot;
    if (i > 0) dist += Math.hypot(x - pts[i * 2 - 2], z - pts[i * 2 - 1]);
    const v = dist / 16;
    const yy = y + (hs ? hs[i] : 0);
    buf.p.push(x + nx * s, yy, z + nz * s, x - nx * s, yy, z - nz * s);
    buf.n.push(0, 1, 0, 0, 1, 0);
    buf.uv.push(lanes, v, 0, v); // the first vertex is on the right of travel: u = 0 is the left edge
  }
  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2;
    buf.i.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

function pushTris(buf, base, contour, tris) {
  for (const t of tris) {
    const a = contour[t[0]], b = contour[t[1]], c = contour[t[2]];
    // y component of (b-a)x(c-a) in x/z plane: up-facing when (bz-az)*(cx-ax) - (bx-ax)*(cz-az) > 0
    const up = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y);
    if (up > 0) buf.i.push(base + t[0], base + t[1], base + t[2]); else buf.i.push(base + t[0], base + t[2], base + t[1]);
  }
}
function polyArea(pts) { let a = 0; const n = pts.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]; } return a / 2; }

function flatPoly(buf, pts, y) {
  const contour = [];
  for (let i = 0; i < pts.length; i += 2) contour.push(new THREE.Vector2(pts[i], pts[i + 1]));
  let tris; try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { return; }
  const sd = subdivTris(contour, tris, 30), base = buf.vc;
  for (const v of sd.pts) { buf.p.push(v.x, y, v.y); buf.n.push(0, 1, 0); }
  pushTris(buf, base, sd.pts, sd.tris);
}

const PAL = [
  ['#d9cbb3', '#c9b79c', '#e8e3d8', '#b9a690', '#a8b4bf', '#d6c3a5', '#9fa89a', '#c7c0b6'],
  ['#c9c2b8', '#b3aea6', '#d8d0c0', '#a59d92', '#bfb6a6'],
  ['#a8acae', '#9aa0a3', '#c2c5c4', '#b0aa9e'],
  ['#b98f74', '#a7a097', '#8f9aa6', '#c4b49b', '#9a7b66'],
  ['#b5806a', '#c2a98b', '#a8927c'],
];
const tmpC = new THREE.Color();
// facades: a 4×3 atlas of wall types, each cell one 4 m bay by one storey (white = tinted by the wall colour).
// The wall's cell index rides along as a vertex attribute; the shader repeats that cell across the wall.
//  0 glass curtain wall · 1 office windows · 2 apartments · 3 masonry (older brick/stone) · 4 storefront
//  5 big-box panels · 6 ribbed metal · 7 loading door · 8 house siding · 9 siding with front door
//  10 garage door · 11 plain (roofs)
const FC = 128;
const facadeTex = canvasTex(FC * 4, FC * 3, (c) => {
  const glass = (x, y, w, h, top = '#7f98ae', bot = '#b2c3d1') => { const g = c.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, top); g.addColorStop(1, bot); c.fillStyle = g; c.fillRect(x, y, w, h); c.fillStyle = 'rgba(255,255,255,.22)'; c.beginPath(); c.moveTo(x, y + h); c.lineTo(x + w * 0.35, y); c.lineTo(x + w * 0.5, y); c.lineTo(x + w * 0.15, y + h); c.fill(); };
  const rect = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
  for (let k = 0; k < 12; k++) {
    const X = (k % 4) * FC, Y = Math.floor(k / 4) * FC;
    c.save(); c.beginPath(); c.rect(X, Y, FC, FC); c.clip(); c.translate(X, Y);
    rect(0, 0, FC, FC, '#ffffff');
    switch (k) {
      case 0: // glass curtain wall: full-height glazing, 1 m mullions, a dark spandrel at each floor
        glass(0, 0, FC, FC, '#6f8aa6', '#9fb6c9'); rect(0, 104, FC, 24, 'rgba(40,52,64,.55)');
        for (let x = 0; x < FC; x += 32) rect(x, 0, 3, FC, 'rgba(60,70,80,.55)'); break;
      case 1: // office: wide punched window with a mullion
        glass(14, 30, 100, 62); rect(62, 30, 4, 62, 'rgba(255,255,255,.45)'); rect(10, 92, 108, 5, 'rgba(0,0,0,.12)'); rect(0, 118, FC, 10, 'rgba(0,0,0,.06)'); break;
      case 2: // apartments: two windows, a balcony rail on one
        glass(14, 34, 40, 58); glass(74, 34, 40, 58); rect(70, 86, 48, 4, 'rgba(40,40,40,.5)'); for (let x = 72; x < 118; x += 6) rect(x, 90, 2, 16, 'rgba(40,40,40,.4)'); rect(68, 104, 52, 4, 'rgba(40,40,40,.45)'); break;
      case 3: // masonry: brick courses, two tall windows with stone sills and lintels
        c.fillStyle = 'rgba(0,0,0,.07)'; for (let y = 0; y < FC; y += 8) c.fillRect(0, y, FC, 1);
        for (const x of [22, 74]) { glass(x, 24, 32, 72, '#5f7183', '#8fa2b3'); rect(x - 4, 96, 40, 6, 'rgba(255,255,255,.7)'); rect(x - 3, 18, 38, 6, 'rgba(255,255,255,.55)'); rect(x + 15, 24, 2, 72, 'rgba(255,255,255,.35)'); } break;
      case 4: // storefront: display glass on a low base, transom, and a sign band
        rect(0, 0, FC, 30, 'rgba(0,0,0,.18)'); rect(0, 30, FC, 6, 'rgba(255,255,255,.6)');
        glass(6, 40, 116, 74, '#4f6577', '#8aa0b2'); rect(62, 40, 4, 74, 'rgba(30,30,30,.6)'); rect(6, 58, 116, 3, 'rgba(30,30,30,.5)');
        rect(0, 114, FC, 14, 'rgba(0,0,0,.28)'); break;
      case 5: // big-box: tilt-up panels, a reveal line near the top
        rect(0, 0, FC, 8, 'rgba(0,0,0,.12)'); rect(0, 22, FC, 3, 'rgba(0,0,0,.10)');
        for (let x = 0; x < FC; x += 64) rect(x, 0, 2, FC, 'rgba(0,0,0,.14)'); rect(0, 120, FC, 8, 'rgba(0,0,0,.08)'); break;
      case 6: // ribbed metal siding with a high strip of clerestory windows
        for (let x = 0; x < FC; x += 8) { rect(x, 0, 3, FC, 'rgba(0,0,0,.10)'); rect(x + 3, 0, 1, FC, 'rgba(255,255,255,.25)'); }
        glass(0, 10, FC, 12, '#6d8093', '#8ea1b2'); for (let x = 0; x < FC; x += 32) rect(x, 10, 2, 12, 'rgba(60,60,60,.6)'); break;
      case 7: // loading dock: roll-up door with slats and a bumper
        for (let x = 0; x < FC; x += 8) { rect(x, 0, 3, FC, 'rgba(0,0,0,.10)'); rect(x + 3, 0, 1, FC, 'rgba(255,255,255,.25)'); }
        rect(18, 30, 92, 98, '#c9c9c4'); for (let y = 32; y < 128; y += 7) rect(18, y, 92, 2, 'rgba(0,0,0,.18)'); rect(14, 26, 100, 5, 'rgba(0,0,0,.45)'); rect(30, 118, 68, 10, '#2a2a2a'); break;
      case 8: case 9: case 10: { // houses: lap siding, trimmed windows (8), a front door (9) or a garage door (10)
        c.fillStyle = 'rgba(0,0,0,.08)'; for (let y = 0; y < FC; y += 7) c.fillRect(0, y, FC, 2);
        rect(0, 120, FC, 8, 'rgba(0,0,0,.18)');
        if (k === 8) { rect(36, 34, 56, 58, '#f6f4ee'); glass(41, 39, 46, 48, '#5c7183', '#90a5b6'); rect(63, 39, 2, 48, '#f6f4ee'); rect(41, 62, 46, 2, '#f6f4ee'); rect(26, 34, 10, 58, 'rgba(40,46,52,.55)'); rect(92, 34, 10, 58, 'rgba(40,46,52,.55)'); }
        else if (k === 9) { rect(14, 30, 40, 92, '#f6f4ee'); rect(19, 35, 30, 87, '#6b3b2e'); rect(42, 78, 4, 4, '#d8c27a'); rect(68, 38, 46, 52, '#f6f4ee'); glass(72, 42, 38, 44, '#5c7183', '#90a5b6'); }
        else { rect(8, 40, 112, 88, '#f3f1ea'); for (let y = 52; y < 128; y += 19) rect(8, y, 112, 2, 'rgba(0,0,0,.18)'); for (let x = 36; x < 120; x += 28) rect(x, 40, 2, 88, 'rgba(0,0,0,.08)'); rect(4, 36, 120, 5, 'rgba(0,0,0,.25)'); }
        break; }
      default: break; // 11: plain
    }
    c.restore();
  }
}, false);
facadeTex.generateMipmaps = true; facadeTex.minFilter = THREE.LinearMipmapLinearFilter;
const facadeMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: facadeTex });
facadeMat.onBeforeCompile = sh => { // pick the wall's atlas cell and repeat it; at night some windows light up
  sh.uniforms.uNight = NIGHT;
  sh.vertexShader = 'attribute float aCell;\nvarying float vCell;\nvarying vec2 vWP;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvCell = aCell; vWP = (modelMatrix * vec4(position, 1.0)).xz;');
  sh.fragmentShader = 'varying float vCell;\nvarying vec2 vWP;\nuniform float uNight;\n' + sh.fragmentShader.replace('#include <map_fragment>', `vec3 winGlow = vec3(0.0);
#ifdef USE_MAP
  float cl = floor(vCell + 0.5); vec2 cellO = vec2(cl - 4.0 * floor(cl / 4.0 + 0.01), 2.0 - floor(cl / 4.0 + 0.01));
  vec2 fu = (fract(vMapUv) * 0.96 + 0.02 + cellO) / vec2(4.0, 3.0);
  vec4 fTex = textureGrad(map, fu, dFdx(vMapUv) / vec2(4.0, 3.0), dFdy(vMapUv) / vec2(4.0, 3.0));
  diffuseColor *= fTex;
  if (uNight > 0.01) { // glass (the bluish texels) glows in roughly 40% of the windows, warm or cool
    float glass = smoothstep(0.07, 0.15, fTex.b - fTex.r);
    vec2 id = floor(vMapUv) + floor(vWP / 37.0) * 17.0;
    float r1 = fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453), r2 = fract(r1 * 57.31);
    float lit = step(r1, 0.42 + 0.1 * step(7.5, cl));
    winGlow = glass * lit * uNight * mix(vec3(1.0, 0.78, 0.48), vec3(0.78, 0.86, 1.0), step(0.7, r2)) * (0.75 + 0.5 * r2);
  }
#endif`).replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += winGlow;');
};
facadeMat.customProgramCacheKey = () => 'facade-atlas-n';
const ROOF_PAL = ['#3f4146', '#4d4038', '#5a5c60', '#6a5545', '#384048', '#7b4a3a', '#4a4f45'];
const HOUSE_PAL = ['#e8e3d8', '#d9cbb3', '#c7b9a0', '#a8b4bf', '#b9c2b0', '#d6c3a5', '#f0ece2', '#9fb0bf', '#c9a98a', '#8e9c8a'];
// one triangle with its own flat normal; up=true flips it so it faces the sky
function tri3(buf, a, b, c, rgb, f, up = true) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (up && ny < 0) { nx = -nx; ny = -ny; nz = -nz; [b, c] = [c, b]; }
  const l = Math.hypot(nx, ny, nz) || 1, base = buf.vc;
  buf.p.push(...a, ...b, ...c);
  for (let k = 0; k < 3; k++) { buf.n.push(nx / l, ny / l, nz / l); buf.c.push(rgb[0] * f, rgb[1] * f, rgb[2] * f); if (buf.facade) { buf.uv.push(0.02, 0.02); buf.cl.push(11); } }
  buf.i.push(base, base + 1, base + 2);
}
const rgbOf = c => { tmpC.set(c); return [tmpC.r, tmpC.g, tmpC.b]; };
// which wall cells a building gets: up = upper floors, gr = ground floor (gH tall), fH = storey height,
// grLong = ground-floor cell only on the front (longest) wall, long = special cell for the front wall
const FAC_DEFAULT = { up: 1, fH: 3.4 };
function facadeFor(tag, kind, top, area) {
  if (tag === 'garage' || tag === 'garages' || tag === 'carport') return { up: 8, gr: 10, gH: 3, grLong: true, fH: 3 };
  if (tag === 'shed') return { up: 8, fH: 3 };
  if (kind === 0 && top < 10) return { up: 8, gr: 9, gH: 2.9, grLong: true, fH: 2.9 }; // front door on the long side
  if (kind === 2 || tag === 'warehouse' || tag === 'industrial' || tag === 'manufacture' || tag === 'hangar') return { up: 6, gr: 7, gH: 4.6, grLong: true, fH: 4.5 };
  if (tag === 'hotel') return { up: 2, gr: 4, gH: 4.8, fH: 3.2 };
  if (tag === 'retail' || tag === 'supermarket' || tag === 'commercial' || tag === 'kiosk') {
    if (area > 2500) return { up: 5, gr: 4, gH: 4.8, grLong: true, fH: 4 };
    return top > 7 ? { up: 3, gr: 4, gH: 4.5, fH: 3.4 } : { up: 3, gr: 4, gH: 9, fH: 3.4 };
  }
  if (tag === 'office') return top > 40 ? { up: 0, fH: 3.8 } : { up: 1, gr: top > 12 ? 4 : 1, gH: 4.8, fH: 3.6 };
  if (tag === 'apartments' || tag === 'dormitory' || tag === 'residential') return top > 45 ? { up: 0, fH: 3.2 } : { up: 2, gr: top > 14 && area < 4000 ? 4 : 2, gH: 4.5, fH: 3.1 };
  if (kind === 4) return { up: 3, fH: 4 };
  if (top > 40) return { up: 0, fH: 3.8 };
  if (top < 8) return area > 2500 ? { up: 5, gr: 4, gH: 4.8, grLong: true, fH: 4 } : { up: 3, gr: 4, gH: 9, fH: 3.4 };
  return { up: 1, gr: 4, gH: 4.8, fH: 3.5 };
}
// o: { holes, shape: flat|skillion|pyramidal|dome|bowl|hipped, roofH, dir (compass deg the slope faces), roofTint(t)->rgb, part, fac }
function building(buf, pts, h, kind, seed, minH = 0, wallCol = '', roofCol = '', o = {}) {
  if (polyArea(pts) < 0) pts = revRing(pts); // consistent winding so walls face outward
  const holes = (o.holes || []).filter(r => r.length >= 6).map(r => polyArea(r) > 0 ? revRing(r) : r);
  const facade = buf.facade; // true → this buffer carries UVs for the window texture
  const pal = o.part ? (h > 45 ? ['#7f8fa1', '#8a9aa8', '#6e7c8c', '#a3adb6'] : PAL[1])
    : minH > 0 ? ['#7d97ad', '#8ba3b6', '#6f8aa1'] : h > 45 ? ['#7f8fa1', '#8a9aa8', '#6e7c8c', '#a3adb6'] : kind === 0 ? HOUSE_PAL : PAL[kind] || PAL[0];
  tmpC.set(wallCol || pal[seed % pal.length]);
  const wr = tmpC.r, wg = tmpC.g, wb = tmpC.b;
  const n = pts.length / 2;
  let cx = 0, cz = 0; for (let i = 0; i < n; i++) { cx += pts[i * 2]; cz += pts[i * 2 + 1]; } cx /= n; cz /= n;
  let shape = o.shape || '';
  if (shape === 'onion') shape = 'dome';
  if (shape === 'pyramid' || shape === 'cone') shape = 'pyramidal';
  if (shape === 'round' || shape === 'gambrel') shape = 'barrel';
  const isHouseRoof = kind === 0 && !minH && h < 10 && n <= 12 && !holes.length && (!shape || shape === 'hipped' || shape === 'gabled');
  let roofH = o.roofH || 0;
  if (!isHouseRoof && shape && shape !== 'flat' && shape !== 'bowl') {
    let r = 0; for (let i = 0; i < n; i++) r = Math.max(r, Math.hypot(pts[i * 2] - cx, pts[i * 2 + 1] - cz));
    if (!roofH) roofH = shape === 'dome' ? r * 0.85 : shape === 'skillion' ? Math.min(4, (h - minH) * 0.3) : Math.min(r * 0.5, (h - minH) * 0.4);
    roofH = Math.min(roofH, (h - minH) * 0.95);
    if (shape !== 'skillion' && shape !== 'dome' && shape !== 'pyramidal' && shape !== 'barrel') shape = 'pyramidal'; // gabled/hipped on big buildings: close enough
  } else if (!isHouseRoof && shape !== 'bowl') shape = 'flat';
  // skillion slope: downhill along compass dir (north = -z, east = +x)
  let Dx = 0, Dz = 1, s0 = 0, s1 = 1;
  if (shape === 'skillion') {
    const d = (o.dir >= 0 ? o.dir : 180) * Math.PI / 180; Dx = Math.sin(d); Dz = -Math.cos(d);
    s0 = 1e9; s1 = -1e9; for (let i = 0; i < n; i++) { const s = pts[i * 2] * Dx + pts[i * 2 + 1] * Dz; s0 = Math.min(s0, s); s1 = Math.max(s1, s); }
    if (s1 - s0 < 1) s1 = s0 + 1;
  }
  const slopeT = (x, z) => (x * Dx + z * Dz - s0) / (s1 - s0);
  const topAt = shape === 'skillion' ? (x, z) => h - roofH * slopeT(x, z) : shape === 'flat' || shape === 'bowl' || isHouseRoof ? () => h : () => h - roofH;
  // walls (outer ring + courtyards); the longest outer wall is treated as the front (entrance, loading doors)
  let longest = 0; { let bl = -1; for (let i = 0; i < n; i++) { const j = (i + 1) % n, L = Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]); if (L > bl) { bl = L; longest = i; } } }
  for (const ring of [pts, ...holes]) {
    const m = ring.length / 2; let u = 0;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
      let nx = bz - az, nz = -(bx - ax); const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
      const shade = 0.82 + 0.18 * Math.abs(nx);
      const ta = topAt(ax, az), tb = topAt(bx, bz);
      // one wall band from y0 up to (ya, yb); facade buffers carry bay/storey UVs and the atlas cell
      const band = (y0, ya, yb, cell, fh, vOff) => {
        const base = buf.vc;
        buf.p.push(ax, y0, az, bx, y0, bz, bx, yb, bz, ax, ya, az);
        for (let k = 0; k < 4; k++) { buf.n.push(nx, 0, nz); const f = (k < 2 ? (y0 <= minH + 0.01 ? 0.86 : 0.97) : 1) * shade; buf.c.push(wr * f, wg * f, wb * f); }
        if (facade) { const u1 = u + Math.max(0.25, Math.round(l / 4 * 4) / 4); buf.uv.push(u, (y0 - vOff) / fh, u1, (y0 - vOff) / fh, u1, (yb - vOff) / fh, u, (ya - vOff) / fh); for (let k = 0; k < 4; k++) buf.cl.push(cell); }
        buf.i.push(base, base + 2, base + 1, base, base + 3, base + 2);
      };
      const F = o.fac || FAC_DEFAULT;
      let up = F.up, gr = F.gr ?? F.up;
      if (ring === pts && i === longest) { if (F.long !== undefined) { gr = F.long; if (F.longAll) up = F.long; } }
      else if (F.grLong) gr = up;
      const gH = F.gH || 0, fH = F.fH || 3.4;
      if (facade && gr !== up && gH > 0 && minH === 0 && Math.min(ta, tb) > gH + 1.5) { band(minH, gH, gH, gr, gH, 0); band(gH, ta, tb, up, fH, gH); }
      else if (facade && gr !== up && minH === 0 && Math.max(ta, tb) <= gH + 1.5) band(minH, ta, tb, gr, Math.max(2.6, Math.max(ta, tb)), 0); // one-storey: the whole wall is the ground floor
      else band(minH, ta, tb, up, fH, 0);
      if (facade) u += Math.max(0.25, Math.round(l / 4 * 4) / 4);
    }
  }
  const contour = [];
  for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(pts[i * 2], pts[i * 2 + 1]));
  const roofRGB = roofCol ? rgbOf(roofCol) : kind === 0 ? rgbOf(ROOF_PAL[(seed >> 3) % ROOF_PAL.length]) : [wr * 0.78, wg * 0.78, wb * 0.78];
  if (isHouseRoof) {
    // houses get a hip roof over their oriented bounding box
    let bl = 0, ax = 1, az = 0;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n, dx = pts[j * 2] - pts[i * 2], dz = pts[j * 2 + 1] - pts[i * 2 + 1], L = Math.hypot(dx, dz); if (L > bl) { bl = L; ax = dx / L; az = dz / L; } }
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (let i = 0; i < n; i++) { const pu = pts[i * 2] * ax + pts[i * 2 + 1] * az, pv = -pts[i * 2] * az + pts[i * 2 + 1] * ax; u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); v0 = Math.min(v0, pv); v1 = Math.max(v1, pv); }
    const ov = 0.45; u0 -= ov; u1 += ov; v0 -= ov; v1 += ov;
    const lu = u1 - u0, lv = v1 - v0;
    const W = (pu, pv, y) => [pu * ax - pv * az, y, pu * az + pv * ax];
    const shortS = Math.min(lu, lv), rise = Math.min(3.6, shortS * 0.38), half = shortS / 2;
    const rc = roofRGB;
    const A = W(u0, v0, h), Bc = W(u1, v0, h), C = W(u1, v1, h), D = W(u0, v1, h);
    let R1, R2;
    if (lu >= lv) { const vm = (v0 + v1) / 2; R1 = W(u0 + Math.min(half, lu / 2), vm, h + rise); R2 = W(u1 - Math.min(half, lu / 2), vm, h + rise); }
    else { const um = (u0 + u1) / 2; R1 = W(um, v0 + Math.min(half, lv / 2), h + rise); R2 = W(um, v1 - Math.min(half, lv / 2), h + rise); }
    const tri = (a, b, c, f) => tri3(buf, a, b, c, rc, f);
    if (lu >= lv) { tri(A, Bc, R2, 1); tri(A, R2, R1, 1); tri(C, D, R1, 0.85); tri(C, R1, R2, 0.85); tri(Bc, C, R2, 0.92); tri(D, A, R1, 0.92); }
    else { tri(Bc, C, R2, 1); tri(Bc, R2, R1, 1); tri(D, A, R1, 0.85); tri(D, R1, R2, 0.85); tri(A, Bc, R1, 0.92); tri(C, D, R2, 0.92); }
    return;
  }
  if (shape === 'barrel') { // arched roof over the long axis (Williams Arena, hangars)
    let bl = 0, ax = 1, az = 0;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n, dx = pts[j * 2] - pts[i * 2], dz = pts[j * 2 + 1] - pts[i * 2 + 1], L = Math.hypot(dx, dz); if (L > bl) { bl = L; ax = dx / L; az = dz / L; } }
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (let i = 0; i < n; i++) { const pu = pts[i * 2] * ax + pts[i * 2 + 1] * az, pv = -pts[i * 2] * az + pts[i * 2 + 1] * ax; u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); v0 = Math.min(v0, pv); v1 = Math.max(v1, pv); }
    if (u1 - u0 < v1 - v0) { [ax, az] = [-az, ax]; [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; } // arch spans the short side
    const W = (pu, pv, y) => [pu * ax - pv * az, y, pu * az + pv * ax];
    const K = 8, b0 = h - roofH, prof = [];
    for (let k = 0; k <= K; k++) prof.push([v0 + (v1 - v0) * k / K, b0 + roofH * Math.sin(Math.PI * k / K)]);
    for (let k = 0; k < K; k++) {
      const [va, ya] = prof[k], [vb, yb] = prof[k + 1], f = 0.82 + 0.18 * Math.abs(Math.cos(Math.PI * (k + 0.5) / K));
      tri3(buf, W(u0, va, ya), W(u1, va, ya), W(u1, vb, yb), roofRGB, f); tri3(buf, W(u0, va, ya), W(u1, vb, yb), W(u0, vb, yb), roofRGB, f);
      for (const u of [u0, u1]) { // end walls under the arch, both faces
        const A = W(u, va, ya), B = W(u, vb, yb), C = W(u, (v0 + v1) / 2, b0);
        tri3(buf, A, B, C, [wr, wg, wb], 0.9, false); tri3(buf, A, C, B, [wr, wg, wb], 0.9, false);
      }
    }
    return;
  }
  if (shape === 'pyramidal' || shape === 'dome') {
    const b0 = h - roofH, apex = [cx, h, cz];
    if (shape === 'pyramidal') {
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; tri3(buf, [pts[i * 2], b0, pts[i * 2 + 1]], [pts[j * 2], b0, pts[j * 2 + 1]], apex, roofRGB, 0.85 + 0.15 * ((i & 1))); }
    } else {
      const K = 7; let prev = null;
      for (let k = 0; k <= K; k++) {
        const th = k / K * Math.PI / 2, sc = Math.cos(th), y = b0 + roofH * Math.sin(th);
        const ring = []; for (let i = 0; i < n; i++) ring.push([cx + (pts[i * 2] - cx) * sc, y, cz + (pts[i * 2 + 1] - cz) * sc]);
        if (prev) for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, f = 0.8 + 0.2 * Math.sin(th);
          if (k === K) tri3(buf, prev[i], prev[j], apex, roofRGB, f);
          else { tri3(buf, prev[i], prev[j], ring[j], roofRGB, f); tri3(buf, prev[i], ring[j], ring[i], roofRGB, f); }
        }
        prev = ring;
      }
    }
    return;
  }
  if (shape === 'bowl') { // open-air stadium: stands slope down to a grass field
    const sc = 0.62, low = 3, inner = [];
    for (let i = 0; i < n; i++) inner.push([cx + (pts[i * 2] - cx) * sc, low, cz + (pts[i * 2 + 1] - cz) * sc]);
    const seat = rgbOf(roofCol || '#59626b'), field = rgbOf('#4f8f3e');
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, A = [pts[i * 2], h, pts[i * 2 + 1]], B2 = [pts[j * 2], h, pts[j * 2 + 1]];
      tri3(buf, A, B2, inner[j], seat, 0.9); tri3(buf, A, inner[j], inner[i], seat, 0.9);
      const a0 = [inner[i][0], 0.25, inner[i][2]], b0 = [inner[j][0], 0.25, inner[j][2]];
      tri3(buf, inner[i], b0, inner[j], [wr, wg, wb], 0.7, false); tri3(buf, inner[i], a0, b0, [wr, wg, wb], 0.7, false);
    }
    let tris; try { tris = THREE.ShapeUtils.triangulateShape(inner.map(v => new THREE.Vector2(v[0], v[2])), []); } catch { return; }
    for (const t of tris) tri3(buf, [inner[t[0]][0], 0.25, inner[t[0]][2]], [inner[t[1]][0], 0.25, inner[t[1]][2]], [inner[t[2]][0], 0.25, inner[t[2]][2]], field, 1);
    return;
  }
  // flat or single-slope roof (with courtyards)
  const holeV = holes.map(r => { const a = []; for (let i = 0; i < r.length; i += 2) a.push(new THREE.Vector2(r[i], r[i + 1])); return a; });
  let tris; try { tris = THREE.ShapeUtils.triangulateShape(contour, holeV); } catch { return; }
  const all = contour.concat(...holeV);
  const base = buf.vc;
  let nx = 0, ny = 1, nz = 0;
  if (shape === 'skillion') { const k = roofH / (s1 - s0), l = Math.hypot(k, 1); nx = Dx * k / l; ny = 1 / l; nz = Dz * k / l; }
  for (const v of all) {
    const rgb = o.roofTint ? o.roofTint(shape === 'skillion' ? slopeT(v.x, v.y) : 0) : roofRGB;
    buf.p.push(v.x, topAt(v.x, v.y), v.y); buf.n.push(nx, ny, nz); buf.c.push(rgb[0], rgb[1], rgb[2]); if (facade) { buf.uv.push(0.02, 0.02); buf.cl.push(11); }
  }
  pushTris(buf, base, all, tris);
  if (minH > 0) { // underside, facing down
    const b2 = buf.vc;
    for (const v of all) { buf.p.push(v.x, minH, v.y); buf.n.push(0, -1, 0); buf.c.push(wr * 0.55, wg * 0.55, wb * 0.55); if (facade) { buf.uv.push(0.02, 0.02); buf.cl.push(11); } }
    const i0 = buf.i.length; pushTris(buf, b2, all, tris);
    for (let k = i0; k < buf.i.length; k += 3) { const tmp = buf.i[k + 1]; buf.i[k + 1] = buf.i[k + 2]; buf.i[k + 2] = tmp; }
  }
}
const NOFACADE_TAGS = new Set(['roof', 'storage_tank', 'silo', 'grandstand', 'parking', 'stadium', 'bridge']);
// soft dark band on the ground around a building's base (contact shading)
const aoMat = new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -0.9, polygonOffsetUnits: -1.8,
  map: canvasTex(4, 64, (c, w, h) => { const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.55, 'rgba(0,0,0,.12)'); g.addColorStop(1, 'rgba(0,0,0,.42)'); c.fillStyle = g; c.fillRect(0, 0, w, h); }, false) });
function aoStrip(buf, pts, w = 2.6) {
  if (polyArea(pts) < 0) pts = revRing(pts);
  const n = pts.length / 2, y = 0.05;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[j * 2], bz = pts[j * 2 + 1];
    let nx = bz - az, nz = -(bx - ax); const l = Math.hypot(nx, nz); if (l < 0.5) continue; nx /= l; nz /= l;
    const base = buf.vc;
    buf.p.push(ax, y, az, bx, y, bz, bx + nx * w, y, bz + nz * w, ax + nx * w, y, az + nz * w);
    buf.n.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0); buf.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    const up = (bz - az) * (nx * w) - (bx - ax) * (nz * w); // orientation of (A, B, B') seen from above
    if (up > 0) buf.i.push(base, base + 1, base + 2, base, base + 2, base + 3); else buf.i.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
}
function edgeDist(x, z, pts) { let d = 1e9; const n = pts.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n, ax = pts[i * 2], az = pts[i * 2 + 1], ex = pts[j * 2] - ax, ez = pts[j * 2 + 1] - az, L2 = ex * ex + ez * ez || 1; let u = ((x - ax) * ex + (z - az) * ez) / L2; u = Math.max(0, Math.min(1, u)); d = Math.min(d, Math.hypot(ax + ex * u - x, az + ez * u - z)); } return d; }
function longAxis(pts) { let bl = 0, ux = 1, uz = 0; const n = pts.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n, dx = pts[j * 2] - pts[i * 2], dz = pts[j * 2 + 1] - pts[i * 2 + 1], L = Math.hypot(dx, dz); if (L > bl) { bl = L; ux = dx / L; uz = dz / L; } } return [ux, uz, bl]; }
// flat commercial roofs: a parapet lip, rooftop HVAC units, and a mechanical penthouse on tall buildings
const PARAPET = rgbOf('#8f9294'), RTU = [rgbOf('#c9cccd'), rgbOf('#aeb2b4'), rgbOf('#d6d4cc')];
function roofDetails(buf, pts, top, area, seed) {
  if (polyArea(pts) < 0) pts = revRing(pts);
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[j * 2], bz = pts[j * 2 + 1];
    let nx = bz - az, nz = -(bx - ax); const l = Math.hypot(nx, nz); if (l < 0.5) continue; nx /= l; nz /= l;
    const ix = -nx * 0.3, iz = -nz * 0.3, H = top + 0.75;
    quadN(buf, [ax, top, az], [bx, top, bz], [bx, H, bz], [ax, H, az], [nx, 0, nz], PARAPET, 0.95);
    quadN(buf, [ax + ix, top, az + iz], [bx + ix, top, bz + iz], [bx + ix, H, bz + iz], [ax + ix, H, az + iz], [-nx, 0, -nz], PARAPET, 0.8);
    quadN(buf, [ax, H, az], [bx, H, bz], [bx + ix, H, bz + iz], [ax + ix, H, az + iz], [0, 1, 0], PARAPET, 1.08);
  }
  const b = bboxOf(pts), [ux, uz] = longAxis(pts); let r = seed | 1;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const want = Math.min(7, 1 + Math.floor(area / 650));
  for (let q = 0, tries = 0; q < want && tries < 40; tries++) {
    const x = b[0] + rnd() * (b[2] - b[0]), z = b[1] + rnd() * (b[3] - b[1]);
    if (!pointInPoly(x, z, pts) || edgeDist(x, z, pts) < 3.5) continue;
    const w = 0.9 + rnd() * 1.8, d = 0.8 + rnd() * 1.3, hh = 0.9 + rnd() * 1.2;
    boxY(buf, x, z, ux, uz, w, d, top, top + hh, RTU[q % 3]);
    q++;
  }
  if (top > 28 && area > 500) { // elevator / mechanical penthouse
    let cx = 0, cz = 0; for (let i = 0; i < n; i++) { cx += pts[i * 2]; cz += pts[i * 2 + 1]; } cx /= n; cz /= n;
    if (pointInPoly(cx, cz, pts)) { const s0 = Math.sqrt(area); boxY(buf, cx, cz, ux, uz, Math.min(14, s0 * 0.16), Math.min(10, s0 * 0.12), top, top + 4.2, PARAPET); }
  }
}
const CHIMNEY = rgbOf('#7a4a3b');
function chimney(buf, pts, top, seed) {
  const n = pts.length / 2, [ux, uz, L] = longAxis(pts);
  let cx = 0, cz = 0; for (let i = 0; i < n; i++) { cx += pts[i * 2]; cz += pts[i * 2 + 1]; } cx /= n; cz /= n;
  const off = ((seed >> 2) & 1 ? 1 : -1) * L * 0.3, x = cx + ux * off, z = cz + uz * off;
  if (pointInPoly(x, z, pts)) boxY(buf, x, z, ux, uz, 0.42, 0.42, top - 0.4, top + 3.9, CHIMNEY);
}
function revRing(p) { const r = []; for (let i = p.length - 2; i >= 0; i -= 2) r.push(p[i], p[i + 1]); return r; }
// does a street (or road tunnel) run through this footprint? (skyways, buildings built over a road)
function spansRoad(t0, pts, box) {
  const n = pts.length / 2;
  // the street may belong to the neighbouring tile (buildings near a tile edge)
  const grids = [t0.roadGrid]; for (const [, o] of tiles) if (o !== t0 && o.roadGrid && Math.abs(o.tx - t0.tx) <= 1 && Math.abs(o.ty - t0.ty) <= 1) grids.push(o.roadGrid);
  for (const grid of grids)
  for (let cx = Math.floor(box[0] / CELL); cx <= Math.floor(box[2] / CELL); cx++) for (let cz = Math.floor(box[1] / CELL); cz <= Math.floor(box[3] / CELL); cz++) {
    const a = grid.get(ck(cx, cz)); if (!a) continue;
    for (const ref of a) {
      const r = ref.road; if (r.c > 12 || r.sunk) continue; // ignore service roads and sunken freeways
      const q = r.pts, s = ref.s, ax = q[s * 2], az = q[s * 2 + 1], bx = q[s * 2 + 2], bz = q[s * 2 + 3];
      const pad = (r.flags & 4) ? r.w / 2 : 0; // tunnels: anything overlapping the roadway counts
      if (Math.max(ax, bx) < box[0] - pad || Math.min(ax, bx) > box[2] + pad || Math.max(az, bz) < box[1] - pad || Math.min(az, bz) > box[3] + pad) continue;
      if (pointInPoly((ax + bx) / 2, (az + bz) / 2, pts) || pointInPoly(ax, az, pts) && pointInPoly(bx, bz, pts)) return true;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; if (segCross(ax, az, bx, bz, pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1])) return true; }
      if (pad) { // building corner sitting on the tunnel roadway
        const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
        for (let i = 0; i < n; i++) {
          const px = pts[i * 2], pz = pts[i * 2 + 1];
          let u = ((px - ax) * ex + (pz - az) * ez) / L2; u = Math.max(0, Math.min(1, u));
          if (Math.hypot(px - ax - ex * u, pz - az - ez * u) < pad - 0.5) return true;
        }
      }
    }
  }
  return false;
}

// ───────────────────────── elevation: bridges, overpasses & ramps ─────────────────────────
const DECK = 7;       // metres per bridge layer
const GRADE = 0.06;   // approach ramp slope (6%)
const TUN_CEIL = 6;  // tunnel ceiling above the road
const TRENCH = 6.5;  // depth of sunken freeways and freeway tunnels below street level
const SINKABLE = new Set([0, 1, 8, 9]); // motorway, trunk and their ramps can dip below ground
function segCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx), d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax), d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return ((d1 > 0.01 && d2 < -0.01) || (d1 < -0.01 && d2 > 0.01)) && ((d3 > 0.01 && d4 < -0.01) || (d3 < -0.01 && d4 > 0.01));
}
// roads: [{ pts, flags, layer }]; grid: segment grid of the tile. Returns Float32Array heights per road.
const CLEAR = 5.5;    // headroom kept under a bridge
const RANK = [0, 1, 2, 3, 4, 5, 5, 5, 6, 6, 6, 6, 6, 7]; // importance by road class (motorway … service)
function computeHeights(roads, grid) {
  const keyOf = (x, z) => Math.round(x * 2) + ',' + Math.round(z * 2);
  const nodeId = new Map(); const adj = []; const rank = [];
  const ids = roads.map(r => {
    const p = r.pts, a = new Int32Array(p.length / 2), rk = RANK[r.c] ?? 7;
    for (let i = 0; i < a.length; i++) {
      const k = keyOf(p[i * 2], p[i * 2 + 1]); let id = nodeId.get(k);
      if (id === undefined) { id = adj.length; nodeId.set(k, id); adj.push([]); rank.push(rk); } else rank[id] = Math.min(rank[id], rk);
      a[i] = id;
    }
    for (let i = 0; i < a.length - 1; i++) { const d = Math.hypot(p[i * 2 + 2] - p[i * 2], p[i * 2 + 3] - p[i * 2 + 1]); adj[a[i]].push(a[i + 1], d); adj[a[i + 1]].push(a[i], d); }
    return a;
  });
  const N = adj.length, idxOf = new Map(roads.map((r, i) => [r.obj || r, i]));
  const deck = new Float64Array(N), deckRank = new Uint8Array(N).fill(9); // fixed bridge-deck heights
  const locked = new Uint8Array(N);   // tunnel nodes: fixed at ground
  const pinU = new Float64Array(N).fill(1e9); // ceilings under bridges
  const layerOf = r => Math.max(1, (r.flags >> 3) & 7);
  // visit every proper crossing between segment s of road ri and other roads
  const crossings = (ri, fn) => {
    const r = roads[ri], p = r.pts;
    for (let s = 0; s < p.length / 2 - 1; s++) {
      const ax = p[s * 2], az = p[s * 2 + 1], bx = p[s * 2 + 2], bz = p[s * 2 + 3];
      for (let cx = Math.floor(Math.min(ax, bx) / CELL); cx <= Math.floor(Math.max(ax, bx) / CELL); cx++) for (let cz = Math.floor(Math.min(az, bz) / CELL); cz <= Math.floor(Math.max(az, bz) / CELL); cz++) {
        const cell = grid.get(ck(cx, cz)); if (!cell) continue;
        for (const ref of cell) {
          const o = ref.road; if (o === (r.obj || r)) continue;
          const oi = idxOf.get(o); if (oi === undefined) continue;
          const q = o.pts, t = ref.s;
          const a0 = ids[ri][s], a1 = ids[ri][s + 1], b0 = ids[oi][t], b1 = ids[oi][t + 1];
          if (a0 === b0 || a0 === b1 || a1 === b0 || a1 === b1) continue; // they meet at a junction
          if (!segCross(ax, az, bx, bz, q[t * 2], q[t * 2 + 1], q[t * 2 + 2], q[t * 2 + 3])) continue;
          const ex = bx - ax, ez = bz - az, fx = q[t * 2 + 2] - q[t * 2], fz = q[t * 2 + 3] - q[t * 2 + 1], den = ex * fz - ez * fx;
          const u = Math.abs(den) < 1e-9 ? 0.5 : ((q[t * 2] - ax) * fz - (q[t * 2 + 1] - az) * fx) / den;
          const v = Math.abs(den) < 1e-9 ? 0.5 : ((q[t * 2] - ax) * ez - (q[t * 2 + 1] - az) * ex) / den;
          fn(s, oi, t, u, v);
        }
      }
    }
  };
  const setDeck = (ri, h) => { const rk = RANK[roads[ri].c] ?? 7; roads[ri].raised = true; roads[ri].deckH = h; for (const id of ids[ri]) { if (h > deck[id]) deck[id] = h; deckRank[id] = Math.min(deckRank[id], rk); } };
  // 1) freeway tunnels sit below street level (city-street "tunnels" under buildings stay at grade)
  const sink = new Float64Array(N); // fixed below-ground heights (negative)
  // only freeway-ish nodes (no city street meeting there) may dip below ground
  const canSink = new Uint8Array(N);
  roads.forEach((r, ri) => { r.tunnel = !!((r.flags & 4) && SINKABLE.has(r.c)); for (const id of ids[ri]) canSink[id] = canSink[id] === 2 ? 2 : SINKABLE.has(r.c) ? 1 : 2; });
  // service drives / parking aisles (and nothing else) at a node: those may dip under a bridge instead of raising it
  const canDip = new Uint8Array(N).fill(1);
  roads.forEach((r, ri) => { if (r.c !== 13) for (const id of ids[ri]) canDip[id] = 0; });
  const trenchCand = []; // [street bridge, freeway, segment] — decided after the bridges are placed
  // 2) a bridge is raised only if it passes over another road (creek culverts stay flat) — but a city street
  //    bridging a freeway stays at grade and the freeway drops into a trench instead (the usual urban layout)
  roads.forEach((r, ri) => {
    if (!(r.flags & 2)) return;
    const layer = layerOf(r); let crosses = false;
    crossings(ri, (s, oi, t) => {
      const o = roads[oi]; if ((o.flags & 2) && layerOf(o) >= layer) return;
      if (o.tunnel) return; // already underground
      if (o.c === 13 && r.c !== 13) return; // a driveway or parking aisle under the bridge dips instead (step 4)
      if (layer === 1 && r.c >= 2 && r.c <= 7 && SINKABLE.has(o.c) && !(o.flags & 2)) { trenchCand.push([ri, oi, t]); return; }
      crosses = true;
    });
    if (crosses) setDeck(ri, DECK * layer);
  });
  // graph distance to the nearest bridge deck / nearest city-street junction (limits how close a dip can start)
  const dijkstra = (seed, through, maxD) => {
    const dist = new Float64Array(N).fill(1e9), hp = [];
    for (let i = 0; i < N; i++) if (seed(i)) { dist[i] = 0; mpushD(hp, 0, i); }
    while (hp.length) { const [d, id] = mpopD(hp); if (d > dist[id] + 1e-9 || d > maxD) continue; const a = adj[id]; for (let k = 0; k < a.length; k += 2) { const v = a[k]; if (!through(v)) continue; const nd = d + a[k + 1]; if (nd < dist[v] - 0.01) { dist[v] = nd; mpushD(hp, nd, v); } } }
    return dist;
  };
  const nearDeck = dijkstra(i => deck[i] > 0, () => true, 400);
  const nearCity = dijkstra(i => canSink[i] === 2, i => canSink[i] === 1, 300);
  roads.forEach((r, ri) => {
    if (!r.tunnel) return;
    // where a tunnel ramp surfaces right at a city street, leave its last ~100 m free to climb out
    const a = ids[ri], p = r.pts, n = a.length, dist = new Float64Array(n).fill(1e9);
    for (let pass = 0; pass < 2; pass++) for (let k0 = 0; k0 < n; k0++) {
      const k = pass ? n - 1 - k0 : k0, prev = pass ? k + 1 : k - 1;
      if (canSink[a[k]] === 2) dist[k] = 0;
      else if (prev >= 0 && prev < n) dist[k] = Math.min(dist[k], dist[prev] + Math.hypot(p[k * 2] - p[prev * 2], p[k * 2 + 1] - p[prev * 2 + 1]));
    }
    for (let k = 0; k < n; k++) if (canSink[a[k]] === 1 && dist[k] > 100 && nearDeck[a[k]] > 220) { locked[a[k]] = 1; sink[a[k]] = -TRENCH; }
    // wherever a street passes over the tunnel, the tunnel is below it — even close to a bridge. A mapped
    // street bridge decides like any other: the freeway sinks, or the street goes over if the freeway is climbing
    crossings(ri, (s, oi) => {
      const o = roads[oi]; if (o.tunnel || o.c > 12 || o.raised) return;
      if (o.flags & 2) { trenchCand.push([oi, ri, s]); return; }
      for (const id of [a[s], a[s + 1]]) if (canSink[id] === 1) sink[id] = Math.min(sink[id], -TRENCH);
    });
  });

  // 3) ramps: spread heights outward along connected roads at the ramp grade. A ramp's or side
  //    street's bridge never spills onto a freeway it joins (no humps in the freeway).
  const H = new Float64Array(N), src = new Uint8Array(N).fill(9);
  const solve = () => {
    H.fill(0); src.fill(9);
    const heap = [];
    const push = (h, id) => { heap.push([h, id]); let i = heap.length - 1; while (i > 0) { const pa = (i - 1) >> 1; if (heap[pa][0] >= heap[i][0]) break; [heap[pa], heap[i]] = [heap[i], heap[pa]]; i = pa; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, rr = l + 1; let m = i; if (l < heap.length && heap[l][0] > heap[m][0]) m = l; if (rr < heap.length && heap[rr][0] > heap[m][0]) m = rr; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    for (let i = 0; i < N; i++) if (deck[i] > 0 && !locked[i]) { H[i] = deck[i]; src[i] = deckRank[i]; push(H[i], i); }
    while (heap.length) {
      const [h, id] = pop(); if (h < H[id] - 1e-9) continue;
      const a = adj[id];
      for (let k = 0; k < a.length; k += 2) {
        const v = a[k]; if (locked[v] || (rank[v] <= 1 && rank[v] < src[id])) continue;
        const nh = h - GRADE * a[k + 1];
        if (nh > H[v] + 0.01) { H[v] = nh; src[v] = src[id]; push(nh, v); }
      }
    }
    // ceilings: roads passing under a bridge are pulled down beneath it (their ramps may be steeper: 9%)
    const U = new Float64Array(N).fill(1e9), mheap = [];
    const mpush = (h, id) => { mheap.push([h, id]); let i = mheap.length - 1; while (i > 0) { const pa = (i - 1) >> 1; if (mheap[pa][0] <= mheap[i][0]) break; [mheap[pa], mheap[i]] = [mheap[i], mheap[pa]]; i = pa; } };
    const mpop = () => { const top = mheap[0], last = mheap.pop(); if (mheap.length) { mheap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, rr = l + 1; let m = i; if (l < mheap.length && mheap[l][0] < mheap[m][0]) m = l; if (rr < mheap.length && mheap[rr][0] < mheap[m][0]) m = rr; if (m === i) break; [mheap[m], mheap[i]] = [mheap[i], mheap[m]]; i = m; } } return top; };
    for (let i = 0; i < N; i++) if (pinU[i] < 1e8 && !locked[i]) { U[i] = pinU[i]; mpush(U[i], i); }
    while (mheap.length) {
      const [h, id] = mpop(); if (h > U[id] + 1e-9) continue;
      const a = adj[id];
      for (let k = 0; k < a.length; k += 2) { const v = a[k]; if (locked[v] || deck[v] > 0) continue; const nh = h + 0.09 * a[k + 1]; if (nh < U[v] - 0.01) { U[v] = nh; mpush(nh, v); } }
    }
    for (let i = 0; i < N; i++) if (locked[i]) H[i] = 0; else if (!(deck[i] > 0)) H[i] = canSink[i] === 1 || canDip[i] ? Math.min(H[i], U[i]) : Math.max(0, Math.min(H[i], U[i]));
    // trenches: from tunnels and sunken stretches, climb back to street level at the ramp grade
    const D = new Float64Array(N), dheap = [];
    for (let i = 0; i < N; i++) if (sink[i] < 0) { D[i] = sink[i]; mpushD(dheap, sink[i], i); }
    while (dheap.length) {
      const [h, id] = mpopD(dheap); if (h > D[id] + 1e-9) continue;
      const a = adj[id];
      for (let k = 0; k < a.length; k += 2) { const v = a[k]; if (canSink[v] !== 1 || deck[v] > 0) continue; const nh = Math.min(0, h + GRADE * a[k + 1]); if (nh < D[v] - 0.01) { D[v] = nh; if (nh < 0) mpushD(dheap, nh, v); } }
    }
    for (let i = 0; i < N; i++) if (sink[i] < 0) H[i] = sink[i]; else if (D[i] < -0.01 && !(deck[i] > 0)) H[i] += D[i]; // the two slopes blend smoothly
    for (let i = 0; i < N; i++) if (H[i] < 0 && !locked[i]) H[i] = Math.max(H[i], -0.1 * nearCity[i]); // climb out before reaching a city street (≤10%)
    // a freeway that surfaces for only a few hundred metres between two sunken stretches stays down (one long trench)
    roads.forEach((r, ri) => {
      if (!SINKABLE.has(r.c)) return;
      const a = ids[ri], p = r.pts, cum = [0];
      for (let k = 1; k < a.length; k++) cum.push(cum[k - 1] + Math.hypot(p[k * 2] - p[k * 2 - 2], p[k * 2 + 1] - p[k * 2 - 1]));
      let last = -1;
      for (let k = 0; k < a.length; k++) {
        if (H[a[k]] > -3) continue;
        if (last >= 0 && k - last > 1 && cum[k] - cum[last] < 700) {
          let ok = true; for (let m = last + 1; m < k; m++) if (deck[a[m]] > 0 || canSink[a[m]] !== 1) { ok = false; break; }
          if (ok) for (let m = last + 1; m < k; m++) { const f = (cum[m] - cum[last]) / (cum[k] - cum[last]); H[a[m]] = Math.min(H[a[m]], H[a[last]] + (H[a[k]] - H[a[last]]) * f); }
        }
        last = k;
      }
    });
  };
  function mpushD(hp, h, id) { hp.push([h, id]); let i = hp.length - 1; while (i > 0) { const pa = (i - 1) >> 1; if (hp[pa][0] <= hp[i][0]) break; [hp[pa], hp[i]] = [hp[i], hp[pa]]; i = pa; } }
  function mpopD(hp) { const top = hp[0], last = hp.pop(); if (hp.length) { hp[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, rr = l + 1; let m = i; if (l < hp.length && hp[l][0] < hp[m][0]) m = l; if (rr < hp.length && hp[rr][0] < hp[m][0]) m = rr; if (m === i) break; [hp[m], hp[i]] = [hp[i], hp[m]]; i = m; } } return top; }
  solve();
  // 3b) streets bridging a freeway: sink the freeway — unless it's climbing to one of its own bridges there,
  //     in which case the street goes over it the classic way
  if (trenchCand.length) {
    let raised = false;
    for (const [ri, oi, t] of trenchCand) {
      const a = ids[oi][t], b = ids[oi][t + 1];
      // the freeway only stays up (and the street goes over) when it's on, or climbing to, one of its own bridges close by
      const climbing = (H[a] > 0.3 || H[b] > 0.3) && Math.min(nearDeck[a], nearDeck[b]) < 230;
      if (deck[a] > 0 || deck[b] > 0 || canSink[a] !== 1 || canSink[b] !== 1 || climbing) { if (!roads[ri].raised) { setDeck(ri, DECK); raised = true; } }
      else { sink[a] = Math.min(sink[a], -TRENCH); sink[b] = Math.min(sink[b], -TRENCH); }
    }
    solve(); void raised;
  }
  // 4) headroom: wherever a road still runs into a bridge, pull the lower road down under it
  const hAt = (ri, s, u) => { const a = ids[ri]; return H[a[s]] + (H[a[s + 1]] - H[a[s]]) * u; };
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    roads.forEach((r, ri) => {
      if (!r.raised && !(r.flags & 2)) return;
      crossings(ri, (s, oi, t, u, v) => {
        const o = roads[oi]; if (r.tunnel || o.c > 12 || locked[ids[oi][t]] && locked[ids[oi][t + 1]]) return;
        const hu = hAt(ri, s, u), hl = hAt(oi, t, v);
        if (hu < hl || hu - hl >= CLEAR - 0.05) return;
        const dip = canDip[ids[oi][t]] && canDip[ids[oi][t + 1]];
        const sinkable = (canSink[ids[oi][t]] === 1 && canSink[ids[oi][t + 1]] === 1) || dip;
        if (hu < 0.3 && !sinkable) return;
        if (deck[ids[oi][t]] > 0 || deck[ids[oi][t + 1]] > 0) return; // two decks: trust the mapped layers
        const cap = sinkable ? hu - CLEAR - (dip ? 0 : 1) : Math.max(0, hu - CLEAR); // freeways (and driveways) duck under
        for (const id of [ids[oi][t], ids[oi][t + 1]]) if (cap < pinU[id] - 0.01) { pinU[id] = cap; changed = true; }
      });
    });
    if (!changed) break;
    solve();
  }
  return ids.map(a => { const out = new Float32Array(a.length); for (let i = 0; i < a.length; i++) out[i] = H[a[i]]; return out; });
}
// ribbon edge positions (same miter maths as ribbon)
function ribbonEdges(pts, width) {
  const n = pts.length / 2, L = new Float32Array(n * 2), R = new Float32Array(n * 2), hw = width / 2;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], z = pts[i * 2 + 1];
    let dx0 = 0, dz0 = 0, dx1 = 0, dz1 = 0;
    if (i > 0) { dx0 = x - pts[i * 2 - 2]; dz0 = z - pts[i * 2 - 1]; const l = Math.hypot(dx0, dz0) || 1; dx0 /= l; dz0 /= l; }
    if (i < n - 1) { dx1 = pts[i * 2 + 2] - x; dz1 = pts[i * 2 + 3] - z; const l = Math.hypot(dx1, dz1) || 1; dx1 /= l; dz1 /= l; }
    if (i === 0) { dx0 = dx1; dz0 = dz1; }
    if (i === n - 1) { dx1 = dx0; dz1 = dz0; }
    let tx = dx0 + dx1, tz = dz0 + dz1; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    const nx = -tz, nz = tx, s = hw / Math.max(0.35, nx * -dz1 + nz * dx1);
    L[i * 2] = x + nx * s; L[i * 2 + 1] = z + nz * s; R[i * 2] = x - nx * s; R[i * 2 + 1] = z - nz * s;
  }
  return { L, R };
}
function quad(buf, a, b, c, d) { // 4 xyz points; flat normal
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  const base = buf.vc;
  buf.p.push(...a, ...b, ...c, ...d); for (let k = 0; k < 4; k++) buf.n.push(nx, ny, nz);
  buf.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
function bridgeParts(buf, pts, hs, width, road) {
  const n = pts.length / 2; if (n < 2) return;
  const { L, R } = ribbonEdges(pts, width + 0.6);
  const top = i => hs[i] + 0.04, bot = i => Math.max(0, hs[i] - 1.1);
  for (let i = 0; i < n - 1; i++) {
    if (hs[i] < 0.35 && hs[i + 1] < 0.35) continue;
    for (const E of [L, R]) {
      quad(buf, [E[i * 2], top(i), E[i * 2 + 1]], [E[i * 2 + 2], top(i + 1), E[i * 2 + 3]], [E[i * 2 + 2], bot(i + 1), E[i * 2 + 3]], [E[i * 2], bot(i), E[i * 2 + 1]]);
      if (hs[i] > 1.2 || hs[i + 1] > 1.2) // guardrail / parapet
        quad(buf, [E[i * 2], top(i) + 0.85, E[i * 2 + 1]], [E[i * 2 + 2], top(i + 1) + 0.85, E[i * 2 + 3]], [E[i * 2 + 2], top(i + 1), E[i * 2 + 3]], [E[i * 2], top(i), E[i * 2 + 1]]);
    }
    if (bot(i) > 0.05 || bot(i + 1) > 0.05) // deck underside
      quad(buf, [L[i * 2], bot(i), L[i * 2 + 1]], [R[i * 2], bot(i), R[i * 2 + 1]], [R[i * 2 + 2], bot(i + 1), R[i * 2 + 3]], [L[i * 2 + 2], bot(i + 1), L[i * 2 + 3]]);
  }
  if (!road.raised) return;
  // piers every ~30 m along raised sections
  let acc = 15;
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3], sl = Math.hypot(bx - ax, bz - az) || 1;
    const dx = (bx - ax) / sl, dz = (bz - az) / sl, nx = -dz, nz = dx;
    while (acc < sl) {
      const f = acc / sl, h = hs[i] + (hs[i + 1] - hs[i]) * f - 1.1;
      if (h > 1.5) {
        const cx = ax + dx * acc, cz = az + dz * acc, hw = Math.min(width * 0.32, 5), hd = 0.7;
        const c = [[cx + nx * hw + dx * hd, cz + nz * hw + dz * hd], [cx - nx * hw + dx * hd, cz - nz * hw + dz * hd], [cx - nx * hw - dx * hd, cz - nz * hw - dz * hd], [cx + nx * hw - dx * hd, cz + nz * hw - dz * hd]];
        for (let k = 0; k < 4; k++) { const p0 = c[k], p1 = c[(k + 1) % 4]; quad(buf, [p0[0], h, p0[1]], [p1[0], h, p1[1]], [p1[0], 0, p1[1]], [p0[0], 0, p0[1]]); }
      }
      acc += 30;
    }
    acc -= sl;
  }
}
const concreteMat = new THREE.MeshLambertMaterial({ color: '#a8a69f', side: THREE.DoubleSide });
// trenches: an invisible mask marks the stencil buffer, and the ground / land use / sidewalks skip those pixels
const DECK_RGB = [0.62, 0.61, 0.59];
const holeMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp });
function cutByTrenches(mat) { mat.stencilWrite = true; mat.stencilRef = 1; mat.stencilFunc = THREE.NotEqualStencilFunc; mat.stencilFail = mat.stencilZFail = mat.stencilZPass = THREE.KeepStencilOp; return mat; }
const tunnelLightMat = new THREE.MeshBasicMaterial({ color: '#fff1c2', side: THREE.DoubleSide });
function quadUp(buf, a, b, c, d) { // quad whose front face points upward
  const ux = b[0] - a[0], uz = b[2] - a[2], vx = d[0] - a[0], vz = d[2] - a[2], uy = b[1] - a[1], vy = d[1] - a[1];
  if (uz * vx - ux * vz < 0 || (Math.abs(uz * vx - ux * vz) < 1e-6 && uy * vz - uz * vy < 0)) quad(buf, a, d, c, b); else quad(buf, a, b, c, d);
}
// freeway tunnel below street level: walls, ceiling and lights follow the road; a headwall closes each portal
function tunnelParts(cbuf, lbuf, pts, hs, width, inner) {
  const n = pts.length / 2; if (n < 2) return;
  const iw = width + 0.6, C = TUN_CEIL;
  const I = ribbonEdges(pts, iw);
  const P = (E, i, y) => [E[i * 2], y, E[i * 2 + 1]];
  for (let i = 0; i < n - 1; i++) {
    const h0 = hs[i], h1 = hs[i + 1];
    for (const E of [I.L, I.R]) quad(cbuf, P(E, i, h0), P(E, i + 1, h1), P(E, i + 1, h1 + C), P(E, i, h0 + C)); // walls
    quad(cbuf, P(I.L, i, h0 + C), P(I.R, i, h0 + C), P(I.R, i + 1, h1 + C), P(I.L, i + 1, h1 + C));            // ceiling
    // ceiling lights every ~16 m
    const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3], L = Math.hypot(bx - ax, bz - az) || 1;
    const dx = (bx - ax) / L, dz = (bz - az) / L;
    for (let d = 8; d < L; d += 16) {
      const cx = ax + dx * d, cz = az + dz * d, y = h0 + (h1 - h0) * d / L + C - 0.06;
      quad(lbuf, [cx - dz * 0.4 - dx * 1.4, y, cz + dx * 0.4 - dz * 1.4], [cx + dz * 0.4 - dx * 1.4, y, cz - dx * 0.4 - dz * 1.4], [cx + dz * 0.4 + dx * 1.4, y, cz - dx * 0.4 + dz * 1.4], [cx - dz * 0.4 + dx * 1.4, y, cz + dx * 0.4 + dz * 1.4]);
    }
  }
  for (const i of [0, n - 1]) { if (inner && inner(pts[i * 2], pts[i * 2 + 1])) continue; const top = Math.max(hs[i] + C, 0.4); quad(cbuf, P(I.L, i, hs[i] + C), P(I.R, i, hs[i] + C), P(I.R, i, top + 0.6), P(I.L, i, top + 0.6)); } // portal headwalls
}
// open trench (a sunken freeway): retaining walls up to street level, a hole in the ground above it
function trenchParts(cbuf, mbuf, pts, hs, width) {
  const n = pts.length / 2; if (n < 2) return;
  const W = ribbonEdges(pts, width + 1.2), M = ribbonEdges(pts, width + 1.1);
  const P = (E, i, y) => [E[i * 2], y, E[i * 2 + 1]];
  for (let i = 0; i < n - 1; i++) {
    if (hs[i] > -0.25 && hs[i + 1] > -0.25) continue;
    for (const E of [W.L, W.R]) quad(cbuf, P(E, i, hs[i] - 0.2), P(E, i + 1, hs[i + 1] - 0.2), P(E, i + 1, 0.55), P(E, i, 0.55));
    quad(cbuf, P(W.L, i, hs[i] - 0.02), P(W.R, i, hs[i] - 0.02), P(W.R, i + 1, hs[i + 1] - 0.02), P(W.L, i + 1, hs[i + 1] - 0.02)); // shoulder floor
    quad(mbuf, P(M.L, i, 0.6), P(M.R, i, 0.6), P(M.R, i + 1, 0.6), P(M.L, i + 1, 0.6));
  }
}
// ───────────────────────── spatial index ─────────────────────────
const CELL = 50;
const ck = (cx, cz) => cx * 100003 + cz;
function gridAddSeg(grid, ax, az, bx, bz, ref) {
  const minx = Math.floor(Math.min(ax, bx) / CELL), maxx = Math.floor(Math.max(ax, bx) / CELL);
  const minz = Math.floor(Math.min(az, bz) / CELL), maxz = Math.floor(Math.max(az, bz) / CELL);
  for (let cx = minx; cx <= maxx; cx++) for (let cz = minz; cz <= maxz; cz++) {
    const k = ck(cx, cz); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(ref);
  }
}

// ───────────────────────── tiles ─────────────────────────
const tiles = new Map(); // key "x,y" -> tile
const queue = [];
let inflight = 0;
const MAXQ = 3;

function tileCenter(tx, ty) { return proj(B.S + (ty + 0.5) * TLAT, B.W + (tx + 0.5) * TLON); }

function wantTiles(x, z) {
  const [cx, cy] = tileOf(x, z);
  const R = settings.radius;
  for (let dy = -R - 1; dy <= R + 1; dy++) for (let dx = -R - 1; dx <= R + 1; dx++) wantTerrain(cx + dx, cy + dy);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const tx = cx + dx, ty = cy + dy;
    if (tx < 0 || ty < 0 || tx >= NX || ty >= NY) continue;
    const key = tx + ',' + ty;
    let t = tiles.get(key);
    if (!t) { t = { key, tx, ty, group: new THREE.Group(), state: { r: 0, b: 0, l: 0 }, roadGrid: new Map(), bermGrid: new Map(), bldGrid: new Map(), blds: [], roads: [] }; scene.add(t.group); tiles.set(key, t); }
    const ready = !(t.retryAt > performance.now());
    if (t.state.r === 0 && ready) enqueue(t, 'r');
    if (t.state.l === 0 && ready) enqueue(t, 'l');
    if (settings.buildings && t.state.b === 0 && ready) enqueue(t, 'b');
  }
  // unload far tiles
  const [fx, fy] = tileFrac(x, z);
  for (const [, t] of tiles) {
    const far = LOW ? Math.max(Math.abs(t.tx + 0.5 - fx), Math.abs(t.ty + 0.5 - fy)) > R + 1.15 : Math.abs(t.tx - cx) > R + 1 || Math.abs(t.ty - cy) > R + 1;
    if (far) unloadTile(t);
  }
  queue.sort((a, b) => a.pri(x, z) - b.pri(x, z));
  pump();
}
function enqueue(t, k) {
  t.state[k] = 1;
  queue.push({ t, k, pri: (x, z) => { const [mx, mz] = tileCenter(t.tx, t.ty); return Math.hypot(mx - x, mz - z) + (k === 'b' ? 2500 : k === 'l' ? 1200 : 0); } });
}
function unloadTile(t) {
  t.dead = true;
  traffic.removeTile(t);
  scene.remove(t.group);
  t.group.traverse(o => { if (o.isInstancedMesh) o.dispose(); if (o.geometry) o.geometry.dispose(); if (o.userData && o.userData.tex) { o.userData.tex.dispose(); o.material.dispose(); } });
  tiles.delete(t.key);
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].t === t) queue.splice(i, 1);
}
function pump() {
  while (inflight < MAXQ && queue.length) {
    const job = queue.shift();
    inflight++;
    fetchTile(job).finally(() => { inflight--; updateLoading(); pump(); });
  }
  updateLoading();
}
// ── map data: server cache first; on a miss the browser pulls OSM itself and shares it back ──
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
let overpassDownUntil = 0, opTurn = 0;
function timedFetch(url, opts = {}, ms = 25000) {
  const c = new AbortController(); const tm = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(tm));
}
async function overpass(q) {
  if (Date.now() < overpassDownUntil) throw new Error('overpass down');
  let err;
  for (let i = 0; i < 2; i++) {
    const url = OVERPASS[(opTurn + i) % OVERPASS.length];
    try {
      const r = await timedFetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 25000);
      if (r.ok) { const j = await r.json(); if (!(j.remark && /error|timed out|out of memory/i.test(j.remark))) return j; }
      err = new Error('overpass ' + r.status);
    } catch (e) { err = e; }
  }
  opTurn++;
  overpassDownUntil = Date.now() + 180000; // skip it for 3 minutes
  throw err;
}
const apiFetches = new Map();
function osmApiTile(tx, ty) { // one fetch fills both the road and building layers
  const key = tx + ',' + ty;
  if (!apiFetches.has(key)) {
    const { s, n, w, e } = tileBox(tx, ty);
    const p = fetchOsmApi(s, w, n, e, url => timedFetch(url, {}, 25000), 3)
      .then(raw => { const els = rawToElements(raw); return { r: convertTile(els, 'r'), b: convertTile(els, 'b'), l: convertTile(els, 'l') }; });
    apiFetches.set(key, p);
    p.catch(() => {}).finally(() => setTimeout(() => apiFetches.delete(key), 60000));
  }
  return apiFetches.get(key);
}
const shared = new Set();
function share(key, data) {
  if (shared.has(key)) return; shared.add(key);
  if (STATIC) { idb.put(key, data); return; }
  fetch(`${API}/store`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, data: JSON.stringify(data) }) })
    .then(r => { if (!r.ok) r.text().then(t => report(`store ${key} ${r.status} ${t.slice(0, 200)}`)); })
    .catch(e => report(`store ${key} ${errText(e)}`));
}
// older saved road tiles have streets but no places: refresh them quietly in the background
const upgrading = new Set();
// (and older saved building tiles lack 3D parts / courtyards, so those get the same treatment)
function upgradeLater(tx, ty, k = 'r') {
  const key = k + tx + ',' + ty;
  if (upgrading.has(key)) return; upgrading.add(key);
  setTimeout(async () => {
    let d = null;
    try { d = convertTile(await overpass(overpassQuery(k, tx, ty)), k); }
    catch { try { d = (await osmApiTile(tx, ty))[k]; } catch {} }
    if (!d) { upgrading.delete(key); return; }
    share(`${KEYP[k]}:${tx}:${ty}`, d);
    const t = tiles.get(tx + ',' + ty);
    if (!t || t.dead) return;
    if (k === 'r') t.pois = d.pois.map(p => ({ c: p[0], name: d.names[p[1]] || '', x: p[2], z: p[3] }));
    else if (t.state.r === 2) buildBuildings(t, d); else t.pendingB = d;
  }, 2500 + upgrading.size * 1500);
}
const KEYP = { r: 'r2', b: 'b4', l: 'l1' };
let reports = 0;
function report(msg) {
  if (STATIC || ++reports > 25) return;
  fetch(`${API}/clientlog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg }) }).catch(() => {});
}
const errText = e => (e && (e.name === 'AbortError' ? 'timeout' : e.message)) || String(e);
async function loadTileData(tx, ty, k) {
  let why = '';
  if (STATIC) {
    const d = (await staticJson(`data/${k}/${tx}_${ty}.json`)) || (await idb.get(`${KEYP[k]}:${tx}:${ty}`));
    if (d) return d;
  } else try {
    const r = await fetch(`${API}/tile?x=${tx}&y=${ty}&k=${k}`);
    if (r.ok) { const d = await r.json(); if (k === 'r' && !d.pois) upgradeLater(tx, ty); if (k === 'b' && !(d.v >= 5)) upgradeLater(tx, ty, 'b'); return d; }
    why = 'cache ' + r.status;
  } catch (e) { why = 'cache ' + errText(e); }
  try {
    const d = convertTile(await overpass(overpassQuery(k, tx, ty)), k);
    share(`${KEYP[k]}:${tx}:${ty}`, d);
    return d;
  } catch (e) { why += ' | overpass ' + errText(e); }
  try {
    const all = await osmApiTile(tx, ty);
    for (const kk of ['r', 'b', 'l']) share(`${KEYP[kk]}:${tx}:${ty}`, all[kk]);
    return all[k];
  } catch (e) { why += ' | osmapi ' + errText(e); report(`tile ${k} ${tx},${ty} failed: ${why}`); throw e; }
}
async function fetchTile({ t, k }) {
  for (let attempt = 0; attempt < 3 && !t.dead; attempt++) {
    try {
      const d = await loadTileData(t.tx, t.ty, k);
      if (t.dead) return;
      if (k === 'r') {
        buildRoads(t, d); t.state.r = 2;
        if (t.pendingB) { buildBuildings(t, t.pendingB); t.pendingB = null; }
        maybePlant(t);
      } else if (k === 'l') {
        buildLanduse(t, d); t.state.l = 2; maybePlant(t);
      } else {
        if (t.state.r === 2) buildBuildings(t, d); else t.pendingB = d; // skyway check needs the streets
        t.state.b = 2;
      }
      return;
    } catch (e) {
      await new Promise(res => setTimeout(res, 4000 * (attempt + 1)));
    }
  }
  if (!t.dead) { t.state[k] = 0; t.retryAt = performance.now() + 20000; if (k === 'l') { t.lFailed = true; maybePlant(t); } }
}

// elevations for a tile's roads, solved together with nearby roads from the neighbouring tiles so a bridge,
// trench or ramp that crosses a tile edge gets the same heights on both sides; then (re)build the geometry
const wayKey = r => r.pts.length + ':' + r.pts[0] + ',' + r.pts[1] + ':' + r.pts[r.pts.length - 2] + ',' + r.pts[r.pts.length - 1];
function solveRoads(t, cascade) {
  const [x0, z1] = proj(B.S + t.ty * TLAT, B.W + t.tx * TLON), [x1, z0] = proj(B.S + (t.ty + 1) * TLAT, B.W + (t.tx + 1) * TLON);
  const M = 450, list = [...t.roads], seen = new Set(t.roads.map(r => r.key)), grid = new Map();
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const n = (i || j) && tiles.get((t.tx + i) + ',' + (t.ty + j)); if (!n || !n.roadMeshes) continue;
    for (const r of n.roads) {
      if (seen.has(r.key)) continue;
      const p = r.pts; let near = false;
      for (let k = 0; k < p.length && !near; k += 2) near = p[k] > x0 - M && p[k] < x1 + M && p[k + 1] > z0 - M && p[k + 1] < z1 + M;
      if (near) { seen.add(r.key); list.push(r); }
    }
  }
  for (const r of list) { const p = r.pts; for (let s = 0; s < p.length / 2 - 1; s++) gridAddSeg(grid, p[s * 2], p[s * 2 + 1], p[s * 2 + 2], p[s * 2 + 3], { road: r, s }); }
  const heights = computeHeights(list, grid), byKey = new Map(), own = new Set(t.roads);
  // ways reaching into this tile take the new heights; the outer context keeps what its own tile solved (it saw more
  // of its own surroundings), so neighbouring tiles agree where their ways meet
  const inTile = r => { const p = r.pts; for (let k = 0; k < p.length; k += 2) if (p[k] > x0 && p[k] < x1 && p[k + 1] > z0 && p[k + 1] < z1) return true; return false; };
  list.forEach((r, i) => { if (own.has(r) || !r.hs || inTile(r)) byKey.set(r.key, heights[i]); });
  // every copy of a way gets the same heights: a way that crosses a tile edge is stored (and drawn) by each tile it
  // touches, and copies solved separately used to disagree — a road at grade drawn through its own raised or sunken twin
  const dirty = new Set([t]);
  for (const n of tiles.values()) {
    if (!n.roadMeshes || n.dead) continue;
    for (const r of n.roads) {
      const h = byKey.get(r.key); if (!h) continue;
      if (n !== t && r.hs && r.hs.length === h.length) { let same = true; for (let k = 0; k < h.length && same; k++) same = Math.abs(h[k] - r.hs[k]) < 0.05; if (same) continue; }
      r.hs = h; dirty.add(n);
    }
  }
  for (const r of t.roads) if (!r.hs) r.hs = byKey.get(r.key) || new Float32Array(r.pts.length / 2);
  for (const n of dirty) rebuildRoadGeometry(n);
  void cascade;
}
// intersections: one clean paved area per junction of city streets — lane lines stop at its edge and the corners
// get rounded curb returns (the crossing streets' own ribbons just overlap underneath)
const junctionMat = new THREE.MeshLambertMaterial({ map: canvasTex(256, 256, (c, w, h) => {
  noise(c, w, h, '#42454b', 0.12, w * 14);
  c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1.5; // a few sealed cracks
  for (let k = 0; k < 3; k++) { c.beginPath(); let x = Math.random() * w, y = Math.random() * h; c.moveTo(x, y); for (let j = 0; j < 8; j++) { x += (Math.random() - 0.5) * 30; y += Math.random() * 18; c.lineTo(x, y); } c.stroke(); }
}), polygonOffset: true, polygonOffsetFactor: -12.5, polygonOffsetUnits: -26 });
junctionMat.userData.snowK = 0.14; junctionMat.userData.wetK = 1;
function buildJunctions(t, buf) {
  const mine = (x, z) => tileOf(x, z).join(',') === t.key;
  const nodes = new Map();
  for (const r of t.roads) {
    if (r.c <= 1 || r.c === 8 || r.c === 9 || r.c > 12 || r.tunnel) continue; // freeways and their ramps merge, they don't cross
    const p = r.pts, n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const x = p[i * 2], z = p[i * 2 + 1], h = r.hs ? r.hs[i] : 0;
      if (Math.abs(h) > 0.3) continue;
      const k = Math.round(x * 2) + ',' + Math.round(z * 2);
      let e = nodes.get(k); if (!e) nodes.set(k, e = { x, z, arms: [] });
      for (const dir of [-1, 1]) {
        let m = i + dir; if (m < 0 || m >= n) continue;
        while (m + dir >= 0 && m + dir < n && Math.hypot(p[m * 2] - x, p[m * 2 + 1] - z) < 8) m += dir; // a stable direction
        const dx = p[m * 2] - x, dz = p[m * 2 + 1] - z, L = Math.hypot(dx, dz); if (L < 1) continue;
        e.arms.push({ dx: dx / L, dz: dz / L, w: r.w, prio: r.spec.prio, th: Math.atan2(dz, dx) });
      }
    }
  }
  for (const e of nodes.values()) {
    if (e.arms.length < 3 || !mine(e.x, e.z)) continue;
    const arms = e.arms.sort((a, b) => a.th - b.th).filter((a, i, A) => !A.slice(0, i).some(b => a.dx * b.dx + a.dz * b.dz > 0.985));
    const n = arms.length; if (n < 3) continue;
    const top = Math.max(...arms.map(a => a.prio)), y = 0.06 + top * 0.018 + 0.004, R = top >= 7 ? 7 : 4.5;
    for (const a of arms) a.d = Math.min(18, Math.max(2.5, Math.max(...arms.filter(b => b !== a).map(b => b.w)) / 2 + 0.6));
    // each arm's cut line sits where its curb returns end (so the patch has no spikes along the kerbs)
    for (let i = 0; i < n; i++) {
      const a = arms[i], b = arms[(i + 1) % n];
      let ang = b.th - a.th; if (ang <= 0) ang += Math.PI * 2;
      if (ang > 2.6 || ang < 0.25) continue;
      const sn = Math.sin(ang), T = Math.min(14, R / Math.tan(ang / 2));
      // distance along each arm from the node to the corner (where the two kerb lines meet), plus the return
      const ta = (b.w / 2 + a.w / 2 * Math.cos(ang)) / sn, tb = (a.w / 2 + b.w / 2 * Math.cos(ang)) / sn;
      if (ta > 0 && ta < 40) a.d = Math.max(a.d, Math.min(22, ta + T));
      if (tb > 0 && tb < 40) b.d = Math.max(b.d, Math.min(22, tb + T));
    }
    const P = []; // perimeter, counter-clockwise from the node's view
    for (let i = 0; i < n; i++) {
      const a = arms[i], b = arms[(i + 1) % n];
      const ax = -a.dz, az = a.dx, bx = -b.dz, bz = b.dx; // left normals (toward increasing angle)
      P.push([e.x + a.dx * a.d - ax * a.w / 2, e.z + a.dz * a.d - az * a.w / 2]); // a's right edge
      P.push([e.x + a.dx * a.d + ax * a.w / 2, e.z + a.dz * a.d + az * a.w / 2]); // a's left edge
      let ang = b.th - a.th; if (ang <= 0) ang += Math.PI * 2;
      if (ang > 2.6 || ang < 0.25) continue; // nearly straight through: no corner to round
      // corner where a's left kerb line meets b's right kerb line, then a curb return of radius R around it
      const ox = bx * -b.w / 2 - ax * a.w / 2, oz = bz * -b.w / 2 - az * a.w / 2;
      const den = a.dx * -b.dz - a.dz * -b.dx; if (Math.abs(den) < 1e-4) continue;
      const tA = (ox * -b.dz - oz * -b.dx) / den;
      const cx = e.x + ax * a.w / 2 + a.dx * tA, cz = e.z + az * a.w / 2 + a.dz * tA;
      if (tA < 0 || tA > 40) continue;
      const T = Math.min(14, R / Math.tan(ang / 2));
      const s0 = [cx + a.dx * T, cz + a.dz * T], s1 = [cx + b.dx * T, cz + b.dz * T];
      for (let k = 0; k <= 6; k++) { const u = k / 6, w0 = (1 - u) * (1 - u), w1 = 2 * u * (1 - u), w2 = u * u; P.push([s0[0] * w0 + cx * w1 + s1[0] * w2, s0[1] * w0 + cz * w1 + s1[1] * w2]); }
    }
    // fan from the junction centre
    const base = buf.vc;
    buf.p.push(e.x, y, e.z); buf.n.push(0, 1, 0); buf.uv.push(e.x / 16, e.z / 16);
    for (const [x, z] of P) { buf.p.push(x, y, z); buf.n.push(0, 1, 0); buf.uv.push(x / 16, z / 16); }
    for (let k = 0; k < P.length; k++) { // wind every triangle to face up
      const A = P[k], B = P[(k + 1) % P.length], up = (A[0] - e.x) * (B[1] - e.z) - (A[1] - e.z) * (B[0] - e.x);
      if (up < 0) buf.i.push(base, base + 1 + k, base + 1 + (k + 1) % P.length); else buf.i.push(base, base + 1 + (k + 1) % P.length, base + 1 + k);
    }
  }
}
function rebuildRoadGeometry(t) {
  for (const m of t.roadMeshes) { t.group.remove(m); m.geometry.dispose(); }
  t.roadMeshes = [];
  buildRoadGeometry(t);
}
function buildRoadGeometry(t) {
  const objs = t.roads;
  const bufs = new Map();
  const getBuf = (mat) => { let b = bufs.get(mat); if (!b) bufs.set(mat, b = new GeoBuf()); return b; };
  const add = m => { t.group.add(m); t.roadMeshes.push(m); };
  // 3) geometry, low priority first
  const bridgeBuf = new GeoBuf(), maskBuf = new GeoBuf(), lightBuf = new GeoBuf();
  // a tunnel mapped as several ways: only its real portals get a headwall, not the joins between the pieces
  const tunnelEnds = new Map(); // (the same way stored in two tiles only counts once)
  { const seenK = new Set(); for (const n of tiles.values()) for (const r of n.roads || []) { if (!r.tunnel || seenK.has(r.key)) continue; seenK.add(r.key); const p = r.pts; for (const i of [0, p.length / 2 - 1]) { const k = Math.round(p[i * 2] * 2) + ',' + Math.round(p[i * 2 + 1] * 2); tunnelEnds.set(k, (tunnelEnds.get(k) || 0) + 1); } } }
  const order = objs.map((o, i) => i).sort((a, b) => objs[a].spec.prio - objs[b].spec.prio);
  for (const i of order) {
    const o = objs[i], spec = o.spec;
    const mat = roadMat(spec);
    const y = 0.06 + spec.prio * 0.018;
    let lifted = false, sunk = false; for (const h of o.hs) { if (h > 0.3) lifted = true; if (h < -0.3) sunk = true; }
    o.sunk = sunk;
    let P = o.pts, Hs = o.hs;
    if (lifted) { const dn = densify(o.pts, o.hs, 10); P = dn.p; Hs = deckProfile(dn.p, dn.h); } // straight decks over valleys
    ribbon(getBuf(mat), P, spec.width, y, 1, lifted || sunk ? Hs : null);
    if (o.c >= 2 && o.c <= 7 && !lifted && !sunk && !o.tunnel) ribbon(getBuf(walkMat), o.pts, spec.width + 6, 0.045, 1); // curb + sidewalk
    if (lifted) bridgeParts(bridgeBuf, P, Hs, spec.width, o);
    if (o.tunnel) tunnelParts(bridgeBuf, lightBuf, o.pts, o.hs, spec.width, (x, z) => tunnelEnds.get(Math.round(x * 2) + ',' + Math.round(z * 2)) > 1);
    else if (sunk) trenchParts(bridgeBuf, maskBuf, o.pts, o.hs, spec.width);
  }
  const jb = new GeoBuf(); buildJunctions(t, jb); { const m = jb.mesh(junctionMat); if (m) { m.renderOrder = 1; add(m); } }
  // streets crossing over a trench get a deck underneath (so you see a bridge from below)
  for (const o of objs) {
    if (!o.sunk || o.tunnel) continue;
    const p = o.pts;
    for (let s2 = 0; s2 < p.length / 2 - 1; s2++) {
      if (o.hs[s2] > -2 && o.hs[s2 + 1] > -2) continue;
      const ax = p[s2 * 2], az = p[s2 * 2 + 1], bx = p[s2 * 2 + 2], bz = p[s2 * 2 + 3];
      for (let cx = Math.floor(Math.min(ax, bx) / CELL); cx <= Math.floor(Math.max(ax, bx) / CELL); cx++) for (let cz = Math.floor(Math.min(az, bz) / CELL); cz <= Math.floor(Math.max(az, bz) / CELL); cz++) for (const ref of t.roadGrid.get(ck(cx, cz)) || []) {
        const r = ref.road; if (r === o || r.sunk || r.c > 12 || !r.hs) continue;
        const q = r.pts, k = ref.s; if (Math.abs(r.hs[k]) > 0.5 || Math.abs(r.hs[k + 1]) > 0.5) continue;
        if (!segCross(ax, az, bx, bz, q[k * 2], q[k * 2 + 1], q[k * 2 + 2], q[k * 2 + 3])) continue;
        const ex = q[k * 2 + 2] - q[k * 2], ez = q[k * 2 + 3] - q[k * 2 + 1], L = Math.hypot(ex, ez) || 1, dx = ex / L, dz = ez / L;
        // only the part of the street right over the trench
        const den = (bx - ax) * ez - (bz - az) * ex; if (Math.abs(den) < 1e-6) continue;
        const u = ((q[k * 2] - ax) * ez - (q[k * 2 + 1] - az) * ex) / den, mx = ax + (bx - ax) * u, mz = az + (bz - az) * u;
        const tl = Math.hypot(bx - ax, bz - az) || 1, sinA = Math.max(0.3, Math.abs(dx * (bz - az) - dz * (bx - ax)) / tl);
        boxY(bridgeBuf, mx, mz, dx, dz, (o.w / 2 + 2) / sinA, r.w / 2 + 0.4, -1.1, -0.02, DECK_RGB);
      }
    }
  }
  const bm = bridgeBuf.mesh(concreteMat); if (bm) add(bm);
  const mk = maskBuf.mesh(holeMat); if (mk) { mk.renderOrder = -10; add(mk); }
  const lm = lightBuf.mesh(tunnelLightMat); if (lm) add(lm);
  for (const [mat, b] of bufs) { const m = b.mesh(mat); if (m) { m.renderOrder = 1; add(m); } }
  t.group.updateMatrixWorld(true);
}


function buildRoads(t, d) {
  t.names = d.names;
  t.pois = (d.pois || []).map(p => ({ c: p[0], name: d.names[p[1]] || '', x: p[2], z: p[3] }));
  // 1) road objects + spatial grid
  d.roads.map(r => {
    const spec = roadSpec(r);
    const road = { c: r[0], name: d.names[r[1]] || '', ref: d.names[r[2]] || '', oneway: r[3] & 1, flags: r[3], ms: r[5], w: spec.width, pts: r[6], spec };
    road.obj = road; road.key = wayKey(road);
    t.roads.push(road);
    const p = r[6];
    for (let s = 0; s < p.length / 2 - 1; s++) gridAddSeg(t.roadGrid, p[s * 2], p[s * 2 + 1], p[s * 2 + 2], p[s * 2 + 3], { road, s });
    return road;
  });
  t.roadMeshes = [];
  solveRoads(t, true);
  // water
  const wb = new GeoBuf();
  for (const w of d.water) flatPoly(wb, w, 0.03);
  for (const [ni, pts] of d.rivers) {
    const nm = d.names[ni] || '';
    if (/tunnel/i.test(nm)) continue; // e.g. Bassett Creek runs in a tunnel under downtown
    ribbon(wb, pts, /mississippi/i.test(nm) ? 140 : /minnesota/i.test(nm) ? 60 : 18, 0.02, 1);
  }
  const wm = wb.mesh(waterMat); if (wm) t.group.add(wm);
  t.water = d.water;
  t.group.updateMatrixWorld(true);
  traffic.addRoads(t);
  if (pendingSnap) trySnap();
}

// hand-tuned looks for landmarks whose OSM outline alone can't capture their shape.
// Matched by OSM name (re); `at` is a fallback point for tiles saved before names were kept.
// h only replaces a height OSM doesn't know.
const LANDMARKS = [
  // downtown Minneapolis + St. Paul
  { re: /^U\.?\s?S\.? Bank Stadium/i, at: [44.9736, -93.2575], wall: '#4a5160', shape: 'skillion', dir: 165, roofH: 0.6, plain: true,
    tint: t => t < 0.3 ? rgbOf('#4a5058') : rgbOf('#d3dce0') }, // zinc ridge, translucent ETFE slope
  { re: /^Target Center/i, at: [44.9795, -93.2761], wall: '#9a7b62', roof: '#7f9168', plain: true }, // tan arena with its green roof
  { re: /Xcel Energy Center/i, at: [44.9448, -93.1010], wall: '#a39787', roof: '#8a8f94', plain: true },
  { re: /Huntington Bank Stadium|TCF Bank Stadium/i, at: [44.9765, -93.2246], wall: '#8a5a44', shape: 'bowl' },
  { re: /^Target Field$/i, at: [44.9817, -93.2777], wall: '#d4c6a6', shape: 'bowl' },
  { re: /Allianz Field/i, at: [44.9530, -93.1652], wall: '#d9dde0', shape: 'bowl' },
  { re: /CHS Field/i, at: [44.9505, -93.0843], wall: '#9a9184', shape: 'bowl' },
  { re: /^IDS (Center|Tower)/i, wall: '#5f7d99' },
  { re: /Foshay/i, wall: '#cdbd9c', h: 136 },
  { re: /^Wells Fargo Center/i, wall: '#d6c39c' },
  { re: /^Capella Tower|225 South Sixth/i, wall: '#c3c0b8' },
  { re: /Minneapolis City Hall|Hennepin County Courthouse/i, wall: '#8d6c60', plain: true },
  { re: /Guthrie Theater/i, wall: '#2f3d50', plain: true },
  { re: /Mill City Museum|Washburn A Mill/i, wall: '#a99f92', plain: true },
  // University of Minnesota
  { re: /^Northrop/i, wall: '#a0664c', h: 32, plain: true },
  { re: /Walter Library/i, wall: '#c9a67c', h: 22, plain: true },
  { re: /Coffman Memorial Union/i, wall: '#d7c098', h: 26 },
  { re: /Weisman Art Museum/i, wall: '#d3d9de', roof: '#b9c1c7', h: 18, plain: true }, // Gehry's brushed steel
  { re: /Williams Arena/i, wall: '#9a5a44', roof: '#b7b0a4', shape: 'barrel', roofH: 9, h: 30, plain: true },
  { re: /Mariucci/i, wall: '#9a5a44', h: 20, plain: true },
  { re: /McNamara Alumni Center/i, wall: '#7f716a', h: 26, plain: true },
  { re: /Folwell Hall/i, wall: '#8f4c3a', roof: '#55615a', h: 20 },
  { re: /Pillsbury Hall/i, wall: '#b0704f', h: 18 },
  { re: /Morrill Hall/i, wall: '#c4a882', h: 18 },
  { re: /Burton Hall/i, wall: '#e2dbcc', h: 16 },
  { re: /Eddy Hall/i, wall: '#a0624a', h: 12 },
  { re: /Moos (Health Science )?Tower/i, wall: '#a8a49c' },
  { re: /Wilson Library/i, wall: '#b9b3a7' },
  { re: /Ted Mann Concert Hall/i, wall: '#9e5f48', plain: true },
  { re: /Science Teaching (and|&) Student Services/i, wall: '#c99c6c' },
  { re: /Carlson School/i, wall: '#b88d6c' },
].map(l => { if (!l.at) return l; const [x, z] = proj(l.at[0], l.at[1]); return { ...l, x, z }; });
const CAMPUS_PAL = ['#9b5c45', '#a8674c', '#b98f74', '#c9a77f', '#8e4b3b', '#b07a5c'];
// domes added on top of the building they belong to (only when OSM has no 3D parts for them)
const DOMES = [
  { n: 'State Capitol', at: [44.95522, -93.10224], body: 22, base: 30, top: 68, r: 13, drum: '#efebe2', dome: '#e8e4da' },
  { n: 'Cathedral of Saint Paul', at: [44.94656, -93.10893], body: 30, base: 45, top: 93, r: 15, drum: '#cbbca3', dome: '#6f9c8a' },
  { n: 'Basilica of Saint Mary', at: [44.97316, -93.28625], body: 26, base: 34, top: 75, r: 12, drum: '#ddd6c5', dome: '#7fa392' },
].map(l => { const [x, z] = proj(l.at[0], l.at[1]); return { ...l, x, z }; });
// ballparks OSM only maps as an outline: home plate + foul-line directions (a = 1st-base line, b = 3rd-base line)
const BALLPARKS = [
  { n: 'Target Field', home: [-5440.8, -4637.5], a: [0.698, 0.716], b: [0.716, -0.698], wall: '#d4c6a6', seat: '#2d3b57' },
];
const inBallpark = (x, z) => BALLPARKS.some(bp => Math.hypot(x - bp.home[0] - 50 * (bp.a[0] + bp.b[0]), z - bp.home[1] - 50 * (bp.a[1] + bp.b[1])) < 135);
const circlePts = (x, z, r, k = 20) => { const p = []; for (let i = 0; i < k; i++) { const a = i / k * Math.PI * 2; p.push(x + Math.cos(a) * r, z - Math.sin(a) * r); } return p; };
const PLAIN_TAGS = new Set(['stadium', 'warehouse', 'industrial', 'hangar', 'roof', 'garage', 'garages', 'shed', 'storage_tank', 'silo', 'grandstand', 'parking', 'manufacture', 'barn']);
const bboxOf = pts => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (let i = 0; i < pts.length; i += 2) { a = Math.min(a, pts[i]); c = Math.max(c, pts[i]); b = Math.min(b, pts[i + 1]); d = Math.max(d, pts[i + 1]); } return [a, b, c, d]; };
const inBox = (x, z, b) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3];

function addCollider(t, pts, h) {
  const box = bboxOf(pts), bi = { pts, h, box };
  t.blds.push(bi);
  for (let cx = Math.floor(box[0] / CELL); cx <= Math.floor(box[2] / CELL); cx++) for (let cz = Math.floor(box[1] / CELL); cz <= Math.floor(box[3] / CELL); cz++) {
    const k = ck(cx, cz); let a = t.bldGrid.get(k); if (!a) t.bldGrid.set(k, a = []); a.push(bi);
  }
}
// a full open-air ballpark: field, infield, warning track, wrap-around stands with canopy, outfield seats, scoreboard
function ballpark(t, buf, bp) {
  const [hx, hz] = bp.home, [ax, az] = bp.a, [bx, bz] = bp.b;
  const W = (fa, fb, y) => [hx + fa * ax + fb * bx, y, hz + fa * az + fb * bz];
  const D = Math.PI / 180;
  const wallR = th => { const K = [[0, 100], [22.5, 112], [45, 124], [67.5, 115], [90, 103]]; for (let i = 0; i < 4; i++) if (th <= K[i + 1][0]) { const f = (th - K[i][0]) / 22.5; return K[i][1] + (K[i + 1][1] - K[i][1]) * (f * f * (3 - 2 * f)); } return 103; };
  const arc = (r0, y, from = 0, to = 90, step = 7.5) => { const p = []; for (let th = from; th <= to + 1e-6; th += step) { const r = r0(th); p.push([r * Math.cos(th * D), r * Math.sin(th * D)]); } return p; };
  const col = c => rgbOf(c), grass = col('#4f8f3e'), grass2 = col('#5c9c48'), dirt = col('#a87a52'), seat = col(bp.seat), wall = col(bp.wall), pad = col('#2c4a37'), canopy = col('#e4e3de'), board = col('#1e2328');
  const flat = (poly, y, c) => { // poly in field coords
    let tris; try { tris = THREE.ShapeUtils.triangulateShape(poly.map(p => new THREE.Vector2(p[0], p[1])), []); } catch { return; }
    for (const tr of tris) tri3(buf, W(...poly[tr[0]], y), W(...poly[tr[1]], y), W(...poly[tr[2]], y), c, 1);
  };
  const vquad = (p, q, y0, y1, c, f = 0.85) => { const A = W(...p, y0), B = W(...q, y0), C = W(...q, y1), E = W(...p, y1); tri3(buf, A, B, C, c, f, false); tri3(buf, A, C, E, c, f, false); tri3(buf, A, C, B, c, f, false); tri3(buf, A, E, C, c, f, false); };
  const slope = (pi, pj, qj, qi, yi, yo, c) => { tri3(buf, W(...pi, yi), W(...pj, yi), W(...qj, yo), c, 0.95); tri3(buf, W(...pi, yi), W(...qj, yo), W(...qi, yo), c, 0.95); };
  const solid = (fieldPts, h) => { const w = []; for (const p of fieldPts) { const v = W(...p, 0); w.push(v[0], v[2]); } const box = bboxOf(w); if (!spansRoad(t, w, box)) addCollider(t, w, h); };
  // playing surface (fair + foul territory), warning track, infield
  const foul = [[100, -11], [10, -14], [-6, -17], [-15, -15], [-17, -6], [-14, 10], [-11, 103]];
  const out = arc(wallR, 0, 0, 90).reverse(); // LF corner → RF corner
  flat([...foul, [0, 103], ...out.slice(1, -1), [100, 0]], 0.3, grass);
  const track = arc(th => wallR(th) - 5, 0, 0, 90);
  for (let i = 0; i < track.length - 1; i++) { const o = out[out.length - 1 - i], o2 = out[out.length - 2 - i]; flat([track[i], track[i + 1], o2, o], 0.33, dirt); }
  flat([[0, 0], ...arc(() => 29, 0, 0, 90, 10)], 0.33, dirt);
  flat(circlePts(0, 0, 4.5, 12).reduce((a, v, i, s) => (i % 2 ? a : a.concat([[s[i], s[i + 1]]])), []), 0.34, dirt);
  flat([[3.2, 3.2], [25.2, 3.2], [25.2, 25.2], [3.2, 25.2]], 0.36, grass2);
  flat(circlePts(12.9, 12.9, 2.8, 10).reduce((a, v, i, s) => (i % 2 ? a : a.concat([[s[i], s[i + 1]]])), []), 0.39, dirt);
  // main grandstand wrapping from the right-field corner behind home to the left-field corner
  const dirs = [[0.15, -1], [0, -1], [-0.35, -0.94], [-0.707, -0.707], [-0.94, -0.35], [-1, 0], [-1, 0.15]];
  const DEPTH = 42, TOP = 26, CAN = 34;
  const outerAt = (k, d) => { const [dx, dz] = dirs[k], l = Math.hypot(dx, dz); return [foul[k][0] + dx / l * d, foul[k][1] + dz / l * d]; };
  for (let k = 0; k < foul.length - 1; k++) {
    const pi = foul[k], pj = foul[k + 1], qi = outerAt(k, DEPTH), qj = outerAt(k + 1, DEPTH);
    vquad(pi, pj, 0.3, 3, pad);
    slope(pi, pj, qj, qi, 3, TOP, seat);
    vquad(qi, qj, 0, TOP + 1.5, wall, 0.9);
    const ci = outerAt(k, 18), cj = outerAt(k + 1, 18), ei = outerAt(k, DEPTH + 4), ej = outerAt(k + 1, DEPTH + 4);
    slope(ci, cj, ej, ei, CAN, CAN, canopy); slope(ci, ei, ej, cj, CAN - 0.8, CAN - 0.8, canopy); vquad(ci, cj, CAN - 0.8, CAN, canopy);
    solid([pi, pj, qj, qi], TOP);
  }
  // outfield seats (taller in right field over Twins Way), batter's eye and the big left-field scoreboard
  const bl = arc(th => wallR(th), 0, 0, 90, 7.5), br = arc(th => wallR(th) + (th < 35 ? 26 : 20), 0, 0, 90, 7.5);
  for (let i = 0; i < bl.length - 1; i++) {
    const th = i * 7.5 + 3.75; if (th > 38 && th < 52) continue; // gap for the batter's eye
    const yIn = th < 35 ? 7 : 2.5, yOut = th < 35 ? 20 : 13;
    vquad(bl[i], bl[i + 1], 0.3, yIn, pad); slope(bl[i], bl[i + 1], br[i + 1], br[i], yIn, yOut, seat); vquad(br[i], br[i + 1], 0, yOut + 1, wall, 0.9);
    solid([bl[i], bl[i + 1], br[i + 1], br[i]], yOut);
  }
  const eye = arc(th => wallR(th) + 1, 0, 39, 51, 6), eye2 = arc(th => wallR(th) + 10, 0, 39, 51, 6);
  for (let i = 0; i < eye.length - 1; i++) { slope(eye[i], eye[i + 1], eye2[i + 1], eye2[i], 11, 11, pad); vquad(eye[i], eye[i + 1], 0.3, 11, pad); }
  const s1 = arc(th => wallR(th) + 24, 0, 58, 74, 8), s2 = arc(th => wallR(th) + 27, 0, 58, 74, 8);
  for (let i = 0; i < s1.length - 1; i++) { vquad(s1[i], s1[i + 1], 13, 31, board, 1); vquad(s2[i], s2[i + 1], 13, 31, board, 0.7); slope(s1[i], s1[i + 1], s2[i + 1], s2[i], 31, 31, board); }
}

// ── street furniture: traffic lights, stop signs, skyways ──
// lit lamps share 6 materials (2 signal phases × red/yellow/green) that frame() switches on and off
const litMats = [0, 1].map(() => ['#ff3b30', '#ffc400', '#36ff6a'].map(c => new THREE.MeshBasicMaterial({ color: c })));
function updateSignals(now) {
  const c = (now / 1000) % 30, st = [c < 12 ? 2 : c < 15 ? 1 : 0, c < 15 ? 0 : c < 27 ? 2 : 1];
  for (let p = 0; p < 2; p++) for (let k = 0; k < 3; k++) litMats[p][k].visible = st[p] === k;
}
function quadN(buf, A, B, C, D, n, rgb, f = 1) { // flat quad facing n
  const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
  const flip = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2] < 0;
  const base = buf.vc;
  buf.p.push(...A, ...B, ...C, ...D);
  for (let k = 0; k < 4; k++) { buf.n.push(n[0], n[1], n[2]); buf.c.push(rgb[0] * f, rgb[1] * f, rgb[2] * f); }
  if (flip) buf.i.push(base, base + 2, base + 1, base, base + 3, base + 2); else buf.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
// box from y0 to y1, centred at (cx, cz), half-sizes hx along (ux, uz) and hz across it
function boxY(buf, cx, cz, ux, uz, hx, hz, y0, y1, side, top = side, bottom = side) {
  const vx = -uz, vz = ux, P = (a, b, y) => [cx + ux * a + vx * b, y, cz + uz * a + vz * b];
  const c = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  for (let i = 0; i < 4; i++) {
    const [a0, b0] = c[i], [a1, b1] = c[(i + 1) % 4], ma = (a0 + a1) / 2, mb = (b0 + b1) / 2, l = Math.hypot(ma, mb) || 1;
    const n = [(ux * ma + vx * mb) / l, 0, (uz * ma + vz * mb) / l];
    quadN(buf, P(a0, b0, y0), P(a1, b1, y0), P(a1, b1, y1), P(a0, b0, y1), n, side, 0.8 + 0.2 * Math.abs(n[0]));
  }
  quadN(buf, P(-hx, -hz, y1), P(hx, -hz, y1), P(hx, hz, y1), P(-hx, hz, y1), [0, 1, 0], top);
  if (bottom) quadN(buf, P(-hx, -hz, y0), P(hx, -hz, y0), P(hx, hz, y0), P(-hx, hz, y0), [0, -1, 0], bottom, 0.7);
}
// which ways does traffic arrive at this point? → [{dx, dz (unit travel dir), w, c, end (m to the road's end ahead)}]
function approachesAt(t, x, z) {
  const out = [], seen = new Set(), gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const ref of t.roadGrid.get(ck(gx + i, gz + j)) || []) {
    const r = ref.road, s = ref.s, key = r.pts.length + ':' + s + ':' + r.pts[0];
    if (seen.has(key) || r.c > 12 || r.tunnel) continue; seen.add(key);
    const q = r.pts, ax = q[s * 2], az = q[s * 2 + 1], bx = q[s * 2 + 2], bz = q[s * 2 + 3];
    const ex = bx - ax, ez = bz - az, L = Math.hypot(ex, ez); if (L < 0.5) continue;
    let u = ((x - ax) * ex + (z - az) * ez) / (L * L); u = Math.max(0, Math.min(1, u));
    if (Math.hypot(ax + ex * u - x, az + ez * u - z) > 3) continue;
    if (r.hs && Math.max(r.hs[s] || 0, r.hs[s + 1] || 0) > 0.5) continue; // up on a bridge
    const n = q.length / 2, dStart = Math.hypot(q[0] - x, q[1] - z), dEnd = Math.hypot(q[n * 2 - 2] - x, q[n * 2 - 1] - z);
    if (u * L > 4) out.push({ dx: ex / L, dz: ez / L, w: r.w, c: r.c, end: dEnd, name: r.name, sp: r.spec, one: r.oneway });
    if ((1 - u) * L > 4 && !r.oneway) out.push({ dx: -ex / L, dz: -ez / L, w: r.w, c: r.c, end: dStart, name: r.name, sp: r.spec, one: r.oneway });
  }
  const res = [];
  for (const a of out) if (!res.some(b => a.dx * b.dx + a.dz * b.dz > 0.9)) res.push(a);
  return res;
}
const markMat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -14, polygonOffsetUnits: -30 });
markMat.userData.snowK = 0.35; markMat.userData.wetK = 0.8;
const SIGN_RED = rgbOf('#c8281e'), SIGN_GREY = rgbOf('#8d9196'), POLE = rgbOf('#55595d'), HEAD = rgbOf('#2b2b26'), WHITE = rgbOf('#f4f4f0'), DIM = ['#4a1714', '#4a3d10', '#123a1d'].map(rgbOf);
function streetFurniture(t, d, buf, lit) {
  const mine = (x, z) => tileOf(x, z).join(',') === t.key;
  const placed = []; // approaches already given a signal (dual carriageways map several signal nodes per junction)
  t.sigBlades = []; // street-name signs on the mast arms (drawn with the street-sign atlas)
  // pavement markings for an approach: a stop bar across its lanes and, at signals, a ladder crosswalk
  const MARK = rgbOf('#ecebe6'), markBuf = new GeoBuf();
  const mark = (a, x, z, d0, walk) => {
    const sp = a.sp, rx = -a.dz, rz = a.dx, y = 0.06 + (RC[a.c]?.p || 0) * 0.018 + 0.06, hw = a.w / 2;
    const flat = (u0, u1, b0, b1) => { // u across (+ = right), b back from the junction
      const P = (u, b) => [x - a.dx * b + rx * u, y, z - a.dz * b + rz * u];
      quadN(markBuf, P(u0, b1), P(u1, b1), P(u1, b0), P(u0, b0), [0, 1, 0], MARK);
    };
    let s0 = -hw + (sp ? sp.shL : 0.3), s1 = hw - (sp ? sp.shR : 0.3);
    if (!a.one) s0 = sp && sp.kind !== 'minor' && sp.lanes >= 3 && sp.lanes % 2 ? sp.laneW / 2 : 0.15; // two-way: just our half
    if (s1 - s0 > 1) flat(s0, s1, d0 + (walk ? 3.6 : 0.2), d0 + (walk ? 4.1 : 0.7));
    if (walk) for (let u = -hw + 0.5; u < hw - 0.3; u += 1.1) flat(u, u + 0.5, d0, d0 + 3);
  };
  for (const [type, x, z, all] of d.signals || []) {
    if (!mine(x, z)) continue;
    const ap = approachesAt(t, x, z); if (!ap.length) continue;
    const cross = ap.length > 2 ? Math.max(...ap.map(a => a.w)) / 2 + 2 : 2.5;
    let use = ap;
    if (type === 1) { // stop sign: minor road approaches, or the way heading to the nearer junction
      if (all) use = ap;
      else if (ap.length > 2) { const mc = Math.max(...ap.map(a => a.c)); use = ap.some(a => a.c !== mc) ? ap.filter(a => a.c === mc) : ap; }
      else use = [ap.reduce((m, a) => a.end < m.end ? a : m)];
    }
    for (const a of use) {
      const rx = -a.dz, rz = a.dx; // right-hand side
      if (type === 0) {
        if (placed.some(p => Math.hypot(p.x - x, p.z - z) < 35 && p.dx * a.dx + p.dz * a.dz > 0.9)) continue;
        placed.push({ x, z, dx: a.dx, dz: a.dz });
        mark(a, x, z, Math.max(0.5, cross - 0.6), true);
        const px = x - a.dx * cross + rx * (a.w / 2 + 1.6), pz = z - a.dz * cross + rz * (a.w / 2 + 1.6);
        const L = Math.min(Math.max(a.w * 0.7, 5), 13);
        boxY(buf, px, pz, a.dx, a.dz, 0.18, 0.18, 0, 6.9, POLE);
        boxY(buf, px - rx * L / 2, pz - rz * L / 2, rx, rz, L / 2, 0.12, 6.35, 6.6, POLE);
        // the cross street's name hangs on the arm, facing the drivers who are arriving
        const crossSt = ap.find(b => b.name && b.name !== a.name && Math.abs(b.dx * a.dx + b.dz * a.dz) < 0.75);
        if (crossSt) {
          const room = L * 0.55 - 0.24 - 0.18 - 0.4, bw = Math.min(3.4, room), onTop = bw < 1.8;
          const w = onTop ? Math.min(3.4, L * 0.9) : bw, off = onTop ? L / 2 : 0.18 + 0.2 + bw / 2, y = onTop ? 6.75 + w * 0.08 : 6.3 - w * 0.08;
          const bx = px - rx * off - a.dx * 0.16, bz = pz - rz * off - a.dz * 0.16;
          t.sigBlades.push({ x: bx, y, z: bz, nx: -a.dx, nz: -a.dz, w, h: w * 0.16, name: crossSt.name });
          boxY(buf, bx + a.dx * 0.03, bz + a.dz * 0.03, rx, rz, w / 2, 0.02, y - w * 0.08, y + w * 0.08, SIGN_GREY); // back of the sign
          if (onTop) boxY(buf, bx + a.dx * 0.1, bz + a.dz * 0.1, rx, rz, 0.04, 0.04, 6.6, y - w * 0.08, POLE);
        }
        const ang = (Math.atan2(a.dz, a.dx) * 180 / Math.PI + 405) % 180, phase = ang < 90 ? 0 : 1;
        for (const off of [L * 0.55, L * 0.95]) { // two heads over the lanes
          const hx = px - rx * off, hz = pz - rz * off;
          boxY(buf, hx, hz, rx, rz, 0.24, 0.2, 5.15, 6.35, HEAD);
          for (let k = 0; k < 3; k++) {
            const y = 6.0 - k * 0.35, fx = hx - a.dx * 0.21, fz = hz - a.dz * 0.21, s = 0.14;
            const P = (u, v, o) => [fx + rx * u - a.dx * o, y + v, fz + rz * u - a.dz * o];
            quadN(buf, P(-s, -s, 0), P(s, -s, 0), P(s, s, 0), P(-s, s, 0), [-a.dx, 0, -a.dz], DIM[k]);
            quadN(lit[phase][k], P(-s, -s, 0.02), P(s, -s, 0.02), P(s, s, 0.02), P(-s, s, 0.02), [-a.dx, 0, -a.dz], WHITE);
          }
        }
      } else {
        const back = ap.length > 2 ? cross : 0.5;
        mark(a, x, z, Math.max(1, back - 0.4), false);
        const px = x - a.dx * back + rx * (a.w / 2 + 1.2), pz = z - a.dz * back + rz * (a.w / 2 + 1.2);
        boxY(buf, px, pz, a.dx, a.dz, 0.05, 0.05, 0, 2.15, POLE);
        const R = 0.55, cy = 2.5, fx = px - a.dx * 0.07, fz = pz - a.dz * 0.07;
        const O = (k, rr, o) => { const th = (k + 0.5) / 8 * Math.PI * 2; return [fx + rx * Math.cos(th) * rr - a.dx * o, cy + Math.sin(th) * rr, fz + rz * Math.cos(th) * rr - a.dz * o]; };
        for (let k = 0; k < 8; k++) {
          const c0 = [fx, cy, fz], cb = [fx + a.dx * 0.03, cy, fz + a.dz * 0.03];
          tri3(buf, c0, O(k, R, 0), O(k + 1, R, 0), SIGN_RED, 1, false); tri3(buf, c0, O(k + 1, R, 0), O(k, R, 0), SIGN_RED, 1, false);
          tri3(buf, cb, O(k, R, -0.03), O(k + 1, R, -0.03), SIGN_GREY, 0.8, false);
        }
        const P = (u, v) => [fx + rx * u - a.dx * 0.015, cy + v, fz + rz * u - a.dz * 0.015];
        quadN(buf, P(-0.33, -0.08), P(0.33, -0.08), P(0.33, 0.08), P(-0.33, 0.08), [-a.dx, 0, -a.dz], WHITE);
      }
    }
  }
  const mm = markBuf.mesh(markMat, true); if (mm) { mm.renderOrder = 2; t.group.add(mm); t.bldMeshes.push(mm); }
  // skyways: glass tubes one floor up, between downtown buildings
  const glass = rgbOf('#86a8bf'), roof = rgbOf('#5f676d'), under = rgbOf('#4b5156');
  for (const pts of d.skyways || []) for (let i = 0; i < pts.length / 2 - 1; i++) {
    const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3], L = Math.hypot(bx - ax, bz - az);
    if (L < 1 || !mine((ax + bx) / 2, (az + bz) / 2)) continue;
    boxY(buf, (ax + bx) / 2, (az + bz) / 2, (bx - ax) / L, (bz - az) / L, L / 2 + 0.4, 2.2, 5.6, 9, glass, roof, under);
  }
}

// ── signage: business names on their buildings (plain lit signs, no logos), pylons, and billboards ──
const SIGN_W = 384, SIGN_H = 60, ATLAS_W = 768, ATLAS_H = 1500, SIGN_COLS = 2, SIGN_MAX = 50;
// sign lettering (Google Fonts, loaded in index.html); until they arrive the browser's fallbacks are used and
// every sign atlas is redrawn once they're in
const SF = {
  sans: s => `800 ${s}px Montserrat, system-ui, sans-serif`, cond: s => `600 ${s}px Oswald, 'Arial Narrow', sans-serif`,
  bebas: s => `${s}px 'Bebas Neue', Impact, sans-serif`, black: s => `${s}px 'Archivo Black', 'Arial Black', sans-serif`,
  anton: s => `${s}px Anton, Impact, sans-serif`, script: s => `${s}px Pacifico, cursive`, lobster: s => `${s}px Lobster, cursive`,
  satisfy: s => `${s}px Satisfy, cursive`, serif: s => `700 ${s}px 'Playfair Display', Georgia, serif`,
  slab: s => `700 ${s}px 'Roboto Slab', Rockwell, serif`, round: s => `${s}px Righteous, sans-serif`, fat: s => `${s}px 'Abril Fatface', Georgia, serif`,
};
const SIGN_UPPER = new Set(['cond', 'bebas', 'black', 'anton']);
// sign looks: kind = box (lit cabinet) | letters (channel letters on the wall) | neon | panel (framed plaque)
// chains get their familiar colours and type style — the name only, no logo artwork
const CHAINS = [
  [/^target$/i, 'letters', '#cc0000', null, 'sans', 1], [/^target (center|field)/i, 'letters', '#ffffff', null, 'sans', 1],
  [/^walmart/i, 'letters', '#0071ce', null, 'sans', 1], [/^costco/i, 'letters', '#e31837', null, 'black', 1],
  [/^cub( foods)?$/i, 'box', '#d71920', '#ffffff', 'black', 1], [/^hy-?vee/i, 'letters', '#e21f26', null, 'lobster', 1],
  [/^lunds/i, 'letters', '#1f3b2d', null, 'serif', 1], [/^kowalski/i, 'letters', '#0b4d2c', null, 'serif', 1],
  [/^aldi/i, 'box', '#00205b', '#ffffff', 'sans', 1], [/^trader joe/i, 'letters', '#c8102e', null, 'lobster', 1],
  [/^whole foods/i, 'box', '#00674b', '#ffffff', 'serif', 1], [/^(the )?home depot/i, 'box', '#f96302', '#ffffff', 'black', 1],
  [/^menards/i, 'box', '#00843d', '#ffffff', 'black', 1], [/^fleet farm/i, 'box', '#c8102e', '#ffffff', 'black', 1],
  [/^best buy/i, 'box', '#ffe000', '#1d252c', 'black', 1], [/^kohl'?s/i, 'letters', '#1a1a1a', null, 'sans', 1],
  [/^petsmart/i, 'letters', '#e31837', null, 'sans', 1], [/^dollar tree/i, 'box', '#00953a', '#ffffff', 'sans'],
  [/^dollar general/i, 'box', '#ffd200', '#111111', 'black'], [/^walgreens/i, 'letters', '#e31837', null, 'script'],
  [/^cvs/i, 'letters', '#cc0000', null, 'sans'], [/^speedway/i, 'letters', '#e21b23', null, 'black'],
  [/^holiday( stationstores)?$/i, 'box', '#00377b', '#ffffff', 'sans'], [/^kwik trip/i, 'box', '#d2232a', '#ffffff', 'black'],
  [/^marathon/i, 'box', '#003893', '#ffffff', 'black'], [/^bp( shop)?$/i, 'box', '#009b3a', '#ffffff', 'sans'],
  [/^mobil/i, 'letters', '#1d4f91', null, 'sans'], [/^casey/i, 'box', '#c8102e', '#ffffff', 'black'], [/^super ?america/i, 'box', '#d71920', '#ffffff', 'black'],
  [/^starbucks/i, 'box', '#00704a', '#ffffff', 'sans'], [/^caribou/i, 'box', '#3d2b1f', '#e9d8b4', 'serif'],
  [/^dunn bros|^dunn brothers/i, 'box', '#6d2c2c', '#f3e3c3', 'serif'], [/^dunkin/i, 'letters', '#ff671f', null, 'round'],
  [/^bruegger/i, 'box', '#f6a01a', '#4a2a12', 'slab'], [/^panera/i, 'box', '#4d5c31', '#ffffff', 'serif'],
  [/^mcdonald/i, 'box', '#da291c', '#ffc72c', 'sans'], [/^burger king/i, 'box', '#502314', '#f5ebdc', 'round'],
  [/^wendy'?s/i, 'letters', '#e2203c', null, 'lobster'], [/^taco bell/i, 'box', '#702082', '#ffffff', 'sans'],
  [/^subway/i, 'box', '#008c15', '#ffc600', 'black'], [/^jimmy john/i, 'box', '#111111', '#ffffff', 'black'],
  [/^chipotle/i, 'box', '#441500', '#ffffff', 'serif'], [/^qdoba/i, 'box', '#e94e1b', '#ffffff', 'sans'],
  [/^arby'?s/i, 'letters', '#d71920', null, 'fat'], [/^dairy queen/i, 'box', '#ee3124', '#ffffff', 'round'],
  [/^culver'?s/i, 'box', '#005696', '#ffffff', 'serif'], [/^chick-?fil-?a/i, 'letters', '#e51636', null, 'script'],
  [/^raising cane/i, 'box', '#d2232a', '#ffd200', 'black'], [/^popeyes/i, 'box', '#f15a22', '#ffffff', 'black'],
  [/^domino'?s/i, 'box', '#006491', '#ffffff', 'black'], [/^pizza hut/i, 'letters', '#ee3a43', null, 'round'],
  [/^papa john/i, 'box', '#148257', '#ffffff', 'black'], [/^little caesars/i, 'box', '#ff6900', '#111111', 'black'],
  [/^five guys/i, 'box', '#d2232a', '#ffffff', 'black'], [/^potbelly/i, 'box', '#2f2a26', '#f4e2b8', 'slab'],
  [/^jersey mike/i, 'box', '#003a70', '#ffffff', 'black'], [/^punch pizza/i, 'box', '#b5121b', '#ffffff', 'slab'],
  [/^noodles/i, 'box', '#d7282f', '#ffffff', 'sans'], [/^buffalo wild wings/i, 'box', '#ffc600', '#111111', 'black'],
  [/^chili'?s/i, 'letters', '#c8102e', null, 'black'], [/^applebee/i, 'letters', '#c8102e', null, 'satisfy'],
  [/^leeann chin/i, 'box', '#b5121b', '#ffffff', 'serif'], [/^white castle/i, 'box', '#ffffff', '#1d428a', 'slab'],
  [/^sweetgreen/i, 'letters', '#0b5e3c', null, 'sans'], [/^jamba/i, 'letters', '#ef3e42', null, 'round'],
  [/^insomnia cookies/i, 'box', '#1d1d5b', '#ffffff', 'script'], [/^erbert/i, 'box', '#0b6b3a', '#ffffff', 'slab'],
  [/^wells fargo/i, 'box', '#d71e28', '#ffcd41', 'serif'], [/^u\.?s\.? bank/i, 'letters', '#0c2074', null, 'sans'],
  [/^chase/i, 'letters', '#117aca', null, 'sans'], [/^bank of america/i, 'letters', '#012169', null, 'sans'],
  [/^huntington/i, 'letters', '#00843d', null, 'sans'], [/^associated bank/i, 'letters', '#0c4e86', null, 'sans'],
  [/^bremer/i, 'letters', '#00557f', null, 'serif'], [/^bmo/i, 'box', '#0079c1', '#ffffff', 'sans'],
  [/^affinity plus/i, 'letters', '#005daa', null, 'sans'], [/^old national/i, 'letters', '#001e60', null, 'serif'],
  [/^t-mobile|^metro by t-mobile/i, 'box', '#e20074', '#ffffff', 'sans'], [/^verizon/i, 'box', '#111111', '#ffffff', 'sans'],
  [/^cricket/i, 'box', '#00953b', '#ffffff', 'sans'], [/^boost mobile/i, 'box', '#f7941d', '#111111', 'black'],
  [/^great clips/i, 'box', '#00a3e0', '#ffffff', 'sans'], [/^sport clips/i, 'box', '#002f6c', '#ffffff', 'black'],
  [/^autozone/i, 'box', '#f26100', '#ffffff', 'black'], [/^tires plus/i, 'box', '#d71920', '#ffffff', 'black'],
  [/^firestone/i, 'box', '#c8102e', '#ffffff', 'black'], [/^valvoline/i, 'box', '#003da5', '#ffffff', 'black'],
  [/^public storage/i, 'box', '#f47920', '#ffffff', 'black'], [/^extra space/i, 'box', '#00833e', '#ffffff', 'sans'],
  [/^u-haul/i, 'box', '#f47920', '#ffffff', 'black'], [/^the ups store/i, 'box', '#3d2314', '#ffb500', 'sans'],
  [/^fedex/i, 'box', '#4d148c', '#ffffff', 'sans'], [/^united states post office|^usps/i, 'letters', '#1f3a68', null, 'serif'],
  [/^mattress firm/i, 'box', '#e31837', '#ffffff', 'sans'], [/^sherwin-williams/i, 'box', '#0069a7', '#ffffff', 'sans'],
  [/^massage envy/i, 'box', '#3a1d5c', '#ffffff', 'serif'], [/^european wax/i, 'box', '#1b1b1b', '#ffffff', 'serif'],
  [/^holiday inn/i, 'letters', '#008751', null, 'sans', 1], [/^hampton/i, 'letters', '#ffffff', null, 'serif', 1],
  [/^residence inn|marriott|marriot/i, 'letters', '#ffffff', null, 'serif', 1], [/^hilton|doubletree|embassy suites/i, 'letters', '#ffffff', null, 'serif', 1],
  [/^ymca/i, 'letters', '#c8102e', null, 'black'], [/^allina/i, 'letters', '#1b365d', null, 'sans'],
  [/^warners' stellian/i, 'box', '#c8102e', '#ffffff', 'serif'], [/^chuck & don/i, 'box', '#e35205', '#ffffff', 'round'],
];
const pick = (h, a) => a[h % a.length];
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
// the look of a business's sign: a known chain's, otherwise a varied one picked from what kind of place it is
function signStyle(name, c) {
  for (const [re, kind, a, b, font, big] of CHAINS) if (re.test(name)) return { kind, fg: kind === 'box' ? b : a, bg: kind === 'box' ? a : null, font, big: !!big };
  const h = hashStr(name), h2 = h >>> 8, h3 = h >>> 16;
  const WARM = ['#7a1f1f', '#8c2f1b', '#2f4a3a', '#1f2a44', '#3b2a20', '#5a1e3c', '#123c4a', '#22313f'];
  const LETTER = ['#c8102e', '#1f4e9c', '#0b6b3a', '#ffffff', '#f2c14e', '#e86a2c', '#6a1b9a', '#111111'];
  const CREAM = ['#fff4d6', '#ffffff', '#ffd27a', '#f6e7c8'];
  const NEON = ['#ff4fd8', '#3df2ff', '#ffde59', '#ff5c5c', '#7cff6b', '#ff9f1c'];
  if (/\b(bar|pub|tavern|saloon|taproom|tap room|brewing|brewery|lounge|cocktail|grill & bar|nightclub|club)\b/i.test(name) || (c === 7 && /theat|cinema|bowl|arcade/i.test(name)))
    return { kind: 'neon', fg: pick(h2, NEON), bg: '#121014', font: pick(h3, ['script', 'lobster', 'round', 'satisfy', 'bebas']) };
  switch (c) {
    case 0: return pick(h, [
      { kind: 'box', bg: pick(h2, WARM), fg: pick(h3, CREAM), font: pick(h3 >>> 2, ['serif', 'slab', 'lobster', 'cond', 'fat']) },
      { kind: 'letters', fg: pick(h2, ['#c8102e', '#ffffff', '#f2c14e', '#e86a2c', '#2f6e3b']), font: pick(h3, ['script', 'lobster', 'fat', 'bebas', 'satisfy']) },
      { kind: 'panel', bg: pick(h2, ['#f4ead5', '#1b1b1b', '#efe6d2', '#24323f']), fg: null, font: pick(h3, ['serif', 'slab', 'cond']) }]);
    case 1: return pick(h, [
      { kind: 'letters', fg: pick(h2, ['#ffffff', '#3b2416', '#f2c14e', '#0e4d3a']), font: pick(h3, ['script', 'satisfy', 'serif', 'cond']) },
      { kind: 'panel', bg: pick(h2, ['#1d1d1d', '#f3ead8', '#123c2e', '#3b2416']), fg: null, font: pick(h3, ['serif', 'slab', 'satisfy']) }]);
    case 2: return { kind: 'box', bg: pick(h2, ['#c8102e', '#003893', '#00843d', '#111111']), fg: '#ffffff', font: pick(h3, ['black', 'sans', 'anton']) };
    case 4: return pick(h, [{ kind: 'letters', fg: pick(h2, LETTER), font: pick(h3, ['sans', 'black', 'serif']) }, { kind: 'box', bg: pick(h2, ['#0b6b3a', '#c8102e', '#1f4e9c']), fg: '#ffffff', font: pick(h3, ['sans', 'round', 'slab']) }]);
    case 5: return pick(h, [{ kind: 'panel', bg: '#ffffff', fg: pick(h2, ['#005a9c', '#00857c', '#4b2e83', '#c8102e']), font: pick(h3, ['sans', 'slab']) }, { kind: 'letters', fg: pick(h2, ['#ffffff', '#005a9c', '#00857c']), font: 'sans' }]);
    case 6: return { kind: 'letters', fg: pick(h2, ['#ffffff', '#c9a86a', '#7a0019', '#003b71']), font: pick(h3, ['slab', 'serif', 'cond']) };
    case 7: return pick(h, [{ kind: 'box', bg: pick(h2, ['#5a189a', '#c1121f', '#003049', '#111111']), fg: pick(h3, ['#ffd60a', '#ffffff', '#7fd3ff']), font: pick(h3 >>> 3, ['bebas', 'round', 'black', 'fat']) }, { kind: 'letters', fg: pick(h2, LETTER), font: pick(h3, ['bebas', 'fat', 'round']) }]);
    case 9: return { kind: 'letters', fg: pick(h2, ['#ffffff', '#c9a86a', '#f2c14e']), font: pick(h3, ['serif', 'sans', 'satisfy']), big: true };
    case 10: return { kind: 'letters', fg: pick(h2, ['#0c2074', '#0b6b3a', '#7a0019', '#ffffff', '#1f3a68']), font: pick(h3, ['sans', 'serif', 'slab']) };
    case 11: case 12: return { kind: 'letters', fg: pick(h2, ['#c9a86a', '#d9d4c7', '#b08d57', '#ffffff']), font: pick(h3, ['serif', 'slab', 'cond']) };
    default: return pick(h, [
      { kind: 'letters', fg: pick(h2, LETTER), font: pick(h3, ['sans', 'black', 'cond', 'round', 'script', 'serif']) },
      { kind: 'box', bg: pick(h2, WARM.concat(['#1f4e9c', '#c8102e', '#0b6b3a'])), fg: pick(h3, CREAM.concat(['#ffffff', '#ffd60a'])), font: pick(h3 >>> 3, ['sans', 'cond', 'slab', 'round', 'bebas']) },
      { kind: 'panel', bg: pick(h2, ['#f4ead5', '#1b1b1b', '#ffffff', '#24323f']), fg: null, font: pick(h3, ['serif', 'sans', 'slab']) }]);
  }
}
const lumOf = hex => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255; };
function drawSign(ctx, slot, text, st) {
  const x0 = (slot % SIGN_COLS) * SIGN_W, y0 = Math.floor(slot / SIGN_COLS) * SIGN_H, W = SIGN_W, H = SIGN_H;
  ctx.save(); ctx.clearRect(x0, y0, W, H);
  ctx.beginPath(); ctx.rect(x0, y0, W, H); ctx.clip();
  const t0 = SIGN_UPPER.has(st.font) ? text.toUpperCase() : text;
  const script = st.font === 'script' || st.font === 'lobster' || st.font === 'satisfy';
  let fg = st.fg, pad = 18, maxH = H * 0.62;
  if (st.kind === 'box') {
    ctx.fillStyle = st.bg; ctx.fillRect(x0, y0, W, H);
    const g = ctx.createLinearGradient(0, y0, 0, y0 + H); g.addColorStop(0, 'rgba(255,255,255,.16)'); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,.18)');
    ctx.fillStyle = g; ctx.fillRect(x0, y0, W, H);
  } else if (st.kind === 'panel') {
    const light = lumOf(st.bg) > 0.6;
    ctx.fillStyle = st.bg; ctx.fillRect(x0, y0, W, H);
    fg = st.fg || (light ? '#2b2b2b' : '#f3e9d2');
    ctx.strokeStyle = fg; ctx.lineWidth = 3; ctx.strokeRect(x0 + 6, y0 + 6, W - 12, H - 12);
    pad = 26; maxH = H * 0.5;
  } else if (st.kind === 'neon') {
    ctx.fillStyle = st.bg; ctx.fillRect(x0, y0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 2; ctx.strokeRect(x0 + 2, y0 + 2, W - 4, H - 4);
  } else { maxH = H * 0.78; pad = 6; } // letters: bare letters, the wall shows through
  let fs = Math.round(maxH * (script ? 0.9 : 1)); ctx.font = SF[st.font](fs);
  while (fs > 14 && ctx.measureText(t0).width > W - pad * 2) { fs--; ctx.font = SF[st.font](fs); }
  let t = t0; while (ctx.measureText(t).width > W - pad * 2 && t.length > 4) t = t.slice(0, -2) + '…';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const cx = x0 + W / 2, cy = y0 + H / 2 + (script ? -2 : 2);
  if (st.kind === 'neon') {
    ctx.shadowColor = fg; ctx.shadowBlur = 16; ctx.fillStyle = fg; ctx.fillText(t, cx, cy); ctx.fillText(t, cx, cy);
    ctx.shadowBlur = 4; ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.85; ctx.font = SF[st.font](fs - 1); ctx.fillText(t, cx, cy);
  } else if (st.kind === 'letters') {
    const light = lumOf(fg) > 0.6; // a thin return edge so the letters read on any wall
    ctx.lineJoin = 'round'; ctx.lineWidth = 5; ctx.strokeStyle = light ? 'rgba(40,40,40,.85)' : 'rgba(255,255,255,.35)';
    ctx.strokeText(t, cx, cy); ctx.fillStyle = fg; ctx.fillText(t, cx, cy);
  } else { ctx.fillStyle = fg; ctx.fillText(t, cx, cy); }
  ctx.restore();
  return [x0 / ATLAS_W, 1 - (y0 + H) / ATLAS_H, (x0 + W) / ATLAS_W, 1 - y0 / ATLAS_H];
}
// redraw every live sign atlas once the sign fonts have loaded
const signAtlases = new Set();
// sign atlases: half resolution in light graphics; the canvas is emptied once its texture is on the GPU, because phones
// (iOS especially) cap the memory all canvases may use and crash the page when it runs out
const ATLAS_S = LOW ? 0.5 : 1;
function atlasCanvas(w, h) {
  const can = document.createElement('canvas'); can.width = Math.round(w * ATLAS_S); can.height = Math.round(h * ATLAS_S);
  const ctx = can.getContext('2d'); ctx.scale(ATLAS_S, ATLAS_S); return [can, ctx];
}
function atlasTexture(can) {
  const tex = new THREE.CanvasTexture(can); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  tex.onUpdate = () => { if (signFontsReady && tex.image && tex.image.width) { tex.image.width = tex.image.height = 1; } }; // keep it until the fonts have redrawn it
  return tex;
}
let signFontsReady = false;
if (document.fonts && document.fonts.load) {
  Promise.all(Object.values(SF).map(f => document.fonts.load(f(40), 'Ag')).map(p => p.catch(() => null))).then(() => {
    signFontsReady = true;
    for (const a of signAtlases) { if (!a.mesh.parent) { signAtlases.delete(a); continue; } a.redraw(); }
  });
}
// textured quad: centre (x, y, z), facing (nx, nz), width w, height h; uv rect [u0, v0, u1, v1]
function signQuad(buf, x, y, z, nx, nz, w, h, uv, flip = false) {
  const ux = nz, uz = -nx; // along the sign, left → right when you face it
  const s = flip ? -1 : 1, hw = w / 2, hh = h / 2;
  const A = [x - ux * hw * s, y - hh, z - uz * hw * s], B = [x + ux * hw * s, y - hh, z + uz * hw * s], C = [x + ux * hw * s, y + hh, z + uz * hw * s], D = [x - ux * hw * s, y + hh, z - uz * hw * s];
  const base = buf.vc;
  buf.p.push(...A, ...B, ...C, ...D);
  for (let k = 0; k < 4; k++) { buf.n.push(nx, 0, nz); buf.c.push(1, 1, 1); }
  buf.uv.push(uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]);
  // wind so the face points along +n
  const nxw = (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]), nzw = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
  if (nxw * nx + nzw * nz >= 0) buf.i.push(base, base + 1, base + 2, base, base + 2, base + 3); else buf.i.push(base, base + 2, base + 1, base, base + 3, base + 2);
}
const POI_PRI = [3, 4, 1, 2, 3, 3, 4, 4, 9, 2, 3, 5, 5]; // which places get a sign first (lower = sooner)
function buildSigns(t, d, frameBuf) {
  const mine = (x, z) => tileOf(x, z).join(',') === t.key;
  const items = [];
  for (const p of t.pois || []) if (p.name && p.c !== 8 && mine(p.x, p.z)) items.push({ name: p.name, c: p.c, x: p.x, z: p.z, pri: POI_PRI[p.c] ?? 6 });
  // named buildings (towers, arenas, halls) get their name up high
  const names = d.names || [];
  for (const rec of d.bld) {
    const nm = rec[10] >= 0 ? names[rec[10]] : ''; if (!nm || rec[0] < 3.5) continue;
    const pts = rec[2], b = bboxOf(pts), cx = (b[0] + b[2]) / 2, cz = (b[1] + b[3]) / 2, a = Math.abs(polyArea(pts));
    if (!mine(cx, cz) || a < 150) continue;
    const high = rec[0] >= 9 && a >= 1200; // towers and halls: name up high; stores, churches, schools: over the door
    items.push({ name: nm, c: 12, x: cx, z: cz, pri: high ? 7 : 5, building: rec, high });
  }
  items.sort((a, b) => a.pri - b.pri);
  if (!items.length) return null;
  const [can, ctx] = atlasCanvas(ATLAS_W, ATLAS_H);
  const buf = new GeoBuf(); let slot = 0; const drawn = [];
  const draw = (name, st) => { const s = slot++; drawn.push([s, name, st]); return drawSign(ctx, s, name, st); };
  const used = new Map(); // building → [{edge, a, b, y}]
  const frame = rgbOf('#1c1f23');
  for (const it of items) {
    if (slot >= SIGN_MAX) break;
    // which building is it in (or right next to)?
    let bld = null, bd = 25;
    if (it.building) { bld = { pts: it.building[2], h: it.building[0] }; bd = 0; }
    else {
      const gx = Math.floor(it.x / CELL), gz = Math.floor(it.z / CELL);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const b of t.bldGrid.get(ck(gx + i, gz + j)) || []) {
        if (pointInPoly(it.x, it.z, b.pts)) { bld = b; bd = 0; break; }
        const p = b.pts, n = p.length / 2;
        for (let k = 0; k < n; k++) { const l = (k + 1) % n, ex = p[l * 2] - p[k * 2], ez = p[l * 2 + 1] - p[k * 2 + 1], L2 = ex * ex + ez * ez || 1; let u = ((it.x - p[k * 2]) * ex + (it.z - p[k * 2 + 1]) * ez) / L2; u = Math.max(0, Math.min(1, u)); const dd = Math.hypot(p[k * 2] + ex * u - it.x, p[k * 2 + 1] + ez * u - it.z); if (dd < bd) { bd = dd; bld = b; } }
      }
    }
    const nr = nearestRoadIn(t, it.x, it.z, 150); if (!nr) continue;
    const st = signStyle(it.name, it.c), key = it.name.toLowerCase();
    const textW = st.big ? Math.min(26, 4 + it.name.length * 1.25) : Math.min(16, 2.8 + it.name.length * 0.62) * (st.kind === 'letters' ? 1.1 : 1);
    if (bld && bld.h >= 3.5 && it.c !== 2) {
      let pts = bld.pts; if (polyArea(pts) < 0) pts = revRing(pts);
      const n = pts.length / 2;
      let best = -1, bs = -1e9;
      for (let k = 0; k < n; k++) {
        const l = (k + 1) % n, ax = pts[k * 2], az = pts[k * 2 + 1], bx = pts[l * 2], bz = pts[l * 2 + 1], L = Math.hypot(bx - ax, bz - az); if (L < 3) continue;
        const nx = (bz - az) / L, nz = -(bx - ax) / L, mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const tx = nr.px - mx, tz = nr.pz - mz, tl = Math.hypot(tx, tz) || 1;
        const sc = (nx * tx + nz * tz) / tl * 2 + Math.min(1, L / (textW + 1)) - Math.hypot(mx - it.x, mz - it.z) / 80;
        if (sc > bs) { bs = sc; best = k; }
      }
      if (best < 0) continue;
      const l = (best + 1) % n, ax = pts[best * 2], az = pts[best * 2 + 1], bx = pts[l * 2], bz = pts[l * 2 + 1], L = Math.hypot(bx - ax, bz - az);
      const ex = (bx - ax) / L, ez = (bz - az) / L, nx = ez, nz = -ex;
      const big = !!it.high || st.big, w = Math.min(it.high ? Math.min(30, 3 + it.name.length * 0.9) : textW, L * 0.85), h = w * SIGN_H / SIGN_W;
      let u = Math.max(w / 2 + 0.3, Math.min(L - w / 2 - 0.3, (it.x - ax) * ex + (it.z - az) * ez));
      let y = big ? Math.max(2.7 + h / 2, bld.h - 1.2 - h / 2) : bld.h > 10 ? 4.4 : Math.max(2.7 + h / 2, bld.h - 0.5 - h / 2);
      // don't stack two signs on top of each other, or put the same name twice on one building
      const list = used.get(bld) || []; used.set(bld, list);
      if (list.some(o => o.key === key)) continue;
      let tries = 0;
      while (list.some(o => o.k === best && Math.abs(o.u - u) < (o.w + w) / 2 + 0.4 && Math.abs(o.y - y) < (o.h + h) / 2 + 0.2) && tries++ < 6) {
        const free = u + w + 0.5 <= L - 0.3 ? u + w + 0.5 : null;
        if (free !== null) u = free; else { y += h * 1.5; u = Math.max(w / 2 + 0.3, Math.min(L - w / 2 - 0.3, u)); }
      }
      if (y + h / 2 > bld.h + 0.2 || tries > 6) continue;
      list.push({ k: best, u, y, w, h, key });
      const uv = draw(it.name, st);
      const cx = ax + ex * u + nx * 0.16, cz = az + ez * u + nz * 0.16;
      if (st.kind !== 'letters') quadN(frameBuf, [cx - ex * (w / 2 + 0.15) - nx * 0.06, y - h / 2 - 0.12, cz - ez * (w / 2 + 0.15) - nz * 0.06], [cx + ex * (w / 2 + 0.15) - nx * 0.06, y - h / 2 - 0.12, cz + ez * (w / 2 + 0.15) - nz * 0.06], [cx + ex * (w / 2 + 0.15) - nx * 0.06, y + h / 2 + 0.12, cz + ez * (w / 2 + 0.15) - nz * 0.06], [cx - ex * (w / 2 + 0.15) - nx * 0.06, y + h / 2 + 0.12, cz - ez * (w / 2 + 0.15) - nz * 0.06], [nx, 0, nz], frame);
      signQuad(buf, cx, y, cz, nx, nz, w, h, uv);
    } else {
      // free-standing pylon by the road (gas stations, places without a building)
      if (nr.road.c > 12 && it.c !== 2) continue;
      let dx = it.x - nr.px, dz = it.z - nr.pz; const dl = Math.hypot(dx, dz);
      if (dl < 0.5) continue; dx /= dl; dz /= dl;
      const off = Math.min(dl, nr.road.w / 2 + 2.5), px = nr.px + dx * off, pz = nr.pz + dz * off;
      const w = Math.min(textW, 4.5), h = w * SIGN_H / SIGN_W, y = 5.2;
      boxY(frameBuf, px, pz, dx, dz, 0.12, 0.12, 0, y - h / 2, POLE);
      boxY(frameBuf, px, pz, -dz, dx, w / 2 + 0.12, 0.1, y - h / 2 - 0.12, y + h / 2 + 0.12, frame);
      const uv = draw(it.name, st.kind === 'letters' ? { kind: 'box', bg: '#ffffff', fg: st.fg, font: st.font } : st);
      // panel stands across the road direction so both lanes can read it
      const fx = nr.dx, fz = nr.dz;
      signQuad(buf, px + fx * 0.11, y, pz + fz * 0.11, fx, fz, w, h, uv);
      signQuad(buf, px - fx * 0.11, y, pz - fz * 0.11, -fx, -fz, w, h, uv);
    }
  }
  if (!slot) return null;
  const tex = atlasTexture(can);
  const m = buf.mesh(new THREE.MeshBasicMaterial({ map: tex, fog: true, alphaTest: 0.4 }), false);
  m.userData.tex = tex;
  if (!signFontsReady) signAtlases.add({ mesh: m, redraw: () => { for (const [s, name, st] of drawn) drawSign(ctx, s, name, st); tex.needsUpdate = true; } });
  return m;
}
// street-name blades at intersections: green with white letters, one pole per corner, a blade for each street
const BLADE_W = 256, BLADE_H = 40, BLADE_COLS = 4, BLADE_ATLAS_W = 1024, BLADE_ATLAS_H = 1600, BLADE_MAX = 160;
const SUFFIX = [[/\bStreet\b/g, 'St'], [/\bAvenue\b/g, 'Ave'], [/\bBoulevard\b/g, 'Blvd'], [/\bRoad\b/g, 'Rd'], [/\bDrive\b/g, 'Dr'],
  [/\bLane\b/g, 'Ln'], [/\bParkway\b/g, 'Pkwy'], [/\bPlace\b/g, 'Pl'], [/\bCourt\b/g, 'Ct'], [/\bCircle\b/g, 'Cir'], [/\bTrail\b/g, 'Trl'],
  [/\bTerrace\b/g, 'Ter'], [/\bHighway\b/g, 'Hwy'], [/\bCounty Road\b/g, 'Co Rd'], [/^North\b/, 'N'], [/^South\b/, 'S'], [/^East\b/, 'E'],
  [/^West\b/, 'W'], [/\bNorth$/, 'N'], [/\bSouth$/, 'S'], [/\bEast$/, 'E'], [/\bWest$/, 'W'], [/\bNortheast$/, 'NE'], [/\bSoutheast$/, 'SE'],
  [/\bNorthwest$/, 'NW'], [/\bSouthwest$/, 'SW'], [/\bSaint\b/g, 'St']];
const shortName = n => { for (const [re, r] of SUFFIX) n = n.replace(re, r); return n; };
function drawBlade(ctx, slot, text) {
  const x0 = (slot % BLADE_COLS) * BLADE_W, y0 = Math.floor(slot / BLADE_COLS) * BLADE_H, W = BLADE_W, H = BLADE_H;
  ctx.fillStyle = '#0d6b3d'; ctx.fillRect(x0, y0, W, H);
  ctx.strokeStyle = '#f2f2ee'; ctx.lineWidth = 2; ctx.strokeRect(x0 + 3, y0 + 3, W - 6, H - 6);
  ctx.fillStyle = '#f7f7f2'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let fs = 28; ctx.font = SF.cond(fs);
  while (fs > 12 && ctx.measureText(text).width > W - 16) { fs--; ctx.font = SF.cond(fs); }
  ctx.fillText(text, x0 + W / 2, y0 + H / 2 + 1);
  return [x0 / BLADE_ATLAS_W, 1 - (y0 + H) / BLADE_ATLAS_H, (x0 + W) / BLADE_ATLAS_W, 1 - y0 / BLADE_ATLAS_H];
}
function buildStreetSigns(t, frameBuf) {
  const mine = (x, z) => tileOf(x, z).join(',') === t.key;
  // junctions: nodes shared by differently named city streets
  const nodes = new Map();
  for (const r of t.roads || []) {
    if (r.c < 2 || r.c > 7 || !r.name || r.tunnel) continue;
    const p = r.pts, n = p.length / 2;
    for (let i = 0; i < n; i++) {
      if (r.hs && Math.abs(r.hs[i]) > 0.3) continue;
      const k = Math.round(p[i * 2] * 2) + ',' + Math.round(p[i * 2 + 1] * 2);
      let e = nodes.get(k); if (!e) nodes.set(k, e = { x: p[i * 2], z: p[i * 2 + 1], arms: [] });
      for (const j of [i - 1, i + 1]) if (j >= 0 && j < n) {
        const dx = p[j * 2] - p[i * 2], dz = p[j * 2 + 1] - p[i * 2 + 1], L = Math.hypot(dx, dz); if (L < 0.5) continue;
        e.arms.push({ name: r.name, dx: dx / L, dz: dz / L, w: r.w || 8 });
      }
    }
  }
  const [can, ctx] = atlasCanvas(BLADE_ATLAS_W, BLADE_ATLAS_H);
  const buf = new GeoBuf(), slots = new Map(), drawn = [];
  const slotFor = name => { let uv = slots.get(name); if (!uv && slots.size < BLADE_MAX) { const s = slots.size; drawn.push([s, name]); uv = drawBlade(ctx, s, name); slots.set(name, uv); } return uv; };
  const done = [];
  for (const e of nodes.values()) {
    if (!mine(e.x, e.z)) continue;
    const names = [...new Set(e.arms.map(a => a.name))]; if (names.length < 2) continue;
    if (done.some(o => Math.hypot(o[0] - e.x, o[1] - e.z) < 30)) continue; // one sign per intersection
    const A = e.arms.find(a => a.name === names[0]), B = e.arms.find(a => a.name === names[1]);
    // pole on the corner between the two streets, clear of both
    let mx = A.dx + B.dx, mz = A.dz + B.dz, ml = Math.hypot(mx, mz);
    if (ml < 0.2) { mx = -A.dz; mz = A.dx; ml = 1; }
    mx /= ml; mz /= ml;
    const sinH = Math.max(0.35, Math.abs(A.dx * mz - A.dz * mx)), d = Math.min(22, (Math.max(A.w, B.w) / 2 + 1.6) / sinH);
    const px = e.x + mx * d, pz = e.z + mz * d;
    done.push([e.x, e.z]);
    boxY(frameBuf, px, pz, 1, 0, 0.05, 0.05, 0, 4.1, POLE);
    [[A, 3.3], [B, 3.8]].forEach(([arm, y], i) => {
      const uv = slotFor(shortName(names[i])); if (!uv) return;
      const nx = -arm.dz, nz = arm.dx; // blade runs along its street, readable from both sides
      signQuad(buf, px + nx * 0.02, y, pz + nz * 0.02, nx, nz, 2.6, 0.42, uv);
      signQuad(buf, px - nx * 0.02, y, pz - nz * 0.02, -nx, -nz, 2.6, 0.42, uv);
    });
  }
  for (const b of t.sigBlades || []) { const uv = slotFor(shortName(b.name)); if (uv) signQuad(buf, b.x, b.y, b.z, b.nx, b.nz, b.w, b.h, uv); }
  if (!slots.size) return null;
  const tex = atlasTexture(can);
  const m = buf.mesh(new THREE.MeshBasicMaterial({ map: tex, fog: true }), false);
  m.userData.tex = tex;
  if (!signFontsReady) signAtlases.add({ mesh: m, redraw: () => { for (const [s, name] of drawn) drawBlade(ctx, s, name); tex.needsUpdate = true; } });
  return m;
}
// billboards carry made-up ads (OSM knows where they stand, not what they show)
const ADS = [
  ['LAKE EFFECT COFFEE', 'Brewed for 10,000 lakes', '#0e3b5c', '#ffd166'],
  ['HOTDISH HEAVEN', 'Diner · open late', '#7a1f1f', '#ffe8c2'],
  ['NORTHSTAR AUTO GLASS', 'Chip today, gone tomorrow', '#123c2e', '#9be7c4'],
  ['LOON LAKE RESORTS', 'Your cabin is waiting', '#1d3557', '#a8dadc'],
  ['SPEED KILLS', 'Slow down · Drive sober MN', '#111111', '#ffcc00'],
  ['TWIN PINES MATTRESS', 'Sleep like it’s January', '#3d2c8d', '#f1e9ff'],
  ['PRAIRIE BANK', 'Banking with a handshake', '#004d40', '#ffffff'],
  ['GOPHER STATE PIZZA', '2 large for $19.99', '#c1121f', '#fff3b0'],
  ['WALLEYE WEEKEND', 'Fishing opener sale', '#264653', '#e9c46a'],
  ['SNOWBELT TIRE & AUTO', 'Winter tires · installed today', '#2a2a2a', '#7fd3ff'],
  ['MILL CITY ROOFING', 'Hail damage? Free quote', '#5a189a', '#ffd60a'],
  ['ST. CROIX DENTAL', 'Smiles across the river', '#0077b6', '#ffffff'],
];
let adTex = null;
const AD_W = 512, AD_H = 150;
function adAtlas() {
  if (adTex) return adTex;
  const can = document.createElement('canvas'); can.width = 1024; can.height = 1024; const ctx = can.getContext('2d');
  ADS.forEach(([title, line, bg, fg], i) => {
    const x0 = (i % 2) * AD_W, y0 = Math.floor(i / 2) * AD_H;
    const g = ctx.createLinearGradient(x0, y0, x0 + AD_W, y0 + AD_H); g.addColorStop(0, bg); g.addColorStop(1, '#000');
    ctx.fillStyle = g; ctx.fillRect(x0, y0, AD_W, AD_H);
    ctx.fillStyle = fg; ctx.fillRect(x0, y0 + AD_H - 10, AD_W, 10);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    let fs = 54; ctx.font = `900 ${fs}px system-ui, -apple-system, Segoe UI, sans-serif`;
    while (ctx.measureText(title).width > AD_W - 40) { fs -= 2; ctx.font = `900 ${fs}px system-ui, -apple-system, Segoe UI, sans-serif`; }
    ctx.fillStyle = '#fff'; ctx.fillText(title, x0 + 20, y0 + 72);
    ctx.font = `700 28px system-ui, -apple-system, Segoe UI, sans-serif`; ctx.fillStyle = fg; ctx.fillText(line, x0 + 22, y0 + 118);
  });
  adTex = new THREE.CanvasTexture(can); adTex.colorSpace = THREE.SRGBColorSpace; adTex.anisotropy = 4;
  return adTex;
}
const adMat = new THREE.MeshBasicMaterial({ map: null, fog: true });
function buildBillboards(t, d, frameBuf) {
  const list = (d.billboards || []).filter(([x, z]) => tileOf(x, z).join(',') === t.key);
  if (!list.length) return null;
  adMat.map = adAtlas(); adMat.needsUpdate = true;
  const buf = new GeoBuf(), grey = rgbOf('#9aa0a6'), dark = rgbOf('#3a3f44');
  for (const [x, z, ang] of list) {
    const nr = nearestRoadIn(t, x, z, 200);
    // the panel faces traffic: across the nearest road, or along a mapped panel line
    let fx, fz;
    if (ang !== 9) { fx = -Math.sin(ang); fz = Math.cos(ang); }
    else if (nr) { fx = nr.dx; fz = nr.dz; } else { fx = 0; fz = 1; }
    const W = 14.6, H = 4.3, y0 = 7.5, cy = y0 + H / 2, ux = -fz, uz = fx;
    const seed = Math.abs(Math.round(x * 7 + z * 13));
    const pick = i => { const k = (seed + i * 5) % ADS.length, c = k % 2, r = Math.floor(k / 2); return [c * AD_W / 1024, 1 - (r + 1) * AD_H / 1024, (c + 1) * AD_W / 1024, 1 - r * AD_H / 1024]; };
    boxY(frameBuf, x, z, fx, fz, 0.35, 0.35, 0, y0, grey); // monopole
    boxY(frameBuf, x, z, ux, uz, W / 2 + 0.25, 0.25, y0 - 0.2, y0 + H + 0.2, dark); // back structure
    boxY(frameBuf, x + fx * 0.9, z + fz * 0.9, ux, uz, W / 2, 0.45, y0 - 0.45, y0 - 0.3, grey); // catwalk
    signQuad(buf, x + fx * 0.27, cy, z + fz * 0.27, fx, fz, W, H, pick(0));
    signQuad(buf, x - fx * 0.27, cy, z - fz * 0.27, -fx, -fz, W, H, pick(1));
  }
  return buf.mesh(adMat, false);
}

function buildBuildings(t, d) {
  if (t.bldMeshes) { for (const m of t.bldMeshes) { t.group.remove(m); m.geometry.dispose(); if (m.userData.tex) { m.userData.tex.dispose(); m.material.dispose(); } } t.blds.length = 0; t.bldGrid.clear(); }
  t.bldMeshes = []; t.cluttered = false; t.apts = []; t.houses = [];
  const houseBuf = new GeoBuf(), faceBuf = new GeoBuf(), aoBuf = new GeoBuf(); faceBuf.facade = true;
  let seed = t.tx * 31 + t.ty * 17;
  const names = d.names || [];
  // 3D building parts (towers, setbacks, spires): when a building has them, they replace its plain outline
  const parts = (d.parts || []).map(p => {
    const pts = p[2]; let cx = 0, cz = 0; for (let i = 0; i < pts.length; i += 2) { cx += pts[i]; cz += pts[i + 1]; }
    return { h: p[0], minH: p[1], pts, wc: p[3], rc: p[4], shape: p[5], rh: p[6], dir: p[7], cx: cx * 2 / pts.length, cz: cz * 2 / pts.length, owner: null };
  });
  for (const rec of d.bld) {
    const [h, kind, pts] = rec;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const box = bboxOf(pts), [minx, minz, maxx, maxz] = box;
    const area = Math.abs(polyArea(pts));
    let top = h, partTop = 0;
    for (const p of parts) if (!p.owner && inBox(p.cx, p.cz, box) && pointInPoly(p.cx, p.cz, pts)) { p.owner = { seed: seed >> 8, wc: rec[3], rc: rec[4] }; partTop = Math.max(partTop, p.h); }
    let minH = +rec[6] || 0;
    if (!partTop) {
      if (!minH && spansRoad(t, pts, box)) { minH = 5.3; t.raisedB = (t.raisedB || 0) + 1; } // skyway / building over a street
      top = minH ? Math.max(h, minH + 3.6) : h;
      const name = rec[10] >= 0 ? names[rec[10]] || '' : '';
      let lm = null;
      if (name) for (const l of LANDMARKS) if (l.re.test(name)) { lm = l; break; }
      if (!lm && area > 3000) for (const l of LANDMARKS) if (l.at && inBox(l.x, l.z, box) && pointInPoly(l.x, l.z, pts)) { lm = l; break; }
      if (lm && lm.h && rec[11] === 0 && !minH) top = lm.h;
      const tag = rec[7] || '';
      if ((tag === 'apartments' || (tag === 'residential' && top >= 9)) && area > 350 && !minH) { // a rentable apartment building
        let cx = 0, cz = 0; for (let i = 0; i < pts.length; i += 2) { cx += pts[i]; cz += pts[i + 1]; }
        t.apts.push({ name, x: cx * 2 / pts.length, z: cz * 2 / pts.length, h: top, area });
      }
      if (kind === 0 && !minH && top < 10 && area > 75 && area < 350 && !name) { // a single-family house
        let cx = 0, cz = 0; for (let i = 0; i < pts.length; i += 2) { cx += pts[i]; cz += pts[i + 1]; }
        t.houses.push({ x: cx * 2 / pts.length, z: cz * 2 / pts.length, area });
      }
      const plain = lm ? lm.plain || lm.shape === 'bowl' : PLAIN_TAGS.has(tag) || (area > 8000 && top < 40) || (kind === 2 && area > 3000) || (tag === 'retail' && area > 2500 && top < 16);
      const isHouse = kind === 0 && !minH && top < 10;
      const o = { shape: rec[5] || '', roofH: +rec[8] || 0, holes: rec[9] || null };
      if (!lm && tag === 'stadium' && area > 12000 && !o.holes && top < 45) o.shape = 'bowl';
      if (lm) { o.shape = lm.shape || o.shape; if (lm.roofH) o.roofH = lm.roofH < 1 ? lm.roofH * top : lm.roofH; o.dir = lm.dir; o.roofTint = lm.tint; }
      const dms = o.holes ? [] : DOMES.filter(dm => inBox(dm.x, dm.z, box) && pointInPoly(dm.x, dm.z, pts) && !parts.some(p => p.h > dm.base + 5 && Math.hypot(p.cx - dm.x, p.cz - dm.z) < dm.r * 2));
      for (const dm of dms) top = dm.body; // the outline's own height is either a low wing or the whole dome
      const campus = !lm && (tag === 'university' || tag === 'college') && !rec[3];
      const wall = (lm && lm.wall) || (dms[0] && dms[0].drum) || rec[3] || (campus ? CAMPUS_PAL[(seed >> 8) % CAMPUS_PAL.length] : '');
      const keepPlain = (lm && (lm.plain || lm.shape === 'bowl')) || dms.length || NOFACADE_TAGS.has(tag) || o.shape === 'bowl';
      o.fac = facadeFor(tag, kind, top, area);
      building(keepPlain ? houseBuf : faceBuf, pts, top, kind, seed >> 8, minH, wall, (lm && lm.roof) || rec[4] || '', o);
      if (!minH && !dms.length) aoStrip(aoBuf, pts);
      const flatRoof = (!o.shape || o.shape === 'flat') && !lm;
      if (!isHouse && flatRoof && !keepPlain && !minH && area > 220 && top >= 4 && top < 160) roofDetails(houseBuf, pts, top, area, seed);
      if (isHouse && area > 70 && (seed & 3) && (!o.shape || o.shape === 'hipped' || o.shape === 'gabled')) chimney(houseBuf, pts, top, seed);
      void plain;
      for (const dm of dms) {
        const lantern = 8, domeH = dm.r * 1.3;
        building(houseBuf, circlePts(dm.x, dm.z, dm.r * 1.08), dm.top - lantern - domeH, 1, 0, Math.min(top, dm.base) - 0.5, dm.drum, dm.drum, {}); // drum rises from the roof
        building(houseBuf, circlePts(dm.x, dm.z, dm.r), dm.top - lantern, 1, 0, dm.top - lantern - domeH - 0.5, dm.drum, dm.dome, { shape: 'dome', roofH: domeH });
        building(houseBuf, circlePts(dm.x, dm.z, dm.r * 0.18, 10), dm.top, 1, 0, dm.top - lantern - 1, dm.drum, dm.dome, { shape: 'pyramidal', roofH: 3 });
      }
    } else top = Math.max(h, partTop);
    if (minH > 0) continue; // you can drive under it
    const bi = { pts, h: top, box, kind };
    t.blds.push(bi);
    for (let cx = Math.floor(minx / CELL); cx <= Math.floor(maxx / CELL); cx++) for (let cz = Math.floor(minz / CELL); cz <= Math.floor(maxz / CELL); cz++) {
      const k = ck(cx, cz); let a = t.bldGrid.get(k); if (!a) t.bldGrid.set(k, a = []); a.push(bi);
    }
  }
  for (const p of parts) {
    const ow = p.owner || { seed: (Math.round(p.cx) * 7 + Math.round(p.cz) * 13) & 0xffff, wc: '', rc: '' };
    const area = Math.abs(polyArea(p.pts));
    const plain = area > 8000 && p.h < 40;
    building(plain ? houseBuf : faceBuf, p.pts, p.h, 1, ow.seed, p.minH, p.wc || ow.wc || '', p.rc || ow.rc || '', { part: true, shape: p.shape, roofH: p.rh, dir: p.dir, fac: p.h > 45 ? { up: 0, fH: 3.8 } : { up: 1, gr: 4, gH: 4.8, fH: 3.6 } });
  }
  // ballparks and stadiums that OSM maps only as an outline (no building)
  for (const bp of BALLPARKS) if (tileOf(bp.home[0], bp.home[1]).join(',') === t.key) ballpark(t, houseBuf, bp);
  const covered = (x, z) => t.blds.some(b => b.h > 6 && inBox(x, z, b.box) && pointInPoly(x, z, b.pts) && (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) > 6000);
  for (const [ni, , vp] of d.venues || []) {
    const name = names[ni] || '', vb = bboxOf(vp), cx = (vb[0] + vb[2]) / 2, cz = (vb[1] + vb[3]) / 2, area = Math.abs(polyArea(vp));
    if (!name || area < 15000 || tileOf(cx, cz).join(',') !== t.key) continue;
    if (BALLPARKS.some(bp => Math.hypot(bp.home[0] - cx, bp.home[1] - cz) < 300) || covered(cx, cz)) continue;
    let lm = null; for (const l of LANDMARKS) if (l.re.test(name)) { lm = l; break; }
    const h = Math.max(10, Math.min(30, Math.sqrt(area) / 7));
    building(houseBuf, vp.slice(), h, 4, 0, 0, (lm && lm.wall) || '#a69c8e', '', { shape: 'bowl' });
    addCollider(t, vp, h);
  }
  traffic.setSignals(t, d.signals);
  const lit = [0, 1].map(() => [new GeoBuf(), new GeoBuf(), new GeoBuf()]);
  streetFurniture(t, d, houseBuf, lit);
  for (const m of [buildSigns(t, d, houseBuf), buildBillboards(t, d, houseBuf), buildStreetSigns(t, houseBuf)]) if (m) { t.group.add(m); t.bldMeshes.push(m); }
  for (let p = 0; p < 2; p++) for (let k = 0; k < 3; k++) { const m = lit[p][k].mesh(litMats[p][k]); if (m) { t.group.add(m); t.bldMeshes.push(m); } }
  const m1 = houseBuf.mesh(bldMat, true); if (m1) { t.group.add(m1); t.bldMeshes.push(m1); }
  const m2 = faceBuf.mesh(facadeMat, true); if (m2) { t.group.add(m2); t.bldMeshes.push(m2); }
  const m3 = LOW ? null : aoBuf.mesh(aoMat); if (m3) { m3.renderOrder = 2; t.group.add(m3); t.bldMeshes.push(m3); }
  t.group.updateMatrixWorld(true);
  maybeClutter(t);
}

// ───────────────────────── land use (ground surfaces) ─────────────────────────
// parking, commercial, industrial, residential, park, wood, pitch, golf, field, campus, dirt
const LU_COL = ['#5b5e63', '#a9a69f', '#8f8d88', '#7b9a59', '#6aa046', '#4c7a37', '#5c9c48', '#86b85f', '#b6b078', '#8fae73', '#a38a68'];
const LU_PRIO = [10, 4, 5, 0, 6, 7, 9, 8, 1, 2, 3];
const LU_MAP = ['#c7c3bb', '#ddd8cf', '#d3cfc8', '#e4e2d6', '#c8e2b4', '#b4d4a0', '#bfe0ae', '#cfe8bd', '#e8e3c4', '#dde8d2', '#e0d6c4'];
const noiseTex = canvasTex(128, 128, (c, w, h) => { noise(c, w, h, '#ffffff', 0.18, 5000); });
const luMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: noiseTex, polygonOffset: true, polygonOffsetFactor: -0.3, polygonOffsetUnits: -0.6 });
for (const m of [waterMat, walkMat, junctionMat, markMat, luMat, ground.material]) m.userData.noCast = true; // ground-level: receive only
for (const m of [ground.material, walkMat, luMat]) cutByTrenches(m); // open trenches show through
function buildLanduse(t, d) {
  t.areas = [];
  const buf = new GeoBuf();
  const list = d.areas.slice().sort((a, b) => LU_PRIO[a[0]] - LU_PRIO[b[0]]);
  for (const [c, pts] of list) {
    if (pts.length < 6) continue;
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (let i = 0; i < pts.length; i += 2) { minx = Math.min(minx, pts[i]); maxx = Math.max(maxx, pts[i]); minz = Math.min(minz, pts[i + 1]); maxz = Math.max(maxz, pts[i + 1]); }
    t.areas.push({ c, pts, box: [minx, minz, maxx, maxz] });
    const contour = [];
    for (let i = 0; i < pts.length; i += 2) contour.push(new THREE.Vector2(pts[i], pts[i + 1]));
    let tris; try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { continue; }
    tmpC.set(LU_COL[c]);
    const sd = subdivTris(contour, tris, 30), y = 0.008 + LU_PRIO[c] * 0.0018, base = buf.vc;
    for (const v of sd.pts) { buf.p.push(v.x, y, v.y); buf.n.push(0, 1, 0); buf.c.push(tmpC.r, tmpC.g, tmpC.b); buf.uv.push(v.x / 24, v.y / 24); }
    pushTris(buf, base, sd.pts, sd.tris);
  }
  const m = buf.mesh(luMat, true); if (m) t.group.add(m);
  t.group.updateMatrixWorld(true);
}
function areaAt(t, x, z) { // highest-priority land use under a point
  let best = -1, bp = -1;
  if (t.areas) for (const a of t.areas) {
    if (x < a.box[0] || x > a.box[2] || z < a.box[1] || z > a.box[3]) continue;
    if (LU_PRIO[a.c] > bp && pointInPoly(x, z, a.pts)) { bp = LU_PRIO[a.c]; best = a.c; }
  }
  return best;
}

// ───────────────────────── traffic signs: freeway exits, route markers, speed limits, one-way / do-not-enter ─────────────────────────
const TS_W = 256, TS_H = 128, TS_COLS = 4, TS_ROWS = 16, TS_AW = TS_W * TS_COLS, TS_AH = TS_H * TS_ROWS;
const MUTCD_GREEN = '#0b6a3b', MUTCD_RED = '#c1121f';
const cardinal = (dx, dz) => Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'E' : 'W') : (dz > 0 ? 'S' : 'N'); // world +z is south
const fmtRef = r => (r || '').split(';')[0].trim().replace(/^I\s*-?\s*/i, 'I-').replace(/^US\s+/i, 'US ').replace(/^MN\s+/i, 'MN ').replace(/^(CR|CSAH)\s+/i, 'CR ');
function drawShield(c, ref, cx, cy, s) { // simplified route markers (government signs: no branding)
  const m = /^(I-|US |MN |CR )?(.*)$/.exec(ref) || [], kind = m[1] || '', num = (m[2] || ref).slice(0, 4);
  c.save(); c.translate(cx, cy);
  if (kind === 'I-') { // interstate: blue shield with a red crown
    c.fillStyle = '#ffffff'; c.beginPath(); c.moveTo(-s, -s); c.lineTo(s, -s); c.quadraticCurveTo(s, s * 0.7, 0, s * 1.05); c.quadraticCurveTo(-s, s * 0.7, -s, -s); c.fill();
    c.fillStyle = '#1d3f8c'; c.beginPath(); c.moveTo(-s * 0.88, -s * 0.55); c.lineTo(s * 0.88, -s * 0.55); c.quadraticCurveTo(s * 0.88, s * 0.62, 0, s * 0.92); c.quadraticCurveTo(-s * 0.88, s * 0.62, -s * 0.88, -s * 0.55); c.fill();
    c.fillStyle = MUTCD_RED; c.fillRect(-s * 0.88, -s * 0.9, s * 1.76, s * 0.3);
  } else if (kind === 'US ') { c.fillStyle = '#111'; c.fillRect(-s, -s, s * 2, s * 2); c.fillStyle = '#fff'; c.beginPath(); c.moveTo(-s * 0.8, -s * 0.85); c.lineTo(s * 0.8, -s * 0.85); c.quadraticCurveTo(s * 0.85, s * 0.6, 0, s * 0.9); c.quadraticCurveTo(-s * 0.85, s * 0.6, -s * 0.8, -s * 0.85); c.fill(); }
  else if (kind === 'CR ') { c.fillStyle = '#1d3f8c'; c.beginPath(); c.moveTo(-s * 0.85, -s * 0.9); c.lineTo(s * 0.85, -s * 0.9); c.lineTo(s * 0.85, s * 0.2); c.lineTo(0, s); c.lineTo(-s * 0.85, s * 0.2); c.closePath(); c.fill(); }
  else { c.fillStyle = '#fff'; c.fillRect(-s, -s * 0.85, s * 2, s * 1.7); c.fillStyle = '#1d3f8c'; c.fillRect(-s * 0.86, -s * 0.71, s * 1.72, s * 1.42); }
  c.fillStyle = kind === 'US ' ? '#111' : kind === 'CR ' ? '#f2c230' : '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
  let fs = Math.round(s * (num.length > 2 ? 0.85 : 1.05)); c.font = SF.cond(fs);
  while (c.measureText(num).width > s * 1.6 && fs > 8) { fs--; c.font = SF.cond(fs); }
  c.fillText(num, 0, kind === 'I-' ? s * 0.18 : kind === 'CR ' ? -s * 0.05 : s * 0.02);
  c.restore();
}
// draw one sign face into a 256×128 slot; returns the UV rect of the face actually used
function drawTSign(c, slot, sg) {
  const X = (slot % TS_COLS) * TS_W, Y = Math.floor(slot / TS_COLS) * TS_H;
  c.save(); c.clearRect(X, Y, TS_W, TS_H); c.translate(X, Y);
  let w = TS_W, h = TS_H;
  const text = (str, x, y, size, col, font = SF.cond, maxW = 236, align = 'center') => { c.fillStyle = col; c.textAlign = align; c.textBaseline = 'middle'; let fs = size; c.font = font(fs); while (c.measureText(str).width > maxW && fs > 10) { fs--; c.font = font(fs); } c.fillText(str, x, y); };
  const border = (col, r = 10, inset = 4) => { c.strokeStyle = col; c.lineWidth = 4; c.beginPath(); c.roundRect(inset, inset, w - inset * 2, h - inset * 2, r); c.stroke(); };
  if (sg.k === 'guide') { // green freeway guide sign: route / destination, distance line, EXIT tab
    c.fillStyle = MUTCD_GREEN; c.beginPath(); c.roundRect(0, 14, w, h - 14, 12); c.fill();
    c.strokeStyle = '#fff'; c.lineWidth = 3; c.beginPath(); c.roundRect(4, 18, w - 8, h - 22, 10); c.stroke();
    c.fillStyle = MUTCD_GREEN; c.beginPath(); c.roundRect(w - 92, 0, 88, 26, 6); c.fill(); text('EXIT', w - 48, 14, 18, '#fff', SF.cond, 80);
    let x0 = 128, maxW = 228;
    if (sg.shield) { drawShield(c, sg.shield, 38, 66, 24); x0 = 150; maxW = 180; }
    text(sg.line1, x0, sg.line2 ? 58 : 70, 34, '#fff', SF.cond, maxW);
    if (sg.line2) text(sg.line2, x0, 98, 22, '#fff', SF.cond, maxW);
  } else if (sg.k === 'gore') { w = 128; h = 64; c.fillStyle = MUTCD_GREEN; c.beginPath(); c.roundRect(0, 0, w, h, 8); c.fill(); border('#fff', 6, 3); text('EXIT', 64, 34, 34, '#fff', SF.cond, 110); }
  else if (sg.k === 'speed') { w = 96; h = 128; c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); border('#111', 6, 4); text('SPEED', 48, 22, 18, '#111', SF.cond, 80); text('LIMIT', 48, 42, 18, '#111', SF.cond, 80); text(String(sg.n), 48, 88, 52, '#111', SF.cond, 84); }
  else if (sg.k === 'oneway') { w = 192; h = 64; c.fillStyle = '#111'; c.fillRect(0, 0, w, h); c.fillStyle = '#fff'; c.fillRect(8, 14, w - 16, 36);
    c.fillStyle = '#111'; c.beginPath(); const L = sg.right; if (L) { c.moveTo(w - 14, 32); c.lineTo(w - 44, 18); c.lineTo(w - 44, 46); } else { c.moveTo(14, 32); c.lineTo(44, 18); c.lineTo(44, 46); } c.fill(); c.fillRect(L ? 22 : 40, 27, w - 62, 10);
    text('ONE WAY', L ? 82 : 110, 32, 22, '#fff', SF.cond, 120); }
  else if (sg.k === 'dne') { w = 128; h = 128; c.fillStyle = '#fff'; c.beginPath(); c.arc(64, 64, 62, 0, 7); c.fill(); c.fillStyle = MUTCD_RED; c.beginPath(); c.arc(64, 64, 58, 0, 7); c.fill(); c.fillStyle = '#fff'; c.fillRect(16, 56, 96, 16); text('DO NOT', 64, 34, 18, '#fff', SF.cond, 80); text('ENTER', 64, 94, 18, '#fff', SF.cond, 80); }
  else if (sg.k === 'wrongway') { w = 192; h = 96; c.fillStyle = MUTCD_RED; c.fillRect(0, 0, w, h); border('#fff', 4, 4); text('WRONG WAY', 96, 50, 34, '#fff', SF.cond, 170); }
  else if (sg.k === 'route') { w = 96; h = 128; c.fillStyle = '#fff'; c.fillRect(0, 0, w, 30); text(sg.dir, 48, 16, 20, '#111', SF.cond, 88); drawShield(c, sg.ref, 48, 82, 40); }
  c.restore();
  return { uv: [X / TS_AW, 1 - (Y + h) / TS_AH, (X + w) / TS_AW, 1 - Y / TS_AH], aspect: w / h };
}
const tsMats = new Set();
function trafficSigns(t, solid, deg, along, mine, inBuilding, onOtherRoad) {
  const [can, ctx] = atlasCanvas(TS_AW, TS_AH);
  const buf = new GeoBuf(), slots = new Map(), drawn = [];
  const face = sg => { const k = JSON.stringify(sg); let f = slots.get(k); if (!f && slots.size < TS_COLS * TS_ROWS) { const sl = slots.size; drawn.push([sl, sg]); f = drawTSign(ctx, sl, sg); slots.set(k, f); } return f; };
  const BACK = rgbOf('#9aa0a4'), POST = rgbOf('#8a9095');
  const count = [0, 0, 0]; let pass = 0; // 0 freeway / ramps, 1 speed limits, 2 one-way streets
  // a sign face (facing nx,nz) of width w, bottom at y0; one or two posts; grey back
  const sign = (x, z, nx, nz, sg, w, y0, posts = 1, base = 0) => {
    if (count[pass] >= [160, 110, 110][pass]) return;
    const f = face(sg); if (!f) return; count[pass]++;
    const h = w / f.aspect, cy = y0 + h / 2, ux = nz, uz = -nx;
    signQuad(buf, x + nx * 0.03, cy, z + nz * 0.03, nx, nz, w, h, f.uv);
    quadN(solid, [x - ux * w / 2, y0, z - uz * w / 2], [x + ux * w / 2, y0, z + uz * w / 2], [x + ux * w / 2, y0 + h, z + uz * w / 2], [x - ux * w / 2, y0 + h, z - uz * w / 2], [-nx, 0, -nz], BACK);
    const ps = posts === 2 ? [-w * 0.32, w * 0.32] : [0];
    for (const o of ps) boxY(solid, x + ux * o - nx * 0.08, z + uz * o - nz * 0.08, nx, nz, 0.06, 0.06, base, y0 + h * (posts === 2 ? 0.8 : 0.5), POST);
  };
  const H = (r, i) => (r.hs ? r.hs[i] || 0 : 0);
  // node → road entries
  const at = new Map();
  for (const r of t.roads) { if (r.c > 12 || r.tunnel) continue; const p = r.pts; for (let i = 0; i < p.length / 2; i++) { const k = Math.round(p[i * 2] * 2) + ',' + Math.round(p[i * 2 + 1] * 2); let a = at.get(k); if (!a) at.set(k, a = []); a.push({ r, i }); } }
  const keyAt = (r, i) => Math.round(r.pts[i * 2] * 2) + ',' + Math.round(r.pts[i * 2 + 1] * 2);
  const dirAt = (r, i) => { const p = r.pts, n = p.length / 2, a = Math.min(i, n - 2); const dx = p[a * 2 + 2] - p[a * 2], dz = p[a * 2 + 3] - p[a * 2 + 1], L = Math.hypot(dx, dz) || 1; return [dx / L, dz / L]; };
  // point `d` metres from node i along r (negative = upstream)
  const walk = (r, i, d) => {
    const p = r.pts, n = p.length / 2; let k = i, left = Math.abs(d); const s = d < 0 ? -1 : 1;
    while (left > 0) { const j = k + s; if (j < 0 || j >= n) return null; const L = Math.hypot(p[j * 2] - p[k * 2], p[j * 2 + 1] - p[k * 2 + 1]); if (L >= left) { const f = left / L; return { x: p[k * 2] + (p[j * 2] - p[k * 2]) * f, z: p[k * 2 + 1] + (p[j * 2 + 1] - p[k * 2 + 1]) * f, h: H(r, k) + (H(r, j) - H(r, k)) * f, seg: Math.min(k, j) }; } left -= L; k = j; }
    return null;
  };
  // where a ramp leads: follow ramps forward to the first street or freeway
  const destOf = link => {
    let cur = link, seen = new Set([link]);
    for (let hop = 0; hop < 8; hop++) {
      const p = cur.pts, n = p.length / 2, list = at.get(keyAt(cur, n - 1)) || [];
      const [dx, dz] = dirAt(cur, n - 2);
      let next = null;
      for (const e of list) {
        if (seen.has(e.r)) continue;
        if (e.r.c <= 1) { const ref = fmtRef(e.r.ref); return ref ? { shield: ref, line1: ref + ' ' + cardinal(...dirAt(e.r, e.i)) } : { line1: shortName(e.r.name || 'Freeway') }; }
        if (e.r.c >= 2 && e.r.c <= 7) { const ref = fmtRef(e.r.ref); return ref ? { shield: ref, line1: e.r.name ? shortName(e.r.name) : ref + ' ' + cardinal(dx, dz) } : { line1: shortName(e.r.name || 'Local Traffic') }; }
        if (!next && e.r.c >= 8 && e.r.c <= 12 && e.i === 0) next = e.r;
      }
      if (!next) break; seen.add(next); cur = next;
    }
    return { line1: 'Local Traffic' };
  };
  for (pass = 0; pass < 3; pass++) for (const r of t.roads) {
    if (r.tunnel || r.c > 12) continue;
    const n = r.pts.length / 2;
    // 1) freeway exits: a ramp leaving a freeway mid-way
    if (pass === 0 && (r.c === 8 || r.c === 9) && r.oneway) {
      const start = at.get(keyAt(r, 0)) || [];
      const fw = start.find(e => e.r !== r && e.r.c <= 1 && e.i > 0); // the freeway arriving at the split
      if (fw && mine(r.pts[0], r.pts[1])) {
        const m = fw.r, dest = destOf(r), [mdx, mdz] = dirAt(m, fw.i - 1), rx = -mdz, rz = mdx; // right of travel
        for (const [dist, line2] of [[-400, '1/4 MILE'], [-90, '']]) {
          const q = walk(m, fw.i, dist); if (!q || Math.abs(q.h) > 0.3 && q.h > 0) continue; // no signs on bridges
          const off = q.h < -0.3 ? m.w / 2 + 0.2 : m.w / 2 + 3.2, x = q.x + rx * off, z = q.z + rz * off; // in a trench: on the shoulder, inside the walls
          if (inBuilding(x, z, 1) || onOtherRoad(x, z, m)) continue;
          sign(x, z, -mdx, -mdz, { k: 'guide', shield: dest.shield || '', line1: dest.line1, line2 }, 6.4, q.h + 2.4, 2, q.h);
        }
        // little EXIT sign in the gore between the ramp and the freeway
        const g = walk(r, 0, 32); if (g && g.h < 0.3) { const [ldx, ldz] = dirAt(r, g.seg), lx = ldz, lz = -ldx; const x = g.x + lx * (r.w / 2 + 2), z = g.z + lz * (r.w / 2 + 2); if (!onOtherRoad(x, z, r)) sign(x, z, -ldx, -ldz, { k: 'gore' }, 1.8, g.h + 1.5, 1, g.h); }
      }
      // on-ramp merging into a freeway: a route marker a little downstream
      const end = at.get(keyAt(r, n - 1)) || [];
      const mf = end.find(e => e.r !== r && e.r.c <= 1 && e.i < e.r.pts.length / 2 - 1 && e.r.ref); // the freeway leaving the merge
      if (mf) { const m = mf.r, q = walk(m, mf.i, 260); if (q && q.h < 0.3) { const [dx, dz] = dirAt(m, q.seg), off = m.w / 2 + 2.6, x = q.x - dz * off, z = q.z + dx * off; if (mine(x, z) && !onOtherRoad(x, z, m) && !inBuilding(x, z, 1)) sign(x, z, -dx, -dz, { k: 'route', ref: fmtRef(m.ref), dir: { N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST' }[cardinal(dx, dz)] }, 1.5, q.h + 2.0, 1, q.h); } }
      // the street end of an off-ramp: DO NOT ENTER + WRONG WAY facing anyone turning in the wrong way
      const e2 = end.find(e => e.r !== r && e.r.c >= 2 && e.r.c <= 7);
      if (e2 && H(r, n - 1) < 0.3 && mine(r.pts[n * 2 - 2], r.pts[n * 2 - 1])) {
        const [dx, dz] = dirAt(r, n - 2), q = walk(r, n - 1, -14); if (q) { const off = r.w / 2 + 1.2, x = q.x + dz * off, z = q.z - dx * off; if (!onOtherRoad(x, z, r)) sign(x, z, dx, dz, { k: 'dne' }, 0.9, 1.6); }
        const q2 = walk(r, n - 1, -45); if (q2 && q2.h < 0.3) { const off = r.w / 2 + 1.2, x = q2.x + dz * off, z = q2.z - dx * off; if (!onOtherRoad(x, z, r)) sign(x, z, dx, dz, { k: 'wrongway' }, 1.3, 1.5); }
      }
    }
    // 2) speed limits along streets and highways
    if (pass === 1 && r.ms && r.c <= 7) along(r, r.c <= 1 ? 1500 : 700, r.c <= 1 ? 300 : 60, (x, z, dx, dz, jd) => {
      if (jd < 25) return;
      const off = r.w / 2 + (r.c <= 1 ? 3 : 1.0), px = x - dz * off, pz = z + dx * off;
      if (!mine(px, pz) || inBuilding(px, pz, 0.8) || onOtherRoad(px, pz, r)) return;
      sign(px, pz, -dx, -dz, { k: 'speed', n: r.ms }, r.c <= 1 ? 1.2 : 0.75, r.c <= 1 ? 1.8 : 1.5);
      if (!r.oneway && r.c > 1) { const qx = x + dz * off, qz = z - dx * off; if (!inBuilding(qx, qz, 0.8) && !onOtherRoad(qx, qz, r)) sign(qx, qz, dx, dz, { k: 'speed', n: r.ms }, 0.75, 1.5); }
    });
    // 3) one-way streets: ONE WAY signs at their intersections, DO NOT ENTER at their exit end
    if (pass === 2 && r.oneway && r.c >= 2 && r.c <= 7) {
      for (let i = 0; i < n; i++) {
        if ((deg.get(Math.round(r.pts[i * 2]) + ',' + Math.round(r.pts[i * 2 + 1])) || 0) < 3 || Math.abs(H(r, i)) > 0.3) continue;
        const x0 = r.pts[i * 2], z0 = r.pts[i * 2 + 1]; if (!mine(x0, z0)) continue;
        const [dx, dz] = dirAt(r, Math.min(i, n - 2));
        if (i < n - 1) { // ONE WAY on the far corner, readable by the cross street
          const q = walk(r, i, 6); if (q) for (const side of [1, -1]) { const off = r.w / 2 + 1.1, x = q.x - dz * off * side, z = q.z + dx * off * side; if (inBuilding(x, z, 0.5) || onOtherRoad(x, z, r)) continue; const nx = -dz * side, nz = dx * side; sign(x, z, nx, nz, { k: 'oneway', right: dx * nz - dz * nx > 0 }, 1.0, 2.2); sign(x, z, -nx, -nz, { k: 'oneway', right: dz * nx - dx * nz > 0 }, 1.0, 2.2); break; }
        }
        if (i === n - 1) { const q = walk(r, i, -8); if (q) { const off = r.w / 2 + 1.1, x = q.x + dz * off, z = q.z - dx * off; if (!onOtherRoad(x, z, r) && !inBuilding(x, z, 0.5)) sign(x, z, dx, dz, { k: 'dne' }, 0.8, 1.6); } }
      }
    }
  }
  if (!slots.size) return null;
  const tex = atlasTexture(can);
  const m = buf.mesh(new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, emissive: '#2a2a2a' }), false);
  m.userData.tex = tex;
  if (!signFontsReady) signAtlases.add({ mesh: m, redraw: () => { for (const [sl, sg] of drawn) drawTSign(ctx, sl, sg); tex.needsUpdate = true; } });
  return m;
}

// ───────────────────────── roadside: streetlights, utility poles & wires, hydrants, parked cars, driveways ─────────────────────────
const POLE_STEEL = rgbOf('#8a9095'), POLE_WOOD = rgbOf('#5f4a38'), LAMP_HEAD = rgbOf('#d4d7d9'), LAMP_LENS = rgbOf('#fff4d2');
const HYDRANT = rgbOf('#c23b2b'), HYD_CAP = rgbOf('#d8d4c8'), MAILBOX = rgbOf('#2e3236'), TIRE = rgbOf('#1b1c1e'), GLASS = rgbOf('#26313b');
const PARKED_PAL = ['#f2f2f0', '#f2f2f0', '#1d1f22', '#1d1f22', '#a9adb2', '#a9adb2', '#6b6f75', '#23365c', '#7d1d1d', '#b9ab8f', '#2f4a36', '#4a5a6c', '#9a2a22', '#d9d6cf'].map(rgbOf);
const drivewayMat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -0.7, polygonOffsetUnits: -1.4 });
drivewayMat.userData.noCast = true;
const wireMat = new THREE.LineBasicMaterial({ color: '#2a2b2c' });
function maybeClutter(t) {
  if (t.cluttered || t.dead || t.state.r !== 2 || !t.bldMeshes || !(t.state.l === 2 || t.lFailed)) return;
  t.cluttered = true;
  buildClutter(t);
}
function buildClutter(t) {
  const mine = (x, z) => tileOf(x, z).join(',') === t.key;
  let seed = (t.tx * 92821 + t.ty * 68917) | 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const solid = new GeoBuf(), flat = new GeoBuf(), wires = [];
  const inBuilding = (x, z, pad = 0) => {
    const a = t.bldGrid.get(ck(Math.floor(x / CELL), Math.floor(z / CELL))); if (!a) return false;
    for (const b of a) if (x > b.box[0] - pad && x < b.box[2] + pad && z > b.box[1] - pad && z < b.box[3] + pad && (pointInPoly(x, z, b.pts) || (pad && edgeDist(x, z, b.pts) < pad))) return true;
    return false;
  };
  const onOtherRoad = (x, z, r) => { const nr = nearestRoadIn(t, x, z, 20); return nr && nr.road !== r && nr.d < nr.road.w / 2 + 0.3; };
  // junction nodes (3+ segment ends meet) so nothing is placed in an intersection
  const deg = new Map();
  for (const r of t.roads) { const p = r.pts, n = p.length / 2; for (let i = 0; i < n; i++) { const k = Math.round(p[i * 2]) + ',' + Math.round(p[i * 2 + 1]); deg.set(k, (deg.get(k) || 0) + (i === 0 || i === n - 1 ? 1 : 2)); } }
  // walk along a road placing things every `step` metres on a side (+1 right of the way's direction, -1 left)
  const along = (r, step, start, fn) => {
    const p = r.pts, n = p.length / 2; if (n < 2) return;
    const cum = [0], jd = [];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]));
    for (let i = 0; i < n; i++) if ((deg.get(Math.round(p[i * 2]) + ',' + Math.round(p[i * 2 + 1])) || 0) >= 3) jd.push(cum[i]);
    let seg = 0;
    for (let s = start; s < cum[n - 1]; s += step) {
      while (seg < n - 2 && cum[seg + 1] < s) seg++;
      const L = cum[seg + 1] - cum[seg] || 1, f = (s - cum[seg]) / L;
      const dx = (p[seg * 2 + 2] - p[seg * 2]) / L, dz = (p[seg * 2 + 3] - p[seg * 2 + 1]) / L;
      const h = r.hs ? r.hs[seg] + (r.hs[seg + 1] - r.hs[seg]) * f : 0;
      if (Math.abs(h) > 0.3) continue; // bridges, trenches
      const jdist = jd.reduce((m, v) => Math.min(m, Math.abs(v - s)), 1e9);
      fn(p[seg * 2] + (p[seg * 2 + 2] - p[seg * 2]) * f, p[seg * 2 + 1] + (p[seg * 2 + 3] - p[seg * 2 + 1]) * f, dx, dz, jdist);
    }
  };
  // a cobra-head streetlight: pole, arm reaching over the road, lamp head
  const cobra = (x, z, tx, tz, H, arm, col = POLE_STEEL) => {
    boxY(solid, x, z, tx, tz, 0.1, 0.1, 0, H, col);
    boxY(solid, x + tx * arm / 2, z + tz * arm / 2, tx, tz, arm / 2, 0.05, H - 0.22, H - 0.1, col);
    const hx = x + tx * (arm + 0.25), hz = z + tz * (arm + 0.25);
    boxY(solid, hx, hz, tx, tz, 0.38, 0.17, H - 0.42, H - 0.12, LAMP_HEAD, LAMP_HEAD, LAMP_LENS);
    lamps.push(hx, hz, H);
  };
  const lamps = [];
  const utilPoles = []; // per road side: list of pole tops, for wires
  let lights = 0, hyd = 0;
  for (const r of t.roads) {
    if (r.tunnel || r.c > 12) continue;
    const c = r.c, w = r.w;
    const place = (step, start, side, off, minJ, fn) => along(r, step, start, (x, z, dx, dz, jd) => {
      if (jd < minJ) return;
      const rx = -dz * side, rz = dx * side, px = x + rx * off, pz = z + rz * off;
      if (!mine(px, pz) || inBuilding(px, pz, 0.6) || onOtherRoad(px, pz, r)) return;
      fn(px, pz, -rx, -rz, dx, dz);
    });
    if (c === 0 || c === 1) place(70, 30 + rnd() * 30, 1, w / 2 + 1.5, 25, (x, z, tx, tz) => { cobra(x, z, tx, tz, 12, 3.2); lights++; });
    else if (c === 8 || c === 9) place(55, 20, 1, w / 2 + 1.4, 18, (x, z, tx, tz) => { cobra(x, z, tx, tz, 11, 2.6); lights++; });
    else if (c === 2) { place(42, 12, 1, w / 2 + 0.9, 14, (x, z, tx, tz) => { cobra(x, z, tx, tz, 10, 2.4); lights++; }); if (!r.oneway) place(42, 33, -1, w / 2 + 0.9, 14, (x, z, tx, tz) => { cobra(x, z, tx, tz, 10, 2.4); lights++; }); }
    else if (c === 3 || c === 4) {
      const side = (r.pts.length & 2) ? 1 : -1;
      place(46, 18, side, w / 2 + 0.9, 14, (x, z, tx, tz) => { cobra(x, z, tx, tz, 9.5, 2.2); lights++; });
      // wooden utility poles with a crossarm on the other side, wired together
      const tops = [];
      place(40, 8, -side, w / 2 + 1.8, 9, (x, z, tx, tz, dx, dz) => {
        boxY(solid, x, z, dx, dz, 0.13, 0.13, 0, 10, POLE_WOOD);
        boxY(solid, x, z, tx, tz, 1.0, 0.06, 9.1, 9.25, POLE_WOOD);
        tops.push([x + tx * 0.85, z + tz * 0.85, x - tx * 0.85, z - tz * 0.85, x, z]);
      });
      utilPoles.push(tops);
    } else if (c === 5 || c === 6) {
      const side = (r.pts.length & 2) ? 1 : -1;
      place(62, 20 + rnd() * 20, side, w / 2 + 1.1, 10, (x, z, tx, tz) => { cobra(x, z, tx, tz, 7.5, 1.4, POLE_WOOD); lights++; });
    } else if (c >= 10) place(50, 15, 1, w / 2 + 1.2, 14, (x, z, tx, tz) => { cobra(x, z, tx, tz, 9.5, 2.2); lights++; });
    if (c >= 3 && c <= 6) place(110, 30 + rnd() * 50, 1, w / 2 + 0.7, 8, (x, z) => { // fire hydrant at the curb
      boxY(solid, x, z, 1, 0, 0.13, 0.13, 0, 0.62, HYDRANT); boxY(solid, x, z, 1, 0, 0.17, 0.08, 0.38, 0.48, HYDRANT); boxY(solid, x, z, 1, 0, 0.09, 0.09, 0.62, 0.78, HYD_CAP); hyd++;
    });
  }
  // overhead lines between consecutive utility poles, sagging a little mid-span
  for (const tops of utilPoles) for (let i = 0; i < tops.length - 1; i++) {
    const a = tops[i], b = tops[i + 1]; if (Math.hypot(a[4] - b[4], a[5] - b[5]) > 60) continue;
    for (const [ia, ib, y] of [[0, 1, 9.3], [2, 3, 9.3], [4, 5, 9.9]]) {
      const ax = a[ia], az = a[ib], bx = b[ia], bz = b[ib];
      for (let k = 0; k < 4; k++) {
        const f0 = k / 4, f1 = (k + 1) / 4, sag = f => y - 0.7 * 4 * f * (1 - f);
        wires.push(ax + (bx - ax) * f0, sag(f0), az + (bz - az) * f0, ax + (bx - ax) * f1, sag(f1), az + (bz - az) * f1);
      }
    }
  }
  // parked cars: along the curb on city and residential streets, and in parking lots
  let parked = 0; const MAXP = LOW ? 450 : 2600;
  const car = (x, z, dx, dz, collide) => {
    if (parked >= MAXP) return;
    const col = PARKED_PAL[(rnd() * PARKED_PAL.length) | 0], len = 4.3 + rnd() * 0.6, big = rnd() < 0.3;
    const hw = 0.92, hl = len / 2, roof = big ? 1.85 : 1.48;
    boxY(solid, x, z, dx, dz, hl, hw, 0.32, big ? 1.12 : 0.98, col);                               // body
    boxY(solid, x - dx * 0.25, z - dz * 0.25, dx, dz, hl * (big ? 0.72 : 0.55), hw - 0.08, big ? 1.12 : 0.98, roof, GLASS, col); // cabin
    boxY(solid, x, z, dx, dz, hl - 0.35, hw - 0.04, 0.02, 0.36, TIRE);                              // wheels / underbody
    if (collide) addCollider(t, [x + dx * hl + dz * hw, z + dz * hl - dx * hw, x + dx * hl - dz * hw, z + dz * hl + dx * hw, x - dx * hl - dz * hw, z - dz * hl + dx * hw, x - dx * hl + dz * hw, z - dz * hl - dx * hw], 1.5);
    parked++;
  };
  for (const r of t.roads) {
    if (r.tunnel || !r.spec) continue;
    const sp = r.spec, c = r.c;
    let rate = 0, off = 0;
    if (c === 5 || c === 6) { rate = 0.26; off = r.w / 2 - 1.05; }
    else if (sp.kind === 'city') { rate = 0.38; off = r.w / 2 - 1.25; }
    if (!rate) continue;
    for (const side of r.oneway ? [1] : [1, -1]) along(r, 6.8, 4 + rnd() * 4, (x, z, dx, dz, jd) => {
      if (jd < 13 || rnd() > rate) return;
      const rx = -dz * side, rz = dx * side, px = x + rx * off, pz = z + rz * off;
      if (!mine(px, pz) || inBuilding(px, pz, 1.2) || onOtherRoad(px, pz, r)) return;
      car(px, pz, dx * side, dz * side, true);
    });
  }
  for (const a of t.areas || []) {
    if (a.c !== 0 || parked >= MAXP) continue;
    const pts = a.pts, ar = Math.abs(polyArea(pts)); if (ar < 250) continue;
    const [ux, uz] = longAxis(pts), vx = -uz, vz = ux;
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (let i = 0; i < pts.length; i += 2) { const u = pts[i] * ux + pts[i + 1] * uz, v = pts[i] * vx + pts[i + 1] * vz; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const fill = 0.35 + rnd() * 0.4;
    // double rows of stalls (2 × 5.4 m) with 7 m aisles; stalls 2.7 m wide
    for (let v = v0 + 3.2; v < v1 - 2.5; v += 17.8) for (const rowOff of [0, 5.4]) for (let u = u0 + 2.5; u < u1 - 1.4; u += 2.7) {
      if (rnd() > fill) continue;
      const vv = v + rowOff, x = u * ux + vv * vx, z = u * uz + vv * vz;
      if (!mine(x, z) || !pointInPoly(x, z, pts) || edgeDist(x, z, pts) < 2.4 || inBuilding(x, z, 1) || onOtherRoad(x, z, null)) continue;
      car(x, z, vx * (rowOff ? 1 : -1), vz * (rowOff ? 1 : -1), true);
    }
  }
  // houses: a driveway out to the nearest residential street, and a mailbox at the curb
  const CONC = rgbOf('#b8b4ab');
  for (const b of t.blds) {
    if (b.kind !== 0 || b.h > 10) continue;
    const pts = b.pts, n = pts.length / 2; if (n < 3) continue;
    let cx = 0, cz = 0; for (let i = 0; i < n; i++) { cx += pts[i * 2]; cz += pts[i * 2 + 1]; } cx /= n; cz /= n;
    if (!mine(cx, cz)) continue;
    const nr = nearestRoadIn(t, cx, cz, 45); if (!nr || nr.road.c < 4 || nr.road.c > 7 || nr.road.tunnel) continue;
    let ox = cx - nr.px, oz = cz - nr.pz; const od = Math.hypot(ox, oz); if (od < nr.road.w / 2 + 3) continue; ox /= od; oz /= od;
    const ex = nr.px + ox * (nr.road.w / 2), ez = nr.pz + oz * (nr.road.w / 2);
    // run toward the house until we reach its wall
    let L = 0; while (L < 40 && !pointInPoly(ex + ox * (L + 0.5), ez + oz * (L + 0.5), pts)) L += 0.5;
    if (L < 2 || L >= 40) continue;
    const mx = ex + ox * L / 2, mz = ez + oz * L / 2;
    if (inBuilding(mx, mz)) continue;
    const sx = -oz * 1.6, sz = ox * 1.6, y = 0.04;
    quadN(flat, [ex + sx, y, ez + sz], [ex - sx, y, ez - sz], [ex - sx + ox * L, y, ez - sz + oz * L], [ex + sx + ox * L, y, ez + sz + oz * L], [0, 1, 0], CONC);
    if (!LOW && rnd() < 0.6) { // mailbox on a post beside the driveway
      const mx2 = ex + ox * 0.9 + sx * 1.6, mz2 = ez + oz * 0.9 + sz * 1.6;
      boxY(solid, mx2, mz2, ox, oz, 0.04, 0.04, 0, 1.0, POLE_WOOD); boxY(solid, mx2, mz2, ox, oz, 0.24, 0.12, 1.0, 1.22, MAILBOX);
    }
  }
  const add = m => { if (m) { t.group.add(m); t.bldMeshes.push(m); } };
  add(trafficSigns(t, solid, deg, along, mine, inBuilding, onOtherRoad));
  { const cm = solid.mesh(bldMat, true); if (cm) cm.userData.role = 'clutter'; add(cm); }
  add(flat.mesh(drivewayMat, true));
  if (lamps.length) { // night: a warm pool of light on the ground under each lamp, and a glow around the lamp itself
    const n = lamps.length / 3, pos = [], nor = [], uv = [], idx = [], hp = [];
    for (let i = 0; i < n; i++) {
      const x = lamps[i * 3], z = lamps[i * 3 + 1], H = lamps[i * 3 + 2], R = H * 0.95, b = i * 4;
      pos.push(x - R, 0.07, z - R, x + R, 0.07, z - R, x + R, 0.07, z + R, x - R, 0.07, z + R);
      nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0); uv.push(0, 0, 1, 0, 1, 1, 0, 1); idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      hp.push(x, H - 0.5, z);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeBoundingSphere();
    const pm = new THREE.Mesh(g, poolMat); pm.matrixAutoUpdate = false; pm.renderOrder = 2; add(pm);
    const hg = new THREE.BufferGeometry(); hg.setAttribute('position', new THREE.Float32BufferAttribute(hp, 3)); hg.computeBoundingSphere();
    const halo = new THREE.Points(hg, haloMat); halo.matrixAutoUpdate = false; halo.renderOrder = 3; add(halo);
  }
  if (wires.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3)); g.computeBoundingSphere(); const l = new THREE.LineSegments(g, wireMat); l.matrixAutoUpdate = false; add(l); }
  t.group.updateMatrixWorld(true);
  t.clutterStats = { lights, hyd, parked, wires: wires.length / 6 };
}
function maybePlant(t) {
  maybeClutter(t);
  if (t.planted || !settings.trees || t.state.r !== 2 || !(t.state.l === 2 || t.lFailed)) return;
  t.planted = true; plantTrees(t);
}

// trees (instanced) – woods and parks, boulevard trees on residential streets, none on parking/commercial
const treeGeoTrunk = new THREE.CylinderGeometry(0.25, 0.35, 3, 5); treeGeoTrunk.translate(0, 1.5, 0);
const treeGeoTop = new THREE.IcosahedronGeometry(2.6, 0); treeGeoTop.translate(0, 4.6, 0);
const treeMatTrunk = new THREE.MeshLambertMaterial({ color: '#5b4632' });
const treeMatTop = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true });
function plantTrees(t) {
  const [x0, z1] = proj(B.S + t.ty * TLAT, B.W + t.tx * TLON);
  const [x1, z0] = proj(B.S + (t.ty + 1) * TLAT, B.W + (t.tx + 1) * TLON);
  let seed = t.tx * 7919 + t.ty * 104729 + 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const spots = [], MAX = LOW ? 1100 : 2600;
  const hasLU = t.areas && t.areas.length > 0;
  const clearOfRoads = (x, z, pad) => { const nr = nearestRoadIn(t, x, z, 30); return !(nr && nr.d < nr.road.w / 2 + pad); };
  const inWater = (x, z) => t.water && t.water.some(w => pointInPoly(x, z, w));
  if (hasLU) {
    // 1) woods & parks: scatter inside the polygons
    for (const a of t.areas) {
      const dens = a.c === 5 ? 1 / 130 : (a.c === 4 || a.c === 7) ? 1 / 700 : a.c === 9 ? 1 / 1500 : 0;
      if (!dens) continue;
      const ar = (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]);
      const want = Math.min(900, ar * dens);
      for (let k = 0; k < want * 2 && spots.length / 3 < MAX; k++) {
        const x = a.box[0] + rnd() * (a.box[2] - a.box[0]), z = a.box[1] + rnd() * (a.box[3] - a.box[1]);
        if (x < x0 || x > x1 || z < z0 || z > z1 || !pointInPoly(x, z, a.pts) || !clearOfRoads(x, z, 3) || inWater(x, z)) continue;
        spots.push(x, z, rnd());
      }
    }
    // 2) boulevard trees along residential streets
    for (const r of t.roads) {
      if (r.c < 4 || r.c > 7 || (r.hs && r.hs.some(h => h > 0.3))) continue;
      const p = r.pts, off = r.w / 2 + 2.6;
      for (let i = 0; i < p.length / 2 - 1 && spots.length / 3 < MAX; i++) {
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2], bz = p[i * 2 + 3], L = Math.hypot(bx - ax, bz - az);
        if (L < 1) continue;
        const dx = (bx - ax) / L, dz = (bz - az) / L;
        for (let d = 6 + rnd() * 6; d < L - 4; d += 11 + rnd() * 7) for (const side of [-1, 1]) {
          if (rnd() < 0.18) continue;
          const x = ax + dx * d - dz * off * side, z = az + dz * d + dx * off * side;
          if (x < x0 || x > x1 || z < z0 || z > z1) continue;
          const lu = areaAt(t, x, z);
          if (lu !== 3 && lu !== 4 && lu !== 9) continue; // only residential / park / campus frontage
          if (!clearOfRoads(x, z, 1.5)) continue;
          spots.push(x, z, rnd());
        }
      }
    }
  } else {
    for (let i = 0; i < 1400 && spots.length < 650 * 3; i++) {
      const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0);
      const nr = nearestRoadIn(t, x, z, 30);
      if (nr && nr.d < nr.road.w / 2 + 4) continue;
      if (!nr && rnd() < 0.6) continue;
      if (inWater(x, z)) continue;
      spots.push(x, z, rnd());
    }
  }
  for (let i = spots.length - 3; i >= 0; i -= 3) if (inBallpark(spots[i], spots[i + 1])) spots.splice(i, 3);
  const n = spots.length / 3; if (!n) return;
  const trunks = new THREE.InstancedMesh(treeGeoTrunk, treeMatTrunk, n);
  const tops = new THREE.InstancedMesh(treeGeoTop, treeMatTop, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const greens = ['#4d7a3a', '#5c8a3f', '#3f6b33', '#6b8f45', '#567d3c'];
  for (let i = 0; i < n; i++) {
    const r = spots[i * 3 + 2], sc = 0.75 + r * 0.8;
    p.set(spots[i * 3], 0, spots[i * 3 + 1]); s.set(sc, sc * (0.9 + r * 0.4), sc); q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r * 6.28);
    m.compose(p, q, s); trunks.setMatrixAt(i, m); tops.setMatrixAt(i, m);
    tops.setColorAt(i, tmpC.set(greens[Math.floor(r * 97) % greens.length]));
  }
  t.trees = spots;
  t.group.add(trunks, tops);
}

function pointInPoly(x, z, pts) {
  let inside = false; const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2], zi = pts[i * 2 + 1], xj = pts[j * 2], zj = pts[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// nearest road
function nearestRoadIn(t, x, z, maxD) {
  let best = null, bd = maxD * maxD;
  const r = Math.ceil(maxD / CELL);
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    const a = t.roadGrid.get(ck(cx + dx, cz + dz)); if (!a) continue;
    for (const ref of a) {
      const p = ref.road.pts, s = ref.s;
      const ax = p[s * 2], az = p[s * 2 + 1], bx = p[s * 2 + 2], bz = p[s * 2 + 3];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
      let u = ((x - ax) * ex + (z - az) * ez) / L2; u = Math.max(0, Math.min(1, u));
      const px = ax + ex * u, pz = az + ez * u;
      const d = (x - px) ** 2 + (z - pz) ** 2;
      // prefer major roads when overlapping (e.g. at intersections)
      const adj = d - (RC[ref.road.c]?.p || 0) * 0.5;
      if (adj < bd) { bd = adj; best = { road: ref.road, d: Math.sqrt(d), px, pz, dx: ex / Math.sqrt(L2), dz: ez / Math.sqrt(L2), s }; }
    }
  }
  return best;
}
// the drivable surface under (x,z) that the car can reach from height y
function surfaceAt(x, z, y) {
  let best = null;
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (const t of tiles.values()) {
    if (t.state.r !== 2) continue;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const a = t.roadGrid.get(ck(cx + dx, cz + dz)); if (!a) continue;
      for (const ref of a) {
        const r = ref.road, p = r.pts, s = ref.s;
        const ax = p[s * 2], az = p[s * 2 + 1], ex = p[s * 2 + 2] - ax, ez = p[s * 2 + 3] - az;
        const L2 = ex * ex + ez * ez || 1e-9;
        let u = ((x - ax) * ex + (z - az) * ez) / L2; u = Math.max(0, Math.min(1, u));
        const d = Math.hypot(x - ax - ex * u, z - az - ez * u);
        if (d > r.w / 2 + 0.7) continue;
        const h = r.hs ? r.hs[s] + (r.hs[s + 1] - r.hs[s]) * u : 0;
        if (h > y + 1.6) continue; // overhead (a bridge above us)
        if (r.tunnel && h < y - 3) continue; // a tunnel under the ground we're driving on
        if (!best || h > best.h + 0.25 || (Math.abs(h - best.h) <= 0.25 && RC[r.c].p > RC[best.road.c].p)) best = { h, road: r, d, dx: ex / Math.sqrt(L2), dz: ez / Math.sqrt(L2), px: ax + ex * u, pz: az + ez * u };
      }
    }
  }
  return best;
}
function nearestRoad(x, z, maxD = 40) {
  let best = null;
  for (const t of tiles.values()) {
    if (t.state.r !== 2) continue;
    const r = nearestRoadIn(t, x, z, maxD);
    if (r && (!best || r.d < best.d)) best = r;
  }
  return best;
}

// building collision: push circle (x,z,rad) out of footprints
function collideBuildings(pos, rad, withBerms = false, road = null) {
  let hit = null;
  const cx = Math.floor(pos.x / CELL), cz = Math.floor(pos.z / CELL);
  for (const t of tiles.values()) {
    if (t.state.b !== 2 && !withBerms) continue;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const grid of withBerms ? [t.bldGrid, t.bermGrid] : [t.bldGrid]) {
      const a = grid.get(ck(cx + dx, cz + dz)); if (!a) continue;
      for (const b of a) {
        const [x0, z0, x1, z1] = b.box;
        if (pos.x < x0 - rad || pos.x > x1 + rad || pos.z < z0 - rad || pos.z > z1 + rad) continue;
        const p = b.pts, n = p.length / 2;
        // a building standing over the street you're on (skyway, building bridging the road): drive under it
        if (road && b.h > 2.5 && [-5, 0, 5].some(k => pointInPoly(road.px + road.dx * k, road.pz + road.dz * k, p))) continue;
        const inside = pointInPoly(pos.x, pos.z, p);
        let bd = 1e18, bx = 0, bz = 0;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ax = p[i * 2], az = p[i * 2 + 1], ex = p[j * 2] - ax, ez = p[j * 2 + 1] - az;
          const L2 = ex * ex + ez * ez || 1e-9;
          let u = ((pos.x - ax) * ex + (pos.z - az) * ez) / L2; u = Math.max(0, Math.min(1, u));
          const qx = ax + ex * u, qz = az + ez * u, d = (pos.x - qx) ** 2 + (pos.z - qz) ** 2;
          if (d < bd) { bd = d; bx = qx; bz = qz; }
        }
        const d = Math.sqrt(bd);
        if (!inside && d >= rad) continue;
        let nx = pos.x - bx, nz = pos.z - bz; const l = Math.hypot(nx, nz) || 1e-6; nx /= l; nz /= l;
        if (inside) { nx = -nx; nz = -nz; }
        const push = inside ? d + rad : rad - d;
        pos.x += nx * push; pos.z += nz * push;
        hit = { nx, nz };
      }
    }
  }
  return hit;
}

// ───────────────────────── car ─────────────────────────
const CARS = {
  sport: { label: 'Sports car', top: 63, boost: 80, accel: 14, boostAccel: 18, grip: 10.5, latG: 14, body: 0.75 },
  sedan: { label: 'Sedan', top: 52, boost: 66, accel: 8, boostAccel: 11, grip: 9, latG: 12.5, body: 1 },
  beater: { label: 'Old sedan', top: 46, boost: 56, accel: 6.2, boostAccel: 8, grip: 8.5, latG: 11.5, body: 1.15 },
  hatch: { label: 'Hatchback', top: 50, boost: 62, accel: 8.4, boostAccel: 11, grip: 9.5, latG: 12.8, body: 1 },
  suv: { label: 'SUV', top: 52, boost: 64, accel: 8, boostAccel: 10.5, grip: 8.5, latG: 11, body: 1.25 },
  pickup: { label: 'Pickup', top: 52, boost: 64, accel: 8.6, boostAccel: 11, grip: 8, latG: 10.5, body: 1.3 },
  van: { label: 'Minivan', top: 49, boost: 60, accel: 7, boostAccel: 9.5, grip: 8.5, latG: 10.5, body: 1.3 },
  lux: { label: 'Luxury sedan', top: 60, boost: 74, accel: 11, boostAccel: 14, grip: 10, latG: 13.5, body: 0.85 },
  bus: { label: 'Metro Transit bus', top: 27, boost: 30, accel: 3.4, boostAccel: 4, grip: 7, latG: 6.5, body: 1.6 },
  tow: { label: 'Tow truck', top: 44, boost: 52, accel: 6.5, boostAccel: 8, grip: 8, latG: 10, body: 1.35 },
  police: { label: 'Police cruiser', top: 60, boost: 74, accel: 10.5, boostAccel: 13.5, grip: 9.8, latG: 13, body: 0.95 },
  taxi: { label: 'Taxi', top: 52, boost: 66, accel: 8, boostAccel: 11, grip: 9, latG: 12.5, body: 1 },
};
function sideProfile(pts) { const sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]); sh.closePath(); return sh; }
function extrudeAcross(pts, width, bevel) {
  const g = new THREE.ExtrudeGeometry(sideProfile(pts), { depth: width - bevel * 2, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 4 });
  g.rotateY(-Math.PI / 2); g.translate((width - bevel * 2) / 2, 0, 0);
  return g;
}
function makeWheels(g, dark, rimMat, r, xs, zs) {
  const tire = new THREE.CylinderGeometry(r, r, 0.3, 18); tire.rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.32, 10); rim.rotateZ(Math.PI / 2);
  const wheels = [];
  for (const z of zs) for (const x of xs) {
    const w = new THREE.Group();
    w.add(new THREE.Mesh(tire, dark), new THREE.Mesh(rim, rimMat));
    w.position.set(x, r, z); g.add(w); wheels.push(w);
  }
  return wheels;
}
function makeSportsCar(color) {
  const g = new THREE.Group();
  const paint = new THREE.MeshPhongMaterial({ color, shininess: 90, specular: '#666' });
  const dark = new THREE.MeshLambertMaterial({ color: '#16181b' });
  const glass = new THREE.MeshPhongMaterial({ color: '#1b2734', shininess: 120, specular: '#aab' });
  const rimMat = new THREE.MeshPhongMaterial({ color: '#c9ccd1', shininess: 100 });
  // low wedge body (profile: z along length, y up)
  g.add(new THREE.Mesh(extrudeAcross([[-2.3, 0.28], [2.32, 0.28], [2.38, 0.52], [1.3, 0.78], [0.45, 0.92], [-1.5, 0.98], [-2.3, 0.88]], 2.02, 0.07), paint));
  // canopy
  g.add(new THREE.Mesh(extrudeAcross([[0.62, 0.9], [-0.15, 1.3], [-1.05, 1.31], [-1.85, 0.97]], 1.6, 0.05), glass));
  // side skirts + splitter + diffuser
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(2.08, 0.12, 3.2), dark); skirt.position.set(0, 0.3, 0); g.add(skirt);
  const split = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.06, 0.3), dark); split.position.set(0, 0.24, 2.3); g.add(split);
  const diff = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.22, 0.2), dark); diff.position.set(0, 0.36, -2.32); g.add(diff);
  // spoiler
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.06, 0.42), paint); wing.position.set(0, 1.28, -2.05); wing.rotation.x = -0.08; g.add(wing);
  for (const x of [-0.6, 0.6]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.32, 0.12), dark); post.position.set(x, 1.1, -2.0); g.add(post); }
  // lights
  const hl = new THREE.MeshBasicMaterial({ color: '#eaf4ff' }), tl = new THREE.MeshBasicMaterial({ color: '#ff1e2d' });
  for (const sx of [-0.68, 0.68]) { const h = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.07, 0.08), hl); h.position.set(sx, 0.6, 2.3); h.rotation.x = 0.4; g.add(h); }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.07, 0.05), tl); bar.position.set(0, 0.86, -2.31); g.add(bar);
  // racing stripes
  const stripeMat = new THREE.MeshBasicMaterial({ color: '#f4f4f0' });
  for (const sx of [-0.2, 0.2]) { const st = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 1.25), stripeMat); st.position.set(sx, 0.86, 1.65); st.rotation.x = 0.3; g.add(st); }
  const wheels = makeWheels(g, dark, rimMat, 0.38, [-0.9, 0.9], [1.42, -1.38]);
  g.userData = { wheels, paint };
  return g;
}
function makeSedan(color) {
  const g = new THREE.Group();
  const paint = new THREE.MeshLambertMaterial({ color });
  const dark = new THREE.MeshLambertMaterial({ color: '#1d2126' });
  const glass = new THREE.MeshLambertMaterial({ color: '#26384a' });
  const rimMat = new THREE.MeshLambertMaterial({ color: '#9aa0a8' });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.62, 4.5), paint); body.position.y = 0.66; g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.62, 2.2), glass); cabin.position.set(0, 1.27, -0.25); g.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 1.9), paint); roof.position.set(0, 1.62, -0.3); g.add(roof);
  const bump = new THREE.Mesh(new THREE.BoxGeometry(1.94, 0.3, 0.2), dark); bump.position.set(0, 0.45, 2.27); g.add(bump);
  const bump2 = bump.clone(); bump2.position.z = -2.27; g.add(bump2);
  const hl = new THREE.MeshBasicMaterial({ color: '#fff7d6' }), tl = new THREE.MeshBasicMaterial({ color: '#d0121b' });
  for (const sx of [-0.65, 0.65]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.05), hl); h.position.set(sx, 0.78, 2.26); g.add(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.05), tl); t.position.set(sx, 0.8, -2.26); g.add(t);
  }
  const wheels = makeWheels(g, dark, rimMat, 0.37, [-0.88, 0.88], [1.4, -1.4]);
  g.userData = { wheels, paint };
  return g;
}
// the rest of the lineup, built from boxes: [body w, h, len, y], [cabin w, h, len, z, y], wheel radius, axle z front/rear, extras
const VSHAPE = {
  beater: { body: [1.86, 0.6, 4.6, 0.64], cab: [1.62, 0.6, 2.25, -0.25, 1.24], r: 0.35, ax: [1.42, -1.42] },
  hatch: { body: [1.8, 0.62, 4.15, 0.64], cab: [1.62, 0.64, 2.35, -0.38, 1.27], r: 0.34, ax: [1.3, -1.3] },
  suv: { body: [1.94, 0.82, 4.65, 0.86], cab: [1.8, 0.72, 2.95, -0.32, 1.63], r: 0.41, ax: [1.45, -1.45] },
  pickup: { body: [2.02, 0.84, 5.7, 0.9], cab: [1.88, 0.76, 1.95, 0.55, 1.7], r: 0.43, ax: [1.9, -1.65], bed: true },
  van: { body: [1.98, 1.0, 5.1, 0.9], cab: [1.86, 0.78, 3.6, -0.45, 1.79], r: 0.37, ax: [1.6, -1.6] },
  lux: { body: [1.92, 0.6, 5.0, 0.66], cab: [1.66, 0.58, 2.5, -0.3, 1.24], r: 0.38, ax: [1.55, -1.55], chrome: true },
  bus: { body: [2.55, 1.5, 12.2, 1.25], cab: [2.5, 1.05, 11.9, 0.05, 2.5], r: 0.5, ax: [4.3, -3.4] },
  tow: { body: [2.05, 0.9, 6.0, 0.95], cab: [1.9, 0.8, 1.9, 1.05, 1.8], r: 0.44, ax: [2.0, -1.8], bed: true, boom: true },
  taxi: { body: [1.86, 0.62, 4.8, 0.66], cab: [1.64, 0.6, 2.35, -0.25, 1.27], r: 0.36, ax: [1.45, -1.45], sign: true },
  police: { body: [1.9, 0.62, 5.0, 0.66], cab: [1.66, 0.6, 2.45, -0.25, 1.27], r: 0.37, ax: [1.5, -1.5], bar: true },
};
function makeBoxCar(type, color) {
  const V = VSHAPE[type], g = new THREE.Group();
  const paint = new THREE.MeshPhongMaterial({ color, shininess: type === 'beater' ? 15 : 60, specular: '#555' });
  const dark = new THREE.MeshLambertMaterial({ color: '#1d2126' }), glass = new THREE.MeshPhongMaterial({ color: '#22303d', shininess: 110, specular: '#99a' });
  const rimMat = new THREE.MeshLambertMaterial({ color: V.chrome ? '#d9dde2' : '#9aa0a8' });
  const [bw, bh, bl, by] = V.body, [cw, ch, cl, cz, cy] = V.cab;
  const box = (w, h, l, x, y, z, m) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m); o.position.set(x, y, z); g.add(o); return o; };
  box(bw, bh, bl, 0, by, 0, paint);
  box(cw, ch, cl, 0, cy, cz, glass); box(cw - 0.06, 0.08, cl - 0.25, 0, cy + ch / 2 + 0.03, cz, paint); // roof
  for (const sx of [-1, 1]) box(0.06, ch * 0.9, 0.12, sx * (cw / 2 - 0.02), cy, cz + cl / 2 - 0.08, paint); // A-pillars
  if (V.bed) { // pickup bed: two side walls and a tailgate around an open box
    const bz0 = cz - cl / 2 - 0.05, bz1 = -bl / 2, len = bz0 - bz1, mz = (bz0 + bz1) / 2;
    for (const sx of [-1, 1]) box(0.1, 0.5, len, sx * (bw / 2 - 0.05), by + bh / 2 + 0.25, mz, paint);
    box(bw, 0.5, 0.1, 0, by + bh / 2 + 0.25, bz1 + 0.05, paint); box(bw - 0.2, 0.04, len - 0.1, 0, by + bh / 2 + 0.02, mz, dark);
  }
  box(bw + 0.04, 0.26, 0.18, 0, by - bh / 2 + 0.12, bl / 2 + 0.02, V.chrome ? rimMat : dark);
  box(bw + 0.04, 0.26, 0.18, 0, by - bh / 2 + 0.12, -bl / 2 - 0.02, V.chrome ? rimMat : dark);
  const hl = new THREE.MeshBasicMaterial({ color: '#fff7d6' }), tl = new THREE.MeshBasicMaterial({ color: '#d0121b' });
  for (const sx of [-1, 1]) {
    box(0.42, 0.15, 0.05, sx * (bw / 2 - 0.3), by + bh * 0.18, bl / 2 + 0.01, hl);
    box(0.36, 0.16, 0.05, sx * (bw / 2 - 0.25), by + bh * 0.2 + (V.bed ? 0.25 : 0), -bl / 2 - 0.01, tl);
  }
  if (V.boom) { const y = new THREE.MeshLambertMaterial({ color: '#d9a41b' }); box(0.22, 1.3, 0.22, 0, by + bh / 2 + 0.65, -bl / 2 + 0.9, dark); const arm = box(0.18, 0.18, 2.2, 0, by + bh / 2 + 1.2, -bl / 2 + 0.1, dark); arm.rotation.x = -0.45; box(cw * 0.7, 0.12, 0.25, 0, cy + ch / 2 + 0.12, cz, y); }
  if (V.bar) { box(0.7, 0.16, 0.34, 0.37, cy + ch / 2 + 0.16, cz, new THREE.MeshBasicMaterial({ color: '#ff2a2a' })); box(0.7, 0.16, 0.34, -0.37, cy + ch / 2 + 0.16, cz, new THREE.MeshBasicMaterial({ color: '#2a5bff' })); for (const sx of [-1, 1]) box(0.04, 0.24, 2.4, sx * (bw / 2 + 0.01), by + 0.02, 0, new THREE.MeshLambertMaterial({ color: '#15243f' })); }
  if (V.sign) box(0.7, 0.24, 0.3, 0, cy + ch / 2 + 0.2, cz, new THREE.MeshBasicMaterial({ color: '#fff2a8' }));
  if (type === 'bus') { const blue = new THREE.MeshLambertMaterial({ color: '#1f5fbf' }), yel = new THREE.MeshLambertMaterial({ color: '#f2c318' }); for (const sx of [-1, 1]) { box(0.04, 0.3, bl - 0.4, sx * (bw / 2 + 0.01), by + 0.25, 0, blue); box(0.04, 0.1, bl - 0.4, sx * (bw / 2 + 0.01), by + 0.45, 0, yel); } box(1.6, 0.32, 0.05, 0, cy + 0.3, bl / 2 - 0.02 + (cz + cl / 2 - bl / 2) + 0.02, new THREE.MeshBasicMaterial({ color: '#ffb02e' })); }
  const wheels = makeWheels(g, dark, rimMat, V.r, [-(bw / 2 - 0.06), bw / 2 - 0.06], V.ax);
  g.userData = { wheels, paint };
  return g;
}
// split the model into wheels (stay on the road) and a sprung body that pitches, rolls and bounces around a
// pivot near axle height; the whole car is lifted rigidly onto the terrain
const BODY_PIV = 0.45;
function rigCar(g) {
  const wheels = g.userData.wheels, body = new THREE.Group(); body.position.y = BODY_PIV;
  for (const c of [...g.children]) if (!wheels.includes(c)) { g.remove(c); c.position.y -= BODY_PIV; body.add(c); }
  g.add(body); g.userData.body = body;
  g.traverse(o => {
    if (o.material) for (const m of [].concat(o.material)) m.userData.rigid = true;
    if (o.isMesh) { o.userData.shadowSet = true; o.receiveShadow = true; o.castShadow = !o.material.isMeshBasicMaterial; o.customDepthMaterial = carDepthMat; }
  });
}
const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 5.0), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.3, depthWrite: false }));
shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.3;
let car = null;
function setCar() {
  if (car) { car.remove(shadow); scene.remove(car); }
  if (!CARS[settings.car]) settings.car = 'sport';
  const ty = vType(), col = vColor();
  car = ty === 'sedan' ? makeSedan(col) : VSHAPE[ty] ? makeBoxCar(ty, col) : makeSportsCar(col);
  rigCar(car);
  const pb = new THREE.Mesh(beamGeo, beamMat); pb.renderOrder = 2; car.add(pb);
  car.add(shadow); scene.add(car);
}
setCar();

const S = { yawR: 0, bp: 0, bpV: 0, br: 0, brV: 0, bh: 0, bhV: 0, aL: 0, vfPrev: 0, odo: 0, joint: 0, rumble: 0, rumbT: 0, scrub: 0, groll: 0, vib: 0, surfK: 1,
  x: 0, y: 0, vy: 0, pitch: 0, z: 0, h: 0, vx: 0, vz: 0, steer: 0, wheelSpin: 0, drift: 0, charge: 0, relT: 0, burst: 0, nitro: 1, boosting: false, throttle: 0, trauma: 0 };
const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
// end a drift; a long one pays out a mini-turbo (blue sparks ≥0.9 s, orange ≥1.9 s)
function endDrift(crashed) {
  const lvl = crashed ? 0 : S.charge >= 1.9 ? 2 : S.charge >= 0.9 ? 1 : 0;
  S.drift = 0; S.charge = 0;
  if (lvl) { S.burst = lvl === 2 ? 1.6 : 0.7; addTrauma(0.25); buzz(30); flashTag(lvl === 2 ? 'SUPER TURBO' : 'TURBO'); sfx.whoosh(); }
}
const input = { up: 0, down: 0, left: 0, right: 0, brake: 0, boost: 0 };

function physics(dt) {
  const fx = Math.sin(S.h), fz = Math.cos(S.h);
  const rx = -Math.cos(S.h), rz = Math.sin(S.h);
  let vf = S.vx * fx + S.vz * fz;
  let vl = S.vx * rx + S.vz * rz;
  const surf0 = surfaceAt(S.x, S.z, S.y);
  const nr = surf0 || nearestRoad(S.x, S.z, 40);
  const onRoad = !!surf0 && surf0.d < surf0.road.w / 2 + 1.5;
  const ct = tiles.get(tileOf(S.x, S.z).join(','));
  const loaded = ct && ct.state.r === 2;
  const offroad = loaded && !onRoad;

  const C = CARS[vType()] || CARS.sport, gf = wxGrip();
  // ── arcade handling (after Asphalt / NFS No Limits / Mario Kart): nitro bar, assisted drifts, mini-turbos ──
  const steerIn = input.right - input.left;
  const wantBoost = input.boost && S.nitro > 0.02;
  if (wantBoost) S.nitro = Math.max(0, S.nitro - 0.2 * dt); // a full bar ≈ 5 s of nitro
  S.nitro = Math.min(1, S.nitro + (0.025 + (S.drift ? 0.2 : 0) + (vf > 40 ? 0.03 : 0)) * dt);
  if (S.burst > 0) S.burst = Math.max(0, S.burst - dt);
  const boosting = wantBoost || S.burst > 0;
  S.boosting = boosting;
  const maxF = (boosting ? C.boost : C.top) * (offroad ? 0.45 : 1);
  let throttle = input.up - input.down;
  if (settings.autoGas && isTouch && throttle === 0 && !input.brake) throttle = 1;
  if (throttle > 0 && life.outOfGas()) throttle = 0; // empty tank
  S.throttle = throttle;
  const spd = Math.hypot(vf, vl);
  // drift: tap DRIFT (Space) while turning at speed; hold the turn to keep it, let go to straighten out
  if (!S.drift) {
    const tapped = input.brake || performance.now() - (input.tap || 0) < 300; // a quick tap still counts
    if (tapped && steerIn && vf > 11 && !offroad) { input.tap = 0; S.drift = steerIn > 0 ? 1 : -1; S.charge = 0; S.relT = 0; addTrauma(0.12); buzz(12); }
  } else {
    const into = steerIn * S.drift;
    S.relT = into <= 0 ? S.relT + dt : 0;
    S.charge += (into > 0 ? 1.6 : 1) * dt;
    if (S.relT > 0.3 || spd < 7 || input.down > 0) endDrift(false);
  }
  if (S.drift) {
    const into = steerIn * S.drift; // +1 steering into the corner, -1 counter-steering
    const vh = spd > 1 ? Math.atan2(S.vx, S.vz) : S.h;
    const w = (0.62 + 0.38 * into) * Math.min(1, spd / 16); // how fast the line curves (rad/s)
    const nvh = vh - S.drift * w * dt;
    const beta = (27 + 13 * into) * Math.PI / 180; // slip angle held between ~14° and 40°
    const h0 = S.h;
    S.h += angDiff(nvh - S.drift * beta, S.h) * Math.min(1, 7 * dt);
    S.yawR = angDiff(S.h, h0) / dt * 0.3 + -S.drift * w * 0.7; S.scrub = 0;
    let s = spd * (1 - (offroad ? 0.5 : 0.035) * dt); // drifting barely costs speed (grass does)
    if (throttle > 0 && s < maxF) s += (boosting ? C.boostAccel : C.accel) * 0.45 * Math.max(0, 1 - s / maxF) * dt;
    S.vx = Math.sin(nvh) * s; S.vz = Math.cos(nvh) * s;
    S.steer += (steerIn - S.steer) * Math.min(1, dt * 6);
  } else {
    if (throttle > 0) {
      if (vf < -0.5) vf += 22 * dt; // braking from reverse
      else vf += (boosting ? C.boostAccel : C.accel) * (0.55 + 0.45 * gf) * Math.max(0, 1 - vf / maxF) * dt;
    } else if (throttle < 0) {
      if (vf > 0.5) vf -= 22 * (0.3 + 0.7 * gf) * dt; // braking distance grows on wet and snowy roads
      else vf -= 6 * Math.max(0, 1 + vf / 14) * dt;
    }
    // drag
    const drag = 0.25 + 0.0006 * vf * vf + (offroad ? 2.5 : 0) + (throttle === 0 ? 0.8 : 0);
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), drag * dt);
    if (input.brake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 9 * dt);
    // steering: ramps in, and the lock shrinks with speed so the car stays planted at 100+ mph
    S.steer += (steerIn - S.steer) * Math.min(1, dt * (steerIn ? 6 : 9));
    const maxA = 0.62 / (1 + Math.abs(vf) / 18);
    let yawT = -(vf / 2.7) * Math.tan(S.steer * maxA);
    // the tyres can only pull so hard sideways: past the limit the nose scrubs wide (understeer) and bleeds speed
    const cap = C.latG * gf * (offroad ? 0.55 : 1) / Math.max(4, Math.abs(vf));
    S.scrub = 0;
    if (Math.abs(yawT) > cap) {
      const ex = Math.abs(yawT) - cap;
      S.scrub = Math.min(1, ex / cap);
      yawT = Math.sign(yawT) * (cap + ex * 0.15);
      vf -= Math.sign(vf) * Math.min(Math.abs(vf), ex * Math.abs(vf) * 0.18 * dt);
    }
    // the car's mass resists changes in rotation: yaw rate builds up over ~0.1 s
    S.yawR += (yawT - S.yawR) * Math.min(1, dt / 0.1);
    S.h += S.yawR * dt;
    // grip: kill the sideways slide but hand part of it back as forward speed (keeps momentum out of drifts)
    const vl2 = vl * Math.exp(-(offroad ? 4 : C.grip * (0.35 + 0.65 * gf)) * dt);
    if (vf > 0) vf += (Math.abs(vl) - Math.abs(vl2)) * 0.35;
    vl = vl2;
    const nfx = Math.sin(S.h), nfz = Math.cos(S.h), nrx = -Math.cos(S.h), nrz = Math.sin(S.h);
    S.vx = nfx * vf + nrx * vl; S.vz = nfz * vf + nrz * vl;
  }
  vf = S.vx * Math.sin(S.h) + S.vz * Math.cos(S.h); vl = S.vx * -Math.cos(S.h) + S.vz * Math.sin(S.h);
  const ox = S.x, oz = S.z;
  S.x += S.vx * dt; S.z += S.vz * dt;
  // vertical: follow ramps & bridges, fall when airborne
  let surf = surfaceAt(S.x, S.z, S.y);
  const inTun0 = surf0 && surf0.road.tunnel && S.y < 3;
  if ((S.y > 1.2 && surf0 && surf0.h > 1.2 && (!surf || surf.h < S.y - 1.2)) || (inTun0 && !surf) || (surf0 && surf0.h < -1.2 && S.y < -1 && !surf)) {
    // guardrail: don't drive off an elevated road — slide along it instead
    const tx = surf0.dx, tz = surf0.dz, along = S.vx * tx + S.vz * tz;
    S.x = ox + tx * along * dt; S.z = oz + tz * along * dt;
    S.vx = tx * along * 0.92; S.vz = tz * along * 0.92;
    surf = surfaceAt(S.x, S.z, S.y) || surf0;
    if (Math.abs(along) > 12) bump();
  }
  const ground = surf ? surf.h : 0;
  if (S.y > ground + 0.08) { S.vy -= 24 * dt; S.y += S.vy * dt; if (S.y <= ground) { if (S.vy < -9) bump(); if (S.vy < -2) { S.bhV += S.vy * 0.3; S.bpV += S.vy * 0.06; } S.y = ground; S.vy = 0; } }
  else { S.y = ground; S.vy = 0; }
  { // hills: gravity along the slope (only when moving, so the car doesn't creep while parked)
    const sx = Math.sin(S.h) * 2.5, sz = Math.cos(S.h) * 2.5, g = (terrainAt(S.x + sx, S.z + sz) - terrainAt(S.x - sx, S.z - sz)) / 5;
    if (Math.hypot(S.vx, S.vz) > 1.5 && Math.abs(g) < 0.4) { S.vx -= Math.sin(S.h) * 9.8 * g * 0.7 * dt; S.vz -= Math.cos(S.h) * 9.8 * g * 0.7 * dt; }
  }
  // pitch from the slope ahead/behind
  const fwd = surfaceAt(S.x + Math.sin(S.h) * 2, S.z + Math.cos(S.h) * 2, S.y + 0.5), back = surfaceAt(S.x - Math.sin(S.h) * 2, S.z - Math.cos(S.h) * 2, S.y + 0.5);
  const hfx = Math.sin(S.h) * 2, hfz = Math.cos(S.h) * 2;
  const tp = Math.atan2((fwd ? fwd.h : 0) - (back ? back.h : 0) + terrainAt(S.x + hfx, S.z + hfz) - terrainAt(S.x - hfx, S.z - hfz), 4);
  S.pitch += (Math.max(-0.3, Math.min(0.3, tp)) - S.pitch) * Math.min(1, dt * 10);
  { // sideways lean of the ground (the car is tilted as one piece; it used to be sheared)
    const lx = Math.cos(S.h) * 0.9, lz = -Math.sin(S.h) * 0.9;
    const tr = Math.atan2(terrainAt(S.x + lx, S.z + lz) - terrainAt(S.x - lx, S.z - lz), 1.8);
    S.groll += (Math.max(-0.25, Math.min(0.25, tr)) - S.groll) * Math.min(1, dt * 10);
  }
  // collisions
  S.inTun = !!(surf && surf.road.tunnel && S.y < 3);
  const hit = S.y < 2 ? collideBuildings(S, 2.1, !surf, surf && !surf.road.tunnel && surf.d < surf.road.w / 2 + 0.5 ? surf : null) : null;
  if (hit) {
    const vn = S.vx * hit.nx + S.vz * hit.nz;
    if (vn < 0) { // glance off walls; only a head-on hit really costs speed
      const sp0 = Math.hypot(S.vx, S.vz) || 1, head = -vn / sp0;
      S.vx -= 1.2 * vn * hit.nx; S.vz -= 1.2 * vn * hit.nz;
      const keep = head > 0.75 ? 0.45 : 0.97 - head * 0.3; S.vx *= keep; S.vz *= keep;
      if (vn < -6) bump(Math.min(1, -vn / 25));
      if (S.drift && head > 0.45) endDrift(true);
    }
  }
  if (S.y < 3 + (surf ? surf.h : 0)) traffic.collide(S);
  // world border
  if (S.x < MINX + 5 || S.x > MAXX - 5 || S.z < MINZ + 5 || S.z > MAXZ - 5) {
    S.x = Math.min(MAXX - 5, Math.max(MINX + 5, S.x)); S.z = Math.min(MAXZ - 5, Math.max(MINZ + 5, S.z));
    S.vx *= -0.3; S.vz *= -0.3; toast('Edge of the map');
  }
  S.wheelSpin += vf * dt / 0.37;
  suspension(dt, vf, surf, offroad, S.y > ground + 0.08);
  return { vf, nr, onRoad, slide: Math.abs(vl) };
}
// ── suspension & road feel: the body pitches under throttle/brakes, leans in corners and rides over the road's
// texture (asphalt ripple, concrete joints, rumble strips, grass) on damped springs; the wheels stay planted ──
const roadProfile = s => Math.sin(s * 1.7) + 0.6 * Math.sin(s * 3.9 + 1) + 0.4 * Math.sin(s * 0.83 + 2) + 0.3 * Math.sin(s * 7.3 + 4);
function suspension(dt, vf, surf, offroad, air) {
  const C = CARS[vType()] || CARS.sport, k = C.body;
  const spd = Math.hypot(S.vx, S.vz);
  const aRaw = Math.max(-30, Math.min(30, (vf - S.vfPrev) / dt)); S.vfPrev = vf;
  S.aL += (aRaw - S.aL) * Math.min(1, dt * 10);
  const aLat = Math.max(-25, Math.min(25, spd * S.yawR * Math.sign(vf || 1)));
  S.odo += Math.abs(vf) * dt;
  // what's under the tyres
  const on = surf && surf.d < surf.road.w / 2 + 0.3, sp = on && surf.road.spec;
  let rough = 0.004; S.surfK = 1; S.rumble = 0;
  if (offroad || !on) { rough = offroad ? 0.03 : 0.012; S.surfK = offroad ? 1.7 : 1.2; }
  else if (sp) {
    rough = sp.kind === 'minor' ? 0.011 : sp.kind === 'fwy' ? 0.003 : 0.006;
    if (sp.conc) S.surfK = 1.25; else if (sp.kind === 'minor') S.surfK = 1.1;
    if (sp.conc && !air) { // concrete slabs: a joint every 4.6 m
      const j = Math.floor(S.odo / 4.6);
      if (j !== S.joint) { S.joint = j; const q = Math.min(1, spd / 25); S.bhV -= 0.1 * q; S.bpV += 0.05 * q; if (spd > 6) sfx.joint(q); }
    }
    if (sp.kind === 'fwy' && spd > 6) { // milled rumble strips just outside the edge lines
      const lr = (S.x - surf.px) * -surf.dz + (S.z - surf.pz) * surf.dx; // + is the road's right
      const eR = surf.road.w / 2 - sp.shR, eL = surf.road.w / 2 - sp.shL, rw = 0.95;
      const inR = lr + rw > eR + 0.15 && lr + rw - 0.3 < eR + 0.75, inL = -lr + rw > eL + 0.15 && -lr + rw - 0.3 < eL + 0.75;
      if (inR || inL) S.rumble = inR && inL ? 2 : 1;
      if (S.rumble) {
        S.bhV += (Math.random() - 0.5) * 2.2 * dt * 60 * 0.03;
        S.brV += (inR ? -1 : 1) * (Math.random() * 0.9) * dt * 60 * 0.03;
        if ((S.rumbT -= dt) <= 0) { S.rumbT = 0.14; buzz(10); }
      }
    }
  }
  // spring targets: weight transfer + the road surface
  const s = S.odo;
  const pT = air ? 0 : Math.max(-0.075, Math.min(0.075, S.aL * 0.0036 * k));
  const rT = air ? 0 : Math.max(-0.09, Math.min(0.09, aLat * 0.0045 * k)) + rough * (roadProfile(s * 1.13 + 5) - roadProfile(s)) / 1.8;
  const hT = air ? 0.05 : rough * roadProfile(s);
  const spring = (x, v, t, K, z) => v + (K * (t - x) - 2 * z * Math.sqrt(K) * v) * dt;
  S.bpV = spring(S.bp, S.bpV, pT, 140, 0.45); S.bp += S.bpV * dt;
  S.brV = spring(S.br, S.brV, rT, 120, 0.42); S.br += S.brV * dt;
  S.bhV = spring(S.bh, S.bhV, hT, 170, 0.5); S.bh += S.bhV * dt;
  S.bp = Math.max(-0.12, Math.min(0.12, S.bp)); S.br = Math.max(-0.14, Math.min(0.14, S.br)); S.bh = Math.max(-0.12, Math.min(0.12, S.bh));
  S.vib = Math.min(1, spd / 50) * (rough * 2.2 + (S.rumble ? 0.035 : 0));
}
function addTrauma(a) { S.trauma = Math.min(1, S.trauma + a); }
function buzz(ms) { try { if (settings.haptics !== false && navigator.vibrate) navigator.vibrate(ms); } catch {} }
function bump(k = 0.5) { addTrauma(0.3 + k * 0.5); buzz(25 + k * 30); sfx.thud(k); S.bhV -= 0.4 * k; S.brV += (Math.random() - 0.5) * 1.6 * k; }

// ───────────────────────── on foot: your character (Golf Go's motion-captured roster) ─────────────────────────
// Bodies come from chars/<id>.js (R3CHAR format: Mixamo skeleton, quantised mesh, texture); the animation clips live in
// chars/boss.js and are retargeted onto each body once. Get out of the car with F (or the door button) and walk, run
// and jump around; the car stays parked where you left it.
const CHAR_LIST = [['boss', 'The Boss'], ['ch01', 'Gary'], ['ch08', 'Marco'], ['ch12', 'Jordan'], ['ch17', 'Mack'], ['ch23', 'Preston'], ['ch24', 'Shadow'],
  ['ch28', 'Andre'], ['ch31', 'Nina'], ['ch39', 'Master Ko'], ['ch42', 'Danny'], ['ch06', 'Dex'], ['ch09', 'Scout'], ['ch43', 'El Chupacabra'], ['remy', 'Remy'],
  ['ty', 'Ty'], ['vegas', 'Big Vegas'], ['peasant', 'Farmer Hob'], ['granny', 'Coach Dot'], ['brute', 'Brick']];
const charData = {}, charWaiters = {};
let BOSS = null;
window.R3CHAR = D => { charData[D.id] = D; (charWaiters[D.id] || []).splice(0).forEach(f => f(D)); };
window.R3CHAR_BOSS = D => { BOSS = D; charData.boss = D; (charWaiters.boss || []).splice(0).forEach(f => f(D)); };
// the locomotion set (walk, run, jump, idle, turns, strafes) — Mixamo clips retargeted onto the Boss skeleton offline
window.R3ANIMS = A => { charData.anims = A; (charWaiters.anims || []).splice(0).forEach(f => f(A)); };
function loadCharFile(id) {
  if (charData[id]) return Promise.resolve(charData[id]);
  return new Promise((res, rej) => {
    (charWaiters[id] = charWaiters[id] || []).push(res);
    if (document.getElementById('chr_' + id)) return;
    const sc = document.createElement('script'); sc.id = 'chr_' + id; sc.src = `chars/${id}.js?v=1`; sc.onerror = () => { sc.remove(); rej(new Error('char ' + id)); };
    document.head.appendChild(sc);
  });
}
const b64 = (str, T) => { const b = atob(str), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new T(u.buffer); };
// clips are stored for the Boss skeleton: rebuild them bone by bone for another body (same as Golf Go)
function retarget(D) {
  const T = THREE, B = BOSS, nbB = B.names.length, nb = D.names.length;
  const rot = (inv, k) => { const m = new T.Matrix4().fromArray(inv, k * 16).transpose().invert(), q = new T.Quaternion(), p = new T.Vector3(); m.decompose(p, q, new T.Vector3()); return { q, p }; };
  const iB = b64(B.inv, Float32Array), iC = b64(D.inv, Float32Array), RB = [], RC = [];
  for (let k = 0; k < nbB; k++) RB.push(rot(iB, k)); for (let k = 0; k < nb; k++) RC.push(rot(iC, k));
  const bI = Object.fromEntries(B.names.map((s, i) => [s, i])), map = D.names.map(s => bI[s] ?? -1);
  const sc = RC[D.names.indexOf('Hips')].p.y / RB[bI.Hips].p.y;
  const RBi = RB.map(r => r.q.clone().invert()), RCi = RC.map(r => r.q.clone().invert());
  const out = {}, WB = [], WC = []; for (let k = 0; k < nbB; k++) WB.push(new T.Quaternion()); for (let k = 0; k < nb; k++) WC.push(new T.Quaternion());
  const ql = new T.Quaternion(), tmp = new T.Quaternion();
  for (const ck in B.clips) {
    const c = B.clips[ck], Qa = b64(c.q, Int16Array), QS = b64(c.qs, Int16Array), H = b64(c.hip, Float32Array), na = c.anim.length, n = c.n;
    const Q = new Int16Array(n * nb * 4), HC = new Float32Array(n * 3), qb = new Float32Array(nbB * 4);
    for (let f = 0; f < n; f++) {
      for (let k = 0; k < nbB * 4; k++) qb[k] = QS[k] / 32767;
      for (let j = 0; j < na; j++) { const k = c.anim[j]; for (let e = 0; e < 4; e++) qb[k * 4 + e] = Qa[(f * na + j) * 4 + e] / 32767; }
      for (let k = 0; k < nbB; k++) { ql.set(qb[k * 4], qb[k * 4 + 1], qb[k * 4 + 2], qb[k * 4 + 3]).normalize(); const p = B.parent[k]; if (p >= 0) WB[k].copy(WB[p]).multiply(ql); else WB[k].copy(ql); }
      for (let k = 0; k < nb; k++) {
        const p = D.parent[k], jb = map[k];
        if (jb >= 0) WC[k].copy(WB[jb]).multiply(RBi[jb]).multiply(RC[k].q);
        else if (p >= 0) WC[k].copy(WC[p]).multiply(RCi[p]).multiply(RC[k].q); else WC[k].copy(RC[k].q);
        if (p >= 0) tmp.copy(WC[p]).invert().multiply(WC[k]); else tmp.copy(WC[k]);
        const o = (f * nb + k) * 4; Q[o] = Math.round(tmp.x * 32767); Q[o + 1] = Math.round(tmp.y * 32767); Q[o + 2] = Math.round(tmp.z * 32767); Q[o + 3] = Math.round(tmp.w * 32767);
      }
      for (let e = 0; e < 3; e++) HC[f * 3 + e] = H[f * 3 + e] * sc;
    }
    for (let f = 1; f < n; f++) for (let k = 0; k < nb; k++) { const a = (f * nb + k) * 4, b = ((f - 1) * nb + k) * 4; if (Q[a] * Q[b] + Q[a + 1] * Q[b + 1] + Q[a + 2] * Q[b + 2] + Q[a + 3] * Q[b + 3] < 0) for (let e = 0; e < 4; e++) Q[a + e] = -Q[a + e]; }
    out[ck] = { ...c, anim: [...Array(nb).keys()], Q, QS: Q.slice(0, nb * 4), HIP: HC };
  }
  return out;
}
// a walking/running clip carries the body forward: keep the bob and sway but take the travel out (we move the root)
function inPlace(c) {
  const H = c.HIP, n = c.n; if (n < 2) return c;
  const dx = (H[(n - 1) * 3] - H[0]) / (n - 1), dz = (H[(n - 1) * 3 + 2] - H[2]) / (n - 1);
  const speed = Math.hypot(dx, dz) * c.fps * 0.0094; // metres per second the clip was captured at
  const HIP = new Float32Array(H); for (let f = 0; f < n; f++) { HIP[f * 3] -= dx * f; HIP[f * 3 + 2] -= dz * f; }
  return { ...c, HIP, speed };
}
function buildFigure(D, id) {
  const T = THREE, nb = D.names.length, lt = b64(D.lt, Float32Array), inv = b64(D.inv, Float32Array);
  const bones = []; for (let k = 0; k < nb; k++) { const b = new T.Bone(); b.name = D.names[k]; b.position.set(lt[k * 3], lt[k * 3 + 1], lt[k * 3 + 2]); bones.push(b); if (D.parent[k] >= 0) bones[D.parent[k]].add(b); }
  const root = new T.Group(); root.add(bones[0]); root.scale.setScalar(0.0094);
  const invs = []; for (let k = 0; k < nb; k++) { const m = new T.Matrix4(); m.fromArray(inv, k * 16); m.transpose(); invs.push(m); }
  const M = D.mesh, n = M.n, pq = b64(M.p, Uint16Array), pos = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) { const a = i % 3; pos[i] = M.lo[a] + pq[i] / 65535 * (M.hi[a] - M.lo[a]); }
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3));
  g.setAttribute('normal', new T.BufferAttribute(b64(M.nr, Int8Array), 3, true));
  const uq = b64(M.uv, Uint16Array), uv = new Float32Array(n * 2); for (let i = 0; i < n * 2; i++) uv[i] = uq[i] / 65535; g.setAttribute('uv', new T.BufferAttribute(uv, 2));
  const si = b64(M.si, Uint8Array), si16 = new Uint16Array(si.length); si16.set(si); g.setAttribute('skinIndex', new T.BufferAttribute(si16, 4));
  g.setAttribute('skinWeight', new T.BufferAttribute(b64(M.sw, Uint8Array), 4, true));
  g.setIndex(new T.BufferAttribute(M.i32 ? b64(M.idx, Uint32Array) : b64(M.idx, Uint16Array), 1));
  const im = new Image(), map = new T.Texture(im); map.colorSpace = T.SRGBColorSpace; im.onload = () => { map.needsUpdate = true; }; im.src = D.tex.d;
  const mat = new T.MeshLambertMaterial({ map, alphaTest: D.alpha ? 0.5 : 0, side: D.alpha ? T.DoubleSide : T.FrontSide });
  mat.userData.terr = true; // the figure is placed on the ground in JS, not lifted per vertex
  const mesh = new T.SkinnedMesh(g, mat); mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.shadowSet = true; mesh.userData.terrBS = true;
  mesh.bind(new T.Skeleton(bones, invs), new T.Matrix4());
  const grp = new T.Group(); grp.add(root, mesh); grp.visible = false; scene.add(grp);
  const raw = id === 'boss' ? null : retarget(D), clips = {};
  for (const k in BOSS.clips) { const c = raw ? raw[k] : BOSS.clips[k]; const cc = { ...c, Q: c.Q || b64(c.q, Int16Array), QS: c.QS || b64(c.qs, Int16Array), HIP: c.HIP || b64(c.hip, Float32Array), na: c.anim.length }; clips[k] = /run|strut|walk|jog|strafe/.test(k) ? inPlace(cc) : cc; }
  return { grp, root, mesh, mat, bones, clips, nb, qa: new Float32Array(nb * 4), ha: [0, 0, 0], qb: new Float32Array(nb * 4), hb: [0, 0, 0], pv: new Float32Array(4) };
}
function posePlay(F, c, t, q, h) { // sample clip c at time t (seconds, looping) into q/h
  const L = (c.n - 1) / c.fps, tt = ((t % L) + L) % L, f = Math.min(c.n - 1, tt * c.fps), i0 = Math.floor(f), i1 = Math.min(c.n - 1, i0 + 1), a = f - i0;
  for (let k = 0; k < F.nb * 4; k++) q[k] = c.QS[k] / 32767;
  const v = F.pv;
  for (let j = 0; j < c.na; j++) {
    const k = c.anim[j], o0 = (i0 * c.na + j) * 4, o1 = (i1 * c.na + j) * 4; let l = 0;
    for (let e = 0; e < 4; e++) { v[e] = (c.Q[o0 + e] * (1 - a) + c.Q[o1 + e] * a) / 32767; l += v[e] * v[e]; }
    l = Math.sqrt(l) || 1; for (let e = 0; e < 4; e++) q[k * 4 + e] = v[e] / l;
  }
  for (let e = 0; e < 3; e++) h[e] = c.HIP[i0 * 3 + e] * (1 - a) + c.HIP[i1 * 3 + e] * a;
}
function poseBlend(F, qa, ha, qb, hb, w) {
  if (w <= 0) return; if (w >= 1) { qa.set(qb); ha[0] = hb[0]; ha[1] = hb[1]; ha[2] = hb[2]; return; }
  for (let k = 0; k < F.nb; k++) {
    let d = 0; for (let e = 0; e < 4; e++) d += qa[k * 4 + e] * qb[k * 4 + e]; const sg = d < 0 ? -1 : 1; let l = 0;
    for (let e = 0; e < 4; e++) { qa[k * 4 + e] = qa[k * 4 + e] * (1 - w) + qb[k * 4 + e] * sg * w; l += qa[k * 4 + e] ** 2; }
    l = Math.sqrt(l) || 1; for (let e = 0; e < 4; e++) qa[k * 4 + e] /= l;
  }
  for (let e = 0; e < 3; e++) ha[e] = ha[e] * (1 - w) + hb[e] * w;
}
// shared bodies for NPCs: one mesh, texture and set of clips per character; each person only gets a skeleton
const FIGS = {};
async function figAsset(id) {
  if (FIGS[id]) return FIGS[id];
  await loadCharFile('boss'); if (!BOSS.clips.walk) { const A = await loadCharFile('anims').catch(() => null); if (A) Object.assign(BOSS.clips, A); }
  const D = await loadCharFile(id); if (FIGS[id]) return FIGS[id];
  const F = buildFigure(D, id); scene.remove(F.grp);
  return (FIGS[id] = { D, geo: F.mesh.geometry, mat: F.mat, invs: F.mesh.skeleton.boneInverses, clips: F.clips, nb: F.nb, lt: b64(D.lt, Float32Array) });
}
function figInstance(id) {
  const A = FIGS[id], D = A.D, T = THREE, nb = A.nb, lt = A.lt;
  const bones = []; for (let k = 0; k < nb; k++) { const b = new T.Bone(); b.name = D.names[k]; b.position.set(lt[k * 3], lt[k * 3 + 1], lt[k * 3 + 2]); bones.push(b); if (D.parent[k] >= 0) bones[D.parent[k]].add(b); }
  const root = new T.Group(); root.add(bones[0]); root.scale.setScalar(0.0094);
  const mesh = new T.SkinnedMesh(A.geo, A.mat); mesh.frustumCulled = false; mesh.castShadow = !LOW; mesh.receiveShadow = true; mesh.userData.shadowSet = true; mesh.userData.terrBS = true;
  mesh.bind(new T.Skeleton(bones, A.invs), new T.Matrix4());
  const grp = new T.Group(); grp.add(root, mesh); grp.visible = false; scene.add(grp);
  return { grp, root, mesh, mat: A.mat, bones, clips: A.clips, nb, qa: new Float32Array(nb * 4), ha: [0, 0, 0], qb: new Float32Array(nb * 4), hb: [0, 0, 0], pv: new Float32Array(4), shared: true };
}
const ME = { fig: null, id: null, loading: null, t: 0, gait: 0, air: 0, car: null };
async function useCharacter(id) {
  if (ME.id === id && ME.fig) return ME.fig;
  if (ME.loading && ME.loading.id === id) return ME.loading.p;
  const p = (async () => {
    await loadCharFile('boss');
    if (!BOSS.clips.walk) { const A = await loadCharFile('anims').catch(() => null); if (A) Object.assign(BOSS.clips, A); }
    const D = await loadCharFile(id);
    const F = buildFigure(D, id);
    if (ME.fig) { scene.remove(ME.fig.grp); ME.fig.mesh.geometry.dispose(); ME.fig.mat.map.dispose(); ME.fig.mat.dispose(); }
    ME.fig = F; ME.id = id; F.grp.visible = S.mode === 'foot';
    return F;
  })();
  ME.loading = { id, p }; p.finally(() => { if (ME.loading && ME.loading.p === p) ME.loading = null; });
  return p;
}
// ── getting in and out ──
const PARKED = { x: 0, y: 0, z: 0, h: 0, pitch: 0, groll: 0 };
async function toggleFoot() {
  if (!started || paused) return;
  if (inside.on) { const a = inside.action(); if (a && a.label.startsWith('🚪')) inside.exit(); else toast('Walk to the front door to go outside'); return; }
  if (S.mode !== 'foot') {
    if (Math.hypot(S.vx, S.vz) > 4) { toast('Slow down to get out'); return; }
    if (ME.busy) return; ME.busy = true;
    const F = await useCharacter(settings.char || 'ch01').catch(() => null); ME.busy = false;
    if (S.mode === 'foot' || Math.hypot(S.vx, S.vz) > 4) return; // something else happened while the character loaded
    if (!F) { toast("Couldn't load your character"); return; }
    Object.assign(PARKED, { x: S.x, y: S.y, z: S.z, h: S.h, pitch: S.pitch, groll: S.groll });
    // step out on the driver's side (the car's left), clear of the door
    const lx = Math.cos(S.h), lz = -Math.sin(S.h);
    S.bh = S.br = S.bp = S.vib = 0; S.rumble = 0; S.scrub = 0;
    S.mode = 'foot'; S.x += lx * 1.7; S.z += lz * 1.7; S.vx = S.vz = 0; S.vy = 0; S.drift = 0; S.boosting = false; S.pitch = 0; S.groll = 0;
    F.grp.visible = true; document.body.classList.add('onfoot'); camInit = false;
  } else {
    if (police.doorState() !== 'car' && police.doorState() !== 'hot' && police.tryEnter()) return;
    if (Math.hypot(S.x - PARKED.x, S.z - PARKED.z) > 4 || Math.abs(S.y - PARKED.y) > 2) { toast('Walk up to your car to get in'); return; }
    S.mode = 'car'; Object.assign(S, { x: PARKED.x, y: PARKED.y, z: PARKED.z, h: PARKED.h, pitch: PARKED.pitch, groll: PARKED.groll, vx: 0, vz: 0, vy: 0, yawR: 0, vfPrev: 0 });
    if (ME.fig) ME.fig.grp.visible = false; document.body.classList.remove('onfoot'); camInit = false; ME.near = undefined;
  }
  sfx.door && sfx.door();
}
// ── walking, running, jumping ──
const FOOT = { jog: 4.6, sprint: 7.2, back: 1.3, turn: 2.8, jump: 4.6 };
function physicsFoot(dt) {
  const steer = input.right - input.left, fwd = input.up - input.down;
  S.h -= steer * FOOT.turn * dt * (fwd < 0 ? -1 : 1);
  const sprint = input.boost && fwd > 0, want = fwd > 0 ? (sprint ? FOOT.sprint : FOOT.jog) : fwd < 0 ? -FOOT.back : 0;
  const fx = Math.sin(S.h), fz = Math.cos(S.h);
  let v = S.vx * fx + S.vz * fz;
  const air = S.y > (S.groundH ?? 0) + 0.05;
  v += Math.max(-14 * dt, Math.min((air ? 3 : 12) * dt, want - v));
  S.vx = fx * v; S.vz = fz * v;
  const ox = S.x, oz = S.z;
  S.x += S.vx * dt; S.z += S.vz * dt;
  // ground: road decks and bridges where there are some, the terrain everywhere else
  const surf = surfaceAt(S.x, S.z, S.y + 0.6), g = surf ? surf.h : 0; S.groundH = g;
  if (input.brake && !air && !ME.jumpHeld) { S.vy = FOOT.jump; ME.jumpHeld = true; }
  if (!input.brake) ME.jumpHeld = false;
  if (S.y > g + 0.02 || S.vy > 0) { S.vy -= 18 * dt; S.y += S.vy * dt; if (S.y <= g) { S.y = g; if (S.vy < -9) bump(0.3); S.vy = 0; } }
  else if (g - S.y < 0.6) { S.y = g; S.vy = 0; } // steps and kerbs
  else { S.x = ox; S.z = oz; S.vx = S.vz = 0; } // too high to step up (a bridge deck from below)
  const hit = collideBuildings(S, 0.35, !surf);
  if (hit) { const vn = S.vx * hit.nx + S.vz * hit.nz; if (vn < 0) { S.vx -= vn * hit.nx; S.vz -= vn * hit.nz; } }
  // your parked car is solid too
  { const cx = Math.cos(PARKED.h), cz = -Math.sin(PARKED.h), fx2 = Math.sin(PARKED.h), fz2 = Math.cos(PARKED.h), rx = S.x - PARKED.x, rz = S.z - PARKED.z;
    const al = rx * fx2 + rz * fz2, sd = rx * cx + rz * cz, pa = 2.45 - Math.abs(al), ps = 1.25 - Math.abs(sd);
    if (pa > 0 && ps > 0 && Math.abs(S.y - PARKED.y) < 1.4) { if (ps < pa) { S.x += cx * Math.sign(sd || 1) * ps; S.z += cz * Math.sign(sd || 1) * ps; } else { S.x += fx2 * Math.sign(al || 1) * pa; S.z += fz2 * Math.sign(al || 1) * pa; } } }
  if (S.y < 3 + g) traffic.collide(S, true);
  if (S.x < MINX + 5 || S.x > MAXX - 5 || S.z < MINZ + 5 || S.z > MAXZ - 5) { S.x = Math.min(MAXX - 5, Math.max(MINX + 5, S.x)); S.z = Math.min(MAXZ - 5, Math.max(MINZ + 5, S.z)); }
  S.inTun = !!(surf && surf.road.tunnel && S.y < 3);
  const nr = surf || nearestRoad(S.x, S.z, 40);
  return { vf: v, nr, onRoad: !!surf, slide: 0 };
}
function animateFoot(dt) {
  const near = police.doorState();
  if (near !== ME.near) {
    ME.near = near; const dh = $('doorHint'); dh.classList.toggle('on', !!near);
    const what = { car: 'get in', hot: 'get back in', own: 'get in your own car', steal: 'steal this car', cop: 'steal the police car (★★★)' }[near] || 'get in';
    dh.querySelector('.kb').innerHTML = `Press <b>F</b> to ${what}`; dh.querySelector('.tc').textContent = `Tap the door button to ${what}`;
  }
  const F = ME.fig; if (!F) return;
  const v = S.vx * Math.sin(S.h) + S.vz * Math.cos(S.h), sp = Math.abs(v), air = S.y > (S.groundH ?? 0) + 0.15;
  const C = F.clips, walk = C.walk || C.strut, run = C.run || C.fastrun, sprint = C.fastrun || run;
  // gait: 0 idle → 1 walk → 2 run → 3 sprint; each clip plays at the rate that matches your speed so the feet don't slide
  const target = sp < 0.15 ? 0 : sp < 2.4 ? 1 : sp < 5.6 ? 2 : 3;
  ME.gait += (target - ME.gait) * Math.min(1, dt * 7);
  ME.t += dt;
  const ref = ME.gait > 2.5 ? sprint : ME.gait > 1.5 ? run : walk;
  ME.phase = (ME.phase || 0) + dt * (sp > 0.15 ? sp / Math.max(0.5, ref.speed || 1) : 1) * Math.sign(v || 1); // in cycles
  const cyc = c => ME.phase * ((c.n - 1) / c.fps);
  posePlay(F, C.idle, ME.t, F.qa, F.ha);
  if (ME.gait > 0.01) { posePlay(F, walk, cyc(walk), F.qb, F.hb); poseBlend(F, F.qa, F.ha, F.qb, F.hb, Math.min(1, ME.gait)); }
  if (ME.gait > 1.01) { posePlay(F, run, cyc(run), F.qb, F.hb); poseBlend(F, F.qa, F.ha, F.qb, F.hb, Math.min(1, ME.gait - 1)); }
  if (ME.gait > 2.01) { posePlay(F, sprint, cyc(sprint), F.qb, F.hb); poseBlend(F, F.qa, F.ha, F.qb, F.hb, Math.min(1, ME.gait - 2)); }
  // jump: the clip's airborne part (takeoff ~0.75 s, landing ~1.35 s) stretched over the time you're in the air
  if (air) ME.airT = (ME.airT || 0) + dt; else if (ME.airT) { ME.landT = 0.3; ME.airT = 0; }
  if (C.jump && (air || ME.landT > 0)) {
    const jt = air ? 0.72 + Math.min(1, ME.airT / 0.55) * 0.6 : 1.35 + (0.3 - ME.landT) * 0.8;
    posePlay(F, C.jump, jt, F.qb, F.hb); poseBlend(F, F.qa, F.ha, F.qb, F.hb, air ? Math.min(1, ME.airT * 8) : ME.landT / 0.3);
    if (!air) ME.landT -= dt;
  }
  const B = F.bones; for (let k = 0; k < F.nb; k++) B[k].quaternion.set(F.qa[k * 4], F.qa[k * 4 + 1], F.qa[k * 4 + 2], F.qa[k * 4 + 3]);
  B[0].position.set(F.ha[0], F.ha[1], F.ha[2]);
  F.root.position.set(S.x, S.y + terrainAt(S.x, S.z), S.z); F.root.rotation.set(0, S.h, 0);
}

// ───────────────────────── camera ─────────────────────────
const CAM_MODES = ['Chase', 'Far chase', 'Hood', 'Overhead'];
let camMode = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let camInit = false;
let boostE = 0, camHd = null, fovE = 62;
const shakeN = (t, s) => Math.sin(t * 13.1 + s) * 0.5 + Math.sin(t * 27.7 + s * 2.3) * 0.3 + Math.sin(t * 7.3 + s * 3.7) * 0.2;
function updateCamera(dt, vf) {
  const C = CARS[vType()] || CARS.sport;
  const spd = Math.hypot(S.vx, S.vz), sp = Math.min(1, spd / C.top);
  boostE += ((S.boosting ? 1 : 0) - boostE) * Math.min(1, dt * 3);
  // chase cams swing toward the direction of travel, so a drift shows the car sideways
  const foot = S.mode === 'foot';
  const vh = !foot && spd > 4 && vf > 0 ? Math.atan2(S.vx, S.vz) : S.h;
  const wantH = S.h + angDiff(vh, S.h) * 0.65;
  if (camHd === null || !camInit) camHd = wantH;
  camHd += angDiff(wantH, camHd) * Math.min(1, dt * 5);
  const fx = Math.sin(S.h), fz = Math.cos(S.h), cx = Math.sin(camHd), cz = Math.cos(camHd);
  let px, py, pz, lx, ly, lz;
  const lag = Math.max(-0.7, Math.min(0.9, S.aL * 0.045)); // camera hangs back under acceleration, closes in under braking
  if (foot && camMode !== 3) { const d = camMode === 1 ? 7 : camMode === 2 ? 2.2 : 4.3; px = S.x - cx * d; pz = S.z - cz * d; py = camMode === 1 ? 3.6 : 2.15; lx = S.x + cx * 4; lz = S.z + cz * 4; ly = 1.35; }
  else if (camMode === 0) { const big = vType() === 'bus' ? 2 : vType() === 'tow' ? 1.3 : 1, d = (7.4 + sp * 4 + boostE * 1.6 + lag) * big; px = S.x - cx * d; pz = S.z - cz * d; py = (3.0 + sp * 1.1) * (big > 1 ? big * 0.85 : 1); lx = S.x + cx * 6; lz = S.z + cz * 6; ly = 1.3; }
  else if (camMode === 1) { const d = 18 + sp * 7 + boostE * 2; px = S.x - cx * d; pz = S.z - cz * d; py = 8 + sp * 3; lx = S.x + cx * 10; lz = S.z + cz * 10; ly = 1; }
  else if (camMode === 2) { const bus = vType() === 'bus'; px = S.x + fx * (bus ? 5.2 : 0.6); pz = S.z + fz * (bus ? 5.2 : 0.6); py = bus ? 2.7 : 1.55; lx = S.x + fx * 30; lz = S.z + fz * 30; ly = 1.3 + S.bh + Math.tan(S.pitch + S.bp) * 30; }
  else { px = S.x - fx * 2; pz = S.z - fz * 2; py = 90 + sp * 60; lx = S.x + fx * 3; lz = S.z + fz * 3; ly = 0; }
  const tCar = terrainAt(S.x, S.z);
  py += S.y + tCar; ly += S.y + tCar;
  if (camMode !== 2 && camMode !== 3) py = Math.max(py, terrainAt(px, pz) + 1.8); // never inside a hillside
  if (S.inTun && camMode !== 2) { py = Math.min(py, S.y + tCar + 4.6); ly = Math.min(ly, S.y + tCar + 3); }
  const k = camMode === 2 ? 1 : 1 - Math.exp(-dt * (camMode === 3 ? 4 : 7));
  if (!camInit) { camPos.set(px, py, pz); camLook.set(lx, ly, lz); camInit = true; }
  camPos.x += (px - camPos.x) * k; camPos.y += (py - camPos.y) * k; camPos.z += (pz - camPos.z) * k;
  camLook.x += (lx - camLook.x) * k; camLook.y += (ly - camLook.y) * k; camLook.z += (lz - camLook.z) * k;
  camera.position.copy(camPos);
  // ride along a little with the body, plus road texture vibration
  const tv = performance.now() / 1000;
  camera.position.y += S.bh * (camMode === 2 ? 1 : 0.35) + shakeN(tv * 2.6, 7) * S.vib * 0.5;
  // trauma shake (squared, smooth noise); nitro keeps a light rumble going
  if (S.boosting) S.trauma = Math.max(S.trauma, 0.22);
  S.trauma = Math.max(0, S.trauma - dt);
  const amt = S.trauma * S.trauma, t = performance.now() / 1000;
  camera.position.x += shakeN(t, 1) * 0.3 * amt; camera.position.y += shakeN(t, 2) * 0.2 * amt;
  camera.lookAt(camLook);
  camera.rotation.z += shakeN(t, 3) * 0.035 * amt + (camMode === 2 ? S.br + S.groll : camMode === 3 ? 0 : S.br * 0.3);
  const wantFov = camMode === 3 ? 62 : 60 + 15 * sp + 10 * boostE;
  if (Math.abs(wantFov - fovE) > 0.05) { fovE += (wantFov - fovE) * Math.min(1, dt * 4); camera.fov = fovE; camera.updateProjectionMatrix(); }
  car.visible = camMode !== 2 || S.mode === 'foot';
  if (ME.fig) ME.fig.grp.visible = S.mode === 'foot' && camMode !== 2;
}

// ───────────────────────── game feel: smoke, sparks, skid marks, flames, speed lines, sound ─────────────────────────
const FXN = 220;
const fxGeo = new THREE.BufferGeometry();
const fxPos = new Float32Array(FXN * 3), fxSize = new Float32Array(FXN), fxAlpha = new Float32Array(FXN), fxCol = new Float32Array(FXN * 3);
fxGeo.setAttribute('position', new THREE.BufferAttribute(fxPos, 3)); fxGeo.setAttribute('aSize', new THREE.BufferAttribute(fxSize, 1));
fxGeo.setAttribute('aAlpha', new THREE.BufferAttribute(fxAlpha, 1)); fxGeo.setAttribute('aCol', new THREE.BufferAttribute(fxCol, 3));
const fxMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 400 }, ...TU }, transparent: true, depthWrite: false,
  vertexShader: TERR_GLSL + 'attribute float aSize; attribute float aAlpha; attribute vec3 aCol; varying float vA; varying vec3 vC; uniform float uScale; void main(){ vA=aAlpha; vC=aCol; vec4 w=modelMatrix*vec4(position,1.0); w.y+=terrH(w.xz); vec4 mv=viewMatrix*w; gl_PointSize=aSize*uScale/max(0.5,-mv.z); gl_Position=projectionMatrix*mv; }',
  fragmentShader: 'varying float vA; varying vec3 vC; void main(){ float d=length(gl_PointCoord-0.5); if(d>0.5) discard; gl_FragColor=vec4(vC, vA*(1.0-d*2.0)); }',
});
const fxPts = new THREE.Points(fxGeo, fxMat); fxPts.frustumCulled = false; scene.add(fxPts);
const fxP = Array.from({ length: FXN }, () => ({ life: 0, age: 1, x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, s0: 1, s1: 1, a0: 0, r: 1, g: 1, b: 1 }));
let fxNext = 0;
function emit(x, y, z, vx, vy, vz, life, s0, s1, a0, col) {
  const p = fxP[fxNext]; fxNext = (fxNext + 1) % FXN;
  Object.assign(p, { x, y, z, vx, vy, vz, life, age: 0, s0, s1, a0, r: col[0], g: col[1], b: col[2] });
}
// skid marks: ring buffer of quads on the road
const SKN = 600, skGeo = new THREE.BufferGeometry(), skPos = new Float32Array(SKN * 4 * 3), skIdx = new Uint16Array(SKN * 6);
for (let i = 0; i < SKN; i++) { const b = i * 4; skIdx.set([b, b + 2, b + 1, b, b + 3, b + 2], i * 6); }
skGeo.setAttribute('position', new THREE.BufferAttribute(skPos, 3)); skGeo.setIndex(new THREE.BufferAttribute(skIdx, 1));
const skMesh = new THREE.Mesh(skGeo, new THREE.MeshBasicMaterial({ color: '#141414', transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
skMesh.frustumCulled = false; skMesh.renderOrder = 2; scene.add(skMesh);
let skNext = 0; const skLast = [null, null];
function skidSeg(w, x, y, z, nx, nz) {
  const L = skLast[w]; skLast[w] = [x, y, z];
  if (!L || Math.hypot(x - L[0], z - L[2]) > 4) return;
  const hw = 0.15, o = skNext * 12; skNext = (skNext + 1) % SKN;
  skPos.set([L[0] + nx * hw, L[1], L[2] + nz * hw, L[0] - nx * hw, L[1], L[2] - nz * hw, x - nx * hw, y, z - nz * hw, x + nx * hw, y, z + nz * hw], o);
  skGeo.attributes.position.needsUpdate = true;
}
// nitro flames out of the exhausts
const flameG = new THREE.Group();
const flameMat = new THREE.MeshBasicMaterial({ color: '#8fd3ff', transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
const flameCore = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
for (const x of [-0.45, 0.45]) {
  const c = new THREE.ConeGeometry(0.16, 1, 10); c.rotateX(-Math.PI / 2); c.translate(0, 0, -0.5);
  const m = new THREE.Mesh(c, flameMat); m.position.set(x, 0.42, -2.36); flameG.add(m);
  const c2 = new THREE.ConeGeometry(0.08, 0.6, 8); c2.rotateX(-Math.PI / 2); c2.translate(0, 0, -0.3);
  const m2 = new THREE.Mesh(c2, flameCore); m2.position.set(x, 0.42, -2.36); flameG.add(m2);
}
flameG.visible = false;
// speed lines (2D overlay)
const slCan = document.createElement('canvas'); slCan.id = 'speedlines'; document.getElementById('c').after(slCan); // under the HUD
const slCtx = slCan.getContext('2d');
const slSeeds = Array.from({ length: 46 }, () => [Math.random() * Math.PI * 2, Math.random(), Math.random()]);
const SMOKE = [0.85, 0.85, 0.83], SPARK = [[1, 1, 1], [0.35, 0.75, 1], [1, 0.62, 0.15]];
function updateFx(dt, info) {
  const C = CARS[vType()] || CARS.sport;
  const spd = Math.hypot(S.vx, S.vz), fx = Math.sin(S.h), fz = Math.cos(S.h), lx = Math.cos(S.h), lz = -Math.sin(S.h);
  const slip = Math.abs(info.slide || 0), burnout = S.throttle > 0 && spd < 6 && input.brake;
  const sliding = !paused && S.mode !== 'foot' && S.y < 0.5 + (surfaceAt(S.x, S.z, S.y + 1)?.h || 0) && (S.drift || slip > 3.5 || burnout) && spd > 2;
  // rear wheels in world space (car local +x points to the car's left)
  for (let w = 0; w < 2; w++) {
    const side = w ? 0.9 : -0.9, x = S.x + lx * side - fx * 1.38, z = S.z + lz * side - fz * 1.38, y = S.y + 0.09;
    if (sliding) {
      skidSeg(w, x, S.y + 0.05, z, lx, lz);
      if (Math.random() < dt * 40) emit(x, y + 0.2, z, -S.vx * 0.1 + (Math.random() - 0.5), 0.8 + Math.random() * 0.6, -S.vz * 0.1 + (Math.random() - 0.5), 1.4, 0.9, 5, 0.5, SMOKE);
      const lvl = S.drift ? (S.charge >= 1.9 ? 2 : S.charge >= 0.9 ? 1 : 0) : -1;
      if (lvl >= 0 && Math.random() < dt * 30) emit(x, y + 0.1, z, (Math.random() - 0.5) * 3 - S.vx * 0.2, 1 + Math.random() * 2, (Math.random() - 0.5) * 3 - S.vz * 0.2, 0.25, 0.18, 0.05, 1, SPARK[lvl]);
    } else skLast[w] = null;
  }
  for (let i = 0; i < FXN; i++) {
    const p = fxP[i];
    if (p.age < p.life) { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vx *= 1 - dt; p.vz *= 1 - dt; }
    const f = Math.min(1, p.age / p.life);
    fxPos[i * 3] = p.x; fxPos[i * 3 + 1] = p.age < p.life ? p.y : -999; fxPos[i * 3 + 2] = p.z;
    fxSize[i] = p.s0 + (p.s1 - p.s0) * f; fxAlpha[i] = p.a0 * (1 - f); fxCol[i * 3] = p.r; fxCol[i * 3 + 1] = p.g; fxCol[i * 3 + 2] = p.b;
  }
  fxGeo.attributes.position.needsUpdate = fxGeo.attributes.aSize.needsUpdate = fxGeo.attributes.aAlpha.needsUpdate = fxGeo.attributes.aCol.needsUpdate = true;
  fxMat.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
  // flames
  if (flameG.parent !== car) car.add(flameG);
  flameG.visible = S.boosting && !paused;
  if (flameG.visible) { const s = 0.8 + Math.random() * 0.5 + (S.burst > 0 ? 0.3 : 0); for (const m of flameG.children) m.scale.set(1, 1, s); flameMat.color.set(S.burst > 0 && !input.boost ? '#ffb347' : '#8fd3ff'); }
  // speed lines at the edges of the screen above ~70% of top speed (and always on nitro)
  const k = Math.max(0, (spd / C.top - 0.7) / 0.3) * 0.5 + (S.boosting ? 0.6 : 0);
  if (slCan.width !== innerWidth || slCan.height !== innerHeight) { slCan.width = innerWidth; slCan.height = innerHeight; }
  slCtx.clearRect(0, 0, slCan.width, slCan.height);
  if (k > 0.02 && !paused && camMode !== 3) {
    const W = slCan.width, H = slCan.height, cx = W / 2, cy = H * 0.45, R = Math.hypot(W, H) / 2, t = performance.now() / 1000;
    slCtx.strokeStyle = `rgba(255,255,255,${Math.min(0.55, k * 0.5)})`; slCtx.lineWidth = 2;
    slCtx.beginPath();
    for (const [a, o, sp] of slSeeds) {
      const ph = (o + t * (1.5 + sp * 2.5)) % 1, r0 = R * (0.55 + ph * 0.45), r1 = r0 + R * (0.08 + 0.12 * k);
      slCtx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); slCtx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    }
    slCtx.stroke();
  }
  // spray off a wet road, powder off a snowy one
  if (!paused && S.mode !== 'foot' && spd > 9 && (WX.wet.value > 0.25 || WX.snow.value > 0.3) && S.y < 0.5 + (surfaceAt(S.x, S.z, S.y + 1)?.h || 0)) {
    const sn = WX.snow.value > WX.wet.value, col = sn ? [0.95, 0.96, 0.98] : [0.72, 0.75, 0.78];
    for (let w = 0; w < 2; w++) if (Math.random() < dt * 26 * Math.min(1, spd / 30)) {
      const side = w ? 0.9 : -0.9, x = S.x + lx * side - fx * 1.9, z = S.z + lz * side - fz * 1.9;
      emit(x, S.y + 0.3, z, S.vx * 0.35 + (Math.random() - 0.5) * 2, 0.6 + Math.random(), S.vz * 0.35 + (Math.random() - 0.5) * 2, 0.7, 0.6, 3.2, sn ? 0.35 : 0.22, col);
    }
  }
  // HUD: nitro meter + drift charge
  hud.nitro.style.width = (S.nitro * 100).toFixed(1) + '%';
  hud.nitroBox.classList.toggle('on', S.boosting);
  boostBtn && boostBtn.style.setProperty('--n', (S.nitro * 100).toFixed(0) + '%');
  const lvl = S.drift ? (S.charge >= 1.9 ? 2 : S.charge >= 0.9 ? 1 : 0) : -1;
  if (lvl !== hud.lastLvl) { hud.lastLvl = lvl; hud.drift.className = lvl < 0 ? '' : 'on l' + lvl; hud.drift.textContent = lvl < 0 ? '' : lvl === 2 ? 'DRIFT ●●' : lvl === 1 ? 'DRIFT ●' : 'DRIFT'; }
  sfx.update(dt, spd, sliding);
}
let tagTimer = 0;
function flashTag(txt) { hud.tag.textContent = txt; hud.tag.classList.add('on'); clearTimeout(tagTimer); tagTimer = setTimeout(() => hud.tag.classList.remove('on'), 900); }
const boostBtn = document.querySelector('[data-k="boost"]');
// ── sound: synthesized engine with fake gears, tire squeal, nitro whoosh, thuds ──
const sfx = (() => {
  let ac = null, eng = null, eng2 = null, lp = null, eg = null, sq = null, sqg = null, mg = null, rng = null, rb = null, rbg = null, rnl = null, wxg = null;
  const GEARS = [0, 9, 17, 26, 36, 48, 62, 90];
  function init() {
    if (ac || settings.sound === false) return;
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
    mg = ac.createGain(); mg.gain.value = 0.9; mg.connect(ac.destination);
    eng = ac.createOscillator(); eng.type = 'sawtooth'; eng2 = ac.createOscillator(); eng2.type = 'square';
    lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600; lp.Q.value = 4;
    eg = ac.createGain(); eg.gain.value = 0;
    const g2 = ac.createGain(); g2.gain.value = 0.45;
    eng.connect(lp); eng2.connect(g2); g2.connect(lp); lp.connect(eg); eg.connect(mg); eng.start(); eng2.start();
    const nb = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    sq = ac.createBufferSource(); sq.buffer = nb; sq.loop = true;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 6;
    sqg = ac.createGain(); sqg.gain.value = 0; sq.connect(bp); bp.connect(sqg); sqg.connect(mg); sq.start();
    // tyre/road roar (rises with speed, louder on concrete and grass) and the rumble-strip drone
    const rn = ac.createBufferSource(); rn.buffer = nb; rn.loop = true; rn.playbackRate.value = 0.7;
    rnl = ac.createBiquadFilter(); rnl.type = 'lowpass'; rnl.frequency.value = 380;
    rng = ac.createGain(); rng.gain.value = 0; rn.connect(rnl); rnl.connect(rng); rng.connect(mg); rn.start();
    rb = ac.createOscillator(); rb.type = 'square'; rb.frequency.value = 60;
    const rbl = ac.createBiquadFilter(); rbl.type = 'lowpass'; rbl.frequency.value = 300;
    rbg = ac.createGain(); rbg.gain.value = 0; rb.connect(rbl); rbl.connect(rbg); rbg.connect(mg); rb.start();
    // rain on the roof and the road
    const wn = ac.createBufferSource(); wn.buffer = nb; wn.loop = true; wn.playbackRate.value = 1.3;
    const wf = ac.createBiquadFilter(); wf.type = 'highpass'; wf.frequency.value = 1800;
    wxg = ac.createGain(); wxg.gain.value = 0; wn.connect(wf); wf.connect(wxg); wxg.connect(mg); wn.start();
  }
  function noiseBurst(dur, f0, f1, vol) {
    if (!ac) return;
    const len = Math.floor(ac.sampleRate * dur), b = ac.createBuffer(1, len, ac.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = ac.createBufferSource(); s.buffer = b; const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(f0, ac.currentTime); f.frequency.exponentialRampToValueAtTime(f1, ac.currentTime + dur);
    const g = ac.createGain(); g.gain.value = vol; s.connect(f); f.connect(g); g.connect(mg); s.start();
  }
  return {
    init,
    pause(on) { if (!ac) return; on ? ac.suspend() : ac.resume(); },
    setOn(on) { if (on) { init(); if (ac) ac.resume(); } else if (ac) ac.suspend(); },
    whoosh() { noiseBurst(0.7, 500, 3500, 0.5); },
    shot(k = 1) { noiseBurst(0.16, 3200, 200, 0.9 * k); noiseBurst(0.35, 600, 80, 0.5 * k); },
    siren(v) { // police siren: a wailing tone, louder as the nearest chasing cruiser closes in
      if (!ac) return;
      if (!this._sir) { const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = 900; const lfo = ac.createOscillator(); lfo.frequency.value = 0.35; const lg = ac.createGain(); lg.gain.value = 380; lfo.connect(lg); lg.connect(o.frequency); const g = ac.createGain(); g.gain.value = 0; o.connect(g); g.connect(mg); o.start(); lfo.start(); this._sir = g; }
      this._sir.gain.setTargetAtTime(paused ? 0 : v * 0.06, ac.currentTime, 0.2);
    },
    thud(k) { noiseBurst(0.25, 300, 60, 0.4 + k * 0.6); },
    joint(k) { noiseBurst(0.06, 240, 80, 0.12 + k * 0.18); },
    update(dt, spd, sliding) {
      if (!ac) return;
      if (paused) { for (const g of [eg, sqg, rng, rbg, wxg]) g.gain.setTargetAtTime(0, ac.currentTime, 0.05); return; }
      let g = 1; while (g < GEARS.length - 1 && spd > GEARS[g]) g++;
      const lo = GEARS[g - 1], hi = GEARS[g], r = Math.max(0, Math.min(1, (spd - lo) / (hi - lo)));
      const rpm = 900 + r * 5600 + (S.throttle > 0 ? 400 : 0) + (S.boosting ? 600 : 0);
      const f = rpm / 60 * 2, now = ac.currentTime;
      eng.frequency.setTargetAtTime(f, now, 0.05); eng2.frequency.setTargetAtTime(f / 2, now, 0.05);
      lp.frequency.setTargetAtTime(500 + rpm * 0.35 + (S.throttle > 0 ? 500 : 0), now, 0.08);
      eg.gain.setTargetAtTime(S.mode === 'foot' ? 0 : 0.05 + (S.throttle > 0 ? 0.05 : 0) + Math.min(0.04, spd / 1500), now, 0.1);
      sqg.gain.setTargetAtTime(sliding ? 0.09 : S.scrub > 0.15 ? 0.025 + 0.05 * S.scrub : 0, now, 0.06);
      rng.gain.setTargetAtTime(Math.min(0.13, spd / 380) * S.surfK * (1 + 0.6 * WX.wet.value) * (1 - 0.5 * WX.snow.value), now, 0.1);
      wxg.gain.setTargetAtTime(0.07 * WX.precip * (1 - WX.snowing), now, 0.3);
      rnl.frequency.setTargetAtTime(260 + spd * 6, now, 0.1);
      rb.frequency.setTargetAtTime(Math.max(20, spd / 0.3), now, 0.05);
      rbg.gain.setTargetAtTime(S.rumble ? 0.07 * S.rumble : 0, now, 0.03);
    },
  };
})();

// ───────────────────────── AI traffic (and a road-network inspector riding along) ─────────────────────────
// Cars follow the real street graph: lanes on the right, speed limits, turns that slow them down,
// red lights and stop signs, a safe gap to whoever is ahead (you included). Whatever trips them up —
// dead ends on main roads, one-way traps, gaps, cliffs, gridlock — is logged as a road issue.
const traffic = (() => {
  const keyOf = (x, z) => Math.round(x * 2) + ',' + Math.round(z * 2);
  const reg = new Map();   // geometry key → { road, tiles:Set }
  const nodes = new Map(); // vertex key → [{ road, i }]
  const sigGrid = new Map(); // cell → [{ type, x, z, all, tile }]
  const cars = [];
  const CLASS_SPEED = [29, 25, 20, 18, 15, 12, 11, 7, 18, 18, 15, 13, 12, 6];
  const COLORS = ['#e8e8e8', '#1b1d22', '#8a8f96', '#b5b9be', '#2c4a7a', '#7a1f1f', '#1f4a33', '#c9c2b0', '#3a3f45', '#5b6e8c', '#9e2b25', '#f2f2ee'];
  const MAXN = 110;
  // one low-poly sedan shape, painted per car; wheels, glass and lamps share instanced meshes
  const merge = geos => { // position+normal geometries → one indexed geometry
    const pos = [], nor = [], idx = []; let off = 0;
    for (const g of geos) { const p = g.attributes.position, n = g.attributes.normal; for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); } if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + off); else for (let i = 0; i < p.count; i++) idx.push(i + off); off += p.count; }
    const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); out.setIndex(idx); return out;
  };
  const bodyGeo = extrudeAcross([[-2.2, 0.32], [2.2, 0.32], [2.26, 0.62], [1.25, 0.82], [-1.85, 0.86], [-2.22, 0.7]], 1.82, 0.05);
  const cabGeo = extrudeAcross([[1.1, 0.8], [0.35, 1.34], [-1.0, 1.37], [-1.62, 0.86]], 1.62, 0.04);
  const wheelGeo = merge([[-0.85, 1.35], [0.85, 1.35], [-0.85, -1.35], [0.85, -1.35]].map(([x, z]) => { const c = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 10); c.rotateZ(Math.PI / 2); c.translate(x, 0.34, z); return c; }));
  const lampGeo = merge([new THREE.BoxGeometry(1.5, 0.1, 0.05).translate(0, 0.72, -2.22)]);
  const headGeo = merge([-0.6, 0.6].map(x => new THREE.BoxGeometry(0.42, 0.1, 0.05).translate(x, 0.6, 2.25)));
  const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshPhongMaterial({ shininess: 60, specular: '#444' }), MAXN);
  const cabs = new THREE.InstancedMesh(cabGeo, new THREE.MeshPhongMaterial({ color: '#1e2630', shininess: 100, specular: '#889' }), MAXN);
  const wheels = new THREE.InstancedMesh(wheelGeo, new THREE.MeshLambertMaterial({ color: '#16181b' }), MAXN);
  const lights = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: '#ffffff' }), MAXN); // tinted per car: dim red, bright when braking
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshBasicMaterial({ color: '#f4f7ff' }), MAXN);
  const parts = [bodies, cabs, wheels, lights, heads];
  for (const m of parts) { m.count = 0; m.frustumCulled = false; scene.add(m); }
  // turn signals: amber lamps at the corners, one mesh per side (hidden instances get a zero-scale matrix)
  const blinkGeo = x => merge([new THREE.BoxGeometry(0.3, 0.13, 0.08).translate(x, 0.6, 2.25), new THREE.BoxGeometry(0.3, 0.14, 0.08).translate(x, 0.6, -2.25), new THREE.BoxGeometry(0.05, 0.08, 0.22).translate(x > 0 ? 0.92 : -0.92, 0.62, 1.8)]);
  const blinkMat = new THREE.MeshBasicMaterial({ color: '#ffa21a' });
  const blinkL = new THREE.InstancedMesh(blinkGeo(0.8), blinkMat, MAXN), blinkR = new THREE.InstancedMesh(blinkGeo(-0.8), blinkMat, MAXN); // car local +x is its left
  for (const m of [blinkL, blinkR]) { m.count = 0; m.frustumCulled = false; scene.add(m); }
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  // police: a light bar on the roof (red and blue halves, flashing in a chase) and a dark door stripe
  const barR = new THREE.InstancedMesh(merge([new THREE.BoxGeometry(0.62, 0.14, 0.3).translate(0.33, 1.44, -0.3)]), new THREE.MeshBasicMaterial({ color: '#ff2a2a' }), MAXN);
  const barB = new THREE.InstancedMesh(merge([new THREE.BoxGeometry(0.62, 0.14, 0.3).translate(-0.33, 1.44, -0.3)]), new THREE.MeshBasicMaterial({ color: '#2a5bff' }), MAXN);
  const stripe = new THREE.InstancedMesh(merge([new THREE.BoxGeometry(1.86, 0.22, 2.4).translate(0, 0.5, -0.1)]), new THREE.MeshLambertMaterial({ color: '#15243f' }), MAXN);
  for (const m of [barR, barB, stripe]) { m.count = 0; m.frustumCulled = false; scene.add(m); }
  const beams = new THREE.InstancedMesh(beamGeo, beamMat, MAXN); beams.count = 0; beams.frustumCulled = false; beams.renderOrder = 2; scene.add(beams);
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(1, 1, 1), tmpP = new THREE.Vector3(), col = new THREE.Color();
  // ── road issues the cars discover ──
  const issues = new Map(); let unsent = [];
  function issue(kind, x, z, info) {
    const k = kind + ':' + Math.round(x / 15) + ':' + Math.round(z / 15);
    let it = issues.get(k);
    if (!it) { it = { kind, x: Math.round(x), z: Math.round(z), n: 0, info }; issues.set(k, it); unsent.push(it); }
    it.n++;
  }
  setInterval(() => {
    if (!unsent.length) return;
    const batch = unsent.splice(0, 100).map(it => { const [lat, lon] = unproj(it.x, it.z); return { kind: it.kind, lat: +lat.toFixed(6), lon: +lon.toFixed(6), info: String(it.info || '').slice(0, 200) }; });
    if (!STATIC) fetch(`${API}/roadissues`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issues: batch }) }).catch(() => {});
  }, 30000);
  // ── road graph bookkeeping ──
  const roadKey = r => r.pts.length + ':' + r.pts[0] + ',' + r.pts[1] + ':' + r.pts[r.pts.length - 2] + ',' + r.pts[r.pts.length - 1];
  function addRoads(t) {
    for (const r of t.roads) {
      if (r.c > 13) continue;
      const k = roadKey(r); let e = reg.get(k);
      if (e) { e.tiles.add(t.key); continue; }
      reg.set(k, { road: r, tiles: new Set([t.key]) }); r.tkey = k;
      const p = r.pts; for (let i = 0; i < p.length / 2; i++) { const nk = keyOf(p[i * 2], p[i * 2 + 1]); let a = nodes.get(nk); if (!a) nodes.set(nk, a = []); a.push({ road: r, i }); }
    }
  }
  function removeTile(t) {
    for (const [k, e] of reg) {
      if (!e.tiles.delete(t.key) || e.tiles.size) continue;
      reg.delete(k);
      const p = e.road.pts;
      for (let i = 0; i < p.length / 2; i++) { const nk = keyOf(p[i * 2], p[i * 2 + 1]), a = nodes.get(nk); if (!a) continue; const j = a.findIndex(o => o.road === e.road); if (j >= 0) a.splice(j, 1); if (!a.length) nodes.delete(nk); }
      for (const c of cars) if (c.road === e.road || (c.next && c.next.road === e.road)) c.dead = true;
    }
    for (const [ck2, a] of sigGrid) { const b = a.filter(s => s.tile !== t.key); if (b.length) sigGrid.set(ck2, b); else sigGrid.delete(ck2); }
  }
  function setSignals(t, list) {
    for (const [ck2, a] of sigGrid) { const b = a.filter(s => s.tile !== t.key); if (b.length !== a.length) b.length ? sigGrid.set(ck2, b) : sigGrid.delete(ck2); }
    for (const [type, x, z, all] of list || []) { const k = ck(Math.floor(x / CELL), Math.floor(z / CELL)); let a = sigGrid.get(k); if (!a) sigGrid.set(k, a = []); a.push({ type, x, z, all, tile: t.key }); }
  }
  const signalNear = (x, z, R) => { let best = null, bd = R; const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const s of sigGrid.get(ck(gx + i, gz + j)) || []) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; best = s; } } return best; };
  const lightState = (dx, dz) => { // same timing as the lamps: 0 red, 1 yellow, 2 green
    const ang = (Math.atan2(dz, dx) * 180 / Math.PI + 405) % 180, ph = ang < 90 ? 0 : 1, c = (performance.now() / 1000) % 30;
    return ph === 0 ? (c < 12 ? 2 : c < 15 ? 1 : 0) : (c < 15 ? 0 : c < 27 ? 2 : 1);
  };
  // ── a car's position on the graph: road, segment s, direction (+1 along the way's points, -1 against) ──
  const segEnds = (road, s, dir) => { const p = road.pts; const a = dir > 0 ? s : s + 1, b = dir > 0 ? s + 1 : s; return [p[a * 2], p[a * 2 + 1], p[b * 2], p[b * 2 + 1], a, b]; };
  const hAt = (road, i) => (road.hs ? road.hs[i] || 0 : 0);
  // lanes per direction, and a lane's centre measured from the way's centreline (+ = right of travel)
  function lanesOf(road) {
    const sp = road.spec; if (!sp || sp.kind === 'minor') return 1;
    return road.oneway ? sp.lanes : Math.max(1, Math.floor(sp.lanes / 2));
  }
  function laneOffset(road, lane) {
    const sp = road.spec, n = lanesOf(road);
    if (!sp || sp.kind === 'minor') return Math.min(2.1, road.w / 4);
    if (road.oneway) return (sp.shL - sp.shR) / 2 + (lane - (n - 1) / 2) * sp.laneW;
    const gap = sp.lanes >= 3 && sp.lanes % 2 === 1 ? sp.laneW / 2 : 0; // centre turn lane
    return gap + sp.laneW * (lane + 0.5);
  }
  // options for leaving vertex v of road (arrived travelling dir)
  function options(road, v, dx, dz, svc) {
    const p = road.pts, n = p.length / 2, out = [];
    const add = (r, s, dir) => {
      if (r.c === 13 && road.c !== 13 && !svc) return; // stay off driveways/parking aisles (unless that's the only way on)
      const [ax, az, bx, bz] = segEnds(r, s, dir), L = Math.hypot(bx - ax, bz - az) || 1, ex = (bx - ax) / L, ez = (bz - az) / L;
      const dot = ex * dx + ez * dz; if (dot < -0.92) return; // no U-turns
      out.push({ road: r, s, dir, dot });
    };
    for (const o of nodes.get(keyOf(p[v * 2], p[v * 2 + 1])) || [{ road, i: v }]) {
      const r = o.road, m = r.pts.length / 2;
      if (o.i < m - 1) add(r, o.i, 1);
      if (o.i > 0 && !r.oneway) add(r, o.i - 1, -1);
    }
    return out;
  }
  function pick(opts, prevRoad) {
    let tot = 0; const w = opts.map(o => { const k = Math.pow(1 + o.dot, 2) * (o.road === prevRoad ? 1.6 : 1) * (o.road.c <= 4 ? 1.3 : 1) + 0.05; tot += k; return k; });
    let r = Math.random() * tot; for (let i = 0; i < opts.length; i++) { r -= w[i]; if (r <= 0) return opts[i]; } return opts[opts.length - 1];
  }
  function chooseNext(c) {
    const [, , bx, bz, , b] = segEnds(c.road, c.s, c.dir), [ax, az] = segEnds(c.road, c.s, c.dir);
    const L = Math.hypot(bx - ax, bz - az) || 1, dx = (bx - ax) / L, dz = (bz - az) / L;
    if (c.chase) { // pursuit: take whichever way heads most directly at the player (U-turns allowed)
      const tx = S.x - bx, tz = S.z - bz, tl = Math.hypot(tx, tz) || 1;
      const all = [...options(c.road, b, dx, dz, true)];
      if (!c.road.oneway) all.push({ road: c.road, s: c.s, dir: -c.dir, dot: -1, uturn: true });
      let best = null, bs = -9;
      for (const o of all) { const [oax, oaz, obx, obz] = segEnds(o.road, o.s, o.dir), ol = Math.hypot(obx - oax, obz - oaz) || 1; const sc = ((obx - oax) * tx + (obz - oaz) * tz) / ol / tl + (o.road.c <= 4 ? 0.08 : 0) - (o.uturn ? 0.25 : 0); if (sc > bs) { bs = sc; best = o; } }
      if (best) return best;
    }
    let opts = options(c.road, b, dx, dz);
    if (!opts.length) opts = options(c.road, b, dx, dz, true); // the only way on is a service road / parking ramp (e.g. the ABC ramps)
    if (!opts.length) {
      const n = c.road.pts.length / 2, atEnd = b === 0 || b === n - 1;
      // a road that stops a few metres short of another one: a mapping gap — hop across it
      if (atEnd) {
        const t = tiles.get(tileOf(bx, bz).join(','));
        const nr = t && nearestNodeNear(bx, bz, 5, c.road);
        if (nr && nr.d > 0.4) { issue('gap', bx, bz, `${c.road.name || ROAD_NAMES[c.road.c] || ''} stops ${nr.d.toFixed(1)} m short of ${nr.road.name || ROAD_NAMES[nr.road.c] || 'a road'}`); opts = options(nr.road, nr.i, dx, dz); }
      }
      if (!opts.length) {
        if (allLoadedAround(bx, bz)) {
          if (c.road.oneway) issue('oneway_trap', bx, bz, `one-way ${c.road.name || ROAD_NAMES[c.road.c] || ''} leads nowhere`);
          else if (c.road.c <= 4 || (c.road.c >= 8 && c.road.c <= 12)) issue('dead_end', bx, bz, `${c.road.name || ROAD_NAMES[c.road.c] || ''} dead-ends`);
        }
        if (!c.road.oneway) return { road: c.road, s: c.s, dir: -c.dir, dot: -1, uturn: true };
        return null;
      }
    }
    return pick(opts, c.road);
  }
  function nearestNodeNear(x, z, R, not) { // nearest graph vertex of another road within R metres (half-metre key grid)
    let best = null; const kx = Math.round(x * 2), kz = Math.round(z * 2);
    for (let i = -R * 2; i <= R * 2; i++) for (let j = -R * 2; j <= R * 2; j++) {
      const a = nodes.get((kx + i) + ',' + (kz + j)); if (!a) continue;
      for (const o of a) { if (o.road === not) continue; const d = Math.hypot(i, j) / 2; if (d <= R && (!best || d < best.d)) best = { road: o.road, i: o.i, d }; }
    }
    return best;
  }
  function allLoadedAround(x, z) {
    const [tx, ty] = tileOf(x, z);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const tt = tiles.get((tx + i) + ',' + (ty + j)); if ((tx + i) >= 0 && (ty + j) >= 0 && (tx + i) < NX && (ty + j) < NY && !(tt && tt.state.r === 2)) return false; }
    return true;
  }
  // ── spawning: busy roads get most of the cars (weighted by length × lanes × how busy that class of road is) ──
  const SPAWN_W = [3, 3, 2.2, 1.8, 1.4, 0.6, 0.35, 0.12, 1, 1, 0.8, 0.6, 0.5];
  function pickRoad(t) {
    if (!t._sw || t._sw.n !== t.roads.length) {
      const cum = []; let tot = 0;
      for (const r of t.roads) {
        let L = 0; const p = r.pts;
        if (r.c < 13) for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
        tot += r.c < 13 ? L * (SPAWN_W[r.c] || 0) * lanesOf(r) : 0; cum.push(tot);
      }
      t._sw = { n: t.roads.length, cum, tot };
    }
    const w = t._sw; if (!w.tot) return null;
    const x = Math.random() * w.tot; let lo = 0, hi = w.cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (w.cum[m] < x) lo = m + 1; else hi = m; }
    return t.roads[lo];
  }
  function spawn(px, pz, minD, maxD, opt) {
    // the player's own tile and its neighbours; when moving fast, fill the road ahead first
    const [tx, ty] = tileOf(px, pz), near = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const t = tiles.get((tx + i) + ',' + (ty + j)); if (t && t.state.r === 2 && t.roads.length) near.push(t); }
    if (!near.length) return;
    const home = tiles.get(tx + ',' + ty), sp = Math.hypot(S.vx, S.vz), hx = S.vx / (sp || 1), hz = S.vz / (sp || 1);
    for (let tries = 0; tries < 25; tries++) {
      const t = home && home.roads.length && Math.random() < 0.55 ? home : near[(Math.random() * near.length) | 0], r = pickRoad(t);
      if (!r || r.c >= 13 || r.tunnel && Math.random() < 0.5 || !reg.has(r.tkey)) continue;
      const n = r.pts.length / 2; if (n < 2) continue;
      const s = (Math.random() * (n - 1)) | 0, dir = r.oneway ? 1 : (Math.random() < 0.5 ? 1 : -1);
      const [ax, az, bx, bz] = segEnds(r, s, dir), L = Math.hypot(bx - ax, bz - az); if (L < 3) continue;
      const u = Math.random() * L, x = ax + (bx - ax) * u / L, z = az + (bz - az) * u / L;
      const d = Math.hypot(x - px, z - pz); if (d < minD || d > maxD) continue;
      if (sp > 12 && (x - px) * hx + (z - pz) * hz < 0 && Math.random() < 0.75) continue; // mostly ahead of you
      if (cars.some(o => Math.hypot(o.x - x, o.z - z) < 12)) continue;
      const lane = (Math.random() * lanesOf(r)) | 0;
      // driver personality: most are calm, a few are in a hurry (faster, quicker off the line, follow closer, pass more)
      const agg = Math.pow(Math.random(), 1.4);
      const c = { road: r, s, dir, u, L, lane, off: laneOffset(r, lane), x, z, y: 0, h: Math.atan2(bx - ax, bz - az), v: 0, color: COLORS[(Math.random() * COLORS.length) | 0], next: null, stopT: 0, stoppedAt: null, hitT: 0, jam: 0,
        agg, k: 0.93 + agg * 0.2, acc: 1.8 + agg * 1.7, hw: 1.7 - agg * 0.75, sig: 0, sigT: 0, lcT: 2 + Math.random() * 5, dT: Math.random() * 0.5, lc: false, latV: 0, brake: false, seed: Math.random(),
        tall: Math.random() < 0.3 ? 1.22 : 1, len: 0.94 + Math.random() * 0.14 };
      c.v = Math.min(CLASS_SPEED[r.c] || 11, r.ms ? r.ms * 0.447 : 99) * 0.7;
      if (opt) Object.assign(c, opt); else if (LIFE_ON() && Math.random() < 0.035) c.cop = true; // a few patrol cars
      if (c.cop) { c.color = '#f4f4f2'; c.tall = 1; c.len = 1.04; }
      cars.push(c); return c;
    }
  }
  // the coming turn: +1 right, -1 left, 0 straight on
  function turnOf(c, dx, dz) {
    if (c.next.uturn) return -1;
    const [nax, naz, nbx, nbz] = segEnds(c.next.road, c.next.s, c.next.dir), nL = Math.hypot(nbx - nax, nbz - naz) || 1;
    const ndx = (nbx - nax) / nL, ndz = (nbz - naz) / nL;
    if (dx * ndx + dz * ndz > 0.94) return 0;
    return dx * ndz - dz * ndx > 0 ? 1 : -1; // right of travel is (-dz, dx)
  }
  // soonest arrival (s) at node (nx,nz) of any car — or the player — heading into it that sel(hx,hz) accepts
  function approaching(c, nx, nz, sel) {
    let best = 1e9;
    const test = (x, z, hx, hz, v, y) => {
      const rx = nx - x, rz = nz - z, d = Math.hypot(rx, rz); if (d > 60 || d < 1.5 || Math.abs(y - c.y) > 3) return;
      if ((rx * hx + rz * hz) / d < 0.6 || !sel(hx, hz)) return;
      const eta = d / Math.max(v, 0.5); if (eta < best) best = eta;
    };
    for (const o of cars) if (o !== c && o.v > 0.5) test(o.x, o.z, Math.sin(o.h), Math.cos(o.h), o.v, o.y);
    const ps = Math.hypot(S.vx, S.vz); if (ps > 1) test(S.x, S.z, S.vx / ps, S.vz / ps, ps, S.y);
    return best;
  }
  // move one lane over if there's room (and, when passing, if that lane is actually moving faster)
  function tryLane(c, lane, needV) {
    const n = lanesOf(c.road); if (lane < 0 || lane >= n || lane === c.lane) return false;
    const dOff = laneOffset(c.road, lane) - c.off, fx = Math.sin(c.h), fz = Math.cos(c.h);
    let ahead = 1e9, aheadV = 99;
    const clear = (x, z, h, v, y) => {
      if (Math.abs(y - c.y) > 3 || Math.sin(h) * fx + Math.cos(h) * fz < 0.7) return true;
      const rx = x - c.x, rz = z - c.z, along = rx * fx + rz * fz, lat = -rx * fz + rz * fx; // lat: + is our right
      if (Math.abs(lat - dOff) > 2.4) return true;
      if (along > -(9 + Math.max(0, v - c.v) * 2.5) && along < 9 + Math.max(0, c.v - v) * 1.2) return false;
      if (along > 0 && along < ahead) { ahead = along; aheadV = v; }
      return true;
    };
    for (const o of cars) if (o !== c && !clear(o.x, o.z, o.h, o.v, o.y)) return false;
    if (!clear(S.x, S.z, S.h, Math.hypot(S.vx, S.vz), S.y)) return false;
    if (needV !== undefined && ahead < 70 && aheadV < needV) return false;
    c.lane = lane; c.lc = true; c.sig = Math.sign(dOff) || 1; c.sigT = 3.2; c.lcT = 4 + Math.random() * 6 - c.agg * 3;
    return true;
  }
  // ── per-frame driving ──
  function update(dt) {
    const want = [0, 35, 60, 95][settings.traffic ?? 2] || 0;
    for (let i = cars.length - 1; i >= 0; i--) { const c = cars[i]; if (c.dead || Math.hypot(c.x - S.x, c.z - S.z) > 420) cars.splice(i, 1); }
    for (let k = 0; k < 4 && cars.length < want; k++) spawn(S.x, S.z, cars.length < want / 2 ? 50 : 90, 320);
    for (let i = cars.length - 1; i >= 0 && cars.length > want; i--) if (!cars[i].chase) cars.splice(i, 1);
    for (const c of cars) {
      if (c.chase && !c.free && Math.hypot(S.x - c.x, S.z - c.z) < 26 && Math.abs(S.y - c.y) < 3) c.free = true;
      if (c.free) { // off the lane graph: drive straight at the player to box them in
        const dxp = S.x - c.x, dzp = S.z - c.z, d = Math.hypot(dxp, dzp);
        if (!c.chase || d > 70) { c.dead = true; continue; }
        const th = Math.atan2(dxp, dzp); c.h += angDiff(th, c.h) * Math.min(1, dt * 3);
        const ps = Math.hypot(S.vx, S.vz), tv = d < 7 ? Math.max(0, ps - 1) : Math.min(32, ps + 8);
        c.v += Math.max(-10 * dt, Math.min(7 * dt, tv - c.v));
        const nx = c.x + Math.sin(c.h) * c.v * dt, nz = c.z + Math.cos(c.h) * c.v * dt;
        const P = { x: nx, z: nz, y: 0 }; collideBuildings(P, 2); c.x = P.x; c.z = P.z;
        c.y += (S.y - c.y) * Math.min(1, dt * 3); c.pitch = 0; c.brake = tv < c.v; c.sig = 0;
        continue;
      }
      const [ax, az, bx, bz, , ib] = segEnds(c.road, c.s, c.dir);
      c.L = Math.hypot(bx - ax, bz - az) || 0.01;
      const dx = (bx - ax) / c.L, dz = (bz - az) / c.L;
      if (!c.next) c.next = chooseNext(c);
      if (!c.next) { c.dead = true; continue; }
      // target speed: limit, upcoming turn, lights / stop signs, the car (or player) ahead
      const limit = (c.road.ms ? Math.min(c.road.ms * 0.447 * 1.05, 34) : CLASS_SPEED[c.road.c] || 11) * c.k * (1 - 0.1 * WX.wet.value - 0.28 * WX.snow.value);
      let target = c.chase ? Math.max(limit * 1.5, 24) : limit, rem = c.L - c.u;
      const [nax, naz, nbx, nbz] = segEnds(c.next.road, c.next.s, c.next.dir), nL = Math.hypot(nbx - nax, nbz - naz) || 1;
      const ndot = ((nbx - nax) * dx + (nbz - naz) * dz) / nL;
      if (ndot < 0.9) target = Math.min(target, Math.max(Math.sqrt(Math.max(0, 2 * 3 * rem)) + (c.next.uturn ? 2 : 4 + 9 * Math.max(0, ndot)), 0));
      const turn = turnOf(c, dx, dz), newRoad = c.next.road !== c.road;
      const oncoming = (hx, hz) => hx * dx + hz * dz < -0.7, cross = (hx, hz) => Math.abs(hx * dx + hz * dz) < 0.75;
      let sg = null;
      if (rem < 60 && !c.chase) sg = signalNear(bx, bz, 14);
      if (rem < 45 && sg) {
        if (sg.type === 0) {
          const st = lightState(dx, dz), stopAt = rem - 9;
          let hold = (st === 0 || (st === 1 && stopAt > c.v * 1.2)) && stopAt > -2;
          // turning left on a green: wait at the line for a gap in oncoming traffic
          if (!hold && turn < 0 && stopAt > -1.5 && approaching(c, bx, bz, oncoming) < 4.5 - c.agg) hold = true;
          if (hold) target = Math.min(target, Math.sqrt(Math.max(0, 2 * 4 * Math.max(0, stopAt - 1))));
        } else if (sg.type === 1) {
          const key = keyOf(bx, bz), here = nodes.get(key) || [], mc = Math.max(...here.map(o => o.road.c)), minor = sg.all || c.road.c >= mc || here.length < 2;
          if (minor) {
            const stopAt = rem - 5;
            if (c.stoppedAt !== key) {
              target = Math.min(target, Math.sqrt(Math.max(0, 2 * 4 * Math.max(0, stopAt))));
              if (stopAt < 1.5 && c.v < 0.6) { c.stopT += dt; if (c.stopT > 1.2) { c.stoppedAt = key; c.stopT = 0; } }
            } else if (stopAt > -1 && approaching(c, bx, bz, (hx, hz) => cross(hx, hz) || (turn < 0 && oncoming(hx, hz))) < (sg.all ? 2.2 : 4.2 - c.agg)) {
              target = Math.min(target, Math.sqrt(Math.max(0, 2 * 4 * Math.max(0, stopAt)))); // stopped: wait for a gap in cross traffic
            }
          }
        }
      }
      // on-ramp: time the merge into a gap in the freeway's traffic
      if (!sg && newRoad && c.road.c >= 8 && c.road.c <= 12 && c.next.road.c < c.road.c && rem < 70) {
        const tMe = rem / Math.max(c.v, 1);
        for (const o of cars) {
          if (o === c || !(o.road === c.next.road || (o.next && o.next.road === c.next.road)) || o.road === c.road) continue;
          const ofx = Math.sin(o.h), ofz = Math.cos(o.h), dO = (bx - o.x) * ofx + (bz - o.z) * ofz;
          if (dO < -12 || dO > 90 || Math.abs((bx - o.x) * ofz - (bz - o.z) * ofx) > 9) continue;
          const tO = dO / Math.max(o.v, 1);
          if (tO < tMe + 0.3 && tO > tMe - 1.8) target = Math.min(target, Math.max(4, rem / (Math.max(0, tO) + 1.7)));
        }
      }
      // following: nearest thing ahead in our lane
      let gap = 1e9, lead = 0;
      const fx = Math.sin(c.h), fz = Math.cos(c.h);
      for (const o of cars) {
        if (o === c) continue;
        const rx = o.x - c.x, rz = o.z - c.z, along = rx * fx + rz * fz; if (along <= 0 || along > 50) continue;
        if (Math.abs(rx * fz - rz * fx) > 2.2 || Math.abs(o.y - c.y) > 3) continue;
        if (Math.sin(o.h) * fx + Math.cos(o.h) * fz < 0.3) continue;
        if (along < gap) { gap = along; lead = o.v; }
      }
      { const rx = S.x - c.x, rz = S.z - c.z, along = rx * fx + rz * fz; if (along > 0 && along < 50 && Math.abs(rx * fz - rz * fx) < 2.4 && Math.abs(S.y - c.y) < 3 && along < gap) { gap = along; lead = Math.max(0, S.vx * fx + S.vz * fz); } }
      if (gap < 1e9) { const safe = 6.5 + c.v * (c.hw + 0.3 * WX.wet.value + 0.7 * WX.snow.value); if (gap < safe) target = Math.min(target, lead + (gap - 6.5) * 0.6); }
      // lanes: get into the right lane for a turn or exit, pass slower cars, keep right on the freeway
      const nLn = lanesOf(c.road);
      c.lcT -= dt; c.dT -= dt;
      if (nLn > 1 && c.dT <= 0 && !c.lc && !(c.hitT > 0)) {
        c.dT = 0.5;
        const want = turn !== 0 && newRoad && rem < 160 ? (turn > 0 ? nLn - 1 : 0) : null;
        if (want !== null && want !== c.lane) tryLane(c, c.lane + Math.sign(want - c.lane));
        else if (want === null && c.lcT <= 0 && c.v > 5) {
          if (gap < 45 && lead < limit - 2.5) { if (!tryLane(c, c.lane - 1, lead + 1.5)) tryLane(c, c.lane + 1, lead + 1.5); }
          else if (c.road.spec && c.road.spec.kind === 'fwy' && c.agg < 0.55 && c.lane < nLn - 1 && !(gap < 70 && lead < limit - 1)) tryLane(c, c.lane + 1, limit - 2);
        }
      }
      if (c.sigT > 0) c.sigT -= dt;
      if (turn !== 0 && (newRoad || c.next.uturn) && rem < 55) { c.sig = turn; c.sigT = Math.max(c.sigT, 0.4); }
      else if (c.sigT <= 0) c.sig = 0;
      if (c.hitT > 0) { c.hitT -= dt; target = 0; }
      target = Math.max(0, target);
      c.brake = target < c.v - 0.4 || c.v < 0.3;
      c.v += Math.max(-8 * dt, Math.min(c.acc * dt, target - c.v));
      if (c.v < 0.3 && !(c.hitT > 0)) { c.jam += dt; if (c.jam > (c.chase ? 8 : 45)) { issue('stuck', c.x, c.z, `traffic stuck on ${c.road.name || ROAD_NAMES[c.road.c] || ''}`); c.dead = true; } } else c.jam = 0;
      // move, crossing vertices as needed
      c.u += c.v * dt;
      let guard = 0;
      while (c.u >= c.L && guard++ < 8) {
        c.u -= c.L;
        const nx = c.next;
        const h0 = hAt(c.road, ib), h1 = hAt(nx.road, nx.dir > 0 ? nx.s : nx.s + 1);
        if (Math.abs(h0 - h1) > 1.5 && nx.road !== c.road) issue('height_step', bx, bz, `${(h0 - h1).toFixed(1)} m step between ${c.road.name || ROAD_NAMES[c.road.c] || 'road'} and ${nx.road.name || ROAD_NAMES[nx.road.c] || 'road'}`);
        if (nx.road !== c.road) {
          const t2 = turnOf(c, (bx - ax) / (Math.hypot(bx - ax, bz - az) || 1), (bz - az) / (Math.hypot(bx - ax, bz - az) || 1)), nn = lanesOf(nx.road);
          c.lane = t2 > 0 || (c.road.c >= 8 && c.road.c <= 12 && nx.road.c < c.road.c) ? nn - 1 : t2 < 0 ? 0 : Math.min(c.lane, nn - 1);
          c.lc = false; c.stoppedAt = c.stoppedAt === keyOf(bx, bz) ? c.stoppedAt : null;
        }
        c.road = nx.road; c.s = nx.s; c.dir = nx.dir; c.next = null;
        const [sax, saz, sbx, sbz, sa, sb] = segEnds(c.road, c.s, c.dir); c.L = Math.hypot(sbx - sax, sbz - saz) || 0.01;
        const g = Math.abs(hAt(c.road, sb) - hAt(c.road, sa)) / c.L;
        if (g > 0.16 && c.L > 2 && !c.road.tunnel) issue('steep', sax, saz, `${(g * 100) | 0}% grade on ${c.road.name || ROAD_NAMES[c.road.c] || 'road'}`);
        c.next = chooseNext(c); if (!c.next) { c.dead = true; break; }
      }
      if (c.dead) continue;
      const [qax, qaz, qbx, qbz, qa, qb] = segEnds(c.road, c.s, c.dir), f = Math.min(1, c.u / c.L);
      const ex = (qbx - qax) / c.L, ez = (qbz - qaz) / c.L;
      const offT = laneOffset(c.road, c.lane);
      if (c.lc) { // lane change: drift across at ~1.2 m/s (about 3 s for a lane) and steer into it
        const d = offT - c.off, st = Math.max(-1.2 * dt, Math.min(1.2 * dt, d));
        c.off += st; c.latV = st / Math.max(dt, 1e-4); if (Math.abs(d) < 0.05) c.lc = false;
      } else { c.latV = 0; c.off += (offT - c.off) * Math.min(1, dt * 2); }
      const tx = qax + (qbx - qax) * f - ez * c.off, tz = qaz + (qbz - qaz) * f + ex * c.off; // right of travel = (-dz, dx)
      c.x = tx; c.z = tz;
      c.y = hAt(c.road, qa) + (hAt(c.road, qb) - hAt(c.road, qa)) * f;
      const th = Math.atan2(ex, ez) - Math.atan2(c.latV, Math.max(c.v, 3));
      c.h += angDiff(th, c.h) * Math.min(1, dt * 8);
      c.pitch = Math.atan2(hAt(c.road, qb) - hAt(c.road, qa), c.L);
    }
    for (let i = cars.length - 1; i >= 0; i--) if (cars[i].dead) cars.splice(i, 1);
    // draw
    const n = Math.min(MAXN, cars.length), now = performance.now() / 1000;
    for (let i = 0; i < n; i++) {
      const c = cars[i];
      tmpQ.setFromEuler(new THREE.Euler(-(c.pitch || 0), c.h, 0, 'YXZ')); tmpP.set(c.x, c.y + 0.02, c.z);
      tmpS.set(1, c.tall, c.len); tmpM.compose(tmpP, tmpQ, tmpS);
      for (const m of parts) m.setMatrixAt(i, tmpM);
      bodies.setColorAt(i, col.set(c.color));
      lights.setColorAt(i, col.set(c.brake ? '#ff2a2a' : NIGHT.value > 0.4 ? '#c0141c' : '#7a0c12'));
      beams.setMatrixAt(i, tmpM);
      const on = (now * 1.5 + c.seed) % 1 < 0.55;
      blinkL.setMatrixAt(i, c.sig < 0 && on ? tmpM : ZERO); blinkR.setMatrixAt(i, c.sig > 0 && on ? tmpM : ZERO);
      const fl = (now * 4 + c.seed) % 1 < 0.5;
      barR.setMatrixAt(i, c.cop && (!c.chase || fl) ? tmpM : ZERO); barB.setMatrixAt(i, c.cop && (!c.chase || !fl) ? tmpM : ZERO); stripe.setMatrixAt(i, c.cop ? tmpM : ZERO);
    }
    beams.count = NIGHT.value > 0.01 ? n : 0;
    for (const m of [...parts, blinkL, blinkR, beams, barR, barB, stripe]) { m.count = m === beams ? beams.count : n; m.instanceMatrix.needsUpdate = true; }
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    if (lights.instanceColor) lights.instanceColor.needsUpdate = true;
  }
  // the player bumping into a car (box vs box, in the AI car's frame)
  function collide(P, foot) {
    for (const c of cars) {
      if (Math.abs(c.y - P.y) > 2.5) continue;
      const rx = P.x - c.x, rz = P.z - c.z; if (rx * rx + rz * rz > 36) continue;
      const fx = Math.sin(c.h), fz = Math.cos(c.h), along = rx * fx + rz * fz, side = rx * fz - rz * fx; // side: + is the car's left
      const pa = (foot ? 2.65 : 4.4) - Math.abs(along), ps = (foot ? 1.3 : 2.0) - Math.abs(side);
      if (pa <= 0 || ps <= 0) continue;
      let nx, nz, pen;
      if (ps < pa) { const sg = Math.sign(side) || 1; nx = fz * sg; nz = -fx * sg; pen = ps; } else { const sg = Math.sign(along) || 1; nx = fx * sg; nz = fz * sg; pen = pa; }
      P.x += nx * pen; P.z += nz * pen;
      const vn = P.vx * nx + P.vz * nz;
      if (foot) { // knocked aside by a moving car
        if (c.v > 3) { P.vx += nx * c.v * 0.5; P.vz += nz * c.v * 0.5; P.vy = Math.max(P.vy || 0, 2.5); bump(Math.min(1, c.v / 15)); }
        c.v *= 0.2; c.hitT = 3; continue;
      }
      if (vn < 0) { // glance off: lose the push into the other car (with a little bounce), keep most of the slide along it
        P.vx -= 1.25 * vn * nx; P.vz -= 1.25 * vn * nz; const k = vn < -6 ? 0.9 : 0.985; P.vx *= k; P.vz *= k;
        if (vn < -4) bump(Math.min(1, -vn / 20)); if (vn < -9 && P.drift) endDrift(true); if (vn < -5 && window.__hitCar) window.__hitCar(c, -vn);
        c.v *= vn < -6 ? 0.4 : 0.8; c.hitT = vn < -6 ? 2.5 : 0.8;
      }
    }
  }
  return { addRoads, removeTile, setSignals, update, collide, cars, issues, spawn };
})();

// ───────────────────────── spawning / teleport ─────────────────────────
let pendingSnap = null;
function teleport(x, z, label) {
  if (window.__noTeleport && window.__noTeleport()) { toast('Not with the cops on your tail — lose them first'); return; }
  if (window.__onTeleport) window.__onTeleport();
  if (window.__inside && __inside.on) __inside.exit();
  if (window.__hustle && __hustle.active()) __hustle.stop('Teleporting ended your hustle');
  if (LIFE.hot) { LIFE.hot = null; LIFE.own = null; if (window.__police) { __police.showOwn(); setCar(); } }
  if (S.mode === 'foot') { S.mode = 'car'; if (ME.fig) ME.fig.grp.visible = false; document.body.classList.remove('onfoot'); } // your car comes with you
  S.x = x; S.z = z; S.vx = S.vz = 0; S.y = 0; S.vy = 0; camInit = false;
  pendingSnap = { x, z, t: performance.now() };
  if (label) toast(label);
  wantTiles(x, z);
  trySnap();
}
function trySnap() {
  if (!pendingSnap) return;
  const nr = nearestRoad(pendingSnap.x, pendingSnap.z, 600);
  if (!nr) return;
  S.x = nr.px; S.z = nr.pz; S.vx = S.vz = 0; S.vy = 0;
  S.h = Math.atan2(nr.dx, nr.dz);
  const sf = surfaceAt(S.x, S.z, 60); S.y = sf ? sf.h : 0;
  if (nr.road.oneway === 0) { S.x += -Math.cos(S.h) * nr.road.w / 4; S.z += Math.sin(S.h) * nr.road.w / 4; }
  camInit = false;
  pendingSnap = null;
}
function respawnOnRoad() {
  const nr = nearestRoad(S.x, S.z, 400);
  if (nr) { pendingSnap = { x: S.x, z: S.z }; trySnap(); toast('Back on the road'); }
}

// ───────────────────────── HUD ─────────────────────────
const $ = id => document.getElementById(id);
const hud = { street: $('street'), sub: $('sub'), speed: $('speed'), limit: $('limit'), limitNum: $('limitNum'), loading: $('loading'), toast: $('toast'), ref: $('ref'), nitro: $('nitroFill'), nitroBox: $('nitroBox'), drift: $('driftTag'), tag: $('fxTag'), lastLvl: -2 };
let toastTimer = 0;
function toast(msg) { hud.toast.textContent = msg; hud.toast.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => hud.toast.classList.remove('on'), 1800); }
function updateLoading() {
  let need = 0, done = 0;
  for (const t of tiles.values()) { need++; if (t.state.r === 2) done++; }
  const busy = queue.length + inflight;
  if (busy > 0) { hud.loading.classList.add('on'); hud.loading.textContent = done < need ? `Loading streets… ${done}/${need}` : 'Loading buildings…'; }
  else hud.loading.classList.remove('on');
  $('firstLoad').classList.toggle('on', started && done === 0 && need > 0);
}
let lastStreet = '';
function updateHud(info) {
  const mph = Math.round(Math.abs(info.vf) * 2.23694);
  hud.speed.textContent = mph;
  const r = info.nr && info.nr.d < info.nr.road.w / 2 + 8 ? info.nr.road : null;
  let name = r ? (r.name || (r.ref ? '' : ROAD_NAMES[r.c])) : 'Off road';
  const ref = r && r.ref ? r.ref.split(';')[0] : '';
  if (name !== lastStreet) { hud.street.textContent = name || ref; lastStreet = name; }
  hud.ref.textContent = ref && name ? ref : '';
  hud.ref.style.display = ref && name ? '' : 'none';
  const p = nearPlace(S.x, S.z);
  const sub = (p ? `Near ${p.n} · ` : '') + clockText();
  if (hud.sub.textContent !== sub) hud.sub.textContent = sub;
  if (r && r.ms) { hud.limit.style.display = ''; hud.limitNum.textContent = r.ms; hud.limit.classList.toggle('over', mph > r.ms + 7); }
  else hud.limit.style.display = 'none';
}

// minimap
const mm = $('minimap'), mmc = mm.getContext('2d');
let mmFrame = 0;
function drawMinimap() {
  const W = mm.width, H = mm.height, R = W / 2;
  const scale = R / 380; // px per metre
  mmc.save();
  mmc.clearRect(0, 0, W, H);
  mmc.beginPath(); mmc.arc(R, R, R - 1, 0, Math.PI * 2); mmc.clip();
  mmc.fillStyle = '#e9e5dc'; mmc.fillRect(0, 0, W, H);
  mmc.translate(R, R);
  mmc.rotate(Math.PI + S.h); // heading up
  mmc.scale(scale, scale);
  mmc.translate(-S.x, -S.z);
  mmc.lineCap = 'round'; mmc.lineJoin = 'round';
  const vis = [];
  for (const t of tiles.values()) {
    if (t.state.r !== 2) continue;
    if (t.areas) for (const a of t.areas) { if (a.c === 3) continue; mmc.fillStyle = LU_MAP[a.c]; const w = a.pts; mmc.beginPath(); mmc.moveTo(w[0], w[1]); for (let i = 2; i < w.length; i += 2) mmc.lineTo(w[i], w[i + 1]); mmc.fill(); }
    if (t.water) { mmc.fillStyle = '#a9c6e0'; for (const w of t.water) { mmc.beginPath(); mmc.moveTo(w[0], w[1]); for (let i = 2; i < w.length; i += 2) mmc.lineTo(w[i], w[i + 1]); mmc.fill(); } }
    for (const r of t.roads) {
      const p = r.pts; let near = false;
      for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - S.x) < 520 && Math.abs(p[i + 1] - S.z) < 520) { near = true; break; }
      if (near) vis.push(r);
    }
  }
  vis.sort((a, b) => RC[a.c].p - RC[b.c].p);
  for (const pass of [0, 1]) for (const r of vis) {
    const k = RC[r.c]; const p = r.pts;
    mmc.strokeStyle = pass ? k.c : '#9b958a';
    mmc.lineWidth = (k.mw + (pass ? 0 : 1.6)) / scale * 1.1;
    mmc.beginPath(); mmc.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) mmc.lineTo(p[i], p[i + 1]); mmc.stroke();
  }
  if (nav.route) {
    mmc.strokeStyle = '#2f7bff'; mmc.lineWidth = 7 / scale;
    const p = nav.route.pts; mmc.beginPath(); mmc.moveTo(p[nav.lastIdx * 2], p[nav.lastIdx * 2 + 1]);
    for (let i = nav.lastIdx + 1; i < p.length / 2; i++) { mmc.lineTo(p[i * 2], p[i * 2 + 1]); if (Math.abs(p[i * 2] - S.x) > 900 || Math.abs(p[i * 2 + 1] - S.z) > 900) break; }
    mmc.stroke();
  }
  mmc.fillStyle = '#4b5563';
  for (const c of traffic.cars) { if (Math.abs(c.x - S.x) > 420 || Math.abs(c.z - S.z) > 420) continue; mmc.beginPath(); mmc.arc(c.x, c.z, 3.5 / scale, 0, Math.PI * 2); mmc.fill(); }
  mmc.restore();
  // places (drawn upright)
  mmc.font = '17px system-ui, "Apple Color Emoji", sans-serif'; mmc.textAlign = 'center'; mmc.textBaseline = 'middle';
  const ca = Math.cos(Math.PI + S.h), sa = Math.sin(Math.PI + S.h);
  for (const t of tiles.values()) if (t.pois) for (const p of t.pois) {
    const dx = (p.x - S.x) * scale, dz = (p.z - S.z) * scale;
    if (dx * dx + dz * dz > (R - 12) ** 2) continue;
    mmc.fillText(POI_ICONS[p.c], R + dx * ca - dz * sa, R + dx * sa + dz * ca);
  }
  if (nav.route) {
    const dx = (nav.route.dest.x - S.x) * scale, dz = (nav.route.dest.z - S.z) * scale;
    const dl = Math.hypot(dx, dz), k = dl > R - 14 ? (R - 14) / dl : 1;
    mmc.fillStyle = '#e8402f'; mmc.beginPath(); mmc.arc(R + (dx * ca - dz * sa) * k, R + (dx * sa + dz * ca) * k, 7, 0, Math.PI * 2); mmc.fill();
  }
  if (LIFE_ON() && LIFE.home) { // home, pinned to the rim when off the minimap
    const dx = (LIFE.home.x - S.x) * scale, dz = (LIFE.home.z - S.z) * scale;
    const dl = Math.hypot(dx, dz), k = dl > R - 14 ? (R - 14) / dl : 1;
    mmc.font = '15px system-ui'; mmc.textAlign = 'center'; mmc.textBaseline = 'middle';
    mmc.fillText('🏠', R + (dx * ca - dz * sa) * k, R + (dx * sa + dz * ca) * k);
  }
  if (LIFE_ON() && LIFE.own) { // your own car, parked while you joyride
    const dx = (LIFE.own.x - S.x) * scale, dz = (LIFE.own.z - S.z) * scale, dl = Math.hypot(dx, dz), k = dl > R - 14 ? (R - 14) / dl : 1;
    mmc.font = '14px system-ui'; mmc.textAlign = 'center'; mmc.textBaseline = 'middle'; mmc.fillText('🔑', R + (dx * ca - dz * sa) * k, R + (dx * sa + dz * ca) * k);
  }
  // car arrow
  mmc.fillStyle = '#e8402f'; mmc.strokeStyle = '#fff'; mmc.lineWidth = 2;
  mmc.beginPath(); mmc.moveTo(R, R - 9); mmc.lineTo(R + 6, R + 7); mmc.lineTo(R, R + 3); mmc.lineTo(R - 6, R + 7); mmc.closePath(); mmc.fill(); mmc.stroke();
  // north indicator
  const na = Math.PI + S.h;
  mmc.fillStyle = '#333'; mmc.font = 'bold 11px system-ui'; mmc.textAlign = 'center'; mmc.textBaseline = 'middle';
  mmc.fillText('N', R + Math.sin(-na) * (R - 10) * -1, R - Math.cos(na) * (R - 10));
}

// ───────────────────────── big map ─────────────────────────
const bigMap = $('bigmap'), bm = $('bmCanvas'), bmc = bm.getContext('2d');
const MV = { cx: 0, cz: 0, scale: 0.02, target: null };
let majorData = null, majorLoading = false, majorLoadedOnce = false;
function sizeMap() { const r = devicePixelRatio || 1; bm.width = innerWidth * r; bm.height = innerHeight * r; if (bigMap.classList.contains('on')) drawBigMap(); }
sizeMap();
async function loadMajor() {
  if (majorData || majorLoading || majorLoadedOnce) return;
  majorLoading = true; $('bmStatus').textContent = 'Loading region map…';
  const parts = await Promise.all([0, 1, 2, 3].map(async q => {
    if (STATIC) { const d = (await staticJson(`data/m/${q}.json`)) || (await idb.get(`m2:${q}`)); if (d) return d; }
    else try { const r = await fetch(`${API}/major?q=${q}`); if (r.ok) return r.json(); } catch {}
    try { const d = convertMajor(await overpass(majorQuery(q))); share(`m2:${q}`, d); return d; } catch {}
    return null;
  }));
  majorData = parts.filter(Boolean);
  majorLoading = false;
  $('bmStatus').textContent = parts.every(Boolean) ? '' : 'Region overview unavailable right now — nearby streets still show';
  setTimeout(() => { $('bmStatus').textContent = ''; }, 4000);
  if (!majorData.length) { majorData = null; setTimeout(() => { majorLoadedOnce = false; }, 60000); }
  majorLoadedOnce = true;
  drawBigMap();
}
function openMap() {
  bigMap.classList.add('on'); paused = true;
  if (settings.showIssues) loadIssues();
  MV.cx = S.x; MV.cz = S.z; MV.scale = Math.min(innerWidth, innerHeight) / 9000; MV.target = null;
  $('bmActions').style.display = 'none';
  sizeMap(); loadMajor(); drawBigMap();
}
function closeMap() { bigMap.classList.remove('on'); paused = false; last = performance.now(); }
function w2s(x, z) { const r = devicePixelRatio || 1; return [(x - MV.cx) * MV.scale * r + bm.width / 2, (z - MV.cz) * MV.scale * r + bm.height / 2]; }
function s2w(sx, sy) { return [(sx - innerWidth / 2) / MV.scale + MV.cx, (sy - innerHeight / 2) / MV.scale + MV.cz]; }
const ISSUE_COL = { dead_end: '#d1342f', oneway_trap: '#a1129a', gap: '#e07b00', height_step: '#1565c0', steep: '#0d8a6a', stuck: '#5d4037' };
const ISSUE_LABEL = { dead_end: 'Dead end', oneway_trap: 'One-way trap', gap: 'Gap', height_step: 'Ramp step', steep: 'Too steep', stuck: 'Gridlock' };
let serverIssues = [];
function loadIssues() {
  if (STATIC) return;
  fetch(`${API}/roadissues`).then(r => r.ok ? r.json() : null).then(j => {
    if (!j) return; serverIssues = j.issues.map(i => { const [x, z] = proj(i.lat, i.lon); return { kind: i.kind, x, z, n: i.hits, info: i.info }; });
    if (bigMap.classList.contains('on')) drawBigMap();
  }).catch(() => {});
}
function drawBigMap() {
  const r = devicePixelRatio || 1, c = bmc;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = '#ece8df'; c.fillRect(0, 0, bm.width, bm.height);
  c.setTransform(MV.scale * r, 0, 0, MV.scale * r, bm.width / 2 - MV.cx * MV.scale * r, bm.height / 2 - MV.cz * MV.scale * r);
  const px = 1 / (MV.scale * r);
  // playable area
  c.fillStyle = '#f6f3ec'; c.fillRect(MINX, MINZ, MAXX - MINX, MAXZ - MINZ);
  c.strokeStyle = '#b8b0a2'; c.lineWidth = 2 * px; c.setLineDash([8 * px, 6 * px]); c.strokeRect(MINX, MINZ, MAXX - MINX, MAXZ - MINZ); c.setLineDash([]);
  c.lineCap = 'round'; c.lineJoin = 'round';
  const line = (p) => { c.beginPath(); c.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]); c.stroke(); };
  if (majorData) {
    c.fillStyle = '#b3cde4';
    for (const d of majorData) for (const w of d.water) { c.beginPath(); c.moveTo(w[0], w[1]); for (let i = 2; i < w.length; i += 2) c.lineTo(w[i], w[i + 1]); c.fill(); }
    c.strokeStyle = '#b3cde4'; c.lineWidth = Math.max(40, 3 * px);
    for (const d of majorData) for (const rv of d.rivers) line(Array.isArray(rv[1]) ? rv[1] : rv);
  }
  // detailed streets from loaded tiles
  for (const t of tiles.values()) {
    if (t.areas) for (const a of t.areas) { if (a.c === 3) continue; c.fillStyle = LU_MAP[a.c]; const w = a.pts; c.beginPath(); c.moveTo(w[0], w[1]); for (let i = 2; i < w.length; i += 2) c.lineTo(w[i], w[i + 1]); c.fill(); }
    if (t.water) { c.fillStyle = '#b3cde4'; for (const w of t.water) { c.beginPath(); c.moveTo(w[0], w[1]); for (let i = 2; i < w.length; i += 2) c.lineTo(w[i], w[i + 1]); c.fill(); } }
  }
  for (const pass of [0, 1]) for (const t of tiles.values()) for (const rd of t.roads) {
    if (MV.scale < 0.05 && RC[rd.c].p < 6) continue;
    c.strokeStyle = pass ? (RC[rd.c].c === '#ffffff' ? '#ffffff' : RC[rd.c].c) : '#cfc8ba';
    c.lineWidth = Math.max(rd.w, (pass ? 1.4 : 2.6) * px * (RC[rd.c].p >= 6 ? 1.6 : 1)); line(rd.pts);
  }
  if (majorData) {
    const order = [3, 2, 1, 0];
    for (const cls of order) for (const d of majorData) for (const rd of d.roads) {
      const k = rd[0] === cls || (cls === 0 && rd[0] === 8) ? RC[rd[0]] : null; if (!k) continue;
      c.strokeStyle = k.c === '#ffffff' ? '#fbe7a8' : k.c; c.lineWidth = Math.max([22, 16, 12, 9][cls] || 8, (k.mw * 0.8) * px); line(rd[2]);
    }
  }
  if (nav.route) { c.strokeStyle = '#2f7bff'; c.lineWidth = Math.max(8, 5 * px); line(nav.route.pts); }
  // labels, in screen space
  c.setTransform(1, 0, 0, 1, 0, 0);
  const placed = [];
  const free = (x, y, w, h) => { for (const q of placed) if (x < q[0] + q[2] && x + w > q[0] && y < q[1] + q[3] && y + h > q[1]) return false; placed.push([x, y, w, h]); return true; };
  // street names along roads
  const minorOk = MV.scale > 0.35, midOk = MV.scale > 0.12;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  const labelled = new Set();
  const roadsByPrio = [];
  for (const t of tiles.values()) for (const rd of t.roads) if (rd.name) roadsByPrio.push(rd);
  roadsByPrio.sort((a, b) => RC[b.c].p - RC[a.c].p);
  for (const rd of roadsByPrio) {
    const pr = RC[rd.c].p;
    if (pr < 5 && !minorOk) continue; if (pr < 8 && !midOk) continue; if (MV.scale < 0.04) break;
    const lk = rd.name + Math.round(rd.pts[0] / 400) + ',' + Math.round(rd.pts[1] / 400);
    if (labelled.has(lk)) continue;
    // label sits at the middle of the street's length
    const p = rd.pts; let total = 0;
    for (let i = 0; i < p.length / 2 - 1; i++) total += Math.hypot(p[i * 2 + 2] - p[i * 2], p[i * 2 + 3] - p[i * 2 + 1]);
    const fs = (pr >= 8 ? 12 : 11) * r;
    c.font = `600 ${fs}px system-ui, sans-serif`;
    const tw = c.measureText(rd.name).width;
    if (total * MV.scale * r < tw * 0.8) continue;
    let acc = 0, bi = 0;
    for (let i = 0; i < p.length / 2 - 1; i++) { const l = Math.hypot(p[i * 2 + 2] - p[i * 2], p[i * 2 + 3] - p[i * 2 + 1]); if (acc + l >= total / 2) { bi = i; break; } acc += l; }
    const segL = Math.hypot(p[bi * 2 + 2] - p[bi * 2], p[bi * 2 + 3] - p[bi * 2 + 1]) || 1, f = (total / 2 - acc) / segL;
    const [ax, ay] = w2s(p[bi * 2], p[bi * 2 + 1]), [bx, by] = w2s(p[bi * 2 + 2], p[bi * 2 + 3]);
    const mx = ax + (bx - ax) * f, my = ay + (by - ay) * f;
    if (mx < 0 || my < 0 || mx > bm.width || my > bm.height) continue;
    let ang = Math.atan2(by - ay, bx - ax); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
    const ext = Math.abs(Math.cos(ang)) * tw + Math.abs(Math.sin(ang)) * fs, eyt = Math.abs(Math.sin(ang)) * tw + Math.abs(Math.cos(ang)) * fs;
    if (!free(mx - ext / 2, my - eyt / 2, ext, eyt)) continue;
    labelled.add(lk);
    c.save(); c.translate(mx, my); c.rotate(ang);
    c.lineWidth = 3 * r; c.strokeStyle = 'rgba(255,255,255,.95)'; c.strokeText(rd.name, 0, 0);
    c.fillStyle = '#4a463e'; c.fillText(rd.name, 0, 0);
    c.restore();
  }
  // highway shields from the overview data
  if (majorData && MV.scale < 0.2) {
    c.font = `800 ${10 * r}px system-ui, sans-serif`;
    for (const d of majorData) for (const rd of d.roads) {
      if (rd[0] > 1 || rd[1] < 0) continue;
      const label = d.names[rd[1]].split(';')[0].replace(/^(I|US|MN)\s?/, (m0, a) => a === 'I' ? 'I-' : a + ' ');
      const p = rd[2], mi = Math.floor(p.length / 4) * 2;
      const [sx, sy] = w2s(p[mi], p[mi + 1]);
      const tw = c.measureText(label).width + 10 * r, th = 15 * r;
      if (sx < 0 || sy < 0 || sx > bm.width || sy > bm.height || !free(sx - tw / 2 - 20 * r, sy - th / 2 - 20 * r, tw + 40 * r, th + 40 * r)) continue;
      c.fillStyle = label.startsWith('I-') ? '#1f4fa8' : '#f4f1ea'; c.strokeStyle = label.startsWith('I-') ? '#fff' : '#333'; c.lineWidth = 1.5 * r;
      c.beginPath(); c.roundRect(sx - tw / 2, sy - th / 2, tw, th, 4 * r); c.fill(); c.stroke();
      c.fillStyle = label.startsWith('I-') ? '#fff' : '#222'; c.fillText(label, sx, sy + 0.5 * r);
    }
  }
  // places
  if (MV.scale > 0.1) {
    for (const t of tiles.values()) if (t.pois) for (const p of t.pois) {
      const [sx, sy] = w2s(p.x, p.z);
      if (sx < 0 || sy < 0 || sx > bm.width || sy > bm.height) continue;
      c.font = `${15 * r}px system-ui, "Apple Color Emoji", sans-serif`;
      if (!free(sx - 9 * r, sy - 9 * r, 18 * r, 18 * r)) continue;
      c.fillText(POI_ICONS[p.c], sx, sy);
      if (MV.scale > 0.45) {
        c.font = `600 ${11 * r}px system-ui, sans-serif`;
        const tw = c.measureText(p.name).width;
        if (free(sx + 11 * r, sy - 7 * r, tw + 4 * r, 14 * r)) {
          c.textAlign = 'left'; c.lineWidth = 3 * r; c.strokeStyle = 'rgba(255,255,255,.95)'; c.strokeText(p.name, sx + 12 * r, sy);
          c.fillStyle = '#7a3d14'; c.fillText(p.name, sx + 12 * r, sy); c.textAlign = 'center';
        }
      }
    }
  }
  // road issues found by the traffic (this drive + everything reported before)
  if (settings.showIssues) {
    const all = [...serverIssues, ...traffic.issues.values()];
    c.textAlign = 'left'; c.font = `700 ${11 * r}px system-ui, sans-serif`;
    for (const it of all) {
      const [sx, sy] = w2s(it.x, it.z);
      if (sx < -20 || sy < -20 || sx > bm.width + 20 || sy > bm.height + 20) continue;
      c.fillStyle = ISSUE_COL[it.kind] || '#d00'; c.strokeStyle = '#fff'; c.lineWidth = 2 * r;
      c.beginPath(); c.arc(sx, sy, 6 * r, 0, Math.PI * 2); c.fill(); c.stroke();
      if (MV.scale > 0.35) { c.lineWidth = 3 * r; c.strokeText(ISSUE_LABEL[it.kind] || it.kind, sx + 9 * r, sy + 4 * r); c.fillStyle = '#222'; c.fillText(ISSUE_LABEL[it.kind] || it.kind, sx + 9 * r, sy + 4 * r); }
    }
    c.textAlign = 'center';
  }
  // city labels
  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (const p of PLACES) {
    const [sx, sy] = w2s(p.x, p.z);
    if (sx < -100 || sy < -50 || sx > bm.width + 100 || sy > bm.height + 50) continue;
    if (MV.scale > 0.3) continue;
    c.font = `700 ${13 * r}px system-ui, sans-serif`;
    c.lineWidth = 3 * r; c.strokeStyle = 'rgba(255,255,255,.9)'; c.strokeText(p.n, sx, sy);
    c.fillStyle = '#3b3a36'; c.fillText(p.n, sx, sy);
  }
  // car
  const [cx, cy] = w2s(S.x, S.z);
  c.save(); c.translate(cx, cy); c.rotate(Math.PI - S.h);
  c.fillStyle = '#e8402f'; c.strokeStyle = '#fff'; c.lineWidth = 2 * r;
  c.beginPath(); c.moveTo(0, -11 * r); c.lineTo(8 * r, 9 * r); c.lineTo(0, 4 * r); c.lineTo(-8 * r, 9 * r); c.closePath(); c.fill(); c.stroke();
  c.restore();
  if (MV.target) {
    const [tx, ty] = w2s(MV.target[0], MV.target[1]);
    c.fillStyle = '#1f6feb'; c.beginPath(); c.arc(tx, ty, 8 * r, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#fff'; c.lineWidth = 3 * r; c.stroke();
  }
}
// map gestures
{
  const pts = new Map(); let moved = 0, pinch0 = 0, scale0 = 0;
  bm.addEventListener('pointerdown', e => { bm.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); moved = 0; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); scale0 = MV.scale; } });
  bm.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p[0], dy = e.clientY - p[1];
    if (pts.size === 1) { MV.cx -= dx / MV.scale; MV.cz -= dy / MV.scale; moved += Math.abs(dx) + Math.abs(dy); }
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); MV.scale = Math.min(1.5, Math.max(0.01, scale0 * d / pinch0)); moved = 99; }
    drawBigMap();
  });
  const up = e => {
    if (pts.size === 1 && moved < 8) {
      MV.target = s2w(e.clientX, e.clientY); MV.targetName = '';
      if (MV.scale > 0.1) { // snap to a tapped place
        let best = null, bd = (22 / MV.scale) ** 2;
        for (const t of tiles.values()) if (t.pois) for (const p of t.pois) { const d = (p.x - MV.target[0]) ** 2 + (p.z - MV.target[1]) ** 2; if (d < bd) { bd = d; best = p; } }
        if (best) { MV.target = [best.x, best.z]; MV.targetName = best.name; }
      }
      const p = nearPlace(MV.target[0], MV.target[1]);
      $('bmLabel').textContent = MV.targetName || `Near ${p.n}`;
      $('bmActions').style.display = '';
      drawBigMap();
    }
    pts.delete(e.pointerId);
  };
  bm.addEventListener('pointerup', up); bm.addEventListener('pointercancel', e => pts.delete(e.pointerId));
  bm.addEventListener('wheel', e => { e.preventDefault(); const [wx, wz] = s2w(e.clientX, e.clientY); MV.scale = Math.min(1.5, Math.max(0.01, MV.scale * Math.exp(-e.deltaY * 0.0015))); const [nx, nz] = s2w(e.clientX, e.clientY); MV.cx += wx - nx; MV.cz += wz - nz; drawBigMap(); }, { passive: false });
  $('bmZin').onclick = () => { MV.scale = Math.min(1.5, MV.scale * 1.6); drawBigMap(); };
  $('bmZout').onclick = () => { MV.scale = Math.max(0.01, MV.scale / 1.6); drawBigMap(); };
  $('bmMe').onclick = () => { MV.cx = S.x; MV.cz = S.z; drawBigMap(); };
  $('bmClose').onclick = closeMap;
  $('bmGo').onclick = () => {
    if (!MV.target) return;
    const [x, z] = MV.target;
    if (x < MINX || x > MAXX || z < MINZ || z > MAXZ) { toast('That spot is outside the drivable area'); return; }
    closeMap(); teleport(x, z, 'Teleported near ' + nearPlace(x, z).n);
  };
  $('bmNav').onclick = () => {
    if (!MV.target) return;
    const [x, z] = MV.target;
    if (x < MINX || x > MAXX || z < MINZ || z > MAXZ) { toast('That spot is outside the drivable area'); return; }
    closeMap(); startNav(x, z, MV.targetName || 'your pin near ' + nearPlace(x, z).n);
  };
}

// ───────────────────────── places (POIs) in 3D ─────────────────────────
const poiTexCache = new Map();
function poiSprite(p) {
  const key = p.c + '|' + p.name;
  let mat = poiTexCache.get(key);
  if (!mat) {
    const c = document.createElement('canvas'), ctx = c.getContext('2d');
    const font = '600 30px system-ui, -apple-system, sans-serif';
    ctx.font = font;
    const name = p.name.length > 28 ? p.name.slice(0, 27) + '…' : p.name;
    const w = Math.ceil(ctx.measureText(name).width) + 76, h = 52;
    c.width = w; c.height = h;
    ctx.font = font;
    ctx.fillStyle = 'rgba(20,24,29,.82)';
    ctx.beginPath(); ctx.roundRect(1, 1, w - 2, h - 2, 24); ctx.fill();
    ctx.font = '28px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillText(POI_ICONS[p.c] || '📍', 12, h / 2 + 1);
    ctx.font = font; ctx.fillStyle = '#f4f1ea'; ctx.fillText(name, 56, h / 2 + 1);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    tex.onUpdate = () => { c.width = c.height = 1; }; // on the GPU now: free the canvas
    mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    mat.userData.aspect = w / h;
    if (poiTexCache.size > (LOW ? 120 : 300)) { const [k0, m0] = poiTexCache.entries().next().value; m0.map.dispose(); m0.dispose(); poiTexCache.delete(k0); }
    poiTexCache.set(key, mat);
  }
  const sp = new THREE.Sprite(mat);
  sp.renderOrder = 10;
  return sp;
}
const poiGroup = new THREE.Group(); scene.add(poiGroup);
let poiTimer = 0;
function updatePoiLabels(dt) {
  if ((poiTimer -= dt) > 0) return; poiTimer = 0.4;
  if (S.inTun) { poiGroup.clear(); return; }
  const near = [];
  for (const t of tiles.values()) if (t.pois) for (const p of t.pois) {
    const d = Math.hypot(p.x - S.x, p.z - S.z);
    if (d < 260) near.push([d, p]);
  }
  near.sort((a, b) => a[0] - b[0]);
  poiGroup.clear();
  for (const [d, p] of near.slice(0, 6)) { // a few small labels: they were crowding the screen
    const sp = poiSprite(p);
    const k = Math.max(2.8, d * 0.03);
    sp.scale.set(k * sp.material.userData.aspect * 0.55, k * 0.55, 1);
    sp.position.set(p.x, 7 + k * 0.4, p.z);
    sp.material.opacity = Math.min(1, (260 - d) / 60);
    poiGroup.add(sp);
  }
}
function allPois() { const out = []; for (const t of tiles.values()) if (t.pois) out.push(...t.pois); return out; }

// ───────────────────────── GPS navigation ─────────────────────────
const nav = { route: null, mesh: null, pin: null, lastIdx: 0, offT: 0, lastReroute: 0, spoken: new Set(), muted: false, busy: false };
const routeMat = new THREE.MeshBasicMaterial({ color: '#3d8bff', transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -20, polygonOffsetUnits: -40 });
const OSRM = ['https://router.project-osrm.org/route/v1/driving/', 'https://routing.openstreetmap.de/routed-car/route/v1/driving/'];
const ll2xz = (lat, lon) => proj(lat, lon);
const xz2ll = (x, z) => unproj(x, z);

function fmtDist(m) {
  const ft = m * 3.28084;
  if (ft < 1000) return `${Math.max(50, Math.round(ft / 50) * 50)} ft`;
  const mi = m / 1609.34;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}
function fmtTime(sec) { const m = Math.max(1, Math.round(sec / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`; }
function stepText(s) {
  const road = s.name || s.ref || '';
  const onto = road ? ` onto ${road}` : '';
  const mod = s.mod || '';
  switch (s.type) {
    case 'depart': return road ? `Head out on ${road}` : 'Head out';
    case 'arrive': return `Arrive at ${nav.route ? nav.route.destName : 'destination'}`;
    case 'merge': return `Merge${onto}`;
    case 'on ramp': return `Take the ramp${road ? onto : s.dest ? ' toward ' + s.dest : ''}`;
    case 'off ramp': return `Take exit${s.exits ? ' ' + s.exits.split(';')[0] : ''}${s.dest ? ' toward ' + s.dest.split(',')[0] : onto}`;
    case 'fork': return `Keep ${mod.includes('left') ? 'left' : 'right'}${onto}`;
    case 'roundabout': case 'rotary': case 'roundabout turn': case 'exit roundabout': case 'exit rotary':
      return s.exit ? `At the roundabout, take exit ${s.exit}${onto}` : `Go through the roundabout${onto}`;
    case 'new name': case 'continue': case 'notification':
      return mod === 'uturn' ? 'Make a U-turn' : mod.includes('left') || mod.includes('right') ? `Bear ${mod.replace('slight ', '')}${onto}` : `Continue${onto}`;
    default:
      if (mod === 'uturn') return `Make a U-turn${onto}`;
      if (mod === 'straight' || !mod) return `Continue straight${onto}`;
      return `Turn ${mod}${onto}`;
  }
}
const ARROW_ANG = { 'sharp left': -135, 'left': -90, 'slight left': -40, 'straight': 0, 'slight right': 40, 'right': 90, 'sharp right': 135 };
function arrowSvg(s) {
  if (s.type === 'arrive') return '<svg viewBox="0 0 24 24"><path d="M12 2c-3.9 0-7 3.1-7 7 0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" fill="currentColor"/></svg>';
  if (s.mod === 'uturn') return '<svg viewBox="0 0 24 24"><path d="M8 21V9a4 4 0 0 1 8 0v4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="m12 11 4 4 4-4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const a = ARROW_ANG[s.mod] ?? 0;
  return `<svg viewBox="0 0 24 24"><g transform="rotate(${a} 12 14)"><path d="M12 22V6" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/><path d="m6 11 6-7 6 7" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
}
function speak(text) {
  if (nav.muted || !('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; speechSynthesis.speak(u); } catch {}
}

async function requestRoute(destX, destZ, destName) {
  const [la0, lo0] = xz2ll(S.x, S.z), [la1, lo1] = xz2ll(destX, destZ);
  const bearing = Math.round(((Math.atan2(Math.sin(S.h), -Math.cos(S.h)) * 180 / Math.PI) + 360) % 360);
  const path = `${lo0.toFixed(6)},${la0.toFixed(6)};${lo1.toFixed(6)},${la1.toFixed(6)}?overview=full&geometries=geojson&steps=true&bearings=${bearing},70;`;
  let lastErr;
  for (const base of OSRM) {
    try {
      const r = await timedFetch(base + path, {}, 15000);
      if (!r.ok) { lastErr = new Error('route ' + r.status); continue; }
      const j = await r.json();
      if (j.code !== 'Ok' || !j.routes?.length) { lastErr = new Error(j.code || 'no route'); continue; }
      return buildRoute(j.routes[0], destX, destZ, destName);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('route failed');
}
function buildRoute(rt, destX, destZ, destName) {
  const pts = [], cum = [0];
  for (const c of rt.geometry.coordinates) { const [x, z] = ll2xz(c[1], c[0]); pts.push(x, z); }
  for (let i = 1; i < pts.length / 2; i++) cum.push(cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]));
  const steps = [];
  let from = 0;
  for (const leg of rt.legs) for (const st of leg.steps) {
    const m = st.maneuver || {};
    const [mx, mz] = ll2xz(m.location[1], m.location[0]);
    // locate maneuver along the polyline (search forward)
    let best = from, bd = 1e18;
    for (let i = from; i < Math.min(pts.length / 2, from + 4000); i++) { const d = (pts[i * 2] - mx) ** 2 + (pts[i * 2 + 1] - mz) ** 2; if (d < bd) { bd = d; best = i; } if (bd < 1 && i > best + 5) break; }
    from = best;
    steps.push({ type: m.type, mod: m.modifier || '', exit: m.exit || 0, name: st.name || '', ref: st.ref || '', dest: st.destinations || '', exits: st.exits || '', along: cum[best], x: mx, z: mz });
  }
  return { pts, cum, steps, total: cum[cum.length - 1], duration: rt.duration, dest: { x: destX, z: destZ }, destName: destName || 'destination' };
}
function showRoute(route) {
  clearRouteMeshes();
  nav.route = route; nav.lastIdx = 0; nav.offT = 0; nav.spoken = new Set();
  rebuildRouteMesh();
  const pin = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 14, 8), new THREE.MeshBasicMaterial({ color: '#e8402f' })); pole.position.y = 7; pin.add(pole);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 12), new THREE.MeshBasicMaterial({ color: '#e8402f' })); ball.position.y = 15; pin.add(ball);
  pin.position.set(route.dest.x, 0, route.dest.z); scene.add(pin); nav.pin = pin;
  document.body.classList.add('navigating');
}
// route line for the next ~2.5 km, draped over bridges and ramps
function rebuildRouteMesh() {
  const R = nav.route; if (!R) return;
  if (nav.mesh) { scene.remove(nav.mesh); nav.mesh.geometry.dispose(); nav.mesh = null; }
  const pts = [], hs = []; let y = S.y, dist = 0;
  const add = (x, z) => { const sf = surfaceAt(x, z, y + 0.6); y = sf ? sf.h : Math.max(0, y - 0.5); pts.push(x, z); hs.push(y); };
  const n = R.pts.length / 2;
  for (let i = Math.max(0, nav.lastIdx); i < n - 1 && dist < 2500; i++) {
    const ax = R.pts[i * 2], az = R.pts[i * 2 + 1], bx = R.pts[i * 2 + 2], bz = R.pts[i * 2 + 3];
    const L = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(L / 12));
    for (let k = 0; k < steps; k++) add(ax + (bx - ax) * k / steps, az + (bz - az) * k / steps);
    dist += L;
  }
  add(R.pts[(n - 1) * 2], R.pts[(n - 1) * 2 + 1]);
  if (pts.length < 4) return;
  const buf = new GeoBuf();
  ribbon(buf, pts, 2.4, 0.34, 1, hs);
  nav.mesh = buf.mesh(routeMat); nav.mesh.renderOrder = 5; scene.add(nav.mesh);
}
let routeMeshTimer = 0;
function clearRouteMeshes() {
  if (nav.mesh) { scene.remove(nav.mesh); nav.mesh.geometry.dispose(); nav.mesh = null; }
  if (nav.pin) { scene.remove(nav.pin); nav.pin = null; }
}
function endNav(msg) {
  clearRouteMeshes(); nav.route = null;
  document.body.classList.remove('navigating');
  if (msg) toast(msg);
}
async function startNav(destX, destZ, destName) {
  if (nav.busy) return;
  nav.busy = true; toast('Finding a route…');
  try {
    const route = await requestRoute(destX, destZ, destName);
    showRoute(route);
    toast(`${fmtTime(route.duration)} · ${fmtDist(route.total)}`);
    speak(`Starting route to ${route.destName}`);
  } catch (e) { toast("Couldn't find a route — try again"); }
  nav.busy = false;
}
let navTick = 0;
function updateNav(dt, vf) {
  const R = nav.route; if (!R) return;
  if ((navTick -= dt) > 0) return; navTick = 0.15;
  // closest point on the route near the last known position
  const n = R.pts.length / 2;
  let bi = nav.lastIdx, bd = 1e18, bu = 0;
  const i0 = Math.max(0, nav.lastIdx - 8), i1 = Math.min(n - 1, nav.lastIdx + 120);
  for (let i = i0; i < i1; i++) {
    const ax = R.pts[i * 2], az = R.pts[i * 2 + 1], ex = R.pts[i * 2 + 2] - ax, ez = R.pts[i * 2 + 3] - az;
    const L2 = ex * ex + ez * ez || 1e-9;
    let u = ((S.x - ax) * ex + (S.z - az) * ez) / L2; u = Math.max(0, Math.min(1, u));
    const d = (S.x - ax - ex * u) ** 2 + (S.z - az - ez * u) ** 2;
    if (d < bd) { bd = d; bi = i; bu = u; }
  }
  nav.lastIdx = bi;
  if ((routeMeshTimer -= 0.15) <= 0) { routeMeshTimer = 2; rebuildRouteMesh(); }
  const off = Math.sqrt(bd);
  const along = R.cum[bi] + (R.cum[Math.min(bi + 1, n - 1)] - R.cum[bi]) * bu;
  const remaining = Math.max(0, R.total - along);
  // arrival
  if (Math.hypot(S.x - R.dest.x, S.z - R.dest.z) < 30 || remaining < 20) { speak(`You have arrived at ${R.destName}`); endNav(`You've arrived at ${R.destName}`); return; }
  // off-route → reroute
  if (off > 35 && Math.abs(vf) > 2) nav.offT += 0.15; else nav.offT = 0;
  if (nav.offT > 2.5 && performance.now() - nav.lastReroute > 8000 && !nav.busy) {
    nav.lastReroute = performance.now(); nav.offT = 0; nav.busy = true;
    $('navText').textContent = 'Rerouting…';
    requestRoute(R.dest.x, R.dest.z, R.destName).then(r => { if (nav.route) { showRoute(r); speak('Rerouting'); } }).catch(() => {}).finally(() => nav.busy = false);
    return;
  }
  // next maneuver
  let si = R.steps.findIndex(s => s.along > along + 8 && s.type !== 'depart');
  if (si < 0) si = R.steps.length - 1;
  const step = R.steps[si];
  const dNext = Math.max(0, step.along - along);
  $('navArrow').innerHTML = arrowSvg(step);
  $('navDist').textContent = fmtDist(dNext);
  $('navText').textContent = stepText(step);
  const eta = new Date(Date.now() + R.duration * (remaining / R.total) * 1000);
  $('navEta').textContent = `${fmtTime(R.duration * remaining / R.total)} · ${fmtDist(remaining)} · ${eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  // voice prompts
  const kFar = si + ':far', kNow = si + ':now';
  if (dNext < 420 && dNext > 90 && !nav.spoken.has(kFar)) { nav.spoken.add(kFar); speak(`In ${fmtDist(dNext).replace('ft', 'feet').replace('mi', 'miles')}, ${stepText(step)}`); }
  if (dNext <= 70 && !nav.spoken.has(kNow)) { nav.spoken.add(kNow); nav.spoken.add(kFar); speak(stepText(step)); }
}

// search panel
const navPanel = $('navPanel'), navInput = $('navInput'), navResults = $('navResults');
function openNavPanel() {
  navPanel.classList.add('on'); paused = true;
  renderResults([], ''); setTimeout(() => navInput.focus(), 50);
}
function closeNavPanel() { navPanel.classList.remove('on'); navInput.blur(); paused = false; last = performance.now(); }
function renderResults(list, msg) {
  navResults.innerHTML = '';
  if (msg) { const d = document.createElement('div'); d.className = 'navMsg'; d.textContent = msg; navResults.appendChild(d); }
  for (const r of list) {
    const b = document.createElement('button'); b.className = 'navRes';
    const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = r.icon || '📍';
    const tx = document.createElement('span'); tx.className = 'tx';
    const t1 = document.createElement('b'); t1.textContent = r.title;
    const t2 = document.createElement('small'); t2.textContent = [r.sub, fmtDist(Math.hypot(r.x - S.x, r.z - S.z)) + ' away'].filter(Boolean).join(' · ');
    tx.append(t1, t2); b.append(ic, tx);
    b.onclick = () => {
      closeNavPanel();
      if (r.x < MINX || r.x > MAXX || r.z < MINZ || r.z > MAXZ) { toast('That place is outside the drivable area'); return; }
      startNav(r.x, r.z, r.title);
    };
    navResults.appendChild(b);
  }
}
function nearbyCategory(c) {
  const list = allPois().filter(p => p.c === c).map(p => ({ title: p.name, sub: POI_CATS[p.c], icon: POI_ICONS[p.c], x: p.x, z: p.z, d: Math.hypot(p.x - S.x, p.z - S.z) }));
  list.sort((a, b) => a.d - b.d);
  renderResults(list.slice(0, 12), list.length ? '' : `No ${POI_CATS[c].toLowerCase()} spots loaded nearby yet — try searching by name`);
}
async function doSearch() {
  const q = navInput.value.trim(); if (q.length < 2) return;
  const ql = q.toLowerCase();
  const local = allPois().filter(p => p.name.toLowerCase().includes(ql)).map(p => ({ title: p.name, sub: POI_CATS[p.c] + ' · nearby', icon: POI_ICONS[p.c], x: p.x, z: p.z, d: Math.hypot(p.x - S.x, p.z - S.z) }))
    .sort((a, b) => a.d - b.d).slice(0, 4);
  renderResults(local, 'Searching…');
  try {
    const vb = `${B.W},${B.N},${B.E},${B.S}`;
    const r = await timedFetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&countrycodes=us&bounded=1&viewbox=${vb}&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en' } }, 12000);
    const arr = r.ok ? await r.json() : [];
    const found = arr.map(p => {
      const a = p.address || {};
      const street = [a.house_number, a.road].filter(Boolean).join(' ');
      const named = p.name && p.name !== a.road;
      const town = a.city || a.town || a.village || a.suburb || '';
      const [x, z] = ll2xz(+p.lat, +p.lon);
      return { title: named ? p.name : (street || p.display_name.split(',')[0]), sub: [named ? street : '', town].filter(Boolean).join(', '), icon: '📍', x, z };
    });
    renderResults([...local, ...found], local.length + found.length ? '' : 'No matches in the drivable area');
  } catch { renderResults(local, local.length ? '' : 'Address search is busy — try again in a moment'); }
}
$('navGo').onclick = doSearch;
navInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } e.stopPropagation(); });
navInput.addEventListener('keyup', e => e.stopPropagation());
$('navClose').onclick = closeNavPanel;
document.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => nearbyCategory(+b.dataset.cat));
$('btnNav').onclick = openNavPanel;
$('navEnd').onclick = () => endNav('Navigation ended');

// ───────────────────────── life: money, your apartment, your cars, gas, weekly bills ─────────────────────────
// Prices are 2026 Twin Cities figures: average rents by city/neighbourhood (RentCafe, Sept–Oct 2026), new/used car
// prices (Kelley Blue Book), Minnesota gas ($4.18/gal, Oct 2026), 6.875% vehicle sales tax. Game time: a week is 7 game
// days (one game hour per real minute); rent is charged weekly at the monthly rate × 12 / 52.
const RENT_AREAS = [ // average monthly rent (all unit sizes)
  ['Downtown Minneapolis', 44.9765, -93.2700, 2016], ['North Loop', 44.9880, -93.2760, 2159], ['Uptown', 44.9490, -93.2980, 1734], ['Loring Park', 44.9690, -93.2830, 1448],
  ['Lowry Hill', 44.9660, -93.2930, 1457], ['Cedar-Isles-Dean', 44.9600, -93.3110, 2565], ['Whittier', 44.9550, -93.2790, 1334], ['Stevens Square', 44.9610, -93.2740, 1053],
  ['Phillips', 44.9550, -93.2600, 1369], ['Seward', 44.9600, -93.2350, 1203], ['Longfellow', 44.9400, -93.2200, 1304], ['Linden Hills', 44.9250, -93.3200, 1302],
  ['Dinkytown', 44.9810, -93.2360, 2098], ['Marcy-Holmes', 44.9870, -93.2480, 2019], ['Northeast', 45.0050, -93.2600, 1550], ['Near North', 44.9900, -93.3000, 1852],
  ['Richfield', 44.8833, -93.2830, 1449], ['St. Paul', 44.9497, -93.0925, 1545], ['St. Louis Park', 44.9483, -93.3480, 1816], ['Edina', 44.8897, -93.3499, 1873],
  ['Bloomington', 44.8408, -93.2983, 1691], ['Burnsville', 44.7677, -93.2777, 1555], ['Plymouth', 45.0105, -93.4555, 1809], ['Minnetonka', 44.9133, -93.4700, 2052],
  ['Eagan', 44.8041, -93.1669, 1686], ['Eden Prairie', 44.8547, -93.4708, 1812], ['Maple Grove', 45.0725, -93.4558, 2284], ['Woodbury', 44.9239, -92.9594, 2168],
  ['Oakdale', 44.9630, -92.9649, 1802], ['Maplewood', 44.9530, -92.9952, 1474], ['Roseville', 45.0061, -93.1566, 1478], ['West St. Paul', 44.9161, -93.1016, 1405],
  ['Brooklyn Park', 45.0941, -93.3563, 1415], ['Brooklyn Center', 45.0761, -93.3327, 1361], ['Robbinsdale', 45.0322, -93.3386, 1523], ['Fridley', 45.0861, -93.2633, 1493],
  ['New Brighton', 45.0655, -93.2019, 1373], ['Golden Valley', 45.0097, -93.3491, 1700], ['Hopkins', 44.9247, -93.4180, 1650], ['Crystal', 45.0327, -93.3602, 1450],
  ['New Hope', 45.0380, -93.3866, 1450], ['Savage', 44.7792, -93.3366, 1650], ['Mendota Heights', 44.8836, -93.1383, 1800], ['South St. Paul', 44.8927, -93.0350, 1350],
  ['Inver Grove Heights', 44.8480, -93.0427, 1500], ['North St. Paul', 45.0125, -92.9919, 1400], ['Shoreview', 45.0791, -93.1472, 1600], ['White Bear Lake', 45.0847, -93.0099, 1450],
].map(([n, la, lo, rent]) => { const [x, z] = proj(la, lo); return { n, x, z, rent }; });
const rentArea = (x, z) => { let b = RENT_AREAS[0], bd = 1e18; for (const a of RENT_AREAS) { const d = (a.x - x) ** 2 + (a.z - z) ** 2; if (d < bd) { bd = d; b = a; } } return b; };
const UNITS = [['Studio', 0.84], ['1 bedroom', 1], ['2 bedroom', 1.3]];
const aptFactor = a => a.h > 45 ? 1.15 : a.h > 20 ? 1.05 : a.h < 12 ? 0.9 : 1;
// houses: RentCafe's Minneapolis house average ($2,543, Oct 2026) runs about 1.48× the city's apartment average ($1,720),
// so a 3-bedroom house rents for ~1.48× the local apartment average; 2- and 4-bedroom houses scale from there
const houseBeds = hs => hs.area < 110 ? 2 : hs.area < 175 ? 3 : 4;
const houseRent = hs => Math.round(rentArea(hs.x, hs.z).rent * { 2: 1.2, 3: 1.48, 4: 1.8 }[houseBeds(hs)] / 5) * 5;
const houseName = hs => { const nr = nearestRoad(hs.x, hs.z, 70); return nr && nr.road.name ? `House on ${nr.road.name}` : `House in ${rentArea(hs.x, hs.z).n}`; };
const aptRent = (a, u) => Math.round(rentArea(a.x, a.z).rent * UNITS[u][1] * aptFactor(a) / 5) * 5;
// the lineup: knock-off names, 2026 prices. type → model and handling (CARS); used cars are older and cheaper
const CATALOG = [
  { k: 'u-beater', type: 'beater', name: '2009 Midsize Sedan', year: 2009, price: 6800, used: true },
  { k: 'u-hatch', type: 'hatch', name: '2015 Hondah Civvy', year: 2015, price: 11900, used: true },
  { k: 'u-van', type: 'van', name: '2017 Chryzler Pacifico', year: 2017, price: 14500, used: true },
  { k: 'u-pickup', type: 'pickup', name: '2013 Ferd F-15', year: 2013, price: 15900, used: true },
  { k: 'u-suv', type: 'suv', name: '2016 Toyoda Rav-Fore', year: 2016, price: 16500, used: true },
  { k: 'hatch', type: 'hatch', name: '2026 Hondah Civvy', year: 2026, price: 25400 },
  { k: 'sedan', type: 'sedan', name: '2026 Toyoda Kamry', year: 2026, price: 29800 },
  { k: 'suv', type: 'suv', name: '2026 Toyoda Rav-Fore', year: 2026, price: 31900 },
  { k: 'van', type: 'van', name: '2026 Chryzler Pacifico', year: 2026, price: 44400 },
  { k: 'pickup', type: 'pickup', name: '2026 Ferd F-15', year: 2026, price: 45500 },
  { k: 'lux', type: 'lux', name: '2026 Lexxus ES', year: 2026, price: 49900 },
  { k: 'sport', type: 'sport', name: '2026 Corvetta Stingrey', year: 2026, price: 69800 },
];
const MPG = { beater: 24, hatch: 33, sedan: 32, suv: 28, pickup: 20, van: 24, lux: 26, sport: 18 }, TANK = 14, GAS = 4.18, TAX = 0.06875;
const INSURE_WK = 37, APR = 0.075, LOAN_MONTHS = 60, DELIVERY = 499;
const NOT_DEALER = /\b(parts|zone|wash|repair|tire|tires|glass|body|collision|service|rental|rent-a|lube|oil|detail|insurance|audio|upholstery)\b/i;
const DEALER_RE = /\b(toyota|honda|ford|chevrolet|chevy|nissan|hyundai|kia|subaru|bmw|mercedes|audi|lexus|volkswagen|vw|mazda|chrysler|dodge|jeep|ram|buick|gmc|cadillac|lincoln|volvo|tesla|porsche|acura|infiniti|genesis|mitsubishi|carmax|carvana|auto sales|motors|dealership|autos?)\b/i;
const money = v => (v < 0 ? '−$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US');
const life = (() => {
  const L = LIFE;
  function plate() { const A = 'ABCDEFGHJKLMNPRSTUVWXYZ'; let p = ''; for (let i = 0; i < 3; i++) p += A[(Math.random() * A.length) | 0]; return p + '-' + String(100 + ((Math.random() * 900) | 0)); }
  for (const c of L.cars) { if (c.fuel == null) c.fuel = TANK * 0.6; if (!c.plate) c.plate = plate(); if (c.paid == null) c.paid = 6800; }
  let dirty = false, saveT = 0;
  const save = () => { dirty = false; try { localStorage.setItem(LIFE_KEY, JSON.stringify(L)); } catch {} };
  const touch = () => { dirty = true; };
  const note = (a, d) => { L.log.unshift({ h: L.hours, a, d }); if (L.log.length > 60) L.log.length = 60; };
  const pay = (amt, desc) => { L.money -= amt; note(-amt, desc); touch(); hud(); };
  const earn = (amt, desc) => { L.money += amt; note(amt, desc); touch(); hud(); };
  function hud() {
    const on = LIFE_ON() && started; document.body.classList.toggle('life', on); document.body.classList.toggle('jobcar', on && !!(L.jobCar || L.hot));
    if (!on) return;
    const el = $('money'); el.textContent = money(L.money); el.classList.toggle('neg', L.money < 0);
    const c = L.cars[L.active]; $('fuelFill').style.width = c ? Math.max(0, Math.min(100, c.fuel / TANK * 100)).toFixed(0) + '%' : '0%';
    $('fuelBox').classList.toggle('low', !!c && c.fuel < TANK * 0.12);
  }
  const weekly = () => {
    const rent = L.home ? Math.round(L.home.rent * 12 / 52) : 0; let loans = 0;
    for (const c of L.cars) if (c.loan && c.loan.left > 0) loans += c.loan.weekly;
    const ins = INSURE_WK * L.cars.length;
    return { rent, loans: Math.round(loans), ins, total: rent + Math.round(loans) + ins };
  };
  // ── the clock: bills every 7 game days ──
  function tick(dtHours) {
    if (!LIFE_ON() || !started) return;
    L.hours += dtHours;
    if (!L.lastBill) L.lastBill = L.hours;
    if (L.hours - L.lastBill >= 168) {
      L.lastBill += 168;
      const w = weekly();
      if (w.rent) pay(w.rent, `Rent — ${L.home.name}`);
      for (const c of L.cars) if (c.loan && c.loan.left > 0) { const amt = Math.min(c.loan.weekly, c.loan.left); c.loan.left -= amt; pay(amt, `Car payment — ${c.name}`); }
      if (w.ins) pay(w.ins, 'Car insurance');
      if (L.money < 0) { pay(35, 'Overdraft fee'); L.late = (L.late || 0) + 1; } else L.late = 0;
      if (L.late >= 2) evict();
      toast(`Weekly bills: ${money(w.total)} · balance ${money(L.money)}`);
    }
    saveT -= dtHours * 60;
    if (saveT <= 0) { saveT = 20; L.pos = { x: S.x, z: S.z, h: S.h }; save(); }
  }
  function evict() {
    L.late = 0;
    if (L.home) { toast(`Evicted from ${L.home.name} — two weeks behind`); L.home = null; }
    const fin = L.cars.findIndex(c => c.loan && c.loan.left > 0);
    if (fin >= 0 && L.cars.length > 1) { toast(`${L.cars[fin].name} repossessed`); removeCar(fin); }
    touch();
  }
  function removeCar(i) {
    const was = L.active;
    L.cars.splice(i, 1);
    if (was === i) { L.active = 0; setCar(); terrainizeScene(); } else if (was > i) L.active = was - 1;
    touch();
  }
  // ── fuel: burned by distance, refilled at gas stations ──
  let lastX = null, lastZ = null;
  function burn() {
    const c = L.cars[L.active]; if (!c || S.mode === 'foot' || !LIFE_ON() || !started || L.jobCar || L.hot) { lastX = null; return; }
    if (lastX !== null) { const d = Math.hypot(S.x - lastX, S.z - lastZ); if (d < 200) c.fuel = Math.max(0, c.fuel - d * (1 - 0.03 * jobs.sk('drive')) / ((MPG[c.type] || 25) * 1609)); }
    lastX = S.x; lastZ = S.z;
    if (c.fuel <= 0 && !L.emptyWarned) { L.emptyWarned = true; toast('Out of gas — walk to a gas station, or order roadside gas on your phone'); }
    if (c.fuel > 0.3) L.emptyWarned = false;
  }
  const outOfGas = () => LIFE_ON() && S.mode !== 'foot' && !L.jobCar && !L.hot && !!L.cars[L.active] && L.cars[L.active].fuel <= 0;
  // ── what's around you: gas stations, dealers, apartment buildings ──
  function nearby(kind, R) {
    let best = null, bd = R;
    for (const t of tiles.values()) {
      if (kind === 'apt') { for (const a of t.apts || []) { const d = Math.hypot(a.x - S.x, a.z - S.z); if (d < bd) { bd = d; best = a; } } continue; }
      for (const p of t.pois || []) {
        if (kind === 'gas' ? p.c !== 2 : !(p.c === 3 && DEALER_RE.test(p.name) && !NOT_DEALER.test(p.name))) continue;
        const d = Math.hypot(p.x - S.x, p.z - S.z); if (d < bd) { bd = d; best = p; }
      }
    }
    return best;
  }
  let act = null; // the action for where you are, shown on the action button (E)
  function scan() {
    const btn = $('actBtn');
    if (!LIFE_ON() || !started || paused) { if (act) { act = null; btn.classList.remove('on'); } return; }
    const spd = Math.hypot(S.vx, S.vz), c = L.cars[L.active];
    if (inside.on) { const a = inside.action(); if ((a && a.label) !== (act && act.label)) { act = a; btn.textContent = a ? a.label : ''; btn.classList.toggle('on', !!a); } return; }
    let a = story.action() || jobs.action() || hustle.action();
    if (a) {} else if (L.home && Math.hypot(L.home.x - S.x, L.home.z - S.z) < (L.home.kind === 'house' ? 30 : 50) && spd < 2) a = { label: `🚪 Go inside${L.home.kind === 'house' ? '' : ' · ' + L.home.unit}`, fn: () => inside.enter() };
    else if (S.mode !== 'foot' && spd < 1.5 && c && c.fuel < TANK - 0.5) { const g = nearby('gas', 30); if (g) a = { label: `⛽ Fill up · ${money((TANK - c.fuel) * GAS)}`, fn: fillUp }; }
    if (!a && spd < 3) { const d = nearby('dealer', 70); if (d) a = { label: `🚗 Shop at ${d.name}`, fn: () => phone.open('cars') }; }
    if (!a && spd < 2 && S.mode === 'foot') { const ap = nearby('apt', 45); if (ap && !(L.home && Math.hypot(L.home.x - ap.x, L.home.z - ap.z) < 5)) a = { label: `🏢 ${ap.name || 'Apartments'} · see units`, fn: () => phone.open('homes', ap) }; }
    if ((a && a.label) !== (act && act.label)) { act = a; btn.textContent = a ? a.label : ''; btn.classList.toggle('on', !!a); }
  }
  function doAction() { if (act) act.fn(); }
  function fillUp() {
    const c = L.cars[L.active]; if (!c) return;
    const gal = TANK - c.fuel, cost = gal * GAS;
    if (L.money < cost) { const can = Math.max(0, L.money / GAS); if (can < 0.5) { toast("You can't afford gas"); return; } c.fuel += can; pay(can * GAS, `Gas ${can.toFixed(1)} gal`); toast(`Put in ${can.toFixed(1)} gal — all you could afford`); return; }
    c.fuel = TANK; pay(cost, `Gas ${gal.toFixed(1)} gal @ $${GAS}`); toast(`Filled up: ${gal.toFixed(1)} gal, ${money(cost)}`); buzz(20);
  }
  function sleep() {
    jobs.syncDay();
    const h = tod, d = jobs.today(), wT = jobs.wakeFor(d), wake = h < wT - 0.1 ? wT : jobs.wakeFor(d + 1), add = h < wake ? wake - h : 24 + wake - h;
    tod = wake; applyTime(tod); jobs.syncDay(); if (h >= wake) { /* crossed midnight */ } tick(add);
    L.pos = { x: S.x, z: S.z, h: S.h }; save();
    toast(`Slept ${Math.round(add)} hours · it's ${clockText()} · game saved${L.job ? ' · next shift ' + (jobs.nextShift() || {}).label : ''}`); flashTag('GOOD MORNING');
  }
  // ── signing a lease, buying and selling cars ──
  function rentHome(ap, unit) {
    const rent = aptRent(ap, unit), wk = Math.round(rent * 12 / 52), deposit = rent + wk, area = rentArea(ap.x, ap.z);
    if (L.money < deposit) { toast(`You need ${money(deposit)} for the deposit and first week`); return; }
    if (L.home && !confirm(`Move out of ${L.home.name}?`)) return;
    pay(rent, `Security deposit — ${ap.name || 'apartment'}`); pay(wk, `First week's rent`);
    L.home = { name: ap.name || `Apartments in ${area.n}`, x: ap.x, z: ap.z, rent, unit: UNITS[unit][0], area: area.n, kind: 'apt', beds: unit };
    L.lastBill = L.hours; touch(); save();
    toast(`Welcome home: ${L.home.unit} at ${L.home.name}`); flashTag('NEW HOME'); story.emit('rent');
  }
  function rentHouse(hs) {
    const rent = houseRent(hs), wk = Math.round(rent * 12 / 52), deposit = rent + wk, area = rentArea(hs.x, hs.z), beds = houseBeds(hs);
    if (L.money < deposit) { toast(`You need ${money(deposit)} for the deposit and first week`); return; }
    if (L.home && !confirm(`Move out of ${L.home.name}?`)) return;
    const name = houseName(hs);
    pay(rent, `Security deposit — ${name}`); pay(wk, `First week's rent`);
    L.home = { name, x: hs.x, z: hs.z, rent, unit: `${beds}-bedroom house`, area: area.n, kind: 'house', beds };
    L.lastBill = L.hours; touch(); save();
    toast(`Welcome home: ${L.home.unit} — ${name}`); flashTag('NEW HOME'); story.emit('rent');
  }
  function quote(it) {
    const tax = Math.round(it.price * TAX), total = it.price + tax, down = Math.round(total * 0.1);
    const apr = Math.max(0.035, APR - 0.0025 * jobs.sk('biz')), r = apr / 12, m = (total - down) * r / (1 - Math.pow(1 + r, -LOAN_MONTHS));
    return { tax, total, down, monthly: Math.round(m), weekly: Math.round(m * 12 / 52), owed: Math.round(m * LOAN_MONTHS) };
  }
  function buyCar(it, finance, atDealer, color) {
    const q = quote(it), fee = atDealer ? 0 : DELIVERY, up = (finance ? q.down : q.total) + fee;
    if (L.money < up) { toast(`You need ${money(up)}${finance ? ' down' : ''}`); return false; }
    pay(finance ? q.down : q.total, `${finance ? 'Down payment' : 'Bought'} — ${it.name}`); if (fee) pay(fee, 'Delivery');
    L.cars.push({ id: L.nextId++, type: it.type, name: it.name, year: it.year, color: color || '#c9ccd1', fuel: TANK, plate: plate(), paid: it.price, loan: finance ? { left: q.owed, weekly: q.weekly } : null });
    touch(); save();
    toast(`${it.name} is yours${finance ? ` — ${money(q.weekly)}/week for 5 years` : ''} · find it in Garage`); flashTag('NEW CAR');
    return true;
  }
  const atHome = () => !!L.home && Math.hypot(L.home.x - S.x, L.home.z - S.z) < 80;
  function switchCar(i) {
    if (i === L.active) return;
    if (L.jobCar) { toast('Finish your shift first (go offline)'); return; }
    if (L.hot) police.dropHot();
    if (S.mode === 'foot') { toast('Get in your car first'); return; }
    if (!atHome()) { if (L.money < 60) { toast('Valet delivery costs $60'); return; } pay(60, 'Valet: car swap'); }
    L.active = i; touch(); setCar(); terrainizeScene(); hud(); toast(`Driving the ${L.cars[i].name}`);
  }
  function sellValue(c) { const age = Math.max(0, 2026 - c.year); return Math.round((c.paid || 8000) * Math.max(0.25, 0.8 - age * 0.05) / 50) * 50; }
  function sellCar(i) {
    const c = L.cars[i]; if (L.cars.length < 2) { toast("You can't sell your only car"); return; }
    const val = sellValue(c), owe = c.loan ? c.loan.left : 0;
    if (!confirm(`Sell the ${c.name} for ${money(val)}${owe ? ` (pays off the ${money(owe)} loan)` : ''}?`)) return;
    earn(val, `Sold ${c.name}`); if (owe) pay(owe, `Loan payoff — ${c.name}`);
    removeCar(i); save();
  }
  function gasCan() { const c = L.cars[L.active]; if (!c) return; if (L.money < 45) { toast('Roadside gas costs $45'); return; } pay(45, 'Roadside gas (2 gal)'); c.fuel = Math.min(TANK, c.fuel + 2); toast('2 gallons delivered'); hud(); }
  return { rentHouse, sleepNow: sleep, L, tick, burn, scan, doAction, hud, weekly, rentHome, quote, buyCar, switchCar, sellCar, sellValue, save, outOfGas, nearby, pay, earn, touch, gasCan, atHome };
})();
// ── the phone: Bank, Homes, Cars, Garage ──
const phone = (() => {
  const P = $('phone'), body = $('phoneBody'), tabs = [...P.querySelectorAll('[data-tab]')];
  let tab = 'bank', ctx = null, apts = [], houses = [], dealer = false;
  const L = LIFE, esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = h => { const d = L.hours - h; return d < 1 ? 'just now' : d < 24 ? `${Math.round(d)} h ago` : `${Math.round(d / 24)} d ago`; };
  function render() {
    tabs.forEach(b => b.classList.toggle('sel', b.dataset.tab === tab));
    const w = life.weekly(), due = Math.max(0, 168 - (L.hours - (L.lastBill || L.hours)));
    let h = '';
    if (tab === 'bank') {
      h += `<div class="pBig ${L.money < 0 ? 'neg' : ''}">${money(L.money)}</div><div class="pSub">Checking · ${jobs.WD[jobs.today() % 7]}, day ${jobs.today() + 1} · ${clockText()}</div>`;
      h += `<div class="pCard"><b>Weekly bills</b><span class="pR">due in ${due < 24 ? Math.round(due) + ' h' : Math.round(due / 24) + ' days'}</span>`;
      h += `<div class="pRow">Rent<span>${money(w.rent)}</span></div><div class="pRow">Car loans<span>${money(w.loans)}</span></div><div class="pRow">Insurance<span>${money(w.ins)}</span></div><div class="pRow tot">Total<span>${money(w.total)}</span></div></div>`;
      h += '<div class="pHead">Activity</div>' + (L.log.length ? L.log.map(e => `<div class="pRow">${esc(e.d)} <small>${ago(e.h)}</small><span class="${e.a < 0 ? 'neg' : 'pos'}">${e.a < 0 ? '−' : '+'}${money(Math.abs(e.a))}</span></div>`).join('') : '<div class="pSub">Nothing yet.</div>');
      h += `<button class="pBtn ghost" data-act="gascan">⛽ Roadside gas delivery · $45</button>`;
    } else if (tab === 'jobs') {
      const j = L.job, g = jobs.gig();
      if (g) { const G = jobs.G(g.k); h += `<div class="pCard ok"><b>${G.ic} Online: ${esc(G.name)}</b><div class="pSub">${L.gigsDone || 0} jobs done · the clock runs slower while you work</div><button class="pBtn sm" data-act="offline">Go offline</button></div>`; }
      if (j) {
        const lad = jobs.LAD(j.lad), rk = lad.ranks[j.rank], nx = lad.ranks[j.rank + 1], st = jobs.status().k, sc = lad.sched, ns = jobs.nextShift();
        h += `<div class="pCard ok"><b>${lad.ic} ${esc(rk.t)}</b><span class="pR">${money(rk.w * jobs.payMult())}/hr</span><div class="pSub">${esc(j.where)} · ${j.total} shift${j.total === 1 ? '' : 's'} worked</div>`;
        h += `<div class="sched">${jobs.WD.map((d, i) => `<i class="${sc.days.includes(i) ? 'on' : ''}${i === jobs.today() % 7 ? ' now' : ''}">${d[0]}</i>`).join('')}<span>${jobs.fh(sc.start)}–${jobs.fh(sc.start + SHIFT_H)}</span></div>`;
        h += `<div class="pSub"><b>${st === 'now' || st === 'late' ? '🟢 Clock in now' + (st === 'late' ? ' (you’re late!)' : '') : 'Next shift: ' + (ns ? ns.label : '—')}</b>${j.strikes ? ` · ⚠️ ${j.strikes}/3 strikes` : ''}</div>`;
        if (nx) h += `<div class="pSub">Next: <b>${esc(nx.t)}</b> (${money(nx.w)}/hr) — ${Math.min(j.shifts, PROMO_SHIFTS)}/${PROMO_SHIFTS} shifts${jobs.meets(nx.req) ? ' · skills ✓' : ' · needs ' + jobs.reqText(nx.req)}</div>`;
        else h += '<div class="pSub">Top of the ladder.</div>';
        h += `<div class="pUnits"><button class="pBtn sm" data-act="navwork">Navigate to work</button><button class="pBtn sm ghost" data-act="quit">Quit</button></div></div>`;
      } else {
        h += `<div class="pCard ok"><b>👋 How to make money</b><div class="pSub"><b>1.</b> Tap <b>Apply</b> on a job below. <b>2.</b> Tap <b>Navigate to work</b> and drive there. <b>3.</b> Each job has a schedule — be there by your start time and tap the orange <b>🕐 Clock in</b> button. You work 8 hours and get paid. Miss 3 shifts and you’re fired.<br>Or tap <b>Go online</b> on a gig and follow the green beam.</div></div>`;
        h += '<div class="pHead">Hiring now · you qualify</div>';
        LADDERS.forEach(lad => {
          let r = -1; lad.ranks.forEach((rk, i) => { if (jobs.meets(rk.req)) r = i; });
          if (r < 0) return;
          const rk = lad.ranks[r];
          h += `<div class="pCard"><b>${lad.ic} ${esc(rk.t)}</b><span class="pR">${money(rk.w)}/hr</span><div class="pSub">${esc(lad.emp)} · ${money(rk.w * SHIFT_H)} a shift · ${jobs.daysText(lad.sched)} ${jobs.fh(lad.sched.start)}–${jobs.fh(lad.sched.start + SHIFT_H)}</div><button class="pBtn" data-act="apply" data-k="${lad.k}" data-r="${r}">Apply</button></div>`;
        });
      }
      h += '<div class="pHead">Gigs · drive for pay</div>';
      GIGS.forEach(G => {
        const ok = jobs.meets(G.req), on = g && g.k === G.k;
        h += `<div class="pCard"><b>${G.ic} ${esc(G.name)}</b><div class="pSub">${esc(G.desc)}</div>${on ? '' : ok ? `<button class="pBtn sm" data-act="online" data-k="${G.k}">Go online</button>` : `<div class="pSub lock">🔒 Needs ${jobs.reqText(G.req)}</div>`}</div>`;
      });
      h += '<div class="pHead">Career ladders · skills unlock the next rung</div>';
      LADDERS.forEach(lad => {
        h += `<div class="pCard"><b>${lad.ic} ${esc(lad.emp)}</b><span class="pR">${jobs.daysText(lad.sched)} · ${jobs.fh(lad.sched.start)}</span>`;
        lad.ranks.forEach((rk, r) => {
          const mine = j && j.lad === lad.k && j.rank === r, ok = jobs.meets(rk.req);
          h += `<div class="pRow">${mine ? '✅ ' : ok ? '' : '🔒 '}${esc(rk.t)}${ok || mine ? '' : ` <small>${jobs.reqText(rk.req)}</small>`}<span>${money(rk.w)}/hr${ok && !mine ? ` <button class="pBtn sm mini" data-act="apply" data-k="${lad.k}" data-r="${r}">Apply</button>` : ''}</span></div>`;
        });
        h += '</div>';
      });
    } else if (tab === 'texts') {
      story.read(); const st = story.st(), m = story.cur();
      h += m && !st.pending ? `<div class="pCard ok"><b>📖 ${esc(m.title)}</b><div class="pSub">${esc(m.goal)}</div></div>` : st.done ? '<div class="pCard ok"><b>🏆 You run this town</b><div class="pSub">The story’s done — the city’s yours to play in.</div></div>' : '';
      h += '<div class="chat">' + (st.msgs.length ? st.msgs.map(x => `<div class="bub"><small>${esc(x.from)}</small>${esc(x.msg)}</div>`).join('') : '<div class="pSub">No messages yet.</div>') + '</div>';
      h += `<div class="pSub" style="margin-top:12px">Story ${Math.min(st.i, STORY.length)}/${STORY.length} · <a href="#" data-act="storyreset" style="color:var(--accent)">restart story</a></div>`;
    } else if (tab === 'hustle') {
      const lv = hustle.repLvl(), nx = (lv + 1) * 100;
      h += `<div class="pBig lv" style="color:#b36bff">Street rep ${lv}</div><div class="xpBar"><i style="width:${lv >= 10 ? 100 : ((L.rep % 100)).toFixed(0)}%;background:#b36bff"></i></div><div class="pSub">${L.rep} rep${lv < 10 ? ` · ${nx - L.rep} to level ${lv + 1}` : ''} · every level makes hustles pay 6% more. Cops don’t like any of this.</div>`;
      const nav = (s, label) => `<button class="pBtn ghost sm" data-act="navspot" data-x="${s.x.toFixed(0)}" data-z="${s.z.toFixed(0)}" data-n="${esc(s.n)}">${label || 'Navigate'} · ${fmtDist(Math.hypot(s.x - S.x, s.z - S.z))}</button>`;
      h += `<div class="pCard"><b>📦 Package runs</b><span class="pR">${money(Math.round(450 * hustle.repMult()))}+</span><div class="pSub">Dre texts you a pickup behind a local business and a drop across town. Beat the clock; patrol cars may get curious.</div>${hustle.active() ? '<div class="pSub">You’re busy with a hustle right now.</div>' : '<button class="pBtn sm" data-act="pkg">Text Dre for work</button>'}</div>`;
      { // guns and contracts
        const G2 = Object.entries(GUNS);
        h += `<div class="pCard"><b>🔫 Dre’s black market</b><div class="pSub">Delivered to wherever you are. Switch weapons with the weapon button (Q on a keyboard); on foot you auto-aim at the nearest threat in front of you and hold FIRE (K or click). Getting busted means losing your guns.</div>`;
        for (const [k, g] of G2) { const have = L.guns && L.guns[k] != null; h += `<div class="pRow">${g.ic} ${g.n}${have ? ` <small>${L.guns[k]} rounds</small>` : ''}<span>${have ? `<button class="pBtn sm mini" data-act="ammo" data-k="${k}">+${g.pack} · ${money(g.packPrice)}</button>` : `<button class="pBtn sm mini" data-act="gun" data-k="${k}">Buy · ${money(g.price)}</button>`}</span></div>`; }
        h += '</div>';
        const c = combat.offer();
        if (c) {
          h += `<div class="pCard${c.accepted ? ' ok' : ''}"><b>☎️ The Broker</b><span class="pR">${money(c.pay)}</span><div class="pSub">Contract: <b>${esc(c.name)}</b> — ${esc(c.why)}. Last seen around ${esc(c.place)}. ${c.guards ? `Has ${c.guards} bodyguard${c.guards > 1 ? 's' : ''}, armed.` : 'Alone.'} Expect 3 stars when it’s done.</div>`;
          h += c.accepted ? `<div class="pUnits"><button class="pBtn sm" data-act="navspot" data-x="${c.x.toFixed(0)}" data-z="${c.z.toFixed(0)}" data-n="${esc(c.place)}">Navigate · ${fmtDist(Math.hypot(c.x - S.x, c.z - S.z))}</button><button class="pBtn sm ghost" data-act="cfail">Walk away</button></div>` : `<button class="pBtn sm" data-act="contract">Take the contract</button>`;
          h += '</div>';
        }
      }
      const ch = hustle.nearest('chop');
      h += `<div class="pCard"><b>🔧 Chop shops</b><div class="pSub">Steal a car (walk up to a stopped one and press F), then drive it to a chop shop for cash — ${money(Math.round(350 * hustle.repMult()))} for a beater up to ${money(Math.round(3200 * hustle.repMult()))} for a sports car. They’ll give you a ride back to your own car.</div><div class="pSub">Nearest: ${esc(ch.n.replace(/ \(.*/, ''))}</div><div class="pUnits">${nav(ch)}</div></div>`;
      const rc = hustle.nearest('race'), open = hustle.night(20, 4);
      h += `<div class="pCard"><b>🏁 Street races</b><span class="pR">${open ? '🟢 tonight' : '8 PM–4 AM'}</span><div class="pSub">Buy in for ${money(Math.min(1000, 100 + lv * 100))}, race a local through 6 checkpoints, winner takes the pot. Somebody usually calls the cops.</div><div class="pSub">Nearest: ${esc(rc.n.replace('Street race — ', ''))}</div><div class="pUnits">${nav(rc)}</div></div>`;
      const cd = hustle.nearest('cards'), co = hustle.night(21, 3);
      h += `<div class="pCard"><b>🃏 Back-room blackjack</b><span class="pR">${co ? '🟢 open' : '9 PM–3 AM'}</span><div class="pSub">$25–$500 hands. Dealer stands on 17; blackjack pays 3:2. Occasionally raided.</div><div class="pSub">${esc(cd.n.replace('Back-room blackjack — ', ''))}</div><div class="pUnits">${nav(cd)}</div></div>`;
      { // the bookie
        const ls = hustle.lines(), open = (L.bets || []).filter(b => !b.done), stake = Math.min(500, 50 + lv * 50);
        h += `<div class="pCard"><b>📞 Sal the bookie</b><span class="pR">${money(stake)} a bet</span><div class="pSub">Sports betting still isn’t legal in Minnesota, so Sal runs his book off the record. Payouts are the odds × your stake; Sal keeps a cut.</div>`;
        ls.slice(0, 6).forEach(g => { h += `<div class="pRow">${g.k ? 'Tmrw' : 'Today'} ${jobs.fh(g.h)} · ${esc(g.team)}<span><button class="pBtn sm mini" data-act="bet" data-id="${esc(g.id)}" data-s="W" data-st="${stake}">Win ${g.oddsW}x</button><button class="pBtn sm mini ghost" data-act="bet" data-id="${esc(g.id)}" data-s="L" data-st="${stake}">Lose ${g.oddsL}x</button></span></div>`; });
        if (!ls.length) h += '<div class="pSub">No games on the board right now.</div>';
        if (open.length) h += `<div class="pSub"><b>Your action:</b> ${open.map(b => `${money(b.stake)} on ${esc(b.team)} to ${b.side === 'W' ? 'win' : 'lose'} (${b.odds}x)`).join(' · ')}</div>`;
        const last = (L.bets || []).filter(b => b.done).slice(-3);
        if (last.length) h += `<div class="pSub">Recent: ${last.map(b => `${esc(b.team)} ${b.won ? '✅' : '❌'}`).join(' · ')}</div>`;
        h += '</div>';
      }
      const ev = hustle.todaysEvents();
      h += `<div class="pCard"><b>🎟️ Ticket flipping</b><div class="pSub">Buy 4 tickets at face value outside the venue, then sell them to fans for more (from 3 hours before start). Reselling is legal in Minnesota, but venue security will walk you off their property.</div>`;
      if (ev.length) ev.forEach(({ v, e }) => { h += `<div class="pRow">${esc(e.t)} · ${esc(v.n)}<span>${jobs.fh(e.h)} ${tod >= e.h - 3 ? '🟢' : ''}</span></div>`; });
      else h += '<div class="pSub">No more events today.</div>';
      if (ev.length) h += `<div class="pUnits">${nav(ev[0].v, 'Go to ' + ev[0].v.n)}</div>`;
      h += '</div>';
    } else if (tab === 'skills') {
      const need = xpNeed(L.lv);
      h += `<div class="pBig lv">Level ${L.lv}</div><div class="xpBar"><i style="width:${(L.xp / need * 100).toFixed(0)}%"></i></div><div class="pSub">${Math.floor(L.xp)} / ${need} XP to level ${L.lv + 1} · gigs and shifts earn XP</div>`;
      h += `<div class="pCard${L.pts ? ' ok' : ''}"><b>${L.pts} skill point${L.pts === 1 ? '' : 's'} to spend</b><div class="pSub">You get one each level. Skills unlock jobs and promotions.</div></div>`;
      SKILLS.forEach(([k, n, ic, d]) => {
        const v = jobs.sk(k);
        h += `<div class="pCard"><b>${ic} ${n}</b><span class="pR">${v}/${SK_MAX}</span><div class="pips">${Array.from({ length: SK_MAX }, (_, i) => `<i class="${i < v ? 'on' : ''}"></i>`).join('')}</div><div class="pSub">${esc(d)}</div>${L.pts && v < SK_MAX ? `<button class="pBtn sm" data-act="spend" data-k="${k}">+1 ${n}</button>` : ''}</div>`;
      });
    } else if (tab === 'homes') {
      if (L.home) h += `<div class="pCard ok"><b>🏠 ${esc(L.home.name)}</b><div class="pSub">${esc(L.home.unit)} · ${esc(L.home.area)} · ${money(L.home.rent)}/month (${money(L.home.rent * 12 / 52)}/week)</div><div class="pSub">Get within a block of it and tap <b>🚪 Go inside</b> to walk around your place, sleep, or use the laptop.</div><button class="pBtn sm" data-act="navhome">Navigate home</button></div>`;
      else h += `<div class="pCard"><b>No place of your own yet</b><div class="pSub">You're crashing on a friend's couch. Rent an apartment and you get somewhere to sleep (skips to morning and saves the game) and to swap cars for free.</div></div>`;
      const list = [];
      for (const t of tiles.values()) for (const a of t.apts || []) { const d = Math.hypot(a.x - S.x, a.z - S.z); if (d < 3500) list.push({ a, d: a === ctx ? -1 : d - (a.name ? 400 : 0) }); }
      list.sort((x, y) => x.d - y.d);
      const seen = new Set(); apts = [];
      for (const it of list) { const k = (it.a.name || '') + Math.round(it.a.x / 80) + ',' + Math.round(it.a.z / 80); if (seen.has(k)) continue; seen.add(k); apts.push(it.a); if (apts.length >= 14) break; }
      { // houses
        const hl = []; for (const t of tiles.values()) for (const q of t.houses || []) { const d = Math.hypot(q.x - S.x, q.z - S.z); if (d < 2500) hl.push({ q, d }); }
        hl.sort((a, b) => a.d - b.d); houses = [];
        for (const it of hl) { if (houses.some(o => Math.hypot(o.x - it.q.x, o.z - it.q.z) < 120)) continue; houses.push(it.q); if (houses.length >= 5) break; }
        if (houses.length) {
          h += `<div class="pHead">Houses for rent</div>`;
          houses.forEach((q, i) => { const r = houseRent(q); h += `<div class="pCard"><b>🏡 ${esc(houseName(q))}</b><span class="pR">${fmtDist(Math.hypot(q.x - S.x, q.z - S.z))}</span><div class="pSub">${houseBeds(q)} bedrooms · ${rentArea(q.x, q.z).n} · ${Math.round(q.area * 10.76).toLocaleString()} sq ft</div><div class="pUnits"><button class="pBtn sm" data-act="renthouse" data-i="${i}">Rent · <b>${money(r)}</b>/mo</button><button class="pBtn ghost sm" data-act="navhouse" data-i="${i}">Navigate</button></div></div>`; });
        }
      }
      h += `<div class="pHead">Apartments for rent</div>`;
      if (!apts.length) h += '<div class="pSub">No apartment buildings mapped around here — try heading toward a city centre.</div>';
      apts.forEach((a, i) => {
        const area = rentArea(a.x, a.z), d = Math.hypot(a.x - S.x, a.z - S.z);
        h += `<div class="pCard"><b>${esc(a.name || 'Apartments')}</b><span class="pR">${fmtDist(d)}</span><div class="pSub">${esc(area.n)} · ${Math.max(2, Math.round(a.h / 3.2))} floors${a.h > 45 ? ' · luxury tower' : ''}</div><div class="pUnits">`;
        UNITS.forEach(([u], j) => { h += `<button class="pBtn sm" data-act="rent" data-i="${i}" data-u="${j}">${u}<br><b>${money(aptRent(a, j))}</b>/mo</button>`; });
        h += `</div><button class="pBtn ghost sm" data-act="navapt" data-i="${i}">Navigate</button></div>`;
      });
    } else if (tab === 'cars') {
      const dl = life.nearby('dealer', 90); dealer = !!dl;
      h += dl ? `<div class="pCard ok"><b>🚗 At ${esc(dl.name)}</b><div class="pSub">Buy here and drive it off the lot — no delivery fee.</div></div>` : `<div class="pSub">Shopping online adds ${money(DELIVERY)} delivery. Stop at a car dealership to skip the fee.</div>`;
      CATALOG.forEach((it, i) => {
        const q = life.quote(it), C = CARS[it.type], fee = dealer ? 0 : DELIVERY;
        h += `<div class="pCard"><b>${esc(it.name)}</b>${it.used ? ' <span class="pTag">USED</span>' : ''}<span class="pR">${money(it.price)}</span><div class="pSub">${C.label} · top ${Math.round(C.top * 2.237)} mph · ${MPG[it.type]} mpg · + ${money(q.tax)} tax</div>`;
        h += `<div class="pUnits"><button class="pBtn sm" data-act="buy" data-i="${i}">Pay ${money(q.total + fee)}</button><button class="pBtn sm ghost" data-act="fin" data-i="${i}">Finance · ${money(q.down + fee)} down<br>${money(q.weekly)}/week</button></div></div>`;
      });
    } else if (tab === 'garage') {
      L.cars.forEach((c, i) => {
        h += `<div class="pCard${i === L.active ? ' ok' : ''}"><b>${esc(c.name)}</b><span class="pR">${esc(c.plate)}</span><div class="pSub">${CARS[c.type] ? CARS[c.type].label : ''} · ⛽ ${Math.round(c.fuel / TANK * 100)}%${c.loan && c.loan.left > 0 ? ` · ${money(c.loan.left)} left on loan (${money(c.loan.weekly)}/wk)` : ' · paid off'} · worth ${money(life.sellValue(c))}</div>`;
        h += `<div class="pUnits">${i === L.active ? '<span class="pSub">Driving this one</span>' : `<button class="pBtn sm" data-act="drive" data-i="${i}">Drive this${life.atHome() ? '' : ' · $60 valet'}</button>`}<button class="pBtn sm ghost" data-act="sell" data-i="${i}">Sell</button></div></div>`;
      });
    }
    body.innerHTML = h;
  }
  body.onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act, i = +b.dataset.i;
    if (a === 'rent') { life.rentHome(apts[i], +b.dataset.u); render(); }
    else if (a === 'navapt') { const ap = apts[i]; close(); startNav(ap.x, ap.z, ap.name || 'Apartments'); }
    else if (a === 'navhome') { close(); startNav(LIFE.home.x, LIFE.home.z, LIFE.home.name); }
    else if (a === 'buy' || a === 'fin') { if (life.buyCar(CATALOG[i], a === 'fin', dealer, settings.color)) tab = 'garage'; render(); }
    else if (a === 'drive') { life.switchCar(i); render(); }
    else if (a === 'sell') { life.sellCar(i); render(); }
    else if (a === 'gascan') { life.gasCan(); render(); }
    else if (a === 'renthouse') { life.rentHouse(houses[i]); render(); }
    else if (a === 'navhouse') { const q = houses[i]; close(); startNav(q.x, q.z, houseName(q)); }
    else if (a === 'online') { close(); jobs.goOnline(b.dataset.k); }
    else if (a === 'offline') { jobs.goOffline(); render(); }
    else if (a === 'apply') { jobs.apply(b.dataset.k, +b.dataset.r); render(); }
    else if (a === 'quit') { jobs.quit(); render(); }
    else if (a === 'navwork') { close(); startNav(L.job.x, L.job.z, L.job.where); }
    else if (a === 'spend') { jobs.spend(b.dataset.k); render(); }
    else if (a === 'pkg') { close(); hustle.startRun(); }
    else if (a === 'storyreset') { e.preventDefault(); if (confirm('Restart the story from the beginning?')) story.reset(); }
    else if (a === 'gun') { combat.buy(b.dataset.k); render(); }
    else if (a === 'ammo') { combat.buy(b.dataset.k, true); render(); }
    else if (a === 'contract') { close(); combat.accept(); }
    else if (a === 'cfail') { combat.contractFail('You walked away from the contract'); render(); }
    else if (a === 'bet') { hustle.placeBet(b.dataset.id, b.dataset.s, +b.dataset.st); render(); }
    else if (a === 'navspot') { close(); startNav(+b.dataset.x, +b.dataset.z, b.dataset.n); }
  };
  tabs.forEach(b => b.onclick = () => { tab = b.dataset.tab; ctx = null; render(); });
  function open(t, c) { if (!LIFE_ON() || !started) return; if (t) tab = t; ctx = c || null; P.classList.add('on'); paused = true; render(); }
  function close() { P.classList.remove('on'); paused = false; last = performance.now(); }
  $('phoneClose').onclick = close; $('btnPhone').onclick = () => open();
  return { open, close, isOpen: () => P.classList.contains('on') };
})();
$('actBtn').onclick = () => life.doAction();
$('money').onclick = () => phone.open('bank');
$('lvPill').onclick = () => phone.open('skills');
$('objective').onclick = () => phone.open('texts');
window.__life = life; window.__phone = phone;
// ───────────────────────── on the clock: a short mini-game for each employer ─────────────────────────
// 60 seconds of the actual job. Performance (0–1) sets the paycheck (85%–120% of base) and how fast you earn a
// promotion; Skip pays base wages. Harder at higher ranks.
const shiftGame = (() => {
  const box = $('shift'), body = $('shBody'), elT = $('shTitle'), elTime = $('shTime'), elScore = $('shScore'), elHint = $('shHint');
  let G = null, timer = null;
  const pick = a => a[(Math.random() * a.length) | 0];
  const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const usd = v => '$' + v.toFixed(2);
  function feedback(ok, msg) {
    const f = document.createElement('div'); f.className = 'shFx ' + (ok ? 'ok' : 'no'); f.textContent = msg || (ok ? '✓' : '✗'); box.appendChild(f);
    setTimeout(() => f.remove(), 700); buzz(ok ? 12 : 40);
  }
  const ctx = {
    good(msg) { G.good++; feedback(true, msg); upd(); },
    bad(msg) { G.bad++; feedback(false, msg); upd(); },
  };
  function upd() { elScore.textContent = `✓ ${G.good}${G.bad ? '  ✗ ' + G.bad : ''}`; }
  // ── item timer bar shared by the games ──
  let itemT = 0, itemMax = 0, onItemOut = null;
  const setItem = (sec, fn) => { itemT = itemMax = sec; onItemOut = fn; };
  // ── Caribou: build the drink on the ticket ──
  function coffee(r) {
    const DR = ['Latte', 'Mocha', 'Americano', 'Cappuccino', 'Chai latte', 'Cold brew'], SZ = ['Small', 'Medium', 'Large'], MK = ['Whole', 'Oat', 'Skim', 'Almond'], SH = ['1 shot', '2 shots', '3 shots'];
    const groups = [['Drink', DR], ['Size', SZ]]; if (r >= 1) groups.push(['Milk', MK]); if (r >= 2) groups.push(['Espresso', SH]);
    let order, sel;
    function next() {
      order = groups.map(([, opts]) => pick(opts)); sel = groups.map(() => null);
      draw(); setItem(15 - r * 2, () => { ctx.bad('Customer left'); next(); });
    }
    function draw() {
      let h = `<div class="shCard"><small>ORDER</small><b>${order.join(' · ')}</b></div>`;
      groups.forEach(([n, opts], gi) => { h += `<div class="shLab">${n}</div><div class="shChips">${opts.map(o => `<button class="${sel[gi] === o ? 'on' : ''}" data-g="${gi}" data-o="${esc(o)}">${o}</button>`).join('')}</div>`; });
      h += `<button class="shGo" data-serve="1">Hand it over ☕</button>`;
      body.innerHTML = h;
    }
    body.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.serve) { if (sel.every((s, i) => s === order[i])) ctx.good('Perfect ☕'); else ctx.bad('Wrong drink'); next(); return; }
      sel[+b.dataset.g] = b.dataset.o; draw();
    };
    elHint.textContent = 'Tap what’s on the ticket, then hand it over.';
    next(); return 7;
  }
  // ── Target: restock to the right department; make change at the register ──
  function retail(r) {
    const IT = [['Cereal', 'Grocery'], ['Frozen pizza', 'Grocery'], ['Coffee beans', 'Grocery'], ['Headphones', 'Electronics'], ['HDMI cable', 'Electronics'], ['Phone charger', 'Electronics'], ['Paper towels', 'Home'], ['Throw pillow', 'Home'], ['Bath towels', 'Home'], ['LEGO set', 'Toys'], ['Board game', 'Toys'], ['Puzzle', 'Toys'], ['Hoodie', 'Clothing'], ['Jeans', 'Clothing'], ['Socks', 'Clothing'], ['Ibuprofen', 'Pharmacy'], ['Band-Aids', 'Pharmacy'], ['Vitamins', 'Pharmacy']];
    const DEP = ['Grocery', 'Electronics', 'Home', 'Toys', 'Clothing', 'Pharmacy'];
    function next() {
      if (r >= 1 && Math.random() < 0.35) { // register: pick the right change
        const tot = Math.round((3 + Math.random() * 60) * 100) / 100, paid = tot < 20 ? 20 : tot < 50 ? 50 : 100, ch = Math.round((paid - tot) * 100) / 100;
        const wrong = shuffle([ch + 1, ch - 1, ch + 0.1, ch - 0.1, ch + 0.25].filter(v => v >= 0)).slice(0, 2);
        const opts = shuffle([[ch, 1], ...wrong.map(v => [v, 0])]);
        body.innerHTML = `<div class="shCard"><small>REGISTER</small><b>Total ${usd(tot)} · paid with a $${paid}</b><span>How much change?</span></div><div class="shGrid three">${opts.map(([v, ok]) => `<button data-ok="${ok}">${usd(v)}</button>`).join('')}</div>`;
        setItem(9 - r, () => { ctx.bad('Line’s backing up'); next(); });
      } else {
        const [it, dep] = pick(IT), opts = shuffle([dep, ...shuffle(DEP.filter(d => d !== dep)).slice(0, 2 + Math.min(r, 1))]);
        body.innerHTML = `<div class="shCard"><small>RESTOCK</small><b>${it}</b><span>Which department?</span></div><div class="shGrid">${opts.map(d => `<button data-ok="${d === dep ? 1 : 0}">${d}</button>`).join('')}</div>`;
        setItem(5.5 - r * 0.5, () => { ctx.bad('Too slow'); next(); });
      }
    }
    body.onclick = e => { const b = e.target.closest('button'); if (!b) return; b.dataset.ok === '1' ? ctx.good() : ctx.bad(); next(); };
    elHint.textContent = r >= 1 ? 'Shelve each item in its department; at the register, pick the right change.' : 'Shelve each item in the right department.';
    next(); return 16;
  }
  // ── Mortenson: wire the panel by the color code ──
  function trades(r) {
    const W = [['black', 'Hot (line)'], ['white', 'Neutral'], ['green', 'Ground'], ['red', 'Switch leg'], ['blue', 'Traveler'], ['orange', 'Data / low voltage']];
    let wires, held, done;
    function next() {
      const n = Math.min(W.length, 3 + r); wires = shuffle(W.slice(0, n)); held = null; done = new Set();
      draw(); setItem(5 + n * 2.6 - r, () => { ctx.bad('Panel not finished'); next(); });
    }
    function draw() {
      const terms = [...wires].sort((a, b) => a[1].localeCompare(b[1]));
      body.innerHTML = `<div class="shWire"><div>${wires.map(([c]) => `<button class="wire ${c}${held === c ? ' on' : ''}${done.has(c) ? ' done' : ''}" data-w="${c}"></button>`).join('')}</div><div>${terms.map(([c, t]) => `<button class="term${done.has(c) ? ' done' : ''}" data-t="${c}">${done.has(c) ? '⚡ ' : ''}${t}</button>`).join('')}</div></div>`;
    }
    body.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.w && !done.has(b.dataset.w)) { held = b.dataset.w; draw(); return; }
      if (b.dataset.t && held) {
        if (b.dataset.t === held) { done.add(held); ctx.good(); if (done.size === wires.length) { feedback(true, 'Panel live ⚡'); next(); return; } }
        else ctx.bad('Zap! Wrong terminal');
        held = null; draw();
      }
    };
    elHint.textContent = r <= 1 ? 'Tap a wire, then its terminal. Black = hot · White = neutral · Green = ground · Red = switch leg · Blue = traveler · Orange = data' : 'Tap a wire, then its terminal — you know the color code by now.';
    next(); return 14;
  }
  // ── HCMC: triage the waiting room ──
  function health(r) {
    const P = [
      ['Crushing chest pain, sweaty, BP 88/50', 0], ['Can’t finish a sentence, O₂ 84%', 0], ['Face drooping on one side, started 20 min ago', 0], ['Lips and tongue swelling after a bee sting', 0],
      ['Temp 103.8°F, confused, heart rate 128', 0], ['Heavy bleeding from a leg wound', 0], ['Barely responsive after a fall, slow breathing', 0],
      ['Deep cut on the hand, bleeding controlled', 1], ['Belly pain 6/10 for 5 hours, vitals normal', 1], ['Swollen wrist after a fall, fingers pink', 1], ['Vomiting all day, dizzy, heart rate 104', 1], ['Asthma flare, O₂ 94% after an inhaler', 1], ['Kidney stone pain 8/10, vitals stable', 1],
      ['Sore throat for 2 days, vitals normal', 2], ['Rolled ankle, walking with a limp', 2], ['Needs a prescription refill', 2], ['Mild rash, no fever, breathing fine', 2], ['Earache, temp 99.4°F', 2], ['Cold symptoms for a week', 2]];
    const L = ['🚨 Now', '⏱ Soon', '🪑 Can wait'];
    function next() {
      const [d, k] = pick(P);
      body.innerHTML = `<div class="shCard"><small>PATIENT ${(Math.random() * 90 + 10) | 0} · ${pick(['M', 'F'])}, ${(Math.random() * 70 + 18) | 0}</small><b>${d}</b><span>How urgent?</span></div><div class="shGrid three">${L.map((l, i) => `<button data-ok="${i === k ? 1 : 0}">${l}</button>`).join('')}</div>`;
      setItem(8 - r, () => { ctx.bad('Patient waited too long'); next(); });
    }
    body.onclick = e => { const b = e.target.closest('button'); if (!b) return; b.dataset.ok === '1' ? ctx.good() : ctx.bad('Wrong call'); next(); };
    elHint.textContent = 'Triage each patient: life-threatening now, needs care soon, or safe to wait.';
    next(); return 10;
  }
  // ── Best Buy: fix the customer's problem; engineers find the bug ──
  function tech(r) {
    const FIX = [
      ['Laptop won’t turn on', 'Plug in the charger and hold power 15 s', ['Reinstall Windows', 'Replace the screen']],
      ['Wi-Fi keeps dropping', 'Restart the router, update the Wi-Fi driver', ['Buy a new laptop', 'Turn off Bluetooth']],
      ['Computer is really slow', 'Disable startup apps, free up disk space', ['Clean the keyboard', 'Lower screen brightness']],
      ['Printer says “offline”', 'Reconnect it to the same Wi-Fi network', ['Replace the toner', 'Update the BIOS']],
      ['TV has no sound', 'Check the input and the mute setting', ['Replace the HDMI port', 'Reset the remote']],
      ['Phone won’t charge', 'Clean the port, try another cable', ['Update the apps', 'Reset network settings']],
      ['Pop-ups all over the browser', 'Remove the bad extension, run a scan', ['Add more RAM', 'Change the wallpaper']],
      ['Customer forgot their password', 'Verify their identity, then reset it', ['Guess common passwords', 'Reinstall the OS']],
      ['Game console overheats', 'Clear the vents, give it airflow', ['Turn the volume down', 'Swap controller batteries']]];
    const BUG = [
      [['let total = 0;', 'for (let i = 0; i <= items.length; i++) {', '  total += items[i].price;', '}'], 1],
      [['function isAdult(age) {', '  if (age = 18) return true;', '  return age > 18;', '}'], 1],
      [['const rate = 0.08;', 'let price = 20;', 'let total = price + rate;', 'show(total);'], 2],
      [['let count = 0;', 'while (count < 10) {', '  count--;', '}'], 2],
      [['const names = [\'Ann\', \'Bo\'];', 'names.push(\'Cy\');', 'show(names[3]);'], 2],
      [['function avg(a, b) {', '  return a + b / 2;', '}'], 1],
      [['const user = getUser();', 'if (user == null) {', '  show(user.name);', '}'], 2],
      [['function last(list) {', '  return list[list.length];', '}'], 1]];
    function next() {
      if (r >= 2 && Math.random() < 0.6) {
        const [lines, k] = pick(BUG);
        body.innerHTML = `<div class="shCard"><small>CODE REVIEW</small><span>Tap the buggy line</span></div><div class="shCode">${lines.map((l, i) => `<button data-ok="${i === k ? 1 : 0}">${esc(l)}</button>`).join('')}</div>`;
        setItem(14 - r, () => { ctx.bad('Bug shipped'); next(); });
      } else {
        const [p, fix, wrong] = pick(FIX);
        body.innerHTML = `<div class="shCard"><small>CUSTOMER</small><b>“${p}”</b><span>Best fix?</span></div><div class="shGrid one">${shuffle([fix, ...wrong]).map(o => `<button data-ok="${o === fix ? 1 : 0}">${o}</button>`).join('')}</div>`;
        setItem(9 - r, () => { ctx.bad('Customer walked out'); next(); });
      }
    }
    body.onclick = e => { const b = e.target.closest('button'); if (!b) return; b.dataset.ok === '1' ? ctx.good() : ctx.bad(); next(); };
    elHint.textContent = r >= 2 ? 'Fix customers’ problems and catch bugs in code review.' : 'Pick the fix that actually solves the problem.';
    next(); return 9;
  }
  // ── U.S. Bank: count out withdrawals exactly; catch bad checks ──
  function bank(r) {
    const BILLS = [100, 50, 20, 10, 5, 1];
    const WORDS = n => { const o = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'], t = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'], teen = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
      const h = Math.floor(n / 100), rest = n % 100; let s = h ? o[h] + ' hundred' : ''; if (rest) s += (s ? ' ' : '') + (rest < 10 ? o[rest] : rest < 20 ? teen[rest - 10] : t[Math.floor(rest / 10)] + (rest % 10 ? '-' + o[rest % 10] : '')); return s[0].toUpperCase() + s.slice(1) + ' dollars'; };
    let want = 0, have = 0;
    function next() {
      if (r >= 1 && Math.random() < 0.4) {
        const amt = 20 + ((Math.random() * 480) | 0), flaw = pick([null, null, 'words', 'date', 'sig']);
        const words = WORDS(flaw === 'words' ? amt + pick([10, 100, -10]) : amt), date = flaw === 'date' ? 'Dec 3, 2027' : pick(['Oct 14, 2026', 'Oct 18, 2026', 'Sep 30, 2026']);
        body.innerHTML = `<div class="shCheck"><div><small>PAY TO</small> ${pick(['Jordan Lee', 'Sam Ortiz', 'Pat Nguyen', 'Alex Berg'])}<span>$${amt}.00</span></div><div class="w">${words}</div><div><small>DATE</small> ${date}<span class="sig">${flaw === 'sig' ? '' : pick(['M. Olson', 'K. Larson', 'T. Johnson'])}</span></div></div><div class="shGrid two"><button data-ok="${flaw ? 0 : 1}">✅ Cash it</button><button data-ok="${flaw ? 1 : 0}">⛔ Reject</button></div>`;
        setItem(11 - r, () => { ctx.bad('Customer complained'); next(); });
        return;
      }
      want = 20 + ((Math.random() * (r ? 460 : 180)) | 0); have = 0; drawCash();
      setItem(16 - r * 1.5, () => { ctx.bad('Too slow at the window'); next(); });
    }
    function drawCash() {
      body.innerHTML = `<div class="shCard"><small>WITHDRAWAL</small><b>$${want}</b><span>Counted: <b class="${have > want ? 'neg' : ''}">$${have}</b></span></div><div class="shGrid bills">${BILLS.map(v => `<button data-b="${v}">$${v}</button>`).join('')}</div><div class="shGrid two"><button data-undo="1">↺ Recount</button><button class="shGo" data-hand="1">Hand it over</button></div>`;
    }
    body.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.ok !== undefined) { b.dataset.ok === '1' ? ctx.good() : ctx.bad('Bad call on that check'); next(); return; }
      if (b.dataset.b) { have += +b.dataset.b; drawCash(); return; }
      if (b.dataset.undo) { have = 0; drawCash(); return; }
      if (b.dataset.hand) { have === want ? ctx.good('Exact 💵') : ctx.bad(have > want ? 'Overpaid!' : 'Short-changed'); next(); }
    };
    elHint.textContent = r >= 1 ? 'Count out each withdrawal exactly; reject checks with a missing signature, a future date, or words that don’t match the amount.' : 'Count out each withdrawal exactly.';
    next(); return 6;
  }
  const GAMES = { coffee, retail, trades, health, tech, bank };
  // ── running a shift ──
  function start(kind, rank, title, done, dur = 60) {
    G = { good: 0, bad: 0, t: dur, done, target: 1, over: false };
    box.classList.add('on'); paused = true;
    elT.textContent = title; upd();
    G.target = GAMES[kind](rank) * dur / 60;
    clearInterval(timer);
    timer = setInterval(() => {
      if (G.over) return;
      G.t -= 0.1; itemT -= 0.1;
      elTime.textContent = `⏱ ${Math.max(0, Math.ceil(G.t))}s`;
      const bar = $('shBar'); bar.style.width = Math.max(0, itemT / itemMax * 100) + '%'; bar.classList.toggle('low', itemT < itemMax * 0.3);
      if (itemT <= 0 && onItemOut) { const f = onItemOut; onItemOut = null; f(); }
      if (G.t <= 0) finish();
    }, 100);
  }
  function perf() { const tot = G.good + G.bad; return tot ? Math.min(1, G.good / G.target) * Math.sqrt(G.good / tot) : 0; }
  function finish() {
    G.over = true; clearInterval(timer); onItemOut = null;
    const p = perf(), grade = p >= 0.9 ? 'Outstanding' : p >= 0.7 ? 'Great shift' : p >= 0.5 ? 'Solid' : p >= 0.3 ? 'Rough day' : 'Your manager noticed…';
    const mult = shiftGame.mult(p);
    body.innerHTML = `<div class="shCard res"><small>SHIFT REVIEW</small><b>${grade}</b><span>${G.good} done right · ${G.bad} mistake${G.bad === 1 ? '' : 's'} · performance ${Math.round(p * 100)}%</span><span class="${mult >= 1 ? 'pos' : 'neg'}">Pay ${mult >= 1 ? '+' : '−'}${Math.abs(Math.round((mult - 1) * 100))}%${p >= 0.8 ? ' · counts double toward promotion' : ''}</span></div><button class="shGo" data-end="1">Clock out</button>`;
    body.onclick = e => { if (e.target.closest('[data-end]')) end(p); };
    elHint.textContent = '';
  }
  function end(p) { box.classList.remove('on'); paused = false; last = performance.now(); const d = G.done; G = null; d(p); }
  $('shSkip').onclick = () => { if (!G) return; clearInterval(timer); onItemOut = null; G.over = true; end(null); };
  return { start, mult: p => p == null ? 1 : p < 0.5 ? 0.85 + 0.3 * p : 1 + 0.4 * (p - 0.5), isOn: () => !!G };
})();
window.__shift = shiftGame;
// ───────────────────────── work: XP, levels and skill points; driving gigs; careers at real employers ─────────────────────────
// Wages are 2026 Twin Cities figures: Minneapolis minimum wage $16.37 (Jan 2026), Minnesota rideshare minimum pay $1.28/mile +
// $0.31/minute (2026), Metro Transit bus operators $27.59/hr to start (ATU 1005 contract), and career wages anchored to the
// BLS May 2025 Minneapolis–St. Paul wage estimates (tellers $21.55, food service ~$17, healthcare practitioners ~$59, computer ~$55…).
const SKILLS = [
  ['drive', 'Driving', '🚗', 'Unlocks taxi, tow and bus work. +5% gig pay and −3% fuel use per point.'],
  ['people', 'People', '🤝', 'Customer-facing jobs. +10% tips per point.'],
  ['hands', 'Hands-on', '🔧', 'The trades: construction and electrical work, tow trucks.'],
  ['tech', 'Tech', '💻', 'Computers, IT and software — and the science side of nursing.'],
  ['biz', 'Business', '📈', 'Banking, finance and management. +2% on every paycheck and −0.25% car-loan APR per point.'],
];
const SK_MAX = 10;
const xpNeed = lv => 100 + 50 * (lv - 1);
// gig apps. own: use your own car; car: the company's vehicle (you swap into it when you go online)
const GIGS = [
  { k: 'deliver', name: 'DashDrop delivery', ic: '🍔', req: {}, xp: 12, own: true, desc: 'Pick up food at restaurants and drop it at customers’ doors. Base pay + mileage + tips.' },
  { k: 'ride', name: 'Lyfft rideshare', ic: '🙋', req: { drive: 1 }, xp: 15, own: true, desc: 'Minnesota minimum pay: $1.28 per mile + $0.31 per minute with a rider, plus tips.' },
  { k: 'taxi', name: 'Twin Town Taxi', ic: '🚕', req: { drive: 3 }, xp: 18, car: { type: 'taxi', color: '#f2c318' }, desc: 'Metered fares: $3.00 to start + $2.60 a mile, and you keep the tips. Company cab provided.' },
  { k: 'tow', name: 'North Star Towing', ic: '🛻', req: { drive: 3, hands: 2 }, xp: 25, car: { type: 'tow', color: '#d93a2b' }, desc: 'Haul broken-down cars to repair shops. $85 a tow + $3 a mile.' },
  { k: 'bus', name: 'Metro Transit bus operator', ic: '🚌', req: { drive: 5 }, xp: 40, car: { type: 'bus', color: '#f2f2ee' }, hourly: 27.59, desc: 'Drive a route from Heywood Garage. $27.59/hour (union scale), paid for every hour on the road.' },
];
const GARAGE = (() => { const [x, z] = proj(44.9862, -93.2844); return { x, z, n: 'Heywood Garage' }; })();
// career ladders: the employer, where you clock in (a real location — chains use the store nearest you when you apply), and the ranks
const LADDERS = [
  { k: 'coffee', sched: { start: 6, days: [0, 1, 2, 3, 4] }, emp: 'Caribou Coffee', ic: '☕', match: /caribou/i, at: [44.9762, -93.2733], ranks: [
    { t: 'Barista', w: 16.37, req: {} }, { t: 'Shift Lead', w: 18.75, req: { people: 2 } }, { t: 'Café Manager', w: 25.5, req: { people: 4, biz: 2 } }] },
  { k: 'retail', sched: { start: 10, days: [2, 3, 4, 5, 6] }, emp: 'Target', ic: '🎯', match: /^target\b/i, at: [44.9746, -93.2738], ranks: [
    { t: 'Team Member', w: 17.5, req: {} }, { t: 'Team Lead', w: 22.75, req: { people: 3 } }, { t: 'Executive Team Leader', w: 33, req: { people: 4, biz: 3 } }, { t: 'Store Director', w: 52, req: { people: 5, biz: 6 } }] },
  { k: 'trades', sched: { start: 7, days: [0, 1, 2, 3, 4] }, emp: 'Mortenson Construction', ic: '🏗️', at: [44.9849, -93.3348], ranks: [
    { t: 'Construction Laborer', w: 24.5, req: {} }, { t: 'Apprentice Electrician', w: 27, req: { hands: 2 } }, { t: 'Journeyman Electrician', w: 48.5, req: { hands: 5, tech: 1 } }, { t: 'Master Electrician', w: 58, req: { hands: 8, tech: 2, biz: 2 } }] },
  { k: 'health', sched: { start: 7, days: [0, 2, 4, 5, 6] }, emp: 'Hennepin Healthcare (HCMC)', ic: '🏥', at: [44.9727, -93.2617], ranks: [
    { t: 'Nursing Assistant', w: 21, req: { people: 1 } }, { t: 'Licensed Practical Nurse', w: 30.5, req: { people: 2, tech: 2 } }, { t: 'Registered Nurse', w: 52.5, req: { people: 3, tech: 5 } }, { t: 'Charge Nurse', w: 61, req: { people: 4, tech: 6, biz: 2 } }] },
  { k: 'tech', sched: { start: 9, days: [0, 1, 2, 3, 4] }, emp: 'Best Buy HQ', ic: '💻', at: [44.8626, -93.3082], ranks: [
    { t: 'Geek Squad Agent', w: 19.5, req: { tech: 1 } }, { t: 'IT Support Specialist', w: 29, req: { tech: 3 } }, { t: 'Software Engineer', w: 57, req: { tech: 6 } }, { t: 'Senior Software Engineer', w: 74, req: { tech: 8, biz: 2 } }] },
  { k: 'bank', sched: { start: 9, days: [0, 1, 2, 3, 4] }, emp: 'U.S. Bank', ic: '🏦', at: [44.9757, -93.2730], ranks: [
    { t: 'Bank Teller', w: 21.55, req: { people: 1 } }, { t: 'Personal Banker', w: 26.5, req: { people: 2, biz: 2 } }, { t: 'Financial Analyst', w: 45, req: { biz: 5, tech: 1 } }, { t: 'Branch Manager', w: 62, req: { biz: 7, people: 4 } }] },
];
const SHIFT_H = 8, PROMO_SHIFTS = 3;
const jobs = (() => {
  const L = LIFE;
  if (!L.sk) { L.sk = { drive: 0, people: 0, hands: 0, tech: 0, biz: 0 }; L.lv = 1; L.xp = 0; L.pts = 2; }
  const sk = k => (L.sk && L.sk[k]) || 0;
  const meets = req => Object.entries(req).every(([k, v]) => sk(k) >= v);
  const reqText = req => Object.entries(req).filter(([k, v]) => sk(k) < v).map(([k, v]) => `${SKILLS.find(s => s[0] === k)[1]} ${v}`).join(', ');
  const dayOf = h => Math.floor(h / 24);
  // ── XP and levels ──
  function gainXP(n) {
    L.xp += n; let up = 0;
    while (L.xp >= xpNeed(L.lv)) { L.xp -= xpNeed(L.lv); L.lv++; L.pts++; up++; }
    if (up) { flashTag('LEVEL UP'); setTimeout(() => toast(`Level ${L.lv}! You have ${L.pts} skill point${L.pts > 1 ? 's' : ''} to spend — open your phone → Skills`), 1800); sfx.whoosh(); buzz(40); }
    life.touch(); hud();
  }
  function spend(k) {
    if (L.pts < 1 || sk(k) >= SK_MAX) return;
    L.pts--; L.sk[k] = sk(k) + 1; life.touch(); life.save();
    const s = SKILLS.find(x => x[0] === k); toast(`${s[1]} is now ${L.sk[k]}`);
    checkPromo(true);
  }
  const payMult = () => 1 + 0.02 * sk('biz');
  const gigMult = () => 1 + 0.05 * sk('drive');
  const tipMult = () => 1 + 0.1 * sk('people');
  // ── where things are ──
  function roadPoints(R, x0, z0) {
    const out = [];
    for (const t of tiles.values()) {
      if (t.state.r !== 2) continue;
      for (const r of t.roads) {
        if (r.c < 2 || r.c > 7 || r.tunnel) continue;
        const p = r.pts, n = p.length / 2;
        for (let i = 0; i < n - 1; i += 2) {
          if (r.hs && Math.abs(r.hs[i]) > 0.3) continue;
          const x = (p[i * 2] + p[i * 2 + 2]) / 2, z = (p[i * 2 + 1] + p[i * 2 + 3]) / 2;
          if (Math.hypot(x - x0, z - z0) > R) continue;
          out.push({ x, z, n: r.name || '' });
        }
      }
    }
    return out;
  }
  const allPois = f => { const out = []; for (const t of tiles.values()) for (const p of t.pois || []) if (p.name && f(p)) out.push(p); return out; };
  function pickNear(list, x, z, lo, hi) {
    const ok = list.filter(p => { const d = Math.hypot(p.x - x, p.z - z); return d >= lo && d <= hi; });
    return ok.length ? ok[(Math.random() * ok.length) | 0] : null;
  }
  const mi = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) * 1.3 / 1609; // road miles ≈ 1.3 × straight line
  // ── 3D marker for the next stop: a light column with a ring on the ground ──
  const mkMat = new THREE.MeshBasicMaterial({ color: '#4fd27a', transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
  const mkRing = new THREE.MeshBasicMaterial({ color: '#4fd27a', transparent: true, opacity: 0.8, side: THREE.DoubleSide });
  const marker = new THREE.Group();
  { const col = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 120, 14, 1, true), mkMat); col.position.y = 60; marker.add(col);
    const ring = new THREE.Mesh(new THREE.RingGeometry(5, 6.2, 32), mkRing); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.3; marker.add(ring); }
  marker.visible = false; scene.add(marker);
  function placeMarker(p) {
    if (!p) { marker.visible = false; return; }
    const sf = surfaceAt(p.x, p.z, 5); marker.position.set(p.x, sf ? sf.h : 0, p.z); marker.visible = true;
  }
  // the broken-down car for tow jobs
  let wreck = null;
  function makeWreck(p) {
    clearWreck();
    wreck = makeBoxCar(['beater', 'hatch', 'suv', 'van'][(Math.random() * 4) | 0], ['#6b6f75', '#7d1d1d', '#23365c', '#b9ab8f'][(Math.random() * 4) | 0]);
    const sf = surfaceAt(p.x, p.z, 5); wreck.position.set(p.x, sf ? sf.h : 0, p.z); wreck.rotation.y = Math.random() * 6.28; scene.add(wreck);
  }
  function clearWreck() { if (wreck) { scene.remove(wreck); wreck.traverse(o => { if (o.geometry) o.geometry.dispose(); }); wreck = null; } }
  // ── gigs ──
  let gig = null; // { k, stage: 'wait'|'pick'|'drop', from, to, wait, t, stops, i }
  const el = $('gig'), elT = $('gigTitle'), elM = $('gigMain'), elS = $('gigSub'), elA = $('gigArrow');
  const G = k => GIGS.find(g => g.k === k);
  function goOnline(k) {
    const g = G(k); if (!g || !meets(g.req)) return;
    if (L.hot) { toast('Ditch the stolen car first'); return; }
    if (police.stars()) { toast('Lose the cops first'); return; }
    if (chal.active()) chal.stop();
    if (gig) goOffline(true);
    if (g.own && !L.cars[L.active]) { toast('You need a car for this'); return; }
    if (k === 'bus' && Math.hypot(S.x - GARAGE.x, S.z - GARAGE.z) > 150) {
      gig = { k, stage: 'garage', to: GARAGE };
      startNav(GARAGE.x, GARAGE.z, 'Heywood Garage'); placeMarker(GARAGE); show(); toast('Head to Heywood Garage to pick up your bus'); return;
    }
    begin(k);
  }
  function begin(k) {
    const g = G(k);
    if (S.mode === 'foot') { toast('Get in a vehicle first'); gig = null; show(); return; }
    if (g.car) { L.jobCar = { ...g.car }; setCar(); terrainizeScene(); toast(k === 'bus' ? 'Your bus is ready — follow the route' : `Your ${CARS[g.car.type].label.toLowerCase()} is here`); }
    gig = { k, stage: 'wait', wait: 3 + Math.random() * 3, t: 0, start: L.hours };
    if (k === 'bus') newRoute();
    show(); life.touch();
  }
  function goOffline(quiet) {
    if (!gig) return;
    const was = gig; gig = null;
    if (was.k === 'bus' && was.stops) payBus(was, true);
    if (L.jobCar) { L.jobCar = null; setCar(); terrainizeScene(); }
    clearWreck(); placeMarker(null); if (nav.route) endNav(); show(); life.touch(); life.hud();
    if (!quiet) toast('You’re offline');
  }
  function offer() {
    const g = G(gig.k), you = { x: S.x, z: S.z };
    let from = null, to = null;
    if (gig.k === 'deliver') {
      const food = allPois(p => p.c === 0 || p.c === 1);
      from = pickNear(food, S.x, S.z, 150, 2200) || pickNear(food, S.x, S.z, 0, 4000);
      if (from) { const rp = roadPoints(4000, from.x, from.z); to = pickNear(rp, from.x, from.z, 600, 3200); if (to) to.n = to.n ? `a customer on ${to.n}` : 'a customer'; }
    } else if (gig.k === 'ride' || gig.k === 'taxi') {
      const rp = roadPoints(1800, S.x, S.z); from = pickNear(rp, S.x, S.z, 150, 1500);
      if (from) { from.n = from.n ? `a rider on ${from.n}` : 'your rider'; to = pickNear(allPois(p => p.c !== 2), from.x, from.z, 900, 6500); }
    } else if (gig.k === 'tow') {
      const rp = roadPoints(2600, S.x, S.z); from = pickNear(rp, S.x, S.z, 300, 2500);
      if (from) { from.n = from.n ? `a breakdown on ${from.n}` : 'a breakdown';
        const shops = allPois(p => p.c === 3 && /auto|tire|collision|repair|body|car|midas|meineke|firestone|goodyear|jiffy/i.test(p.name));
        to = pickNear(shops, from.x, from.z, 500, 6000) || pickNear(allPois(p => p.c === 3), from.x, from.z, 800, 5000); }
    }
    if (!from || !to) { gig.wait = 6; elM.textContent = 'Finding work…'; elS.textContent = 'Drive somewhere busier if this takes a while'; return; }
    const m = mi(from, to);
    let pay = 0;
    if (gig.k === 'deliver') pay = 2.5 + 0.9 * m;
    else if (gig.k === 'ride') pay = 1.28 * m + 0.31 * m * 2.4; // minutes with the rider ≈ 2.4 per mile in town traffic
    else if (gig.k === 'taxi') pay = 3 + 2.6 * m;
    else if (gig.k === 'tow') pay = 85 + 3 * m;
    pay *= gigMult();
    Object.assign(gig, { stage: 'pick', from, to, pay, m, t: 0 });
    if (gig.k === 'tow') makeWreck(from);
    placeMarker(from); startNav(from.x, from.z, from.n); sfx.whoosh(); buzz(20);
    toast(`${g.ic} New ${gig.k === 'deliver' ? 'order' : gig.k === 'tow' ? 'tow' : 'ride'}: ${m.toFixed(1)} mi · ${money(pay)}${gig.k === 'tow' ? '' : ' + tip'}`);
  }
  function complete() {
    const g = G(gig.k);
    let tip = 0;
    if (gig.k !== 'tow' && Math.random() < (gig.k === 'deliver' ? 0.85 : 0.65)) tip = (gig.k === 'deliver' ? 2 + Math.random() * 4 : gig.pay * (0.1 + Math.random() * 0.15)) * tipMult();
    life.earn(Math.round(gig.pay * 100) / 100, `${g.name}: ${gig.to.n || 'trip'}`);
    if (tip > 0.5) life.earn(Math.round(tip * 100) / 100, 'Tip');
    L.gigsDone = (L.gigsDone || 0) + 1;
    flashTag(`+${money(gig.pay + tip)}`); gainXP(g.xp); story.emit('gig');
    clearWreck(); placeMarker(null); if (nav.route) endNav();
    Object.assign(gig, { stage: 'wait', wait: 4 + Math.random() * 6, from: null, to: null });
  }
  // the bus: a loop of stops on real streets, paid by the hour
  function newRoute() {
    const rp = roadPoints(4000, S.x, S.z).filter(p => p.n);
    const stops = []; let px = S.x, pz = S.z;
    for (let k = 0; k < 7; k++) { const s = pickNear(rp, px, pz, 350, 750); if (!s || stops.some(q => Math.hypot(q.x - s.x, q.z - s.z) < 250)) continue; stops.push(s); px = s.x; pz = s.z; }
    if (stops.length < 3) { gig.wait = 5; return; }
    Object.assign(gig, { stage: 'bus', stops, i: 0, start: L.hours, to: stops[0] });
    placeMarker(stops[0]); startNav(stops[0].x, stops[0].z, `Stop: ${stops[0].n}`);
  }
  function payBus(g, early) {
    const hrs = Math.max(0.25, L.hours - g.start), pay = hrs * G('bus').hourly * payMult();
    life.earn(Math.round(pay * 100) / 100, `Metro Transit: ${hrs.toFixed(1)} h`);
    if (!early) { gainXP(G('bus').xp); flashTag(`+${money(pay)}`); story.emit('gig'); }
  }
  function show() {
    const on = !!gig; el.classList.toggle('on', on);
    document.body.classList.toggle('working', on);
  }
  // the clock runs at 1/6 speed while you're working a gig, so pay per game hour is realistic
  const clockRate = () => (gig && gig.stage !== 'garage' ? 1 / 6 : 1);
  function update(dt) {
    if (!gig || !LIFE_ON()) { if (gig && !LIFE_ON()) goOffline(true); return; }
    const g = G(gig.k), spd = Math.hypot(S.vx, S.vz);
    const arrow = p => { const a = Math.atan2(p.x - S.x, p.z - S.z) - S.h; elA.style.transform = `rotate(${(-a * 180 / Math.PI).toFixed(1)}deg)`; };
    elT.textContent = `${g.ic} ${g.name}`;
    if (gig.stage === 'garage') {
      const d = Math.hypot(S.x - GARAGE.x, S.z - GARAGE.z); arrow(GARAGE);
      elM.textContent = 'Go to the garage'; elS.textContent = fmtDist(d);
      if (d < 60 && spd < 3) { placeMarker(null); if (nav.route) endNav(); begin('bus'); }
      return;
    }
    if (gig.stage === 'wait') {
      elM.textContent = 'Waiting for a request…'; elS.textContent = `${L.gigsDone || 0} jobs done`; elA.style.transform = '';
      if ((gig.wait -= dt) <= 0) { if (gig.k === 'bus') newRoute(); else offer(); }
      return;
    }
    if (gig.stage === 'bus') {
      const s = gig.stops[gig.i], d = Math.hypot(S.x - s.x, S.z - s.z); arrow(s);
      elM.textContent = `Stop ${gig.i + 1}/${gig.stops.length}`; elS.textContent = `${s.n} · ${fmtDist(d)} · ${money((L.hours - gig.start) * g.hourly * payMult())} so far`;
      if (d < 25 && spd < 2) {
        gig.i++; buzz(20); sfx.whoosh(); toast(gig.i < gig.stops.length ? `Picked up ${1 + ((Math.random() * 6) | 0)} passengers` : 'End of the line');
        if (gig.i >= gig.stops.length) { payBus(gig); if (nav.route) endNav(); placeMarker(null); Object.assign(gig, { stage: 'wait', wait: 4 }); return; }
        const n = gig.stops[gig.i]; placeMarker(n); startNav(n.x, n.z, `Stop: ${n.n}`);
      }
      return;
    }
    const tgt = gig.stage === 'pick' ? gig.from : gig.to, d = Math.hypot(S.x - tgt.x, S.z - tgt.z);
    arrow(tgt); gig.t += dt;
    elM.textContent = money(gig.pay); elS.textContent = `${gig.stage === 'pick' ? 'Pick up' : 'Drop off'}: ${tgt.n} · ${fmtDist(d)}`;
    if (gig.k === 'tow' && wreck && gig.stage === 'drop') { // the wreck rides behind on the hook
      const bx = S.x - Math.sin(S.h) * 6.3, bz = S.z - Math.cos(S.h) * 6.3;
      wreck.position.set(bx, S.y + 0.35, bz); wreck.rotation.set(0.12, S.h, 0);
    }
    const R = tgt.c !== undefined ? 45 : 26; // shops and restaurants sit back from the street
    if (d < R && spd < 2.5) {
      if (gig.stage === 'pick') {
        gig.stage = 'drop'; buzz(20); sfx.whoosh();
        toast(gig.k === 'deliver' ? `Picked up the order from ${gig.from.name || gig.from.n}` : gig.k === 'tow' ? 'Hooked up — take it to the shop' : 'Rider’s in');
        placeMarker(gig.to); startNav(gig.to.x, gig.to.z, gig.to.name || gig.to.n);
        if (gig.to.name) gig.to.n = gig.to.name;
      } else complete();
    }
  }
  // ── careers ──
  const LAD = k => LADDERS.find(l => l.k === k);
  function workplace(lad) {
    if (lad.match) { let best = null, bd = 1e9; for (const p of allPois(p => lad.match.test(p.name))) { const d = Math.hypot(p.x - S.x, p.z - S.z); if (d < bd) { bd = d; best = p; } } if (best) return { x: best.x, z: best.z, n: `${lad.emp}, ${rentArea(best.x, best.z).n}` }; }
    const [x, z] = proj(lad.at[0], lad.at[1]); return { x, z, n: lad.emp };
  }
  function apply(k, r) {
    const lad = LAD(k), rank = lad.ranks[r];
    if (!meets(rank.req)) return;
    if (L.job && !confirm(`Quit your job as ${LAD(L.job.lad).ranks[L.job.rank].t}?`)) return;
    const w = workplace(lad);
    syncDay(); L.job = { lad: k, rank: r, shifts: 0, total: 0, last: L.hours, lastDay: -1, x: w.x, z: w.z, where: w.n, strikes: 0 };
    life.touch(); life.save();
    const sc = lad.sched, n = nextShift(); flashTag('HIRED'); toast(`Hired: ${rank.t} at ${w.n} · ${money(rank.w)}/hr · ${daysText(sc)} ${fh(sc.start)}–${fh(sc.start + SHIFT_H)} · first shift ${n ? n.label : ''}`);
    phone.close(); startNav(w.x, w.z, w.n);
  }
  function quit() { if (!L.job) return; const t = LAD(L.job.lad).ranks[L.job.rank].t; if (!confirm(`Quit your job as ${t}?`)) return; L.job = null; life.touch(); life.save(); toast('You quit'); }
  // ── work schedules: set days and a set start time; show up within the window or it counts as a missed shift ──
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const fh = h => { const hh = Math.floor(h), m = Math.round((h - hh) * 60); return `${(hh + 11) % 12 + 1}${m ? ':' + String(m).padStart(2, '0') : ''} ${hh % 24 < 12 ? 'AM' : 'PM'}`; };
  const sched = j => LAD(j.lad).sched;
  const workday = (j, d) => sched(j).days.includes(((d % 7) + 7) % 7);
  const daysText = sc => { const d = sc.days; if (d.every((v, i) => !i || v === d[i - 1] + 1) && d.length > 2) return `${WD[d[0]]}–${WD[d[d.length - 1]]}`; return d.map(i => WD[i]).join(', '); };
  function syncDay() { if (L.lastTod != null && tod < L.lastTod - 1e-6) { L.day = (L.day || 0) + 1; life.touch(); } L.lastTod = tod; }
  const today = () => L.day || 0;
  function status() {
    const j = L.job; if (!j) return { k: 'none' };
    const sc = sched(j), d = today();
    if (j.lastDay === d) return { k: 'done' };
    if (!workday(j, d)) return { k: 'off' };
    if (tod < sc.start - 1) return { k: 'early' };
    if (tod <= sc.start + 0.25) return { k: 'now' };
    if (tod <= sc.start + 1.5) return { k: 'late' };
    return { k: 'missed' };
  }
  function nextShift() {
    const j = L.job; if (!j) return null;
    const sc = sched(j), d0 = today(), st = status().k;
    for (let k = 0; k < 8; k++) {
      const d = d0 + k; if (!workday(j, d)) continue;
      if (k === 0 && (st === 'done' || st === 'missed')) continue;
      return { d, k, label: `${k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : WD[d % 7]} ${fh(sc.start)}` };
    }
    return null;
  }
  // the hour to wake up for a given day: 1½ hours before an early shift, otherwise 7 AM
  function wakeFor(d) { const j = L.job; if (!j || !workday(j, d)) return 7; return Math.min(7, sched(j).start - 1.5); }
  function strike(why) {
    const j = L.job; j.strikes = (j.strikes || 0) + 1; life.touch();
    if (j.strikes >= 3) { toast(`You were fired from ${LAD(j.lad).emp} — ${why}, 3 strikes`); flashTag('FIRED'); L.job = null; life.save(); return; }
    toast(`⚠️ ${why} — strike ${j.strikes} of 3 at ${LAD(j.lad).emp}`);
  }
  function work() {
    const j = L.job; if (!j) return;
    const st = status().k, sc = sched(j);
    if (st === 'done') { toast('You already worked today'); return; }
    if (st === 'off') { const n = nextShift(); toast(`Day off — your next shift is ${n ? n.label : 'soon'}`); return; }
    if (st === 'early') { toast(`Your shift starts at ${fh(sc.start)}`); return; }
    if (st === 'missed') { toast('Too late for today’s shift'); return; }
    if (gig) goOffline(true);
    const late = Math.max(0, tod - sc.start), hrs = SHIFT_H - (st === 'late' ? late : 0);
    const lad = LAD(j.lad), rank = lad.ranks[j.rank];
    j.lastDay = today(); life.save();
    shiftGame.start(lad.k, j.rank, `${lad.ic} ${rank.t} · ${lad.emp}`, p => finishShift(j, lad, rank, st, late, hrs, p));
  }
  function finishShift(j, lad, rank, st, late, hrs, p) {
    const sc = lad.sched, mult = shiftGame.mult(p), pay = rank.w * hrs * payMult() * mult;
    tod = (tod + hrs) % 24; applyTime(tod); life.tick(hrs); syncDay();
    j.shifts += p != null && p >= 0.8 ? 2 : 1; j.total++; j.last = L.hours;
    life.earn(Math.round(pay * 100) / 100, `Paycheck — ${rank.t}, ${hrs.toFixed(hrs % 1 ? 1 : 0)} h${p == null ? '' : ` (${Math.round(p * 100)}% performance)`}`);
    flashTag(`+${money(pay)}`);
    toast(st === 'late' ? `You were ${Math.round(late * 60)} min late — paid for ${hrs.toFixed(1)} h · ${money(pay)} · it's ${clockText()}` : `Worked your ${fh(sc.start)}–${fh(sc.start + SHIFT_H)} shift as ${rank.t} · ${money(pay)} deposited`);
    gainXP(Math.round((35 + 10 * j.rank) * (p == null ? 0.7 : 0.6 + 0.8 * p)));
    checkPromo(); story.emit('shift');
    L.pos = { x: S.x, z: S.z, h: S.h }; life.save();
  }
  function waitForShift() { const sc = sched(L.job), add = sc.start - 0.25 - tod; if (add <= 0) return; tod += add; applyTime(tod); life.tick(add); toast(`It's ${clockText()} — time to clock in`); }
  function checkPromo(quiet) {
    const j = L.job; if (!j) return;
    const lad = LAD(j.lad), next = lad.ranks[j.rank + 1]; if (!next) return;
    if (j.shifts < PROMO_SHIFTS) return;
    if (meets(next.req)) {
      j.rank++; j.shifts = 0; life.touch(); life.save();
      flashTag('PROMOTED'); setTimeout(() => toast(`Promoted to ${next.t} · ${money(next.w)}/hr`), quiet ? 0 : 2200);
    } else if (!quiet && !j.toldNeed) { j.toldNeed = true; setTimeout(() => toast(`Ready for promotion to ${next.t} — you need ${reqText(next.req)}`), 2200); }
  }
  // missed shifts become strikes; a heads-up before each shift
  function tick() {
    syncDay();
    const j = L.job; if (!j) return;
    if (j.checked == null) j.checked = today() - (tod > sched(j).start + 1.5 ? 0 : 1); // hired today after the window: today doesn't count
    const sc = sched(j), d = today();
    while (j.checked < d - 1 && L.job) { j.checked++; if (workday(j, j.checked) && j.lastDay !== j.checked && j.struck !== j.checked) strike(`missed your ${WD[j.checked % 7]} shift`); }
    if (!L.job) return;
    if (workday(j, d) && j.lastDay !== d && j.struck !== d && tod > sc.start + 1.5 && j.checked < d) { j.struck = d; strike('no-show for today’s shift'); }
    if (L.job && workday(j, d) && j.lastDay !== d && tod > sc.start - 1.5 && tod < sc.start - 0.5 && j.remind !== d) {
      j.remind = d; toast(`⏰ Your shift at ${LAD(j.lad).emp} starts at ${fh(sc.start)} — time to head to work`); buzz(40);
    }
  }
  // the action button at your workplace
  function action() {
    const j = L.job; if (!j || gig || inside.on) return null;
    if (Math.hypot(S.x - j.x, S.z - j.z) > 130 || Math.hypot(S.vx, S.vz) > 2) return null;
    const rank = LAD(j.lad).ranks[j.rank], st = status().k, sc = sched(j), n = nextShift();
    if (st === 'done') return { label: `✅ Done today · next ${n ? n.label : ''}`, fn: () => toast(`Your next shift: ${n ? n.label : '—'}`) };
    if (st === 'off') return { label: `📅 Day off · next ${n ? n.label : ''}`, fn: () => toast(`Your schedule: ${daysText(sc)}, ${fh(sc.start)}–${fh(sc.start + SHIFT_H)}`) };
    if (st === 'missed') return { label: '❌ Missed today’s shift', fn: () => toast(`Your next shift: ${n ? n.label : '—'}`) };
    if (st === 'early') return { label: `⏳ Wait for your ${fh(sc.start)} shift`, fn: waitForShift };
    return { label: `🕐 Clock in${st === 'late' ? ' (late)' : ''} · ${money(rank.w * SHIFT_H * payMult())}`, fn: work };
  }
  function hud() { $('btnPhone').classList.toggle('badge', !L.job && !gig && !(L.gigsDone > 0)); const b = $('lvPill'); if (b) { b.textContent = `Lv ${L.lv}${L.pts ? ' · ' + L.pts + ' pt' + (L.pts > 1 ? 's' : '') : ''}`; b.classList.toggle('pts', L.pts > 0); } }
  $('gigQuit').onclick = () => goOffline();
  window.__onTeleport = () => { if (gig) { goOffline(true); toast('Teleporting ended your gig'); } };
  return { roadPoints, allPois, pickNear, gainXP, spend, sk, meets, reqText, goOnline, goOffline, update, clockRate, apply, quit, work, action, tick, hud, status, nextShift, wakeFor, fh, daysText, today, syncDay, WD, LAD, G,
    gig: () => gig, payMult, gigMult, tipMult, workplace };
})();

window.__jobs = jobs;
// ───────────────────────── light mischief: stealing cars, speeding tickets, wanted stars, police chases, busted ─────────────────────────
// Speeding tickets: a base fine plus the $75 state surcharge and $3 Hennepin County law-library fee every Minnesota citation
// carries; the base fine doubles at 20+ mph over (Minn. Stat. § 169.14). Busted: a fine by wanted level, a few hours in booking,
// and any stolen car goes back to its owner.
const TICKETS = false; // speeding tickets are off: cops only come after you for stealing cars and ramming them
const WANTED_FINE = [0, 300, 600, 1200, 2500, 5000];
const COPS_FOR = [0, 1, 2, 3, 4, 6];
const police = (() => {
  const L = LIFE;
  if (L.hot) { L.hot = null; L.own = null; } // a stolen car never survives a reload
  const W = { stars: 0, heat: 0, evade: 0, bust: 0, pull: null, cool: 0, chk: 0, why: '' };
  const el = $('wanted');
  let ownMesh = null;
  // your own car, parked where you left it while you joyride in someone else's
  function showOwn() {
    if (ownMesh) { scene.remove(ownMesh); ownMesh = null; }
    if (!L.own) return;
    const c = L.cars[L.active], ty = c ? c.type : 'beater';
    ownMesh = ty === 'sedan' ? makeSedan(c.color) : VSHAPE[ty] ? makeBoxCar(ty, c ? c.color : '#8a8f96') : makeSportsCar(c ? c.color : '#8a8f96');
    ownMesh.position.set(L.own.x, L.own.y || 0, L.own.z); ownMesh.rotation.y = L.own.h; scene.add(ownMesh); terrainizeScene();
  }
  function dropHot() { L.hot = null; L.own = null; showOwn(); setCar(); terrainizeScene(); life.hud(); }
  // ── on foot: the door button / F ──
  const nearTraffic = R => { let best = null, bd = R; for (const c of traffic.cars) { if (c.free || c.v > 6) continue; const d = Math.hypot(c.x - S.x, c.z - S.z); if (d < bd && Math.abs(c.y - S.y) < 2.5) { bd = d; best = c; } } return best; };
  function doorState() {
    if (inside.on) return null;
    if (Math.hypot(S.x - PARKED.x, S.z - PARKED.z) < 4) return L.hot ? 'hot' : 'car';
    if (!LIFE_ON()) return null;
    if (L.own && Math.hypot(S.x - L.own.x, S.z - L.own.z) < 4.5) return 'own';
    const c = nearTraffic(4.8); return c ? (c.cop ? 'cop' : 'steal') : null;
  }
  // returns true when it handled getting in (your own car while joyriding, or stealing a car)
  function tryEnter() {
    const st = doorState();
    if (st === 'own') {
      const o = L.own; L.hot = null; L.own = null; showOwn();
      S.mode = 'car'; Object.assign(S, { x: o.x, y: o.y || 0, z: o.z, h: o.h, pitch: 0, groll: 0, vx: 0, vz: 0, vy: 0, yawR: 0, vfPrev: 0 });
      if (ME.fig) ME.fig.grp.visible = false; document.body.classList.remove('onfoot'); camInit = false; ME.near = undefined;
      setCar(); terrainizeScene(); life.hud(); toast('Back in your own car'); return true;
    }
    if (st === 'steal' || st === 'cop') {
      if (L.jobCar || jobs.gig()) { toast('Not while you’re on the clock'); return true; }
      const c = nearTraffic(4.8);
      if (!L.hot) L.own = { x: PARKED.x, y: PARKED.y, z: PARKED.z, h: PARKED.h }; // your car stays parked here
      L.hot = { type: c.cop ? 'police' : c.tall > 1.1 ? 'suv' : ['sedan', 'beater', 'hatch'][(c.seed * 3) | 0], color: c.cop ? '#f4f4f2' : c.color };
      c.dead = true;
      S.mode = 'car'; Object.assign(S, { x: c.x, y: c.y, z: c.z, h: c.h, pitch: 0, groll: 0, vx: 0, vz: 0, vy: 0, yawR: 0, vfPrev: 0 });
      if (ME.fig) ME.fig.grp.visible = false; document.body.classList.remove('onfoot'); camInit = false;
      setCar(); showOwn(); life.hud(); sfx.door && sfx.door(); buzz(30); ME.near = undefined;
      const seen = traffic.cars.some(o => o.cop && !o.dead && Math.hypot(o.x - S.x, o.z - S.z) < 120);
      addWanted(c.cop ? 3 : seen ? 2 : 1, c.cop ? 'Stole a police cruiser' : 'Grand theft auto');
      flashTag('STOLEN'); return true;
    }
    return false;
  }
  // ── wanted level ──
  function addWanted(n, why) {
    const was = W.stars; W.stars = Math.min(5, Math.max(W.stars, n)); W.heat = 0; W.evade = 0; W.why = why || W.why;
    if (W.pull) { W.pull.cop.chase = true; W.pull = null; }
    if (W.stars > was) { toast(`🚨 ${why} — ${'★'.repeat(W.stars)}`); buzz(60); }
  }
  function clearWanted(msg) {
    W.stars = 0; W.heat = W.evade = W.bust = 0; W.pull = null;
    for (const c of traffic.cars) if (c.chase) { c.chase = false; if (c.free) c.dead = true; }
    if (msg) { toast(msg); flashTag('EVADED'); }
  }
  window.__hitCar = (c, v) => {
    if (!LIFE_ON()) return;
    if (c.cop) addWanted(W.stars + 1, 'Rammed a police car');
    else if (W.stars && v > 8) { W.heat += 10; }
  };
  window.__noTeleport = () => LIFE_ON() && W.stars > 0;
  // ── a traffic stop: pull over within 12 seconds and take the ticket, or run for it ──
  function ticket(over, limit) {
    const base = over >= 20 ? (40 + (over - 10) * 5) * 2 : 40 + Math.max(0, over - 10) * 5, total = base + 78;
    life.pay(total, `Speeding ticket — ${over} over in a ${limit}`);
    toast(`Ticket: ${over} mph over in a ${limit} zone · ${money(total)} (fine ${money(base)} + $78 surcharge & fees)`);
    flashTag('TICKET');
  }
  function busted() {
    const s = W.stars, fine = WANTED_FINE[s], hrs = 2 + 3 * s, hot = !!L.hot;
    life.pay(fine, `Fine — ${W.why || 'police chase'} (${'★'.repeat(s)})`);
    let impound = 0;
    if (!hot && s >= 3 && S.mode !== 'foot') { impound = 300; life.pay(impound, 'Impound lot: towing & storage'); }
    clearWanted();
    for (const c of traffic.cars) if (c.cop) c.dead = true;
    if (L.hot && L.own) { const o = L.own; L.hot = null; L.own = null; showOwn(); if (S.mode === 'foot') { S.mode = 'car'; if (ME.fig) ME.fig.grp.visible = false; document.body.classList.remove('onfoot'); } Object.assign(S, { x: o.x, y: o.y || 0, z: o.z, h: o.h, vx: 0, vz: 0, vy: 0 }); camInit = false; setCar(); terrainizeScene(); }
    tod = (tod + hrs) % 24; applyTime(tod); life.tick(hrs);
    flashTag('BUSTED'); sfx.siren(0);
    toast(`Busted! ${money(fine)} fine${impound ? ` + ${money(impound)} impound` : ''}${hot ? ', the stolen car went back to its owner' : ''} · ${hrs} hours in booking — it's ${clockText()}`);
    L.busts = (L.busts || 0) + 1; life.touch(); life.save();
    if (window.__hustle && __hustle.active()) __hustle.stop();
    if (window.__combat) __combat.confiscate();
  }
  // ── per frame ──
  function update(dt, info) {
    if (!LIFE_ON()) { if (W.stars || W.pull) clearWanted(); el.classList.remove('on'); sfx.siren(0); return; }
    const spd = Math.hypot(S.vx, S.vz), mph = spd * 2.237;
    W.cool = Math.max(0, W.cool - dt);
    const cops = traffic.cars.filter(c => c.cop && !c.dead);
    // speeding in view of a patrol car
    if ((W.chk -= dt) <= 0) {
      W.chk = 0.3;
      const r = info && info.nr && info.nr.d < info.nr.road.w / 2 + 6 ? info.nr.road : null;
      if (TICKETS && !W.stars && !W.pull && !W.cool && S.mode !== 'foot' && r && r.ms && mph > r.ms + 12) {
        const cop = cops.find(c => !c.chase && Math.hypot(c.x - S.x, c.z - S.z) < 90 && Math.abs(c.y - S.y) < 4);
        if (cop) { W.pull = { cop, t: 12, over: Math.round(mph - r.ms), limit: r.ms }; cop.chase = true; toast(`🚨 Pull over! ${W.pull.over} over the limit — stop within 12 seconds`); buzz(50); }
      }
    }
    if (W.pull) {
      const p = W.pull, d = Math.hypot(p.cop.x - S.x, p.cop.z - S.z);
      p.t -= dt;
      if (p.cop.dead) { W.pull = null; }
      else if (spd < 1 && d < 70) { ticket(p.over, p.limit); p.cop.chase = false; if (p.cop.free) p.cop.dead = true; W.pull = null; W.cool = 60; }
      else if (p.t <= 0) addWanted(2, 'Fleeing a traffic stop');
    }
    // the chase
    if (W.stars) {
      const chasing = cops.filter(c => c.chase);
      // patrol cars nearby join in; more cruisers come as the stars go up
      for (const c of cops) if (!c.chase && chasing.length < COPS_FOR[W.stars] && Math.hypot(c.x - S.x, c.z - S.z) < 300) { c.chase = true; chasing.push(c); }
      if (chasing.length < COPS_FOR[W.stars] && Math.random() < dt * 0.8) { const c = traffic.spawn(S.x, S.z, 140, 330, { cop: true, chase: true }); if (c) chasing.push(c); }
      let nearest = 1e9; for (const c of chasing) nearest = Math.min(nearest, Math.hypot(c.x - S.x, c.z - S.z));
      if (nearest < 170) { W.evade = 0; W.heat += dt; if (W.heat > 75 && W.stars < 5) { W.stars++; W.heat = 0; toast(`The chase is heating up — ${'★'.repeat(W.stars)}`); } }
      else if ((W.evade += dt) > 10 + 5 * W.stars) { clearWanted('You lost the cops'); }
      // boxed in: a cruiser right on you while you're (nearly) stopped
      if (nearest < (S.mode === 'foot' ? 6 : 8) && spd < (S.mode === 'foot' ? 3.5 : 2.5)) { if ((W.bust += dt) > 2.2) busted(); }
      else W.bust = Math.max(0, W.bust - dt);
      sfx.siren(Math.max(0, 1 - nearest / 260));
      if (W.stars >= 3 && nearest < 32 && Math.random() < dt * (S.mode === 'foot' ? 1.3 : 0.7) && window.__combat) __combat.hurt(S.mode === 'foot' ? 9 : 5, 'shot by police');
    } else sfx.siren(W.pull ? 0.6 : 0);
    // HUD
    const on = !!(W.stars || W.pull); el.classList.toggle('on', on);
    if (W.pull) el.innerHTML = `<b>🚨 PULL OVER</b><span>${Math.ceil(W.pull.t)}</span>`;
    else if (W.stars) {
      const ev = W.evade > 0, left = Math.max(0, 10 + 5 * W.stars - W.evade);
      el.innerHTML = `<b class="stars">${'★'.repeat(W.stars)}<i>${'★'.repeat(5 - W.stars)}</i></b><span>${W.bust > 0.3 ? 'STOP RESISTING…' : ev ? `out of sight · ${Math.ceil(left)}s` : 'WANTED'}</span>`;
      el.classList.toggle('evading', ev);
    }
  }
  return { update, tryEnter, doorState, dropHot, addWanted, clearWanted, stars: () => W.stars, W, showOwn };
})();
window.__police = police; window.__traffic = traffic;
// ───────────────────────── inside your home: a furnished floor plan you walk around in ─────────────────────────
// Its own little scene (no ceiling, seen from above and behind like a dollhouse). The world outside keeps running; you
// come back out where you went in. Size follows what you rent: studio → 4-bedroom house.
const inside = (() => {
  const sc = new THREE.Scene(); sc.background = new THREE.Color('#1a1d22');
  sc.add(new THREE.HemisphereLight('#fff8ee', '#5a5048', 2.4));
  const sunL = new THREE.DirectionalLight('#ffffff', 1.1); sunL.position.set(4, 10, 6); sc.add(sunL);
  const room = new THREE.Group(); sc.add(room);
  const IN = { on: false, P: { x: 0, z: 0, h: 0, vx: 0, vz: 0 }, out: null, cols: [], spots: [], W: 0, D: 0, cam: new THREE.Vector3(), look: new THREE.Vector3(), camInit: false, built: null };
  const mats = {};
  const M = c => mats[c] || (mats[c] = new THREE.MeshLambertMaterial({ color: c }));
  const winMat = new THREE.MeshBasicMaterial({ color: '#bfe0ff' });
  function box(w, h, d, x, y, z, c, solid) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof c === 'string' ? M(c) : c); m.position.set(x, y, z); room.add(m);
    if (solid) IN.cols.push([x - w / 2, z - d / 2, x + w / 2, z + d / 2]);
    return m;
  }
  const WALL_H = 2.7, T = 0.14;
  // a straight wall from (x0,z0) to (x1,z1) (axis-aligned) with optional door gaps [from, to] along it
  function wall(x0, z0, x1, z1, gaps = [], col) {
    const horiz = z0 === z1, a0 = horiz ? Math.min(x0, x1) : Math.min(z0, z1), a1 = horiz ? Math.max(x0, x1) : Math.max(z0, z1);
    const cuts = [a0, ...gaps.flat(), a1];
    for (let i = 0; i < cuts.length; i += 2) {
      const s = cuts[i], e = cuts[i + 1]; if (e - s < 0.05) continue;
      if (horiz) box(e - s, WALL_H, T, (s + e) / 2, WALL_H / 2, z0, col, true); else box(T, WALL_H, e - s, x0, WALL_H / 2, (s + e) / 2, col, true);
    }
    for (const [s, e] of gaps) { if (horiz) box(e - s, 0.5, T, (s + e) / 2, WALL_H - 0.25, z0, col); else box(T, 0.5, e - s, x0, WALL_H - 0.25, (s + e) / 2, col); } // header over the doorway
  }
  const spot = (x, z, r, label, fn) => IN.spots.push({ x, z, r, label, fn });
  function clear() {
    room.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    room.clear(); IN.cols = []; IN.spots = [];
  }
  // ── furniture ──
  function bed(x, z, rot, dbl, col, main) {
    const w = dbl ? 1.6 : 1.0, l = 2.05, g = new THREE.Group(); room.add(g); g.position.set(x, 0, z); g.rotation.y = rot;
    const add = (bw, bh, bd, bx, by, bz, c) => { const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), M(c)); m.position.set(bx, by, bz); g.add(m); };
    add(w + 0.1, 0.35, l + 0.1, 0, 0.18, 0, '#6b4f3a'); add(w, 0.22, l, 0, 0.46, 0, '#f2efe8'); add(w + 0.1, 0.95, 0.08, 0, 0.48, -l / 2 - 0.05, '#5a4030');
    add(w * 0.9, 0.12, 0.42, 0, 0.62, -l / 2 + 0.3, '#ffffff'); add(w + 0.02, 0.08, l * 0.62, 0, 0.6, l * 0.17, col);
    const c = Math.abs(Math.cos(rot)) > 0.5, hw = (c ? w : l) / 2 + 0.05, hd = (c ? l : w) / 2 + 0.05; IN.cols.push([x - hw, z - hd, x + hw, z + hd]);
    if (main) spot(x + Math.sin(rot) * (l / 2 + 0.4), z + Math.cos(rot) * (l / 2 + 0.4), 1.6, '🛏 Sleep until morning', () => life.sleepNow());
  }
  function couch(x, z, rot, col) {
    const g = new THREE.Group(); room.add(g); g.position.set(x, 0, z); g.rotation.y = rot;
    const add = (bw, bh, bd, bx, by, bz, c) => { const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), M(c)); m.position.set(bx, by, bz); g.add(m); };
    add(2.2, 0.42, 0.9, 0, 0.21, 0, col); add(2.2, 0.5, 0.2, 0, 0.62, -0.35, col); add(0.2, 0.3, 0.9, -1.0, 0.55, 0, col); add(0.2, 0.3, 0.9, 1.0, 0.55, 0, col);
    add(0.9, 0.08, 0.7, -0.5, 0.46, 0.05, '#e6e0d4'); add(0.9, 0.08, 0.7, 0.5, 0.46, 0.05, '#e6e0d4');
    const c = Math.abs(Math.cos(rot)) > 0.5; IN.cols.push(c ? [x - 1.15, z - 0.5, x + 1.15, z + 0.5] : [x - 0.5, z - 1.15, x + 0.5, z + 1.15]);
  }
  // ── the floor plan ──
  function build(home) {
    clear();
    const beds = home.beds ?? (/studio/i.test(home.unit) ? 0 : parseInt(home.unit) || 1), house = home.kind === 'house', lux = home.rent > 2400;
    const W = 7.4 + beds * 3.3, Dl = beds ? 6.2 : 7.4, Db = beds ? 4.2 : 0, D = Dl + Db; IN.W = W; IN.D = D;
    const floorC = lux ? '#c9b08a' : house ? '#a9825c' : '#b89b78', wallC = lux ? '#f1ede6' : '#e4ddd0', trim = '#d9d2c4';
    box(W, 0.1, D, W / 2, -0.05, D / 2, floorC); // floor
    box(W + 0.6, 0.06, D + 0.6, W / 2, -0.12, D / 2, '#2a2d33');
    // outside walls, the front door at x 1.2–2.3
    wall(0, 0, W, 0, [[1.2, 2.3]], wallC); wall(0, D, W, D, [], wallC); wall(0, 0, 0, D, [], wallC); wall(W, 0, W, D, [], wallC);
    box(1.1, 2.1, 0.06, 1.75, 1.05, -0.02, '#7b5a3c'); // the door itself (in the wall, you walk up to it)
    spot(1.75, 0.6, 1.1, '🚪 Go outside', exit);
    // windows on the back and sides
    const win = (x, z, w, side) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.3), winMat); m.position.set(x, 1.55, z); if (side) m.rotation.y = side; room.add(m); };
    if (beds) for (let i = 0; i < beds; i++) win(W * (i + 0.5) / beds, D - T / 2 - 0.01, 1.4, Math.PI);
    else win(W / 2, D - T / 2 - 0.01, 2.4, Math.PI);
    win(T / 2 + 0.01, Dl * 0.55, 1.8, Math.PI / 2); win(W - T / 2 - 0.01, Dl * 0.55, 1.8, -Math.PI / 2);
    // bathroom in the front-right corner
    const bw = 2.6, bd = 2.5;
    wall(W - bw, bd, W, bd, [], wallC); wall(W - bw, 0, W - bw, bd, [[bd - 1.1, bd - 0.2]], wallC);
    box(bw - T, 0.02, bd - T, W - bw / 2, 0.01, bd / 2, '#dfe6ea');
    box(0.75, 0.55, 1.5, W - 0.5, 0.28, 0.85, '#f4f6f7', true); // tub
    box(0.45, 0.42, 0.6, W - bw + 0.45, 0.21, 0.5, '#f4f6f7', true); // toilet
    box(0.7, 0.85, 0.45, W - 1.25, 0.43, 0.32, '#f4f6f7', true); // sink
    box(0.6, 0.75, 0.03, W - 1.25, 1.45, 0.09, '#9fb4c2'); // mirror
    // kitchen along the left wall
    box(0.62, 0.92, 3.0, 0.38, 0.46, 3.0, lux ? '#3a3f47' : '#8a6d52', true); box(0.66, 0.05, 3.04, 0.38, 0.94, 3.0, lux ? '#e8e8e6' : '#cfc7b8');
    box(0.7, 1.85, 0.75, 0.42, 0.93, 5.0, '#d9dcdf', true); // fridge
    box(0.5, 0.02, 0.5, 0.38, 0.97, 2.4, '#222'); // stove top
    box(0.62, 0.7, 2.2, 0.38, 1.95, 3.0, lux ? '#3a3f47' : '#8a6d52'); // upper cabinets
    spot(1.1, 2.4, 1.0, '🍳 Cook dinner · $9 groceries', () => { if (LIFE.money < 9) { toast('Not even $9 for groceries…'); return; } life.pay(9, 'Groceries'); toast('You made pasta. Not bad!'); tod = (tod + 0.75) % 24; applyTime(tod); life.tick(0.75); });
    // living room: couch facing a TV, rug, coffee table; a desk with a laptop; dining table
    const lx = beds ? 3.6 + beds * 0.6 + 0.6 : Math.min(W - bw - 1.6, 3.6), lz = 3.4;
    box(2.8, 0.02, 2.0, lx, 0.01, lz, lux ? '#6a7c8f' : '#8a4f3c'); // rug
    couch(lx, lz + 1.15, Math.PI, lux ? '#3c4a5c' : house ? '#6b7a55' : '#5a6270');
    box(1.1, 0.4, 0.6, lx, 0.2, lz, '#5a4030', true); // coffee table
    box(1.6, 0.5, 0.45, lx, 0.25, 1.0 + 0.25, '#2b2b2b', true); box(1.5, 0.85, 0.06, lx, 1.05, 1.05 + 0.25, '#111'); // TV stand + TV
    spot(lx, lz + 0.4, 1.3, '📺 Watch TV · 1 hour', () => { tod = (tod + 1) % 24; applyTime(tod); life.tick(1); toast(['The Vikings lost a heartbreaker.', 'You binged a cooking show.', 'Local news: snow emergency rules explained.', 'Twins highlights — still a rebuild.', 'A documentary about Prince. Great.'][(Math.random() * 5) | 0]); });
    const dx = beds ? W - bw - 1.0 : 1.9, dz = Dl - 0.6;
    box(1.3, 0.75, 0.6, dx, 0.38, dz, '#6b4f3a', true); box(0.36, 0.02, 0.26, dx, 0.77, dz, '#2c2f35'); box(0.36, 0.24, 0.02, dx, 0.89, dz + 0.12, '#3d5a80'); // desk + laptop
    box(0.45, 0.85, 0.45, dx, 0.42, dz - 0.6, '#333', false);
    spot(dx, dz - 0.75, 1.0, '💻 Laptop · find a job', () => phone.open('jobs'));
    if (beds) box(1.2, 0.75, 0.8, 2.6, 0.38, 5.0, '#7a5a40', true); if (beds) for (const sx of [-0.75, 0.75]) box(0.42, 0.45, 0.42, 2.6 + sx, 0.23, 5.0, '#5a4030', false); // dining
    // plants and lamps
    box(0.4, 0.4, 0.4, W - bw - 0.4, 0.2, 0.5, '#7a5a40'); box(0.6, 0.8, 0.6, W - bw - 0.4, 0.8, 0.5, '#3f7a4a');
    // bedrooms across the back (a studio just gets a bed in the corner)
    if (!beds) { bed(W - 1.1, D - 1.35, Math.PI, true, lux ? '#2f4f7a' : '#7a2f3c', true); box(1.2, 2.0, 0.6, W - 3.0, 1.0, D - 0.4, '#8a6d52', true); spot(W - 3.0, D - 1.1, 1.0, '👕 Change outfit', outfit); }
    else {
      const rw = W / beds;
      wall(0, Dl, W, Dl, Array.from({ length: beds }, (_, i) => [i * rw + rw * 0.5 - 0.55, i * rw + rw * 0.5 + 0.55]).map(([a, b]) => [Math.max(0.2, a), Math.min(W - 0.2, b)]), wallC);
      for (let i = 1; i < beds; i++) wall(i * rw, Dl, i * rw, D, [], wallC);
      for (let i = 0; i < beds; i++) {
        const cx = i * rw + rw / 2;
        box(rw - T, 0.02, Db - T, cx, 0.012, Dl + Db / 2, i === 0 ? (lux ? '#a3a0b5' : '#9a8f80') : '#a59a86');
        bed(cx + (i === 0 ? 0.2 : 0.4), D - 1.15, Math.PI, i === 0, ['#2f4f7a', '#7a6a2f', '#3f7a4a', '#7a2f3c'][i % 4], i === 0);
        box(0.45, 0.5, 0.4, cx - (i === 0 ? 1.05 : 0.5), 0.25, D - 0.35, '#6b4f3a', true); // nightstand
        if (i === 0) { box(1.2, 2.0, 0.6, i * rw + 0.75, 1.0, Dl + 0.45, '#8a6d52', true); spot(i * rw + 0.75, Dl + 1.15, 1.0, '👕 Change outfit', outfit); }
      }
    }
    IN.built = home;
  }
  function outfit() {
    const i = CHAR_LIST.findIndex(c => c[0] === (settings.char || 'ch01')), next = CHAR_LIST[(i + 1) % CHAR_LIST.length];
    settings.char = next[0]; saveSettings(); $('optChar').value = next[0];
    useCharacter(next[0]).then(F => { if (IN.on && F) { sc.add(F.grp); F.grp.visible = true; } toast(`Now playing as ${next[1]}`); }).catch(() => {});
  }
  // ── going in and out ──
  async function enter() {
    const h = LIFE.home; if (!h || IN.on) return;
    if (police.stars()) { toast('The cops are watching — lose them first'); return; }
    if (jobs.gig()) { toast('Go offline first'); return; }
    if (S.mode !== 'foot') { await toggleFoot(); if (S.mode !== 'foot') return; }
    const F = ME.fig || await useCharacter(settings.char || 'ch01').catch(() => null); if (!F) return;
    if (IN.built !== h) build(h);
    IN.out = { x: S.x, y: S.y, z: S.z, h: S.h };
    Object.assign(IN.P, { x: 1.75, z: 1.3, h: 0, vx: 0, vz: 0 });
    S.vx = S.vz = 0;
    sc.add(F.grp); F.grp.visible = true;
    IN.on = true; IN.camInit = false; document.body.classList.add('inside');
    $('doorHint').classList.remove('on');
    toast(`Home: ${h.name}`);
  }
  function exit() {
    if (!IN.on) return;
    IN.on = false; document.body.classList.remove('inside');
    if (ME.fig) scene.add(ME.fig.grp);
    Object.assign(S, { x: IN.out.x, y: IN.out.y, z: IN.out.z, h: IN.out.h + Math.PI, vx: 0, vz: 0, vy: 0 });
    ME.near = undefined; camInit = false;
  }
  // ── walking around ──
  function update(dt) {
    const P = IN.P, steer = input.right - input.left, fwd = input.up - input.down;
    P.h -= steer * FOOT.turn * dt * (fwd < 0 ? -1 : 1);
    const want = fwd > 0 ? (input.boost ? 4.2 : 2.6) : fwd < 0 ? -1.2 : 0, fx = Math.sin(P.h), fz = Math.cos(P.h);
    let v = P.vx * fx + P.vz * fz; v += Math.max(-12 * dt, Math.min(10 * dt, want - v));
    P.vx = fx * v; P.vz = fz * v; P.x += P.vx * dt; P.z += P.vz * dt;
    const R = 0.3;
    for (const [x0, z0, x1, z1] of IN.cols) {
      const qx = Math.max(x0, Math.min(x1, P.x)), qz = Math.max(z0, Math.min(z1, P.z)), dx = P.x - qx, dz = P.z - qz, d = Math.hypot(dx, dz);
      if (d >= R) continue;
      if (d > 1e-6) { P.x = qx + dx / d * R; P.z = qz + dz / d * R; }
      else { const l = P.x - x0, r = x1 - P.x, b = P.z - z0, t = z1 - P.z, m = Math.min(l, r, b, t); if (m === l) P.x = x0 - R; else if (m === r) P.x = x1 + R; else if (m === b) P.z = z0 - R; else P.z = z1 + R; }
    }
    P.x = Math.max(0.3, Math.min(IN.W - 0.3, P.x)); P.z = Math.max(0.3, Math.min(IN.D - 0.3, P.z));
    // animate the character with the outdoor gait code, borrowing S for a moment
    const F = ME.fig;
    if (F) {
      const sv = { x: S.x, z: S.z, y: S.y, h: S.h, vx: S.vx, vz: S.vz, vy: S.vy, groundH: S.groundH };
      Object.assign(S, { x: P.x, z: P.z, y: 0, h: P.h, vx: P.vx, vz: P.vz, vy: 0, groundH: 0 });
      animateFoot(dt); F.root.position.y = 0;
      Object.assign(S, sv);
    }
    // dollhouse camera: up and behind, smoothed
    const cx = P.x - Math.sin(P.h) * 3.4, cz = P.z - Math.cos(P.h) * 3.4;
    const k = IN.camInit ? 1 - Math.exp(-dt * 5) : 1; IN.camInit = true;
    IN.cam.x += (cx - IN.cam.x) * k; IN.cam.y += (6.4 - IN.cam.y) * k; IN.cam.z += (cz - IN.cam.z) * k;
    IN.look.x += (P.x + Math.sin(P.h) * 0.8 - IN.look.x) * k; IN.look.y = 0.9; IN.look.z += (P.z + Math.cos(P.h) * 0.8 - IN.look.z) * k;
    camera.position.copy(IN.cam); camera.lookAt(IN.look);
    if (Math.abs(camera.fov - 55) > 0.1) { camera.fov = 55; camera.updateProjectionMatrix(); }
    // windows follow the time of day
    winMat.color.set(NIGHT.value > 0.5 ? '#1c2742' : NIGHT.value > 0.15 ? '#c98a5a' : WX.precip > 0.5 ? '#9aa6b2' : '#bfe0ff');
  }
  function action() {
    let best = null, bd = 1e9;
    for (const s of IN.spots) { const d = Math.hypot(s.x - IN.P.x, s.z - IN.P.z); if (d < s.r && d < bd) { bd = d; best = s; } }
    return best && { label: best.label, fn: best.fn };
  }
  return { get on() { return IN.on; }, scene: sc, enter, exit, update, action, build, IN };
})();
window.__inside = inside;
// ───────────────────────── side hustles: chop shop, street racing, package runs, ticket flipping, back-room blackjack ─────────────────────────
// The shady side of town. Bigger payouts, more heat: patrol cars can turn a package run or a street race into a chase, and
// "street rep" (earned by pulling these off) makes every hustle pay a little better.
const HUSTLE_SPOTS = (() => {
  const P = (n, la, lo, kind) => { const [x, z] = proj(la, lo); return { n, x, z, kind }; };
  return [
    P('Northside Auto Salvage (chop shop)', 45.0060, -93.2860, 'chop'), P('Hiawatha Ave scrapyard (chop shop)', 44.9330, -93.2240, 'chop'),
    P('Midway rail yard garage (chop shop)', 44.9640, -93.1680, 'chop'), P('Fridley industrial lot (chop shop)', 45.0700, -93.2580, 'chop'),
    P('Street race — North Loop warehouses', 44.9920, -93.2770, 'race'), P('Street race — Hiawatha industrial', 44.9400, -93.2270, 'race'),
    P('Street race — Shakopee Ave lots, Bloomington', 44.8580, -93.2930, 'race'), P('Street race — Pig’s Eye, St. Paul', 44.9220, -93.0510, 'race'),
    P('Back-room blackjack — Lake Street', 44.9483, -93.2600, 'cards'), P('Back-room blackjack — Northeast', 45.0010, -93.2580, 'cards'),
  ];
})();
// real venues; the events and times are made up for the game
const VENUES = (() => {
  const V = (n, la, lo, ev) => { const [x, z] = proj(la, lo); return { n, x, z, ev }; };
  return [
    V('U.S. Bank Stadium', 44.9737, -93.2575, [{ d: [6], h: 12, t: 'Vikings game', face: 140, hot: 1.6 }, { d: [3], h: 19.5, t: 'stadium concert', face: 110, hot: 1.4 }]),
    V('Target Field', 44.9817, -93.2776, [{ d: [1, 2, 4, 5], h: 18.5, t: 'Twins game', face: 45, hot: 1.1 }]),
    V('Target Center', 44.9795, -93.2761, [{ d: [0, 2, 4, 5], h: 19, t: 'Timberwolves game', face: 70, hot: 1.35 }]),
    V('Xcel Energy Center', 44.9448, -93.1010, [{ d: [1, 3, 5], h: 19, t: 'Wild game', face: 85, hot: 1.3 }]),
    V('Allianz Field', 44.9532, -93.1650, [{ d: [2, 6], h: 19.5, t: 'Minnesota United match', face: 50, hot: 1.2 }]),
  ];
})();
const CHOP_VALUE = { beater: 350, hatch: 650, sedan: 900, suv: 1300, pickup: 1400, van: 900, lux: 2200, sport: 3200, taxi: 500 };
const hustle = (() => {
  const L = LIFE;
  if (L.rep == null) L.rep = 0;
  const repLvl = () => Math.min(10, Math.floor(L.rep / 100));
  const repMult = () => 1 + 0.06 * repLvl();
  const addRep = n => { const was = repLvl(); L.rep = Math.max(0, L.rep + n); if (repLvl() > was) { flashTag('STREET REP UP'); toast(`Street rep level ${repLvl()} — hustles pay ${Math.round((repMult() - 1) * 100)}% more`); } life.touch(); };
  const near = (kind, R) => HUSTLE_SPOTS.filter(s => s.kind === kind).find(s => Math.hypot(s.x - S.x, s.z - S.z) < R);
  const nearest = kind => HUSTLE_SPOTS.filter(s => s.kind === kind).sort((a, b) => Math.hypot(a.x - S.x, a.z - S.z) - Math.hypot(b.x - S.x, b.z - S.z))[0];
  const night = (a, b) => tod >= a || tod < b;
  // ── the banner and a marker for races and runs ──
  const el = $('hustle'), elT = $('huTitle'), elM = $('huMain'), elS = $('huSub'), elA = $('huArrow');
  const mkMat = new THREE.MeshBasicMaterial({ color: '#b36bff', transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide });
  const mkRing = new THREE.MeshBasicMaterial({ color: '#b36bff', transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const marker = new THREE.Group();
  { const col = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 140, 14, 1, true), mkMat); col.position.y = 70; marker.add(col);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(7, 0.45, 8, 40), mkRing); ring.position.y = 7.4; marker.add(ring); }
  marker.visible = false; scene.add(marker);
  const place = p => { if (!p) { marker.visible = false; return; } const sf = surfaceAt(p.x, p.z, 5); marker.position.set(p.x, sf ? sf.h : 0, p.z); marker.visible = true; };
  let run = null; // the race or package run in progress
  function show() { el.classList.toggle('on', !!run); }
  function stop(msg) { run = null; place(null); if (nav.route) endNav(); show(); if (msg) toast(msg); }
  const arrow = p => { const a = Math.atan2(p.x - S.x, p.z - S.z) - S.h; elA.style.transform = `rotate(${(-a * 180 / Math.PI).toFixed(1)}deg)`; };
  const busy = () => { if (jobs.gig()) return 'Go offline from your gig first'; if (chal.active()) return 'Finish your challenge first'; if (run) return 'You’re already on a hustle'; return null; };
  // ── 1. chop shop ──
  function chop(spot) {
    if (!L.hot) return;
    if (police.stars()) { toast('“Not with cops on your tail. Lose them, then come back.”'); return; }
    if (L.hot.type === 'police') { toast('“A cop car? Get that thing out of here.”'); return; }
    const pay = Math.round((CHOP_VALUE[L.hot.type] || 600) * repMult() * (0.85 + Math.random() * 0.3) / 10) * 10;
    life.earn(pay, `Cash — ${spot.n.replace(/ \(.*/, '')}`); addRep(20); flashTag(`+${money(pay)}`); buzz(40);
    const o = L.own; L.hot = null; L.own = null; police.showOwn();
    if (o) { // the crew gives you a ride back to your own car
      if (S.mode === 'foot') { S.mode = 'car'; if (ME.fig) ME.fig.grp.visible = false; document.body.classList.remove('onfoot'); }
      Object.assign(S, { x: o.x, y: o.y || 0, z: o.z, h: o.h, vx: 0, vz: 0, vy: 0 }); camInit = false; wantTiles(S.x, S.z);
    }
    setCar(); terrainizeScene(); life.hud(); life.save();
    toast(`Sold it for parts: ${money(pay)} cash. The crew drops you back at your car.`); story.emit('chop');
  }
  // ── 2. street racing (nights) ──
  function startRace(spot, bet) {
    const b = busy(); if (b) { toast(b); return; }
    if (S.mode === 'foot') { toast('You need a car to race'); return; }
    if (L.money < bet) { toast(`The buy-in is ${money(bet)}`); return; }
    const rp = jobs.roadPoints(2500, S.x, S.z);
    if (rp.length < 40) { toast('Roads are still loading — try again in a second'); return; }
    const pts = []; let px = S.x, pz = S.z, hx = Math.sin(S.h), hz = Math.cos(S.h);
    for (let k = 0; k < 6; k++) {
      let pick = null;
      for (let t = 0; t < 300 && !pick; t++) { const c = rp[(Math.random() * rp.length) | 0], d = Math.hypot(c.x - px, c.z - pz); if (d < 280 || d > 600) continue; if (((c.x - px) * hx + (c.z - pz) * hz) / d < (t < 200 ? 0 : -0.7)) continue; if (pts.some(q => Math.hypot(q.x - c.x, q.z - c.z) < 200)) continue; pick = c; }
      if (!pick) break;
      hx = pick.x - px; hz = pick.z - pz; const l = Math.hypot(hx, hz) || 1; hx /= l; hz /= l; px = pick.x; pz = pick.z; pts.push(pick);
    }
    if (pts.length < 4) { toast('Couldn’t lay out a course here'); return; }
    life.pay(bet, 'Street race buy-in');
    let dist = Math.hypot(pts[0].x - S.x, pts[0].z - S.z); for (let i = 1; i < pts.length; i++) dist += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const rival = { name: ['Dez', 'Kenji', 'Rosa', 'Big Mike', 'Tash', 'Vinny'][(Math.random() * 6) | 0], v: 19 + Math.random() * 6 + repLvl() * 0.6 };
    run = { type: 'race', spot, bet, pts, i: 0, t: -3, dist: dist * 1.25, rival, copAt: Math.random() < 0.4 ? 10 + Math.random() * 25 : -1 };
    place(pts[0]); show(); flashTag('3'); sfx.whoosh();
  }
  // ── 3. package runs ──
  function startRun() {
    const b = busy(); if (b) { toast(b); return; }
    const shops = jobs.allPois(p => p.c === 3 || p.c === 0), rp = jobs.roadPoints(5000, S.x, S.z);
    const from = jobs.pickNear(shops, S.x, S.z, 200, 1800) || jobs.pickNear(shops, S.x, S.z, 0, 3000);
    const to = from && jobs.pickNear(rp, from.x, from.z, 1800, 4500);
    if (!from || !to) { toast('“Nothing right now. Hit me up later.”'); return; }
    const d = Math.hypot(to.x - from.x, to.z - from.z), pay = Math.round((220 + d * 0.14) * repMult() / 10) * 10;
    run = { type: 'pkg', stage: 'pick', from, to: { ...to, n: to.n ? `a car parked on ${to.n}` : 'the drop spot' }, pay, limit: d * 1.35 / 15 + 75, t: 0 };
    place(from); startNav(from.x, from.z, from.name); show();
    toast(`📱 Dre: “Pick up a bag behind ${from.name}. Don’t open it. ${money(pay)} when it lands.”`);
  }
  // ── per frame: races and runs ──
  function update(dt) {
    if (!run || !LIFE_ON()) { if (run && !LIFE_ON()) stop(); return; }
    const spd = Math.hypot(S.vx, S.vz);
    if (run.type === 'race') {
      run.t += dt;
      const r = run;
      if (r.t < 0) { elT.textContent = `🏁 vs ${r.rival.name} · ${money(r.bet * 2)} pot`; elM.textContent = String(Math.ceil(-r.t)); elS.textContent = 'Get ready…'; arrow(r.pts[0]); if (Math.ceil(-r.t) !== Math.ceil(-(r.t - dt))) flashTag(r.t > -0.05 ? 'GO!' : String(Math.ceil(-r.t))); return; }
      const p = r.pts[r.i], d = Math.hypot(S.x - p.x, S.z - p.z); arrow(p);
      if (d < 16) { r.i++; buzz(20); sfx.whoosh(); if (r.i >= r.pts.length) return finishRace(); place(r.pts[r.i]); }
      const rivalPct = Math.min(1, r.t * r.rival.v / r.dist), myPct = r.i / r.pts.length;
      elT.textContent = `🏁 Street race vs ${r.rival.name}`; elM.textContent = `${r.i}/${r.pts.length}`;
      elS.innerHTML = `<span class="huBar"><i style="width:${(myPct * 100).toFixed(0)}%"></i><b style="left:${(rivalPct * 100).toFixed(0)}%"></b></span> ${rivalPct > myPct ? 'behind' : 'ahead'} · ${fmtDist(d)}`;
      if (rivalPct >= 1 && !r.lost) { r.lost = true; toast(`${r.rival.name} crossed the line first…`); }
      if (r.copAt > 0 && r.t > r.copAt) { r.copAt = -1; police.addWanted(2, 'Street racing'); }
      if (r.t > r.dist / 8) stop(`You bailed on the race — ${money(r.bet)} gone`);
      return;
    }
    if (run.type === 'pkg') {
      const r = run; r.t += dt;
      const tgt = r.stage === 'pick' ? r.from : r.to, d = Math.hypot(S.x - tgt.x, S.z - tgt.z); arrow(tgt);
      const left = r.limit - r.t;
      elT.textContent = '📦 Package run'; elM.textContent = r.stage === 'pick' ? 'Pick up' : `${Math.max(0, Math.floor(left / 60))}:${String(Math.max(0, Math.floor(left % 60))).padStart(2, '0')}`;
      elS.textContent = `${r.stage === 'pick' ? r.from.name : r.to.n} · ${fmtDist(d)} · ${money(r.pay)}`;
      el.classList.toggle('warn', r.stage === 'drop' && left < 30);
      if (r.stage === 'drop') {
        if (left <= 0) { addRep(-10); return stop('📱 Dre: “Too slow. Deal’s off.”'); }
        // patrol cars notice someone in a hurry with a bag
        if (!police.stars()) for (const c of traffic.cars) if (c.cop && !c.chase && Math.hypot(c.x - S.x, c.z - S.z) < 70 && Math.random() < dt * 0.25) { police.addWanted(2, 'Suspicious package'); break; }
      }
      if (d < (tgt.c !== undefined ? 45 : 28) && spd < 3) {
        if (r.stage === 'pick') { r.stage = 'drop'; r.t = 0; place(r.to); startNav(r.to.x, r.to.z, 'Drop spot'); toast(`Got the bag. Get it to ${r.to.n} — the clock is running.`); buzz(30); }
        else { life.earn(r.pay, 'Cash — package run'); addRep(25); flashTag(`+${money(r.pay)}`); stop('📱 Dre: “Smooth. Cash is yours.”'); story.emit('pkg'); }
      }
    }
  }
  function finishRace() {
    const r = run, won = r.t * r.rival.v < r.dist;
    if (won) { const pot = Math.round(r.bet * 2 * (1 + 0.03 * repLvl())); life.earn(pot, `Street race winnings vs ${r.rival.name}`); addRep(30); flashTag('YOU WIN'); stop(`You beat ${r.rival.name}! ${money(pot)} pot`); story.emit('race-win'); }
    else { addRep(5); flashTag('LOST'); stop(`${r.rival.name} won. ${money(r.bet)} gone.`); }
  }
  // ── full-screen panels: ticket flipping and blackjack (reuse the shift panel) ──
  const box = $('shift'), body = $('shBody'), oT = $('shTitle'), oTime = $('shTime'), oSc = $('shScore'), oHint = $('shHint'), oSkip = $('shSkip');
  let ov = null, ovTimer = null;
  function openOv(title, hint, leaveText, onLeave) {
    ov = { onLeave }; box.classList.add('on'); paused = true; oT.textContent = title; oHint.textContent = hint; oSkip.textContent = leaveText; oTime.textContent = ''; oSc.textContent = ''; $('shBar').style.width = '0%';
  }
  function closeOv() { clearInterval(ovTimer); ov = null; box.classList.remove('on'); paused = false; last = performance.now(); oSkip.textContent = 'Skip shift · base pay'; }
  oSkip.addEventListener('click', () => { if (ov) { const f = ov.onLeave; f && f(); } });
  // ── 4. ticket flipping outside the venues ──
  function eventAt(v) { const d = jobs.today() % 7; return v.ev.find(e => e.d.includes(d) && tod >= e.h - 3 && tod <= e.h + 0.25); }
  function todaysEvents() { const d = jobs.today() % 7, out = []; for (const v of VENUES) for (const e of v.ev) if (e.d.includes(d) && tod <= e.h + 0.25) out.push({ v, e }); return out.sort((a, b) => a.e.h - b.e.h); }
  function flip(v, e) {
    const n = 4, cost = e.face * n;
    if (L.money < cost) { toast(`You need ${money(cost)} to buy the 4 tickets`); return; }
    life.pay(cost, `4 tickets — ${e.t}`);
    let left = n, cash = 0, fan = null, t = 45, kicked = false, haggled = false;
    const FANS = ['A dad with two kids in jerseys', 'College kids splitting the cost', 'A couple on a date night', 'A guy who drove in from Rochester', 'Superfan with a painted face', 'Someone checking their phone a lot'];
    const nextFan = () => {
      const sec = Math.random() < 0.13;
      fan = { who: sec ? pick(['A guy in a plain polo with an earpiece', 'Someone who keeps asking “so where’d you get these?”', 'A woman with a lanyard tucked into her jacket']) : pick(FANS), offer: Math.round(e.face * (0.75 + Math.random() * e.hot * 0.9) * (1 + 0.02 * repLvl())), sec };
      haggled = false; draw();
    };
    const pick = a => a[(Math.random() * a.length) | 0];
    const draw = () => {
      body.innerHTML = `<div class="shCard"><small>${esc(v.n.toUpperCase())} · ${esc(e.t.toUpperCase())}</small><b>${left} ticket${left === 1 ? '' : 's'} left</b><span>Paid ${money(e.face)} each · cash so far ${money(cash)}</span></div>` +
        (fan && left ? `<div class="shCard"><small>A FAN WALKS UP</small><b style="font-size:16px">${esc(fan.who)}</b><span>“I’ll give you <b>${money(fan.offer)}</b> for one.”</span></div><div class="shGrid three"><button data-a="sell">Sell</button><button data-a="haggle"${haggled ? ' disabled' : ''}>Ask ${money(fan.offer * 1.25)}</button><button data-a="pass">Pass</button></div>` : '') +
        (!left ? '<button class="shGo" data-a="done">Sold out — head out</button>' : '');
    };
    const end = () => {
      closeOv(); const profit = cash - cost;
      if (cash) life.earn(cash, `Ticket sales — ${v.n}`);
      addRep(profit > 0 ? 10 : 0);
      toast(kicked ? `Security walked you off the property — kept ${money(cash)}, lost the rest` : `Done flipping: ${profit >= 0 ? 'profit' : 'loss'} of ${money(Math.abs(profit))}`);
    };
    openOv(`🎟️ Flipping tickets · ${v.n}`, 'Sell to fans for more than you paid. Venue security doesn’t want resellers on their property — watch who you deal with.', 'Walk away', end);
    body.onclick = ev => {
      const b = ev.target.closest('button'); if (!b || !ov) return;
      const a = b.dataset.a;
      if (a === 'done') return end();
      if (!fan) return;
      if (a === 'sell') { if (fan.sec) { kicked = true; feedback(false, 'Security!'); return end(); } cash += fan.offer; left--; feedback(true, `+${money(fan.offer)}`); }
      if (a === 'haggle') { haggled = true; if (fan.sec) { kicked = true; feedback(false, 'Security!'); return end(); } if (Math.random() < 0.5) { const p = Math.round(fan.offer * 1.25); cash += p; left--; feedback(true, `+${money(p)}`); } else { feedback(false, 'They walked'); } }
      if (a === 'pass') feedback(true, 'Next');
      left ? nextFan() : draw();
    };
    nextFan();
    ovTimer = setInterval(() => { t -= 0.1; oTime.textContent = `⏱ ${Math.max(0, Math.ceil(t))}s`; oSc.textContent = `💵 ${money(cash)}`; $('shBar').style.width = Math.max(0, t / 45 * 100) + '%'; if (t <= 0) end(); }, 100);
  }
  function feedback(ok, msg) { const f = document.createElement('div'); f.className = 'shFx ' + (ok ? 'ok' : 'no'); f.textContent = msg; box.appendChild(f); setTimeout(() => f.remove(), 700); buzz(ok ? 12 : 40); }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // ── 5. back-room blackjack (nights) ──
  function cards(spot) {
    const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let deck = [], hand = null, bet = 50, net = 0, hands = 0;
    const shuffleDeck = () => { deck = []; for (let k = 0; k < 4; k++) for (const s of SUITS) for (const r of RANKS) deck.push([r, s]); for (let i = deck.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [deck[i], deck[j]] = [deck[j], deck[i]]; } };
    const draw1 = () => { if (deck.length < 20) shuffleDeck(); return deck.pop(); };
    const val = h => { let v = 0, a = 0; for (const [r] of h) { if (r === 'A') { a++; v += 11; } else v += ['J', 'Q', 'K'].includes(r) ? 10 : +r; } while (v > 21 && a) { v -= 10; a--; } return v; };
    const cardHtml = (c, hide) => hide ? '<i class="card back"></i>' : `<i class="card ${c[1] === '♥' || c[1] === '♦' ? 'red' : ''}">${c[0]}<small>${c[1]}</small></i>`;
    const render = msg => {
      const h = hand;
      body.innerHTML = `<div class="bj"><small>DEALER${h && !h.done ? '' : h ? ' · ' + val(h.d) : ''}</small><div class="hand">${h ? h.d.map((c, i) => cardHtml(c, i === 1 && !h.done)).join('') : ''}</div>
        <small>YOU${h ? ' · ' + val(h.p) : ''}</small><div class="hand">${h ? h.p.map(c => cardHtml(c)).join('') : ''}</div>
        <div class="bjMsg">${msg || ''}</div></div>` +
        (!h || h.done ? `<div class="shLab">Bet</div><div class="shChips">${[25, 50, 100, 250, 500].map(v => `<button class="${v === bet ? 'on' : ''}" data-bet="${v}">$${v}</button>`).join('')}</div><button class="shGo" data-a="deal">Deal · ${money(bet)}</button>`
          : `<div class="shGrid three"><button data-a="hit">Hit</button><button data-a="stand">Stand</button><button data-a="double"${h.p.length > 2 || L.money < h.bet ? ' disabled' : ''}>Double</button></div>`);
      oSc.textContent = `${net >= 0 ? '+' : '−'}${money(Math.abs(net))} tonight`;
    };
    const settle = () => {
      const h = hand; h.done = true;
      const pv = val(h.p);
      if (pv <= 21) while (val(h.d) < 17) h.d.push(draw1());
      const dv = val(h.d), bj = pv === 21 && h.p.length === 2;
      let win = 0, msg;
      if (pv > 21) { msg = 'Bust.'; }
      else if (bj && !(dv === 21 && h.d.length === 2)) { win = h.bet * 2.5; msg = 'Blackjack! Pays 3 to 2.'; }
      else if (dv > 21 || pv > dv) { win = h.bet * 2; msg = dv > 21 ? 'Dealer busts — you win.' : 'You win.'; }
      else if (pv === dv) { win = h.bet; msg = 'Push.'; }
      else msg = 'Dealer wins.';
      if (win) life.earn(win, 'Blackjack payout');
      net += win - h.bet; hands++;
      if (Math.random() < 0.025) { // a raid
        closeOv(); life.pay(250, 'Fine — illegal gambling'); police.addWanted(1, 'Illegal card game');
        toast('🚨 Police raid! You got a $250 citation and slipped out the back.'); return;
      }
      render(msg);
    };
    body.onclick = ev => {
      const b = ev.target.closest('button'); if (!b || !ov) return;
      if (b.dataset.bet) { bet = +b.dataset.bet; render(); return; }
      const a = b.dataset.a;
      if (a === 'deal') {
        if (L.money < bet) { render('Not enough cash for that bet.'); return; }
        life.pay(bet, 'Blackjack bet');
        hand = { p: [draw1(), draw1()], d: [draw1(), draw1()], bet, done: false };
        if (val(hand.p) === 21) return settle();
        render(); return;
      }
      if (!hand || hand.done) return;
      if (a === 'hit') { hand.p.push(draw1()); if (val(hand.p) >= 21) return settle(); render(); }
      if (a === 'stand') settle();
      if (a === 'double') { life.pay(hand.bet, 'Blackjack double down'); hand.bet *= 2; hand.p.push(draw1()); settle(); }
    };
    shuffleDeck();
    openOv(`🃏 Blackjack · ${spot.n.replace('Back-room blackjack — ', '')}`, 'Dealer stands on 17 · blackjack pays 3:2 · cops raid now and then.', 'Cash out & leave', () => { closeOv(); if (hands) toast(`You left ${net >= 0 ? 'up' : 'down'} ${money(Math.abs(net))}`); if (net > 200) addRep(5); });
    render('Place your bet.');
  }
  // ── 6. the bookie: bets on tonight's and tomorrow's games (sports betting isn't legal in Minnesota) ──
  if (!L.bets) L.bets = [];
  const SPORTS = /game|match/;
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };
  function lines() { // games today (not started yet) and tomorrow, with a moneyline for the home team
    const out = [], d0 = jobs.today();
    for (let k = 0; k < 2; k++) {
      const d = d0 + k;
      for (const v of VENUES) for (const e of v.ev) {
        if (!SPORTS.test(e.t) || !e.d.includes(d % 7) || (k === 0 && tod >= e.h)) continue;
        const pw = 0.35 + hash(`${d}:${v.n}`) * 0.33; // home win chance 35–68%
        const fair = p => 1 / p, juice = 0.95; // the house keeps about 5%
        out.push({ id: `${d}:${v.n}`, d, k, v: v.n, t: e.t, h: e.h, team: e.t.replace(/ (game|match)$/, ''), pw, oddsW: +(fair(pw) * juice).toFixed(2), oddsL: +(fair(1 - pw) * juice).toFixed(2) });
      }
    }
    return out.sort((a, b) => a.d - b.d || a.h - b.h);
  }
  function placeBet(id, side, stake) {
    const g = lines().find(x => x.id === id); if (!g) { toast('That game’s already started'); return; }
    if (L.money < stake) { toast(`You need ${money(stake)}`); return; }
    if (L.bets.filter(b => !b.done).length >= 6) { toast('“You’ve got enough action. Wait till those settle.”'); return; }
    const odds = side === 'W' ? g.oddsW : g.oddsL;
    life.pay(stake, `Bet with Sal — ${g.team} ${side === 'W' ? 'to win' : 'to lose'}`);
    L.bets.push({ id, d: g.d, h: g.h, team: g.team, side, stake, odds, pw: g.pw, done: false });
    life.touch(); life.save(); toast(`📱 Sal: “${money(stake)} on the ${g.team} ${side === 'W' ? 'winning' : 'losing'} at ${odds}x. You’re on.”`);
  }
  function settleBets() {
    const now = jobs.today() * 24 + tod;
    for (const b of L.bets) {
      if (b.done || now < b.d * 24 + b.h + 3) continue;
      b.done = true; const homeWon = hash(b.id + ':result') < b.pw;
      b.won = (b.side === 'W') === homeWon;
      if (b.won) { const pay = Math.round(b.stake * b.odds); life.earn(pay, `Sal paid out — ${b.team}`); toast(`📱 Sal: “${b.team} ${homeWon ? 'won' : 'lost'}. You hit — ${money(pay)}.”`); flashTag(`+${money(pay)}`); addRep(3); }
      else toast(`📱 Sal: “${b.team} ${homeWon ? 'won' : 'lost'}. Tough one. Better luck next time.”`);
      life.touch();
    }
    if (L.bets.length > 30) L.bets = L.bets.filter(b => !b.done).concat(L.bets.filter(b => b.done).slice(-10));
  }
  // ── what the action button offers around the shady spots ──
  function action() {
    if (run || inside.on) return null;
    const spd = Math.hypot(S.vx, S.vz); if (spd > 2.5) return null;
    if (L.hot) { const s = near('chop', 60); if (s) return { label: `🔧 Sell this car for parts · ~${money((CHOP_VALUE[L.hot.type] || 600) * repMult())}`, fn: () => chop(s) }; }
    const r = near('race', 70);
    if (r && S.mode !== 'foot') { const bet = Math.min(1000, 100 + repLvl() * 100); return night(20, 4) ? { label: `🏁 Street race · ${money(bet)} buy-in`, fn: () => startRace(r, bet) } : { label: '🏁 Races start at 8 PM', fn: () => toast('Come back after 8 PM — races run until 4 AM') }; }
    const c = near('cards', 60);
    if (c) return night(21, 3) ? { label: '🃏 Back-room blackjack', fn: () => cards(c) } : { label: '🃏 The game starts at 9 PM', fn: () => toast('The back room opens at 9 PM') };
    for (const v of VENUES) if (Math.hypot(v.x - S.x, v.z - S.z) < 220) { const e = eventAt(v); if (e) return { label: `🎟️ Flip tickets · ${e.t}`, fn: () => flip(v, e) }; }
    return null;
  }
  $('huQuit').onclick = () => { if (run && run.type === 'race') stop(`You bailed — ${money(run.bet)} gone`); else if (run) { addRep(-5); stop('You dumped the package.'); } };
  return { addRep, lines, placeBet, settleBets, update, action, startRun, chop, startRace, flip, cards, todaysEvents, nearest, repLvl, repMult, overlayOn: () => !!ov, active: () => !!run, stop, spots: HUSTLE_SPOTS, VENUES, night };
})();
window.__hustle = hustle;
// ───────────────────────── weapons, health and contracts ─────────────────────────
// Guns come from Dre's black market. On foot you auto-aim at the nearest threat in front of you. Contracts from "the
// Broker" are made-up characters (with bodyguards at higher street rep) at real places; pulling one off brings 3 stars.
// Health regenerates; at zero you wake up at HCMC with an ER bill. Busted = your guns are confiscated.
const GUNS = {
  pistol: { n: 'Pistol', ic: '🔫', dmg: 34, rate: 0.38, range: 45, price: 800, ammo0: 60, pack: 30, packPrice: 60 },
  smg: { n: 'SMG', ic: '💥', dmg: 15, rate: 0.095, range: 38, price: 3500, ammo0: 150, pack: 90, packPrice: 150 },
};
const HOSPITAL = (() => { const [x, z] = proj(44.9727, -93.2617); return { x, z }; })();
const combat = (() => {
  const L = LIFE;
  if (!L.guns) L.guns = {}; if (!L.weapon || (L.weapon !== 'none' && !L.guns[L.weapon])) L.weapon = 'none';
  const P = { hp: 100, hurtT: 9, cool: 0, fire: false, aimT: 0, lock: null };
  const npcs = [];
  const T = THREE, own = m => { m.userData.terr = true; return m; };
  const gy = (x, z, y = 0) => y + terrainAt(x, z);
  // ── effects: tracers, muzzle flashes, the lock-on ring, hand-held guns ──
  const trGeo = new T.BufferGeometry(); trGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(6 * 24), 3));
  const trMat = own(new T.LineBasicMaterial({ color: '#ffe08a', transparent: true, opacity: 0.9 }));
  const tracers = new T.LineSegments(trGeo, trMat); tracers.frustumCulled = false; scene.add(tracers);
  const trList = []; // [x0,y0,z0,x1,y1,z1,life]
  const flashMat = own(new T.MeshBasicMaterial({ color: '#ffd36b', transparent: true, opacity: 0.95, depthWrite: false }));
  const flashGeo = new T.SphereGeometry(0.12, 8, 6), flashes = [];
  const ringMat = own(new T.MeshBasicMaterial({ color: '#ff3b30', transparent: true, opacity: 0.75, side: T.DoubleSide, depthWrite: false }));
  const ring = new T.Mesh(new T.RingGeometry(0.55, 0.75, 28), ringMat); ring.rotation.x = -Math.PI / 2; ring.visible = false; scene.add(ring);
  const tgtMat = own(new T.MeshBasicMaterial({ color: '#ff3b30', transparent: true, opacity: 0.22, depthWrite: false, side: T.DoubleSide }));
  const beam = new T.Mesh(new T.CylinderGeometry(1.2, 1.2, 90, 12, 1, true), tgtMat); beam.visible = false; scene.add(beam);
  const gunMat = own(new T.MeshLambertMaterial({ color: '#1b1d21' }));
  function makeGun(smg) { const g = new T.Group(); const b = new T.Mesh(new T.BoxGeometry(0.05, 0.08, smg ? 0.42 : 0.24), gunMat); b.position.z = smg ? 0.12 : 0.06; g.add(b); const h = new T.Mesh(new T.BoxGeometry(0.045, 0.13, 0.06), gunMat); h.position.set(0, -0.08, -0.02); g.add(h); g.visible = false; scene.add(g); return g; }
  const myGun = { pistol: makeGun(false), smg: makeGun(true) };
  function tracer(a, b) { trList.push([a.x, a.y, a.z, b.x, b.y, b.z, 0.07]); const f = own(new T.Mesh(flashGeo, flashMat)); f.position.copy(a); f.userData.life = 0.05; scene.add(f); flashes.push(f); }
  function fxTick(dt) {
    const arr = trGeo.attributes.position.array; let n = 0;
    for (let i = trList.length - 1; i >= 0; i--) { const t = trList[i]; t[6] -= dt; if (t[6] <= 0) { trList.splice(i, 1); continue; } }
    for (const t of trList.slice(-24)) { arr.set(t.slice(0, 6), n * 6); n++; }
    trGeo.setDrawRange(0, n * 2); trGeo.attributes.position.needsUpdate = true;
    for (let i = flashes.length - 1; i >= 0; i--) { const f = flashes[i]; f.userData.life -= dt; if (f.userData.life <= 0) { scene.remove(f); flashes.splice(i, 1); } }
  }
  // ── point a figure's right arm (and gun) along a direction, whatever its bind pose ──
  const _q = new T.Quaternion(), _q2 = new T.Quaternion(), _v = new T.Vector3(), _v2 = new T.Vector3(), _m = new T.Matrix4();
  function bindInfo(F) {
    if (F.aim) return F.aim;
    const idx = n => F.bones.findIndex(b => b.name === n), ia = idx('RightArm'), ifa = idx('RightForeArm'), ih = idx('RightHand');
    if (ia < 0 || ifa < 0 || ih < 0) return (F.aim = { ok: false });
    const inv = F.mesh.skeleton.boneInverses, bq = k => { const p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3(); _m.copy(inv[k]).invert().decompose(p, q, s); return { p, q }; };
    const A = bq(ia), FA = bq(ifa), H = bq(ih);
    return (F.aim = { ok: true, ia, ifa, ih, qA: A.q, qF: FA.q, qH: H.q, d0: FA.p.clone().sub(A.p).normalize() });
  }
  function aimArm(F, dir) {
    const I = bindInfo(F); if (!I.ok) return null;
    F.root.updateMatrixWorld(true);
    // the bind direction of the upper arm, as it sits in the world right now (the root's heading turns it)
    F.root.getWorldQuaternion(_q2); // includes the heading; bind space is the root's unrotated frame
    const d0w = _v.copy(I.d0).applyQuaternion(_q2), R = new T.Quaternion().setFromUnitVectors(d0w, dir);
    for (const [k, qb] of [[I.ia, I.qA], [I.ifa, I.qF], [I.ih, I.qH]]) {
      const b = F.bones[k];
      const want = R.clone().multiply(_q2).multiply(qb); // world orientation: bind (in the root's frame), swung onto the aim line
      b.parent.getWorldQuaternion(_q); b.quaternion.copy(_q.invert().multiply(want)); b.updateMatrixWorld(true);
    }
    return F.bones[I.ih].getWorldPosition(new T.Vector3());
  }
  function holdGun(g, hand, dir) { if (!hand) { g.visible = false; return; } g.visible = true; g.position.copy(hand).addScaledVector(dir, 0.08); g.quaternion.setFromUnitVectors(_v2.set(0, 0, 1), dir); }
  // ── people: contract targets and their bodyguards ──
  async function spawnNPC(id, x, z, role) {
    await loadCharFile('boss'); if (!BOSS.clips.walk) { const A = await loadCharFile('anims').catch(() => null); if (A) Object.assign(BOSS.clips, A); }
    await figAsset(id); const F = figInstance(id); F.grp.visible = true;
    const n = { F, id, x, z, h: Math.random() * 6.28, v: 0, hp: role === 'guard' ? 70 : 60, role, state: 'idle', t: Math.random() * 5, gait: 0, phase: 0, cool: 1 + Math.random(), hx: x, hz: z, wT: 0, dead: false, deadT: 0, gun: role === 'guard' ? makeGun(false) : null };
    npcs.push(n); return n;
  }
  function removeNPCs() { for (const n of npcs) { scene.remove(n.F.grp); if (n.gun) scene.remove(n.gun); } npcs.length = 0; beam.visible = false; ring.visible = false; }
  function animNPC(n, dt) {
    const F = n.F, C = F.clips, walk = C.walk || C.strut, run = C.run || C.fastrun;
    if (n.dead) { // fall over and stay down
      n.deadT = Math.min(1, n.deadT + dt * 2.2);
      posePlay(F, C.idle, 0, F.qa, F.ha);
      const B = F.bones; for (let k = 0; k < F.nb; k++) B[k].quaternion.set(F.qa[k * 4], F.qa[k * 4 + 1], F.qa[k * 4 + 2], F.qa[k * 4 + 3]); B[0].position.set(F.ha[0], F.ha[1], F.ha[2]);
      const e = 1 - Math.pow(1 - n.deadT, 3);
      F.root.position.set(n.x, gy(n.x, n.z) + 0.15 * e, n.z); F.root.rotation.set(-Math.PI / 2 * e, n.h, 0, 'YXZ');
      if (n.gun) n.gun.visible = false;
      return;
    }
    const sp = Math.abs(n.v), target = sp < 0.15 ? 0 : sp < 2.6 ? 1 : 2;
    n.gait += (target - n.gait) * Math.min(1, dt * 7); n.t += dt;
    const ref = n.gait > 1.5 ? run : walk; n.phase += dt * (sp > 0.15 ? sp / Math.max(0.5, ref.speed || 1) : 1);
    const cyc = c => n.phase * ((c.n - 1) / c.fps);
    posePlay(F, C.idle, n.t, F.qa, F.ha);
    if (n.gait > 0.01) { posePlay(F, walk, cyc(walk), F.qb, F.hb); poseBlend(F, F.qa, F.ha, F.qb, F.hb, Math.min(1, n.gait)); }
    if (n.gait > 1.01) { posePlay(F, run, cyc(run), F.qb, F.hb); poseBlend(F, F.qa, F.ha, F.qb, F.hb, Math.min(1, n.gait - 1)); }
    const B = F.bones; for (let k = 0; k < F.nb; k++) B[k].quaternion.set(F.qa[k * 4], F.qa[k * 4 + 1], F.qa[k * 4 + 2], F.qa[k * 4 + 3]); B[0].position.set(F.ha[0], F.ha[1], F.ha[2]);
    F.root.position.set(n.x, gy(n.x, n.z), n.z); F.root.rotation.set(0, n.h, 0);
    if (n.aiming) { const d = new T.Vector3(S.x - n.x, (S.y + 1.3 + terrainAt(S.x, S.z)) - (gy(n.x, n.z) + 1.4), S.z - n.z).normalize(); holdGun(n.gun, aimArm(F, d), d); }
    else if (n.gun) n.gun.visible = false;
  }
  function moveNPC(n, dt, tx, tz, speed) {
    const dx = tx - n.x, dz = tz - n.z, d = Math.hypot(dx, dz);
    if (d < 0.3) { n.v += (0 - n.v) * Math.min(1, dt * 6); return d; }
    n.h += angDiff(Math.atan2(dx, dz), n.h) * Math.min(1, dt * 6);
    n.v += (speed - n.v) * Math.min(1, dt * 4);
    const p = { x: n.x + Math.sin(n.h) * n.v * dt, z: n.z + Math.cos(n.h) * n.v * dt, y: 0 };
    if (collideBuildings(p, 0.35)) n.wT += dt;
    n.x = p.x; n.z = p.z; return d;
  }
  // ── the player's health ──
  function hurt(dmg, why) {
    if (P.hp <= 0 || !LIFE_ON()) return;
    P.hp -= dmg; P.hurtT = 0; addTrauma(0.25); buzz(30);
    const v = $('hurt'); v.style.opacity = Math.min(0.85, 0.35 + dmg / 30).toFixed(2);
    if (P.hp <= 0) wasted(why);
  }
  function wasted(why) {
    P.hp = 0; flashTag('WASTED'); toast(`You went down${why ? ' — ' + why : ''}. You wake up at HCMC.`);
    setTimeout(() => {
      police.clearWanted(); hustle.stop(); contractFail(null, true);
      if (L.hot) police.dropHot();
      life.pay(1200, 'HCMC emergency room bill');
      teleport(HOSPITAL.x, HOSPITAL.z, 'Hennepin Healthcare — you’re patched up. ER bill: $1,200');
      P.hp = 100; $('hurt').style.opacity = 0;
    }, 1600);
  }
  // ── shooting ──
  const visible = (ax, az, bx, bz) => { const d = Math.hypot(bx - ax, bz - az), n = Math.ceil(d / 3); for (let i = 1; i < n; i++) { const f = i / n, p = { x: ax + (bx - ax) * f, z: az + (bz - az) * f, y: 0 }; if (collideBuildings(p, 0.05)) return false; } return true; };
  function findLock() {
    const g = GUNS[L.weapon]; if (!g) return null;
    let best = null, bs = 1e9; const fx = Math.sin(S.h), fz = Math.cos(S.h);
    for (const n of [...npcs, ...peds.list]) {
      if (n.dead || n.state === 'dead') continue;
      const ped = !n.role; if (ped && Math.hypot(n.x - S.x, n.z - S.z) > 22) continue; // bystanders only when close (threats come first)
      const dx = n.x - S.x, dz = n.z - S.z, d = Math.hypot(dx, dz) * (ped ? 1.6 : 1); if (d > g.range * 1.6) continue;
      const c = (dx * fx + dz * fz) / (d || 1); if (c < 0.45) continue;
      const sc = d * (2 - c); if (sc < bs && visible(S.x, S.z, n.x, n.z)) { bs = sc; best = n; }
    }
    return best;
  }
  function shoot() {
    const g = GUNS[L.weapon]; if (!g || S.mode !== 'foot' || inside.on || P.cool > 0) return;
    if (!(L.guns[L.weapon] > 0)) { toast(`Out of ${g.n} ammo — buy more from Dre (📱 Hustle)`); P.cool = 0.6; return; }
    L.guns[L.weapon]--; P.cool = g.rate; P.aimT = 1.4; life.touch();
    const tgt = P.lock = findLock();
    if (tgt) S.h += angDiff(Math.atan2(tgt.x - S.x, tgt.z - S.z), S.h); // snap to the target
    sfx.shot && sfx.shot(L.weapon === 'smg' ? 0.6 : 1);
    const muzzle = P.hand ? P.hand.clone() : new T.Vector3(S.x + Math.sin(S.h) * 0.5, gy(S.x, S.z, S.y) + 1.35, S.z + Math.cos(S.h) * 0.5);
    let end;
    if (tgt) {
      const d = Math.hypot(tgt.x - S.x, tgt.z - S.z), hit = Math.random() < 0.95 - d / g.range * 0.45;
      end = new T.Vector3(tgt.x + (hit ? 0 : (Math.random() - 0.5) * 2), terrainAt(tgt.x, tgt.z) + 1.2 + (hit ? 0 : Math.random()), tgt.z + (hit ? 0 : (Math.random() - 0.5) * 2));
      if (hit) { if (tgt.role) damageNPC(tgt, g.dmg * (0.85 + Math.random() * 0.3)); else if ((tgt.hp -= g.dmg) <= 0) peds.kill(tgt, 'Murder'); }
    } else end = muzzle.clone().add(new T.Vector3(Math.sin(S.h) * g.range, 0, Math.cos(S.h) * g.range));
    tracer(muzzle, end);
    alertAll(); peds.alarm(S.x, S.z, 70, 'Shots fired', 2);
    if (!police.stars() && traffic.cars.some(c => c.cop && Math.hypot(c.x - S.x, c.z - S.z) < 130)) police.addWanted(2, 'Shots fired');
  }
  function damageNPC(n, dmg) {
    n.hp -= dmg; n.state = n.role === 'guard' ? 'attack' : 'flee';
    if (n.hp <= 0 && !n.dead) {
      n.dead = true; n.v = 0;
      if (n.role === 'target') contractDone();
      else police.addWanted(Math.min(5, Math.max(3, police.stars() + 1)), 'Shootout');
    }
  }
  function alertAll() { for (const n of npcs) if (!n.dead && Math.hypot(n.x - S.x, n.z - S.z) < 90) n.state = n.role === 'guard' ? 'attack' : 'flee'; }
  // ── contracts from the Broker ──
  const FIRST = ['Vinnie', 'Lou', 'Frankie', 'Dutch', 'Carla', 'Benny', 'Marco', 'Rita', 'Sully', 'Nicky'], NICK = ['“The Fish”', '“Two Phones”', '“Knuckles”', '“The Accountant”', '“Lucky”', '“Slick”', '“Ice”', '“Bones”'];
  const LAST = ['Marchetti', 'Kowalski', 'Lindqvist', 'Delgado', 'Brennan', 'Okafor', 'Novak', 'Haugen', 'Ferraro', 'Pham'];
  const WHY = ['a loan shark who crossed the wrong people', 'skimming from the Broker’s card games', 'talking to the feds', 'stole a shipment and sold it twice', 'runs a rival chop shop', 'owes a lot of money to a lot of people'];
  const pk = a => a[(Math.random() * a.length) | 0];
  function offer() {
    if (L.contract && !L.contract.done) return L.contract;
    const spots = jobs.allPois(p => p.c === 8 || p.c === 0 || p.c === 7), at = jobs.pickNear(spots, S.x, S.z, 800, 4500) || jobs.pickNear(spots, S.x, S.z, 300, 7000);
    if (!at) return null;
    const lv = hustle.repLvl(), guards = Math.min(3, Math.floor(lv / 2) + (Math.random() < 0.4 ? 1 : 0));
    L.contract = { name: `${pk(FIRST)} ${pk(NICK)} ${pk(LAST)}`, why: pk(WHY), x: at.x, z: at.z, place: at.name, guards, pay: Math.round((2500 + guards * 1200 + Math.random() * 1500) * hustle.repMult() / 50) * 50, accepted: false, done: false, char: pk(['vegas', 'ty', 'remy', 'peasant', 'ch09']) };
    life.touch(); return L.contract;
  }
  function accept() {
    const c = offer(); if (!c) { toast('“Nothing for you right now.”'); return; }
    if (!Object.keys(L.guns).length) { toast('“You’re gonna need a piece. Talk to Dre.”'); return; }
    c.accepted = true; c.spawned = false; life.touch();
    startNav(c.x, c.z, c.place); toast(`📱 The Broker: “${c.name}. ${c.place}. Make it quick.”`);
  }
  function contractDone() {
    const c = L.contract; if (!c || c.done) return;
    c.done = true; life.earn(c.pay, 'Cash — the Broker'); flashTag(`+${money(c.pay)}`);
    police.addWanted(Math.max(3, police.stars()), 'Homicide'); hustle.addRep && hustle.addRep(40);
    toast(`📱 The Broker: “It’s done. ${money(c.pay)} is yours. Now lose the heat.”`);
    setTimeout(() => { if (L.contract === c) L.contract = null; }, 1000); life.touch(); life.save();
    beam.visible = false; if (nav.route) endNav(); story.emit('contract');
  }
  function contractFail(msg, quiet) {
    const c = L.contract; if (c && c.accepted && !c.done) { L.contract = null; life.touch(); if (!quiet) toast(msg || 'Contract failed'); }
    removeNPCs();
  }
  async function spawnContract(c) {
    c.spawned = true;
    const t = await spawnNPC(c.char, c.x + (Math.random() - 0.5) * 10, c.z + (Math.random() - 0.5) * 10, 'target').catch(() => null);
    if (!t) { c.spawned = false; return; }
    for (let i = 0; i < c.guards; i++) await spawnNPC(pk(['brute', 'ch24', 'ch39']), t.x + Math.cos(i * 2.1) * 3, t.z + Math.sin(i * 2.1) * 3, 'guard').catch(() => null);
  }
  // ── per frame ──
  function update(dt, on) {
    if (!LIFE_ON()) return;
    fxTick(dt);
    P.cool = Math.max(0, P.cool - dt); P.aimT = Math.max(0, P.aimT - dt); P.hurtT += dt;
    if (P.hurtT > 5 && P.hp < 100 && P.hp > 0) P.hp = Math.min(100, P.hp + dt * 2.5);
    const hv = $('hurt'); if (+hv.style.opacity > 0) hv.style.opacity = Math.max(0, +hv.style.opacity - dt * 1.2).toFixed(2);
    if (P.fire) shoot();
    // the contract: spawn the target when you get close; it escapes if it gets far enough away
    const c = L.contract;
    if (c && c.accepted && !c.done) {
      const d = Math.hypot(c.x - S.x, c.z - S.z);
      if (!c.spawned && d < 260) spawnContract(c);
      const t = npcs.find(n => n.role === 'target');
      const bx = t ? t.x : c.x, bz = t ? t.z : c.z;
      beam.visible = true; beam.position.set(bx, gy(bx, bz) + 45, bz);
      if (t && !t.dead && Math.hypot(t.x - S.x, t.z - S.z) > 220 && t.state === 'flee') contractFail(`${c.name} got away.`);
    } else { beam.visible = false; if (npcs.length && npcs.every(n => Math.hypot(n.x - S.x, n.z - S.z) > 250)) removeNPCs(); }
    // the people
    const armed = GUNS[L.weapon] && S.mode === 'foot';
    for (const n of npcs) {
      const dP = Math.hypot(S.x - n.x, S.z - n.z);
      if (!n.dead && S.mode !== 'foot' && Math.hypot(S.vx, S.vz) > 5 && dP < 2.4) { damageNPC(n, 999); bump(0.5); } // run over
      n.aiming = false;
      if (!n.dead) {
        if (n.state === 'idle') {
          if ((n.wT -= dt) <= 0) { n.wT = 3 + Math.random() * 5; n.tx = n.hx + (Math.random() - 0.5) * 16; n.tz = n.hz + (Math.random() - 0.5) * 16; }
          moveNPC(n, dt, n.tx ?? n.x, n.tz ?? n.z, 1.2);
          if (dP < (armed && P.aimT > 0 ? 40 : 9) || (n.role === 'guard' && dP < 14 && armed)) n.state = n.role === 'guard' ? 'attack' : 'flee';
        } else if (n.state === 'flee') {
          const ax = n.x - S.x, az = n.z - S.z, l = Math.hypot(ax, az) || 1;
          moveNPC(n, dt, n.x + ax / l * 10 + Math.sin(n.t) * 4, n.z + az / l * 10 + Math.cos(n.t * 0.7) * 4, 5.2);
        } else if (n.state === 'attack') {
          if (dP > 13) moveNPC(n, dt, S.x, S.z, 4.6); else { n.v += (0 - n.v) * Math.min(1, dt * 6); n.h += angDiff(Math.atan2(S.x - n.x, S.z - n.z), n.h) * Math.min(1, dt * 8); }
          if (dP < 40) {
            n.aiming = true; n.cool -= dt;
            if (n.cool <= 0 && visible(n.x, n.z, S.x, S.z)) {
              n.cool = 0.75 + Math.random() * 0.5;
              const from = n.F.bones[bindInfo(n.F).ih || 0].getWorldPosition(new T.Vector3()), to = new T.Vector3(S.x, gy(S.x, S.z, S.y) + 1.2, S.z);
              const inCar = S.mode !== 'foot', hit = Math.random() < (inCar ? 0.3 : 0.45) - dP / 200;
              if (!hit) to.add(new T.Vector3((Math.random() - 0.5) * 3, Math.random(), (Math.random() - 0.5) * 3));
              tracer(from, to); sfx.shot && sfx.shot(0.5 * Math.max(0.2, 1 - dP / 60));
              if (hit) hurt(inCar ? 4 : 8, 'shot by a bodyguard');
            }
          }
        }
      }
      animNPC(n, dt);
    }
    // the player's gun: raised while aiming or just after a shot
    for (const k in myGun) myGun[k].visible = false;
    P.hand = null;
    const F = ME.fig;
    if (armed && F && !inside.on) {
      P.lock = findLock();
      if (P.lock) { ring.visible = true; ring.position.set(P.lock.x, gy(P.lock.x, P.lock.z) + 0.05, P.lock.z); } else ring.visible = false;
      if (P.aimT > 0 || P.lock) {
        const tx = P.lock ? P.lock.x : S.x + Math.sin(S.h) * 20, tz = P.lock ? P.lock.z : S.z + Math.cos(S.h) * 20;
        const dir = new T.Vector3(tx - S.x, (P.lock ? gy(tx, tz) + 1.2 : gy(S.x, S.z, S.y) + 1.3) - (gy(S.x, S.z, S.y) + 1.4), tz - S.z).normalize();
        P.hand = aimArm(F, dir); holdGun(myGun[L.weapon], P.hand, dir);
      }
    } else ring.visible = false;
    // HUD
    const hb = $('hpBox'); hb.classList.toggle('on', P.hp < 99.5 || !!police.stars() || armed);
    $('hpFill').style.width = Math.max(0, P.hp) + '%';
    document.body.classList.toggle('armed', !!armed && !inside.on);
    const wb = $('btnWeap'); const g = GUNS[L.weapon]; wb.textContent = g ? `${g.ic}${L.guns[L.weapon] ?? 0}` : '✊'; wb.classList.toggle('has', Object.keys(L.guns).length > 0);
  }
  function cycleWeapon() {
    const list = ['none', ...Object.keys(GUNS).filter(k => L.guns[k] != null)];
    if (list.length < 2) { toast('No weapons — Dre sells them (📱 Hustle tab)'); return; }
    L.weapon = list[(list.indexOf(L.weapon) + 1) % list.length]; life.touch();
    toast(L.weapon === 'none' ? 'Weapon away' : `${GUNS[L.weapon].n} · ${L.guns[L.weapon]} rounds`);
  }
  function buy(k, ammo) {
    const g = GUNS[k];
    if (ammo) { if (L.guns[k] == null) return; if (L.money < g.packPrice) { toast(`You need ${money(g.packPrice)}`); return; } life.pay(g.packPrice, `Ammo — ${g.n}`); L.guns[k] += g.pack; toast(`+${g.pack} rounds`); }
    else { if (L.guns[k] != null) return; if (L.money < g.price) { toast(`You need ${money(g.price)}`); return; } life.pay(g.price, `Dre — ${g.n}`); L.guns[k] = g.ammo0; L.weapon = k; toast(`${g.n} bought — ${g.ammo0} rounds. Switch weapons with the ${g.ic} button (Q).`); }
    life.touch(); life.save();
  }
  function confiscate() { if (Object.keys(L.guns).length) { L.guns = {}; L.weapon = 'none'; toast('The police confiscated your guns'); life.touch(); } contractFail(null, true); }
  // fire controls: hold FIRE (touch) / K / click
  const fb = $('btnFire');
  fb.addEventListener('pointerdown', e => { e.preventDefault(); P.fire = true; fb.classList.add('down'); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) fb.addEventListener(ev, () => { P.fire = false; fb.classList.remove('down'); });
  addEventListener('keydown', e => { if (e.code === 'KeyK') P.fire = true; if (e.code === 'KeyQ' && !e.repeat && started && !paused) cycleWeapon(); });
  addEventListener('keyup', e => { if (e.code === 'KeyK') P.fire = false; });
  renderer.domElement.addEventListener('mousedown', e => { if (e.button === 0 && started && !paused && GUNS[L.weapon]) P.fire = true; });
  addEventListener('mouseup', () => { if (!fb.classList.contains('down')) P.fire = false; });
  $('btnWeap').onclick = cycleWeapon;
  return { update, hurt, buy, cycleWeapon, offer, accept, contractFail, confiscate, removeNPCs, spawnNPC, P, npcs, wasted };
})();
window.__combat = combat;
// ───────────────────────── people on the sidewalks ─────────────────────────
// Walkers along real streets (on the sidewalk, either side), from the lightest characters in the roster. Each body
// shares one mesh + texture per character and only gets its own skeleton. They scatter from gunfire and speeding
// cars, can be run over, and the ones who see a crime call 911.
const peds = (() => {
  const IDS = ['ty', 'vegas', 'peasant', 'granny', 'ch24', 'ch09'];
  const list = [], MAX = LOW ? 9 : 16, NEAR = 45, FAR = 170;
  let loading = false, spawnT = 0;
  const T = THREE;
  async function preload() { if (loading) return; loading = true; for (const id of IDS) await figAsset(id).catch(() => null); }
  // sidewalk graph per tile: city streets at grade
  function pedNodes(t) {
    if (t.pedNodes && t.pedNodesN === t.roads.length) return t.pedNodes;
    const m = new Map();
    for (const r of t.roads) {
      if (r.c < 2 || r.c > 7 || r.tunnel || !r.hs) continue;
      const p = r.pts, n = p.length / 2;
      for (const i of [0, n - 1]) { const k = Math.round(p[i * 2] * 2) + ',' + Math.round(p[i * 2 + 1] * 2); (m.get(k) || m.set(k, []).get(k)).push({ r, i }); }
    }
    t.pedNodes = m; t.pedNodesN = t.roads.length; return m;
  }
  const flat = r => { if (!r.hs) return false; for (const h of r.hs) if (Math.abs(h) > 0.3) return false; return true; };
  function spawn() {
    const ready = IDS.filter(id => FIGS[id]); if (!ready.length) return;
    const [tx, ty] = tileOf(S.x, S.z), cand = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const t = tiles.get((tx + i) + ',' + (ty + j)); if (t && t.state.r === 2) for (const r of t.roads) if (r.c >= 2 && r.c <= 7 && !r.tunnel && flat(r)) cand.push(r); }
    if (!cand.length) return;
    for (let tries = 0; tries < 20; tries++) {
      const r = cand[(Math.random() * cand.length) | 0], n = r.pts.length / 2, s = (Math.random() * (n - 1)) | 0;
      const ax = r.pts[s * 2], az = r.pts[s * 2 + 1], bx = r.pts[s * 2 + 2], bz = r.pts[s * 2 + 3], L = Math.hypot(bx - ax, bz - az); if (L < 4) continue;
      const u = Math.random() * L, x = ax + (bx - ax) * u / L, z = az + (bz - az) * u / L, d = Math.hypot(x - S.x, z - S.z);
      if (d < NEAR || d > FAR - 30) continue;
      // behind the camera is the best place to appear
      if (((x - S.x) * Math.sin(S.h) + (z - S.z) * Math.cos(S.h)) / d > 0.3 && Math.random() < 0.7) continue;
      const id = ready[(Math.random() * ready.length) | 0], F = figInstance(id);
      const p = { F, id, r, s, u, dir: Math.random() < 0.5 ? 1 : -1, side: Math.random() < 0.5 ? 1 : -1, v: 1.2 + Math.random() * 0.5, sp: 0, x, z, h: 0, state: 'walk', t: Math.random() * 3, gait: 0, phase: 0, fleeT: 0, deadT: 0, hp: 50, frame: (Math.random() * 3) | 0 };
      F.grp.visible = true; list.push(p); return;
    }
  }
  function remove(i) { const p = list[i]; scene.remove(p.F.grp); list.splice(i, 1); }
  // walk along the street; at its end carry on along another street from the same corner (or turn back)
  function advance(p, dist) {
    let r = p.r, guard = 0;
    while (dist > 0 && guard++ < 6) {
      const n = r.pts.length / 2, a = p.dir > 0 ? p.s : p.s + 1, b = p.dir > 0 ? p.s + 1 : p.s;
      const L = Math.hypot(r.pts[b * 2] - r.pts[a * 2], r.pts[b * 2 + 1] - r.pts[a * 2 + 1]) || 0.01;
      if (p.u + dist < L) { p.u += dist; return; }
      dist -= L - p.u; p.u = 0;
      const ns = p.s + p.dir;
      if (ns >= 0 && ns < n - 1) { p.s = ns; continue; }
      // a corner: pick another street from here
      const e = p.dir > 0 ? n - 1 : 0, ex = r.pts[e * 2], ez = r.pts[e * 2 + 1], t = tiles.get(tileOf(ex, ez).join(','));
      const opts = t ? (pedNodes(t).get(Math.round(ex * 2) + ',' + Math.round(ez * 2)) || []).filter(o => o.r !== r && flat(o.r)) : [];
      if (opts.length && Math.random() < 0.85) { const o = opts[(Math.random() * opts.length) | 0]; p.r = r = o.r; const m = r.pts.length / 2; if (o.i === 0) { p.dir = 1; p.s = 0; } else { p.dir = -1; p.s = m - 2; } }
      else { p.dir = -p.dir; p.s = Math.max(0, Math.min(n - 2, p.s)); p.side = -p.side; }
    }
  }
  function place(p) {
    const r = p.r, a = p.dir > 0 ? p.s : p.s + 1, b = p.dir > 0 ? p.s + 1 : p.s;
    const ax = r.pts[a * 2], az = r.pts[a * 2 + 1], bx = r.pts[b * 2], bz = r.pts[b * 2 + 1], L = Math.hypot(bx - ax, bz - az) || 1;
    const dx = (bx - ax) / L, dz = (bz - az) / L, off = (r.w || 8) / 2 + 1.7;
    // the sidewalk on our right (right of travel = (-dz, dx))
    p.x = ax + dx * p.u - dz * off * p.side; p.z = az + dz * p.u + dx * off * p.side;
    const th = Math.atan2(dx, dz); p.h += angDiff(th, p.h) * 0.25;
  }
  // a crime nearby: anyone within sight flees, and somebody calls it in
  function alarm(x, z, R, why, stars) {
    let witness = false;
    for (const p of list) if (p.state !== 'dead' && Math.hypot(p.x - x, p.z - z) < R) { p.state = 'flee'; p.fleeT = 6 + Math.random() * 4; p.fx = x; p.fz = z; witness = true; }
    if (witness && why && LIFE_ON()) police.addWanted(Math.max(police.stars(), stars || 1), why);
    return witness;
  }
  function kill(p, why) {
    if (p.state === 'dead') return;
    p.state = 'dead'; p.deadT = 0; p.dieT = 0; p.sp = 0;
    alarm(p.x, p.z, 45, why, why === 'Hit a pedestrian' ? 1 : 3);
  }
  function anim(p, dt) {
    const F = p.F, C = F.clips, walk = C.walk || C.strut, run = C.run || C.fastrun;
    if (p.state === 'dead') {
      p.dieT = Math.min(1, p.dieT + dt * 2.4);
      posePlay(F, C.idle, 0, F.qa, F.ha);
      const B = F.bones; for (let k = 0; k < F.nb; k++) B[k].quaternion.set(F.qa[k * 4], F.qa[k * 4 + 1], F.qa[k * 4 + 2], F.qa[k * 4 + 3]); B[0].position.set(F.ha[0], F.ha[1], F.ha[2]);
      const e = 1 - Math.pow(1 - p.dieT, 3); F.root.position.set(p.x, terrainAt(p.x, p.z) + 0.15 * e, p.z); F.root.rotation.set(-Math.PI / 2 * e, p.h, 0, 'YXZ'); return;
    }
    const target = p.sp < 0.15 ? 0 : p.sp < 2.6 ? 1 : 2;
    p.gait += (target - p.gait) * Math.min(1, dt * 7); p.t += dt;
    const ref = p.gait > 1.5 ? run : walk; p.phase += dt * (p.sp > 0.15 ? p.sp / Math.max(0.5, ref.speed || 1) : 1);
    const cyc = c => p.phase * ((c.n - 1) / c.fps);
    posePlay(F, C.idle, p.t, F.qa, F.ha);
    if (p.gait > 0.01) { posePlay(F, walk, cyc(walk), F.qb, F.hb); poseBlend(F, F.qa, F.ha, F.qb, F.hb, Math.min(1, p.gait)); }
    if (p.gait > 1.01) { posePlay(F, run, cyc(run), F.qb, F.hb); poseBlend(F, F.qa, F.ha, F.qb, F.hb, Math.min(1, p.gait - 1)); }
    const B = F.bones; for (let k = 0; k < F.nb; k++) B[k].quaternion.set(F.qa[k * 4], F.qa[k * 4 + 1], F.qa[k * 4 + 2], F.qa[k * 4 + 3]); B[0].position.set(F.ha[0], F.ha[1], F.ha[2]);
    F.root.position.set(p.x, terrainAt(p.x, p.z), p.z); F.root.rotation.set(0, p.h, 0);
  }
  let frame = 0;
  function update(dt) {
    const on = settings.peds !== false && started && !inside.on;
    if (!on) { if (list.length) for (let i = list.length - 1; i >= 0; i--) remove(i); return; }
    preload();
    frame++;
    for (let i = list.length - 1; i >= 0; i--) { const p = list[i], d = Math.hypot(p.x - S.x, p.z - S.z); if (d > FAR || (p.state === 'dead' && (p.deadT += dt) > 40) || !tiles.has(tileOf(p.x, p.z).join(','))) remove(i); }
    if ((spawnT -= dt) <= 0 && list.length < MAX) { spawnT = 0.35; spawn(); }
    const carSp = S.mode === 'foot' ? 0 : Math.hypot(S.vx, S.vz), fx = Math.sin(S.h), fz = Math.cos(S.h);
    for (const p of list) {
      const d = Math.hypot(p.x - S.x, p.z - S.z);
      if (p.state !== 'dead') {
        // a car bearing down on you: jump out of the way (or not)
        if (carSp > 4 && d < 2.3 && Math.abs((S.y || 0)) < 2) { kill(p, 'Hit a pedestrian'); bump(0.4); }
        else if (carSp > 9 && d < 14 && ((p.x - S.x) * fx + (p.z - S.z) * fz) > 0 && p.state === 'walk') { p.state = 'flee'; p.fleeT = 2.5; p.fx = S.x; p.fz = S.z; }
        if (p.state === 'flee') {
          p.fleeT -= dt; p.sp += (5.2 - p.sp) * Math.min(1, dt * 4);
          const ax = p.x - p.fx, az = p.z - p.fz, l = Math.hypot(ax, az) || 1, th = Math.atan2(ax / l, az / l);
          p.h += angDiff(th, p.h) * Math.min(1, dt * 6);
          const q = { x: p.x + Math.sin(p.h) * p.sp * dt, z: p.z + Math.cos(p.h) * p.sp * dt, y: 0 }; collideBuildings(q, 0.35); p.x = q.x; p.z = q.z;
          if (p.fleeT <= 0) { p.state = 'walk'; // rejoin the nearest sidewalk
            const nr = nearestRoad(p.x, p.z, 40); if (nr && nr.road.c >= 2 && nr.road.c <= 7 && flat(nr.road)) { p.r = nr.road; p.s = Math.max(0, Math.min(nr.road.pts.length / 2 - 2, nr.s || 0)); p.u = 0; p.dir = 1; } else p.fleeT = 3; }
        } else { p.sp += (p.v - p.sp) * Math.min(1, dt * 3); advance(p, p.sp * dt); place(p); }
        // the player on foot bumps through crowds
        if (S.mode === 'foot' && d < 0.7) { const ax = S.x - p.x, az = S.z - p.z, l = Math.hypot(ax, az) || 1; S.x = p.x + ax / l * 0.7; S.z = p.z + az / l * 0.7; }
      }
      if (d < 60 || (frame + p.frame) % 3 === 0) anim(p, d < 60 ? dt : dt * 3);
    }
  }
  return { update, alarm, kill, list, preload };
})();
window.__peds = peds; window.__FIGS = FIGS;
// ───────────────────────── the story: from Marcus's couch to running the town ─────────────────────────
// Missions arrive as texts on your phone. Each one is finished by doing something the game already has (a shift,
// renting a place, a package run, a race, a chop-shop sale, a contract) or a story-only set piece (Sal's crew, the
// armored truck). All the characters are made up.
const STORY = [
  { id: 'job', from: 'Marcus', title: 'Couch surfing', ev: ['shift', 'gig'], reward: 250, goal: 'Work a shift or finish a gig (📱 Jobs)',
    texts: ['Yo, you can crash on my couch as long as you need. But rent ain’t free forever 😅', 'Get a job — any job. Your phone’s Jobs tab has openings, or just drive deliveries.'] },
  { id: 'home', from: 'Marcus', title: 'A place of your own', ev: ['rent'], reward: 300, goal: 'Rent an apartment or a house (📱 Homes)',
    texts: ['Look at you, getting paid! 🙌', 'Now get your own place. My couch is wrecking your back and my vibe 😂 Check the Homes tab.'] },
  { id: 'dre', from: 'Dre', title: 'Easy money', ev: ['pkg'], reward: 500, goal: 'Finish a package run for Dre (📱 Hustle)',
    texts: ['Marcus says you’re good people. I’m his cousin Dre.', 'I got easy money if you got wheels. Hit me up on the Hustle tab. Don’t open the bag.'] },
  { id: 'race', from: 'Dre', title: 'Street cred', ev: ['race-win'], reward: 750, goal: 'Win a street race (8 PM–4 AM, 📱 Hustle)',
    texts: ['Smooth. People are already asking about you.', 'Wanna make a name? The races run after 8. Win one and I’ll introduce you to some real players.'] },
  { id: 'chop', from: 'Dre', title: 'Hot wheels', ev: ['chop'], reward: 1000, goal: 'Steal a car and sell it to a chop shop',
    texts: ['My guy at the salvage yard needs inventory.', 'Walk up to a stopped car, take it (F / door button), and drive it to any chop shop. Nicer car, bigger payday.'] },
  { id: 'broker', from: 'The Broker', title: 'A new number', ev: ['contract'], reward: 2000, goal: 'Buy a gun from Dre, then finish a contract for the Broker',
    texts: ['Dre speaks highly of you. I don’t hear that often.', 'I have work for someone with steady hands. Get a piece from Dre, then take my contract. Both are on your Hustle tab.'] },
  { id: 'sal', from: 'The Broker', title: 'Sal’s debt', ev: ['clear'], reward: 5000, goal: 'Take out Sal’s crew at the Northside warehouse lot', enc: { kind: 'clear', at: [45.0035, -93.2795], n: 3, name: 'Northside warehouse lot' },
    texts: ['Sal the bookie has been skimming from my card games.', 'His crew is holed up in a warehouse lot on the Northside. Make them understand. Bring ammo.'] },
  { id: 'truck', from: 'The Broker', title: 'The big score', ev: ['heist'], reward: 0, goal: 'Ram the armored truck until it stops, grab the cash, then lose the cops', enc: { kind: 'truck' },
    texts: ['One last job. An armored truck just left the bank downtown with a week of deposits.', 'Ram it until it stops, take the cash, and lose the heat. After this you work for no one.'] },
];
const story = (() => {
  const L = LIFE;
  const S0 = () => ({ i: 0, msgs: [], unread: 0, done: false, pending: true });
  if (!L.story) L.story = S0();
  const st = L.story;
  const el = $('objective'); let kicked = false;
  const cur = () => STORY[st.i];
  function text(from, msg) { st.msgs.push({ from, msg, h: L.hours }); if (st.msgs.length > 80) st.msgs.shift(); st.unread++; life.touch(); toast(`💬 ${from}: ${msg.length > 70 ? msg.slice(0, 68) + '…' : msg}`); buzz(25); }
  function begin() { // the current mission's texts arrive, a few seconds apart
    const m = cur(); if (!m) return; st.pending = false;
    m.texts.forEach((t, k) => setTimeout(() => text(m.from, t), 1500 + k * 3500));
    life.save();
  }
  function emit(ev) {
    const m = cur(); if (!m || st.pending || st.done || !m.ev.includes(ev)) return;
    if (m.reward) life.earn(m.reward, `Story: ${m.title}`);
    flashTag('MISSION COMPLETE'); toast(`✅ ${m.title}${m.reward ? ` · +${money(m.reward)}` : ''}`); sfx.whoosh();
    hustle.addRep(m.id === 'job' || m.id === 'home' ? 0 : 15);
    clearEnc();
    st.i++; st.pending = true; life.touch(); life.save();
    if (!cur()) { st.done = true; setTimeout(() => { text('Marcus', 'Bro… everybody’s talking about the armored truck. Was that YOU?? 😳'); text('The Broker', 'You run this town now. Spend it wisely.'); flashTag('THE END?'); }, 4000); return; }
    kicked = true; setTimeout(begin, 7000);
  }
  // ── set pieces ──
  let enc = null; // { kind, npcs, truck, grabbed }
  const mkMat = new THREE.MeshBasicMaterial({ color: '#ffd23a', transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }); mkMat.userData.terr = true;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 120, 12, 1, true), mkMat); beam.visible = false; scene.add(beam);
  function clearEnc() { if (enc && enc.truck) enc.truck.dead = true; enc = null; beam.visible = false; }
  async function spawnClear(m) {
    const [x, z] = proj(m.enc.at[0], m.enc.at[1]);
    enc = { kind: 'clear', x, z, npcs: [], spawning: true };
    for (let k = 0; k < m.enc.n; k++) { const n = await combat.spawnNPC(['brute', 'ch24', 'ch39'][k % 3], x + Math.cos(k * 2.1) * 4, z + Math.sin(k * 2.1) * 4, 'guard').catch(() => null); if (n) { n.hp = 90; enc.npcs.push(n); } }
    enc.spawning = false;
  }
  function spawnTruck() {
    const c = traffic.spawn(S.x, S.z, 120, 300, { armored: true, color: '#4a5546', tall: 1.3, len: 1.25, hits: 0 });
    if (c) enc = { kind: 'truck', truck: c, grabbed: false };
  }
  function onHit(c, v) {
    if (!enc || enc.kind !== 'truck' || c !== enc.truck || v < 5) return;
    c.hits = (c.hits || 0) + 1;
    if (c.hits >= 3) { c.v = 0; c.hitT = 1e9; c.stopped = true; flashTag('TRUCK STOPPED'); toast('The truck’s down! Get out (F) and grab the cash.'); }
    else toast(`Armored truck: hit ${c.hits}/3`);
  }
  { const prev = window.__hitCar; window.__hitCar = (c, v) => { if (prev) prev(c, v); onHit(c, v); }; }
  function update(dt) {
    if (!LIFE_ON() || !started) { el.classList.remove('on'); return; }
    const m = cur();
    if (!st.done && st.pending && !kicked) { kicked = true; setTimeout(begin, 6000); } // first texts (or the next mission after a reload)
    // the objective line
    const show = m && !st.pending;
    el.classList.toggle('on', !!show);
    if (show) el.textContent = `📖 ${m.goal}`;
    $('btnPhone').classList.toggle('msg', st.unread > 0);
    if (!m || st.pending) { beam.visible = false; return; }
    // set pieces
    if (m.enc && m.enc.kind === 'clear') {
      const [x, z] = proj(m.enc.at[0], m.enc.at[1]);
      beam.visible = !enc || enc.npcs.some(n => !n.dead); beam.position.set(x, terrainAt(x, z) + 60, z);
      if (!enc && Math.hypot(x - S.x, z - S.z) < 260) spawnClear(m);
      if (enc && enc.kind === 'clear' && !enc.spawning) {
        for (const n of enc.npcs) if (!n.dead && n.state === 'idle' && Math.hypot(n.x - S.x, n.z - S.z) < 45) n.state = 'attack';
        if (enc.npcs.length && enc.npcs.every(n => n.dead)) { emit('clear'); return; }
        if (!combat.npcs.some(n => enc.npcs.includes(n))) { enc = null; } // wiped (e.g. you went down) — they'll be back
      }
    }
    if (m.enc && m.enc.kind === 'truck') {
      if (!enc) spawnTruck();
      else if (enc.truck && (enc.truck.dead || !traffic.cars.includes(enc.truck)) && !enc.grabbed) { enc = null; } // lost it: another one rolls out
      if (enc && enc.truck && !enc.grabbed) { const c = enc.truck; beam.visible = true; beam.position.set(c.x, terrainAt(c.x, c.z) + 60, c.z); }
      else if (enc && enc.grabbed) { beam.visible = false; if (!police.stars()) emit('heist'); }
    }
  }
  // the action button next to a stopped truck
  function action() {
    if (!enc || enc.kind !== 'truck' || enc.grabbed || !enc.truck || !enc.truck.stopped || S.mode !== 'foot') return null;
    if (Math.hypot(enc.truck.x - S.x, enc.truck.z - S.z) > 7) return null;
    return { label: '💰 Grab the cash', fn: () => {
      enc.grabbed = true; const cash = 25000; life.earn(cash, 'The armored truck'); flashTag(`+${money(cash)}`);
      police.addWanted(4, 'Armored truck robbery'); peds.alarm(S.x, S.z, 80);
      toast('You’ve got the bags! Now lose the cops — 4 stars.'); enc.truck.dead = true; enc.truck = null;
    } };
  }
  function read() { st.unread = 0; life.touch(); }
  function reset() { L.story = S0(); life.save(); location.reload(); }
  return { emit, update, action, read, st: () => st, cur, STORY, reset };
})();
window.__story = story;
const overlayUp = () => shiftGame.isOn() || phone.isOpen() || hustle.overlayOn();

// ───────────────────────── challenges: timed runs, checkpoint rush, landmark hunt ─────────────────────────
const DISCOVER = [
  ['Stone Arch Bridge', 44.9806, -93.2533], ['Guthrie Theater', 44.9780, -93.2551], ['Mill City Museum', 44.9789, -93.2570],
  ['U.S. Bank Stadium', 44.9736, -93.2575], ['Target Field', 44.9817, -93.2777], ['Target Center', 44.9795, -93.2761],
  ['First Avenue', 44.9785, -93.2762], ['IDS Center', 44.9760, -93.2721], ['Foshay Tower', 44.9747, -93.2725],
  ['Minneapolis City Hall', 44.9773, -93.2654], ['Grain Belt sign', 44.9862, -93.2654], ['Basilica of Saint Mary', 44.9732, -93.2862],
  ['Spoonbridge and Cherry', 44.9697, -93.2891], ['Minneapolis Institute of Art', 44.9585, -93.2738], ['Midtown Global Market', 44.9485, -93.2603],
  ['Bde Maka Ska', 44.9425, -93.3120], ['Lake Harriet Bandshell', 44.9220, -93.3060], ['Minnehaha Falls', 44.9153, -93.2110],
  ['Northrop Auditorium', 44.9764, -93.2353], ['Weisman Art Museum', 44.9732, -93.2370], ['Huntington Bank Stadium', 44.9765, -93.2246],
  ['Minnesota State Capitol', 44.9551, -93.1022], ['Cathedral of Saint Paul', 44.9469, -93.1093], ['Xcel Energy Center', 44.9448, -93.1010],
  ['Allianz Field', 44.9530, -93.1652], ['Como Zoo & Conservatory', 44.9817, -93.1523], ['State Fairgrounds', 44.9817, -93.1700],
  ['Harriet Island', 44.9385, -93.0947], ['Historic Fort Snelling', 44.8925, -93.1806], ['Southdale Center', 44.8810, -93.3253],
  ['Mall of America', 44.8549, -93.2422], ['MSP Airport', 44.8820, -93.2050], ['Minnesota Zoo', 44.7666, -93.1960], ['Valleyfair', 44.7983, -93.4554],
].map(([n, la, lo]) => { const [x, z] = proj(la, lo); return { n, x, z }; });
const RUNS = [
  { n: 'Stadium Sprint', from: 'U.S. Bank Stadium', to: 'Target Field' },
  { n: 'Lakes Loop', from: 'Bde Maka Ska', to: 'Minnehaha Falls' },
  { n: 'Downtown to the Mall', from: 'Minneapolis City Hall', to: 'Mall of America' },
  { n: 'Twin Cities Dash', from: 'Guthrie Theater', to: 'Minnesota State Capitol' },
  { n: 'Airport Run', from: 'Southdale Center', to: 'MSP Airport' },
  { n: 'Zoo Trip', from: 'Historic Fort Snelling', to: 'Minnesota Zoo' },
];
const chal = (() => {
  const load = k => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const found = load('tcd-found'), best = load('tcd-best');
  const D = n => DISCOVER.find(d => d.n === n);
  const fmt = t => { const m = Math.floor(t / 60), sec = t - m * 60; return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`; };
  const el = $('chal'), elT = $('chalTitle'), elM = $('chalMain'), elS = $('chalSub'), elA = $('chalArrow');
  let cur = null; // the challenge in progress
  // ── 3D gate: a glowing ring with a light column, lifted onto the terrain ──
  const gateMat = new THREE.MeshBasicMaterial({ color: '#ffb02e', transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const beamColMat = new THREE.MeshBasicMaterial({ color: '#ffb02e', transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
  const makeGate = () => { const g = new THREE.Group(); const ring = new THREE.Mesh(new THREE.TorusGeometry(7, 0.45, 8, 40), gateMat); ring.position.y = 7.4; g.add(ring); const col = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 160, 12, 1, true), beamColMat); col.position.y = 80; g.add(col); g.visible = false; scene.add(g); return g; };
  const gates = [makeGate(), makeGate()];
  function placeGates() {
    gates.forEach(g => (g.visible = false));
    if (!cur || cur.type !== 'cp') return;
    for (let k = 0; k < 2; k++) {
      const p = cur.pts[cur.i + k]; if (!p) continue;
      const g = gates[k]; g.visible = true; g.position.set(p.x, p.y, p.z); g.rotation.y = Math.atan2(p.dx, p.dz); g.scale.setScalar(k ? 0.6 : 1);
      g.children[0].material = gateMat;
    }
  }
  function show(on) { el.classList.toggle('on', on); }
  function stop(msg) { if (cur && cur.type === 'run') endNav(); cur = null; placeGates(); show(false); if (msg) toast(msg); }
  // ── landmark hunt ──
  function discover() {
    for (const d of DISCOVER) if (!found[d.n] && Math.hypot(S.x - d.x, S.z - d.z) < 80) {
      found[d.n] = Date.now(); save('tcd-found', found);
      flashTag('DISCOVERED'); toast(`${d.n} · ${Object.keys(found).length}/${DISCOVER.length} landmarks`); sfx.whoosh(); buzz(30);
    }
  }
  // ── checkpoint rush: 8 gates on real roads around you, beat the clock ──
  function roadPoints() {
    const out = [];
    for (const t of tiles.values()) {
      if (t.state.r !== 2) continue;
      for (const r of t.roads) {
        if (r.c > 6 || r.tunnel) continue;
        const p = r.pts, n = p.length / 2;
        for (let i = 0; i < n - 1; i++) {
          if (r.hs && Math.abs(r.hs[i]) > 0.3) continue;
          const L = Math.hypot(p[i * 2 + 2] - p[i * 2], p[i * 2 + 3] - p[i * 2 + 1]); if (L < 8) continue;
          out.push({ x: (p[i * 2] + p[i * 2 + 2]) / 2, z: (p[i * 2 + 1] + p[i * 2 + 3]) / 2, dx: (p[i * 2 + 2] - p[i * 2]) / L, dz: (p[i * 2 + 3] - p[i * 2 + 1]) / L, y: 0 });
        }
      }
    }
    return out;
  }
  function startRush() {
    stop();
    const cand = roadPoints(); if (cand.length < 50) { toast('Drive a little first — the roads around you are still loading'); return; }
    const pts = []; let px = S.x, pz = S.z, hx = Math.sin(S.h), hz = Math.cos(S.h);
    for (let k = 0; k < 8; k++) {
      let pick = null;
      for (let tries = 0; tries < 400 && !pick; tries++) {
        const c = cand[(Math.random() * cand.length) | 0], d = Math.hypot(c.x - px, c.z - pz);
        const lo = tries < 250 ? 260 : 150, hi = tries < 250 ? 520 : 800;
        if (d < lo || d > hi) continue;
        if (((c.x - px) * hx + (c.z - pz) * hz) / d < (tries < 150 ? -0.1 : -0.8)) continue; // mostly onwards, not back
        if (pts.some(q => Math.hypot(q.x - c.x, q.z - c.z) < 180)) continue;
        pick = c;
      }
      if (!pick) break;
      const sf = surfaceAt(pick.x, pick.z, 5); pick.y = sf ? sf.h : 0;
      hx = (pick.x - px); hz = (pick.z - pz); const l = Math.hypot(hx, hz) || 1; hx /= l; hz /= l;
      pick.d = Math.hypot(pick.x - px, pick.z - pz); px = pick.x; pz = pick.z; pts.push(pick);
    }
    if (pts.length < 4) { toast("Couldn't lay out a course here — try somewhere with more streets"); return; }
    cur = { type: 'cp', pts, i: 0, t: 0, left: pts[0].d / 17 + 8, total: pts.length };
    placeGates(); show(true); flashTag('GO!'); sfx.whoosh();
  }
  // ── timed run: teleport to the start, count down, then race the GPS route to the finish ──
  function startRun(run) {
    stop();
    const a = D(run.from), b = D(run.to); if (!a || !b) return;
    teleport(a.x, a.z, run.n);
    cur = { type: 'run', run, b, t: 0, count: 3.5, par: Math.hypot(b.x - a.x, b.z - a.z) * 1.35 / 17, navd: false };
    show(true);
  }
  function update(dt) {
    discover();
    if (!cur) return;
    const fx = Math.sin(S.h), fz = Math.cos(S.h);
    const arrow = (x, z) => { const a = Math.atan2(x - S.x, z - S.z) - Math.atan2(fx, fz); elA.style.transform = `rotate(${(-a * 180 / Math.PI).toFixed(1)}deg)`; };
    if (cur.type === 'cp') {
      cur.t += dt; cur.left -= dt;
      const p = cur.pts[cur.i], d = Math.hypot(S.x - p.x, S.z - p.z);
      if (d < 13 && Math.abs(S.y - p.y) < 4) {
        cur.i++; buzz(20); sfx.whoosh();
        if (cur.i >= cur.pts.length) {
          const k = 'rush', prev = best[k], t = cur.t; let msg = `Course complete in ${fmt(t)}`;
          if (!prev || t < prev) { best[k] = t; save('tcd-best', best); msg += prev ? ' · new best!' : ''; }
          flashTag('FINISH'); stop(msg); return;
        }
        cur.left += cur.pts[cur.i].d / 17 + 5; flashTag(`+${Math.round(cur.pts[cur.i].d / 17 + 5)}s`); placeGates();
      }
      if (cur.left <= 0) { stop(`Out of time — ${cur.i}/${cur.total} checkpoints`); return; }
      const q = cur.pts[cur.i]; arrow(q.x, q.z);
      elT.textContent = `Checkpoint ${cur.i + 1}/${cur.total}`; elM.textContent = fmt(Math.max(0, cur.left)); elS.textContent = fmtDist(Math.hypot(S.x - q.x, S.z - q.z));
      el.classList.toggle('warn', cur.left < 8);
    } else if (cur.type === 'run') {
      if (cur.count > 0) { // countdown: hold the car at the start
        if (pendingSnap) { elT.textContent = cur.run.n; elM.textContent = 'Loading…'; elS.textContent = ''; return; }
        cur.count -= dt; S.vx = S.vz = 0;
        elT.textContent = cur.run.n; elM.textContent = cur.count > 0.5 ? String(Math.ceil(cur.count - 0.5)) : 'GO'; elS.textContent = `to ${cur.run.to}`;
        if (cur.count <= 0) { flashTag('GO!'); sfx.whoosh(); startNav(cur.b.x, cur.b.z, cur.run.to); }
        return;
      }
      cur.t += dt;
      if (!cur.navd && nav.route) { cur.navd = true; cur.par = nav.route.duration * 0.7; }
      const d = Math.hypot(S.x - cur.b.x, S.z - cur.b.z);
      arrow(cur.b.x, cur.b.z);
      const k = 'run:' + cur.run.n, pb = best[k];
      elT.textContent = `${cur.run.n} · par ${fmt(cur.par)}`; elM.textContent = fmt(cur.t); elS.textContent = `${fmtDist(d)} to go${pb ? ' · best ' + fmt(pb) : ''}`;
      el.classList.toggle('warn', cur.t > cur.par);
      if (d < 40) {
        const t = cur.t, medal = t <= cur.par ? 'GOLD' : t <= cur.par * 1.25 ? 'SILVER' : t <= cur.par * 1.6 ? 'BRONZE' : '';
        let msg = `${cur.run.n}: ${fmt(t)}${medal ? ' · ' + medal.toLowerCase() : ''}`;
        if (!pb || t < pb) { best[k] = t; save('tcd-best', best); if (pb) msg += ' · new best!'; }
        flashTag(medal || 'FINISH'); stop(msg);
      }
    }
  }
  // ── the challenges panel ──
  const panel = $('chalPanel'), list = $('chalList');
  function render() {
    const nf = Object.keys(found).length;
    let h = `<div class="chSec">Checkpoint rush</div><button class="navRes" data-a="rush"><span class="ic">🏁</span><span class="tx"><b>8 checkpoints from here</b><small>Beat the clock through gates on the streets around you${best.rush ? ' · best ' + fmt(best.rush) : ''}</small></span></button>`;
    h += '<div class="chSec">Timed runs</div>';
    RUNS.forEach((r, i) => { const pb = best['run:' + r.n]; h += `<button class="navRes" data-a="run" data-i="${i}"><span class="ic">⏱️</span><span class="tx"><b>${r.n}</b><small>${r.from} → ${r.to}${pb ? ' · best ' + fmt(pb) : ''}</small></span></button>`; });
    h += `<div class="chSec">Landmark hunt · ${nf}/${DISCOVER.length} found</div>`;
    DISCOVER.forEach((d, i) => { const f = !!found[d.n]; h += `<button class="navRes${f ? ' done' : ''}" data-a="lm" data-i="${i}"><span class="ic">${f ? '✅' : '📍'}</span><span class="tx"><b>${d.n}</b><small>${f ? 'Found' : fmtDist(Math.hypot(S.x - d.x, S.z - d.z)) + ' away · tap to navigate'}</small></span></button>`; });
    list.innerHTML = h;
  }
  function open() { panel.classList.add('on'); paused = true; render(); }
  function close() { panel.classList.remove('on'); paused = false; last = performance.now(); }
  list.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.a, i = +b.dataset.i; close();
    if (a !== 'lm' && jobs.gig()) jobs.goOffline(true);
    if (a === 'rush') startRush();
    else if (a === 'run') startRun(RUNS[i]);
    else if (a === 'lm' && !found[DISCOVER[i].n]) startNav(DISCOVER[i].x, DISCOVER[i].z, DISCOVER[i].n);
  };
  $('chalClose').onclick = close; $('btnChal').onclick = open; $('chalQuit').onclick = () => stop('Challenge cancelled');
  window.__chal = () => cur && { type: cur.type, i: cur.i, n: cur.pts ? cur.pts.length : 0, left: cur.left, t: cur.t, next: cur.pts ? cur.pts[cur.i] : cur.b, count: cur.count };
  return { update, open, close, active: () => !!cur, stop, isOpen: () => panel.classList.contains('on') };
})();
$('navMute').onclick = () => { nav.muted = !nav.muted; $('navMute').textContent = nav.muted ? '🔇' : '🔊'; if (nav.muted && 'speechSynthesis' in window) speechSynthesis.cancel(); };

// ───────────────────────── input ─────────────────────────
const KEYS = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'brake', ShiftLeft: 'boost', ShiftRight: 'boost' };
addEventListener('keydown', e => {
  if (KEYS[e.code]) { if (KEYS[e.code] === 'brake' && !e.repeat) input.tap = performance.now(); input[KEYS[e.code]] = 1; e.preventDefault(); }
  if (e.code === 'KeyC') cycleCam();
  if (e.code === 'KeyF' && !e.repeat) toggleFoot();
  if (e.code === 'KeyJ') chal.isOpen() ? chal.close() : chal.open();
  if (e.code === 'KeyT') { tod = (Math.floor(tod) + 1) % 24; applyTime(tod); toast(clockText()); }
  if (e.code === 'KeyM') bigMap.classList.contains('on') ? closeMap() : openMap();
  if (e.code === 'KeyR' && !inside.on) respawnOnRoad();
  if (e.code === 'KeyE' && !e.repeat && started && !paused) life.doAction();
  if (e.code === 'KeyP' && !e.repeat && !shiftGame.isOn() && !hustle.overlayOn()) phone.isOpen() ? phone.close() : (started && !paused && phone.open());
  if (e.code === 'Escape' && phone.isOpen()) phone.close();
  if (e.code === 'KeyG') openNavPanel();
  if (e.code === 'Escape' && bigMap.classList.contains('on')) closeMap();
});
addEventListener('keyup', e => { if (KEYS[e.code]) input[KEYS[e.code]] = 0; });
function cycleCam() { camMode = (camMode + 1) % CAM_MODES.length; toast(CAM_MODES[camMode] + ' camera'); }
document.querySelectorAll('[data-k]').forEach(el => {
  const k = el.dataset.k;
  const on = e => { e.preventDefault(); input[k] = 1; if (k === 'brake') input.tap = performance.now(); el.classList.add('down'); try { el.setPointerCapture(e.pointerId); } catch {} };
  const off = e => { input[k] = 0; el.classList.remove('down'); };
  el.addEventListener('pointerdown', on); el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('lostpointercapture', off);
  el.addEventListener('contextmenu', e => e.preventDefault());
});
$('btnCam').onclick = cycleCam;
$('btnMap').onclick = openMap;
$('btnReset').onclick = () => { if (!inside.on) respawnOnRoad(); };
$('btnDoor').onclick = toggleFoot;
{ const tl = document.querySelector('.tools'); $('btnMore').onclick = () => tl.classList.toggle('more'); $('moreTray').addEventListener('click', () => setTimeout(() => tl.classList.remove('more'), 150)); }
// character picker (Golf Go roster)
{ const cs = $('optChar'); for (const [id, name] of CHAR_LIST) { const o = document.createElement('option'); o.value = id; o.textContent = name; cs.appendChild(o); }
  cs.value = settings.char || 'ch01'; cs.onchange = e => { settings.char = e.target.value; saveSettings(); if (S.mode === 'foot') useCharacter(settings.char); }; }
$('btnMenu').onclick = () => { if (LIFE_ON() && started) { LIFE.pos = { x: S.x, z: S.z, h: S.h }; life.save(); } if (phone.isOpen()) phone.close(); paused = true; sfx.pause(true); $('menu').classList.add('on'); $('startBtn').textContent = 'Resume'; };
if (isTouch) document.body.classList.add('touch');

// ───────────────────────── menu ─────────────────────────
const sel = $('spawn');
if (LIFE.pos && settings.mode !== 'free') { const o = document.createElement('option'); o.value = -1; o.textContent = 'Where I left off' + (LIFE.home ? ` (home: ${LIFE.home.name})` : ''); sel.appendChild(o); sel.value = -1; }
PLACES.forEach((p, i) => { const o = document.createElement('option'); o.value = i; o.textContent = p.n; sel.appendChild(o); });
const colors = ['#d6332a', '#1f5fbf', '#f2f2ee', '#1d1f22', '#e8b81e', '#2e8b57', '#8a8f96', '#ef6c1a'];
const sw = $('swatches');
colors.forEach(c => { const b = document.createElement('button'); b.style.background = c; b.className = c === settings.color ? 'sel' : ''; b.onclick = () => { settings.color = c; car.userData.paint.color.set(c); saveSettings(); if (LIFE_ON() && LIFE.cars[LIFE.active]) { LIFE.cars[LIFE.active].color = c; life.touch(); } sw.querySelectorAll('button').forEach(x => x.className = ''); b.className = 'sel'; }; sw.appendChild(b); });
document.querySelectorAll('[data-car]').forEach(b => {
  b.classList.toggle('sel', b.dataset.car === settings.car);
  b.onclick = () => { settings.car = b.dataset.car; saveSettings(); setCar(); document.querySelectorAll('[data-car]').forEach(x => x.classList.toggle('sel', x === b)); };
});
$('optRadius').value = settings.radius; $('optBld').checked = settings.buildings; $('optTrees').checked = settings.trees; $('optShadows').checked = settings.shadows !== false;
$('optSound').checked = settings.sound !== false; $('optAuto').checked = !!settings.autoGas;
$('optTraffic').value = settings.traffic ?? 2; $('optIssues').checked = !!settings.showIssues;
$('optTraffic').onchange = e => { settings.traffic = +e.target.value; saveSettings(); };
$('optTime').value = settings.time ?? 'cycle';
$('optGfx').value = LOW ? 'low' : 'high';
$('optGfx').onchange = e => { settings.gfx = e.target.value; saveSettings(); location.reload(); };
$('optWeather').value = settings.weather || 'clear';
{ const m = $('optMode'); m.value = settings.mode === 'free' ? 'free' : 'life';
  const sync = () => document.body.classList.toggle('freeMode', settings.mode === 'free');
  sync(); m.onchange = e => { settings.mode = e.target.value; saveSettings(); sync(); setCar(); terrainizeScene(); life.hud(); };
  $('lifeReset').onclick = e => { e.preventDefault(); if (confirm('Start your life over? Your money, apartment and cars will be reset.')) { try { localStorage.removeItem(LIFE_KEY); } catch {} location.reload(); } }; }
$('optWeather').onchange = e => { settings.weather = e.target.value; saveSettings(); WX.next = 0; };
$('optTime').onchange = e => { settings.time = e.target.value; saveSettings(); if (TIME_PRESETS[settings.time] != null) { tod = TIME_PRESETS[settings.time]; applyTime(tod); } };
if (STATIC) $('optIssues').closest('label').style.display = 'none'; // no shared server to collect them
$('optIssues').onchange = e => { settings.showIssues = e.target.checked; saveSettings(); if (settings.showIssues) loadIssues(); };
$('optSound').onchange = e => { settings.sound = e.target.checked; saveSettings(); sfx.setOn(settings.sound); };
$('optAuto').onchange = e => { settings.autoGas = e.target.checked; saveSettings(); };
$('optRadius').onchange = e => { settings.radius = +e.target.value; saveSettings(); scene.fog.far = settings.radius > 1 ? 2600 : 1700; camera.far = scene.fog.far + 300; camera.updateProjectionMatrix(); };
$('optBld').onchange = e => { settings.buildings = e.target.checked; saveSettings(); reloadAll(); };
$('optTrees').onchange = e => { settings.trees = e.target.checked; saveSettings(); reloadAll(); };
$('optPeds').checked = settings.peds !== false; $('optPeds').onchange = e => { settings.peds = e.target.checked; saveSettings(); };
$('optShadows').onchange = e => { settings.shadows = e.target.checked; saveSettings(); renderer.shadowMap.enabled = settings.shadows; scene.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; }); }); };
function reloadAll() { for (const t of [...tiles.values()]) unloadTile(t); wantTiles(S.x, S.z); }
let started = false, paused = true;
let spawnIdx = 0;
$('startBtn').onclick = () => {
  $('menu').classList.remove('on');
  sfx.init(); sfx.pause(false);
  const idx = +sel.value;
  const at = /at=(-?[\d.]+),(-?[\d.]+)/.exec(location.hash);
  if (!started && at) { const [x, z] = proj(+at[1], +at[2]); teleport(x, z, 'Starting at your link'); }
  else if (!started && LIFE_ON() && idx === -1 && LIFE.pos) { teleport(LIFE.pos.x, LIFE.pos.z, 'Welcome back'); }
  else if (idx >= 0 ? (!started || idx !== spawnIdx) : !started) { spawnIdx = idx; const p = PLACES[Math.max(0, idx)]; teleport(p.x, p.z, p.n); }
  started = true; paused = false; last = performance.now();
  $('hud').classList.add('on');
  setCar(); terrainizeScene(); life.hud();
  if (LIFE_ON() && !LIFE.started) { LIFE.started = true; life.save(); setTimeout(() => { toast(`You have ${money(LIFE.money)} and a 2009 sedan. First step: get a job.`); phone.open('jobs'); }, 1800); }
};
scene.fog.far = settings.radius > 1 ? 2600 : 1700; camera.far = scene.fog.far + 300; camera.updateProjectionMatrix();

// ───────────────────────── loop ─────────────────────────
let last = performance.now(), tileCheck = 0;
const clock = { acc: 0 };
// idle background so the menu has something behind it
teleport(PLACES[0].x, PLACES[0].z);
let terrFrame = 0, terrNext = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (overlayUp()) { last = now; sfx.update(0, 0, false); sfx.siren(0); return; } // a full-screen panel is up: the world can wait (saves battery)
  if ((terrFrame++ % 15) === 0) terrainizeScene();
  sky.position.copy(camera.position); sky.scale.setScalar(camera.far * 0.9);
  tickTime(paused || !started ? 0 : Math.min(0.05, (now - last) / 1000));
  updateSun(S.x, S.y + terrainAt(S.x, S.z), S.z);
  { // night lights: fade the additive glows in, aim the player's headlights down the road
    const nv = NIGHT.value;
    for (const m of [poolMat, beamMat]) { m.opacity = nv * m.userData.nightK; m.visible = nv > 0.01; }
    haloMat.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
    headL.intensity = nv * 700;
    precipObj.frame(now / 1000);
    const fx = Math.sin(S.h), fz = Math.cos(S.h), ty = S.y + terrainAt(S.x, S.z);
    headL.position.set(S.x + fx * 2.2, ty + 0.75, S.z + fz * 2.2);
    headL.target.position.set(S.x + fx * 30, S.y + terrainAt(S.x + fx * 30, S.z + fz * 30) - 1.5, S.z + fz * 30); headL.target.updateMatrixWorld();
  }
  if (now > terrNext) { terrNext = now + 1200; updateTerrainWindow(S.x, S.z); }
  let dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (paused) { dt = 0; }
  let info = { vf: 0, nr: null };
  if (!paused) {
    // fixed sub-steps for stable physics
    clock.acc += dt; let steps = 0;
    while (clock.acc > 1 / 120 && steps < 14 && !inside.on) { info = S.mode === 'foot' ? physicsFoot(1 / 120) : physics(1 / 120); clock.acc -= 1 / 120; steps++; }
    if (inside.on) clock.acc = 0;
    if (!steps) info = { vf: S.vx * Math.sin(S.h) + S.vz * Math.cos(S.h), nr: nearestRoad(S.x, S.z, 40) };
  } else {
    if (!started) S.h += 0.0015; // slow orbit behind the title menu
    info.nr = null;
  }
  const CP = S.mode === 'foot' ? PARKED : S; // on foot the car stays where you left it
  car.position.set(CP.x, CP.y, CP.z);
  car.rotation.set(-CP.pitch, CP.h, CP.groll, 'YXZ');
  TU.uCarP.value.set(CP.x, CP.z);
  if (S.mode === 'foot' && !inside.on) animateFoot(paused ? 0 : dt);
  const body = car.userData.body; body.position.y = BODY_PIV + S.bh; body.rotation.set(-S.bp, 0, S.br);
  const w = car.userData.wheels;
  for (let i = 0; i < 4; i++) { w[i].rotation.x = S.wheelSpin; if (i < 2) w[i].rotation.y = -S.steer * 0.45; }
  ground.position.set(Math.round(S.x / 30) * 30, 0, Math.round(S.z / 30) * 30);
  if (inside.on) inside.update(paused ? 0 : dt); else updateCamera(paused ? 0.016 : dt, info.vf);
  if (started) updateFx(paused ? 0 : dt, info);
  if (started && !paused) traffic.update(dt);
  if ((tileCheck -= (paused ? 0.016 : dt)) <= 0) { tileCheck = 0.5; if (!bigMap.classList.contains('on')) wantTiles(S.x, S.z); }
  if (started && !paused) {
    updateHud(info);
    updateNav(dt, info.vf);
    chal.update(dt);
    peds.update(dt);
    if (LIFE_ON()) { life.tick(dt / 60 * jobs.clockRate()); life.burn(); jobs.update(dt); hustle.update(dt); combat.update(dt); story.update(dt); police.update(dt, info); if ((mmFrame & 7) === 0) { hustle.settleBets(); life.scan(); life.hud(); jobs.hud(); jobs.tick(); } }
    updatePoiLabels(dt);
    if (++mmFrame % 3 === 0) drawMinimap();
  }
  if (pendingSnap && performance.now() - (pendingSnap.t || 0) > 500) trySnap();
  updateSignals(now);
  renderer.render(inside.on ? inside.scene : scene, camera);
}
window.__phys = (n, inp) => { Object.assign(input, inp || {}); const out = []; for (let i = 0; i < n; i++) { physics(1 / 120); if (i % 12 === 11) out.push(window.__tcd()); } return out; };
window.__tr = () => traffic.cars.map(c => [c.road.c, c.lane, c.sig, c.brake ? 1 : 0, +c.v.toFixed(1), c.lc ? 1 : 0, +c.agg.toFixed(2), +c.x.toFixed(1), +c.z.toFixed(1), +c.h.toFixed(3), +c.y.toFixed(2)]);
window.__trStep = (n, dt = 1 / 30) => { for (let i = 0; i < n; i++) traffic.update(dt); return window.__tr(); };
window.__setTime = h => { tod = h; applyTime(h); };
window.__setWx = (k, snap) => { settings.weather = k; if (snap) { const t = WX_TARGET[k]; WX.kind = k; WX.cloud = t[0]; WX.precip = t[1]; WX.snowing = t[2]; WX.wet.value = t[1] * (1 - t[2]); WX.snow.value = t[2]; } };
window.__mem = () => ({ geo: renderer.info.memory.geometries, tex: renderer.info.memory.textures, prog: renderer.info.programs.length, heap: Math.round((performance.memory?.usedJSHeapSize || 0) / 1e6), tiles: tiles.size, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, cars: traffic.cars.length, clutter: [...tiles.values()].map(t => t.clutterStats).filter(Boolean) });
window.__goLL = (lat, lon) => { const [x, z] = proj(lat, lon); teleport(x, z); };
window.__tris = () => {
  const names = new Map([[bldMat, 'bld'], [facadeMat, 'facade'], [luMat, 'landuse'], [treeMatTop, 'treeTop'], [treeMatTrunk, 'trunk'], [walkMat, 'walk'], [markMat, 'marks'], [junctionMat, 'junction'], [drivewayMat, 'driveway'], [waterMat, 'water'], [aoMat, 'ao']]);
  const out = {};
  scene.traverse(o => { if (!o.isMesh || !o.visible) return; let p = o; while (p) { if (!p.visible) return; p = p.parent; } const g = o.geometry; const tri = (g.index ? g.index.count : g.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1); const m = Array.isArray(o.material) ? o.material[0] : o.material; const n = o.userData.role || names.get(m) || (roadMats && [...roadMats.values()].includes(m) ? 'road' : m.type + (m.map ? '+map' : '')); out[n] = (out[n] || 0) + Math.round(tri); });
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};
window.__tiles = tiles; window.__pip = pointInPoly; window.__unproj = unproj;
window.__tcdSet = o => { Object.assign(S, o); camInit = false; };
window.__tcd = () => ({ x: S.x, y: S.y, z: S.z, h: S.h, v: Math.hypot(S.vx, S.vz), pitch: S.pitch, drift: S.drift, charge: S.charge, nitro: S.nitro, burst: S.burst, bp: S.bp, br: S.br, bh: S.bh, yawR: S.yawR, scrub: S.scrub, aL: S.aL, rumble: S.rumble, groll: S.groll, raised: [...tiles.values()].reduce((n, t) => n + (t.raisedB || 0), 0) });
requestAnimationFrame(frame);
