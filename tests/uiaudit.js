// Waypoint Studio — interface audit in both languages.
// For every screen state (tabs, panels, menus, dialogs, 3D) it reports:
//   • clipped / cut text (text wider than its box, ellipsis, text outside a clipping parent)
//   • text covered by another element (what the user sees on top is not the text's own element)
//   • text left in Russian while the interface is English (texts, tooltips, «?» help, placeholders)
//   • every «?» help text and tooltip, for review
// Run: node tests/uiaudit.js [--lang=ru|en] [--size=1440x900] [--shots=dir]
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'app'), PORT = 8795;
const arg = k => (process.argv.find(a => a.startsWith('--' + k + '=')) || '').split('=')[1];
const LANGS = arg('lang') ? [arg('lang')] : ['ru', 'en'];
const SIZES = (arg('size') || '1440x900,1280x800').split(',').map(s => s.split('x').map(Number));
const SHOTS = arg('shots'); if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const OUT = arg('out') || path.join(__dirname, 'uiaudit.json');

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
  return new Promise(res => { const s = http.createServer((q, r) => {
    let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html';
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
  }).listen(PORT, () => res(s)); });
}

// runs inside the page: inspects everything visible inside `scope` (CSS selector list; default: whole page)
function inspect(scopeSel) {
  const CYR = /[А-Яа-яЁё]/;
  const SKIPTXT = '.mname,#mName,.libname,.nolang,.leaflet-control-attribution,.leaflet-tile-pane,script,style,.cesium-widget-credits,.cesium-credit-lightbox-overlay';
  const scopes = scopeSel ? [...document.querySelectorAll(scopeSel)] : [document.body];
  const vis = el => { if (!el.getClientRects().length) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05; };
  const visDeep = el => { for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false; } return true; };
  const name = el => { let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; else if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.'); const p = el.closest('[id]'); if (p && p !== el) s = '#' + p.id + ' › ' + s; return s; };
  const clipAnc = el => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (/(hidden|auto|scroll|clip)/.test(cs.overflowX + cs.overflowY)) return e; } return null; };
  const out = { clip: [], covered: [], cyr: [], tips: [], texts: [] };
  const seen = new Set();
  for (const scope of scopes) {
    if (!scope || !visDeep(scope)) continue;
    const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) {
      const txt = n.nodeValue.replace(/\s+/g, ' ').trim(); if (!txt) continue;
      const el = n.parentElement; if (!el || el.closest(SKIPTXT) || !visDeep(el)) continue;
      { const d = el.closest('details:not([open])'); if (d && !el.closest('summary')) continue; } // inside a collapsed section: not shown
      if (el.closest('select') && el.tagName === 'OPTION') { if (CYR.test(txt) && document.documentElement.lang === 'en') out.cyr.push({ where: name(el.closest('select')), text: txt, kind: 'option' }); continue; }
      const r = document.createRange(); r.selectNodeContents(n); const rects = [...r.getClientRects()].filter(q => q.width > 1 && q.height > 1);
      if (!rects.length) continue;
      if (CYR.test(txt) && document.documentElement.lang === 'en') out.cyr.push({ where: name(el), text: txt.slice(0, 160), kind: 'text' });
      out.texts.push(txt);
      // 1) own box too small (text cut or ellipsis)
      const cs = getComputedStyle(el);
      const key = name(el) + '|' + txt.slice(0, 40); if (seen.has(key)) continue; seen.add(key);
      if ((el.scrollWidth > el.clientWidth + 1 && /(hidden|clip|auto|scroll)/.test(cs.overflowX)) || (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1))
        out.clip.push({ where: name(el), text: txt.slice(0, 120), why: `шире блока ${el.scrollWidth}>${el.clientWidth}${cs.textOverflow === 'ellipsis' ? ' (…)' : ''}` });
      else if (el.scrollHeight > el.clientHeight + 2 && /(hidden|clip)/.test(cs.overflowY) && el.clientHeight > 0)
        out.clip.push({ where: name(el), text: txt.slice(0, 120), why: `выше блока ${el.scrollHeight}>${el.clientHeight}` });
      // 2) text outside a clipping parent (cut by a panel edge)
      const ca = clipAnc(el);
      if (ca) { const cr = ca.getBoundingClientRect(); const csA = getComputedStyle(ca);
        const scrollY = /(auto|scroll)/.test(csA.overflowY), scrollX = /(auto|scroll)/.test(csA.overflowX);
        for (const q of rects) {
          const outX = q.left < cr.left - 1 || q.right > cr.right + 1, outY = q.top < cr.top - 1 || q.bottom > cr.bottom + 1;
          // in a scrolling panel a line partly out of view vertically is normal (scroll); horizontally it's a cut
          if ((outX && !scrollX) || (outY && !scrollY && !(q.bottom < cr.top || q.top > cr.bottom))) { if (!(outY && (q.bottom <= cr.top || q.top >= cr.bottom))) { out.clip.push({ where: name(el), text: txt.slice(0, 120), why: `обрезано краем ${name(ca)}` }); break; } }
        } }
      // visible part of the line: inside every clipping / scrolling ancestor (text scrolled out of view is not a defect)
      const visRect = q => { let l = q.left, t = q.top, r2 = q.right, b2 = q.bottom;
        for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const c = getComputedStyle(e); if (/(hidden|auto|scroll|clip)/.test(c.overflowX + c.overflowY)) { const k = e.getBoundingClientRect(); l = Math.max(l, k.left); t = Math.max(t, k.top); r2 = Math.min(r2, k.right); b2 = Math.min(b2, k.bottom); } }
        return r2 - l > 2 && b2 - t > 2 ? { left: l, top: t, right: r2, bottom: b2, width: r2 - l, height: b2 - t } : null; };
      // 3) covered: the element on top at the centre of each line is not the text's element
      const pe = el.style.getPropertyValue('pointer-events'), pep = el.style.getPropertyPriority('pointer-events');
      el.style.setProperty('pointer-events', 'auto', 'important');
      for (const q0 of rects) { const q = visRect(q0); if (!q) continue;
        const x = Math.min(innerWidth - 1, Math.max(0, q.left + Math.min(q.width / 2, 12))), x2 = Math.min(innerWidth - 1, q.right - Math.min(q.width / 2, 4)), y = q.top + q.height / 2;
        if (y < 0 || y > innerHeight || q.right < 0 || q.left > innerWidth) continue;
        for (const xx of [x, x2]) {
          const top = document.elementFromPoint(xx, y); if (!top) continue;
          if (top === el || el.contains(top) || top.contains(el)) continue;
          // the label of a control (<label> wraps input) or tooltip box over text after hovering is fine
          if (top.closest('#tipBox')) continue;
          // a sticky header of the same scrolling panel over a line that has scrolled under it — normal scrolling
          { let st = null; for (let e = top; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).position === 'sticky') { st = e; break; }
            if (st && st.parentElement && st.parentElement.contains(el)) continue; }
          // in a scrolling panel the line may simply be scrolled under the header of the same panel: still a real overlap
          out.covered.push({ where: name(el), text: txt.slice(0, 100), by: name(top) + (top.textContent ? ' «' + top.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) + '»' : '') });
          break;
        }
        break;
      }
      if (pe) el.style.setProperty('pointer-events', pe, pep); else el.style.removeProperty('pointer-events');
    }
    // selects: the chosen value must fit (native selects cut it silently)
    const cv = document.createElement('canvas').getContext('2d');
    scope.querySelectorAll('select').forEach(sel => {
      if (!vis(sel) || !visDeep(sel) || sel.closest('.nolang')) return; const o = sel.options[sel.selectedIndex]; if (!o) return;
      const cs = getComputedStyle(sel); cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const need = cv.measureText(o.text).width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 18;
      if (need > sel.clientWidth + 1) out.clip.push({ where: name(sel), text: o.text, why: `список: текст ${Math.round(need)} > поле ${sel.clientWidth}` });
    });
    // placeholders must fit the empty field
    scope.querySelectorAll('input[placeholder]').forEach(inp => {
      if (!vis(inp) || !visDeep(inp) || inp.value || inp.type === 'number' && !inp.placeholder) return;
      const cs = getComputedStyle(inp); cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const need = cv.measureText(inp.placeholder).width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      if (need > inp.clientWidth + 1) out.clip.push({ where: name(inp), text: inp.placeholder, why: `подсказка в поле ${Math.round(need)} > ${inp.clientWidth}` });
    });
    // tooltips and help, placeholders, button values
    scope.querySelectorAll('[data-tip],[title],[placeholder],[aria-label]').forEach(el => {
      if (el.closest('.nolang,.leaflet-control-attribution') || !vis(el)) return;
      for (const a of ['data-tip', 'title', 'placeholder', 'aria-label']) {
        const v = el.getAttribute(a); if (!v) continue;
        out.tips.push({ where: name(el), attr: a, label: (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60), text: v });
        if (CYR.test(v) && document.documentElement.lang === 'en') out.cyr.push({ where: name(el), text: v.slice(0, 160), kind: a });
      }
    });
  }
  return out;
}

(async () => {
  const srv = await serve();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const report = [];
  for (const lang of LANGS) for (const [W, H] of SIZES) {
    const p = await b.newPage({ viewport: { width: W, height: H } });
    const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push('console: ' + m.text()); });
    await p.route(u => !u.href.startsWith('http://localhost:' + PORT), r => r.fulfill({ status: 200, body: '' }));
    await p.addInitScript(l => { try { localStorage.setItem('ws.tourDone', 'true'); localStorage.setItem('ws.lang', JSON.stringify(l)); } catch (e) { /* ignore */ } }, lang);
    await p.goto(`http://localhost:${PORT}/index.html`); await p.waitForFunction(() => window.WS && WS.Core);
    // a realistic mission: take-off, 6 points, 2 POIs, actions, a point looking at a POI
    await p.evaluate(() => { const C = WS.Core, S = C.S;
      S.m.name = 'Audit route'; S.m.home = { lat: 12.2448, lng: 109.1950 };
      S.m.pois = [{ id: 'pa', name: 'POI 1', lat: 12.2475, lng: 109.1985, alt: 10 }, { id: 'pb', name: 'POI 2', lat: 12.2440, lng: 109.2030, alt: 0 }];
      const P = [[12.2462, 109.1960], [12.2462, 109.2010], [12.2475, 109.2000], [12.2480, 109.1970], [12.2455, 109.1990], [12.2450, 109.2040]];
      S.m.waypoints = P.map(([lat, lng], i) => C.newWaypoint({ lat, lng, alt: 40 + i * 5 }, S.m));
      S.m.waypoints[1].actions = [{ type: 1, param: 0 }, { type: 4, param: 90 }]; C.lookAt(S.m.waypoints[2], 'pa'); S.m.waypoints[3].actions = [{ type: 2, param: 0 }];
      C.changed({ fit: true }); });
    await p.waitForTimeout(400);
    const states = [];
    const snap = async (state, scope) => {
      await p.waitForTimeout(250);
      const r = await p.evaluate(inspect, scope || null);
      states.push({ state, ...r });
      if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${lang}_${W}_${states.length.toString().padStart(2, '0')}_${state.replace(/[^\wа-я]+/gi, '_').slice(0, 40)}.png`) });
    };
    const click = async sel => { const el = await p.$(sel); if (el && await el.isVisible()) { await el.click(); await p.waitForTimeout(200); return true; } return false; };
    const esc = async () => { await p.keyboard.press('Escape'); await p.mouse.click(5, H - 5).catch(() => {}); await p.waitForTimeout(150); await p.evaluate(() => { const c = document.getElementById('ctx'); if (c) c.hidden = true; document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); }); };
    const tabs = ['mission', 'points', 'tools', 'library', 'check'];
    for (const ui of ['simple', 'full']) {
      await p.evaluate(u => WS.UI.set(u), ui); await p.waitForTimeout(300);
      await p.evaluate(() => { WS.Core.S.sel.clear(); WS.refresh && WS.refresh(); });
      for (const t of tabs) { if (await click(`#ltabs [data-tab=${t}]`)) await snap(`${ui}: вкладка ${t}`); }
      // expand every collapsible section in the left panel (details / cards), then scroll through the panel
      await click('#ltabs [data-tab=mission]');
      await p.evaluate(() => document.querySelectorAll('#left details').forEach(d => d.open = true));
      for (const t of tabs) { if (!(await click(`#ltabs [data-tab=${t}]`))) continue; await p.evaluate(() => document.querySelectorAll('#left details').forEach(d => d.open = true));
        const hgt = await p.evaluate(t => { const s = document.getElementById('tab-' + t); return s ? s.scrollHeight : 0; }, t);
        for (let y = 0; y < hgt; y += H - 200) { await p.evaluate(([t, y]) => { const s = document.getElementById('tab-' + t); s.scrollTop = y; const l = document.getElementById('left'); if (l) l.scrollTop = y; }, [t, y]); await snap(`${ui}: вкладка ${t} (развёрнуто, прокрутка ${y})`, '#left'); } }
      // one point selected → right panel (inspector), all sections open, scrolled
      await p.evaluate(() => { const S = WS.Core.S; S.sel.clear(); S.sel.add(S.m.waypoints[1].id); WS.refresh(); });
      await p.evaluate(() => document.querySelectorAll('#right details').forEach(d => d.open = true));
      { const hgt = await p.evaluate(() => document.getElementById('insp').scrollHeight);
        for (let y = 0; y < hgt; y += H - 200) { await p.evaluate(y => { const r = document.getElementById('right'); r.scrollTop = y; document.getElementById('insp').scrollTop = y; }, y); await snap(`${ui}: точка 2 выбрана (прокрутка ${y})`, '#right,#top,#bottom,.qcam,#qcam'); } }
      await p.evaluate(() => { const S = WS.Core.S; S.sel.clear(); S.sel.add(S.m.waypoints[2].id); WS.refresh(); document.querySelectorAll('#right details').forEach(d => d.open = true); });
      await snap(`${ui}: точка 3 (на POI)`, '#right');
      await p.evaluate(() => { const S = WS.Core.S; S.sel.clear(); S.m.waypoints.slice(0, 4).forEach(w => S.sel.add(w.id)); WS.refresh(); document.querySelectorAll('#right details').forEach(d => d.open = true); });
      await snap(`${ui}: выделено 4 точки`, '#right,#qcam,.qcam');
      await p.evaluate(() => { const S = WS.Core.S; S.sel.clear(); S.selPoi = 'pa'; WS.refresh(); });
      await snap(`${ui}: выбран POI`, '#right');
      await p.evaluate(() => { const S = WS.Core.S; S.selPoi = null; S.selHome = true; WS.refresh(); });
      await snap(`${ui}: выбран взлёт`, '#right');
      await p.evaluate(() => { const S = WS.Core.S; S.selHome = false; S.sel.clear(); WS.refresh(); });
      await snap(`${ui}: ничего не выбрано`, '#right,#top,#bottom');
    }
    // full UI for menus / dialogs
    await p.evaluate(() => WS.UI.set('full'));
    for (const m of await p.$$('#top .menu > .btn')) { if (!(await m.isVisible())) continue; await m.click(); await p.waitForTimeout(250); await snap('меню ' + (await m.textContent()).trim(), '#top .menu .drop'); await esc(); }
    for (const c of ['settings', 'help']) { await p.evaluate(c => document.querySelector(`[data-cmd=${c}]`).click(), c); await p.waitForTimeout(400);
      const hgt = await p.evaluate(() => { const b = document.querySelector('#modal .box'); return b ? b.scrollHeight : 0; });
      for (let y = 0; y < hgt; y += H - 250) { await p.evaluate(y => { const b = document.querySelector('#modal .box'); if (b) b.scrollTop = y; const mb = document.getElementById('modalBody'); if (mb) mb.scrollTop = y; }, y); await snap(`диалог ${c} (прокрутка ${y})`, '#modal'); }
      await p.evaluate(() => { const x = document.querySelector('#modal [data-close]'); if (x) x.click(); }); await p.waitForTimeout(200); }
    await p.evaluate(() => FlightLog.openDialog()); await p.waitForTimeout(300); await snap('диалог журнала полёта', '#modal');
    await p.evaluate(() => { const x = document.querySelector('#modal [data-close]'); if (x) x.click(); });
    // context menus: map, point, POI, take-off; open every submenu
    const pt = async ll => p.evaluate(ll => { const q = WS.map.latLngToContainerPoint(ll), r = document.getElementById('map').getBoundingClientRect(); return [r.left + q.x, r.top + q.y]; }, ll);
    const menus = [['карта', { lat: 12.2470, lng: 109.2040 }], ['точка', { lat: 12.2462, lng: 109.2010 }], ['POI', { lat: 12.2475, lng: 109.1985 }], ['взлёт', { lat: 12.2448, lng: 109.1950 }]];
    for (const [nm, ll] of menus) {
      const [x, y] = await pt(ll); await p.mouse.click(x, y, { button: 'right' }); await p.waitForTimeout(300);
      await snap('контекстное меню: ' + nm, '#ctx');
      const subs = await p.$$('#ctx .ci.has > button');
      for (let i = 0; i < subs.length; i++) { const s = (await p.$$('#ctx .ci.has > button'))[i]; if (!s || !(await s.isVisible())) continue; await s.hover(); await p.waitForTimeout(250); await snap(`контекстное меню: ${nm} › подменю ${i + 1}`, '#ctx'); }
      await esc();
    }
    // simulation running: bubble, OSD, telemetry
    await p.evaluate(() => WS.Sim.play && WS.Sim.play()); await p.waitForTimeout(1500); await p.evaluate(() => WS.Sim.pause && WS.Sim.pause());
    await snap('симуляция на паузе', null);
    await p.evaluate(() => WS.Sim.stop && WS.Sim.stop());
    // 3D
    try {
      await p.evaluate(() => View3D.open()); await p.waitForTimeout(5000);
      await snap('3D', '#v3d');
      await p.evaluate(() => View3D.seek(0.4)); await p.waitForTimeout(500); await snap('3D полёт', '#v3d');
      await p.evaluate(() => View3D.close());
    } catch (e) { errs.push('3D: ' + e.message); }
    // light theme, simple mode
    await p.evaluate(() => { WS.UI.set('simple'); document.body.classList.add('light'); }); await snap('светлая тема, упрощённый', null);
    await p.evaluate(() => document.body.classList.remove('light'));
    report.push({ lang, size: `${W}x${H}`, errs, states });
    await p.close();
  }
  await b.close(); srv.close();
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  // short summary
  for (const r of report) {
    const uniq = k => { const m = new Map(); r.states.forEach(s => s[k].forEach(x => { const id = x.where + '|' + x.text; if (!m.has(id)) m.set(id, Object.assign({ state: s.state }, x)); })); return [...m.values()]; };
    const clip = uniq('clip'), cov = uniq('covered'), cyr = uniq('cyr');
    console.log(`\n=== ${r.lang} ${r.size}: обрезано ${clip.length}, перекрыто ${cov.length}, кириллица в EN ${cyr.length}, ошибок ${r.errs.length}`);
    r.errs.slice(0, 10).forEach(e => console.log('  ERR', e.slice(0, 200)));
  }
})();
