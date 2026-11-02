// Plan vs real flight: read a flight log (Airdata / FlightReader / Litchi / PhantomHelp CSV, GPX, KML, GeoJSON),
// draw the flown track over the plan (2D, 3D, height profile) and measure how far the drone was from the planned path.
// DJI's own .txt records (DJI Fly, version 13+) are encrypted: they are converted to CSV first (airdata.com,
// phantomhelp.com/logviewer, flightreader) — the button in the dialog explains how.
const FlightLog = (() => {
  const { S } = Core;
  let track = null, cmp = null;

  // ---------- parsing ----------
  function splitCSV(line, sep) { const o = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === sep) { o.push(cur); cur = ''; } else cur += ch; } o.push(cur); return o; }
  const FT = 0.3048;
  function parseCSVLog(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
    // FlightReader / PhantomHelp put a title line or «sep=,» before the header
    let hi = lines.findIndex(l => /latitude/i.test(l)); if (hi < 0) return null;
    const sep = (lines[hi].match(/;/g) || []).length > (lines[hi].match(/,/g) || []).length ? ';' : ',';
    const H = splitCSV(lines[hi], sep).map(h => h.trim());
    const find = (...res) => { for (const re of res) { const i = H.findIndex(h => re.test(h)); if (i >= 0) return i; } return -1; };
    const unit = i => (i < 0 ? 1 : /feet|\[ft\]|\(ft\)|_ft\b/i.test(H[i]) ? FT : 1);
    const I = {
      lat: find(/^(osd\.)?latitude\b/i, /latitude/i), lng: find(/^(osd\.)?longitude\b/i, /longitude/i),
      h: find(/height_above_takeoff/i, /^osd\.height\b/i, /^altitude\(feet\)$/i, /^altitude\(m\)$/i, /^height\b/i, /relative.?alt/i),
      asl: find(/altitude_above_sea/i, /^osd\.altitude\b/i, /^altitude.*msl/i),
      tms: find(/^time\(millisecond\)$/i, /^offsettime/i), fly: find(/^osd\.flytime/i, /^flytime/i, /^custom\.flytime/i), dt: find(/datetime\(utc\)/i, /^custom\.datetime/i, /^custom\.updatetime/i, /^time$/i, /timestamp/i),
      rec: find(/^isvideo$/i, /camera\.isvideo/i, /isrecording/i), photo: find(/^isphoto$/i, /camera\.isphoto/i),
      hd: find(/compass_heading/i, /^osd\.yaw/i, /^yaw/i), gb: find(/gimbal_pitch/i, /^gimbal\.pitch/i), bat: find(/battery_percent/i, /battery\.chargelevel/i, /^battery/i),
      spd: find(/^speed\(m\/s\)/i, /^speed\(mph\)/i, /^osd\.hspeed/i),
    };
    if (I.lat < 0 || I.lng < 0) return null;
    const uh = unit(I.h), ua = unit(I.asl), num = v => { const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : null; };
    const pts = []; let t0 = null;
    for (let k = hi + 1; k < lines.length; k++) {
      const c = splitCSV(lines[k], sep), lat = num(c[I.lat]), lng = num(c[I.lng]);
      if (lat == null || lng == null || (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      let t = I.tms >= 0 ? num(c[I.tms]) : I.fly >= 0 ? (num(c[I.fly]) ?? 0) * 1000 : null;
      if (t == null && I.dt >= 0) { const d = Date.parse(String(c[I.dt]).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(c[I.dt]) ? '' : 'Z')); if (isFinite(d)) { if (t0 == null) t0 = d; t = d - t0; } }
      const yes = v => /^(1|true|yes)$/i.test(String(v || '').trim());
      pts.push({ t: t ?? pts.length * 100, lat, lng, h: I.h >= 0 ? (num(c[I.h]) ?? 0) * uh : null, asl: I.asl >= 0 ? (num(c[I.asl]) ?? 0) * ua : null,
        rec: I.rec >= 0 ? yes(c[I.rec]) : null, photo: I.photo >= 0 ? yes(c[I.photo]) : null, hd: I.hd >= 0 ? num(c[I.hd]) : null, gb: I.gb >= 0 ? num(c[I.gb]) : null, bat: I.bat >= 0 ? num(c[I.bat]) : null });
    }
    return pts;
  }
  function parseGPX(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml'); const pts = []; let t0 = null;
    [...doc.getElementsByTagName('trkpt')].concat([...doc.getElementsByTagName('rtept')]).forEach((p, k) => {
      const e = p.getElementsByTagName('ele')[0], tm = p.getElementsByTagName('time')[0], d = tm ? Date.parse(tm.textContent) : NaN;
      if (isFinite(d) && t0 == null) t0 = d;
      pts.push({ t: isFinite(d) ? d - t0 : k * 1000, lat: +p.getAttribute('lat'), lng: +p.getAttribute('lon'), asl: e ? +e.textContent : null, h: null });
    });
    return pts;
  }
  function parseKMLTrack(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml'), pts = [];
    const coords = [...doc.getElementsByTagNameNS('*', 'coord')];
    if (coords.length) { const whens = [...doc.getElementsByTagNameNS('*', 'when')]; let t0 = null;
      coords.forEach((c, k) => { const [lng, lat, alt] = c.textContent.trim().split(/\s+/).map(Number); const d = whens[k] ? Date.parse(whens[k].textContent) : NaN; if (isFinite(d) && t0 == null) t0 = d; pts.push({ t: isFinite(d) ? d - t0 : k * 1000, lat, lng, asl: alt ?? null, h: null }); }); return pts; }
    const ls = [...doc.getElementsByTagNameNS('*', 'LineString')].sort((a, b) => b.textContent.length - a.textContent.length)[0];
    if (!ls) return pts;
    const rel = /relativeToGround|relativeToSeaFloor/.test((ls.getElementsByTagNameNS('*', 'altitudeMode')[0] || {}).textContent || '');
    ls.getElementsByTagNameNS('*', 'coordinates')[0].textContent.trim().split(/\s+/).forEach((c, k) => { const [lng, lat, alt] = c.split(',').map(Number); if (isFinite(lat)) pts.push({ t: k * 1000, lat, lng, h: rel ? alt : null, asl: rel ? null : alt ?? null }); });
    return pts;
  }
  function parseGeo(text) {
    const j = JSON.parse(text), pts = [], push = (c, k) => pts.push({ t: k * 1000, lat: c[1], lng: c[0], asl: c[2] ?? null, h: null });
    const geo = g => g && (g.type === 'LineString' ? g.coordinates.forEach(push) : g.type === 'MultiLineString' ? g.coordinates.flat().forEach(push) : g.type === 'Feature' ? geo(g.geometry) : g.type === 'FeatureCollection' ? g.features.forEach(f => geo(f.geometry)) : null);
    geo(j.type ? j : null); return pts;
  }
  function parse(text, name = '') {
    const ext = (name.split('.').pop() || '').toLowerCase(); let pts = null;
    if (ext === 'txt' && /^\s*[\x00-\x08]|DJI/.test(text.slice(0, 64)) && !/latitude/i.test(text.slice(0, 4000))) throw new Error('Это зашифрованный журнал DJI (.txt). Сначала превратите его в CSV — подробности в окне «Сравнить с журналом полёта».');
    if (ext === 'gpx' || /<gpx[\s>]/i.test(text.slice(0, 500))) pts = parseGPX(text);
    else if (ext === 'kml' || /<kml[\s>]/i.test(text.slice(0, 500))) pts = parseKMLTrack(text);
    else if (ext === 'json' || ext === 'geojson') pts = parseGeo(text);
    else pts = parseCSVLog(text);
    if (!pts || pts.length < 2) throw new Error('В файле нет трека полёта (нужны колонки широты и долготы)');
    pts.sort((a, b) => a.t - b.t);
    // height above take-off from sea-level altitude when the log has no relative height
    if (pts.every(p => p.h == null)) { const a0 = pts.find(p => p.asl != null); pts.forEach(p => { p.h = p.asl != null && a0 ? p.asl - a0.asl : null; }); }
    return { name: name || 'Журнал полёта', pts, hasH: pts.some(p => p.h != null), hasRec: pts.some(p => p.rec != null) };
  }
  const isLogCSV = text => { const h = text.slice(0, 4000); return /latitude/i.test(h) && /(height_above_takeoff|isVideo|OSD\.|flyTime|time\(millisecond\)|CAMERA\.|battery)/i.test(h); };

  // ---------- comparison with the plan ----------
  const R = 6371008.8;
  function compare(tr = track) {
    if (!tr) return null;
    const G = Core.pathGeometry(); if (G.length < 2) return null;
    const lat0 = G[0].lat * Math.PI / 180, kx = R * Math.cos(lat0) * Math.PI / 180, ky = R * Math.PI / 180;
    const P = G.map(g => ({ x: (g.lng - G[0].lng) * kx, y: (g.lat - G[0].lat) * ky, alt: g.alt, i: g.i }));
    const cum = [0]; for (let k = 1; k < P.length; k++) cum[k] = cum[k - 1] + Math.hypot(P[k].x - P[k - 1].x, P[k].y - P[k - 1].y);
    const out = [];
    const near = (x, y, k0, k1) => { let best = null;
      for (let k = Math.max(1, k0); k < Math.min(P.length, k1); k++) {
        const a = P[k - 1], b = P[k], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
        const f = L2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2)) : 0, ex = a.x + f * dx - x, ey = a.y + f * dy - y, d = Math.hypot(ex, ey);
        if (!best || d < best.d) best = { d, k, f, alt: a.alt + f * (b.alt - a.alt), gd: cum[k - 1] + f * (cum[k] - cum[k - 1]), wi: a.i };
      } return best; };
    // follow the route in order: the next match is searched just around the previous one (a route that passes the same
    // place twice, or a wide corner, must not make the position jump); re-acquire globally only when clearly off
    let kPrev = null;
    tr.pts.forEach(p => {
      const x = (p.lng - G[0].lng) * kx, y = (p.lat - G[0].lat) * ky, glob = near(x, y, 1, P.length);
      let best = glob;
      if (kPrev != null) { const loc = near(x, y, kPrev - 1, kPrev + 12); if (loc && loc.d < glob.d + 15) best = loc; }
      if (best.d < 40) kPrev = best.k;
      out.push({ p, dh: glob.d, dv: p.h != null ? p.h - best.alt : null, gd: best.gd, wi: best.wi, on: glob.d < 40 });
    });
    const on = out.filter(o => o.on), dv = on.filter(o => o.dv != null);
    if (!on.length) return { n: tr.pts.length, onRoute: 0, far: true };
    const seg = {}; on.forEach(o => { const s = seg[o.wi] || (seg[o.wi] = { wi: o.wi, hMax: 0, vMax: 0 }); s.hMax = Math.max(s.hMax, o.dh); if (o.dv != null) s.vMax = Math.max(s.vMax, Math.abs(o.dv)); });
    const T = tr.pts[tr.pts.length - 1].t - tr.pts[0].t;
    let len = 0; for (let k = 1; k < tr.pts.length; k++) len += Geo.dist(tr.pts[k - 1], tr.pts[k]);
    let recT = 0; for (let k = 1; k < tr.pts.length; k++) if (tr.pts[k].rec) recT += tr.pts[k].t - tr.pts[k - 1].t;
    const covered = Math.max(...on.map(o => o.gd)) - Math.min(...on.map(o => o.gd));
    cmp = { n: tr.pts.length, onRoute: on.length, pts: out,
      hMax: Math.max(...on.map(o => o.dh)), hMean: on.reduce((a, o) => a + o.dh, 0) / on.length,
      vMax: dv.length ? Math.max(...dv.map(o => Math.abs(o.dv))) : null, vMean: dv.length ? dv.reduce((a, o) => a + o.dv, 0) / dv.length : null,
      dur: T / 1000, len, recT: tr.hasRec ? recT / 1000 : null, covered, planLen: cum[cum.length - 1],
      worst: Object.values(seg).sort((a, b) => (b.hMax + b.vMax) - (a.hMax + a.vMax)).slice(0, 5), batUsed: (() => { const b = tr.pts.filter(p => p.bat != null); return b.length > 1 ? b[0].bat - b[b.length - 1].bat : null; })() };
    return cmp;
  }

  // ---------- display ----------
  let layer = null;
  const col = d => d < 3 ? '#3ccf7a' : d < 8 ? '#ffb020' : '#ff3b3b';
  function draw2D() {
    const map = WS.map; if (layer) { map.removeLayer(layer); layer = null; } if (!track) return;
    layer = L.layerGroup().addTo(map);
    const pts = track.pts.map(p => [p.lat, p.lng]);
    L.polyline(pts, { color: '#000', weight: 4.5, opacity: .45, interactive: false }).addTo(layer);
    if (cmp && cmp.pts) { // coloured by distance from the plan
      for (let k = 1; k < cmp.pts.length; k++) { const a = cmp.pts[k - 1], b = cmp.pts[k]; L.polyline([[a.p.lat, a.p.lng], [b.p.lat, b.p.lng]], { color: b.on ? col(b.dh) : '#ffffff', weight: 2.2, opacity: b.on ? .95 : .6, dashArray: b.on ? null : '4 5', interactive: false }).addTo(layer); }
    } else L.polyline(pts, { color: '#ffffff', weight: 2.2, interactive: false }).addTo(layer);
    L.circleMarker(pts[0], { radius: 5, color: '#fff', weight: 2, fillColor: '#3ccf7a', fillOpacity: 1 }).bindTooltip('Начало журнала').addTo(layer);
    L.circleMarker(pts[pts.length - 1], { radius: 5, color: '#fff', weight: 2, fillColor: '#ff3b3b', fillOpacity: 1 }).bindTooltip('Конец журнала').addTo(layer);
  }
  function show(tr) { track = tr; compare(); draw2D(); Core.emit('flightlog'); }
  function clear() { track = null; cmp = null; draw2D(); Core.emit('flightlog'); }
  Core.on('rendered', () => { if (track) { compare(); draw2D(); } });

  // profile: flown height over along-route distance (profile d of each waypoint ↔ plan geometry distance)
  function profileLine(pr) {
    if (!cmp || !cmp.pts || !pr) return [];
    const G = Core.pathGeometry(), cum = [0]; for (let k = 1; k < G.length; k++) cum[k] = cum[k - 1] + Geo.dist(G[k - 1], G[k]);
    const gw = [], pw = []; G.forEach((g, k) => { if (g.wp && gw[g.i] == null) gw[g.i] = cum[k]; }); pr.samples.forEach(s => { if (s.wp != null && pw[s.wp] == null) pw[s.wp] = s.d; });
    const map = gd => { for (let i = 1; i < gw.length; i++) if (gw[i] != null && gw[i - 1] != null && gd <= gw[i]) { const f = (gd - gw[i - 1]) / Math.max(1e-6, gw[i] - gw[i - 1]); return pw[i - 1] + f * (pw[i] - pw[i - 1]); } return pw[pw.length - 1]; };
    // in time order; the position along the route never goes back (corners make the nearest point jump)
    let dm = -Infinity; return cmp.pts.filter(o => o.on && o.p.h != null).map(o => { dm = Math.max(dm, map(o.gd)); return { d: dm, h: o.p.h, rec: o.p.rec }; });
  }

  // ---------- dialog ----------
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const m1 = v => v == null ? '—' : (Math.round(v * 10) / 10) + ' м';
  function card() {
    if (!track) return '';
    const c = cmp || {};
    if (c.far) return `<div class="logcard"><div class="lch"><b>✈ ${esc(track.name)}</b><button class="btn sm" data-lg="close">✕</button></div><p class="note bad">Трек не проходит рядом с маршрутом (дальше 40 м). Откройте маршрут, по которому летали.</p></div>`;
    const fm = s => s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
    return `<div class="logcard"><div class="lch"><b>✈ План и полёт</b><small>${esc(track.name)}</small><button class="btn sm" data-lg="close" title="Убрать трек">✕</button></div>
      <div class="kv"><span>Отклонение в плане</span><b class="${c.hMax > 8 ? 'bad' : c.hMax > 3 ? 'warnc' : 'okc'}">до ${m1(c.hMax)} <small>(ср. ${m1(c.hMean)})</small></b>
      <span>Отклонение по высоте</span><b class="${c.vMax > 8 ? 'bad' : c.vMax > 3 ? 'warnc' : 'okc'}">${c.vMax == null ? 'в журнале нет высоты' : `до ${m1(c.vMax)} <small>(ср. ${c.vMean > 0 ? '+' : ''}${m1(c.vMean)})</small>`}</b>
      <span>Пройдено маршрута</span><b>${Math.round(100 * Math.min(1, c.covered / (c.planLen || 1)))}%</b>
      <span>Полёт</span><b>${fm(c.dur)} · ${Geo && c.len >= 1000 ? (c.len / 1000).toFixed(2) + ' км' : Math.round(c.len) + ' м'}</b>
      ${c.recT != null ? `<span>Запись видео</span><b>${fm(c.recT)}</b>` : ''}${c.batUsed != null ? `<span>Батарея</span><b>−${Math.round(c.batUsed)}%</b>` : ''}</div>
      ${c.worst && c.worst.length ? `<div class="note">Больше всего отклонений: ${c.worst.filter(w => w.hMax > 3 || w.vMax > 3).map(w => `<a href="#" data-lg="wp" data-i="${w.wi}">Т.${w.wi + 1}→${w.wi + 2}</a> (${Math.round(w.hMax)} м / ${Math.round(w.vMax)} м)`).join(', ') || 'нет, дрон шёл по плану'}</div>` : ''}
      <div class="lleg"><i style="background:#3ccf7a"></i>до 3 м <i style="background:#ffb020"></i>3–8 м <i style="background:#ff3b3b"></i>больше 8 м <i style="background:#fff"></i>вне маршрута</div></div>`;
  }
  let dlg = null;
  function openDialog() {
    if (!dlg) { dlg = document.createElement('div'); dlg.className = 'geodlg'; document.body.appendChild(dlg); }
    dlg.innerHTML = `<div class="gbox"><div class="ghead"><b>✈ Сравнить с журналом полёта</b><button class="btn sm" data-x>✕</button></div>
      <p>Откройте журнал полёта по этому маршруту — программа наложит реальный путь дрона на план и покажет, где и насколько он отклонился по высоте и в плане.</p>
      <div class="row"><button class="btn primary" data-pick>Выбрать файл журнала…</button><span class="note">или перетащите файл в окно</span></div>
      <h3>Какие файлы подходят</h3>
      <ul class="note"><li><b>CSV</b> из Airdata, PhantomHelp Log Viewer, FlightReader, Litchi.</li><li>Треки <b>GPX, KML, GeoJSON</b>.</li></ul>
      <h3>Журнал DJI Fly (.txt)</h3>
      <p class="note">Пульт DJI RC 2 хранит журналы в папке <code>Android/data/dji.go.v5/files/FlightRecord</code>. Начиная с версии 13 DJI шифрует их, поэтому сначала их нужно превратить в CSV:
        загрузите файл <code>DJIFlightRecord_….txt</code> на <a href="https://www.phantomhelp.com/logviewer/upload/" target="_blank">phantomhelp.com/logviewer</a> (бесплатно) и скачайте CSV, или используйте <a href="https://app.airdata.com" target="_blank">Airdata</a> / FlightReader.</p>
      <input type="file" hidden accept=".csv,.txt,.gpx,.kml,.json,.geojson" data-f></div>`;
    dlg.hidden = false;
    dlg.onclick = e => { if (e.target === dlg || e.target.closest('[data-x]')) dlg.hidden = true; if (e.target.closest('[data-pick]')) dlg.querySelector('[data-f]').click(); };
    dlg.querySelector('[data-f]').onchange = async e => { const f = e.target.files[0]; if (!f) return; await openFile(f); dlg.hidden = true; };
  }
  async function openFile(f) {
    try {
      if (S.m.waypoints.length < 2) throw new Error('Сначала откройте маршрут, по которому летали');
      const tr = parse(await f.text(), f.name); show(tr);
      const c = cmp || {}; WS.refresh && WS.refresh();
      if (c.far) toast('Трек не проходит рядом с маршрутом — проверьте, тот ли это маршрут', 'err', 7000);
      else toast(`Журнал «${f.name}»: ${tr.pts.length} точек. Отклонение до ${m1(c.hMax)} в плане${c.vMax != null ? `, до ${m1(c.vMax)} по высоте` : ''}. Подробности — во вкладке «Проверка».`, 'ok', 8000);
      return true;
    } catch (e) { toast(f.name + ': ' + e.message, 'err', 9000); return false; }
  }
  return { parse, compare, show, clear, card, openDialog, openFile, profileLine, isLogCSV, get track() { return track; }, get result() { return cmp; } };
})();
