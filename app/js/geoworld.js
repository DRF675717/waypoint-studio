// World geozones besides Vietnam: official and open sources, chosen automatically by location or by the user,
// cached by the desktop app per 0.5° cell and refreshed on a chosen interval (or right now, on request).
//   • США — FAA (UAS Facility Maps / LAANC grid, Prohibited Areas, national-defence TFR, national-security UAS restrictions)
//   • Канада — NAV CANADA (UAS facility map)
//   • аэропорты и вертодромы мира — OurAirports (estimated circles, not official borders)
//   • openAIP — controlled / restricted airspace worldwide (free personal API key)
//   • свои файлы — ED-269 (the EU format national authorities publish UAS geographical zones in), GeoJSON, KML
// Everything is advisory: the route check shows warnings and red stretches; writing to the remote is never blocked.
const World = (() => {
  const { S } = Core;
  const desk = () => !!window.WS_DESKTOP;
  const KIND = { 1: { name: 'Запрет полётов', color: '#ef4444', icon: '⛔' }, 2: { name: 'Ограничение / нужно разрешение', color: '#f0a742', icon: '⛔' }, 3: { name: 'Зона внимания', color: '#facc15', icon: '⚠' } };
  // coverage boxes [south, west, north, east]
  const SRC = {
    vn: { name: 'Вьетнам — Министерство обороны', what: 'официальные зоны запрета и ограничения полётов', url: 'https://cambay.mod.gov.vn', off: true, cover: [[8, 102, 23.6, 110]], country: 'Вьетнам' },
    faa: { name: 'США — FAA', what: 'карты UAS Facility Maps (LAANC), запретные зоны, временные ограничения (TFR), объекты нац. безопасности', url: 'https://www.faa.gov/uas/getting_started/b4ufly', off: true, cover: [[24, -125.5, 49.5, -66.5], [51, -180, 71.5, -129], [18.5, -161, 22.5, -154.5], [17.5, -68, 18.7, -64.5], [13, 144, 21, 146.5]], country: 'США' },
    navcan: { name: 'Канада — NAV CANADA', what: 'официальная карта зон для дронов (аэропорты, вертодромы)', url: 'https://www.navcanada.ca/en/flight-planning/drone-flight-planning.aspx', off: true, cover: [[41.5, -141.1, 83.5, -52.5]], country: 'Канада' },
    airports: { name: 'Аэропорты мира — OurAirports', what: 'круги вокруг аэропортов и вертодромов (оценка, не официальные границы)', url: 'https://ourairports.com/' },
    openaip: { name: 'Воздушное пространство — openAIP', what: 'зоны R / P / D, CTR, ATZ по всему миру (нужен бесплатный ключ)', url: 'https://www.openaip.net/' },
    import: { name: 'Свои файлы', what: 'ED-269 (формат, в котором страны ЕС публикуют зоны для дронов), GeoJSON, KML' },
  };
  const ORDER = ['vn', 'faa', 'navcan', 'airports', 'openaip', 'import'];
  const OFFICIAL_LINKS = [['ЕС / EASA — список национальных карт зон для дронов', 'https://www.easa.europa.eu/en/domains/civil-drones/naa'], ['Великобритания — Drone Assist (NATS)', 'https://www.nats.aero/drone-assist/'], ['Австралия — CASA, проверенные приложения', 'https://www.casa.gov.au/drones/flight-authorisations/drone-safety-apps'], ['Япония — DIPS (MLIT)', 'https://www.ossportal.dips.mlit.go.jp/portal/top/'], ['DJI Fly Safe — карта геозон DJI', 'https://fly-safe.dji.com/nfz/nfz-query']];

  // ---------- settings ----------
  const DEF = { mode: 'auto', src: { vn: true, faa: true, navcan: true, airports: true, openaip: true, import: true }, days: 7, key: '' };
  let cfg = Object.assign({}, DEF, Core.store.get('ws.geo', {}) || {}); cfg.src = Object.assign({}, DEF.src, cfg.src || {});
  const save = () => Core.store.set('ws.geo', cfg);
  const ttl = () => (cfg.days > 0 ? cfg.days : 90) * 86400e3;
  const hit = (b, c) => !(b[0] > c[2] || b[2] < c[0] || b[1] > c[3] || b[3] < c[1]);
  const covers = (src, bb) => !SRC[src].cover || SRC[src].cover.some(c => hit(bb, c));
  const officialHere = bb => ['vn', 'faa', 'navcan'].some(k => covers(k, bb));
  // is a source used for this area (bb = [s, w, n, e])
  function active(src, bb) {
    if (src === 'openaip' && !cfg.key) return false;
    if (cfg.mode === 'manual') return !!cfg.src[src] && covers(src, bb);
    if (!cfg.src[src] && src !== 'vn') return false; // a source switched off by the user stays off
    if (src === 'airports') return !officialHere(bb);  // official national data where it exists, airport circles elsewhere
    return covers(src, bb);
  }

  // ---------- location (for automatic choice) ----------
  let here = Core.store.get('ws.geo.here', null), mapRef = null;
  function countryOf(lat, lng) { const b = [lat, lng, lat, lng]; for (const k of ['vn', 'faa', 'navcan']) if (covers(k, b)) return SRC[k].country; return null; }
  function locate() {
    return new Promise(res => {
      const fallback = () => { const c = mapRef ? mapRef.getCenter() : null; res(c ? { lat: c.lat, lng: c.lng, how: 'по центру карты (геолокация компьютера недоступна)' } : null); };
      if (!navigator.geolocation) return fallback();
      let done = false; const t = setTimeout(() => { if (!done) { done = true; fallback(); } }, 9000);
      navigator.geolocation.getCurrentPosition(p => { if (done) return; done = true; clearTimeout(t); res({ lat: p.coords.latitude, lng: p.coords.longitude, how: 'по геолокации компьютера' }); },
        () => { if (done) return; done = true; clearTimeout(t); fallback(); }, { timeout: 8000, maximumAge: 6 * 3600e3 });
    }).then(r => { if (r) { here = { ...r, at: Date.now() }; Core.store.set('ws.geo.here', here); } return r; });
  }

  // ---------- data cells ----------
  const cells = new Map(), errs = {};
  const cellKey = (src, s, w) => src + '|' + s + '|' + w;
  function bbOf(rings) { let s = 90, w = 180, n = -90, e = -180; rings.forEach(r => r.forEach(([la, lo]) => { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; })); return [s, w, n, e]; }
  function cell(src, s, w) {
    const k = cellKey(src, s, w); if (cells.has(k)) return cells.get(k);
    const pr = fetch(`/geo/cell?src=${src}&lat=${s + 0.25}&lng=${w + 0.25}&ttl=${ttl()}`, { headers: { 'X-WS-Token': window.WS_RC_TOKEN || '', 'X-OpenAIP-Key': src === 'openaip' ? cfg.key : '' } })
      .then(r => r.json()).then(j => {
        if (!j.ok) throw new Error(j.error || 'ошибка');
        delete errs[src];
        return (j.f || []).filter(f => f.rings && f.rings.length).map(f => Object.assign(f, { bb: bbOf(f.rings) }));
      }).catch(e => { errs[src] = e.message || String(e); cells.delete(k); return null; });
    cells.set(k, pr); if (cells.size > 400) cells.delete(cells.keys().next().value);
    return pr;
  }
  function cellsOf(bb, max = 40) {
    const out = [], s0 = Math.floor(bb[0] * 2) / 2, w0 = Math.floor(bb[1] * 2) / 2;
    for (let s = s0; s < bb[2]; s += 0.5) for (let w = w0; w < bb[3]; w += 0.5) { out.push([+s.toFixed(1), +w.toFixed(1)]); if (out.length > max) return null; }
    return out;
  }
  const SOURCES = ['faa', 'navcan', 'airports', 'openaip', 'import'];
  // all features of the active sources for an area; returns { list, bad: [sources that failed] } or null if too big
  async function load(bb, max = 40) {
    const cs = cellsOf(bb, max); if (!cs) return null;
    const list = [], bad = new Set(), seen = new Set();
    await Promise.all(SOURCES.filter(src => active(src, bb)).map(src => Promise.all(cs.map(async ([s, w]) => {
      const fs = await cell(src, s, w); if (!fs) { bad.add(src); return; }
      fs.forEach(f => { if (!seen.has(f.id) && hit(f.bb, bb)) { seen.add(f.id); list.push(f); } });
    }))));
    return { list, bad: [...bad] };
  }
  // point in polygon over all rings of a feature (even-odd: holes work)
  function inside(f, lat, lng) {
    if (lat < f.bb[0] || lat > f.bb[2] || lng < f.bb[1] || lng > f.bb[3]) return false;
    let c = false;
    for (const r of f.rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[0] > lat) !== (b[0] > lat) && lng < (b[1] - a[1]) * (lat - a[0]) / (b[0] - a[0]) + a[1]) c = !c; }
    return c;
  }

  // ---------- 2D layer ----------
  const lon2x = (lng, z) => (lng + 180) / 360 * 2 ** z;
  const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
  const x2lon = (x, z) => x / 2 ** z * 360 - 180;
  const y2lat = (y, z) => { const n = Math.PI * (1 - 2 * y / 2 ** z); return Math.atan(Math.sinh(n)) * 180 / Math.PI; };
  const ZMIN = 8;
  let layer = null;
  function makeLayer() {
    const Grid = L.GridLayer.extend({
      createTile(c, done) {
        const cv = document.createElement('canvas'), sz = this.getTileSize(); cv.width = sz.x * 2; cv.height = sz.y * 2;
        if (c.z < ZMIN) { setTimeout(() => done(null, cv), 0); return cv; }
        const bb = [y2lat(c.y + 1, c.z), x2lon(c.x, c.z), y2lat(c.y, c.z), x2lon(c.x + 1, c.z)];
        load(bb, 24).then(r => {
          if (r && r.list.length) {
            const g = cv.getContext('2d'), W = cv.width, X = lng => (lon2x(lng, c.z) - c.x) * W, Y = lat => (lat2y(lat, c.z) - c.y) * W;
            [3, 2, 1].forEach(kd => r.list.filter(f => f.kind === kd).forEach(f => {
              const col = KIND[kd].color;
              g.beginPath(); f.rings.forEach(rg => rg.forEach(([la, lo], i) => i ? g.lineTo(X(lo), Y(la)) : g.moveTo(X(lo), Y(la))));
              g.fillStyle = col; g.globalAlpha = kd === 1 ? 0.6 : kd === 2 ? 0.45 : 0.35; g.fill('evenodd'); g.globalAlpha = 1;
              g.strokeStyle = col; g.lineWidth = c.z >= 12 ? 3.5 : 2; g.stroke();
            }));
          }
          done(null, cv);
        });
        return cv;
      },
    });
    return new Grid({ pane: 'zonesPane', tileSize: 256, minZoom: ZMIN, maxZoom: 22, updateWhenZooming: false, keepBuffer: 1, opacity: 0.55, attribution: 'Геозоны: FAA, NAV CANADA, OurAirports, openAIP' });
  }
  function show(map, on) {
    if (!map) return; mapRef = map;
    if (on && desk()) { if (!layer) layer = makeLayer(); if (!map.hasLayer(layer)) layer.addTo(map); }
    else if (layer && map.hasLayer(layer)) map.removeLayer(layer);
  }
  function redraw() { cells.clear(); if (layer) layer.redraw(); Core.emit('geoSources'); }

  // features under a point from the cells already loaded (for the hover tooltip)
  async function at(lat, lng) {
    const bb = [lat - 1e-4, lng - 1e-4, lat + 1e-4, lng + 1e-4], r = await load(bb, 4); if (!r) return [];
    return r.list.filter(f => inside(f, lat, lng)).sort((a, b) => a.kind - b.kind);
  }
  const srcName = f => (SRC[f.src] || { name: f.src }).name;

  // ---------- route check: pts = [{lat, lng, seg, what}] (the same samples Zones uses) ----------
  async function check(pts) {
    if (!desk() || !pts.length) return { found: [], bad: [], state: 'done' };
    let s = 90, w = 180, n = -90, e = -180; pts.forEach(p => { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); });
    const r = await load([s - 0.01, w - 0.01, n + 0.01, e + 0.01], 60);
    if (!r) return { found: [], bad: [], state: 'toobig' };
    const found = new Map();
    pts.forEach(p => {
      p.wkind = 0;
      r.list.forEach(f => { if (!inside(f, p.lat, p.lng)) return;
        const h = found.get(f.id) || { id: f.id, layer: f.kind, f, segs: new Set(), what: new Set(), n: 0, world: true };
        h.n++; if (p.seg >= 0) h.segs.add(p.seg); if (p.what !== 'точка') h.what.add(p.what); found.set(f.id, h);
        p.wkind = p.wkind ? Math.min(p.wkind, f.kind) : f.kind; });
    });
    return { found: [...found.values()], bad: r.bad, state: 'done' };
  }
  function message(h) {
    const segs = [...h.segs].sort((a, b) => a - b), f = h.f;
    const where = [...h.what].filter(w => w !== 'маршрут').concat(segs.length ? [segs.length === 1 ? `отрезок Т.${segs[0] + 1}→${segs[0] + 2}` : `отрезки Т.${segs[0] + 1}…Т.${segs[segs.length - 1] + 2}`] : []).join(', ');
    const info = f.info ? ` (${f.info})` : '';
    if (f.kind === 3) return `Зона внимания — ${f.name}${info}: ${where}. Источник: ${srcName(f)}.`;
    return `Пересечение ${f.kind === 1 ? 'запретной' : 'ограниченной'} зоны — ${f.name}${info}: ${where}. Источник: ${srcName(f)}.`;
  }
  const badMsg = src => `Геозоны «${SRC[src].name}»: нет связи с источником и нет сохранённой копии для этого района${errs[src] ? ' (' + errs[src] + ')' : ''} — проверьте маршрут по официальной карте.`;

  // polygons for the 3D view
  async function around(b) {
    const r = await load([b.s, b.w, b.n, b.e], 30); if (!r) return [];
    return r.list.filter(f => f.kind <= 2 || f.src === 'airports').slice(0, 400).map(f => ({ id: f.id, layer: f.kind, rings: f.rings, lines: f.rings.map(rg => rg.concat([rg[0]])), color: KIND[f.kind].color }));
  }

  // ---------- import: ED-269 / GeoJSON / KML → normalised zones ----------
  const KW1 = /prohib|forbid|no.?fly|restricted.?area.?p|запрет|cấm|verbot|interdit/i;
  function circleRing(lat, lng, r) { const o = []; for (let k = 0; k <= 48; k++) { const a = k / 48 * 2 * Math.PI; o.push([lat + r * Math.cos(a) / 111320, lng + r * Math.sin(a) / (111320 * Math.cos(lat * Math.PI / 180))]); } return o; }
  const geoRings = g => !g ? [] : g.type === 'Polygon' ? [g.coordinates.map(r => r.map(([x, y]) => [y, x]))] : g.type === 'MultiPolygon' ? g.coordinates.map(p => p.map(r => r.map(([x, y]) => [y, x]))) : g.type === 'Circle' && g.center ? [[circleRing(g.center[1], g.center[0], +g.radius || 0)]] : g.type === 'GeometryCollection' ? g.geometries.flatMap(geoRings) : [];
  function parseImport(name, text) {
    const out = [], push = (kind, nm, info, polys) => polys.forEach(rings => { rings = rings.filter(r => r.length >= 3); if (rings.length) out.push({ id: 'import:' + name + ':' + out.length, kind, name: nm || 'Зона', info, src: 'import', rings, bb: bbOf(rings) }); });
    const t = text.trim();
    if (t.startsWith('<')) { // KML
      const doc = new DOMParser().parseFromString(t, 'application/xml'); if (doc.querySelector('parsererror')) throw new Error('файл KML повреждён');
      doc.querySelectorAll('Placemark').forEach(pm => {
        const nm = (pm.querySelector('name') || {}).textContent || '', ds = ((pm.querySelector('description') || {}).textContent || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 140);
        const polys = [...pm.querySelectorAll('Polygon')].map(pg => [...pg.querySelectorAll('outerBoundaryIs coordinates, innerBoundaryIs coordinates')].map(c => c.textContent.trim().split(/\s+/).map(s => s.split(',').map(Number)).filter(a => a.length >= 2 && isFinite(a[0]) && isFinite(a[1])).map(([x, y]) => [y, x])));
        push(KW1.test(nm + ' ' + ds) ? 1 : 2, nm, ds, polys);
      });
      return out;
    }
    const j = JSON.parse(t);
    const feats = Array.isArray(j) ? j : j.type === 'FeatureCollection' || Array.isArray(j.features) ? j.features : j.type === 'Feature' ? [j] : j.type ? [{ type: 'Feature', geometry: j, properties: {} }] : [];
    feats.forEach(f => {
      if (f && Array.isArray(f.geometry) && (f.restriction || f.identifier)) { // ED-269 UASZone
        const rs = String(f.restriction || '').toUpperCase(), kind = rs === 'PROHIBITED' ? 1 : rs === 'NO_RESTRICTION' ? 3 : 2;
        f.geometry.forEach(gm => { const hp = gm.horizontalProjection || gm.horizontal_projection; if (!hp) return;
          const lim = gm.upperLimit != null ? `до ${gm.upperLimit} ${(gm.uomDimensions || 'M').toUpperCase() === 'FT' ? 'ft' : 'м'}` : '';
          push(kind, f.name || f.identifier, [rs === 'PROHIBITED' ? 'запрещено' : rs === 'REQ_AUTHORISATION' ? 'нужно разрешение' : rs === 'CONDITIONAL' ? 'с условиями' : rs === 'NO_RESTRICTION' ? 'без ограничений' : '', lim, Array.isArray(f.reason) ? f.reason.join(', ') : f.reason || ''].filter(Boolean).join(' · '), geoRings(hp)); });
        return;
      }
      const p = (f && f.properties) || {}, nm = p.name || p.NAME || p.Name || p.title || p.identifier || '', ds = [p.restriction, p.type, p.description, p.reason].filter(x => typeof x === 'string').join(' ').slice(0, 140);
      push(KW1.test(nm + ' ' + ds) ? 1 : 2, nm, ds, geoRings(f && f.geometry));
    });
    return out;
  }
  async function importFiles(files) {
    let total = 0; const msgs = [];
    for (const fl of files) {
      try {
        const zs = parseImport(fl.name, await fl.text()); if (!zs.length) { msgs.push(`${fl.name}: зон не найдено`); continue; }
        const r = await fetch('/geo/import?name=' + encodeURIComponent(fl.name.replace(/\.[^.]+$/, '')), { method: 'POST', headers: { 'X-WS-Token': window.WS_RC_TOKEN || '' }, body: JSON.stringify(zs) }).then(r => r.json());
        if (!r.ok) throw new Error(r.error || 'не сохранено'); total += zs.length; msgs.push(`${fl.name}: ${zs.length} зон`);
      } catch (e) { msgs.push(`${fl.name}: ошибка — ${e.message}`); }
    }
    redraw(); return { total, msgs };
  }

  // ---------- dialog «Геозоны: источники и обновления» ----------
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const ago = t => { if (!t) return 'ещё не загружались'; const m = (Date.now() - t) / 60000; return m < 2 ? 'только что' : m < 60 ? Math.round(m) + ' мин назад' : m < 1440 ? Math.round(m / 60) + ' ч назад' : Math.round(m / 1440) + ' дн. назад'; };
  async function info() { try { const r = await fetch('/geo/info', { headers: { 'X-WS-Token': window.WS_RC_TOKEN || '' } }).then(r => r.json()); return r.ok ? r.info : {}; } catch (e) { return {}; } }
  let dlg = null;
  async function openDialog(toast) {
    toast = toast || (() => {});
    if (!desk()) return toast('Мировые геозоны работают в программе Waypoint Studio для macOS', 'err', 6000);
    if (!dlg) { dlg = document.createElement('div'); dlg.id = 'geoDlg'; dlg.className = 'geodlg'; document.body.appendChild(dlg); }
    const inf = await info(), loc = here, cty = loc ? countryOf(loc.lat, loc.lng) : null;
    const locBB = loc ? [loc.lat, loc.lng, loc.lat, loc.lng] : null;
    const row = k => {
      const s = SRC[k], i = inf[k] || {}, use = locBB ? active(k, locBB) : null;
      const auto = cfg.mode === 'auto';
      return `<div class="gsrc${use ? ' use' : ''}" data-src="${k}">
        <label><input type="checkbox" data-on="${k}" ${cfg.src[k] ? 'checked' : ''} ${auto && k === 'vn' ? 'disabled' : ''}><b>${esc(s.name)}</b>${s.off ? '<em>официальный</em>' : ''}${use ? '<em class="here">используется здесь</em>' : ''}</label>
        <div class="gsub">${esc(s.what)}${s.url ? ` · <a href="${s.url}" target="_blank">сайт</a>` : ''}</div>
        <div class="gsub">${k === 'import' ? (inf.imports && inf.imports.length ? 'Загружено: ' + inf.imports.map(f => `${esc(f.replace(/\.json$/, ''))} <a href="#" data-unimp="${esc(f)}" title="Убрать">✕</a>`).join(', ') : 'Файлов пока нет') : `Обновлено: ${ago(i.updated)}${i.files ? ` · в кэше ${i.files} фрагм.` : ''}${errs[k] ? ` · <span class="gerr">ошибка: ${esc(errs[k])}</span>` : ''}`}
          ${k === 'import' ? '<button class="btn sm" data-imp>Загрузить файл…</button>' : `<button class="btn sm" data-upd="${k}">Обновить сейчас</button>`}</div>
        ${k === 'openaip' ? `<div class="gsub">Ключ: <input type="text" id="geoKey" value="${esc(cfg.key)}" placeholder="вставьте ключ openAIP" spellcheck="false"> <a href="https://www.openaip.net/users/clients" target="_blank">получить ключ</a></div>` : ''}
      </div>`;
    };
    dlg.innerHTML = `<div class="gbox"><div class="ghead"><b>🌍 Геозоны: источники и обновления</b><button class="btn sm" data-close>✕</button></div>
      <div class="gloc">${loc ? `Ваше место: <b>${cty || 'страна без официального источника в программе'}</b> (${loc.lat.toFixed(3)}, ${loc.lng.toFixed(3)}) — ${esc(loc.how)}${loc.at ? ', ' + ago(loc.at) : ''}` : 'Местоположение ещё не определено'} <button class="btn sm" data-loc>📍 Определить</button></div>
      <div class="gmode"><label><input type="radio" name="gmode" value="auto" ${cfg.mode === 'auto' ? 'checked' : ''}> <b>Автоматически</b> — по месту полёта: официальные данные страны, где они есть; в остальных странах — аэропорты (и openAIP при наличии ключа)</label>
        <label><input type="radio" name="gmode" value="manual" ${cfg.mode === 'manual' ? 'checked' : ''}> <b>Вручную</b> — только отмеченные источники</label></div>
      <div class="glist">${ORDER.map(row).join('')}</div>
      <div class="gupd">Проверять обновления: <select id="geoDays">${[[1, 'каждый день'], [7, 'раз в неделю'], [30, 'раз в месяц'], [0, 'только вручную']].map(([v, t]) => `<option value="${v}" ${+cfg.days === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <button class="btn sm" data-updall>Обновить все сейчас</button></div>
      <details class="glinks"><summary>Официальные карты других стран (открываются в браузере)</summary>${OFFICIAL_LINKS.map(([t, u]) => `<div><a href="${u}" target="_blank">${esc(t)}</a></div>`).join('')}<div class="gsub">Многие службы стран ЕС дают скачать зоны в формате ED-269 — загрузите такой файл через «Свои файлы».</div></details>
      <div class="gnote">Геозоны — только предупреждение: маршрут всегда можно записать на пульт. Окончательно правила проверяйте в официальном приложении своей страны и в DJI Fly.</div>
      <input type="file" id="geoFile" accept=".json,.geojson,.kml,application/json" multiple hidden></div>`;
    dlg.hidden = false;
    const $ = s => dlg.querySelector(s), changed = () => { save(); redraw(); };
    dlg.onclick = async e => {
      const t = e.target;
      if (t === dlg || t.closest('[data-close]')) { dlg.hidden = true; return; }
      if (t.closest('[data-loc]')) { t.disabled = true; t.textContent = 'Определяю…'; await locate(); return openDialog(toast); }
      if (t.closest('[data-imp]')) return $('#geoFile').click();
      const un = t.closest('[data-unimp]'); if (un) { e.preventDefault(); await fetch('/geo/unimport?name=' + encodeURIComponent(un.dataset.unimp), { method: 'POST', headers: { 'X-WS-Token': window.WS_RC_TOKEN || '' } }); changed(); return openDialog(toast); }
      const up = t.closest('[data-upd]'), all = t.closest('[data-updall]');
      if (up || all) {
        const list = all ? ORDER.filter(k => k !== 'import') : [up.dataset.upd]; (up || all).disabled = true; (up || all).textContent = 'Обновляю…';
        for (const k of list) await fetch('/geo/clear?src=' + k, { headers: { 'X-WS-Token': window.WS_RC_TOKEN || '' } }).catch(() => {});
        if (list.includes('vn') && window.Zones) Zones.refresh();
        changed(); toast('Геозоны будут заново загружены с официальных сайтов для просматриваемого района и маршрута', 'ok', 5000);
        setTimeout(() => openDialog(toast), 2500); return;
      }
    };
    dlg.onchange = async e => {
      const t = e.target;
      if (t.name === 'gmode') { cfg.mode = t.value; changed(); return openDialog(toast); }
      if (t.dataset.on) { cfg.src[t.dataset.on] = t.checked; changed(); if (t.dataset.on === 'vn' && window.Zones) Zones.refresh(); return openDialog(toast); }
      if (t.id === 'geoDays') { cfg.days = +t.value; save(); return; }
      if (t.id === 'geoKey') { cfg.key = t.value.trim(); delete errs.openaip; changed(); return openDialog(toast); }
      if (t.id === 'geoFile' && t.files.length) { const r = await importFiles([...t.files]); toast(r.msgs.join(' · '), r.total ? 'ok' : 'err', 7000); return openDialog(toast); }
    };
  }

  // ---------- planning a trip: geozones of another country ----------
  const PLACES = [['Вьетнам — Нячанг', 12.24, 109.19], ['Вьетнам — Фукуок', 10.22, 103.96], ['Таиланд — Пхукет', 7.89, 98.39], ['Таиланд — Бангкок', 13.75, 100.5], ['Индонезия — Бали', -8.65, 115.2],
    ['Малайзия — Куала-Лумпур', 3.14, 101.69], ['Япония — Токио', 35.68, 139.76], ['Южная Корея — Сеул', 37.57, 126.98], ['ОАЭ — Дубай', 25.2, 55.27], ['Турция — Стамбул', 41.01, 28.98],
    ['Грузия — Тбилиси', 41.72, 44.79], ['Россия — Москва', 55.75, 37.62], ['Франция — Париж', 48.86, 2.35], ['Италия — Рим', 41.9, 12.5], ['Испания — Барселона', 41.39, 2.17],
    ['США — Нью-Йорк', 40.71, -74.0], ['США — Лос-Анджелес', 34.05, -118.24], ['Канада — Ванкувер', 49.28, -123.12], ['Австралия — Сидней', -33.87, 151.21]];
  function sourcesAt(lat, lng) { const b = [lat, lng, lat, lng]; return ORDER.filter(k => k !== 'import' && active(k, b)).map(k => SRC[k].name); }
  // download the zones of an area in advance (to plan a trip and to fly later without internet)
  async function prefetch(bb) {
    const r = await load(bb, 400); let vn = 0;
    if (active('vn', bb) && window.Zones && Zones.prefetch) vn = await Zones.prefetch(bb);
    return { n: r ? r.list.length : 0, bad: r ? r.bad : [], vn, tooBig: !r };
  }
  let tdlg = null;
  function openTravel(toast, map) {
    toast = toast || (() => {}); map = map || mapRef;
    if (!desk()) return toast('Геозоны работают в программе Waypoint Studio для macOS', 'err', 6000);
    if (!tdlg) { tdlg = document.createElement('div'); tdlg.className = 'geodlg'; document.body.appendChild(tdlg); }
    tdlg.innerHTML = `<div class="gbox"><div class="ghead"><b>🌍 Геозоны в другой стране</b><button class="btn sm" data-close>✕</button></div>
      <div class="gnote" style="margin:0 0 8px">Планируете поездку? Выберите место — карта перейдёт туда, покажет зоны и подберёт источники для этой страны (не по месту, где сейчас находится компьютер). Маршрут можно составить заранее.</div>
      <div class="gtrav"><input type="text" id="tvQ" placeholder="Город, курорт, адрес или координаты…" autocomplete="off"><div id="tvRes"></div></div>
      <div class="gplaces">${PLACES.map(([n, la, lo], k) => `<button class="btn sm" data-pl="${k}">${esc(n)}</button>`).join('')}</div>
      <div class="gupd" id="tvHere"></div>
      <div><button class="btn primary" data-pf>⬇ Сохранить зоны этого района для работы без интернета</button></div>
      <div class="gnote">Сохраняется район, видимый на карте (до ~200×200 км). Данные хранятся на этом компьютере и обновляются по расписанию из «Источники и обновления».</div></div>`;
    tdlg.hidden = false;
    const $ = q => tdlg.querySelector(q);
    const here = () => { const c = map.getCenter(); const src = sourcesAt(c.lat, c.lng); $('#tvHere').innerHTML = `Сейчас на карте: ${c.lat.toFixed(3)}, ${c.lng.toFixed(3)} · источники: <b>${src.length ? src.map(esc).join(', ') : 'нет'}</b>${src.some(x => /OurAirports/.test(x)) && !cfg.key ? ' · для зон воздушного пространства добавьте бесплатный ключ openAIP' : ''}`; };
    const go = (lat, lng, name) => { map.setView([lat, lng], 11); if (window.Zones && !Zones.on) Zones.setOn(true); here(); toast(`${name}: показаны геозоны. Источники — ${sourcesAt(lat, lng).join(', ') || 'нет'}`, 'ok', 6000); };
    here();
    let tq = 0;
    $('#tvQ').oninput = e => { clearTimeout(tq); const q = e.target.value.trim(); if (q.length < 3) { $('#tvRes').innerHTML = ''; return; }
      tq = setTimeout(async () => { try { const r = await Maps.search(q); $('#tvRes').innerHTML = r.slice(0, 6).map((x, k) => `<div data-k="${k}">${esc(x.name)}</div>`).join('') || '<div>Ничего не найдено</div>'; $('#tvRes').onclick = ev => { const d = ev.target.closest('[data-k]'); if (!d) return; const x = r[+d.dataset.k]; $('#tvRes').innerHTML = ''; go(x.lat, x.lng, x.name.split(',')[0]); }; } catch (err) { $('#tvRes').innerHTML = '<div>Поиск недоступен</div>'; } }, 450); };
    tdlg.onclick = async e => {
      const t = e.target;
      if (t === tdlg || t.closest('[data-close]')) { tdlg.hidden = true; return; }
      const pl = t.closest('[data-pl]'); if (pl) { const [n, la, lo] = PLACES[+pl.dataset.pl]; go(la, lo, n); return; }
      if (t.closest('[data-pf]')) {
        const b = map.getBounds(), bb = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
        if ((bb[2] - bb[0]) * (bb[3] - bb[1]) > 4.5) return toast('Слишком большой район — приблизьте карту (до ~200×200 км)', 'err', 6000);
        t.disabled = true; t.textContent = 'Загружаю…';
        const r = await prefetch(bb);
        t.disabled = false; t.textContent = '⬇ Сохранить зоны этого района для работы без интернета';
        toast(r.bad.length ? `Часть источников недоступна: ${r.bad.map(k => SRC[k].name).join(', ')}` : `Сохранено: ${r.n + r.vn} зон и фрагментов карты для этого района`, r.bad.length ? 'err' : 'ok', 7000);
      }
    };
  }

  // first start: find out where the computer is (silently), for the automatic choice
  window.addEventListener('ws-desktop', () => { if (!here || Date.now() - here.at > 7 * 86400e3) setTimeout(() => locate(), 3000); });

  return { openTravel, prefetch, sourcesAt, KIND, SRC, active, show, redraw, at, check, message, badMsg, around, openDialog, locate, parseImport, srcName, get cfg() { return cfg; }, get here() { return here; }, get errors() { return errs; }, _inside: inside };
})();
