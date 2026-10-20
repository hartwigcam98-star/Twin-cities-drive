# Twin Cities Drive

A drivable 3D map of Minneapolis–St. Paul and the suburbs (Maple Grove and Plymouth to Woodbury, Brooklyn Park to Burnsville), built with three.js from OpenStreetMap streets and buildings and USGS lidar terrain.

**Play:** https://hartwigcam98-star.github.io/twin-cities-drive/

- `index.html`, `game.js`, `convert.js`, `elevcore.js`, `vendor/` — the game (static, no server)
- `data/` — baked map tiles (`r` streets, `b` buildings, `l` land use, `e` terrain, `m` region map)
- `tools/bake.mjs` + `.github/workflows/bake.yml` — fills in missing tiles every few hours until the whole map is baked; areas not baked yet load live from OpenStreetMap and USGS in the browser

Map data © OpenStreetMap contributors (ODbL) · Terrain: USGS 3D Elevation Program · Routing: OSRM · Search: Nominatim
