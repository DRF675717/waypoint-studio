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
    const box = await p.evaluate(() => { const r = document.querySelector('#profCanvas').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
    const before = await p.evaluate(() => WS.Sim.cur && WS.Sim.cur.d);
    for (const f of [0.6, 0.75, 0.9]) { await p.mouse.move(box[0] + box[2] * f, box[1] + box[3] / 2); await p.waitForTimeout(150); }
    const after = await p.evaluate(() => WS.Sim.cur && WS.Sim.cur.d);
    ok('курсор над графиком ведёт дрона', after > before + 50, { before, after });
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
    await p.evaluate(() => I18N.set('en')); await p.waitForTimeout(400);
    const cyr = await p.evaluate(() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const el = n.parentElement; if (!el || el.closest('script,style,.leaflet-control-attribution,#libList,.mname,input,textarea') || !el.offsetParent) continue; if (/[а-яё]/i.test(n.textContent)) out.push(n.textContent.trim().slice(0, 60)); } return out; });
    ok('английский: на экране нет русского текста', cyr.length <= 3, cyr.slice(0, 15));
    ok('английский: подписи вкладок', await p.evaluate(() => /Mission/i.test(document.querySelector('#ltabs').innerText)));
    await p.evaluate(() => I18N.set('ru')); await p.waitForTimeout(300);
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
      G.forEach((g, i) => { if (i % 2) return; pts.push({ t: t += 1000, lat: g.lat, lng: g.lng + 6 / (111320 * Math.cos(g.lat * Math.PI / 180)), alt: g.alt + 3 }); });
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
    const t = await p.evaluate(() => { const t0 = performance.now(); for (let k = 0; k < 5; k++) { WS.Core.S.m.waypoints[k].alt += 1; WS.Core.changed(); } return (performance.now() - t0) / 5; });
    ok(`200 точек: перерисовка после правки < 150 мс (${Math.round(t)} мс)`, t < 150, t);
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
  const os = require('os'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-')), ud = path.join(tmp, 'ud'), bundle = path.join(tmp, 'bundle');
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
    fs.rmSync(path.join(L, '.failed')); fs.rmSync(path.join(L, '.starting'), { force: true });
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
