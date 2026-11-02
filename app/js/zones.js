// Vietnam no-fly («Vùng cấm bay», CB) and restricted («Vùng hạn chế bay», HCB) zones from the official map of the
// Ministry of Defence of Vietnam (https://cambay.mod.gov.vn). The desktop app proxies its vector tiles (/cb/tile/z/x/y)
// with a disk cache. This module:
//   • draws the zones on the 2D map (toggle «⛔ Зоны»), with a hover tooltip;
//   • checks the route (path + take-off) against the zones and reports hits in the route check (Core.validate);
//   • gives the 3D view the zone polygons around the route.
const Zones = (() => {
  const { S } = Core;
  const KIND = { 1: { name: 'Зона запрета полётов', short: 'запрет', vi: 'Vùng cấm bay', color: '#ef4444', lvl: 'err' },
                 2: { name: 'Зона ограничения полётов', short: 'ограничение', vi: 'Vùng hạn chế bay', color: '#f0a742', lvl: 'warn' } };
  const available = () => !!window.WS_DESKTOP;
  // the Vietnam source is used only where it applies (and can be switched off in «Геозоны: источники»)
  const vnActive = bb => typeof World === 'undefined' || World.active('vn', bb);
  const SRC = 'Минобороны Вьетнама · cambay.mod.gov.vn';

  // ---------- Mapbox Vector Tile decoding ----------
  function decode(buf) {
    const u8 = new Uint8Array(buf); let p = 0;
    const varint = () => { let r = 0, s = 0, b; do { b = u8[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80 && p < u8.length); return r; };
    const read = (end, fn) => { while (p < end) { const k = varint(); fn(k >> 3, k & 7); } };
    const skip = w => { if (w === 0) varint(); else if (w === 1) p += 8; else if (w === 2) { const l = varint(); p += l; } else if (w === 5) p += 4; };
    const str = () => { const l = varint(), s = new TextDecoder().decode(u8.subarray(p, p + l)); p += l; return s; };
    const packed = () => { const l = varint(), e = p + l, a = []; while (p < e) a.push(varint()); return a; };
    const out = [];
    read(u8.length, (f, w) => {
      if (f !== 3) return skip(w);
      const l = varint(), end = p + l, L = { ext: 4096, keys: [], vals: [], feats: [] };
      read(end, (f2, w2) => {
        if (f2 === 5) L.ext = varint();
        else if (f2 === 3) L.keys.push(str());
        else if (f2 === 4) { const ve = p + varint(); let v = null; read(ve, (f3, w3) => { if (f3 === 1) v = str(); else if (f3 === 2) { v = new DataView(u8.buffer, u8.byteOffset + p, 4).getFloat32(0, true); p += 4; } else if (f3 === 3) { v = new DataView(u8.buffer, u8.byteOffset + p, 8).getFloat64(0, true); p += 8; } else if (f3 === 4 || f3 === 5) v = varint(); else if (f3 === 6) { const z = varint(); v = (z >> 1) ^ -(z & 1); } else if (f3 === 7) v = !!varint(); else skip(w3); }); L.vals.push(v); }
        else if (f2 === 2) { const fe = p + varint(), F = { tags: [], type: 0, geom: [] }; read(fe, (f3, w3) => { if (f3 === 2) F.tags = packed(); else if (f3 === 3) F.type = varint(); else if (f3 === 4) F.geom = packed(); else skip(w3); }); L.feats.push(F); }
        else skip(w2);
      });
      L.feats.forEach(F => {
        const pr = {}; for (let i = 0; i < F.tags.length; i += 2) pr[L.keys[F.tags[i]]] = L.vals[F.tags[i + 1]];
        if (F.type !== 3) return;
        // geometry → rings in tile pixels (0…ext)
        const g = F.geom, rings = []; let i = 0, cx = 0, cy = 0, ring = null;
        while (i < g.length) {
          const c = g[i++], id = c & 7, cnt = c >> 3;
          if (id === 1 || id === 2) for (let k = 0; k < cnt; k++) { const dx = g[i++], dy = g[i++]; cx += (dx >> 1) ^ -(dx & 1); cy += (dy >> 1) ^ -(dy & 1); if (id === 1) { ring = [[cx, cy]]; rings.push(ring); } else ring.push([cx, cy]); }
        }
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        rings.forEach(r => r.forEach(([x, y]) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }));
        out.push({ id: pr.id, layer: pr.layer_id, rings, ext: L.ext, bb: [x0, y0, x1, y1] });
      });
    });
    return out;
  }
  // point in polygon (even-odd over all rings: outer + holes)
  function inside(f, x, y) {
    if (x < f.bb[0] || x > f.bb[2] || y < f.bb[1] || y > f.bb[3]) return false;
    let c = false;
    for (const r of f.rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; }
    return c;
  }

  // ---------- tiles ----------
  const cache = new Map();
  let failed = 0, lastErr = '';
  function tile(z, x, y) {
    const k = z + '/' + x + '/' + y; if (cache.has(k)) return cache.get(k);
    const pr = fetch(`/cb/tile/${z}/${x}/${y}${typeof World !== 'undefined' ? '?ttl=' + (World.cfg.days > 0 ? World.cfg.days : 90) * 86400e3 : ''}`).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(b => { failed = 0; return b.byteLength ? decode(b) : []; })
      .catch(e => { failed++; lastErr = e.message; cache.delete(k); return null; });
    cache.set(k, pr); if (cache.size > 600) cache.delete(cache.keys().next().value);
    return pr;
  }
  const lon2x = (lng, z) => (lng + 180) / 360 * 2 ** z;
  const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
  const x2lon = (x, z) => x / 2 ** z * 360 - 180;
  const y2lat = (y, z) => { const n = Math.PI * (1 - 2 * y / 2 ** z); return Math.atan(Math.sinh(n)) * 180 / Math.PI; };

  // zones containing a point (data zoom dz)
  async function at(lat, lng, dz = 13) {
    const X = lon2x(lng, dz), Y = lat2y(lat, dz), tx = Math.floor(X), ty = Math.floor(Y);
    const fs = await tile(dz, tx, ty); if (!fs) return null;
    const px = (X - tx), py = (Y - ty);
    return fs.filter(f => inside(f, px * f.ext, py * f.ext));
  }

  // ---------- details (code, address) ----------
  const det = new Map();
  function details(id) {
    if (!det.has(id)) det.set(id, fetch('/cb/detail?id=' + id).then(r => r.ok ? r.json() : null).then(j => {
      if (!j || !j.properties) return null; const o = {};
      Object.entries(j.properties).forEach(([k, v]) => { let n = k; try { n = JSON.parse(k).vi || k; } catch (e) { /* plain key */ } o[n] = v; });
      return { code: o['Mã ký hiệu quy ước'] || '', address: o['Địa chỉ'] || [o['Phường xã'], o['Quận huyện'], o['Tỉnh thành']].filter(Boolean).join(', '), province: o['Tỉnh thành'] || '' };
    }).catch(() => null));
    return det.get(id);
  }

  // ---------- 2D map layer (canvas grid layer: each map tile is drawn from the matching data tile) ----------
  let layer = null, on = Core.store.get('ws.zones', true) !== false, map = null;
  function makeLayer() {
    const Grid = L.GridLayer.extend({
      createTile(c, done) {
        const cv = document.createElement('canvas'), sz = this.getTileSize(); cv.width = sz.x * 2; cv.height = sz.y * 2;
        const dz = Math.max(6, Math.min(14, c.z)), k = c.z - dz;
        if (c.z < 6) { setTimeout(() => done(null, cv), 0); return cv; }
        const tx = c.x >> k, ty = c.y >> k, sub = 2 ** k, ox = c.x - tx * sub, oy = c.y - ty * sub;
        if (!vnActive([y2lat(c.y + 1, c.z), x2lon(c.x, c.z), y2lat(c.y, c.z), x2lon(c.x + 1, c.z)])) { setTimeout(() => done(null, cv), 0); return cv; }
        tile(dz, tx, ty).then(fs => {
          if (fs && fs.length) {
            const g = cv.getContext('2d'), W = cv.width;
            [2, 1].forEach(lay => fs.filter(f => f.layer === lay).forEach(f => {
              const s = W * sub / f.ext, X = x => x * s - ox * W, Y = y => y * s - oy * W;
              if (f.bb[2] * s - ox * W < -4 || f.bb[0] * s - ox * W > W + 4 || f.bb[3] * s - oy * W < -4 || f.bb[1] * s - oy * W > W + 4) return;
              g.beginPath(); f.rings.forEach(r => r.forEach(([x, y], i) => i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
              const col = KIND[lay] ? KIND[lay].color : '#a855f7', e = f.ext;
              // opaque colours in the tile; the transparency is applied to the whole layer, so overlapping tiles
              // (e.g. while zooming) never look darker
              g.fillStyle = col; g.globalAlpha = lay === 1 ? 0.62 : 0.5; g.fill('evenodd'); g.globalAlpha = 1;
              // outline without the tile-border edges (the data is cut at tile borders — no seams)
              const t = e * 0.004, edge = (a, b) => (a[0] <= t && b[0] <= t) || (a[0] >= e - t && b[0] >= e - t) || (a[1] <= t && b[1] <= t) || (a[1] >= e - t && b[1] >= e - t);
              g.beginPath(); f.rings.forEach(r => { for (let i = 1; i < r.length; i++) { if (edge(r[i - 1], r[i])) continue; g.moveTo(X(r[i - 1][0]), Y(r[i - 1][1])); g.lineTo(X(r[i][0]), Y(r[i][1])); } const a = r[r.length - 1], b = r[0]; if (!edge(a, b)) { g.moveTo(X(a[0]), Y(a[1])); g.lineTo(X(b[0]), Y(b[1])); } });
              g.strokeStyle = col; g.lineWidth = c.z >= 12 ? 4 : 2.5; g.stroke();
            }));
          }
          done(null, cv);
        });
        return cv;
      },
    });
    return new Grid({ pane: 'zonesPane', tileSize: 256, minZoom: 6, maxZoom: 22, updateWhenZooming: false, keepBuffer: 2, opacity: 0.55, attribution: 'Зоны полётов: ' + SRC });
  }
  function apply() {
    if (!map) return;
    if (on && available()) { if (!layer) layer = makeLayer(); if (!map.hasLayer(layer)) layer.addTo(map); }
    else if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    if (typeof World !== 'undefined') World.show(map, on);
    const b = document.getElementById('zonesBtn'); if (b) { b.classList.toggle('on', on && available()); b.title = available() ? (on ? 'Скрыть геозоны (запрет и ограничение полётов)' : 'Показать геозоны (запрет и ограничение полётов)') : 'Геозоны доступны в программе для macOS'; }
    const lg = document.getElementById('zonesLegend'); if (lg) lg.hidden = !(on && available());
    Core.emit('zonesView', on);
  }
  function setOn(v) { on = !!v; Core.store.set('ws.zones', on); apply(); }

  // hover tooltip
  let tipEl = null, hoverT = 0, hoverSeq = 0;
  function hover(e) {
    if (!on || !available() || !map || map.getZoom() < 9) { if (tipEl) tipEl.hidden = true; return; }
    const now = performance.now(); if (now - hoverT < 120) return; hoverT = now;
    const seq = ++hoverSeq, ll = e.latlng, pt = e.containerPoint;
    const vn = vnActive([ll.lat, ll.lng, ll.lat, ll.lng]) ? at(ll.lat, ll.lng, Math.min(13, Math.max(9, map.getZoom()))) : Promise.resolve([]);
    Promise.all([vn, typeof World !== 'undefined' ? World.at(ll.lat, ll.lng).catch(() => []) : []]).then(async ([fs, wf]) => {
      if (seq !== hoverSeq) return;
      if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'zoneTip'; map.getContainer().appendChild(tipEl); }
      if ((!fs || !fs.length) && wf && wf.length) { // world sources
        const f = wf[0], kd = World.KIND[f.kind];
        tipEl.hidden = false; tipEl.style.left = (pt.x + 14) + 'px'; tipEl.style.top = (pt.y + 14) + 'px';
        tipEl.innerHTML = `<b style="color:${kd.color === '#facc15' ? '#a16207' : kd.color}">${kd.icon} ${kd.name}</b><span>${esc(f.name)}${f.info ? ' · ' + esc(f.info) : ''}</span>${wf.length > 1 ? `<span>и ещё зон здесь: ${wf.length - 1}</span>` : ''}<small>${esc(World.srcName(f))}</small>`;
        return;
      }
      if (!fs || !fs.length) { tipEl.hidden = true; return; }
      const f = fs.sort((a, b) => a.layer - b.layer)[0], kd = KIND[f.layer] || { name: 'Зона', color: '#a855f7' };
      tipEl.hidden = false; tipEl.style.left = (pt.x + 14) + 'px'; tipEl.style.top = (pt.y + 14) + 'px';
      tipEl.innerHTML = `<b style="color:${kd.color}">⛔ ${kd.name}</b><span>${kd.vi || ''}</span>`;
      const d = await details(f.id); if (seq !== hoverSeq || !d) return;
      tipEl.innerHTML = `<b style="color:${kd.color}">⛔ ${kd.name}</b><span>${d.code ? 'Код ' + d.code + ' · ' : ''}${d.address || ''}</span><small>${SRC}</small>`;
    });
  }

  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  // ---------- route check ----------
  let hits = { key: '', list: [], state: 'idle' }, runSeq = 0, timer = null;
  const routeKey = () => JSON.stringify([S.m.waypoints.map(w => [w.lat.toFixed(6), w.lng.toFixed(6)]), S.m.home && [S.m.home.lat.toFixed(6), S.m.home.lng.toFixed(6)], S.m.settings.curve, S.m.settings.pathMode]);
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 400); }
  async function run() {
    if (!available()) return;
    const W = S.m.waypoints, key = routeKey(); if (key === hits.key && hits.state === 'done') return;
    const seq = ++runSeq;
    if (!W.length && !S.m.home) { hits = { key, list: [], stretches: [], state: 'done' }; Core.emit('zones'); return; }
    hits = { key, list: hits.list, state: 'busy' };
    // samples: take-off + the flight path every ~15 m (+ the approach from take-off)
    const g = Core.pathGeometry(), pts = [], home = Core.homePt();
    const push = (p, seg, what) => pts.push({ lat: p.lat, lng: p.lng, seg, what });
    if (S.m.home) push(S.m.home, -1, 'взлёт');
    const line = (a, b, seg, what) => { const d = Geo.dist(a, b), n = Math.max(1, Math.ceil(d / 15)); for (let k = 0; k <= n; k++) push(Geo.interp(a, b, k / n), seg, what); };
    // approach / return exist only when the take-off point is set (otherwise the route is NOT closed: point 1 ≠ last point)
    if (S.m.home && W.length) line(home, W[0], -1, 'подлёт');
    for (let i = 1; i < g.length; i++) line(g[i - 1], g[i], g[i - 1].i, 'маршрут');
    if (S.m.home && W.length > 1 && S.m.settings.finishAction === 'rth') line(W[W.length - 1], home, -1, 'возврат');
    W.forEach((w, i) => pts.push({ lat: w.lat, lng: w.lng, seg: -2, what: 'точка', wi: i }));
    const dz = 13, found = new Map();
    let s0 = 90, w0 = 180, n0 = -90, e0 = -180; pts.forEach(p => { s0 = Math.min(s0, p.lat); n0 = Math.max(n0, p.lat); w0 = Math.min(w0, p.lng); e0 = Math.max(e0, p.lng); });
    const useVN = vnActive([s0, w0, n0, e0]);
    // world sources (FAA, NAV CANADA, airports, openAIP, own files) — checked in parallel
    const wp = typeof World !== 'undefined' ? World.check(pts).catch(() => ({ found: [], bad: [], state: 'done' })) : Promise.resolve({ found: [], bad: [], state: 'done' });
    // load the needed Vietnam data tiles (few for a normal route)
    const need = new Map(); if (useVN) pts.forEach(p => { const tx = Math.floor(lon2x(p.lng, dz)), ty = Math.floor(lat2y(p.lat, dz)); need.set(tx + '/' + ty, [tx, ty]); });
    let state = 'done';
    const T = {}; let bad = 0;
    if (need.size > 400) state = 'toobig';
    else await Promise.all([...need].map(async ([k, [tx, ty]]) => { T[k] = await tile(dz, tx, ty); if (!T[k]) bad++; }));
    const wr = await wp;
    if (seq !== runSeq) return;
    if (bad) state = 'offline';
    pts.forEach(p => {
      const X = lon2x(p.lng, dz), Y = lat2y(p.lat, dz), tx = Math.floor(X), ty = Math.floor(Y), fs = T[tx + '/' + ty] || [];
      p.kind = 0;
      fs.forEach(f => { if (!inside(f, (X - tx) * f.ext, (Y - ty) * f.ext)) return;
        const h = found.get(f.id) || { id: f.id, layer: f.layer, segs: new Set(), what: new Set(), n: 0 };
        h.n++; if (p.seg >= 0) h.segs.add(p.seg); if (p.what !== 'точка') h.what.add(p.what); found.set(f.id, h);
        p.kind = p.kind ? Math.min(p.kind, f.layer) : f.layer; });
      if (p.wkind && p.wkind <= 2) p.kind = p.kind ? Math.min(p.kind, p.wkind) : p.wkind; // world zones (caution zones are not drawn red)
    });
    // stretches of the flight inside zones (drawn red on the map with a note)
    const zoneWps = new Set(pts.filter(p => p.what === 'точка' && p.kind).map(p => p.wi));
    const stretches = []; let cur = null;
    pts.filter(p => p.what !== 'точка').forEach((p, i, pts) => { if (p.kind) { if (!cur || cur.kind !== p.kind || cur.what !== p.what) { cur = { kind: p.kind, what: p.what, pts: i && pts[i - 1].what === p.what ? [pts[i - 1], p] : [p] }; stretches.push(cur); } else cur.pts.push(p); } else if (cur) { if (cur.what === p.what) cur.pts.push(p); cur = null; } });
    const list = [...found.values()].sort((a, b) => a.layer - b.layer);
    await Promise.all(list.map(async h => { h.d = await details(h.id); }));
    if (seq !== runSeq) return;
    hits = { key, list: list.concat(wr.found.sort((a, b) => a.layer - b.layer)), stretches, zoneWps, state, wbad: wr.bad, wstate: wr.state }; Core.emit('zones');
  }
  // items for Core.validate()
  function checks() {
    if (!available()) return [];
    const out = [];
    if (hits.state === 'offline') out.push({ lvl: 'warn', msg: 'Зоны полётов Вьетнама: нет связи с cambay.mod.gov.vn и нет сохранённой копии для этого района — проверьте маршрут на сайте вручную.' });
    if (hits.state === 'toobig') out.push({ lvl: 'warn', msg: 'Зоны полётов: маршрут слишком большой для автоматической проверки — проверьте его на карте зон.' });
    // warnings only: the route can still be written to the remote — the pilot decides
    if (hits.wstate === 'toobig') out.push({ lvl: 'warn', msg: 'Геозоны: маршрут слишком большой для автоматической проверки по мировым источникам — проверьте его на карте зон.' });
    (hits.wbad || []).forEach(src => out.push({ lvl: 'warn', msg: World.badMsg(src) }));
    hits.list.forEach(h => {
      if (h.world) { const segs = [...h.segs].sort((a, b) => a - b); out.push({ lvl: 'warn', zone: true, i: segs.length ? segs[0] : undefined, msg: World.message(h) }); return; }
      const kd = KIND[h.layer] || { name: 'Зона' }, segs = [...h.segs].sort((a, b) => a - b);
      const where = [...h.what].filter(w => w !== 'маршрут').concat(segs.length ? [segs.length === 1 ? `отрезок Т.${segs[0] + 1}→${segs[0] + 2}` : `отрезки Т.${segs[0] + 1}…Т.${segs[segs.length - 1] + 2}`] : []).join(', ');
      const code = h.d && h.d.code ? ` ${h.d.code}` : '', addr = h.d && h.d.address ? ` (${h.d.address})` : '';
      out.push({ lvl: 'warn', zone: true, i: segs.length ? segs[0] : undefined, msg: `Пересечение ${h.layer === 1 ? 'запретной' : 'ограниченной'} зоны${code}${addr}: ${where}.` });
    });
    return out;
  }

  function init(m) {
    map = m;
    if (!map.getPane('zonesPane')) { const pn = map.createPane('zonesPane'); pn.style.zIndex = 390; pn.style.pointerEvents = 'none'; }
    map.on('mousemove', hover); map.on('mouseout', () => { if (tipEl) tipEl.hidden = true; });
    apply(); schedule();
  }
  Core.on('change', schedule);
  window.addEventListener('ws-desktop', () => { apply(); schedule(); });
  // sources / settings changed: drop cached tiles and check the route again
  // download the Vietnam zone tiles of an area in advance; returns the number of tiles
  async function prefetch(bb, dz = 13) {
    const x0 = Math.floor(lon2x(bb[1], dz)), x1 = Math.floor(lon2x(bb[3], dz)), y0 = Math.floor(lat2y(bb[2], dz)), y1 = Math.floor(lat2y(bb[0], dz));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 900) return 0;
    const jobs = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
    let n = 0; for (let k = 0; k < jobs.length; k += 12) { const r = await Promise.all(jobs.slice(k, k + 12).map(([x, y]) => tile(dz, x, y))); n += r.filter(Boolean).length; }
    return n;
  }
  function refresh() { cache.clear(); if (layer) layer.redraw(); hits.key = ''; schedule(); }
  Core.on('geoSources', () => { if (layer) layer.redraw(); hits.key = ''; schedule(); });

  // polygons of zones around the route for the 3D view: rings in lat/lng clipped to their data tile
  async function around(bounds, dz = 12) {
    if (!available()) return [];
    const wz = typeof World !== 'undefined' ? await World.around(bounds).catch(() => []) : [];
    if (!vnActive([bounds.s, bounds.w, bounds.n, bounds.e])) return wz;
    return (await aroundVN(bounds, dz)).concat(wz);
  }
  async function aroundVN(bounds, dz) {
    const x0 = Math.floor(lon2x(bounds.w, dz)), x1 = Math.floor(lon2x(bounds.e, dz)), y0 = Math.floor(lat2y(bounds.n, dz)), y1 = Math.floor(lat2y(bounds.s, dz));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) return [];
    const out = [];
    for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) {
      const fs = await tile(dz, tx, ty); if (!fs) continue;
      fs.forEach(f => {
        const cr = f.rings.map(r => clip(r, f.ext)).filter(r => r.length >= 3), e = f.ext;
        const toLL = ([x, y]) => [y2lat(ty + y / e, dz), x2lon(tx + x / e, dz)];
        // outline without the artificial edges along the tile border (no seams between neighbouring tiles)
        const onB = (a, b) => (Math.abs(a[0]) < 1e-6 && Math.abs(b[0]) < 1e-6) || (Math.abs(a[0] - e) < 1e-6 && Math.abs(b[0] - e) < 1e-6) || (Math.abs(a[1]) < 1e-6 && Math.abs(b[1]) < 1e-6) || (Math.abs(a[1] - e) < 1e-6 && Math.abs(b[1] - e) < 1e-6);
        const lines = [];
        cr.forEach(r => { let cur = null; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; if (onB(a, b)) { cur = null; continue; } if (!cur) { cur = [toLL(a)]; lines.push(cur); } cur.push(toLL(b)); } });
        if (cr.length) out.push({ id: f.id, layer: f.layer, rings: cr.map(r => r.map(toLL)), lines, color: (KIND[f.layer] || {}).color || '#a855f7' });
      });
    }
    return out;
  }
  // Sutherland–Hodgman clip of a ring to the tile square [0, ext]
  function clip(r, e) {
    let pts = r.slice();
    const edges = [[p => p[0] >= 0, (a, b) => { const t = (0 - a[0]) / (b[0] - a[0]); return [0, a[1] + t * (b[1] - a[1])]; }],
                   [p => p[0] <= e, (a, b) => { const t = (e - a[0]) / (b[0] - a[0]); return [e, a[1] + t * (b[1] - a[1])]; }],
                   [p => p[1] >= 0, (a, b) => { const t = (0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), 0]; }],
                   [p => p[1] <= e, (a, b) => { const t = (e - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), e]; }]];
    for (const [ins, cut] of edges) {
      const inp = pts; pts = []; if (!inp.length) break;
      for (let i = 0; i < inp.length; i++) { const a = inp[(i + inp.length - 1) % inp.length], b = inp[i];
        if (ins(b)) { if (!ins(a)) pts.push(cut(a, b)); pts.push(b); } else if (ins(a)) pts.push(cut(a, b)); }
    }
    return pts;
  }

  return { init, setOn, get on() { return on; }, get available() { return available(); }, checks, at, details, around, refresh, prefetch, KIND, SRC, get state() { return hits.state; }, get hits() { return hits.list; }, get stretches() { return hits.stretches || []; }, get zoneWps() { return hits.zoneWps || new Set(); }, run };
})();
