// Waypoint Studio — automatic checks before every release.
// Run:  node tests/run.js            (from the repository root; needs Node 18+ and Playwright with Chromium)
//       node tests/run.js --only=io  (one group)
// Network to the map services is not needed: everything external is answered by local stubs.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.join(__dirname, '..', 'app'), PORT = 8799;
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, info) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; fails.push(name); console.log('  ✗ ' + name + (info !== undefined ? '  → ' + JSON.stringify(info).slice(0, 300) : '')); } };

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
  return new Promise(res => { const s = http.createServer((q, r) => {
    let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html';
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
  }).listen(PORT, () => res(s)); });
}
const W3 = [[12.2462, 109.1960], [12.2462, 109.2010], [12.2475, 109.2000]];
async function page(b, init) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
  // offline: every external request gets an empty answer (tiles, geocoder, weather, elevation…)
  await p.route(u => !u.href.startsWith('http://localhost:' + PORT), r => r.fulfill({ status: 200, body: '' }));
  await p.addInitScript(() => { try { localStorage.setItem('ws.tourDone', 'true'); } catch (e) { /* ignore */ } });
  await p.goto(`http://localhost:${PORT}/index.html`); await p.waitForFunction(() => window.WS && WS.Core);
  await p.evaluate(() => WS.UI && WS.UI.set('full'));
  if (init) await p.evaluate(init, W3);
  return p;
}
const route = W3s => { const S = WS.Core.S; S.m.home = { lat: 12.2448, lng: 109.1950 }; S.m.pois = []; S.m.waypoints = W3s.map(([lat, lng]) => WS.Core.newWaypoint({ lat, lng, alt: 50 }, S.m)); WS.Core.changed({ fit: true }); };

const groups = {
  async load(b) {
    const p = await page(b);
    ok('программа открывается без ошибок', p.errs.length === 0, p.errs);
    ok('все модули на месте', await p.evaluate(() => ['Core', 'SimCore', 'Zones', 'LOS', 'IO', 'Gen', 'Maps', 'View3D', 'World', 'Sun', 'Geo'].filter(n => { try { return (0, eval)('typeof ' + n) === 'undefined'; } catch (e) { return true; } }).length === 0));
    ok('значок программы (favicon) подключён', await p.evaluate(() => !!document.querySelector('link[rel~=icon]')));
    await p.close();
  },
  async edit(b) {
    const p = await page(b, route);
    ok('маршрут из 3 точек', await p.evaluate(() => WS.Core.S.m.waypoints.length === 3));
    await p.evaluate(() => { WS.Core.snap(); WS.Core.S.m.waypoints.pop(); WS.Core.changed(); WS.Core.undo(); });
    ok('отмена действия возвращает точку', await p.evaluate(() => WS.Core.S.m.waypoints.length === 3));
    const st = await p.evaluate(() => WS.Core.stats());
    ok('длина и время маршрута считаются', st.dist > 500 && st.dist < 900 && st.time > 0, st);
    ok('проверка маршрута без ошибок', await p.evaluate(() => WS.Core.validate().filter(x => x.lvl === 'err').length === 0), await p.evaluate(() => WS.Core.validate()));
    await p.evaluate(() => { WS.Core.S.m.waypoints[1].alt = 900; WS.Core.changed(); });
    ok('проверка ловит слишком большую высоту', await p.evaluate(() => WS.Core.validate().some(x => x.lvl !== 'ok' && /высот/i.test(x.msg))));
    await p.evaluate(() => { WS.Core.S.m.waypoints[1].alt = 50; WS.Core.changed(); WS.map.setView(WS.Core.S.m.waypoints[1], 17, { animate: false }); }); await p.waitForTimeout(700);
    const c = await p.evaluate(() => { const m = WS.map, w = WS.Core.S.m.waypoints[1], q = m.latLngToContainerPoint(w), r = m.getContainer().getBoundingClientRect(); return { x: r.left + q.x, y: r.top + q.y, id: w.id, lat: w.lat }; });
    await p.mouse.click(c.x, c.y); await p.waitForTimeout(200);
    ok('клик по точке выбирает её', await p.evaluate(id => WS.Core.S.sel.has(id), c.id), await p.evaluate(c => { const e = document.elementFromPoint(c.x, c.y); return e && (e.className + ' ' + (e.parentElement && e.parentElement.className)); }, c));
    await p.mouse.move(c.x, c.y); await p.mouse.down(); await p.mouse.move(c.x + 30, c.y + 40, { steps: 5 }); await p.mouse.up(); await p.waitForTimeout(300);
    ok('перетаскивание двигает точку', await p.evaluate(lat => Math.abs(WS.Core.S.m.waypoints[1].lat - lat) > 1e-5, c.lat));
    await p.evaluate(() => { WS.Core.undo(); }); await p.waitForTimeout(200);
    ok('отмена перетаскивания', await p.evaluate(lat => Math.abs(WS.Core.S.m.waypoints[1].lat - lat) < 1e-9, c.lat));
    const c2 = await p.evaluate(() => { const m = WS.map, w = WS.Core.S.m.waypoints[1], q = m.latLngToContainerPoint(w), r = m.getContainer().getBoundingClientRect(); return { x: r.left + q.x, y: r.top + q.y }; });
    await p.mouse.click(c2.x, c2.y, { button: 'right' }); await p.waitForTimeout(200);
    ok('правый клик открывает меню точки', await p.evaluate(() => !document.getElementById('ctx').hidden));
    ok('без ошибок в консоли', p.errs.length === 0, p.errs);
    await p.close();
  },
  async params(b) {
    const p = await page(b, route);
    // a new point takes the parameters of the previous one
    const r = await p.evaluate(() => { const W = WS.Core.S.m.waypoints, L = W[W.length - 1]; Object.assign(L, { alt: 73, gimbal: -55, speed: 6, curve: 14, hm: 'custom', heading: 210, zoom: 2, photoTime: 3 }); WS.Core.changed(); return true; });
    const c = await p.evaluate(() => { const m = WS.map, q = m.latLngToContainerPoint([12.2490, 109.2030]), r = m.getContainer().getBoundingClientRect(); return { x: r.left + q.x, y: r.top + q.y }; });
    await p.evaluate(() => WS.map.setView([12.247, 109.2], 16, { animate: false })); await p.waitForTimeout(300);
    const c2 = await p.evaluate(() => { const r = WS.map.getContainer().getBoundingClientRect(); return { x: r.left + r.width * 0.62, y: r.top + r.height * 0.35 }; });
    await p.mouse.click(c2.x, c2.y); await p.waitForTimeout(300);
    const n = await p.evaluate(() => { const W = WS.Core.S.m.waypoints, w = W[W.length - 1]; return { n: W.length, alt: w.alt, gimbal: w.gimbal, speed: w.speed, curve: w.curve, hm: w.hm, heading: w.heading, zoom: w.zoom, photoTime: w.photoTime, actions: w.actions.length }; });
    n.at = await p.evaluate(c => { const e = document.elementFromPoint(c.x, c.y); return e && (e.tagName + '#' + e.id + '.' + e.className + ' < ' + (e.parentElement && (e.parentElement.id + '.' + e.parentElement.className)) + ' html:' + e.outerHTML.slice(0, 120)); }, c2); n.mode = await p.evaluate(() => WS.Core.S.mode);
    ok('новая точка — с параметрами предыдущей', n.n === 4 && n.alt === 73 && n.gimbal === -55 && n.speed === 6 && n.curve === 14 && n.hm === 'custom' && n.heading === 210 && n.zoom === 2 && n.photoTime === 3 && n.actions === 0, n);
    // heading slider on a point in «as in mission» mode
    await p.evaluate(() => { const W = WS.Core.S.m.waypoints; delete W[1].hm; WS.Core.S.sel.clear(); WS.Core.S.sel.add(W[1].id); WS.Core.changed(); }); await p.waitForTimeout(300);
    ok('ползунок курса есть', await p.evaluate(() => !!document.querySelector('#wHdR')));
    const u0 = await p.evaluate(() => WS.Core.S.undo.length);
    await p.evaluate(() => { const r = document.querySelector('#wHdR'); for (const v of [100, 120, 135]) { r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); } r.dispatchEvent(new Event('change', { bubbles: true })); }); await p.waitForTimeout(300);
    const h = await p.evaluate(() => { const w = WS.Core.S.m.waypoints[1]; return { hm: w.hm, heading: w.heading, eff: WS.Core.effHeading(1), field: document.querySelector('[data-k=heading]').value, undo: WS.Core.S.undo.length }; });
    ok('ползунок задаёт курс и переключает на «задать угол»', h.hm === 'custom' && h.heading === 135 && Math.round(h.eff) === 135 && +h.field === 135, h);
    ok('перетаскивание ползунка — один шаг отмены', h.undo - u0 === 1, { u0, u1: h.undo });
    await p.fill('[data-k=heading]', '271'); await p.press('[data-k=heading]', 'Enter'); await p.waitForTimeout(200);
    ok('точный ввод курса стрелками/числом', await p.evaluate(() => WS.Core.S.m.waypoints[1].heading === 271 && +document.querySelector('#wHdR').value === 271));
    ok('без ошибок в консоли', p.errs.length === 0, p.errs);
    await p.close();
  },
  async io(b) {
    const p = await page(b, route);
    const r = await p.evaluate(async () => {
      const W0 = WS.Core.S.m.waypoints.map(w => [w.lat, w.lng, w.alt]);
      const xml = await IO.djiFlyXML(); const m = IO.parseWPML(typeof xml === 'string' ? xml : xml.waylines || xml.template || '');
      const W1 = (m.waypoints || []).map(w => [w.lat, w.lng, w.alt]);
      return { n0: W0.length, n1: W1.length, d: Math.max(...W0.map((a, i) => W1[i] ? Math.abs(a[0] - W1[i][0]) + Math.abs(a[1] - W1[i][1]) + Math.abs(a[2] - W1[i][2]) / 1e5 : 1)) };
    });
    ok('DJI Fly: запись → чтение без потерь', r.n0 === r.n1 && r.d < 1e-6, r);
    const csv = await p.evaluate(() => { const t = IO.litchiCSV(); const m = IO.parseCSV(t); return { n: (m.waypoints || []).length, head: t.split('\n')[0].slice(0, 40) }; });
    ok('Litchi CSV: запись → чтение', csv.n === 3, csv);
    ok('без ошибок в консоли', p.errs.length === 0, p.errs);
    await p.close();
  },
  async sim(b) {
    const p = await page(b, route);
    await p.click('#simPlay'); await p.waitForTimeout(1200); await p.click('#simPlay');
    ok('симуляция двигает дрона', await p.evaluate(() => !!(WS.Sim.cur && WS.Sim.cur.d > 0)));
    { // «Смотреть на POI» turns the camera to it; leaving the POI the course swings smoothly (no jump, no loop)
      const r = await p.evaluate(() => { const C = WS.Core, S = C.S, W = S.m.waypoints; C.snap();
        S.m.settings.headingMode = 'custom'; W.forEach(w => { delete w.hm; w.heading = 0; w.poi = null; });
        S.m.pois = [{ id: 'tp', name: 'P', lat: 12.2475, lng: 109.1985, alt: 0 }];
        C.lookAt(W[0], 'tp'); C.lookAt(W[1], 'tp'); W[2].hm = 'auto'; C.changed();
        const warn0 = C.validate().some(x => /курс не «на точку интереса»/.test(x.msg));
        const tl = SimCore.build(() => ({ g: 0 })); let mx = 0, prev = null;
        for (let t = 0; t <= tl.T; t += 0.05) { const c = SimCore.at(tl, t); if (prev != null) mx = Math.max(mx, Math.abs(Geo.norm180(c.hd - prev))); prev = c.hd; }
        const hm = W[0].hm; W[0].hm = 'custom'; const warn1 = C.validate().some(x => /курс не «на точку интереса»/.test(x.msg));
        C.lookAt(W[0], null); const off = W[0].poi === null; C.undo(); return { hm, warn0, warn1, mx, off }; });
      ok('«Смотреть на POI» ставит курс на POI, плавный уход от POI', r.hm === 'poi' && !r.warn0 && r.warn1 && r.off && r.mx < 6, r);
    }
    const box = await p.evaluate(() => { const r = document.querySelector('#profCanvas').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
    const before = await p.evaluate(() => WS.Sim.cur && WS.Sim.cur.d);
    for (const f of [0.6, 0.75, 0.9]) { await p.mouse.move(box[0] + box[2] * f, box[1] + box[3] / 2); await p.waitForTimeout(150); }
    const after = await p.evaluate(() => WS.Sim.cur && WS.Sim.cur.d);
    ok('курсор над графиком ведёт дрона', after > before + 50, { before, after });
    // ▶ starts from the selected point; pause + ▶ resumes; another selected point → start from it
    await p.evaluate(() => { WS.Sim.stop(); const W = WS.Core.S.m.waypoints; WS.Core.S.sel.clear(); WS.Core.S.sel.add(W[1].id); WS.refresh(); }); await p.waitForTimeout(200);
    const dWp = await p.evaluate(() => { const tl = SimCore.build(); return tl.pts.find(q => q.wp === 1).d; });
    await p.click('#simPlay'); await p.waitForTimeout(150);
    const d1 = await p.evaluate(() => WS.Sim.cur.d);
    ok('▶ — полёт с выбранной точки', d1 >= dWp - 1 && d1 < dWp + 150, { d1, dWp });
    await p.waitForTimeout(500); await p.click('#simPlay'); const dp = await p.evaluate(() => WS.Sim.cur.d);
    await p.click('#simPlay'); await p.waitForTimeout(150); const d2 = await p.evaluate(() => WS.Sim.cur.d); await p.click('#simPlay');
    ok('пауза и ▶ — продолжение с того же места', d2 >= dp - 1, { dp, d2 });
    await p.evaluate(() => { const W = WS.Core.S.m.waypoints; WS.Core.S.sel.clear(); WS.Core.S.sel.add(W[0].id); WS.refresh(); }); await p.waitForTimeout(150);
    await p.click('#simPlay'); await p.waitForTimeout(120); const d3 = await p.evaluate(() => WS.Sim.cur.d); 
    const dWp0 = await p.evaluate(() => SimCore.build().pts.find(q => q.wp === 0).d);
    ok('выбрана другая точка — ▶ начинает с неё', Math.abs(d3 - dWp0) < 150 && d3 < dp, { d3, dWp0, dp });
    // a click on the profile while flying jumps there
    const pb = await p.evaluate(() => { const r = document.querySelector('#profCanvas').getBoundingClientRect(), pr = window.WS && document.querySelector('#profCanvas'); return [r.left, r.top, r.width, r.height]; });
    await p.mouse.click(pb[0] + pb[2] - 12, pb[1] + pb[3] / 2); await p.waitForTimeout(150);
    const d4 = await p.evaluate(() => ({ d: WS.Sim.cur.d, sel: WS.Core.wpIndex([...WS.Core.S.sel][0]), playing: WS.Sim.playing }));
    const dWp2 = await p.evaluate(() => SimCore.build().pts.find(q => q.wp === 2).d);
    ok('клик по графику во время полёта — переход к точке', d4.sel === 2 && d4.d >= dWp2 - 1, { ...d4, dWp2 });
    await p.evaluate(() => WS.Sim.stop());
    ok('без ошибок в консоли', p.errs.length === 0, p.errs);
    await p.close();
  },
  async ui(b) {
    const p = await page(b, route);
    await p.click('#colL'); await p.click('#colR'); await p.waitForTimeout(300);
    ok('боковые панели сворачиваются', await p.evaluate(() => document.body.classList.contains('lcol') && document.body.classList.contains('rcol')));
    await p.click('#colL'); await p.click('#colR');
    await p.evaluate(() => document.querySelector('#ltabs [data-tab=mission]').click());
    await p.selectOption('#sunFmtT', '12'); await p.fill('#sunTime', '5:30 pm'); await p.press('#sunTime', 'Enter'); await p.waitForTimeout(200);
    ok('окно солнца: 12-часовой формат', await p.evaluate(() => document.querySelector('#sunTime').value === '5:30 PM'));
    await p.click('#sunNow'); await p.selectOption('#sunFmtT', '24');
    ok('формат времени во всей программе', await p.evaluate(() => /^\d\d:\d\d$/.test(WS.Core.fmtTime(Date.now()))));
    await p.evaluate(() => document.querySelector('[data-cmd=settings]').click()); await p.waitForTimeout(200);
    ok('настройки открываются (ключи снимков, форматы)', await p.evaluate(() => !!document.querySelector('#airbusKey') && !!document.querySelector('#setFmtD')));
    ok('без ошибок в консоли', p.errs.length === 0, p.errs);
    await p.close();
  },
  async lang(b) {
    const p = await page(b, route);
    if (!(await p.evaluate(() => typeof I18N !== 'undefined'))) { ok('английский интерфейс есть', false); return p.close(); }
    await p.evaluate(() => I18N.set('en')); await p.waitForTimeout(600); await p.waitForFunction(() => window.WS && WS.Core); await p.evaluate(() => WS.UI && WS.UI.set('full')); await p.waitForTimeout(500);
    const cyr = await p.evaluate(() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const el = n.parentElement; if (!el || el.closest('script,style,.leaflet-control-attribution,#libList,.mname,input,textarea') || !el.offsetParent) continue; if (/[а-яё]/i.test(n.textContent)) out.push(n.textContent.trim().slice(0, 60)); } return out; });
    ok('английский: на экране нет русского текста', cyr.length <= 3, cyr.slice(0, 15));
    ok('английский: подписи вкладок', await p.evaluate(() => /Mission/i.test(document.querySelector('#ltabs').innerText)));
    for (const t of ['points', 'tools', 'check', 'mission']) { await p.evaluate(t => { const b = document.querySelector(`#ltabs [data-tab=${t}]`); b && b.click(); }, t); await p.waitForTimeout(150); }
    const cyr2 = await p.evaluate(() => { const out = []; document.querySelectorAll('#left, #right, #top, #bottom').forEach(r => { const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const el = n.parentElement; if (!el || el.closest('script,style,.mname,input,textarea,#libList') || !el.offsetParent) continue; if (/[а-яё]/i.test(n.textContent)) out.push(n.textContent.trim().slice(0, 50)); } }); return out; });
    ok('английский: во всех вкладках нет русского', cyr2.length <= 3, cyr2.slice(0, 20));
    await p.evaluate(() => I18N.set('ru')); await p.waitForTimeout(600); await p.waitForFunction(() => window.WS && WS.Core); await p.evaluate(() => WS.UI && WS.UI.set('full')); await p.waitForTimeout(300);
    ok('обратно на русский', await p.evaluate(() => /Миссия/.test(document.querySelector('#ltabs').innerText)));
    ok('без ошибок в консоли', p.errs.length === 0, p.errs);
    await p.close();
  },
  async log(b) {
    const p = await page(b, route);
    if (!(await p.evaluate(() => typeof FlightLog !== 'undefined'))) { ok('сравнение с полётом есть', false); return p.close(); }
    const r = await p.evaluate(() => {
      // a flown track: the plan shifted 6 m east, 3 m higher, plus a sample every second
      const G = WS.Core.pathGeometry(), pts = []; let t = 0;
      for (let i = 1; i < G.length; i++) for (let f = 0; f < 1; f += 0.1) { const a = G[i - 1], b = G[i], lat = a.lat + f * (b.lat - a.lat), lng = a.lng + f * (b.lng - a.lng); pts.push({ t: t += 1000, lat: lat + 6 / 111320, lng, alt: a.alt + f * (b.alt - a.alt) + 3 }); }
      const csv = 'time(millisecond),latitude,longitude,altitude_above_seaLevel(feet),height_above_takeoff(feet),isVideo\n' + pts.map((q, i) => `${q.t},${q.lat},${q.lng},0,${(q.alt / 0.3048).toFixed(2)},${i > 2 ? 1 : 0}`).join('\n');
      const tr = FlightLog.parse(csv, 'airdata.csv'); FlightLog.show(tr); return FlightLog.compare(tr);
    });
    ok('журнал Airdata CSV читается', r && r.n > 10, r);
    ok('отклонение в плане ≈ 6 м', r && Math.abs(r.hMax - 6) < 1.5, r);
    ok('отклонение по высоте ≈ 3 м', r && Math.abs(r.vMean - 3) < 1, r);
    const g = await p.evaluate(() => { const t = FlightLog.parse('<?xml version="1.0"?><gpx><trk><trkseg><trkpt lat="12.2462" lon="109.1960"><ele>10</ele><time>2026-11-01T10:00:00Z</time></trkpt><trkpt lat="12.2463" lon="109.1970"><ele>12</ele><time>2026-11-01T10:00:05Z</time></trkpt></trkseg></trk></gpx>', 'a.gpx'); return t && t.pts.length; });
    ok('трек GPX читается', g === 2, g);
    ok('без ошибок в консоли', p.errs.length === 0, p.errs);
    await p.close();
  },
  async perf(b) {
    const p = await page(b, () => { const S = WS.Core.S; S.m.home = { lat: 12.2448, lng: 109.1950 }; S.m.waypoints = []; for (let i = 0; i < 200; i++) S.m.waypoints.push(WS.Core.newWaypoint({ lat: 12.24 + (i % 20) * 0.0008, lng: 109.19 + Math.floor(i / 20) * 0.0008 + (i % 2) * 0.0002, alt: 40 + (i % 7) * 5 }, S.m)); WS.Core.changed({ fit: true }); });
    const t = await p.evaluate(async () => { const ts = []; for (let k = 0; k < 6; k++) { await new Promise(r => setTimeout(r, 250)); const t0 = performance.now(); WS.Core.S.m.waypoints[k].alt += 1; WS.Core.changed(); await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))); ts.push(performance.now() - t0); } ts.sort((a, b) => a - b); return ts[3]; });
    ok(`200 точек: правка точки и перерисовка < 100 мс (${Math.round(t)} мс)`, t < 100, t);
    const v = await p.evaluate(() => { const t0 = performance.now(); for (let k = 0; k < 5; k++) WS.Core.validate(); return (performance.now() - t0) / 5; });
    ok(`200 точек: проверка маршрута < 60 мс (${Math.round(v)} мс)`, v < 60, v);
    const s = await p.evaluate(() => { const t0 = performance.now(); const tl = SimCore.build(); for (let k = 0; k < 600; k++) SimCore.at(tl, tl.T * k / 600); return (performance.now() - t0); });
    ok(`200 точек: 600 кадров симуляции < 400 мс (${Math.round(s)} мс)`, s < 400, s);
    ok('без ошибок в консоли', p.errs.length === 0, p.errs);
    await p.close();
  },
};

// the loader inside the app bundle: picks a light update only when it is newer, for this shell and not failed
async function loaderTest() {
  console.log('\n• loader (лёгкие обновления)');
  const os = require('os'), tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-'))), // realpath: macOS /tmp → /private/tmp (require cache keys)
    ud = path.join(tmp, 'ud'), bundle = path.join(tmp, 'bundle');
  fs.mkdirSync(bundle); fs.mkdirSync(path.join(ud, 'live', '9.9.9'), { recursive: true });
  const src = path.join(__dirname, '..', 'desktop');
  fs.copyFileSync(path.join(src, 'main.js'), path.join(bundle, 'main.js'));
  fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ version: '2.9.0' }));
  fs.writeFileSync(path.join(bundle, 'core.js'), 'global.LOADED = "bundle";');
  const shell = +fs.readFileSync(path.join(src, 'main.js'), 'utf8').match(/const SHELL = (\d+)/)[1];
  const L = path.join(ud, 'live', '9.9.9');
  fs.writeFileSync(path.join(L, 'core.js'), 'global.LOADED = "live";'); fs.writeFileSync(path.join(ud, 'live', 'current'), '9.9.9');
  const origLoad = Module._load; Module._load = function (req, ...a) { if (req === 'electron') return { app: { getPath: () => ud } }; return origLoad.call(this, req, ...a); };
  const run = () => { delete require.cache[path.join(bundle, 'main.js')]; delete require.cache[path.join(bundle, 'core.js')]; delete require.cache[path.join(L, 'core.js')]; global.LOADED = null; require(path.join(bundle, 'main.js')); return global.LOADED; };
  try {
    fs.writeFileSync(path.join(L, 'manifest.json'), JSON.stringify({ version: '9.9.9', shell }));
    ok('новая лёгкая версия загружается', run() === 'live');
    ok('второй запуск без открытого окна → откат на встроенную', run() === 'bundle' && fs.existsSync(path.join(L, '.failed')));
    fs.rmSync(path.join(L, '.failed'), { force: true }); fs.rmSync(path.join(L, '.starting'), { force: true });
    fs.writeFileSync(path.join(L, 'manifest.json'), JSON.stringify({ version: '9.9.9', shell: shell + 1 }));
    ok('лёгкая версия для другой оболочки не загружается', run() === 'bundle');
    fs.writeFileSync(path.join(L, 'manifest.json'), JSON.stringify({ version: '2.8.0', shell }));
    ok('старая лёгкая версия не перекрывает новую встроенную', run() === 'bundle');
    fs.writeFileSync(path.join(L, 'manifest.json'), JSON.stringify({ version: '9.9.9', shell })); fs.writeFileSync(path.join(L, 'core.js'), 'throw new Error("broken")');
    ok('сломанная лёгкая версия → встроенная', run() === 'bundle' && fs.existsSync(path.join(L, '.failed')));
  } finally { Module._load = origLoad; fs.rmSync(tmp, { recursive: true, force: true }); }
}

(async () => {
  const srv = await serve();
  const b = await chromium.launch();
  try {
    for (const [k, fn] of Object.entries(groups)) { if (only && only !== k) continue; console.log('\n• ' + k); try { await fn(b); } catch (e) { ok(k + ': тест не завершился', false, e.message); } }
    if (!only || only === 'loader') await loaderTest();
  } finally { await b.close(); srv.close(); }
  console.log(`\nИтого: ${pass} ✓, ${fail} ✗${fail ? '\nНе прошли: ' + fails.join('; ') : ''}`);
  process.exit(fail ? 1 : 0);
})();
