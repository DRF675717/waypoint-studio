// Waypoint Studio — macOS shell (Electron). Serves the web app from a private local HTTP server
// and opens it in a native window with geolocation, downloads, file open and external links handled.
const { app, BrowserWindow, Menu, shell, session, dialog, net } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

// global.WS comes from the loader (main.js): where the bundle is, which program version runs, the shell generation
if (!global.WS) global.WS = { bundleDir: __dirname, shell: 1, version: require('./package.json').version, bundleVersion: require('./package.json').version, liveDir: null };
const VER = () => global.WS.version;
const ROOT = path.join(__dirname, 'www');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
let win = null, baseURL = null, pendingFiles = [];

// ---------------- Vietnam no-fly / restricted zones (official map of the Ministry of Defence: cambay.mod.gov.vn) ----------------
// The site publishes its zones as Mapbox vector tiles. The app fetches them with Electron's own (Chromium) network stack,
// keeps a disk cache (works offline afterwards, refreshed weekly) and hands them to the page.
const CB_ORIGIN = 'https://cambay.mod.gov.vn';
const CB_TTL = 7 * 24 * 3600 * 1000;
function cbDir() { const d = path.join(app.getPath('userData'), 'cambay-cache'); fs.mkdirSync(d, { recursive: true }); return d; }
const cbInflight = new Map();
async function cbGet(rel, file, binary, ttl = CB_TTL) {
  const f = path.join(cbDir(), file);
  let st = null; try { st = fs.statSync(f); } catch (e) { st = null; }
  if (st && Date.now() - st.mtimeMs < ttl) return { body: fs.readFileSync(f), cached: true };
  if (cbInflight.has(file)) return cbInflight.get(file);
  const job = (async () => {
    try {
      const r = await net.fetch(CB_ORIGIN + rel, { signal: AbortSignal.timeout(20000), headers: { Accept: binary ? 'application/x-protobuf,*/*' : 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const body = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(f, body);
      return { body, cached: false };
    } catch (e) {
      if (st) return { body: fs.readFileSync(f), cached: true, stale: true }; // offline: the last copy
      throw e;
    } finally { cbInflight.delete(file); }
  })();
  cbInflight.set(file, job);
  return job;
}
// ---------------- OpenStreetMap buildings for the 3D view (Overpass API, cached on disk for 30 days) ----------------
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
async function osmBuildings(s, w, n, e) {
  const f = path.join(cbDir(), `osm_${s.toFixed(3)}_${w.toFixed(3)}_${n.toFixed(3)}_${e.toFixed(3)}.json`);
  try { const st = fs.statSync(f); if (Date.now() - st.mtimeMs < 30 * 24 * 3600 * 1000) return fs.readFileSync(f); } catch (x) { /* not cached */ }
  const q = `[out:json][timeout:40];(way["building"](${s},${w},${n},${e});relation["building"](${s},${w},${n},${e}););out geom tags qt;`;
  let lastErr = null;
  for (const u of OVERPASS) {
    try {
      const r = await net.fetch(u, { method: 'POST', signal: AbortSignal.timeout(30000), body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'WaypointStudio/' + VER() + ' (desktop drone route planner)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(), out = [];
      (j.elements || []).forEach(el => {
        const t = el.tags || {}, num = v => { const x = parseFloat(String(v || '').replace(',', '.')); return isFinite(x) ? x : null; };
        let h = num(t.height) ?? num(t['building:height']), est = false;
        const lv = num(t['building:levels']); if (h == null && lv != null) { h = lv * 3.2 + 1; est = true; }
        if (h == null) { h = /^(house|detached|residential|apartments|hotel|commercial|retail|office)$/.test(t.building) ? 9 : 6; est = true; }
        const ring = g => (g || []).map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6)]);
        if (el.type === 'way' && el.geometry && el.geometry.length > 3) out.push({ h: Math.min(450, h), est, min: num(t.min_height) || 0, p: ring(el.geometry) });
        if (el.type === 'relation') (el.members || []).filter(m => m.role === 'outer' && m.geometry && m.geometry.length > 3).forEach(m => out.push({ h: Math.min(450, h), est, min: num(t.min_height) || 0, p: ring(m.geometry) }));
      });
      const body = Buffer.from(JSON.stringify({ ok: true, n: out.length, b: out }));
      fs.writeFileSync(f, body); return body;
    } catch (x) { lastErr = x; }
  }
  throw lastErr || new Error('Overpass недоступен');
}

// ---------------- World geozones (official / open sources), fetched per 0.5° cell and cached on disk ----------------
// kind: 1 = no-fly / prohibited, 2 = restricted / authorisation needed, 3 = caution
const ARC = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/ArcGIS/rest/services';
function geoDir(src) { const d = path.join(app.getPath('userData'), 'geozones', src); fs.mkdirSync(d, { recursive: true }); return d; }
async function arcgisQuery(layer, s, w, n, e, fields) {
  const out = []; let offset = 0;
  for (let page = 0; page < 12; page++) {
    const q = new URLSearchParams({ where: '1=1', geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: fields, returnGeometry: 'true', outSR: '4326', f: 'geojson', resultOffset: String(offset), resultRecordCount: '2000', geometryPrecision: '6' });
    const r = await net.fetch(`${ARC}/${layer}/FeatureServer/0/query?${q}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(layer + ': HTTP ' + r.status);
    const j = await r.json(); if (j.error) throw new Error(layer + ': ' + (j.error.message || 'error'));
    out.push(...(j.features || [])); offset += (j.features || []).length;
    if (!(j.properties && j.properties.exceededTransferLimit) || !(j.features || []).length) break;
  }
  return out;
}
const polysOf = g => !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
const ringsLL = poly => poly.map(r => r.map(([x, y]) => [+y.toFixed(6), +x.toFixed(6)]));
function feat(id, kind, name, info, poly, src) { return { id: src + ':' + id, kind, name, info, src, rings: ringsLL(poly) }; }
let airportsMem = null, airportsJob = null;
// one shared download for all the cells asked at the same time (the list is ~13 MB)
function airportsAll(ttl, force) {
  if (!airportsJob) airportsJob = airportsLoad(ttl, force).finally(() => { airportsJob = null; });
  return airportsJob;
}
async function airportsLoad(ttl, force) {
  const f = path.join(geoDir('airports'), 'airports.json');
  let st = null; try { st = fs.statSync(f); } catch (e) { st = null; }
  if (!force && airportsMem && st && Date.now() - st.mtimeMs < ttl) return airportsMem;
  if (!force && st && Date.now() - st.mtimeMs < ttl) { airportsMem = JSON.parse(fs.readFileSync(f, 'utf8')); return airportsMem; }
  try {
    const r = await net.fetch('https://davidmegginson.github.io/ourairports-data/airports.csv', { signal: AbortSignal.timeout(90000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text(), rows = [];
    const parse = line => { const o = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ',') { o.push(cur); cur = ''; } else cur += c; } o.push(cur); return o; };
    const lines = txt.split(/\r?\n/), head = parse(lines[0]), ix = k => head.indexOf(k);
    const I = { id: ix('ident'), type: ix('type'), name: ix('name'), lat: ix('latitude_deg'), lng: ix('longitude_deg'), c: ix('iso_country'), icao: ix('icao_code'), iata: ix('iata_code') };
    for (let i = 1; i < lines.length; i++) { if (!lines[i]) continue; const c = parse(lines[i]), t = c[I.type]; if (!/^(large_airport|medium_airport|small_airport|heliport)$/.test(t)) continue; rows.push([c[I.id], t[0], c[I.name], +(+c[I.lat]).toFixed(5), +(+c[I.lng]).toFixed(5), c[I.c], c[I.icao] || c[I.iata] || '']); }
    fs.writeFileSync(f, JSON.stringify(rows)); airportsMem = rows; return rows;
  } catch (e) { if (st) { airportsMem = JSON.parse(fs.readFileSync(f, 'utf8')); return airportsMem; } throw e; }
}
const circle = (lat, lng, r) => { const ring = []; for (let k = 0; k <= 48; k++) { const a = k / 48 * 2 * Math.PI, dLat = r * Math.cos(a) / 111320, dLng = r * Math.sin(a) / (111320 * Math.cos(lat * Math.PI / 180)); ring.push([+(lng + dLng).toFixed(6), +(lat + dLat).toFixed(6)]); } return [ring]; };
const OPENAIP_TYPES = { 1: ['Ограниченная зона (R)', 2], 2: ['Опасная зона (D)', 2], 3: ['Запретная зона (P)', 1], 4: ['Диспетчерская зона аэродрома (CTR)', 2], 5: ['Зона с обязательной связью (TMZ)', 3], 6: ['Зона с ответчиком (RMZ)', 3], 13: ['Зона аэродрома (ATZ)', 2] };
const oaLim = l => !l || l.value == null ? '' : l.unit === 6 ? 'FL' + l.value : l.value === 0 && l.referenceDatum === 0 ? 'земля' : l.value + (l.unit === 1 ? ' ft' : ' м');
async function geoCellFetch(src, s, w, n, e, key) {
  if (src === 'faa' || src === 'navcan') {
    const out = [];
    if (src === 'faa') {
      (await arcgisQuery('FAA_UAS_FacilityMap_Data', s, w, n, e, 'OBJECTID,CEILING,APT1_NAME,APT1_ICAO')).forEach(f => polysOf(f.geometry).forEach((p, k) => { const c = f.properties.CEILING; out.push(feat('fm' + f.properties.OBJECTID + '_' + k, c === 0 ? 1 : 2, `Сетка FAA UASFM: ${c === 0 ? 'полёт только с разрешением' : 'до ' + c + ' ft (' + Math.round(c * 0.3048) + ' м) по LAANC'}`, f.properties.APT1_NAME || '', p, 'faa')); }));
      const pv = (o, ...ks) => { for (const k of ks) for (const kk of Object.keys(o)) if (kk.toLowerCase() === k.toLowerCase() && o[kk] != null && o[kk] !== '') return String(o[kk]); return ''; };
      const extra = [['Prohibited_Areas', 'p', 'Запретная зона', 'FAA: запретная зона (Prohibited Area)'], ['National_Defense_Airspace_TFR_Areas', 't', 'Зона нац. обороны (TFR)', 'FAA: временное ограничение полётов'], ['Part_Time_National_Security_UAS_Flight_Restrictions', 'ns', 'Нац. безопасность', 'FAA: ограничение для дронов (может действовать не всё время)']];
      for (const [layer, pre, title, info] of extra) {
        let fs = []; try { fs = await arcgisQuery(layer, s, w, n, e, '*'); } catch (x) { console.warn(layer, x.message); continue; }
        fs.forEach((f, j) => polysOf(f.geometry).forEach((p, k) => { const o = f.properties || {}; out.push(feat(pre + (o.OBJECTID ?? o.FID ?? j) + '_' + k, 1, title + ': ' + (pv(o, 'NAME', 'Facility', 'FACILITY_NAME', 'TITLE') || ''), [info, pv(o, 'CITY'), pv(o, 'STATE')].filter(Boolean).join(' · '), p, 'faa')); }));
      }
    } else {
      (await arcgisQuery('Nav_Canada_UASFM_Publication', s, w, n, e, 'OBJECTID,CEILING,UNIT,APT1_NAME')).forEach(f => polysOf(f.geometry).forEach((p, k) => { const c = f.properties.CEILING; out.push(feat('c' + f.properties.OBJECTID + '_' + k, c === 0 ? 1 : 2, `NAV CANADA: ${c === 0 ? 'полёт только с разрешением' : 'до ' + c + ' ' + (f.properties.UNIT || 'ft')}`, f.properties.APT1_NAME || '', p, 'navcan')); }));
    }
    return out;
  }
  if (src === 'openaip') {
    if (!key) throw new Error('нужен ключ openAIP');
    const out = []; let page = 1;
    for (; page <= 10; page++) {
      const r = await net.fetch(`https://api.core.openaip.net/api/airspaces?bbox=${w},${s},${e},${n}&limit=1000&page=${page}`, { headers: { 'x-openaip-api-key': key }, signal: AbortSignal.timeout(30000) });
      if (r.status === 401 || r.status === 403) throw new Error('ключ openAIP не принят');
      if (!r.ok) throw new Error('openAIP: HTTP ' + r.status);
      const j = await r.json();
      (j.items || []).forEach(a => { const t = OPENAIP_TYPES[a.type]; if (!t) return; const lim = a.lowerLimit ? `высоты ${oaLim(a.lowerLimit)} … ${oaLim(a.upperLimit)} · openAIP` : 'openAIP'; polysOf(a.geometry).forEach((p, k) => out.push(feat(a._id + '_' + k, t[1], `${t[0]}: ${a.name || ''}`, lim, p, 'openaip'))); });
      if (!j.nextPage || page >= (j.totalPages || 1)) break;
    }
    return out;
  }
  if (src === 'airports') {
    const all = await airportsAll(30 * 24 * 3600 * 1000), out = [], pad = 0.1;
    const R = { l: [8000, 2, 'Крупный аэропорт'], m: [5000, 2, 'Аэропорт'], s: [3000, 3, 'Аэродром'], h: [1000, 3, 'Вертолётная площадка'] };
    all.forEach(a => { if (a[3] < s - pad || a[3] > n + pad || a[4] < w - pad || a[4] > e + pad) return; const r = R[a[1]]; out.push(feat(a[0], r[1], `${r[2]} ${a[6] ? a[6] + ' ' : ''}${a[2]}`, `радиус ${r[0] >= 1000 ? r[0] / 1000 + ' км' : r[0] + ' м'} (оценка) · OurAirports`, circle(a[3], a[4], r[0]), 'airports')); });
    return out;
  }
  if (src === 'import') {
    const out = [], dir = geoDir('import');
    fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => { try { JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).forEach(z => { if (z.bb && (z.bb[0] > n || z.bb[2] < s || z.bb[1] > e || z.bb[3] < w)) return; out.push(z); }); } catch (x) { /* broken file */ } });
    return out;
  }
  throw new Error('unknown source');
}
// ---------------- Commercial imagery: Airbus OneAtlas basemap (needs a bearer token made from the user's API key) ----------------
const IMGF = () => path.join(app.getPath('userData'), 'imagery.json');
let imgCfg = null, abTok = null, abTokExp = 0;
function imgConf() { if (!imgCfg) { try { imgCfg = JSON.parse(fs.readFileSync(IMGF(), 'utf8')); } catch (e) { imgCfg = {}; } } return imgCfg; }
async function airbusToken(force) {
  const key = imgConf().airbus; if (!key) throw new Error('ключ не задан');
  if (!force && abTok && Date.now() < abTokExp - 60000) return abTok;
  const r = await net.fetch('https://authenticate.foundation.api.oneatlas.airbus.com/auth/realms/IDP/protocol/openid-connect/token', { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'apikey=' + encodeURIComponent(key) + '&grant_type=api_key&client_id=IDP' });
  if (!r.ok) throw new Error('ключ не принят (HTTP ' + r.status + ')');
  const j = await r.json(); if (!j.access_token) throw new Error('нет токена в ответе');
  abTok = j.access_token; abTokExp = Date.now() + (j.expires_in || 3600) * 1000; return abTok;
}
async function handleTP(req, res, url) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/tp/config') {
    if (req.headers['x-ws-token'] !== RC_TOKEN || req.method !== 'POST') return send(403, { ok: false });
    let body = ''; for await (const ch of req) { body += ch; if (body.length > 10000) break; }
    let c = {}; try { c = JSON.parse(body); } catch (e) { return send(400, { ok: false }); }
    imgCfg = { airbus: String(c.airbus || '').trim(), maxar: String(c.maxar || '').trim() }; abTok = null;
    fs.writeFileSync(IMGF(), JSON.stringify(imgCfg), { mode: 0o600 });
    const out = { ok: true };
    if (imgCfg.airbus) { try { await airbusToken(true); out.airbus = 'ok'; } catch (e) { out.airbus = e.message; } }
    return send(200, out);
  }
  const m = url.pathname.match(/^\/tp\/airbus\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/);
  if (!m) return send(404, { ok: false });
  try {
    for (let k = 0; k < 2; k++) {
      const tok = await airbusToken(k > 0);
      const r = await net.fetch(`https://view-bm.api.oneatlas.airbus.com/basemap/wmts?style=default&tilematrixset=3857&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/unknown&layer=advancedBasemap&TileMatrix=${m[1]}&TileCol=${m[2]}&TileRow=${m[3]}`,
        { headers: { Authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(20000) });
      if (r.status === 401 && k === 0) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }); return res.end(buf);
    }
  } catch (e) { res.writeHead(502, { 'Content-Type': 'text/plain' }); return res.end(String(e.message || e)); }
}

async function handleGeo(req, res, url) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); };
  if (req.headers['x-ws-token'] !== RC_TOKEN) return send(403, { ok: false });
  const q = url.searchParams, src = q.get('src') || '';
  try {
    if (url.pathname === '/geo/cell') {
      if (!/^(faa|navcan|openaip|airports|import)$/.test(src)) return send(400, { ok: false, error: 'bad src' });
      const lat0 = parseFloat(q.get('lat')), lng0 = parseFloat(q.get('lng')); if (!isFinite(lat0) || !isFinite(lng0)) return send(400, { ok: false });
      const s = Math.floor(lat0 * 2) / 2, w = Math.floor(lng0 * 2) / 2, n = s + 0.5, e = w + 0.5, ttl = Math.max(3600e3, Math.min(90 * 86400e3, +q.get('ttl') || 7 * 86400e3));
      if (src === 'import') return send(200, { ok: true, f: await geoCellFetch(src, s, w, n, e) });
      const f = path.join(geoDir(src), `c_${s}_${w}.json`); let st = null; try { st = fs.statSync(f); } catch (x) { st = null; }
      if (st && Date.now() - st.mtimeMs < ttl) return send(200, fs.readFileSync(f));
      try { const body = JSON.stringify({ ok: true, at: Date.now(), f: await geoCellFetch(src, s, w, n, e, req.headers['x-openaip-key'] || '') }); fs.writeFileSync(f, body); return send(200, body); }
      catch (x) { if (st) return send(200, fs.readFileSync(f)); return send(200, { ok: false, error: String(x.message || x) }); }
    }
    if (url.pathname === '/geo/clear') { // «Обновить сейчас»: forget the cached copies of a source
      const dir = src === 'vn' ? cbDir() : geoDir(src); if (!/^(vn|faa|navcan|openaip|airports)$/.test(src)) return send(400, { ok: false });
      let k = 0; fs.readdirSync(dir).forEach(f => { if (src !== 'vn' || /^t_/.test(f)) { fs.rmSync(path.join(dir, f), { force: true }); k++; } }); if (src === 'airports') airportsMem = null;
      return send(200, { ok: true, removed: k });
    }
    if (url.pathname === '/geo/info') {
      const info = {}; ['faa', 'navcan', 'openaip', 'airports', 'import'].forEach(sr => { const d = geoDir(sr), fl = fs.readdirSync(d); info[sr] = { files: fl.length, updated: fl.reduce((m, f) => Math.max(m, fs.statSync(path.join(d, f)).mtimeMs), 0) }; });
      const vf = fs.readdirSync(cbDir()).filter(f => /^t_/.test(f)); info.vn = { files: vf.length, updated: vf.reduce((m, f) => Math.max(m, fs.statSync(path.join(cbDir(), f)).mtimeMs), 0) };
      info.imports = fs.readdirSync(geoDir('import')).filter(f => f.endsWith('.json'));
      return send(200, { ok: true, info });
    }
    if (url.pathname === '/geo/import' && req.method === 'POST') {
      const name = (q.get('name') || 'zones').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
      const zs = JSON.parse((await readBody(req, 80 * 1024 * 1024)).toString('utf8'));
      if (!Array.isArray(zs)) return send(400, { ok: false, error: 'bad data' });
      fs.writeFileSync(path.join(geoDir('import'), name + '.json'), JSON.stringify(zs)); return send(200, { ok: true, n: zs.length });
    }
    if (url.pathname === '/geo/unimport' && req.method === 'POST') { const name = (q.get('name') || '').replace(/[^A-Za-z0-9._-]/g, '_'); fs.rmSync(path.join(geoDir('import'), name), { force: true }); return send(200, { ok: true }); }
    return send(404, { ok: false });
  } catch (e) { return send(200, { ok: false, error: String(e.message || e) }); }
}

async function handleCB(req, res, url) {
  const send = (code, body, type) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  const m = url.pathname.match(/^\/cb\/tile\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/);
  try {
    if (m) {
      const [z, x, y] = m.slice(1).map(Number); if (z > 16) return send(400, 'bad zoom', 'text/plain');
      const ttl = Math.max(3600e3, Math.min(90 * 86400e3, +url.searchParams.get('ttl') || CB_TTL));
      const r = await cbGet(`/api/tiles/features/${z}/${x}/${y}.pbf`, `t_${z}_${x}_${y}.pbf`, true, ttl);
      return send(200, r.body, 'application/x-protobuf');
    }
    if (url.pathname === '/cb/osm') {
      const q = ['s', 'w', 'n', 'e'].map(k => parseFloat(url.searchParams.get(k)));
      if (q.some(v => !isFinite(v)) || q[2] <= q[0] || q[3] <= q[1] || (q[2] - q[0]) * (q[3] - q[1]) > 0.0012) return send(400, JSON.stringify({ ok: false, error: 'bad bbox' }), 'application/json');
      return send(200, await osmBuildings(...q), 'application/json; charset=utf-8');
    }
    if (url.pathname === '/cb/detail') {
      const id = url.searchParams.get('id'); if (!/^\d{1,9}$/.test(id || '')) return send(400, 'bad id', 'text/plain');
      const r = await cbGet(`/api/feature-details?id=${id}`, `d_${id}.json`, false);
      return send(200, r.body, 'application/json; charset=utf-8');
    }
    return send(404, 'not found', 'text/plain');
  } catch (e) { return send(502, JSON.stringify({ ok: false, error: String(e.message || e) }), 'application/json; charset=utf-8'); }
}

// ---------------- DJI RC 2 bridge (USB/MTP via bin/wsbridge) ----------------
// Only the app's own page may call it: every request must carry a random per-launch token
// (a custom header also forces a CORS preflight, which this server never approves for other origins).
const RC_TOKEN = crypto.randomBytes(24).toString('hex');
const BRIDGE = path.join(global.WS.bundleDir, 'bin', 'wsbridge'); // the signed USB helper always lives in the bundle
function rcBackupDir() { const d = path.join(exportDir(), 'Резервные копии пульта'); fs.mkdirSync(d, { recursive: true }); return d; }
function rcArchDir() { const d = path.join(rcBackupDir(), 'Архивы'); fs.mkdirSync(d, { recursive: true }); return d; }
// USB presence of the DJI RC 2 (VID 0x2ca3 = 11427) via IOKit registry — no MTP session, so it never disturbs the remote
const rcPresence = { present: false, since: 0, product: '' };
function pollPresence() {
  if (process.platform !== 'darwin') return;
  execFile('/usr/sbin/ioreg', ['-p', 'IOUSB', '-l', '-w0'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => {
    if (e) return; const txt = String(out || ''), on = /"idVendor" = 11427\b/.test(txt);
    if (on !== rcPresence.present) { rcPresence.present = on; rcPresence.since = Date.now(); }
    if (on) { const m = txt.match(/"USB Product Name" = "([^"]*)"[\s\S]{0,4000}?"idVendor" = 11427\b/); rcPresence.product = m ? m[1] : ''; }
  });
}
function rcTmpDir() { const d = path.join(app.getPath('temp'), 'ws-rc'); fs.mkdirSync(d, { recursive: true }); return d; }
let rcQueue = Promise.resolve(); // MTP allows one session at a time: strictly serialize helper calls
function runBridgeOnce(args) {
  return new Promise(resolve => {
    execFile(BRIDGE, args, { timeout: 180000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      let j = null; try { j = JSON.parse(String(stdout).trim().split('\n').pop()); } catch (e) { /* not JSON */ }
      if (!j) j = { ok: false, code: err && err.killed ? 'TIMEOUT' : 'BRIDGE_ERROR', error: err && err.killed ? 'Пульт не ответил за 3 минуты' : ('Ошибка утилиты связи: ' + (stderr || (err && err.message) || '').toString().slice(0, 400)) };
      if (stderr) j.log = String(stderr).slice(-2000);
      resolve(j);
    });
  });
}
function freeUsb() { return new Promise(r => execFile('/usr/bin/pkill', ['-x', 'ptpcamerad'], () => setTimeout(r, 900))); }
function busyApps() { return new Promise(r => execFile('/bin/ps', ['-axco', 'comm'], (e, out) => { const n = String(out || ''); r(['Android File Transfer', 'Android File Transfer Agent', 'OpenMTP', 'MacDroid', 'Image Capture', 'Захват изображений', 'Litchi Hub Bridge', 'MavenBridge'].filter(a => n.includes(a))); })); }
// The RC 2 needs ~3 s between MTP sessions, otherwise it intermittently reports "no device"/"no folder".
let lastSessionEnd = 0;
const SAFE_RETRY = ['NO_DEVICE', 'DETECT_FAILED', 'OPEN_FAILED', 'NO_STORAGE', 'NO_WAYPOINT_FOLDER', 'NO_MISSION', 'NO_MISSION_FILE'];
async function mtpSession(args) {
  const wait = lastSessionEnd + 3000 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
  try { return await runBridgeOnce(args); } finally { lastSessionEnd = Date.now(); }
}
let rcBusy = 0;
function runBridge(args) {
  rcBusy++;
  const job = rcQueue.then(async () => {
    let j = await mtpSession(args);
    // only errors that happen BEFORE the remote is modified are retried (the helper guarantees this for these codes)
    for (let k = 0; k < 2 && !j.ok && SAFE_RETRY.includes(j.code); k++) {
      if (['OPEN_FAILED', 'NO_STORAGE'].includes(j.code)) await freeUsb();
      j = await mtpSession(args);
    }
    if (!j.ok && ['OPEN_FAILED', 'NO_STORAGE'].includes(j.code)) j.busy = await busyApps();
    return j;
  });
  rcQueue = job.catch(() => {});
  job.finally(() => { rcBusy--; }).catch(() => {});
  return job;
}
const safeSeg = s => typeof s === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(s) && !s.includes('..');
function readBody(req, max = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => { const ch = []; let n = 0; req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too big')); req.destroy(); } else ch.push(c); }); req.on('end', () => resolve(Buffer.concat(ch))); req.on('error', reject); });
}
async function handleRC(req, res, url) {
  const send = (code, obj, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); };
  if (req.headers['x-ws-token'] !== RC_TOKEN) return send(403, { ok: false, code: 'FORBIDDEN', error: 'forbidden' });
  if (url.pathname === '/rc/status' && req.method === 'GET') return send(200, { ok: true, present: rcPresence.present, since: rcPresence.since, product: rcPresence.product, busy: rcBusy > 0 });
  if (process.platform !== 'darwin' || !fs.existsSync(BRIDGE)) return send(200, { ok: false, code: 'NO_BRIDGE', error: 'Утилита связи с пультом не найдена в программе' });
  const q = url.searchParams, ep = url.pathname;
  try {
    if (ep === '/rc/list' && req.method === 'GET') return send(200, await runBridge(['list']));
    if (ep === '/rc/scan' && req.method === 'GET') {
      const dir = path.join(rcTmpDir(), 'scan_' + Date.now());
      const j = await runBridge(['scan', dir]);
      if (j.ok) j.missions.forEach(m => { const rd = f => { try { return f ? fs.readFileSync(f).toString('base64') : null; } catch (e) { return null; } }; m.data = rd(m.local); m.previewData = rd(m.preview); delete m.local; delete m.preview; });
      fs.rmSync(dir, { recursive: true, force: true });
      return send(200, j);
    }
    if ((ep === '/rc/replace' || ep === '/rc/restore') && req.method === 'POST') {
      const folder = q.get('folder'), name = q.get('name');
      const isPrev = /^map_preview\/[A-Za-z0-9-]{1,64}$/.test(folder || '');
      if (!(isPrev || safeSeg(folder)) || !safeSeg(name) || !(isPrev ? /\.jpg$/i : /\.kmz$/i).test(name)) return send(400, { ok: false, code: 'BAD_ARGS', error: 'Неверное имя задания' });
      let local;
      if (ep === '/rc/replace') { local = path.join(rcTmpDir(), 'upload_' + Date.now() + (isPrev ? '.jpg' : '.kmz')); fs.writeFileSync(local, await readBody(req)); }
      else { const b = q.get('backup'); if (!safeSeg(b)) return send(400, { ok: false, error: 'bad backup' }); local = path.join(rcBackupDir(), b); if (!fs.existsSync(local)) return send(200, { ok: false, code: 'NO_BACKUP', error: 'Резервная копия не найдена' }); }
      const j = await runBridge(['replace', folder, name, local, rcBackupDir()]);
      if (ep === '/rc/replace') fs.rmSync(local, { force: true });
      if (j.backup) { j.backupName = path.basename(j.backup); j.backupDir = rcBackupDir(); }
      return send(200, j);
    }
    if (ep === '/rc/saveArchive' && req.method === 'POST') {
      const name = q.get('name'); if (!safeSeg(name) || !/\.zip$/i.test(name)) return send(400, { ok: false, error: 'bad name' });
      const f = path.join(rcArchDir(), name); fs.writeFileSync(f, await readBody(req, 300 * 1024 * 1024));
      return send(200, { ok: true, path: f, dir: rcArchDir() });
    }
    if (ep === '/rc/archives' && req.method === 'GET') {
      const ls = (dir, tag) => fs.readdirSync(dir).filter(f => /\.(zip|kmz)$/i.test(f) && !f.startsWith('.')).map(f => { const st = fs.statSync(path.join(dir, f)); return { name: f, dir: tag, size: st.size, mtime: st.mtimeMs }; });
      return send(200, { ok: true, files: ls(rcArchDir(), 'arch').concat(ls(rcBackupDir(), 'bk')).sort((a, b) => b.mtime - a.mtime) });
    }
    if (ep === '/rc/archiveGet' && req.method === 'GET') {
      const name = q.get('name'), dir = q.get('dir') === 'arch' ? rcArchDir() : rcBackupDir();
      if (!safeSeg(name) || !/\.(zip|kmz|jpg)$/i.test(name)) return send(400, { ok: false, error: 'bad name' });
      const f = path.join(dir, name); if (!fs.existsSync(f)) return send(200, { ok: false, code: 'NO_FILE', error: 'Файл не найден' });
      return send(200, fs.readFileSync(f), 'application/octet-stream');
    }
    if (ep === '/rc/backups' && req.method === 'GET') return send(200, { ok: true, dir: rcBackupDir(), files: fs.readdirSync(rcBackupDir()).filter(f => f.endsWith('.kmz')).sort().reverse() });
    if (ep === '/rc/openBackups' && req.method === 'GET') { shell.openPath(rcBackupDir()); return send(200, { ok: true }); }
    return send(404, { ok: false, error: 'not found' });
  } catch (e) { return send(500, { ok: false, code: 'SERVER', error: String(e.message || e) }); }
}

function userConfigPath() { return path.join(app.getPath('userData'), 'config.js'); }

function startServer(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if ((req.url || '').startsWith('/rc/')) return handleRC(req, res, new URL(req.url, 'http://localhost'));
      if ((req.url || '').startsWith('/cb/')) return handleCB(req, res, new URL(req.url, 'http://localhost'));
      if ((req.url || '').startsWith('/geo/')) return handleGeo(req, res, new URL(req.url, 'http://localhost'));
      if ((req.url || '').startsWith('/ui/lang') && req.method === 'POST' && req.headers['x-ws-token'] === RC_TOKEN) {
        const l = new URL(req.url, 'http://localhost').searchParams.get('l') === 'en' ? 'en' : 'ru';
        try { fs.writeFileSync(path.join(app.getPath('userData'), 'ui.json'), JSON.stringify({ lang: l })); } catch (e) { /* ignore */ }
        buildMenu(); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}');
      }
      if ((req.url || '').startsWith('/tp/')) return handleTP(req, res, new URL(req.url, 'http://localhost'));
      if ((req.url || '').startsWith('/upd/')) return handleUPD(req, res, new URL(req.url, 'http://localhost'));
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/index.html';
      // user-level config (Google key) lives outside the app bundle so updates don't erase it
      if (p === '/config.js' && fs.existsSync(userConfigPath())) {
        res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(userConfigPath()));
      }
      let f = path.normalize(path.join(ROOT, p));
      if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      // a light update carries only the program; big unchanged libraries (vendor/: Cesium, Leaflet…) come from the bundle
      if (!fs.existsSync(f) && global.WS.liveDir) { const b = path.normalize(path.join(global.WS.bundleDir, 'www', p)); if (b.startsWith(path.join(global.WS.bundleDir, 'www'))) f = b; }
      fs.readFile(f, (e, d) => {
        if (e) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(d);
      });
    });
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv.address().port));
  });
}

async function ensureServer() {
  // Keep the address stable (http://localhost:8765): the Google key is allowed for this address and the browser storage
  // (settings, keys, routes) belongs to it. Right after an update/restart the previous copy may still hold the port for
  // a moment — wait for it instead of jumping to another port.
  for (let k = 0; k < 16; k++) {
    try { const p = await startServer(8765); return `http://localhost:${p}`; } catch (e) { await new Promise(r => setTimeout(r, 500)); }
  }
  for (const port of [8766, 8767, 0]) {
    try { const p = await startServer(port); return `http://localhost:${p}`; } catch (e) { /* busy, try next */ }
  }
  throw new Error('Не удалось запустить локальный сервер');
}

function importFile(file) {
  if (!win || !baseURL) { pendingFiles.push(file); return; }
  try {
    const b64 = fs.readFileSync(file).toString('base64');
    const js = `window.wsImportBase64 && window.wsImportBase64(${JSON.stringify(path.basename(file))}, ${JSON.stringify(b64)})`;
    win.webContents.executeJavaScript(js).catch(() => {});
  } catch (e) { dialog.showErrorBox('Waypoint Studio', 'Не удалось открыть файл: ' + e.message); }
}

function exportDir() {
  const d = path.join(app.getPath('downloads'), 'WaypointStudio');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function createWindow() {
  if (!baseURL) baseURL = await ensureServer();
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 900, minHeight: 600,
    title: 'Waypoint Studio', backgroundColor: '#0f1419', show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => { win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(baseURL)) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`document.body.classList.add('electron'); window.WS_DESKTOP = true; window.WS_RC_TOKEN = ${JSON.stringify(RC_TOKEN)}; window.dispatchEvent(new Event('ws-desktop'));`).catch(() => {});
    const f = pendingFiles.splice(0); f.forEach(importFile);
    if (global.WS.liveDir) { try { fs.rmSync(path.join(global.WS.liveDir, '.starting'), { force: true }); } catch (e) { /* ignore */ } } // light version started fine
  });
  win.on('closed', () => { win = null; });
  await win.loadURL(baseURL + '/index.html');
}

// ---------------- Updates ----------------
// Feed: a folder or an https URL with latest.json = { version, file | parts:[...], sha256, notes }.
// Default feed: ~/Projects/WaypointStudio/.upd (where new builds are delivered). Can be changed in update.json (userData).
const UPD = { state: 'idle', available: null, error: '', progress: 0 };
function updConfig() { try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'update.json'), 'utf8')); } catch (e) { return {}; } }
function updFeed() { return updConfig().feed || path.join(app.getPath('home'), 'Projects', 'WaypointStudio', '.upd'); }
const vnum = v => String(v || '0').split('.').map(x => parseInt(x, 10) || 0);
const newer = (a, b) => { const x = vnum(a), y = vnum(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function feedRead(name, binary) {
  const feed = updFeed();
  if (/^https:\/\//.test(feed)) { const r = await net.fetch(feed.replace(/\/$/, '') + '/' + name); if (!r.ok) throw new Error('HTTP ' + r.status); return binary ? Buffer.from(await r.arrayBuffer()) : await r.text(); }
  const f = path.join(feed, name); return binary ? fs.readFileSync(f) : fs.readFileSync(f, 'utf8');
}
async function checkUpdate() {
  if (UPD.state === 'downloading' || UPD.state === 'installing') return UPD;
  try {
    const m = JSON.parse(await feedRead('latest.json'));
    if (!m.version || !(m.parts || m.file) || !/^[0-9a-f]{64}$/.test(m.sha256 || '')) throw new Error('повреждённое описание обновления');
    m.lightOk = !!(m.light && m.light.file && /^[0-9a-f]{64}$/.test(m.light.sha256 || '') && m.shell === global.WS.shell && newer(m.version, global.WS.bundleVersion));
    UPD.available = newer(m.version, VER()) ? m : null; UPD.state = 'checked'; UPD.error = '';
  } catch (e) { UPD.state = 'checked'; UPD.available = null; UPD.error = e.code === 'ENOENT' ? '' : String(e.message || e); }
  return UPD;
}
function appBundlePath() { return path.resolve(process.execPath, '..', '..', '..'); } // …/Waypoint Studio.app
// light update: only the program (core.js + www, ~2 MB) into userData/live/<version>; the signed bundle is not touched
async function applyLight(m) {
  UPD.state = 'downloading'; UPD.progress = 0;
  if (!/^[A-Za-z0-9._-]+$/.test(m.light.file)) throw new Error('недопустимое имя файла');
  const b = await feedRead(m.light.file, true); UPD.progress = 1;
  if (crypto.createHash('sha256').update(b).digest('hex') !== m.light.sha256) { UPD.state = 'checked'; throw new Error('Контрольная сумма не совпала — файл обновления повреждён, программа не изменена'); }
  UPD.state = 'installing';
  const live = path.join(app.getPath('userData'), 'live'); fs.mkdirSync(live, { recursive: true });
  const tmp = path.join(live, m.version + '.tmp'), dst = path.join(live, m.version), pkg = path.join(live, m.version + '.tgz');
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp); fs.writeFileSync(pkg, b);
  await new Promise((res, rej) => execFile('/usr/bin/tar', ['xzf', pkg, '-C', tmp], e => e ? rej(e) : res())); fs.rmSync(pkg, { force: true });
  let man = {}; try { man = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8')); } catch (e) { /* checked below */ }
  if (man.version !== m.version || man.shell !== global.WS.shell || !fs.existsSync(path.join(tmp, 'core.js')) || !fs.existsSync(path.join(tmp, 'www', 'index.html')) || (man.vendor === false && !fs.existsSync(path.join(global.WS.bundleDir, 'www', 'vendor')))) { fs.rmSync(tmp, { recursive: true, force: true }); UPD.state = 'checked'; throw new Error('Обновление неполное — программа не изменена'); }
  // keep the bundled config (Google key) for the new www
  try { fs.copyFileSync(path.join(ROOT, 'config.js'), path.join(tmp, 'www', 'config.js')); } catch (e) { /* none */ }
  fs.rmSync(dst, { recursive: true, force: true }); fs.renameSync(tmp, dst);
  fs.writeFileSync(path.join(live, 'current'), m.version);
  // keep only this version and the one running now (to roll back by hand if needed)
  for (const d of fs.readdirSync(live)) { if (d === 'current' || d === m.version || (global.WS.liveDir && path.join(live, d) === global.WS.liveDir)) continue; fs.rmSync(path.join(live, d), { recursive: true, force: true }); }
  setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
  return { ok: true, version: m.version, light: true };
}
async function applyUpdate() {
  const m = UPD.available; if (!m) throw new Error('Нет доступного обновления');
  if (m.lightOk) return applyLight(m);
  const bundle = appBundlePath(); if (!/\.app$/.test(bundle)) throw new Error('Обновление работает только для установленной программы');
  UPD.state = 'downloading'; UPD.progress = 0;
  const work = fs.mkdtempSync(path.join(app.getPath('temp'), 'ws-upd-')), pkg = path.join(work, 'update.tar.gz');
  const parts = m.parts || [m.file], hash = crypto.createHash('sha256'), out = fs.openSync(pkg, 'w');
  try {
    for (let i = 0; i < parts.length; i++) { if (!/^[A-Za-z0-9._-]+$/.test(parts[i])) throw new Error('недопустимое имя файла'); const b = await feedRead(parts[i], true); hash.update(b); fs.writeSync(out, b); UPD.progress = (i + 1) / parts.length; }
  } finally { fs.closeSync(out); }
  if (hash.digest('hex') !== m.sha256) { UPD.state = 'checked'; throw new Error('Контрольная сумма не совпала — файл обновления повреждён, программа не изменена'); }
  UPD.state = 'installing';
  const ex = path.join(work, 'x'); fs.mkdirSync(ex);
  await new Promise((res, rej) => execFile('/usr/bin/tar', ['xzf', pkg, '-C', ex], e => e ? rej(e) : res()));
  const newApp = path.join(ex, 'Waypoint Studio.app'), plist = path.join(newApp, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist) || !fs.readFileSync(plist, 'utf8').includes('<string>' + (m.fullVersion || m.version) + '</string>')) { UPD.state = 'checked'; throw new Error('В обновлении нет программы нужной версии — программа не изменена'); }
  // swap after this process exits (keeps the old copy until the new one is in place), then start the new version
  const q = s => "'" + s.replace(/'/g, "'\\''") + "'";
  const script = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done; rm -rf ${q(bundle + '.old')}; mv ${q(bundle)} ${q(bundle + '.old')} && mv ${q(newApp)} ${q(bundle)} && rm -rf ${q(bundle + '.old')} ${q(work)}; touch ${q(bundle)}; /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f ${q(bundle)} 2>/dev/null; open ${q(bundle)}`; // touch + re-register so Finder/Dock pick up a new app icon
  spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 300);
  return { ok: true, version: m.version };
}
async function handleUPD(req, res, url) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  if (req.headers['x-ws-token'] !== RC_TOKEN) return send(403, { ok: false });
  try {
    if (url.pathname === '/upd/status') { if (url.searchParams.get('check')) await checkUpdate(); return send(200, { ok: true, current: VER(), light: !!(UPD.available && UPD.available.lightOk), state: UPD.state, progress: UPD.progress, error: UPD.error, available: UPD.available && { version: UPD.available.version, notes: UPD.available.notes || '' } }); }
    if (url.pathname === '/upd/apply' && req.method === 'POST') return send(200, await applyUpdate());
    return send(404, { ok: false });
  } catch (e) { return send(200, { ok: false, error: String(e.message || e) }); }
}

// menu language follows the interface (stored in userData/ui.json, changed from the page)
const MENU_EN = { 'О программе': 'About', 'Проверить обновления…': 'Check for updates…', 'Скрыть': 'Hide', 'Скрыть остальные': 'Hide others', 'Показать все': 'Show all', 'Выйти': 'Quit',
  'Файл': 'File', 'Открыть маршрут…': 'Open route…', 'Открыть папку экспорта': 'Open export folder', 'Закрыть окно': 'Close window', 'Выход': 'Exit', 'Правка': 'Edit', 'Отменить': 'Undo', 'Повторить': 'Redo',
  'Вырезать': 'Cut', 'Копировать': 'Copy', 'Вставить': 'Paste', 'Выделить всё': 'Select all', 'Вид': 'View', 'Перезагрузить': 'Reload', 'Инструменты разработчика': 'Developer tools', 'Масштаб 100%': 'Actual size',
  'Увеличить': 'Zoom in', 'Уменьшить': 'Zoom out', 'Полный экран': 'Full screen', 'Окно': 'Window', 'Справка': 'Help', 'Зоны полётов DJI (Fly Safe)': 'DJI flight zones (Fly Safe)', 'Маршруты': 'Routes' };
function uiLang() { try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'ui.json'), 'utf8')).lang || 'ru'; } catch (e) { return 'ru'; } }
function enMenu(t) { return t.map(i => { const o = Object.assign({}, i); if (o.label && MENU_EN[o.label]) o.label = MENU_EN[o.label]; if (Array.isArray(o.submenu)) o.submenu = enMenu(o.submenu); return o; }); }
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const tpl = [
    ...(isMac ? [{ label: 'Waypoint Studio', submenu: [{ role: 'about', label: 'О программе' }, { label: 'Проверить обновления…', click: async () => { await checkUpdate(); if (win) win.webContents.executeJavaScript('typeof WSUpdate !== "undefined" && WSUpdate.check(true)').catch(() => {}); } }, { type: 'separator' }, { role: 'hide', label: 'Скрыть' }, { role: 'hideOthers', label: 'Скрыть остальные' }, { role: 'unhide', label: 'Показать все' }, { type: 'separator' }, { role: 'quit', label: 'Выйти' }] }] : []),
    { label: 'Файл', submenu: [
      { label: 'Открыть маршрут…', accelerator: 'CmdOrCtrl+O', click: async () => {
        const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Маршруты', extensions: ['kmz', 'kml', 'csv', 'gpx', 'json', 'geojson', 'wpml'] }] });
        if (!r.canceled) r.filePaths.forEach(importFile);
      } },
      { label: 'Открыть папку экспорта', click: () => shell.openPath(exportDir()) },
      { type: 'separator' }, isMac ? { role: 'close', label: 'Закрыть окно' } : { role: 'quit', label: 'Выход' },
    ] },
    { label: 'Правка', submenu: [{ role: 'undo', label: 'Отменить' }, { role: 'redo', label: 'Повторить' }, { type: 'separator' }, { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' }, { role: 'paste', label: 'Вставить' }, { role: 'selectAll', label: 'Выделить всё' }] },
    { label: 'Вид', submenu: [{ role: 'reload', label: 'Перезагрузить' }, { role: 'togglefullscreen', label: 'Полный экран' }, { type: 'separator' }, { role: 'resetZoom', label: 'Масштаб 100%' }, { role: 'zoomIn', label: 'Увеличить' }, { role: 'zoomOut', label: 'Уменьшить' }, { type: 'separator' }, { role: 'toggleDevTools', label: 'Инструменты разработчика' }] },
    { role: 'windowMenu', label: 'Окно' },
    { role: 'help', label: 'Справка', submenu: [{ label: 'Зоны полётов DJI (Fly Safe)', click: () => shell.openExternal('https://fly-safe.dji.com/nfz/nfz-query') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(uiLang() === 'en' ? enMenu(tpl) : tpl));
}

app.setName('Waypoint Studio');
app.on('open-file', (e, file) => { e.preventDefault(); importFile(file); });
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', (e, argv) => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } argv.filter(a => /\.(kmz|kml|csv|gpx|json|geojson|wpml)$/i.test(a)).forEach(importFile); });
  app.whenReady().then(async () => {
    try { app.setAboutPanelOptions({ applicationName: 'Waypoint Studio', applicationVersion: VER(), version: global.WS.liveDir ? 'обновление интерфейса' : '' }); } catch (e) { /* not macOS */ }
    pollPresence(); setInterval(pollPresence, 2500);
    setTimeout(checkUpdate, 4000); setInterval(checkUpdate, 3 * 3600 * 1000);
    // permissions: location for "my position", clipboard, fullscreen
    const allow = new Set(['geolocation', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'notifications', 'pointerLock']);
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(allow.has(perm)));
    session.defaultSession.setPermissionCheckHandler((wc, perm) => allow.has(perm));
    // downloads go straight to ~/Downloads/WaypointStudio
    session.defaultSession.on('will-download', (e, item) => {
      const target = path.join(exportDir(), item.getFilename());
      item.setSavePath(target);
      item.once('done', (ev, state) => { if (state === 'completed' && win) win.webContents.executeJavaScript(`window.toast && toast(${JSON.stringify('Сохранено: Загрузки/WaypointStudio/' + item.getFilename())}, 'ok', 5000)`).catch(() => {}); });
    });
    buildMenu();
    await createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { app.quit(); });
}
