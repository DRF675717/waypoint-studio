// UI: map, panels, inspector, profile, simulation, dialogs
(() => {
  const { S } = Core;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const r1 = n => Math.round(n * 10) / 10;
  const fmtT = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  const fmtD = d => d >= 1000 ? (d / 1000).toFixed(2) + ' км' : Math.round(d) + ' м';
  const escH = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

  function toast(msg, cls = '', ms = 3500, action) {
    const d = document.createElement('div'); d.className = cls; d.textContent = msg;
    if (action) { const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = action.label; b.onclick = () => { d.remove(); action.fn(); }; d.appendChild(b); d.classList.add('act'); }
    $('#toast').appendChild(d);
    setTimeout(() => d.remove(), ms);
  }
  window.toast = toast;
  // ---- help tips: small (?) circles, tooltip on hover ----
  const tip = t => `<i class="hlp" data-tip="${escH(t)}">?</i>`;
  const tipBox = document.createElement('div'); tipBox.id = 'tipBox'; tipBox.hidden = true; document.body.appendChild(tipBox);
  document.addEventListener('mouseover', e => {
    const h = e.target.closest && e.target.closest('.hlp'); if (!h) return;
    tipBox.innerHTML = escH(h.dataset.tip).replace(/\n/g, '<br>'); tipBox.hidden = false;
    const r = h.getBoundingClientRect(), w = tipBox.offsetWidth, ht = tipBox.offsetHeight;
    let x = r.left + r.width / 2 - w / 2; x = Math.max(8, Math.min(innerWidth - w - 8, x));
    let y = r.bottom + 8; if (y + ht > innerHeight - 8) y = r.top - ht - 8;
    Object.assign(tipBox.style, { left: x + 'px', top: y + 'px' });
  });
  document.addEventListener('mouseout', e => { if (e.target.closest && e.target.closest('.hlp')) tipBox.hidden = true; });
  document.addEventListener('click', e => { const h = e.target.closest && e.target.closest('.hlp'); if (h) { e.preventDefault(); e.stopPropagation(); } }, true);

  // =================== MAP ===================
  const view = Core.store.get('ws.view', { c: [12.2388, 109.1967], z: 15 });
  const map = L.map('map', { zoomControl: true, boxZoom: false, doubleClickZoom: false, maxZoom: 22, zoomSnap: 0.5 }).setView(view.c, view.z);
  L.control.scale({ imperial: false }).addTo(map);
  map.on('moveend', () => Core.store.set('ws.view', { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() }));
  let baseLayer = null, baseId = Core.store.get('ws.base', 'esri-sat'), layCtlReady = false, imgInfoUpd = null;
  function setBase(id) {
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = Maps.makeLayer(id).addTo(map); baseLayer.bringToBack && baseLayer.bringToBack();
    baseId = id; Core.store.set('ws.base', id); if (imgInfoUpd) setTimeout(imgInfoUpd, 0);
    fillLayerSel(); if (typeof renderLayList === 'function' && layCtlReady) renderLayList();
  }
  function fillLayerSel() {
    const sel = $('#layerSel'); const list = Maps.list();
    sel.innerHTML = Object.entries(list).map(([k, v]) => `<option value="${k}" ${k === baseId ? 'selected' : ''}>${v.name}</option>`).join('');
    if (!list[baseId]) sel.value = 'esri-sat';
  }
  $('#layerSel').onchange = e => setBase(e.target.value);
  setBase(Maps.list()[baseId] ? baseId : 'esri-sat');
  Maps.loadGoogle().then(ok => {
    if (ok) { if (baseId === 'esri-sat' && !Core.store.get('ws.baseChosen')) baseId = 'g-hybrid'; setBase(Maps.google[baseId] || Maps.free[baseId] ? baseId : 'g-hybrid'); toast('Google Maps подключены', 'ok'); }
    else if (Maps.key()) toast(Maps.googleError || 'Google Maps не загрузились — используются свободные карты', 'err', 6000);
  });
  function gStatus() { const el = $('#gStatus'); if (!el) return; el.className = 'gst ' + (Maps.googleReady && !Maps.googleError ? 'ok' : Maps.key() ? 'bad' : ''); el.textContent = Maps.googleReady && !Maps.googleError ? 'Google ✓' : Maps.key() ? 'Google ✕' : 'Без Google'; el.title = Maps.googleError || (Maps.googleReady ? 'Google Maps подключены' : 'Нажмите, чтобы указать ключ API'); }
  Maps.loadGoogle().then(() => { gStatus(); renderLayList(); }); setTimeout(gStatus, 16000);
  Core.on('google', ok => { gStatus(); renderLayList(); if (!ok) { toast(Maps.googleError, 'err', 8000); setBase('esri-sat'); } });
  $('#layerSel').addEventListener('change', () => Core.store.set('ws.baseChosen', true));

  // ---- map type switcher (on the map) ----
  const isMobile = () => innerWidth <= 1000;
  const LayerCtl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const d = L.DomUtil.create('div', 'laysw');
      L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d);
      d.innerHTML = '<button class="laybtn" title="Тип карты"></button><div class="laylist"></div>';
      d.querySelector('.laybtn').onclick = e => { L.DomEvent.stop(e); d.classList.toggle('open'); renderLayList(); };
      d.querySelector('.laylist').onclick = e => { L.DomEvent.stop(e); const b = e.target.closest('[data-l]'); if (!b) return; d.classList.remove('open'); const id = b.dataset.l; setTimeout(() => { setBase(id); Core.store.set('ws.baseChosen', true); }, 0); };
      return d;
    },
  });
  const layCtl = new LayerCtl().addTo(map);
  // ---- Vietnam no-fly / restricted zones toggle (official MoD map) ----
  const ZoneCtl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const d = L.DomUtil.create('div', 'zonesw');
      L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d);
      d.innerHTML = `<button id="zonesBtn" class="laybtn"><i>⛔</i><span>Геозоны</span></button>
        <div id="zonesLegend" class="zleg" hidden><div><i style="background:#ef4444"></i>Запрет полётов</div><div><i style="background:#f0a742"></i>Ограничение / нужно разрешение</div><div><i style="background:#facc15"></i>Зона внимания (аэродром)</div><small id="zonesSrc"></small><button class="btn sm" id="geoTravelBtn">🌍 Зоны в другой стране</button><button class="btn sm" id="geoSrcBtn">⚙ Источники и обновления</button></div>`;
      d.querySelector('#zonesBtn').onclick = e => { L.DomEvent.stop(e); if (!Zones.available) return toast('Геозоны доступны в программе Waypoint Studio для macOS', 'err', 6000); Zones.setOn(!Zones.on); toast(Zones.on ? 'Показаны геозоны: красные — запрет, оранжевые — ограничение, жёлтые — зоны внимания. Подсказка — при наведении курсора' : 'Геозоны скрыты (проверка маршрута по зонам продолжает работать)', '', 5000); };
      d.querySelector('#geoSrcBtn').onclick = e => { L.DomEvent.stop(e); World.openDialog(toast); };
      d.querySelector('#geoTravelBtn').onclick = e => { L.DomEvent.stop(e); World.openTravel(toast, map); };
      const upd = () => { const el = d.querySelector('#zonesSrc'), c = map.getCenter(), bb = [c.lat, c.lng, c.lat, c.lng]; el.textContent = 'Здесь: ' + (['vn', 'faa', 'navcan', 'airports', 'openaip', 'import'].filter(k => World.active(k, bb) && (k !== 'import')).map(k => World.SRC[k].name.split(' — ')[k === 'airports' || k === 'openaip' ? 1 : 0]).join(', ') || 'нет источников') + ' · с 8–9-го масштаба'; };
      map.on('moveend', upd); Core.on('geoSources', upd); setTimeout(upd, 0);
      return d;
    },
  });
  new ZoneCtl().addTo(map);
  map.on('zoomend', () => { if (sunShow) renderSun(); });
  // map buttons: 3D view and «back to the route»
  const MapBtns = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const d = L.DomUtil.create('div', 'mapbtns'); L.DomEvent.disableClickPropagation(d);
      d.innerHTML = `<button class="b3d" data-mb="3d" title="Открыть 3D-вид маршрута (рельеф, здания, полёт камеры)">3D</button><button data-mb="fit" title="Показать весь маршрут"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 15 L6 5 L14 4 L16 13 Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="4" cy="15" r="2.2" fill="#22c7ff" stroke="currentColor" stroke-width="1"/><circle cx="6" cy="5" r="2.2" fill="#22c7ff" stroke="currentColor" stroke-width="1"/><circle cx="14" cy="4" r="2.2" fill="#22c7ff" stroke="currentColor" stroke-width="1"/><circle cx="16" cy="13" r="2.2" fill="#22c7ff" stroke="currentColor" stroke-width="1"/></svg></button><button data-mb="full" title="Во весь экран: только карта и управление полётом (Esc — выйти)">⛶</button><button data-mb="ruler" title="Линейка: измерить расстояние и направление по карте (клики по карте, Esc — закончить)">📏</button>`;
      d.onclick = e => { const b = e.target.closest('[data-mb]'); if (!b) return; if (b.dataset.mb === '3d') cmd('view3d'); else if (b.dataset.mb === 'full') FullView.toggle(); else if (b.dataset.mb === 'ruler') Ruler.toggle(b); else { if (S.m.waypoints.length || S.m.home) fit(); else toast('Маршрут пока пуст'); } };
      return d;
    },
  });
  new MapBtns().addTo(map);
  // ---- full-screen view of the map / 3D flight (any mode): panels hidden, only the view and the flight controls ----
  const FullView = (() => {
    let on = false;
    function set(v) {
      on = !!v; document.body.classList.toggle('fullview', on);
      try {
        if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
        if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      } catch (e) { /* the window simply fills itself */ }
      document.querySelectorAll('[data-mb=full], #v3full').forEach(b => { b.classList.toggle('on', on); b.title = on ? 'Выйти из полноэкранного режима (Esc)' : 'Во весь экран: только карта и управление полётом (Esc — выйти)'; });
      setTimeout(() => { map.invalidateSize(); window.dispatchEvent(new Event('resize')); }, 120);
      if (on) toast('Полноэкранный просмотр. Выйти — Esc или кнопка ⛶', '', 3500);
    }
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && on) set(false); });
    document.addEventListener('keydown', e => { if (on && e.key === 'Escape' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.stopImmediatePropagation(); e.preventDefault(); set(false); } }, true);
    return { toggle: () => set(!on), set, get on() { return on; } };
  })();
  window.WSFull = FullView;
  // ---- collapsible side panels (tabs on the map edges) ----
  const Panels = (() => {
    function apply() {
      const l = document.body.classList.contains('lcol'), r = document.body.classList.contains('rcol');
      $('#colL').textContent = l ? '›' : '‹'; $('#colL').title = l ? 'Показать левую панель' : 'Свернуть левую панель — больше места для карты';
      $('#colR').textContent = r ? '‹' : '›'; $('#colR').title = r ? 'Показать правую панель' : 'Свернуть правую панель — больше места для карты';
      Core.store.set('ws.cols', { l, r });
      setTimeout(() => { map.invalidateSize(); window.dispatchEvent(new Event('resize')); }, 30);
    }
    function toggle(side) { document.body.classList.toggle(side === 'l' ? 'lcol' : 'rcol'); apply(); }
    const st = Core.store.get('ws.cols', { l: false, r: false });
    document.body.classList.toggle('lcol', !!st.l); document.body.classList.toggle('rcol', !!st.r); apply();
    $('#colL').onclick = () => toggle('l'); $('#colR').onclick = () => toggle('r');
    document.addEventListener('keydown', e => { if (e.altKey && (e.ctrlKey || e.metaKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); toggle(e.key === 'ArrowLeft' ? 'l' : 'r'); } }); // Ctrl/⌘+⌥+← / →
    return { toggle, show(side) { document.body.classList.remove(side === 'l' ? 'lcol' : 'rcol'); apply(); } };
  })();
  window.WSPanels = Panels;
  // ---- ruler: measure distances and bearings on the map ----
  const Ruler = (() => {
    let on = false, pts = [], lay = L.layerGroup().addTo(map), btn = null;
    const fmt = m => m >= 1000 ? (m / 1000).toFixed(2) + ' км' : Math.round(m) + ' м';
    function draw() {
      lay.clearLayers(); if (!pts.length) return;
      L.polyline(pts, { color: '#fff', weight: 5, opacity: .7, interactive: false }).addTo(lay);
      L.polyline(pts, { color: '#ff7a1a', weight: 2.5, dashArray: '6 5', interactive: false }).addTo(lay);
      let tot = 0;
      pts.forEach((p, i) => {
        L.circleMarker(p, { radius: 4, color: '#fff', weight: 2, fillColor: '#ff7a1a', fillOpacity: 1, interactive: false }).addTo(lay);
        if (!i) return; const d = Geo.dist(pts[i - 1], p); tot += d;
        L.marker(p, { interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="rulm">${fmt(tot)}<small>${pts.length > 2 ? '+' + fmt(d) + ' · ' : ''}${Math.round(Geo.bearing(pts[i - 1], p))}°</small></div>` }) }).addTo(lay);
      });
    }
    function toggle(b) { btn = b || btn; on = !on; pts = []; draw(); if (btn) btn.classList.toggle('on', on); map.getContainer().style.cursor = on ? 'crosshair' : ''; toast(on ? 'Линейка: кликайте по карте — покажу расстояние и направление. Esc или 📏 — закончить.' : 'Линейка выключена', '', 4000); }
    map.on('click', e => { if (!on) return; pts.push(e.latlng); draw(); });
    document.addEventListener('keydown', e => { if (on && e.key === 'Escape') { e.stopImmediatePropagation(); toggle(); } }, true);
    return { toggle, get on() { return on; } };
  })();
  Zones.init(map);
  Core.on('zones', () => refresh());
  Core.on('los', () => refresh());
  function renderLayList() {
    const d = layCtl.getContainer(); if (!d) return; const list = Maps.list();
    const cur = list[baseId] || Maps.free['esri-sat'];
    d.querySelector('.laybtn').innerHTML = `<i>${cur.icon || '🗺'}</i><span>${cur.short || cur.name}</span> ▾`;
    d.querySelector('.laylist').innerHTML = '<div class="lt">Подложка карты</div>' + Object.entries(list).map(([k, v]) => `<button data-l="${k}" class="${k === baseId ? 'on' : ''}"><i>${v.icon || ''}</i>${v.name}</button>`).join('') +
      (Maps.googleReady ? '' : '<div class="lt" style="text-transform:none">Google Maps появятся, когда заработает ключ API (⚙)</div>') +
      (Object.keys(Maps.pro).some(k => !Maps.proReady(k)) ? '<div class="lt" style="text-transform:none">Airbus / CNES и Vantor (Maxar) — добавьте свой ключ в ⚙ Настройки</div>' : '');
  }
  layCtlReady = true; renderLayList();
  // ---- «where is this picture from»: provider, satellite, capture date, resolution (Esri imagery = Vantor/Maxar, Airbus, aerial…) ----
  const ImgInfo = (() => {
    const box = document.createElement('div'); box.id = 'imgInfo'; $('#mapWrap').appendChild(box); L.DomEvent.disableClickPropagation(box); L.DomEvent.disableScrollPropagation(box);
    let seq = 0, tmr = 0;
    const isEsriSat = () => ['esri-sat', 'esri-clean', 'wayback'].includes(baseId);
    async function upd() {
      const my = ++seq;
      if (!isEsriSat()) { box.hidden = !['airbus', 'maxar'].includes(baseId); box.innerHTML = baseId === 'airbus' ? 'Снимки <b>Airbus / CNES</b> (Pléiades, SPOT) — OneAtlas' : baseId === 'maxar' ? 'Снимки <b>Vantor (Maxar)</b> — Vivid' : ''; return; }
      box.hidden = false;
      let sel = '', meta = null;
      if (baseId === 'wayback') {
        try { const list = await Maps.wayback(); const cur = list.find(x => x.id === Core.store.get('ws.wbRel', '')) || list[0]; meta = cur.meta;
          sel = `<select id="wbSel" title="Версия спутниковой карты Esri — по дате публикации">${list.map(x => `<option value="${x.id}" ${x.id === cur.id ? 'selected' : ''}>${Core.fmtDate(x.date + 'T12:00', false)}</option>`).join('')}</select> `; } catch (e) { sel = 'архив недоступен · '; }
      }
      box.innerHTML = `${sel}<span class="ii">снимок: …</span>`;
      const c = map.getCenter();
      try { const r = await Maps.imageryInfo(c.lat, c.lng, map.getZoom(), meta); if (my !== seq) return;
        box.querySelector('.ii').innerHTML = r ? `снимок <b>${escH(r.provider || '')}</b>${r.product ? ' ' + escH(r.product) : ''}${r.sensor ? ` <small>(${escH(r.sensor)})</small>` : ''} · <b>${Core.fmtDate(r.date, false)}</b>${r.res ? ` · ${r.res < 1 ? Math.round(r.res * 100) + ' см' : r.res.toFixed(1) + ' м'}/пикс.` : ''}` : 'источник снимка не указан';
      } catch (e) { if (my === seq) box.querySelector('.ii').textContent = 'сведения о снимке недоступны (нет сети?)'; }
    }
    box.addEventListener('change', e => { if (e.target.id === 'wbSel') { Core.store.set('ws.wbRel', e.target.value); setBase('wayback'); } });
    map.on('moveend', () => { clearTimeout(tmr); tmr = setTimeout(upd, 500); });
    return { upd };
  })();
  imgInfoUpd = ImgInfo.upd; ImgInfo.upd();
  document.addEventListener('click', e => { const d = layCtl.getContainer(); if (d && !e.composedPath().includes(d)) d.classList.remove('open'); });
  // ---- my location ----
  const LocCtl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const b = L.DomUtil.create('a', 'leaflet-bar locbtn'); b.href = '#'; b.title = 'Моё местоположение'; b.innerHTML = '◎';
      L.DomEvent.on(b, 'click', e => { L.DomEvent.stop(e); locate(); });
      return b;
    },
  });
  new LocCtl().addTo(map);
  let locMk = null;
  function locate() {
    if (!navigator.geolocation) return toast('Геолокация недоступна');
    toast('Определяю местоположение…', '', 2000);
    navigator.geolocation.getCurrentPosition(p => {
      const ll = [p.coords.latitude, p.coords.longitude];
      if (locMk) locMk.remove();
      locMk = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#1e90ff', fillOpacity: 1 }).addTo(map).bindTooltip(`Вы здесь (±${Math.round(p.coords.accuracy)} м). Правый клик / долгое нажатие — сделать точкой взлёта`);
      map.setView(ll, Math.max(map.getZoom(), 17));
    }, async err => {
      // fallback: approximate position by IP address
      try {
        const j = await fetch('https://ipwho.is/').then(r => r.json());
        if (!j.success) throw new Error('ip');
        map.setView([j.latitude, j.longitude], 14);
        toast(`GPS недоступен (${err.message}). Показано примерное место по IP: ${j.city || ''}`, '', 6000);
      } catch (e) { toast('Не удалось определить местоположение: ' + err.message, 'err', 5000); }
    }, { enableHighAccuracy: true, timeout: 12000 });
  }
  // ---- mobile drawers ----
  const closeDrawers = () => document.body.classList.remove('showL', 'showR');
  $('#btnLeft') && ($('#btnLeft').onclick = e => { e.stopPropagation(); document.body.classList.toggle('showL'); document.body.classList.remove('showR'); });
  $('#btnRight') && ($('#btnRight').onclick = e => { e.stopPropagation(); document.body.classList.toggle('showR'); document.body.classList.remove('showL'); });

  const G = {
    path: L.layerGroup().addTo(map), mid: L.layerGroup().addTo(map), aim: L.layerGroup().addTo(map), poiLines: L.layerGroup().addTo(map),
    area: L.layerGroup().addTo(map), wp: L.layerGroup().addTo(map), poi: L.layerGroup().addTo(map), home: L.layerGroup().addTo(map), sim: L.layerGroup().addTo(map),
  };
  let pathCasing, pathLine, simActive = false;

  function wpIcon(w, i) {
    const n = S.m.waypoints.length, recP = Core.recPlan();
    const h = Core.effHeading(i);
    const cls = (S.sel.has(w.id) ? ' sel' : '') + (i === 0 ? ' first' : '') + (typeof Zones !== 'undefined' && Zones.zoneWps.has(i) ? ' inzone' : '') ; const rb = recP && recP[i] ? (recP[i].out && !recP[i].in ? '<div class="recb">● REC</div>' : recP[i].in && !recP[i].out ? '<div class="recb stop">■ REC</div>' : '') : '';
    const ic = (w.actions.some(a => a.type === 1) || w.photoDist || w.photoTime ? '📷' : '') + (w.actions.some(a => a.type === 2) ? '⏺' : '') + (w.actions.some(a => a.type === 0) ? '⏸' : '');
    const big = n < 150 || S.sel.has(w.id) || i === 0 || i === n - 1;
    if (!big) return L.divIcon({ className: '', iconSize: [10, 10], iconAnchor: [5, 5], html: `<div class="wpm tiny" title="${i + 1}"></div>` });
    return L.divIcon({
      className: '', iconSize: [24, 24], iconAnchor: [12, 12],
      html: `<div class="wpm${cls}">${h != null && big ? `<div class="hd" style="transform:rotate(${h}deg)"></div>` : ''}${i + 1}${big ? `<div class="alt">${r1(w.alt)} м</div>` : ''}${ic && big ? `<div class="ic">${ic}</div>` : ''}${big ? rb : ''}</div>`,
    });
  }

  // single note on the map when the route crosses a zone
  function zoneBanner(kind) {
    let b = $('#zoneBanner');
    if (!b) { b = document.createElement('button'); b.id = 'zoneBanner'; b.onclick = () => switchTab('check'); $('#mapWrap').appendChild(b); }
    b.hidden = !kind; if (!kind) return;
    b.textContent = `⛔ Пересечение ${kind === 1 ? 'запретной' : 'ограниченной'} зоны — отмечено красным`;
    b.title = 'Это предупреждение: маршрут всё равно можно записать на пульт. Нажмите — подробности во вкладке «Проверка».';
  }
  let dragStart = null;
  function renderMap() {
    Object.values(G).forEach(g => g !== G.sim && g.clearLayers());
    const W = S.m.waypoints;
    // path
    const geo = Core.pathGeometry();
    pathCasing = L.polyline(geo, { color: '#1a1400', weight: 3.2, opacity: .5, lineJoin: 'round', interactive: false }).addTo(G.path);
    pathLine = L.polyline(geo, { color: '#ffe100', weight: 1.8, lineJoin: 'round', interactive: false }).addTo(G.path);
    // stretches flown while the video is recording: red dotted line along the path
    { const rp = Core.recPlan(); let run = null; const runs = [];
      for (let k = 1; k < geo.length; k++) { const on = rp[geo[k - 1].i] && rp[geo[k - 1].i].out; if (on) { if (!run) { run = [geo[k - 1]]; runs.push(run); } run.push(geo[k]); } else run = null; }
      if (false) runs.forEach(r => L.polyline(r, { color: '#1b1b1b', weight: 2.6, dashArray: '0.1 7', lineCap: 'round', opacity: .9, interactive: true }).bindTooltip('Тёмные точки на линии — здесь идёт запись видео', { sticky: true }).addTo(G.path)); }
    // parts of the flight inside no-fly / restricted zones: red, with a note on the map
    // (one note for the whole route in the map corner; the stretches and the points themselves are highlighted red)
    let zk = 0;
    if (typeof Zones !== 'undefined') Zones.stretches.forEach(z => {
      const pts = z.pts.map(q => [q.lat, q.lng]); if (pts.length < 2) return;
      zk = zk ? Math.min(zk, z.kind) : z.kind;
      const txt = z.kind === 1 ? 'Пересечение запретной зоны' : 'Пересечение ограниченной зоны', side = z.what !== 'маршрут';
      const ln = L.polyline(pts, { color: '#ff2020', weight: side ? 3 : 8, opacity: side ? .8 : .5, dashArray: side ? '6 8' : null, lineCap: 'round', lineJoin: 'round', interactive: true }).bindTooltip('⛔ ' + txt + (side ? ` (${z.what} — не входит в маршрут)` : ''), { sticky: true }).addTo(G.path); if (!side) ln.bringToBack();
    });
    zoneBanner(zk);
    // parts of the flight where hills block the line of sight to the remote
    (LOS.result.blocked || []).forEach(b => { const pts = b.pts.map(q => [q.lat, q.lng]); if (pts.length > 1) L.polyline(pts, { color: '#d946ef', weight: 3, opacity: .9, dashArray: '2 7', lineCap: 'round', interactive: true }).bindTooltip('Связь с пультом может пропадать: рельеф закрывает прямую видимость', { sticky: true }).addTo(G.path); });
    if (S.m.home && W.length) {
      L.polyline([S.m.home, W[0]], { color: '#3ccf7a', weight: 1.2, dashArray: '4 6', interactive: false }).addTo(G.path);
      if (S.m.settings.finishAction === 'rth') L.polyline([W[W.length - 1], S.m.home], { color: '#ffb020', weight: 1.2, dashArray: '4 6', interactive: false }).addTo(G.path);
    }
    // midpoints for insertion
    if (S.mode !== 'area' && S.mode !== 'line') for (let i = 0; i < W.length - 1; i++) {
      if (W.length > 60 && !S.sel.has(W[i].id) && !S.sel.has(W[i + 1].id)) continue;
      const p = Geo.interp(W[i], W[i + 1], .5);
      const mk = L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="mid">+</div>', iconSize: [14, 14], iconAnchor: [7, 7] }), title: 'Вставить точку', zIndexOffset: -100 }).addTo(G.mid);
      mk.on('click', () => insertAt(i + 1, p));
    }
    // waypoints
    W.forEach((w, i) => {
      const mk = L.marker(w, { icon: wpIcon(w, i), draggable: true, zIndexOffset: S.sel.has(w.id) ? 1000 : 0, autoPan: true }).addTo(G.wp);
      mk._wid = w.id;
      if (W.length < 150) mk.bindTooltip(`Точка №${i + 1} · ${r1(w.alt)} м<br><small>клик — параметры · тащите — переместить · правый клик — меню</small>`, { direction: 'top', offset: [0, -16], opacity: .95 });
      mk.on('click', e => { L.DomEvent.stop(e); selectWp(w.id, e.originalEvent); if (isMobile()) { document.body.classList.add('showR'); document.body.classList.remove('showL'); } });
      mk.on('contextmenu', e => { L.DomEvent.stop(e); if (!S.sel.has(w.id)) selectWp(w.id, {}); ctxWp(e, i); });
      mk.on('dragstart', () => {
        Core.snap();
        if (!S.sel.has(w.id)) { S.sel.clear(); S.sel.add(w.id); }
        dragStart = { lat: w.lat, lng: w.lng, others: W.filter(o => S.sel.has(o.id) && o !== w).map(o => ({ o, lat: o.lat, lng: o.lng })) };
      });
      mk.on('drag', e => {
        const p = e.target.getLatLng(); w.lat = p.lat; w.lng = p.lng;
        const dl = p.lat - dragStart.lat, dg = p.lng - dragStart.lng;
        dragStart.others.forEach(x => { x.o.lat = x.lat + dl; x.o.lng = x.lng + dg; });
        if (dragStart.others.length) G.wp.eachLayer(l => { const o = dragStart.others.find(x => x.o.id === l._wid); if (o) l.setLatLng(o.o); });
        const g2 = Core.pathGeometry(); pathLine.setLatLngs(g2); pathCasing.setLatLngs(g2);
      });
      mk.on('dragend', () => { dragStart = null; Core.changed(); });
    });
    // POIs
    S.m.pois.forEach(p => {
      const mk = L.marker(p, { icon: L.divIcon({ className: '', html: `<div class="poiw" data-poi="${p.id}"><div class="poim${S.selPoi === p.id ? ' sel' : ''}"></div><div class="palt">${escH(p.name || 'POI')} · ${r1(p.alt || 0)} м</div></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }), draggable: true }).addTo(G.poi);
      mk._pid = p.id;
      mk.bindTooltip(escH(p.name), { direction: 'top', offset: [0, -14] });
      mk.on('click', e => { L.DomEvent.stop(e); S.sel.clear(); S.selHome = false; S.selPoi = p.id; refresh(); });
      mk.on('contextmenu', e => { L.DomEvent.stop(e); S.sel.clear(); S.selHome = false; S.selPoi = p.id; refresh(); ctxPoi(e, p); });
      mk.on('dragstart', () => Core.snap());
      mk.on('dragend', e => { const q = e.target.getLatLng(); p.lat = q.lat; p.lng = q.lng; Core.changed(); });
    });
    // lines wp -> poi
    const showAll = W.length < 60;
    W.forEach(w => {
      if (!(showAll || S.sel.has(w.id))) return;
      const p = Core.poiById(w.poi); if (p) L.polyline([w, p], { color: '#ff7a1a', weight: 1, dashArray: '3 5', opacity: .8, interactive: false }).addTo(G.poiLines);
    });
    // home
    if (S.m.home) {
      const mk = L.marker(S.m.home, { icon: L.divIcon({ className: '', html: '<div class="homem">H</div>', iconSize: [28, 28], iconAnchor: [14, 14] }), draggable: true, zIndexOffset: 500 }).addTo(G.home);
      mk.bindTooltip('Точка взлёта · перетащите или правый клик — меню', { direction: 'top', offset: [0, -14] });
      mk.on('click', e => { L.DomEvent.stop(e); S.sel.clear(); S.selPoi = null; S.selHome = true; refresh(); });
      mk.on('dragstart', () => Core.snap());
      mk.on('dragend', e => { const q = e.target.getLatLng(); S.m.home = { lat: q.lat, lng: q.lng }; Core.changed(); });
      mk.on('contextmenu', e => { L.DomEvent.stop(e); S.sel.clear(); S.selPoi = null; S.selHome = true; refresh(); ctxHome(e); });
    }
    // area & line
    drawShape(S.m.area, true); drawShape(S.m.line, false);
    // aim for single selection
    if (S.sel.size === 1 && !simActive && Core.store.get('ws.frame3dOn', true) !== false) drawAim(Core.wpIndex([...S.sel][0]));
  }
  function drawShape(pts, closed) {
    if (!pts.length) return;
    const col = closed ? '#ffb020' : '#c77dff';
    (closed ? L.polygon(pts, { color: col, weight: 2, fillOpacity: .12, dashArray: '6 4', interactive: false }) : L.polyline(pts, { color: col, weight: 3, dashArray: '6 4', interactive: false })).addTo(G.area);
    const editable = S.mode === (closed ? 'area' : 'line');
    pts.forEach((p, i) => {
      const mk = L.marker(p, { icon: L.divIcon({ className: '', html: `<div class="vtx" style="border-color:${col}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }), draggable: true, opacity: editable ? 1 : .7, title: 'Правый клик — удалить вершину' }).addTo(G.area);
      mk.on('dragstart', () => Core.snap());
      mk.on('dragend', e => { const q = e.target.getLatLng(); pts[i] = { lat: q.lat, lng: q.lng }; Core.changed(); });
      mk.on('contextmenu', e => { L.DomEvent.stop(e); Core.snap(); pts.splice(i, 1); Core.changed(); });
      mk.on('click', e => L.DomEvent.stop(e));
    });
  }
  const frLabel = fr => `<div class="frlbl">кадр ${Math.round(fr.width)}×${Math.round(fr.depth)} м${fr.clipped ? ' · до горизонта' : ''}<br>${fr.gsd.toFixed(1)} см/пикс · ${Math.round(fr.centerDist)} м</div>`;
  function drawAim(i) {
    const w = S.m.waypoints[i]; if (!w) return;
    const h = Core.effHeading(i); if (h == null) return;
    const g = Core.effGimbal(i) ?? w.gimbal;
    const agl = Core.wpAGL(w) ?? w.alt;
    const fr = Camera.frame(Core.drone(), w, agl, h, g, Camera.viewMax(agl));
    const C = fr.corners;
    // footprint of the image on the ground + rays from the drone (Litchi-style frame)
    L.polygon(C, { color: '#4fd3ff', weight: 1, fillOpacity: .16, interactive: false }).addTo(G.aim);
    L.polyline([C[0], C[1]], { color: '#ff2a2a', weight: 1.4, interactive: false }).addTo(G.aim).bindTooltip('верх кадра');
    C.forEach(c => L.polyline([w, c], { color: '#4fd3ff', weight: 0.7, opacity: .85, interactive: false }).addTo(G.aim));
    L.circleMarker(fr.center, { radius: 3, color: '#4fd3ff', weight: 1, fill: false, interactive: false }).addTo(G.aim);
    // no text bubble on the map: frame size, GSD and distance are shown in the point's panel
  }
  // ---- map interactions ----
  let ignoreClick = false;
  map.on('click', e => {
    if (typeof Ruler !== 'undefined' && Ruler.on) return; // measuring
    if (moving) { endMove(true, { lat: e.latlng.lat, lng: e.latlng.lng }); return; }
    if (ignoreClick) { ignoreClick = false; return; }
    if (isMobile() && (document.body.classList.contains('showL') || document.body.classList.contains('showR'))) { closeDrawers(); return; }
    hideCtx(); closeMenus();
    const p = { lat: e.latlng.lat, lng: e.latlng.lng };
    switch (S.mode) {
      case 'wp': addWp(p); break;
      case 'poi': addPoi(p); setMode('wp'); toast('POI поставлен. Режим снова «Точки маршрута»'); break;
      case 'home': Core.snap(); S.m.home = p; setMode('wp'); Core.changed(); break;
      case 'area': Core.snap(); S.m.area.push(p); Core.changed(); break;
      case 'line': Core.snap(); S.m.line.push(p); Core.changed(); break;
      default: S.sel.clear(); S.selPoi = null; S.selHome = false; refresh();
    }
  });
  map.on('contextmenu', e => { if (moving) return endMove(false); ctxMap(e); });
  function addWp(p) {
    const W = S.m.waypoints;
    if (W.length && Geo.dist(W[W.length - 1], p) > 8000 && !confirm('Новая точка дальше 8 км от предыдущей. Добавить?')) return;
    Core.snap();
    const prev = W[W.length - 1];
    const w = Core.newWaypoint({ lat: p.lat, lng: p.lng, alt: prev ? prev.alt : undefined, gimbal: prev ? prev.gimbal : undefined }, S.m);
    if (prev) { w.speed = prev.speed; w.poi = prev.poi; }
    W.push(w);
    if (!S.m.home && W.length === 1) S.m.home = null;
    S.sel.clear(); S.sel.add(w.id); S.selPoi = null; S.selHome = false;
    Core.changed();
  }
  function insertAt(idx, p) {
    const W = S.m.waypoints; Core.snap();
    const a = W[idx - 1], b = W[idx];
    const w = Core.newWaypoint({ lat: p.lat, lng: p.lng, alt: a && b ? r1((a.alt + b.alt) / 2) : (a || b || {}).alt, gimbal: a ? a.gimbal : undefined }, S.m);
    if (a) { w.speed = a.speed; w.poi = a.poi; }
    W.splice(idx, 0, w); S.sel.clear(); S.sel.add(w.id); Core.changed();
  }
  function addPoi(p) {
    Core.snap();
    const poi = { id: Core.id(), lat: p.lat, lng: p.lng, alt: 0, name: 'POI ' + (S.m.pois.length + 1) };
    S.m.pois.push(poi); S.sel.clear(); S.selPoi = poi.id; S.selHome = false; Core.changed();
  }
  let lastClicked = null;
  function selectWp(idv, ev = {}) {
    S.selPoi = null; S.selHome = false;
    if (ev.shiftKey && lastClicked) {
      const a = Core.wpIndex(lastClicked), b = Core.wpIndex(idv);
      S.m.waypoints.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(w => S.sel.add(w.id));
    } else if (ev.metaKey || ev.ctrlKey) { S.sel.has(idv) ? S.sel.delete(idv) : S.sel.add(idv); }
    else { S.sel.clear(); S.sel.add(idv); }
    lastClicked = idv;
    if (simActive && !Sim.playing) Sim.stop(); // a paused simulation gives way to the selected point's own frame
    refresh();
  }
  // shift + drag = box selection
  (() => {
    const el = map.getContainer(); let box = null, start = null;
    el.addEventListener('mousedown', e => {
      if (!e.shiftKey || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation(); map.dragging.disable();
      const r = el.getBoundingClientRect(); start = { x: e.clientX - r.left, y: e.clientY - r.top };
      box = document.createElement('div'); box.className = 'selbox'; el.appendChild(box);
      const move = ev => { const x = ev.clientX - r.left, y = ev.clientY - r.top; Object.assign(box.style, { left: Math.min(x, start.x) + 'px', top: Math.min(y, start.y) + 'px', width: Math.abs(x - start.x) + 'px', height: Math.abs(y - start.y) + 'px' }); };
      const up = ev => {
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
        const x = ev.clientX - r.left, y = ev.clientY - r.top; box.remove(); map.dragging.enable();
        if (Math.abs(x - start.x) + Math.abs(y - start.y) < 6) return;
        const b = L.latLngBounds(map.containerPointToLatLng([start.x, start.y]), map.containerPointToLatLng([x, y]));
        if (!(ev.metaKey || ev.ctrlKey)) S.sel.clear();
        S.m.waypoints.forEach(w => b.contains(w) && S.sel.add(w.id)); S.selPoi = null; S.selHome = false;
        ignoreClick = true; setTimeout(() => ignoreClick = false, 300); refresh();
      };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    }, true);
  })();

  // ---- context menus (2D and 3D share the same menus) ----
  const ctx = $('#ctx');
  function showCtx(e, items) {
    const ev = e.originalEvent || e;
    const acts = [];
    const html = list => list.map(it => {
      if (it === '-') return '<hr>';
      if (it.t) return `<div class="t">${it.t}</div>`;
      const k = acts.push(it) - 1;
      const cls = (it.danger ? ' danger' : '') + (it.sub ? ' has' : '') + (it.on ? ' on' : '') + (it.info ? ' info' : '');
      return `<div class="ci${cls}"><button data-k="${k}" ${it.dis ? 'disabled' : ''}>${it.label}${it.badge ? `<span class="bdg">${it.badge}</span>` : ''}${it.sub ? '<span class="arr">▸</span>' : it.kbd ? `<kbd>${it.kbd}</kbd>` : ''}</button>${it.sub ? `<div class="sub">${html(it.sub)}</div>` : ''}</div>`;
    }).join('');
    ctx.innerHTML = html(items);
    ctx.hidden = false; ctx.classList.remove('flip');
    const x = Math.min(ev.clientX, innerWidth - ctx.offsetWidth - 8), y = Math.max(8, Math.min(ev.clientY, innerHeight - ctx.offsetHeight - 10));
    Object.assign(ctx.style, { left: x + 'px', top: y + 'px' });
    if (x + ctx.offsetWidth + 230 > innerWidth) ctx.classList.add('flip');
    // a submenu that would run below the window is lifted so all of it stays visible
    ctx.querySelectorAll('.ci.has').forEach(ci => ci.addEventListener('mouseenter', () => {
      const sub = ci.querySelector(':scope > .sub'); if (!sub) return; sub.style.top = '-5px';
      requestAnimationFrame(() => { const r = sub.getBoundingClientRect(), over = r.bottom - (innerHeight - 8); if (over > 0) sub.style.top = Math.max(-5 - over, -ci.getBoundingClientRect().top + 8) + 'px'; });
    }));
    ctx.onclick = c => { const b = c.target.closest('button'); if (!b || b.disabled) return; const it = acts[+b.dataset.k]; if (it.sub || !it.fn) return; hideCtx(); it.fn(); };
  }
  const hideCtx = () => ctx.hidden = true;
  document.addEventListener('mousedown', e => { if (!ctx.contains(e.target)) hideCtx(); });
  ctx.addEventListener('contextmenu', e => e.preventDefault());

  const defs = () => S.m.settings;
  const aboutPt = p => { const g = Core.Elev.cached(p); Core.Elev.request([p]); return `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}${g !== undefined ? ' · рельеф ' + Math.round(g) + ' м' : ''}`; };
  function nearestSeg(p) { const W = S.m.waypoints; let best = -1, bd = Infinity; for (let i = 0; i < W.length - 1; i++) { const m = Geo.interp(W[i], W[i + 1], .5); const d = Geo.dist(W[i], p) + Geo.dist(p, W[i + 1]) - Geo.dist(W[i], W[i + 1]); if (d < bd) { bd = d; best = i; } } return best; }
  function ctxMap(e, p) {
    p = p || { lat: e.latlng.lat, lng: e.latlng.lng };
    const W = S.m.waypoints;
    const items = [
      { t: aboutPt(p) },
      { t: 'Поставить здесь' },
      { label: '<i class="ico wp">✚</i> Точку маршрута' + (W.length ? ` (№${W.length + 1}, в конец)` : ''), fn: () => addWp(p) },
    ];
    if (W.length > 1) items.push({ label: '<i class="ico wp">↳</i> Точку маршрута — в ближайший отрезок', fn: () => { const i = nearestSeg(p); insertAt(i + 1, p); toast(`Точка вставлена между ${i + 1} и ${i + 2}`); } });
    items.push(
      { label: '<i class="ico poi">◎</i> Точку интереса (POI)', fn: () => addPoi(p) },
      { label: '<i class="ico home">H</i> Точку взлёта' + (S.m.home ? ' (перенести сюда)' : ''), fn: () => { Core.snap(); S.m.home = p; Core.changed(); } },
      '-',
      { label: '⟳ Орбита вокруг этого места…', fn: () => { genCenter = p; openTool('orbit'); } },
      { label: '▱ Начать зону картирования отсюда', fn: () => { Core.snap(); S.m.area = [p]; setMode('area'); Core.changed(); } },
      { label: '⧉ Копировать координаты', fn: () => navigator.clipboard.writeText(`${p.lat.toFixed(7)}, ${p.lng.toFixed(7)}`).then(() => toast('Координаты скопированы')) },
      '-',
      { label: '🧹 Очистить', danger: true, sub: clearItems() },
    );
    showCtx(e, items);
  }
  function clearItems() {
    const W = S.m.waypoints;
    return [
      { label: `Удалить все точки маршрута (${W.length})`, dis: !W.length, fn: () => clearAll('wp') },
      { label: `Удалить все POI (${S.m.pois.length})`, dis: !S.m.pois.length, fn: () => clearAll('poi') },
      { label: 'Удалить точку взлёта', dis: !S.m.home, fn: () => clearAll('home') },
      { label: 'Удалить зону и линию', dis: !S.m.area.length && !S.m.line.length, fn: () => clearAll('shape') },
      '-',
      { label: 'Очистить всё', danger: true, fn: () => clearAll('all') },
    ];
  }
  function clearAll(what) {
    Core.snap();
    if (what === 'wp' || what === 'all') { S.m.waypoints = []; S.sel.clear(); }
    if (what === 'poi' || what === 'all') { S.m.pois = []; S.m.waypoints.forEach(w => w.poi = null); S.selPoi = null; }
    if (what === 'home' || what === 'all') { S.m.home = null; S.selHome = false; }
    if (what === 'shape' || what === 'all') { S.m.area = []; S.m.line = []; }
    Core.changed(); undoToast('Очищено');
  }
  function undoToast(msg) { toast(msg, '', 6000, { label: '↶ Отменить', fn: () => Core.undo() }); }

  const ACT_Q = [[1, '📷 Сделать фото'], [2, '⏺ Начать видео'], [3, '⏹ Остановить видео'], [0, '⏸ Зависнуть 2 с']];
  function ctxWp(e, i) {
    const W = S.m.waypoints, w = W[i], n = S.sel.size, many = n > 1;
    const sfx = many ? ` (${n})` : '';
    const items = [
      { t: many ? `Выбрано точек: ${n}` : `Точка маршрута №${i + 1} · ${r1(w.alt)} м · камера ${Math.round(Core.effGimbal(i) ?? w.gimbal)}°` },
      { label: '✥ Переместить мышью', dis: many, fn: () => startMove('wp', w.id) },
      { label: '↕ Высота' + sfx, sub: [
        ...[10, 5, -5, -10].map(d => ({ label: (d > 0 ? '+' : '−') + Math.abs(d) + ' м', fn: () => batch(x => x.alt = r1(x.alt + d)) })),
        '-', ...[30, 60, 90, 120].map(v => ({ label: `= ${v} м`, fn: () => batch(x => x.alt = v) })),
        { label: 'Указать…', fn: async () => { const v = await ask('Высота точки, м', r1(w.alt)); if (v != null && !isNaN(v)) batch(x => x.alt = v); } } ] },
      { label: '📷 Наклон камеры' + sfx, sub: [[-90, 'Вниз (−90°, надир)'], [-60, '−60°'], [-45, '−45°'], [-30, '−30°'], [-20, '−20°'], [0, 'Горизонт (0°)']].map(([v, t]) => { const on = !many && Math.round(w.gimbal) === v; return { label: (on ? '✓ ' : '') + t, on, fn: () => batch(x => x.gimbal = v) }; }) },
    ];
    items.push({ label: '◎ Смотреть на' + sfx, sub: S.m.pois.length ? [...S.m.pois.map(p => ({ label: (w.poi === p.id ? '✓ ' : '') + escH(p.name), fn: () => batch(x => x.poi = p.id) })), '-', { label: 'Ни на что (снять POI)', fn: () => batch(x => x.poi = null) }]
      : [{ label: 'POI ещё нет — поставьте его правым кликом на карте', dis: true, fn: () => {} }] });
    // actions already set at the point are highlighted: their sequence on top, ✓ and a count on the add items
    const selW = many ? W.filter(x => S.sel.has(x.id)) : [w];
    const single = x => Core.actGroups(x.actions).filter(g => g.kind === 'act').map(g => g.a); // actions outside panoramas
    const cnt = t => many ? selW.filter(x => single(x).some(a => a.type === t)).length : single(w).filter(a => a.type === t).length;
    const grp = Core.actGroups(w.actions), hasPano = x => Core.actGroups(x.actions).some(g => g.kind === 'pano');
    const actName = a => ({ 0: `⏸ Зависнуть ${((a.param || 0) / 1000).toFixed(a.param % 1000 ? 1 : 0)} с`, 1: '📷 Сделать фото', 2: '⏺ Начать видео', 3: '⏹ Остановить видео', 4: `⟳ Повернуть дрон ${Math.round(a.param || 0)}°`, 5: `↕ Наклон камеры ${Math.round(a.param ?? 0)}°` })[a.type] || '•';
    const nAct = many ? selW.filter(x => x.actions.length).length : grp.length;
    const gName = g => g.kind === 'pano' ? `🌐 Панорама 360° (${g.shots} кадров)` : actName(g.a);
    const cur = !many && grp.length ? [{ t: `Сейчас в точке: ${grp.length} ${grp.length === 1 ? 'действие' : grp.length < 5 ? 'действия' : 'действий'} · команд ${w.actions.length}/15` }, ...grp.slice(0, 7).map((g, k) => ({ label: `${k + 1}. ${gName(g)}`, on: true, info: true })), ...(grp.length > 7 ? [{ t: `… и ещё ${grp.length - 7} (весь список — справа)` }] : []), '-', { t: 'Добавить:' }] : [];
    items.push({ label: '🎬 Действия в точке' + sfx, on: nAct > 0, badge: nAct ? (many ? `${nAct} т.` : String(nAct)) : '', sub: [
      ...cur,
      ...ACT_Q.map(([t, l]) => { const c = cnt(t); return { label: (c ? '✓ ' : '') + l, on: c > 0, badge: c ? (many ? `${c} т.` : '×' + c) : '', fn: () => batch(x => x.actions.length < 15 && x.actions.push({ type: t, param: ACTIONS[t].def })) }; }),
      (() => { const c = many ? selW.filter(hasPano).length : grp.filter(g => g.kind === 'pano').length; return { label: (c ? '✓ ' : '') + '🌐 Панорама 360°', on: c > 0, badge: c ? (many ? `${c} т.` : '×' + c) : '', dis: many || w.actions.length >= 13, fn: () => { Core.snap(); addPano(i); Core.changed(); } }; })(),
      '-', { label: 'Убрать все действия', dis: !nAct, fn: () => batch(x => x.actions = []) } ] });
    items.push('-');
    if (!many) items.push(
      { label: '✚ Вставить новую точку', sub: [
        { label: '↤ Перед этой', fn: () => insertAt(i, i > 0 ? Geo.interp(W[i - 1], w, .5) : Geo.dest(w, 225, 20)) },
        { label: '↦ После этой', fn: () => insertAt(i + 1, i < W.length - 1 ? Geo.interp(w, W[i + 1], .5) : Geo.dest(w, 45, 20)) } ] },
      { label: '⇅ Порядок в маршруте', sub: [
        { label: '⤒ Сделать первой (№1)', dis: i === 0, fn: () => reorder(i, 0) },
        { label: '↑ Раньше на одну', dis: i === 0, fn: () => reorder(i, i - 1) },
        { label: '↓ Позже на одну', dis: i === W.length - 1, fn: () => reorder(i, i + 1) },
        { label: '⤓ Сделать последней', dis: i === W.length - 1, fn: () => reorder(i, W.length - 1) },
        '-', { label: '⇄ Развернуть весь маршрут', fn: () => Gen.reverse() } ] },
      { label: '⇄ Превратить в', sub: [
        { label: '<i class="ico poi">◎</i> Точку интереса (POI)', fn: () => convert('wp', w.id, 'poi') },
        { label: '<i class="ico home">H</i> Точку взлёта', fn: () => convert('wp', w.id, 'home') } ] },
      { label: '⧉ Дублировать', fn: () => { Core.snap(); const c = Object.assign(JSON.parse(JSON.stringify(w)), { id: Core.id() }); const q = Geo.dest(w, 90, 10); c.lat = q.lat; c.lng = q.lng; W.splice(i + 1, 0, c); S.sel.clear(); S.sel.add(c.id); Core.changed(); } },
    );
    items.push(
      { label: '↺ Сбросить параметры' + sfx, fn: () => { batch(resetWp); toast('Параметры сброшены к значениям по умолчанию', '', 5000, { label: '↶ Отменить', fn: () => Core.undo() }); } },
      { label: '▶ Симуляция полёта с этой точки', dis: many, fn: () => { if (View3D.isOpen) { Sim.stop(); View3D.playFrom(i); } else Sim.play(i); } },
      '-',
      { label: '🗑 Удалить' + (many ? ` выбранные (${n})` : ' точку'), danger: true, kbd: 'Del', fn: deleteSel },
    );
    showCtx(e, items);
  }
  function ctxPoi(e, p) {
    const used = S.m.waypoints.filter(w => w.poi === p.id).length;
    showCtx(e, [{ t: `Точка интереса «${escH(p.name)}» · на неё смотрят точек: ${used}` },
      { label: '✥ Переместить мышью', fn: () => startMove('poi', p.id) },
      { label: '✎ Переименовать…', fn: async () => { const v = await ask('Название точки интереса', p.name, 'text'); if (v) { Core.snap(); p.name = v; Core.changed(); } } },
      { label: '↕ Высота цели над землёй', sub: [0, 2, 10, 30, 50].map(v => ({ label: (p.alt === v ? '✓ ' : '') + v + ' м', fn: () => { Core.snap(); p.alt = v; Core.changed(); } })) },
      '-',
      { label: '◎ Все точки маршрута смотрят сюда', fn: () => { Core.snap(); S.m.waypoints.forEach(w => w.poi = p.id); S.m.settings.headingMode = 'poi'; S.m.settings.gimbalMode = 'poi'; Core.changed(); toast('Курс и камера всех точек направлены на POI'); } },
      { label: 'Отвязать все точки от этого POI', dis: !used, fn: () => { Core.snap(); S.m.waypoints.forEach(w => { if (w.poi === p.id) w.poi = null; }); Core.changed(); } },
      { label: '⟳ Орбита вокруг…', fn: () => { genCenter = p; openTool('orbit'); } },
      { label: '⇄ Превратить в', sub: [
        { label: '<i class="ico wp">✚</i> Точку маршрута (в конец)', fn: () => convert('poi', p.id, 'wp') },
        { label: '<i class="ico home">H</i> Точку взлёта', fn: () => convert('poi', p.id, 'home') } ] },
      '-', { label: '🗑 Удалить POI', danger: true, kbd: 'Del', fn: () => delPoi(p.id) }]);
  }
  function ctxHome(e) {
    showCtx(e, [{ t: 'Точка взлёта (H) · ' + aboutPt(S.m.home) },
      { label: '✥ Переместить мышью', fn: () => startMove('home') },
      { label: '⇄ Превратить в', sub: [
        { label: '<i class="ico wp">✚</i> Первую точку маршрута', fn: () => convert('home', null, 'wp') },
        { label: '<i class="ico poi">◎</i> Точку интереса (POI)', fn: () => convert('home', null, 'poi') } ] },
      '-', { label: '🗑 Удалить точку взлёта', danger: true, fn: () => { Core.snap(); S.m.home = null; S.selHome = false; Core.changed(); undoToast('Точка взлёта удалена'); } }]);
  }

  // ---- point operations ----
  function resetWp(w) { const s = defs(); Object.assign(w, { alt: s.defAlt, speed: 0, curve: s.defCurve, gimbal: s.defGimbal, heading: 0, poi: null, actions: [], photoTime: 0, photoDist: 0 }); }
  function addPano(i) {
    const w = S.m.waypoints[i], h0 = Core.effHeading(i) || 0, g = 'pano' + Core.id(), n0 = w.actions.length;
    [0, -45].forEach(t => { if (w.actions.length < 13) w.actions.push({ type: 5, param: t, g }); for (let a = 0; a < 6; a++) if (w.actions.length < 14) w.actions.push({ type: 4, param: Math.round(Geo.norm180(h0 + a * 60)), g }, { type: 1, param: 0, g }); });
    w.actions = w.actions.slice(0, 15);
    const shots = w.actions.slice(n0).filter(a => a.type === 1).length;
    toast(`Добавлена панорама 360° — одно действие (${shots} кадров; DJI Fly позволяет не более 15 команд в точке)`, 'ok', 6000);
  }
  function reorder(from, to) { const W = S.m.waypoints; Core.snap(); const [w] = W.splice(from, 1); W.splice(to, 0, w); S.sel.clear(); S.sel.add(w.id); Core.changed(); toast(`Точка теперь №${to + 1}`); }
  function convert(kind, idv, to) {
    Core.snap();
    let pos;
    if (kind === 'wp') { const w = S.m.waypoints.find(x => x.id === idv); pos = { lat: w.lat, lng: w.lng }; S.m.waypoints = S.m.waypoints.filter(x => x.id !== idv); S.sel.delete(idv); }
    if (kind === 'poi') { const p = Core.poiById(idv); pos = { lat: p.lat, lng: p.lng }; S.m.pois = S.m.pois.filter(x => x.id !== idv); S.m.waypoints.forEach(w => { if (w.poi === idv) w.poi = null; }); S.selPoi = null; }
    if (kind === 'home') { pos = { ...S.m.home }; S.m.home = null; S.selHome = false; }
    if (to === 'wp') { const w = Core.newWaypoint(pos, S.m); kind === 'home' ? S.m.waypoints.unshift(w) : S.m.waypoints.push(w); S.sel.clear(); S.sel.add(w.id); }
    if (to === 'poi') { const p = { id: Core.id(), lat: pos.lat, lng: pos.lng, alt: 0, name: 'POI ' + (S.m.pois.length + 1) }; S.m.pois.push(p); S.sel.clear(); S.selPoi = p.id; }
    if (to === 'home') { S.m.home = pos; S.sel.clear(); S.selHome = true; }
    Core.changed();
    undoToast({ wp: 'Теперь это точка маршрута', poi: 'Теперь это точка интереса (POI)', home: 'Теперь это точка взлёта' }[to]);
  }
  function deleteSel() {
    if (!S.sel.size) return;
    const n = S.sel.size;
    Core.snap(); S.m.waypoints = S.m.waypoints.filter(w => !S.sel.has(w.id)); S.sel.clear(); Core.changed();
    undoToast(n > 1 ? `Удалено точек: ${n}` : 'Точка удалена');
  }
  function delPoi(idv) { Core.snap(); S.m.pois = S.m.pois.filter(p => p.id !== idv); S.m.waypoints.forEach(w => { if (w.poi === idv) w.poi = null; }); S.selPoi = null; Core.changed(); undoToast('POI удалён'); }
  function batch(fn) { Core.snap(); S.m.waypoints.filter(w => S.sel.has(w.id)).forEach(fn); Core.changed(); }

  // ---- "move with mouse" (from the menu): the point follows the cursor, click drops it, Esc cancels ----
  let moving = null;
  function objOf(kind, idv) { return kind === 'wp' ? S.m.waypoints.find(w => w.id === idv) : kind === 'poi' ? Core.poiById(idv) : S.m.home; }
  function startMove(kind, idv) {
    const o = objOf(kind, idv); if (!o) return;
    Core.snap();
    moving = { kind, idv, orig: { lat: o.lat, lng: o.lng } };
    document.body.classList.add('moving');
    $('#modeHint').textContent = '✥ Ведите мышью — точка следует за курсором · клик — поставить · Esc — отмена';
    map.getContainer().style.cursor = 'move';
    if (View3D.isOpen) View3D.startMove(kind === 'wp' ? Core.wpRel(o) : null, g => moveTo(g, true));
  }
  function moveTo(p, from3d) {
    if (!moving) return; const o = objOf(moving.kind, moving.idv); if (!o) return;
    o.lat = p.lat; o.lng = p.lng;
    if (from3d) return;
    let mk = null;
    const grp = moving.kind === 'wp' ? G.wp : moving.kind === 'poi' ? G.poi : G.home;
    grp.eachLayer(l => { if (moving.kind === 'home' || l._wid === moving.idv || l._pid === moving.idv) mk = l; });
    if (mk) mk.setLatLng(p);
    if (moving.kind === 'wp' && pathLine) { const g2 = Core.pathGeometry(); pathLine.setLatLngs(g2); pathCasing.setLatLngs(g2); }
  }
  function endMove(commit, p) {
    if (!moving) return;
    if (p) moveTo(p);
    if (!commit) { const o = objOf(moving.kind, moving.idv); if (o) Object.assign(o, moving.orig); S.undo.pop(); }
    moving = null; document.body.classList.remove('moving');
    map.getContainer().style.cursor = S.mode === 'pan' ? '' : 'crosshair'; $('#modeHint').textContent = hintText();
    View3D.stopMove();
    commit ? Core.changed() : refresh();
    ignoreClick = true; setTimeout(() => ignoreClick = false, 250);
  }
  map.on('mousemove', e => { if (moving) moveTo({ lat: e.latlng.lat, lng: e.latlng.lng }); });

  // ---- 3D bridge ----
  Core.on('click3d', g => {
    if (moving) { if (g.lat != null) endMove(true, g); return; }
    hideCtx();
    if (g.wp) selectWp(g.wp, {}); else if (g.poi) { S.sel.clear(); S.selHome = false; S.selPoi = g.poi; refresh(); } else if (g.home) { S.sel.clear(); S.selPoi = null; S.selHome = true; refresh(); }
  });
  Core.on('ctx3d', g => {
    if (moving) { endMove(false); return; }
    const e = { clientX: g.clientX, clientY: g.clientY };
    if (g.wp) { if (!S.sel.has(g.wp)) selectWp(g.wp, {}); ctxWp(e, Core.wpIndex(g.wp)); }
    else if (g.poi) { const p = Core.poiById(g.poi); S.sel.clear(); S.selPoi = p.id; refresh(); ctxPoi(e, p); }
    else if (g.home) ctxHome(e);
    else if (g.lat != null) ctxMap(e, { lat: g.lat, lng: g.lng });
  });

  // small input dialog (window.prompt is not available in the desktop app)
  function ask(title, val, type = 'number') {
    return new Promise(res => {
      modal(`<h2>${escH(title)}</h2><div class="row"><input id="askIn" type="${type}" step="any" value="${escH(val)}" style="flex:1;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px"><button class="btn primary" id="askOk">OK</button></div>`);
      const inp = $('#askIn'); inp.focus(); inp.select();
      const done = ok => { const v = inp.value; closeModal(); res(ok ? (type === 'number' ? parseFloat(v) : v.trim()) : null); };
      $('#askOk').onclick = () => done(true); inp.onkeydown = e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    });
  }

  // ---- modes ----
  const hints = { wp: 'Клик — новая точка · тащите точку — переместить · правый клик — меню', poi: 'Клик по карте — поставить точку интереса (POI), на которую будет смотреть камера', home: 'Клик по карте — поставить точку взлёта (H)', area: 'Клик — вершина зоны картирования · правый клик по вершине — удалить · затем «Генераторы → Картирование»', line: 'Клик — точка линии (коридор / фасад)', pan: 'Режим просмотра: клики не ставят точки · правый клик — меню' };
  const hintText = () => !S.m.waypoints.length && S.mode === 'wp' ? '👆 Кликните по карте — появится первая точка маршрута. Правый клик — меню с вариантами' : hints[S.mode] || '';
  function setMode(m) {
    S.mode = m; $$('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    if (!moving) { $('#modeHint').textContent = hintText(); map.getContainer().style.cursor = m === 'pan' ? '' : 'crosshair'; }
    renderMap();
    if (m === 'area' || m === 'line') { openTool(m === 'area' ? 'grid' : (toolOpen === 'facade' ? 'facade' : 'corridor'), true); }
  }
  $('#modes').onclick = e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); };

  // =================== PANELS ===================
  // generic field helpers
  const opt = (o, v) => Object.entries(o).map(([k, n]) => `<option value="${k}" ${String(k) === String(v) ? 'selected' : ''}>${n}</option>`).join('');
  function fld(label, k, v, o = {}) {
    let inp;
    if (o.sel) inp = `<select data-k="${k}">${opt(o.sel, v)}</select>`;
    else if (o.unit) inp = `<span class="u"><input data-k="${k}" type="number" step="${o.step ?? 'any'}" ${o.min != null ? `min="${o.min}"` : ''} ${o.max != null ? `max="${o.max}"` : ''} value="${v ?? ''}" placeholder="${o.ph ?? ''}" ${o.dis ? 'disabled' : ''}><i>${o.unit}</i></span>`;
    else inp = `<input data-k="${k}" type="${o.type || 'number'}" step="any" value="${escH(v ?? '')}" placeholder="${o.ph ?? ''}" ${o.dis ? 'disabled' : ''}>`;
    const t = o.tip || o.title;
    return `<div class="f"><label>${label}${t ? ' ' + tip(t) : ''}</label>${inp}</div>`;
  }
  const readVal = el => el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : parseFloat(el.value)) : el.value;
  function syncForm(root, get) {
    $$('[data-k]', root).forEach(el => { if (el === document.activeElement) return; const v = get(el.dataset.k); if (v === undefined) return; if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? ''; });
  }

  // ---- Mission tab ----
  const tabM = $('#tab-mission');
  const droneOpts = Object.fromEntries(DRONES.map(d => [d.name, d.name]));
  function buildMission() {
    const s = S.m.settings;
    tabM.innerHTML = `
      <h3>Описание миссии ${tip('Левая панель описывает весь полёт целиком: дрон, длину, время, батарею и общие правила для всех точек.\nПараметры отдельной точки — в правой панели (кликните по точке).')}</h3>
      <div class="card sum" id="mSum"></div>
      <h3>Дрон и приложение ${tip('Выберите свой дрон — от него зависят размер кадра, время полёта и формат файла для экспорта.')}</h3>
      ${fld('Дрон', 'drone', s.drone, { sel: droneOpts })}
      ${fld('Выполнять в', 'target', s.target, { sel: { fly: 'DJI Fly (KMZ)', litchi: 'Litchi (CSV)', pilot: 'DJI Pilot 2 (KMZ)' }, tip: 'Приложение на пульте, в котором будет выполняться маршрут. Определяет формат экспорта.' })}
      <div class="note" id="droneNote"></div>
      <h3>Полёт ${tip('Общие правила полёта для всего маршрута.')}</h3>
      ${fld('Высоты считать', 'altMode', s.altMode, { sel: { takeoff: 'от точки взлёта', agl: 'над рельефом (AGL)' }, tip: '«От точки взлёта» — как в DJI Fly: 60 м = 60 м выше места взлёта.\n«Над рельефом» — 60 м над землёй под каждой точкой (удобно в горах); при экспорте пересчитывается.' })}
      ${fld('Траектория', 'pathMode', s.pathMode, { sel: { curved: 'Плавные кривые', straight: 'Прямые с остановками' }, tip: 'Плавные кривые — дрон пролетает точки по дуге без остановки (красиво для видео).\nПрямые — летит по прямой и останавливается в каждой точке.' })}
      ${fld('Крейсерская скорость', 'cruise', s.cruise, { unit: 'м/с', min: 0.5, max: 15, tip: 'Скорость на отрезках, где у точки скорость = 0. 5–8 м/с — спокойное видео.' })}
      ${fld('Макс. скорость', 'maxSpeed', s.maxSpeed, { unit: 'м/с', min: 1, max: 15, tip: 'Верхний предел скорости для всей миссии.' })}
      ${fld('Курс дрона', 'headingMode', s.headingMode, { sel: HEADING_MODES, tip: 'Куда повёрнут нос (и камера) дрона: по направлению полёта, на точку интереса (POI) или свой курс в каждой точке.' })}
      ${fld('Плавный доворот камеры', 'poiBlend', s.poiBlend ?? 3, { unit: 'с', min: 0, max: 15, tip: 'Камера никогда не «скачет». Если в точке меняется курс (точка со своим курсом после участка «по курсу», смена режима, переход на POI), дрон начинает плавно поворачиваться за столько секунд ДО точки и приходит в неё уже с нужным курсом. От POI он плавно отворачивается столько же секунд ПОСЛЕ точки. Поворот всегда идёт через «нос» дрона. 0 — к POI поворот прямо в точке, остальные — не быстрее чем за 1 с.' })}
      ${fld('Плавные повороты в полёте', 'poiPre', s.poiPre || 'off', { sel: { off: 'только в симуляции', on: 'да — добавлять доп. точки' }, tip: 'DJI Fly разворачивает дрон прямо в точке. Если включить, при записи на пульт и экспорте добавляются вспомогательные точки (без действий), чтобы настоящий дрон поворачивал так же, как в симуляции: перед точкой с новым курсом (свой курс, POI) он начинает поворот заранее, а от POI плавно отворачивается после точки. Длительность — «Плавный доворот камеры». Сам маршрут на карте не меняется.' })}
      ${fld('Камера (подвес)', 'gimbalMode', s.gimbalMode, { sel: GIMBAL_MODES, tip: 'Как меняется наклон камеры между точками: плавно, скачком в точке или всегда на POI.' })}
      ${fld('По завершении', 'finishAction', s.finishAction, { sel: FINISH, tip: 'Что сделает дрон после последней точки.' })}
      ${fld('При потере связи', 'rcLost', s.rcLost, { sel: { rth: 'Возврат домой', continue: 'Продолжить миссию' }, tip: 'Что делать, если пропал сигнал пульта. Безопаснее — «Возврат домой».' })}
      <h3>Значения для новых точек ${tip('С такими параметрами создаётся каждая новая точка. Уже поставленные точки не меняются. «Сбросить параметры» в меню точки возвращает её к этим значениям.')}</h3>
      ${fld('Высота', 'defAlt', s.defAlt, { unit: 'м' })}
      ${fld('Радиус кривой', 'defCurve', s.defCurve, { unit: 'м', min: 0, tip: 'Насколько плавно дрон огибает точку. 0 — острый угол.' })}
      ${fld('Наклон камеры', 'defGimbal', s.defGimbal, { unit: '°', min: -90, max: 60, tip: '0° — горизонт, −90° — строго вниз.' })}
      <h3>Безопасность ${tip('Ограничения, по которым вкладка «Проверка» предупреждает об опасных местах маршрута.')}</h3>
      ${fld('Предел высоты (закон)', 'legalAlt', s.legalAlt, { unit: 'м', tip: 'Во многих странах — 120 м над землёй.' })}
      ${fld('Мин. зазор над рельефом', 'minClear', s.minClear, { unit: 'м', tip: 'Если маршрут проходит ниже этого запаса над землёй — будет предупреждение. Здания и деревья не учитываются!' })}
      ${fld('Макс. удаление', 'maxDist', s.maxDist, { unit: 'м', tip: 'Предупреждать, если точка дальше этого расстояния от взлёта.' })}
      <h3>Погода на месте взлёта ${tip('Прогноз ветра у земли и на высоте 80–120 м (Open-Meteo).')}</h3>
      <div class="card wx" id="wx"><button class="btn sm" id="wxBtn">Загрузить прогноз ветра</button></div>
      <h3>Солнце и свет ${tip('Восход, закат, «золотой час» (мягкий тёплый свет — лучшее время для видео) и где будет солнце в выбранное время. Считается для места взлёта. Направление солнца можно показать на карте стрелкой.')}</h3>
      <div class="card" id="sunCard"></div>
      <h3>Заметки ${tip('Свободный текст — сохраняется вместе с маршрутом.')}</h3>
      <textarea id="notes" rows="3" style="width:100%;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px">${escH(S.m.notes)}</textarea>`;
    tabM.onchange = e => {
      const k = e.target.dataset.k; if (!k) return;
      Core.snap(); S.m.settings[k] = readVal(e.target);
      if (k === 'drone') { const d = Core.drone(); S.m.settings.target = d.apps; }
      Core.changed();
    };
    $('#notes').onchange = e => { S.m.notes = e.target.value; Core.changed(); };
    $('#wxBtn').onclick = loadWeather;
    $('#sunCard').addEventListener('click', e => { if (e.target.closest('#sunDateBtn')) { const d = $('#sunDate'); try { d.showPicker(); } catch (er) { d.focus(); d.click(); } return; } if (e.target.closest('#sunNow')) { e.target.closest('#sunNow').blur(); sunWhen = null; $('#sunCard')._h = null; renderSun(); } });
    // while the card shows «now», keep the time current
    setInterval(() => { if (!sunWhen && $('#sunCard') && !$('#sunCard').contains(document.activeElement)) renderSun(); }, 60000);
    $('#sunCard').addEventListener('change', e => { if (e.target.id === 'sunDate' || e.target.id === 'sunTime') {
        // time is typed in the chosen clock: «1730», «17:30», «9:05», «5:30 PM» are all accepted; kept inside as 24-hour «HH:MM»
        const now0 = new Date(), prevT = sunWhen ? sunWhen[1] : `${pad2(now0.getHours())}:${pad2(now0.getMinutes())}`, pt = Core.parseTime($('#sunTime').value);
        let tv = prevT; if (pt) tv = pad2(pt[0]) + ':' + pad2(pt[1]); else if (e.target.id === 'sunTime') toast(Core.fmtCfg().t === '12' ? 'Время — например 5:30 PM' : 'Время — в формате 24 часа, например 17:30');
        if (!$('#sunDate').value) return; sunWhen = [$('#sunDate').value, tv]; if ($('#sunCard').contains(document.activeElement)) document.activeElement.blur(); $('#sunCard')._h = null; renderSun(); } if (e.target.id === 'sunShow') { sunShow = e.target.checked; renderSun(); }
        if (e.target.id === 'sunFmtD' || e.target.id === 'sunFmtT') Core.setFmt(e.target.id === 'sunFmtD' ? { d: e.target.value } : { t: e.target.value }); });
    Core.on('fmt', () => { $('#sunCard')._h = null; renderSun(); refresh(); });
  }
  // ---- sun & light ----
  let sunWhen = null, sunShow = false, sunLayer = null;
  const FMT_D = [['text', '2 Nov 2026'], ['dmy', '02.11.2026'], ['ymd', '2026-11-02'], ['mdy', '11/02/2026']];
  const pad2 = n => String(n).padStart(2, '0');
  function renderSun() {
    const el = $('#sunCard'); if (!el) return;
    const p = Core.homePt() || { lat: map.getCenter().lat, lng: map.getCenter().lng };
    const now = new Date(), dStr = sunWhen ? sunWhen[0] : `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`, tStr = sunWhen ? sunWhen[1] : `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const [Y, M, D] = dStr.split('-').map(Number), [hh, mm] = tStr.split(':').map(Number), day0 = new Date(Y, M - 1, D).getTime(), at = new Date(Y, M - 1, D, hh, mm).getTime();
    const ev = Sun.day(day0, p.lat, p.lng), sp = Sun.pos(at, p.lat, p.lng);
    const T = ms => ms ? Core.fmtTime(ms) : '—', tShow = Core.hm(hh, mm), F = Core.fmtCfg();
    const tz = -new Date(at).getTimezoneOffset() / 60, tzLoc = Math.round(p.lng / 15), far = Math.abs(tzLoc - tz) >= 2;
    const rumb = h => ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'][Math.round(h / 45) % 8];
    const light = sp.alt < -6 ? 'ночь' : sp.alt < 0 ? 'сумерки (синий час)' : sp.alt < 6 ? 'золотой час' : sp.alt < 30 ? 'низкое солнце — длинные тени' : 'высокое солнце — короткие тени';
    const html = `<div class="row" style="gap:6px"><span class="sdate"><button type="button" class="btn sm" id="sunDateBtn" title="Выбрать дату">📅 ${Core.fmtDate(day0, false)}</button><input type="date" id="sunDate" value="${dStr}" tabindex="-1" aria-hidden="true"></span><input type="text" id="sunTime" value="${tShow}" maxlength="8" placeholder="${F.t === '12' ? '5:30 PM' : 'ЧЧ:ММ'}" title="${F.t === '12' ? 'Время, 12 часов (например 5:30 PM)' : 'Время, 24 часа (например 17:30)'}"><button type="button" class="btn sm${sunWhen ? '' : ' on'}" id="sunNow" title="${sunWhen ? 'Вернуть текущие дату и время' : 'Показано текущее время (обновляется каждую минуту)'}">⟲ Сейчас</button></div>
      <div class="row sunfmt"><label>Дата <select id="sunFmtD">${FMT_D.map(([v, t]) => `<option value="${v}" ${F.d === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label><label>Время <select id="sunFmtT"><option value="24" ${F.t === '24' ? 'selected' : ''}>24 ч (17:30)</option><option value="12" ${F.t === '12' ? 'selected' : ''}>12 ч (5:30 PM)</option></select></label></div>
      <div class="kv"><span>Восход / закат</span><b>${T(ev.rise)} / ${T(ev.set)}</b>
      <span>Золотой час утром</span><b>${T(ev.rise)}–${T(ev.gmEnd)}</b><span>Золотой час вечером</span><b>${T(ev.geStart)}–${T(ev.set)}</b>
      <span>Синий час</span><b>${T(ev.bmStart)}–${T(ev.rise)} · ${T(ev.set)}–${T(ev.beEnd)}</b>
      <span>Солнце в ${tShow}</span><b>${sp.alt > -0.8 ? `азимут ${Math.round(sp.az)}° ${rumb(sp.az)}, высота ${Math.round(sp.alt)}°` : 'под горизонтом'}</b><span>Свет</span><b>${light}</b></div>
      <label class="chk"><input type="checkbox" id="sunShow" ${sunShow ? 'checked' : ''}> показать направление солнца на карте</label>
      <div class="note">Время — по часам компьютера (UTC${tz >= 0 ? '+' : ''}${tz}).${far ? ` Место маршрута в другом часовом поясе (≈UTC${tzLoc >= 0 ? '+' : ''}${tzLoc}) — пересчитайте время.` : ''}</div>`;
    if (el._h !== html && !el.contains(document.activeElement)) { el.innerHTML = html; el._h = html; }
    const nb = $('#sunNow'); if (nb) { nb.classList.toggle('on', !sunWhen); nb.title = sunWhen ? 'Вернуть текущие дату и время' : 'Показано текущее время (обновляется каждую минуту)'; }
    if (sunLayer) { map.removeLayer(sunLayer); sunLayer = null; }
    if (sunShow && sp.alt > -0.8) {
      const r = Math.max(60, Math.min(800, 40000 / 2 ** (map.getZoom() - 10))), tip0 = Geo.dest(p, sp.az, r), sh = Geo.dest(p, sp.az + 180, r * 0.6);
      sunLayer = L.layerGroup([
        L.polyline([p, tip0], { color: '#ffb300', weight: 3, dashArray: '8 6', interactive: false }),
        L.marker(tip0, { interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="sunm">☀ ${Math.round(sp.alt)}°</div>` }) }),
        L.polyline([p, sh], { color: '#000', weight: 4, opacity: .45, interactive: true }).bindTooltip('Направление теней'),
      ]).addTo(map);
    }
  }
  function syncMission() {
    syncForm(tabM, k => S.m.settings[k]);
    const d = Core.drone();
    const fp = Camera.footprint(d, S.m.settings.defAlt);
    $('#droneNote').innerHTML = `Камера ${d.wPx}×${d.hPx}, обзор ${Math.round(fp.hfov)}°×${Math.round(fp.vfov)}° · полёт до ${d.flight} мин · подвес ${d.gMin}…${d.gMax}°<br>На ${S.m.settings.defAlt} м: кадр ${Math.round(fp.w)}×${Math.round(fp.h)} м, ${fp.gsd.toFixed(2)} см/пикс.`;
    if (document.activeElement !== $('#notes')) $('#notes').value = S.m.notes || '';
    $('#mSum').innerHTML = missionSummary();
  }
  function missionSummary() {
    const W = S.m.waypoints, s = S.m.settings, d = Core.drone();
    if (!W.length) return `<b>Маршрут пока пуст.</b><ol class="steps"><li>Кликните по карте — появится точка №1. Ещё клик — №2 и т.д.</li><li>Перетащите точку, чтобы переместить; правый клик — меню (удалить, тип, высота, камера…).</li><li>Кликните по точке — справа откроются её параметры.</li><li>Кнопка <b>3D</b> — посмотреть полёт и кадр камеры.</li></ol>`;
    const st = Core.stats(), v = Core.validate();
    const ne = v.filter(x => x.lvl === 'err').length, nw = v.filter(x => x.lvl === 'warn').length;
    const alts = W.map(w => w.alt), amin = Math.min(...alts), amax = Math.max(...alts);
    const bat = Math.round(st.battery);
    const nAct = W.reduce((a, w) => a + Core.actGroups(w.actions).length, 0);
    return `<div class="kv">
      <span>Дрон</span><b>${escH(d.name)} → ${escH(Core.targetName(s.target))}</b>
      <span>Точек маршрута</span><b>${W.length}${S.m.pois.length ? ` · POI ${S.m.pois.length}` : ''}</b>
      <span>Длина маршрута</span><b>${fmtD(st.dist)}${st.transit ? ` (+${fmtD(st.transit)} подлёт)` : ''}</b>
      <span>Время полёта</span><b>${fmtT(st.total || st.time)}</b>
      <span>Батарея</span><b class="${bat > 85 ? 'bad' : bat > 65 ? 'warnc' : 'okc'}">≈ ${bat}%${bat > 85 ? ' — не хватит!' : ''}</b>
      <span>Высота</span><b>${amin === amax ? r1(amin) : r1(amin) + '…' + r1(amax)} м ${s.altMode === 'agl' ? 'над рельефом' : 'от взлёта'}</b>
      <span>Взлёт</span><b>${S.m.home ? 'задан (H)' : 'не задан — считается от точки 1'}</b>
      <span>Действий в точках</span><b>${nAct || 'нет'}${st.photos ? ` · фото ≈ ${st.photos}` : ''}</b>
      ${S.m.rc ? `<span>Пульт DJI RC 2</span><b>связано с заданием на пульте ✎</b>` : ''}
      <span>Проверка</span><b class="${ne ? 'bad' : nw ? 'warnc' : 'okc'}" style="white-space:nowrap">${ne ? `⛔ ошибок: ${ne}` : nw ? `⚠ замечаний: ${nw}` : '✓ всё в порядке'}</b></div>`;
  }
  async function loadWeather() {
    const p = Core.homePt() || { lat: map.getCenter().lat, lng: map.getCenter().lng };
    $('#wx').innerHTML = 'Загрузка…';
    try {
      const j = await Maps.weather(p); const c = j.current, h = j.hourly;
      const dir = d => ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'][Math.round(d / 45) % 8];
      const lim = 10.7; // DJI level 5 wind resistance
      const bad = c.wind_gusts_10m > lim || h.wind_speed_120m[0] > lim;
      $('#wx').innerHTML = `<div class="kv">
        <span>Сейчас у земли</span><b>${c.wind_speed_10m} м/с ${dir(c.wind_direction_10m)}, порывы ${c.wind_gusts_10m}</b>
        <span>На 80 м / 120 м</span><b>${h.wind_speed_80m[0]} / ${h.wind_speed_120m[0]} м/с</b>
        <span>Температура</span><b>${c.temperature_2m} °C</b>
        <span>Облачность / осадки</span><b>${c.cloud_cover}% / ${c.precipitation} мм</b>
        <span>Видимость</span><b>${c.visibility != null ? Math.round(c.visibility / 1000) + ' км' : '—'}</b></div>
        <div class="note" style="color:${bad ? 'var(--err)' : 'var(--ok)'}">${bad ? '⚠ Ветер на высоте выше 10.7 м/с — полёт не рекомендуется' : '✓ Ветер в пределах для дронов DJI'}</div>
        <div class="note">Ветер на 120 м, ближайшие часы: ${h.wind_speed_120m.slice(0, 8).map(v => Math.round(v)).join(' · ')} м/с</div>
        <button class="btn sm" id="wxBtn">Обновить</button>`;
      $('#wxBtn').onclick = loadWeather;
    } catch (e) { $('#wx').innerHTML = 'Не удалось загрузить погоду <button class="btn sm" id="wxBtn">Повторить</button>'; $('#wxBtn').onclick = loadWeather; }
  }

  // ---- Points tab ----
  const tabP = $('#tab-points');
  function renderPoints() {
    const W = S.m.waypoints;
    if (!W.length) { tabP.innerHTML = '<div class="empty">Точек нет.<br>Кликните по карте — появится первая точка.</div>'; return; }
    let cum = 0;
    tabP.innerHTML = `<div class="row" style="position:sticky;top:0;background:var(--panel);z-index:3;padding:4px 0;margin:-4px 0 4px">
        <button class="btn sm" data-p="all">Выбрать все</button><button class="btn sm" data-p="rev">Развернуть</button>
        <button class="btn sm" data-p="up" title="Сдвинуть выбранные выше">▲</button><button class="btn sm" data-p="down" title="Ниже">▼</button>
        <button class="btn sm danger" data-p="del" title="Удалить выбранные">Удалить</button><button class="btn sm danger" data-p="clr">Удалить все</button>
        ${tip('Список всех точек по порядку полёта. Клик — выбрать точку, Shift+клик — диапазон, ⌘/Ctrl+клик — добавить к выбору. ▲▼ меняют порядок выбранных.')}</div>
      <table class="plist"><tr><th>#</th><th>Выс.</th><th>Скор.</th><th>Кам.</th><th>Действ.</th><th>Путь</th></tr>
      ${W.map((w, i) => { if (i) cum += Geo.dist(W[i - 1], w); return `<tr data-id="${w.id}" class="${S.sel.has(w.id) ? 'sel' : ''}"><td><b>${i + 1}</b></td><td>${r1(w.alt)}</td><td>${w.speed || '—'}</td><td>${Math.round(w.gimbal)}°</td><td>${w.actions.length || ''}${w.photoDist ? ' 📷' + w.photoDist + 'м' : w.photoTime ? ' 📷' + w.photoTime + 'с' : ''}</td><td>${fmtD(cum)}</td></tr>`; }).join('')}</table>`;
  }
  tabP.onclick = e => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) { selectWp(tr.dataset.id, e); const w = S.m.waypoints.find(x => x.id === tr.dataset.id); if (w && !map.getBounds().contains(w)) map.panTo(w); return; }
    const b = e.target.closest('[data-p]'); if (!b) return;
    const W = S.m.waypoints;
    if (b.dataset.p === 'all') { W.forEach(w => S.sel.add(w.id)); refresh(); }
    if (b.dataset.p === 'rev') Gen.reverse();
    if (b.dataset.p === 'del') deleteSel();
    if (b.dataset.p === 'clr' && confirm(`Удалить все ${W.length} точек маршрута?`)) clearAll('wp');
    if (b.dataset.p === 'up' || b.dataset.p === 'down') moveSel(b.dataset.p === 'up' ? -1 : 1);
  };
  function moveSel(dir) {
    const W = S.m.waypoints; if (!S.sel.size) return; Core.snap();
    const idx = W.map((w, i) => S.sel.has(w.id) ? i : -1).filter(i => i >= 0);
    if (dir < 0 && idx[0] === 0 || dir > 0 && idx[idx.length - 1] === W.length - 1) return;
    (dir < 0 ? idx : idx.reverse()).forEach(i => { const t = W[i + dir]; W[i + dir] = W[i]; W[i] = t; });
    Core.changed();
  }

  // ---- Tools tab ----
  const tabT = $('#tab-tools');
  let genCenter = null, toolOpen = null;
  const GP = Object.assign({ r1: 60, r2: 60, alt1: 40, alt2: 40, n: 12, revs: 1, dir: 1, start: 0, poiAlt: 0, video: true,
    galt: 60, front: 75, side: 65, angle: '', margin: 0, capture: 'distance', cross: false, oblique: -90, gspeed: '',
    ckind: 'dronie', caz: 180, cdist: 80, ch1: 5, ch2: 60, cvideo: true, cwidth: 60, calt: 60, fdist: 15, fh1: 5, fh2: 30, fside: 'right', fov1: 70, fov2: 70, tstep: 10, trot: 15, tscale: 110, talt: 5, tagl: 60, tdens: 50 }, Core.store.get('ws.gen', {}));
  function buildTools() {
    const s = v => GP[v];
    tabT.innerHTML = `
    <details class="card" data-tool="orbit"><summary>⟳ Орбита и спираль ${tip('Автоматически строит круг (или спираль) точек вокруг объекта. Центр — POI или клик по карте.')}</summary>
      <div class="note" id="orbCenter"></div>
      ${fld('Радиус начала', 'r1', s('r1'), { unit: 'м' })}${fld('Радиус конца', 'r2', s('r2'), { unit: 'м', title: 'Отличается от начального → спираль' })}
      ${fld('Высота начала', 'alt1', s('alt1'), { unit: 'м' })}${fld('Высота конца', 'alt2', s('alt2'), { unit: 'м' })}
      ${fld('Точек на виток', 'n', s('n'), { min: 3, max: 36 })}${fld('Витков', 'revs', s('revs'), { min: 0.25, step: 0.25 })}
      ${fld('Направление', 'dir', s('dir'), { sel: { 1: 'По часовой', '-1': 'Против часовой' } })}${fld('Старт (азимут)', 'start', s('start'), { unit: '°' })}
      ${fld('Высота объекта (POI)', 'poiAlt', s('poiAlt'), { unit: 'м', title: 'Куда целится камера: высота над землёй' })}
      <label class="chk"><input type="checkbox" data-k="video" ${s('video') ? 'checked' : ''}> Запись видео на всём облёте</label>
      <div class="row"><button class="btn primary sm" data-g="orbit-new">Создать маршрут</button><button class="btn sm" data-g="orbit-add">Добавить к текущему</button></div></details>

    <details class="card" data-tool="cine"><summary>🎬 Кинокадры ${tip('Готовые красивые пролёты, как в Drone Harmony, Dronelink и «умных» режимах DJI: улёт от объекта, «ракета», раскрытие вида, пролёт мимо, наезд. Объект — выбранный POI, выбранная точка или центр карты.')}</summary>
      <div class="note" id="cineCenter"></div>
      <div class="cinegrid">${[['dronie', '↗', 'Улёт (Dronie)', 'отлетает назад и вверх, камера на объекте'], ['rocket', '⇡', 'Ракета', 'вертикально вверх, камера вниз'], ['reveal', '◠', 'Раскрытие', 'летит вперёд, камера поднимается от земли к горизонту'], ['flyby', '⇢', 'Пролёт мимо', 'прямой пролёт сбоку, объект в кадре'], ['approach', '↙', 'Наезд', 'подлёт к объекту со снижением']].map(([k, i, t, d]) => `<button class="${GP.ckind === k ? 'on' : ''}" data-cine="${k}"><i>${i}</i><b>${t}</b><span>${d}</span></button>`).join('')}</div>
      ${fld('Направление от объекта', 'caz', s('caz'), { unit: '°', title: 'С какой стороны от объекта летит дрон: 0 — с севера, 90 — с востока, 180 — с юга, 270 — с запада' })}
      ${fld('Расстояние', 'cdist', s('cdist'), { unit: 'м' })}${fld('Высота начала', 'ch1', s('ch1'), { unit: 'м' })}${fld('Высота конца', 'ch2', s('ch2'), { unit: 'м' })}
      <label class="chk"><input type="checkbox" data-k="cvideo" ${s('cvideo') ? 'checked' : ''}> Запись видео на всём пролёте</label>
      <div class="row"><button class="btn primary sm" data-g="cine-new">Создать маршрут</button><button class="btn sm" data-g="cine-add">Добавить к текущему</button></div></details>

    <details class="card" data-tool="grid"><summary>▱ Картирование зоны (фотограмметрия) ${tip('Строит «змейку» над нарисованной зоной для съёмки карты/3D-модели с нужным перекрытием кадров.')}</summary>
      <div class="note" id="areaInfo"></div>
      <div class="row"><button class="btn sm" data-g="area-draw">Рисовать зону</button><button class="btn sm danger" data-g="area-clear">Очистить</button><button class="btn sm" data-g="area-view">Показать</button></div>
      ${fld('Высота съёмки', 'galt', s('galt'), { unit: 'м' })}${fld('Продольное перекрытие', 'front', s('front'), { unit: '%', min: 0, max: 95 })}
      ${fld('Поперечное перекрытие', 'side', s('side'), { unit: '%', min: 0, max: 95 })}${fld('Направление галсов', 'angle', s('angle'), { unit: '°', ph: 'авто' })}
      ${fld('Запас за границей', 'margin', s('margin'), { unit: 'м' })}${fld('Наклон камеры', 'oblique', s('oblique'), { unit: '°', title: '−90 — надир (ортофото); −45…−60 — наклонная съёмка для 3D' })}
      ${fld('Съёмка', 'capture', s('capture'), { sel: { distance: 'Интервал по расстоянию', time: 'Интервал по времени', waypoints: 'Фото в каждой точке' } })}
      ${fld('Скорость', 'gspeed', s('gspeed'), { unit: 'м/с', ph: 'авто' })}
      <label class="chk"><input type="checkbox" data-k="cross" ${s('cross') ? 'checked' : ''}> Двойная сетка (крест) — для 3D-моделей</label>
      <div class="card" id="gridInfo" style="display:none"></div>
      <div class="row"><button class="btn primary sm" data-g="grid">Создать маршрут</button></div></details>

    <details class="card" data-tool="corridor"><summary>╱ Коридор (дорога, река, ЛЭП) ${tip('Съёмка вдоль нарисованной линии полосой заданной ширины.')}</summary>
      <div class="note" id="lineInfo"></div>
      <div class="row"><button class="btn sm" data-g="line-draw">Рисовать линию</button><button class="btn sm danger" data-g="line-clear">Очистить</button></div>
      ${fld('Ширина коридора', 'cwidth', s('cwidth'), { unit: 'м' })}${fld('Высота', 'calt', s('calt'), { unit: 'м' })}
      <div class="note">Перекрытия берутся из «Картирования зоны».</div>
      <div class="row"><button class="btn primary sm" data-g="corridor">Создать маршрут</button></div></details>

    <details class="card" data-tool="facade"><summary>▤ Фасад / стена ${tip('Вертикальная «змейка» вдоль стены здания: несколько проходов на разной высоте.')}</summary>
      <div class="note">Нарисуйте линию из 2 точек вдоль основания стены (режим «Линия»).</div>
      ${fld('Расстояние до стены', 'fdist', s('fdist'), { unit: 'м' })}${fld('Высота от', 'fh1', s('fh1'), { unit: 'м' })}${fld('Высота до', 'fh2', s('fh2'), { unit: 'м' })}
      ${fld('Дрон с какой стороны', 'fside', s('fside'), { sel: { right: 'Справа от линии', left: 'Слева от линии' } })}
      ${fld('Перекрытие гориз.', 'fov1', s('fov1'), { unit: '%' })}${fld('Перекрытие верт.', 'fov2', s('fov2'), { unit: '%' })}
      <div class="row"><button class="btn primary sm" data-g="facade">Создать маршрут</button></div></details>

    <details class="card" data-tool="transform"><summary>✥ Трансформация маршрута ${tip('Сдвинуть, повернуть, растянуть или поднять весь маршрут (или выбранные точки) целиком.')}</summary>
      <div class="note">Применяется к выбранным точкам, а если ничего не выбрано — ко всему маршруту.</div>
      <div class="row">Сдвиг на ${fld('', 'tstep', s('tstep'), { unit: 'м' }).replace('class="f"', 'class="f" style="display:inline-grid;grid-template-columns:0 80px;margin:0"')}
        <button class="btn sm" data-g="mv-n">↑</button><button class="btn sm" data-g="mv-s">↓</button><button class="btn sm" data-g="mv-w">←</button><button class="btn sm" data-g="mv-e">→</button></div>
      ${fld('Поворот', 'trot', s('trot'), { unit: '°' })}<div class="row"><button class="btn sm" data-g="rot-l">⟲ против</button><button class="btn sm" data-g="rot-r">⟳ по часовой</button></div>
      ${fld('Масштаб', 'tscale', s('tscale'), { unit: '%' })}<div class="row"><button class="btn sm" data-g="scale">Масштабировать</button></div>
      ${fld('Изменить высоту на', 'talt', s('talt'), { unit: 'м' })}<div class="row"><button class="btn sm" data-g="alt-up">Выше</button><button class="btn sm" data-g="alt-dn">Ниже</button></div>
      ${fld('Следовать рельефу на', 'tagl', s('tagl'), { unit: 'м', title: 'Пересчитать высоты так, чтобы над землёй было столько метров' })}
      <div class="row"><button class="btn sm" data-g="terrain">Применить к высотам</button></div>
      ${fld('Добавить точки каждые', 'tdens', s('tdens'), { unit: 'м', title: 'Для точного следования рельефу на длинных отрезках' })}
      <div class="row"><button class="btn sm" data-g="densify">Уплотнить маршрут</button></div></details>`;
    tabT.onchange = e => { const k = e.target.dataset.k; if (!k) return; GP[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? (e.target.value === '' ? '' : parseFloat(e.target.value)) : e.target.value; Core.store.set('ws.gen', GP); gridPreview(); };
    tabT.addEventListener('toggle', e => { if (e.target.open) toolOpen = e.target.dataset.tool; }, true);
    tabT.onclick = e => {
      const k = e.target.closest('[data-cine]'); if (k) { GP.ckind = k.dataset.cine; Core.store.set('ws.gen', GP); $$('[data-cine]', tabT).forEach(b => b.classList.toggle('on', b === k)); return; }
      const b = e.target.closest('[data-g]'); if (b) runTool(b.dataset.g).catch(err => toast(err.message, 'err', 6000)); };
  }
  function openTool(name, keepMode) {
    switchTab('tools');
    $$('details[data-tool]', tabT).forEach(d => d.open = d.dataset.tool === name);
    toolOpen = name; syncTools();
  }
  function orbitCenter() {
    if (genCenter) return genCenter;
    const p = S.selPoi ? Core.poiById(S.selPoi) : null; if (p) return p;
    if (S.sel.size === 1) return S.m.waypoints[Core.wpIndex([...S.sel][0])];
    return { lat: map.getCenter().lat, lng: map.getCenter().lng };
  }
  function syncTools() {
    const c = orbitCenter();
    const src = genCenter ? 'точка из меню' : S.selPoi ? 'выбранный POI' : S.sel.size === 1 ? 'выбранная точка' : 'центр карты';
    if ($('#cineCenter')) $('#cineCenter').innerHTML = `Объект: <b>${src}</b> (${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}).`;
    $('#orbCenter').innerHTML = `Центр: <b>${src}</b> (${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}). Выберите POI или кликните правой кнопкой по карте → «Орбита вокруг».`;
    const A = S.m.area;
    $('#areaInfo').innerHTML = A.length ? `Зона: ${A.length} вершин, ${(Geo.polygonArea(A) / 10000).toFixed(2)} га` : 'Зона не задана. Нажмите «Рисовать зону» и кликайте по карте.';
    $('#lineInfo').innerHTML = S.m.line.length ? `Линия: ${S.m.line.length} точек, ${fmtD(S.m.line.reduce((s, p, i) => i ? s + Geo.dist(S.m.line[i - 1], p) : 0, 0))}` : 'Линия не задана.';
    gridPreview();
  }
  function gridParams() { return { poly: S.m.area, alt: GP.galt, front: GP.front, side: GP.side, angle: GP.angle === '' ? null : GP.angle, margin: GP.margin || 0, capture: GP.capture, cross: GP.cross, oblique: GP.oblique, speed: GP.gspeed || null }; }
  function gridPreview() {
    const box = $('#gridInfo'); if (!box) return;
    if (S.m.area.length < 3) { box.style.display = 'none'; return; }
    try {
      const r = Gen.grid(gridParams()); const i = r.info;
      let t = 0; for (let k = 1; k < r.wps.length; k++) t += Geo.dist(r.wps[k - 1], r.wps[k]) / i.speed;
      const d = Core.drone(); const bat = (t + 90) / (d.flight * 60 * .85) * 100;
      box.style.display = '';
      box.innerHTML = `<div class="kv"><span>GSD</span><b>${i.gsd.toFixed(2)} см/пикс</b><span>Кадр на земле</span><b>${Math.round(i.fw)}×${Math.round(i.fh)} м</b>
        <span>Между галсами / снимками</span><b>${r1(i.spacing)} / ${r1(i.photoStep)} м</b><span>Галсов</span><b>${i.lines}</b><span>Точек маршрута</span><b>${r.wps.length}</b>
        <span>Скорость</span><b>${r1(i.speed)} м/с</b><span>Снимков ≈</span><b>${i.photos}</b><span>Время ≈</span><b>${fmtT(t)}</b>
        <span>Батарея</span><b style="color:${bat > 85 ? 'var(--err)' : bat > 65 ? 'var(--warn)' : 'var(--ok)'}">${Math.round(bat)}%${bat > 85 ? ' — нужно ' + Math.ceil(bat / 80) + ' батареи' : ''}</b><span>Галсы по азимуту</span><b>${Math.round(i.angle)}°</b></div>${bat > 85 ? '<div class="note">Большую зону экспортируйте через «Экспорт → DJI Fly — разбить по батареям».</div>' : ''}`;
    } catch (e) { box.style.display = ''; box.textContent = e.message; }
  }
  async function runTool(g) {
    const M = (dx, dy) => Gen.translate(dx * GP.tstep, dy * GP.tstep);
    switch (g) {
      case 'orbit-new': case 'orbit-add': {
        const c = orbitCenter();
        const res = Gen.orbit({ center: c, r1: GP.r1, r2: GP.r2, alt1: GP.alt1, alt2: GP.alt2, n: GP.n, revs: GP.revs, dir: +GP.dir, start: GP.start, poiAlt: GP.poiAlt, video: GP.video, poiName: c.name });
        Gen.apply(res, g === 'orbit-new'); genCenter = null; toast(`Создано ${res.wps.length} точек облёта`, 'ok'); break;
      }
      case 'cine-new': case 'cine-add': {
        const c = orbitCenter(), names = { dronie: 'Улёт', rocket: 'Ракета', reveal: 'Раскрытие', flyby: 'Пролёт мимо', approach: 'Наезд' };
        const res = Gen.cine({ kind: GP.ckind, center: c, az: +GP.caz, dist: +GP.cdist, h1: +GP.ch1, h2: +GP.ch2, poiAlt: GP.poiAlt, video: GP.cvideo, poiName: c.name });
        Gen.apply(res, g === 'cine-new'); genCenter = null; toast(`Кинокадр «${names[GP.ckind]}»: ${res.wps.length} точек. Посмотрите его кнопкой ▶ или в 3D.`, 'ok', 6000); break;
      }
      case 'area-draw': setMode('area'); break;
      case 'line-draw': setMode('line'); break;
      case 'area-clear': Core.snap(); S.m.area = []; Core.changed(); break;
      case 'line-clear': Core.snap(); S.m.line = []; Core.changed(); break;
      case 'area-view': if (S.m.area.length) map.fitBounds(L.latLngBounds(S.m.area), { padding: [40, 40] }); break;
      case 'grid': { const r = Gen.grid(gridParams()); if (S.m.waypoints.length && !confirm('Заменить текущий маршрут сеткой картирования?')) return; Gen.apply(r, true); setMode('pan'); toast(`Маршрут картирования: ${r.wps.length} точек, GSD ${r.info.gsd.toFixed(2)} см/пикс`, 'ok'); break; }
      case 'corridor': { const r = Gen.corridor({ line: S.m.line, width: GP.cwidth, alt: GP.calt, side: GP.side, front: GP.front }); Gen.apply(r, true); setMode('pan'); toast(`Коридор: ${r.info.passes} прохода(ов)`, 'ok'); break; }
      case 'facade': { const r = Gen.facade({ line: S.m.line, dist: GP.fdist, h1: GP.fh1, h2: GP.fh2, side2: GP.fside, front: GP.fov1, side: GP.fov2 }); Gen.apply(r, true); setMode('pan'); toast(`Фасад: ${r.info.rows} рядов`, 'ok'); break; }
      case 'mv-n': M(0, 1); break; case 'mv-s': M(0, -1); break; case 'mv-w': M(-1, 0); break; case 'mv-e': M(1, 0); break;
      case 'rot-l': Gen.rotate(-GP.trot, true); break; case 'rot-r': Gen.rotate(GP.trot, true); break;
      case 'scale': Gen.scale(GP.tscale / 100); break;
      case 'alt-up': Gen.altOffset(GP.talt); break; case 'alt-dn': Gen.altOffset(-GP.talt); break;
      case 'terrain': await Gen.followTerrain(GP.tagl); toast('Высоты пересчитаны по рельефу', 'ok'); break;
      case 'densify': Gen.densify(GP.tdens); break;
    }
  }

  // ---- Library tab ----
  const tabL = $('#tab-library');
  function renderLibrary() {
    const lib = Object.values(Core.library()).sort((a, b) => b.updated - a.updated);
    tabL.innerHTML = `<div class="row"><button class="btn sm primary" data-l="save">Сохранить текущий</button><button class="btn sm" data-l="new">Новый</button><button class="btn sm" data-l="import">Импорт…</button><button class="btn sm" data-l="backup">Экспорт всех</button></div>
      <div class="note">Архив ваших маршрутов ${tip('Маршруты хранятся на этом компьютере. Клик по маршруту — открыть. Делайте резервную копию кнопкой «Экспорт всех».')} — хранится локально.</div>
      ${lib.length ? lib.map(m => `<div class="lib"><div class="n"><b>${escH(m.name)}</b><small>${(m.waypoints || []).length} точек · ${Core.fmtDate(m.updated)}</small></div>
        <button class="btn sm" data-open="${m.id}">Открыть</button><button class="btn sm" data-dup="${m.id}" title="Копия">⧉</button><button class="btn sm danger" data-del="${m.id}" title="Удалить">✕</button></div>`).join('') : '<div class="empty">Библиотека пуста</div>'}`;
  }
  tabL.onclick = e => {
    const b = e.target; const lib = Core.library();
    if (b.dataset.l === 'save') { Core.saveToLibrary(); toast('Сохранено в библиотеку', 'ok'); renderLibrary(); }
    if (b.dataset.l === 'new') cmd('new');
    if (b.dataset.l === 'import') cmd('import');
    if (b.dataset.l === 'backup') IO.download('waypoint-studio-backup.json', JSON.stringify(lib, null, 1), 'application/json');
    if (b.dataset.open) { Core.loadMission(JSON.parse(JSON.stringify(lib[b.dataset.open]))); toast('Открыт: ' + lib[b.dataset.open].name); }
    if (b.dataset.dup) { const m = JSON.parse(JSON.stringify(lib[b.dataset.dup])); m.id = Core.id() + Core.id(); m.name += ' (копия)'; m.updated = Date.now(); lib[m.id] = m; Core.store.set('ws.library', lib); renderLibrary(); }
    if (b.dataset.del && confirm('Удалить «' + lib[b.dataset.del].name + '» из библиотеки?')) { delete lib[b.dataset.del]; Core.store.set('ws.library', lib); renderLibrary(); }
  };

  // ---- Check tab ----
  const tabC = $('#tab-check');
  function renderCheck() {
    const v = Core.validate();
    const ne = v.filter(x => x.lvl === 'err').length, nw = v.filter(x => x.lvl === 'warn').length;
    const bd = $('#warnBadge'); bd.textContent = ne || nw || ''; bd.className = ne ? 'err' : nw ? 'warn' : '';
    const ic = { err: '⛔', warn: '⚠️', ok: '✅', info: 'ℹ️' };
    tabC.innerHTML = camCard() + `<h3>Предполётная проверка ${tip('Автоматическая проверка маршрута: высоты, рельеф, батарея, лимиты приложения. Клик по замечанию — показать точку на карте.')}</h3>${v.map(x => `<div class="w ${x.lvl}" ${x.i != null ? `data-i="${x.i}"` : ''}><span>${ic[x.lvl]}</span><span>${x.msg}</span></div>`).join('')}
      <h3>Источник рельефа</h3><div class="note">${Core.Elev.source}. Рельеф не учитывает здания, деревья и опоры ЛЭП — оставляйте запас.</div>
      <h3>Перед вылетом</h3><div class="note">• Проверьте зоны GEO на fly-safe.dji.com<br>• Обновите прошивку и калибровку компаса<br>• Сверьте маршрут в 3D / Google Earth<br>• Держите дрон в прямой видимости</div>`;
  }
  // camera state point by point, with ‹ › to step through the route; the chosen point is selected everywhere
  // (map, profile, panels, 3D)
  const ACT_NAME = a => ({ 0: `⏸ зависнуть ${((a.param || 0) / 1000).toFixed(0)} с`, 1: '📷 фото', 2: '⏺ начать запись', 3: '⏹ остановить запись', 4: `⟳ поворот ${Math.round(a.param || 0)}°`, 5: `↕ наклон камеры ${Math.round(a.param ?? 0)}°` })[a.type] || '•';
  function camCard() {
    const W = S.m.waypoints; if (!W.length) return '';
    const i = S.sel.size === 1 ? Math.max(0, Core.wpIndex([...S.sel][0])) : 0, w = W[i], rp = Core.recPlan()[i] || {};
    const G = Core.actGroups(w.actions), acts = G.map(g => g.kind === 'pano' ? `🌐 панорама 360° (${g.shots} кадров)` : ACT_NAME(g.a));
    const lost = (() => { let r = rp.in, n = 0; w.actions.forEach(a => { if (a.type === 2) r = true; if (a.type === 3) r = false; if (a.type === 1 && r && !a.g) n++; }); return n; })();
    const vid = rp.in && rp.out ? '<b class="recon">● идёт запись</b>' : rp.out ? '<b class="recon">● начинается запись</b>' : rp.in ? '<b>■ запись останавливается</b>' : '<b>выкл.</b>';
    const h = Core.effHeading(i), g = Core.effGimbal(i) ?? w.gimbal;
    return `<div class="camcard"><div class="cch"><button class="btn icon" data-cc="-1" ${i ? '' : 'disabled'} title="Предыдущая точка ( [ )">‹</button><b>Камера в точке ${i + 1} <small>из ${W.length}</small></b><button class="btn icon" data-cc="1" ${i < W.length - 1 ? '' : 'disabled'} title="Следующая точка ( ] )">›</button></div>
      <div class="kv"><span>Высота</span><b>${r1(Core.wpRel(w))} м</b><span>Наклон камеры</span><b>${Math.round(g)}°</b><span>Курс</span><b>${h != null ? Math.round(Geo.norm360(h)) + '°' : '—'}</b><span>Видео</span>${vid}
      <span>Действия</span><b>${acts.length ? acts.join('<br>') : 'нет'}</b>${w.photoTime || w.photoDist ? `<span>Фото по пути</span><b>${w.photoTime ? 'каждые ' + w.photoTime + ' с' : 'каждые ' + w.photoDist + ' м'}${rp.out ? ' — <span class="bad">пропустятся (запись)</span>' : ''}</b>` : ''}
      ${lost ? `<span>Внимание</span><b class="warnc">${lost} фото во время записи — камера их пропустит</b>` : ''}</div></div>`;
  }
  tabC.addEventListener('click', e => { const b = e.target.closest('[data-cc]'); if (!b) return; const W = S.m.waypoints, i0 = S.sel.size === 1 ? Core.wpIndex([...S.sel][0]) : 0, i = Math.max(0, Math.min(W.length - 1, i0 + +b.dataset.cc)); selectWp(W[i].id); map.panTo(W[i]); });
  tabC.onclick = e => { const w = e.target.closest('[data-i]'); if (w) { const x = S.m.waypoints[+w.dataset.i]; if (x) { selectWp(x.id); map.panTo(x); } } };

  // ---- tabs ----
  function switchTab(t) { $$('#ltabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); $$('#left .tab').forEach(s => s.classList.toggle('on', s.id === 'tab-' + t)); if (t === 'library') renderLibrary(); if (t === 'tools') syncTools(); }
  $('#ltabs').onclick = e => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); };


  let cur3d = null;
  Core.on('simtel', st => { const n = st ? st.c : null; if (!n && !cur3d) return; cur3d = n; drawProfile(profData); });
  // =================== FLIGHT TELEMETRY (right panel, during 2D/3D simulation) ===================
  const Tel = (() => {
    const box = document.createElement('div'); box.id = 'simTel'; box.hidden = true;
    $('#right').insertBefore(box, $('#insp'));
    let built = false, last = 0, pend = null, timer = null;
    const r1 = x => (Math.round(x * 10) / 10).toFixed(1);
    const fT = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const fD = m => m >= 1000 ? (m / 1000).toFixed(2) + ' км' : Math.round(m) + ' м';
    const rumb = h => ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'][Math.round(Geo.norm360(h) / 45) % 8];
    function build() {
      box.innerHTML = `<div class="head"><div class="num" style="background:#ffe14d">✈</div><b>Полёт</b> <span class="tsrc"></span> ${tip('Текущие параметры дрона и камеры во время симуляции. Обновляются в реальном времени, пока дрон летит по маршруту (в 2D и 3D). Полоса «участок» показывает продвижение между двумя соседними точками маршрута, «весь маршрут» — общий прогресс.')}<span class="tstate"></span></div>
        <div class="tseg"><b class="tlbl"></b><span class="tsegd"></span></div>
        <div class="tbar seg"><i></i><span class="tA"></span><span class="tB"></span></div>
        <div class="tseg sm"><span>Весь маршрут</span><span class="ttot"></span></div>
        <div class="tbar tot"><i></i><span class="ticks"></span></div>
        <div class="ttiles">
          <div><span>Над землёй</span><b data-v="agl"></b><small data-v="alt"></small></div>
          <div><span>Скорость</span><b data-v="v"></b><small data-v="vz"></small></div>
          <div><span>Курс</span><b data-v="hd"></b><small data-v="look"></small></div>
          <div><span>Подвес</span><b data-v="gb"></b><small data-v="zoom"></small></div>
        </div>
        ${['cam:📷 Кадр камеры', 'pos:📍 Положение', 'bat:🔋 Батарея и время'].map(x => { const [k, t] = x.split(':'); return `<details class="tsec" data-sec="${k}" ${secOpen(k) ? 'open' : ''}><summary>${t}<em data-v="sum_${k}"></em></summary><div data-body="${k}"></div></details>`; }).join('')}`;
      box.querySelector('[data-body=cam]').innerHTML = `<p><span>Кадр на земле</span><b data-v="fr"></b></p><p><span>Детализация</span><b data-v="gsd"></b></p><p><span>До центра кадра</span><b data-v="cd"></b></p><p><span>Цель камеры</span><b data-v="tgt"></b></p>`;
      box.querySelector('[data-body=pos]').innerHTML = `<p><span>Широта</span><b data-v="lat"></b></p><p><span>Долгота</span><b data-v="lng"></b></p><p><span>До точки взлёта</span><b data-v="home"></b></p>`;
      box.querySelector('[data-body=bat]').innerHTML = `<p><span>Израсходовано (оценка)</span><b data-v="bat"></b></p><p><span>Время полёта</span><b data-v="time"></b></p><p><span>Осталось до финиша</span><b data-v="rest"></b></p>`;
      box.addEventListener('toggle', e => { const d = e.target.closest && e.target.closest('details[data-sec]'); if (d) { const o = Core.store.get('ws.telSec', {}) || {}; o[d.dataset.sec] = d.open; Core.store.set('ws.telSec', o); } }, true);
      built = true;
    }
    const secOpen = k => { const o = Core.store.get('ws.telSec', {}) || {}; return o[k] ?? (k === 'cam'); };
    const set = (k, v) => { const e = box.querySelector(`[data-v="${k}"]`); if (e && e.textContent !== v) e.textContent = v; };
    function render(st) {
      if (!built) build();
      const { c, t, T, pts } = st, W = S.m.waypoints, n = W.length;
      box.querySelector('.tsrc').textContent = st.src === '3D' ? '· 3D' : '· 2D';
      const done = t >= T - 1e-6;
      box.querySelector('.tstate').textContent = done ? '✔ финиш' : st.playing ? '▶ летит' : '⏸ пауза';
      box.querySelector('.tstate').className = 'tstate ' + (done ? 'ok' : st.playing ? 'go' : 'pz');
      const wi = c.wi, wn = c.wn ?? Math.min(n - 1, wi + 1);
      // segment between waypoint wi and wn, measured along the flight path
      const pa = pts.find(p => p.wp === wi), pb = pts.find(p => p.wp === wn && !p.hold);
      const segLen = pa && pb ? Math.max(0, pb.d - pa.d) : 0, segDone = pa ? Math.max(0, Math.min(segLen, c.d - pa.d)) : 0;
      let lbl, frac;
      if (c.hold) { lbl = `Т.${wi + 1} · выполняет действия`; frac = 0; }
      else if (done || wi >= n - 1) { lbl = `Т.${n} · маршрут пройден`; frac = 1; }
      else if (pa && t < pa.t) { lbl = `Подлёт → Т.${wi + 1}`; frac = pa.t > 0 ? t / pa.t : 0; }
      else { lbl = `Т.${wi + 1} → Т.${wn + 1}`; frac = segLen > 0.05 ? segDone / segLen : (c.sf || 0); }
      frac = Math.max(0, Math.min(1, frac));
      box.querySelector('.tlbl').textContent = lbl;
      const left = Math.max(0, segLen - segDone), eta = pb ? Math.max(0, pb.t - t) : 0;
      box.querySelector('.tsegd').textContent = c.hold || done || wi >= n - 1 ? '' : `${Math.round(frac * 100)}% · осталось ${fD(left)} · ~${fT(eta)}`;
      box.querySelector('.tbar.seg i').style.width = (frac * 100).toFixed(1) + '%';
      box.querySelector('.tA').textContent = `Т.${wi + 1}`; box.querySelector('.tB').textContent = done || wi >= n - 1 ? '' : `Т.${wn + 1}`;
      const tf = T ? t / T : 0, Dt = pts.length ? pts[pts.length - 1].d || 0 : 0;
      box.querySelector('.ttot').textContent = `${fT(t)} / ${fT(T)} · ${fD(c.d || 0)} из ${fD(Dt)} · ${Math.round(tf * 100)}%`;
      box.querySelector('.tbar.tot i').style.width = (tf * 100).toFixed(1) + '%';
      const tk = box.querySelector('.ticks');
      if (tk.dataset.k !== T + ':' + n) { tk.dataset.k = T + ':' + n; tk.innerHTML = T ? pts.filter(p => p.wp != null && !p.hold).map(p => `<b style="left:${(p.t / T * 100).toFixed(2)}%" title="Т.${p.wp + 1}"></b>`).join('') : ''; }
      set('lat', c.lat.toFixed(6) + '°'); set('lng', c.lng.toFixed(6) + '°');
      set('agl', st.agl != null && isFinite(st.agl) ? Math.round(st.agl) + ' м' : '—'); set('alt', 'от взлёта ' + Math.round(c.alt) + ' м');
      const hp = Core.homePt(); set('home', hp ? fD(Geo.dist(hp, c)) : '—');
      set('v', r1(c.v || 0) + ' м/с'); set('vz', Math.abs(c.vz || 0) < 0.05 ? 'по высоте 0' : (c.vz > 0 ? '↑ ' : '↓ ') + r1(Math.abs(c.vz)) + ' м/с');
      set('hd', c.hd != null ? Math.round(Geo.norm360(c.hd)) + '°' : '—');
      const lp = SimCore.lookPoi(c); set('look', lp ? '◎ на ' + (lp.name || 'POI') : c.hd != null ? rumb(c.hd) : '');
      set('gb', c.gb != null ? Math.round(c.gb) + '°' : '—');
      const z = (W[wi] && W[wi].zoom) || 1; set('zoom', z > 1 ? 'зум ×' + z : 'зум ×1');
      const fm = Core.drone().flight, used = fm ? Math.min(100, Math.round((t + 30) / (fm * 60 * 0.85) * 100)) : null; // same model as «Батарея» in the totals (85% usable, take-off)
      set('bat', used != null ? `≈ ${used}%` : '—'); set('time', fT(t)); set('rest', fT(Math.max(0, T - t)));
      set('sum_bat', used != null ? `≈ ${used}% · ${fT(t)}` : fT(t)); set('sum_pos', hp ? fD(Geo.dist(hp, c)) + ' от взлёта' : '');
      set('tgt', lp ? `${lp.name || 'POI'} · ${fD(Geo.dist(c, lp))}` : 'по курсу');
      let fr = null; try { if (c.hd != null && c.gb != null && st.agl > 0.5) fr = Camera.frame(Core.drone(), c, st.agl, c.hd, c.gb, 1200); } catch (e) { fr = null; }
      if (fr) { const k = z > 1 ? z : 1; const fs = `${Math.round(fr.width / k)} × ${Math.round(fr.depth / k)} м`; set('fr', fs + (fr.clipped ? ' (до горизонта)' : '')); set('gsd', (fr.gsd / k).toFixed(1) + ' см/пикс'); set('cd', fD(fr.centerDist)); set('sum_cam', fs); }
      else { set('fr', st.agl != null && st.agl <= 0.5 ? 'на земле' : '—'); set('gsd', '—'); set('cd', '—'); set('sum_cam', ''); }
    }
    function show(st) {
      if (!st) { pend = null; clearTimeout(timer); timer = null; box.hidden = true; inspState(); return; }
      if (box.hidden) { box.hidden = false; inspState(); } pend = st;
      const now = performance.now();
      if (!st.playing || now - last > 80) { last = now; clearTimeout(timer); timer = null; render(st); }
      else if (!timer) timer = setTimeout(() => { timer = null; last = performance.now(); if (pend) render(pend); }, 90);
    }
    Core.on('simtel', show);
    // the point panel below is folded into one bar while the flight is shown (it repeats what the flight panel says)
    const bar = document.createElement('button'); bar.id = 'inspBar'; bar.hidden = true; $('#right').insertBefore(bar, $('#insp'));
    let inspOpen = !!Core.store.get('ws.inspInSim', false);
    function inspState() { const on = !box.hidden; bar.hidden = !on; document.body.classList.toggle('simon', on); $('#insp').classList.toggle('folded', on && !inspOpen); bar.textContent = (inspOpen ? '▾ ' : '▸ ') + 'Параметры точки маршрута'; }
    bar.onclick = () => { inspOpen = !inspOpen; Core.store.set('ws.inspInSim', inspOpen); inspState(); };
    return { show, get visible() { return !box.hidden; } };
  })();

  // =================== INSPECTOR ===================
  const insp = $('#insp'); let inspKey = '';
  function renderInspector() {
    if (S.selPoi && !Core.poiById(S.selPoi)) S.selPoi = null; if (S.selHome && !S.m.home) S.selHome = false;
    const key = S.selHome ? 'home' : S.selPoi ? 'poi' + S.selPoi : S.sel.size === 1 ? 'wp' + [...S.sel][0] + ':' + S.m.waypoints.find(w => S.sel.has(w.id))?.actions.length + (S.m.waypoints.find(w => S.sel.has(w.id))?.hm || '') + (S.m.waypoints.find(w => S.sel.has(w.id))?.gkeep ? 'k' : '') + S.m.settings.headingMode + S.m.pois.length + S.m.settings.altMode : S.sel.size > 1 ? 'multi' + S.sel.size + S.m.pois.length : 'none' + S.m.waypoints.length;
    if (key !== inspKey) { inspKey = key; buildInspector(); }
    syncInspector();
  }
  function buildInspector() {
    const s = S.m.settings;
    if (S.selHome) {
      insp.innerHTML = `<div class="head"><div class="num" style="background:#fff">H</div><b>Точка взлёта</b> ${tip('Место, откуда взлетает дрон. От неё считаются высоты (режим «от взлёта»), подлёт и возврат домой.')}</div>
        ${fld('Широта', 'lat', 0, {})}${fld('Долгота', 'lng', 0, {})}<div class="kv" id="hInfo"></div>
        <div class="row"><button class="btn sm" id="hMove">✥ Переместить</button><button class="btn sm" id="hConv">⇄ В точку маршрута</button><button class="btn sm danger" id="hDel">🗑 Удалить</button></div>
        <div class="note">От точки взлёта отсчитываются высоты (режим «от взлёта») и рассчитывается подлёт и возврат.</div>`;
      insp.onchange = e => { const k = e.target.dataset.k; if (!S.m.home || !k) return; Core.snap(); S.m.home[k] = readVal(e.target); Core.changed(); };
      $('#hDel').onclick = () => { Core.snap(); S.m.home = null; S.selHome = false; Core.changed(); undoToast('Точка взлёта удалена'); };
      $('#hMove').onclick = () => startMove('home'); $('#hConv').onclick = () => convert('home', null, 'wp');
      return;
    }
    if (S.selPoi) {
      insp.innerHTML = `<div class="head"><div class="num" style="background:var(--poi)">◎</div><b>Точка интереса (POI)</b> ${tip('Объект, на который смотрит камера. Привяжите к нему точки маршрута (поле «Точка интереса» у точки) или нажмите «Все точки смотрят сюда».')}</div>
        ${fld('Название', 'name', '', { type: 'text' })}${fld('Широта', 'lat', 0)}${fld('Долгота', 'lng', 0)}${fld('Высота над землёй', 'alt', 0, { unit: 'м', tip: 'На какой высоте над землёй находится объект, куда смотрит камера (например, верх здания).' })}
        <div class="kv" id="pInfo"></div>
        <div class="row"><button class="btn sm" id="pAll">◎ Все точки смотрят сюда</button><button class="btn sm" id="pOrb">⟳ Орбита…</button></div>
        <div class="row"><button class="btn sm" id="pMove">✥ Переместить</button><button class="btn sm" id="pConv">⇄ В точку маршрута</button><button class="btn sm danger" id="pDel">🗑 Удалить</button></div>`;
      const pid = S.selPoi;
      insp.onchange = e => { const p = Core.poiById(pid), k = e.target.dataset.k; if (!p || !k) return; Core.snap(); p[k] = readVal(e.target); Core.changed(); };
      $('#pDel').onclick = () => delPoi(S.selPoi);
      $('#pMove').onclick = () => startMove('poi', S.selPoi); $('#pConv').onclick = () => convert('poi', S.selPoi, 'wp');
      $('#pOrb').onclick = () => { genCenter = Core.poiById(S.selPoi); openTool('orbit'); };
      $('#pAll').onclick = () => { Core.snap(); S.m.waypoints.forEach(w => w.poi = S.selPoi); s.headingMode = 'poi'; s.gimbalMode = 'poi'; Core.changed(); };
      return;
    }
    const poiOpts = Object.assign({ '': '— нет —' }, Object.fromEntries(S.m.pois.map(p => [p.id, p.name])));
    const actOpts = Object.fromEntries(ACTIONS.map(a => [a.t, a.name]));
    if (S.sel.size === 1) {
      const i = Core.wpIndex([...S.sel][0]), w = S.m.waypoints[i];
      insp.innerHTML = `<div class="head"><div class="num">${i + 1}</div><b>Точка маршрута</b> ${tip('Правая панель — параметры только выбранной точки. Изменения сразу видны на карте и в 3D. Общие настройки полёта — слева, во вкладке «Миссия».')}
          <div class="nav"><button class="btn sm" data-nav="-1" title="Предыдущая ([)">‹</button><button class="btn sm" data-nav="1" title="Следующая (])">›</button></div></div>
        <div class="row tools"><button class="btn sm" id="wMove" title="Точка будет следовать за мышью, клик — поставить">✥ Переместить</button><button class="btn sm" id="wReset" title="Вернуть высоту, камеру, скорость к значениям по умолчанию и убрать действия">↺ Сбросить</button>
          <select id="wConv" class="btn sm" title="Сменить тип точки"><option value="">⇄ Тип…</option><option value="poi">→ Точка интереса</option><option value="home">→ Точка взлёта</option></select><button class="btn sm danger" id="wDel" title="Удалить (Del)">🗑 Удалить</button></div>
        ${fld(s.altMode === 'agl' ? 'Высота над рельефом' : 'Высота от взлёта', 'alt', w.alt, { unit: 'м', tip: s.altMode === 'agl' ? 'Высота над землёй прямо под точкой.' : 'Высота над местом взлёта (как показывает DJI Fly).' })}
        <div class="kv" id="wInfo" style="margin:2px 0 8px"></div>
        ${fld('Наклон камеры', 'gimbal', w.gimbal, { unit: '°', min: -90, max: 60, dis: s.gimbalMode === 'poi' || w.gkeep, tip: '0° — горизонт, −90° — строго вниз. Жёлтая рамка на карте и в 3D показывает, что попадёт в кадр.' })}
        ${fld('Точка интереса', 'poi', w.poi || '', { sel: poiOpts, tip: 'Объект, на который будет смотреть камера в этой точке.' })}
        ${fld('Скорость (0 = крейсерская)', 'speed', w.speed, { unit: 'м/с', min: 0, max: 15, tip: 'Скорость на отрезке после этой точки. 0 — крейсерская из настроек миссии.' })}
        ${fld('Радиус кривой', 'curve', w.curve, { unit: 'м', min: 0, dis: s.pathMode !== 'curved', tip: 'Плавность поворота в точке. Работает в режиме «Плавные кривые».' })}
        ${fld('Курс в этой точке', 'hm', w.hm || '', { sel: { '': 'как в миссии (' + (HEADING_MODES[s.headingMode] || '').toLowerCase() + ')', auto: 'по направлению полёта', poi: 'на точку интереса', custom: 'задать угол', manual: 'вручную (пилот)' }, tip: 'DJI Fly позволяет задать режим курса отдельно для каждой точки. «Как в миссии» — общий режим слева.' })}
        ${fld('Курс' + ((w.hm || s.headingMode) !== 'custom' ? ' (авто)' : ''), 'heading', w.heading, { unit: '°', dis: (w.hm || s.headingMode) !== 'custom', tip: 'Куда смотрит нос дрона (0° — север, 90° — восток). Доступно, если курс в точке — «задать угол».' })}
        <label class="chk" style="margin:4px 0"><input type="checkbox" data-k="gkeep" ${w.gkeep ? 'checked' : ''}> Не менять наклон камеры в этой точке ${tip('Как в DJI Fly: камера сохраняет наклон с предыдущей точки, плавного поворота к этой точке нет.')}</label>
        ${fld('Зум камеры', 'zoom', w.zoom ?? '', { unit: '×', min: 1, max: 4, step: 0.1, ph: 'не менять', tip: 'Цифровой зум при подлёте к точке (как в DJI Fly). Пусто — не управлять зумом.' })}
        <details class="card"><summary>Координаты</summary>${fld('Широта', 'lat', w.lat)}${fld('Долгота', 'lng', w.lng)}</details>
        <h3>Съёмка на отрезке до след. точки ${tip('Автоматическая серия фото, пока дрон летит к следующей точке.')}</h3>
        <div class="row"><select data-k="photoMode" style="flex:1"><option value="none">Нет</option><option value="time">Фото каждые N секунд</option><option value="dist">Фото каждые N метров</option></select>
          <input data-k="photoVal" type="number" step="any" style="width:70px;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:4px"></div>
        <h3>Действия в точке ${tip('Что дрон делает, долетев до точки: фото, видео, пауза, поворот, наклон камеры. Выполняются по порядку. Панорама 360° — одно действие, но внутри неё много команд; DJI Fly допускает не более 15 команд в точке.')} <span style="float:right;text-transform:none">${Core.actGroups(w.actions).length} · команд ${w.actions.length}/15</span></h3>
        <div id="acts">${Core.actGroups(w.actions).map(g => g.kind === 'pano'
          ? `<div class="act pano" data-a="${g.from}" data-to="${g.to}"><span class="pn">🌐 Панорама 360° <small>${g.shots} кадров · ${g.to - g.from + 1} команд</small></span><button data-adel title="Удалить панораму целиком">✕</button></div>`
          : `<div class="act" data-a="${g.from}"><select data-ak="type">${opt(actOpts, g.a.type)}</select>
          <input data-ak="param" type="number" step="any" value="${g.a.param}" ${ACTIONS[g.a.type].unit ? '' : 'disabled'} title="${ACTIONS[g.a.type].unit}"><button data-adel title="Удалить">✕</button></div>`).join('')}</div>
        <div class="row"><select id="newAct" style="flex:1">${opt(actOpts, 1)}</select><button class="btn sm" id="addAct" ${w.actions.length >= 15 ? 'disabled' : ''}>+ Добавить</button></div>
        <div class="row"><button class="btn sm" data-q="1">📷</button><button class="btn sm" data-q="2">⏺ старт</button><button class="btn sm" data-q="3">⏹ стоп</button><button class="btn sm" data-q="0">⏸ 2с</button><button class="btn sm" data-q="pano">Панорама 360°</button></div>`;
      insp.onchange = e => {
        const el = e.target;
        if (el.id === 'wConv') { if (el.value) convert('wp', w.id, el.value); return; }
        if (el.dataset.ak) { const k = +el.closest('[data-a]').dataset.a; Core.snap(); w.actions[k][el.dataset.ak] = parseFloat(el.value); if (el.dataset.ak === 'type') w.actions[k].param = ACTIONS[w.actions[k].type].def; inspKey = ''; Core.changed(); return; }
        const k = el.dataset.k; if (!k) return; Core.snap();
        if (k === 'photoMode' || k === 'photoVal') {
          const mode = $('[data-k=photoMode]', insp).value, val = parseFloat($('[data-k=photoVal]', insp).value) || 0;
          w.photoTime = mode === 'time' ? (val || 3) : 0; w.photoDist = mode === 'dist' ? (val || 20) : 0;
        } else if (k === 'poi') w.poi = el.value || null;
        else if (k === 'hm') { if (el.value) w.hm = el.value; else delete w.hm; inspKey = ''; }
        else if (k === 'gkeep') { if (el.checked) w.gkeep = true; else delete w.gkeep; inspKey = ''; }
        else if (k === 'zoom') { const z = parseFloat(el.value); if (z >= 1) w.zoom = Math.min(4, z); else delete w.zoom; }
        else { const v = readVal(el); if (v != null && !isNaN(v)) w[k] = v; }
        Core.changed();
      };
      insp.onclick = e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.nav) { const n = S.m.waypoints[i + +b.dataset.nav]; if (n) { selectWp(n.id); map.panTo(n); } }
        if (b.id === 'wDel') deleteSel();
        if (b.id === 'wMove') startMove('wp', w.id);
        if (b.id === 'wReset') { batch(resetWp); toast('Параметры точки сброшены', '', 5000, { label: '↶ Отменить', fn: () => Core.undo() }); }
        if (b.id === 'addAct') { const t = +$('#newAct').value; Core.snap(); w.actions.push({ type: t, param: ACTIONS[t].def }); Core.changed(); }
        if (b.dataset.adel != null) { const r = b.closest('[data-a]'), k = +r.dataset.a, to = r.dataset.to != null ? +r.dataset.to : k; Core.snap(); w.actions.splice(k, to - k + 1); inspKey = ''; Core.changed(); }
        if (b.dataset.q != null) {
          Core.snap();
          if (b.dataset.q === 'pano') addPano(i);
          else { const t = +b.dataset.q; if (w.actions.length < 15) w.actions.push({ type: t, param: ACTIONS[t].def }); }
          Core.changed();
        }
      };
      return;
    }
    if (S.sel.size > 1) {
      insp.innerHTML = `<div class="head"><div class="num">${S.sel.size}</div><b>Выбрано точек</b> ${tip('Групповое редактирование: введённое значение применяется ко всем выбранным точкам. Выбор: Shift+рамка на карте, ⌘/Ctrl+клик, или Shift+клик в списке.')}<div class="nav"><button class="btn sm danger" id="wDel">🗑 Удалить</button></div></div>
        <div class="note">Пустое поле — значение не меняется. Изменение применяется ко всем выбранным.</div>
        ${fld('Высота =', 'alt', '', { unit: 'м', ph: '—' })}${fld('Высота + / −', 'altD', '', { unit: 'м', ph: '0' })}
        ${fld('Скорость', 'speed', '', { unit: 'м/с', ph: '—' })}${fld('Радиус кривой', 'curve', '', { unit: 'м', ph: '—' })}
        ${fld('Курс', 'heading', '', { unit: '°', ph: '—' })}${fld('Наклон камеры', 'gimbal', '', { unit: '°', ph: '—' })}
        ${fld('Точка интереса', 'poi', '_', { sel: Object.assign({ _: '— не менять —' }, poiOpts) })}
        ${fld('Фото каждые (м)', 'photoDist', '', { unit: 'м', ph: '—' })}${fld('Фото каждые (с)', 'photoTime', '', { unit: 'с', ph: '—' })}
        <div class="row"><select id="newAct" style="flex:1">${opt(actOpts, 1)}</select><button class="btn sm" id="addAct">+ всем</button></div>
        <div class="row"><button class="btn sm" id="clrAct">Очистить действия</button><button class="btn sm" id="eqAlt">Выровнять высоту по первой</button><button class="btn sm" id="rstAll">↺ Сбросить параметры</button></div>`;
      insp.onchange = e => {
        const k = e.target.dataset.k; if (!k) return; const v = readVal(e.target);
        if (k === 'poi') { if (v !== '_') batch(w => w.poi = v || null); return; }
        if (v == null || isNaN(v)) return;
        if (k === 'altD') batch(w => w.alt = r1(w.alt + v));
        else if (k === 'photoDist') batch(w => { w.photoDist = v; if (v > 0) w.photoTime = 0; });
        else if (k === 'photoTime') batch(w => { w.photoTime = v; if (v > 0) w.photoDist = 0; });
        else batch(w => w[k] = v);
        if (k === 'altD') e.target.value = ''; // a relative change is applied once; absolute values stay shown (synced below)
      };
      insp.onclick = e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.id === 'wDel') deleteSel();
        if (b.id === 'addAct') { const t = +$('#newAct').value; batch(w => w.actions.length < 15 && w.actions.push({ type: t, param: ACTIONS[t].def })); }
        if (b.id === 'clrAct') batch(w => w.actions = []);
        if (b.id === 'rstAll') { batch(resetWp); undoToast('Параметры сброшены'); }
        if (b.id === 'eqAlt') { const f = S.m.waypoints.find(w => S.sel.has(w.id)); batch(w => w.alt = f.alt); }
      };
      return;
    }
    insp.onchange = null; insp.onclick = null;
    insp.innerHTML = `<div class="empty"><b>Параметры точки</b> ${tip('Здесь появятся параметры точки, по которой вы кликнули на карте: высота, камера, скорость, действия.')}<br><br>
      <div class="howto"><div><b>Клик</b> по карте</div><span>новая точка маршрута</span>
      <div><b>Клик</b> по точке</div><span>её параметры здесь</span>
      <div><b>Тащить</b> точку</div><span>переместить</span>
      <div><b>Правый клик</b></div><span>меню: тип, высота, камера, удалить…</span>
      <div><b>Del</b></div><span>удалить выбранное</span>
      <div><b>⌘Z</b></div><span>отменить</span></div><br>
      <button class="btn sm" id="qOrbit">⟳ Быстрая орбита</button> <button class="btn sm" id="qArea">▱ Картирование</button><br><br>
      <span style="font-size:11px">Нажмите <kbd>?</kbd> для справки</span></div>`;
    $('#qOrbit').onclick = () => openTool('orbit'); $('#qArea').onclick = () => setMode('area');
  }
  function syncInspector() {
    if (S.selHome && S.m.home) {
      syncForm(insp, k => S.m.home[k]);
      const g = Core.groundAt(S.m.home); Core.Elev.request([S.m.home]);
      $('#hInfo').innerHTML = `<span>Высота рельефа</span><b>${g !== undefined ? Math.round(g) + ' м н.у.м.' : '…'}</b>`;
    } else if (S.selPoi) {
      const p = Core.poiById(S.selPoi); if (!p) return; syncForm(insp, k => p[k]);
      const g = Core.groundAt(p); Core.Elev.request([p]);
      $('#pInfo').innerHTML = `<span>Рельеф</span><b>${g !== undefined ? Math.round(g) + ' м' : '…'}</b><span>Точек смотрят сюда</span><b>${S.m.waypoints.filter(w => w.poi === p.id).length}</b>`;
    } else if (S.sel.size === 1) {
      const i = Core.wpIndex([...S.sel][0]), w = S.m.waypoints[i]; if (!w) return;
      syncForm(insp, k => k === 'heading' ? r1(Core.effHeading(i) ?? w.heading) : k === 'gimbal' ? r1(Core.effGimbal(i) ?? w.gimbal) : k === 'poi' ? (w.poi || '') : k === 'hm' ? (w.hm || '') : k === 'gkeep' ? !!w.gkeep : k === 'zoom' ? (w.zoom ?? '') : k === 'photoMode' ? (w.photoDist ? 'dist' : w.photoTime ? 'time' : 'none') : k === 'photoVal' ? (w.photoDist || w.photoTime || '') : k === 'lat' || k === 'lng' ? +w[k].toFixed(7) : w[k]);
      Core.Elev.request([w, Core.homePt()].filter(Boolean));
      const agl = Core.wpAGL(w), asl = Core.wpASL(w), W = S.m.waypoints;
      const next = W[i + 1], prev = W[i - 1];
      const RP = Core.recPlan(), rp = RP[i] || {}; let rec0 = -1; if (rp.in) { let k = i; while (k > 0 && RP[k].in) k--; rec0 = k; }
      $('#wInfo').innerHTML = `${rp.in || rp.out ? `<span>Видео</span><b class="recon">● ${rp.in && rp.out ? 'идёт запись' : rp.out ? 'запись начинается здесь' : 'запись останавливается здесь'}${rp.in && rec0 >= 0 ? ` (с Т.${rec0 + 1})` : ''}</b>` : ''}<span>Над землёй</span><b>${agl !== undefined ? r1(agl) + ' м' : '…'}</b>
        <span>${S.m.settings.altMode === 'agl' ? 'От взлёта' : 'Над уровнем моря'}</span><b>${S.m.settings.altMode === 'agl' ? r1(Core.wpRel(w)) : asl !== undefined ? Math.round(asl) : '…'} м</b>
        ${prev ? `<span>От предыдущей</span><b>${fmtD(Geo.dist(prev, w))}</b>` : ''}${next ? `<span>До следующей</span><b>${fmtD(Geo.dist(w, next))}, курс ${Math.round(Geo.bearing(w, next))}°</b>` : ''}
        ${Core.homePt() ? `<span>До взлёта</span><b>${fmtD(Geo.dist(Core.homePt(), w))}</b>` : ''}${(() => { try { const h = Core.effHeading(i), g = Core.effGimbal(i) ?? w.gimbal, a = agl !== undefined ? agl : Core.wpRel(w); if (h == null || !(a > 0.5)) return ''; const f = Camera.frame(Core.drone(), w, a, h, g, 1200), z = w.zoom || 1; return `<span>Кадр на земле</span><b>${Math.round(f.width / z)}×${Math.round(f.depth / z)} м${f.clipped ? ' (до горизонта)' : ''}</b><span>Детализация</span><b>${(f.gsd / z).toFixed(1)} см/пикс</b>`; } catch (e) { return ''; } })()}`;
    } else if (S.sel.size > 1) {
      // group editing: a field shows the value when all selected points share it, otherwise «разные»
      const W = S.m.waypoints, idx = W.map((w, i) => S.sel.has(w.id) ? i : -1).filter(i => i >= 0);
      const valOf = (k, i) => { const w = W[i]; return k === 'heading' ? r1(Core.effHeading(i) ?? w.heading) : k === 'gimbal' ? r1(Core.effGimbal(i) ?? w.gimbal) : k === 'alt' ? r1(w.alt) : k === 'poi' ? (w.poi || '') : (w[k] ?? 0); };
      $$('[data-k]', insp).forEach(el => {
        const k = el.dataset.k; if (k === 'altD' || el === document.activeElement) return;
        const vals = idx.map(i => valOf(k, i)), same = vals.length && vals.every(v => v === vals[0]);
        if (el.tagName === 'SELECT') { el.value = same && [...el.options].some(o => o.value === String(vals[0])) ? String(vals[0]) : '_'; return; }
        el.value = same ? vals[0] : ''; el.placeholder = same ? '—' : 'разные';
      });
    }
  }

  // =================== STATS & PROFILE ===================
  function renderStats() {
    const st = Core.stats(); const pr = Core.profile();
    const bcls = st.battery > 85 ? 'bad' : st.battery > 65 ? 'warnc' : '';
    const ccls = pr && pr.minClear !== undefined && pr.minClear < S.m.settings.minClear ? 'bad' : '';
    $('#stats').innerHTML = `<span>Точек<b>${st.n}</b></span><span>Маршрут<b>${fmtD(st.dist)}</b></span>${st.transit ? `<span class="x">Подлёт/возврат<b>${fmtD(st.transit)}</b></span>` : ''}
      <span>Время миссии<b>${fmtT(st.time)}</b></span><span class="x">Всего с взлётом<b>${fmtT(st.total || 0)}</b></span>
      <span class="${bcls}">Батарея<b>${st.n ? Math.round(st.battery) + '%' : '—'}</b></span><span class="x">Фото ≈<b>${st.photos}</b></span>
      <span>Макс. высота<b>${st.n ? Math.round(st.maxRel) + ' м' : '—'}</b></span>
      <span class="${ccls}">Мин. зазор<b>${pr && pr.minClear !== undefined ? r1(pr.minClear) + ' м' : '—'}</b></span>`;
    drawProfile(pr);
  }
  const cv = $('#profCanvas'); let profData = null;
  function drawProfile(pr) {
    profData = pr;
    const box = $('#profile'); if (box.classList.contains('hide')) return;
    const dpr = devicePixelRatio || 1, Wd = cv.clientWidth, Ht = cv.clientHeight; if (!Wd) return;
    cv.width = Wd * dpr; cv.height = Ht * dpr; const c = cv.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, Wd, Ht);
    c.font = '11px -apple-system, sans-serif';
    if (!pr) { c.fillStyle = '#8b98a5'; c.fillText('Профиль высот появится, когда в маршруте будет 2+ точки', 12, 22); return; }
    const sm = pr.samples, gh = pr.homeGround ?? 0, haveG = sm.some(s => s.ground !== undefined);
    const ys = sm.map(s => gh + s.alt).concat(sm.filter(s => s.ground !== undefined).map(s => s.ground));
    let ymin = Math.min(...ys), ymax = Math.max(...ys); const pad = Math.max(10, (ymax - ymin) * .12); ymin -= pad; ymax += pad;
    const L0 = 48, R0 = 10, T0 = 10, B0 = 20;
    const X = d => L0 + (Wd - L0 - R0) * d / (pr.total || 1), Y = v => T0 + (Ht - T0 - B0) * (1 - (v - ymin) / (ymax - ymin));
    // grid
    c.strokeStyle = '#2a3541'; c.fillStyle = '#8b98a5'; c.lineWidth = 1;
    const stepY = niceStep((ymax - ymin) / 4);
    for (let v = Math.ceil(ymin / stepY) * stepY; v <= ymax; v += stepY) { c.beginPath(); c.moveTo(L0, Y(v)); c.lineTo(Wd - R0, Y(v)); c.stroke(); c.fillText(Math.round(v) + ' м', 4, Y(v) + 4); }
    const stepX = niceStep(pr.total / 8);
    for (let d = 0; d <= pr.total; d += stepX) c.fillText(fmtD(d), X(d) - 10, Ht - 5);
    // terrain
    if (haveG) {
      c.beginPath(); c.moveTo(X(0), Y(ymin));
      sm.forEach(s => s.ground !== undefined && c.lineTo(X(s.d), Y(s.ground)));
      c.lineTo(X(pr.total), Y(ymin)); c.closePath();
      const gr = c.createLinearGradient(0, T0, 0, Ht); gr.addColorStop(0, '#8a6b3d'); gr.addColorStop(1, '#3b2d1a'); c.fillStyle = gr; c.fill();
      // min clearance band
      c.setLineDash([3, 4]); c.strokeStyle = '#ff5d5d88'; c.beginPath(); let st = false;
      sm.forEach(s => { if (s.ground === undefined) return; const y = Y(s.ground + S.m.settings.minClear); st ? c.lineTo(X(s.d), y) : (c.moveTo(X(s.d), y), st = true); }); c.stroke(); c.setLineDash([]);
    } else { c.fillStyle = '#8b98a5'; c.fillText('Загрузка рельефа…', L0 + 8, T0 + 14); }
    // flight line coloured by clearance
    c.lineWidth = 2.5;
    for (let k = 1; k < sm.length; k++) {
      const a = sm[k - 1], b = sm[k];
      c.strokeStyle = b.clear !== undefined && b.clear < S.m.settings.minClear ? (b.clear < 3 ? '#ff5d5d' : '#ffb020') : '#00c2ff';
      c.beginPath(); c.moveTo(X(a.d), Y(gh + a.alt)); c.lineTo(X(b.d), Y(gh + b.alt)); c.stroke();
    }
    // waypoints
    c.lineWidth = 1;
    sm.filter(s => s.wp != null).forEach(s => {
      const id = S.m.waypoints[s.wp] && S.m.waypoints[s.wp].id; const sel = S.sel.has(id);
      c.strokeStyle = '#ffffff33'; c.beginPath(); c.moveTo(X(s.d), Y(ymin)); c.lineTo(X(s.d), Y(gh + s.alt)); c.stroke();
      c.fillStyle = sel ? '#ffe14d' : s.wp === 0 ? '#3ccf7a' : '#00c2ff'; c.beginPath(); c.arc(X(s.d), Y(gh + s.alt), sel ? 6 : 4.5, 0, 7); c.fill();
      if (sm.length < 400 && S.m.waypoints.length < 60) { c.fillStyle = '#fff'; c.fillText(s.wp + 1, X(s.d) - 3, Y(gh + s.alt) - 8); }
    });
    // video recording: red band at the bottom of the chart where the camera is recording
    { const rp = Core.recPlan(), wd = []; sm.forEach(s => { if (s.wp != null && wd[s.wp] == null) wd[s.wp] = s.d; });
      let any = false;
      rp.forEach((r, i) => { if (!r.out || wd[i] == null) return; const d1 = wd[i + 1] ?? pr.total; const x0 = X(wd[i]), x1 = Math.max(x0 + 2, X(d1)); c.fillStyle = 'rgba(232,0,28,.9)'; c.fillRect(x0, Ht - B0 - 4, x1 - x0, 4); any = true; });
      if (any) { c.fillStyle = '#ff6b6b'; c.font = '600 10.5px -apple-system, sans-serif'; const i0 = rp.findIndex(r => r.out); c.fillText('● запись видео', X(wd[i0]) + 4, Ht - B0 - 8); } }
    // stretches without line of sight to the remote: magenta band at the top of the chart
    (LOS.result.blocked || []).filter(b => b.part === 'маршрут' && b.d0 != null).forEach(b => {
      const x0 = X(b.d0), x1 = Math.max(x0 + 3, X(b.d1)); c.fillStyle = 'rgba(217,70,239,.85)'; c.fillRect(x0, T0, x1 - x0, 5);
      c.fillStyle = 'rgba(217,70,239,.12)'; c.fillRect(x0, T0 + 5, x1 - x0, Ht - B0 - T0 - 5);
    });
    if ((LOS.result.blocked || []).some(b => b.part === 'маршрут')) { c.fillStyle = '#e879f9'; c.font = '11px -apple-system, sans-serif'; c.fillText('▬ нет прямой видимости пульта', Wd - R0 - 190, T0 + 16); }
    // the simulated drone (2D or 3D flight) moves along the profile with its current height above it
    const cur = Sim.cur || cur3d;
    if (cur && cur.d != null) {
      const x = X(Math.max(0, Math.min(pr.total, cur.d))), y = Y(gh + cur.alt);
      c.strokeStyle = '#ffe14d99'; c.lineWidth = 1; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(x, T0); c.lineTo(x, Ht - B0); c.stroke(); c.setLineDash([]);
      c.fillStyle = '#ffe14d'; c.strokeStyle = '#000'; c.lineWidth = 2; c.beginPath(); c.arc(x, y, 6.5, 0, 7); c.fill(); c.stroke();
      // heading arrow inside the dot is meaningless on a profile — show a small up/down tick for climbing/descending
      const txt = `${Math.round(cur.alt)} м`; c.font = '700 12px -apple-system, Helvetica, sans-serif';
      const tw = c.measureText(txt).width + 14, bh = 20; let bx = Math.max(L0, Math.min(Wd - R0 - tw, x - tw / 2)), by = Math.max(1, y - 12 - bh - 6);
      c.fillStyle = 'rgba(255,255,255,.92)'; c.beginPath(); if (c.roundRect) c.roundRect(bx, by, tw, bh, 7); else c.rect(bx, by, tw, bh); c.fill();
      c.beginPath(); c.moveTo(x - 5, by + bh); c.lineTo(x + 5, by + bh); c.lineTo(x, by + bh + 6); c.closePath(); c.fill();
      c.fillStyle = '#000'; c.textBaseline = 'middle'; c.fillText(txt, bx + 7, by + bh / 2 + 0.5); c.textBaseline = 'alphabetic'; c.font = '11px -apple-system, sans-serif';
    }
    profData.X = X; profData.Y = Y; profData.gh = gh;
  }
  function niceStep(x) { const p = 10 ** Math.floor(Math.log10(Math.max(x, 1e-6))); const n = x / p; return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p; }
  cv.addEventListener('mousemove', e => {
    if (!profData || !profData.X) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
    let best = null, bd = 1e9; profData.samples.forEach(s => { const d = Math.abs(profData.X(s.d) - x); if (d < bd) { bd = d; best = s; } });
    const tip = $('#profTip'); if (!best) return;
    tip.style.display = 'block'; tip.style.left = Math.min(x + 12, r.width - 200) + 'px'; tip.style.top = '8px';
    tip.innerHTML = `${fmtD(best.d)} · полёт ${Math.round(best.alt)} м от взлёта${best.ground !== undefined ? ` · рельеф ${Math.round(best.ground)} м · зазор <b>${r1(best.clear)} м</b>` : ''}`;
    hoverMk.setLatLng(best.p).addTo(map);
    scrubTo(best.d);
  });
  // moving the cursor over the height profile moves the simulated drone there (2D and 3D), while the flight is paused
  let scrubRq = 0, scrubD = null, scrubIdle = false;
  function scrubTo(d) {
    if (Sim.playing || (View3D.isOpen && View3D.playing) || S.m.waypoints.length < 2) return;
    if (!scrubIdle && !Tel.visible) scrubIdle = true; // no flight was shown before the hover
    scrubD = d; if (scrubRq) return;
    scrubRq = requestAnimationFrame(() => {
      scrubRq = 0; const tl = SimCore.build(); if (!tl || !tl.T) return;
      const P = tl.pts; let t = tl.T;
      for (let k = 1; k < P.length; k++) { const a = P[k - 1], b = P[k]; if (b.d >= scrubD && b.d > a.d) { t = a.t + (b.t - a.t) * (scrubD - a.d) / (b.d - a.d); break; } if (b.d >= scrubD && b.d === a.d && !b.hold) { t = b.t; break; } }
      if (scrubD <= 0) t = 0;
      if (View3D.isOpen) View3D.seek(t / tl.T); else Sim.seekT(t);
    });
  }
  const hoverMk = L.circleMarker([0, 0], { radius: 6, color: '#ffe14d', weight: 2, interactive: false });
  cv.addEventListener('mouseleave', () => { $('#profTip').style.display = 'none'; hoverMk.remove();
    // the drone was shown only for the hover: put everything back as it was
    if (scrubIdle) { scrubIdle = false; if (scrubRq) { cancelAnimationFrame(scrubRq); scrubRq = 0; } if (View3D.isOpen) View3D.stopSim(); else Sim.stop(); } });
  cv.addEventListener('click', e => {
    if (!profData || !profData.X) return; const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
    let best = null, bd = 1e9; profData.samples.filter(s => s.wp != null).forEach(s => { const d = Math.abs(profData.X(s.d) - x); if (d < bd) { bd = d; best = s; } });
    if (best && bd < 25) { const w = S.m.waypoints[best.wp]; selectWp(w.id, e); }
  });
  $('#profToggle').onclick = () => { $('#profile').classList.toggle('hide'); Core.store.set('ws.prof', !$('#profile').classList.contains('hide')); map.invalidateSize(); renderStats(); };
  if (Core.store.get('ws.prof', innerHeight > 600) === false) $('#profile').classList.add('hide');
  new ResizeObserver(() => { map.invalidateSize(); drawProfile(profData); }).observe($('#profile'));

  // =================== SIMULATION ===================
  const Sim = (() => {
    let tl = null, t = 0, playing = false, last = 0, mk = null;
    const build = () => SimCore.build();
    const at = tt => SimCore.at(tl, tt);
    function show() {
      if (!tl) return; const c = at(t); Sim.cur = c;
      if (!mk) mk = L.marker(c, { icon: L.divIcon({ className: '', html: `<div class="dronem">${DroneModel.svg(46)}</div>`, iconSize: [46, 46], iconAnchor: [23, 23] }), interactive: false, zIndexOffset: 3000 }).addTo(G.sim);
      mk.setLatLng(c); const el = mk.getElement(); if (el) el.querySelector('svg').style.transform = `rotate(${c.hd ?? 0}deg)`; // icon turned where the camera looks
      simFrame(c);
      lookLine(c);
      if (!simActive) { simActive = true; refresh(); }
      if ($('#simFollow').checked) map.panTo(c, { animate: false });
      $('#simSlider').value = Math.round(t / tl.T * 1000);
      const osd = $('#osd'); osd.hidden = false; osd.textContent = SimCore.osd(c, t, tl.T);
      // the same flight bubble as in 3D, attached to the drone on the map
      bub.hidden = false; bubLL = c; SimCore.bubble(bub, c, SimCore.camState(tl, c, t, +$('#simSpeed').value || 1)); placeBub();
      drawProfile(profData);
      Tel.show({ src: '2D', c, agl: aglOf(c), t, T: tl.T, pts: tl.pts, playing });
    }
    const aglOf = c => SimCore.agl(c);
    function frame(now) {
      if (!playing) return;
      const dt = (now - last) / 1000; last = now; t += dt * +$('#simSpeed').value;
      if (t >= tl.T) { t = tl.T; playing = false; $('#simPlay').textContent = '▶'; }
      show(); if (playing) requestAnimationFrame(frame);
    }
    function play(fromWp) {
      tl = build(); if (!tl) return toast('Нужно минимум 2 точки');
      if (fromWp != null) { const p = tl.pts.find(x => x.wp === fromWp); t = p ? p.t : 0; }
      else if (t >= tl.T) t = 0;
      if ((t === 0 || fromWp != null) && !$('#simFollow').checked) fit(); // start of the flight: the whole route on screen
      playing = true; last = performance.now(); $('#simPlay').textContent = '⏸'; requestAnimationFrame(frame);
    }
    function pause() { playing = false; $('#simPlay').textContent = '▶'; if (tl) show(); }
    function stop() { pause(); t = 0; tl = null; Sim.cur = null; if (mk) { G.sim.clearLayers(); mk = null; } fr = null; sight = null; markLook(null); $('#osd').hidden = true; bub.hidden = true; bubLL = null; $('#simSlider').value = 0; drawProfile(profData); Tel.show(null); if (simActive) { simActive = false; refresh(); } }
    const bub = document.createElement('div'); bub.className = 'v3bub b2d'; bub.hidden = true; map.getContainer().appendChild(bub);
    let bubLL = null;
    function placeBub() { if (!bubLL || bub.hidden) return; const q = map.latLngToContainerPoint(bubLL); bub.style.left = q.x + 'px'; bub.style.top = q.y + 'px'; }
    map.on('move zoom viewreset', placeBub);
    // camera aimed at a POI: thin orange line of sight from the drone to it, and the POI blinks
    let sight = null;
    function markLook(id) { document.querySelectorAll('.poiw.look').forEach(e => { if (e.dataset.poi !== id) e.classList.remove('look'); }); if (id) { const e = document.querySelector(`.poiw[data-poi="${id}"]`); if (e) e.classList.add('look'); } }
    function lookLine(c) {
      const lp = SimCore.lookPoi(c);
      if (!lp) { if (sight) { G.sim.removeLayer(sight); sight = null; } markLook(null); return; }
      if (!sight) sight = L.polyline([c, lp], { color: '#ff8a3d', weight: 1.2, dashArray: '5 4', opacity: .95, interactive: false }).addTo(G.sim); else sight.setLatLngs([c, lp]);
      markLook(lp.id);
    }
    // moving camera frame: footprint of the image for the drone's current position, heading, gimbal pitch and height above ground
    let fr = null;
    function simFrame(c) {
      if (Core.store.get('ws.frame3dOn', true) === false) { if (fr) { Object.values(fr).forEach(l => Array.isArray(l) ? l.forEach(x => G.sim.removeLayer(x)) : G.sim.removeLayer(l)); fr = null; } return; } // «Кадр» switched off (same switch as in 3D)
      if (c.hd == null || c.gb == null) return;
      const agl = aglOf(c);
      const f = Camera.frame(Core.drone(), c, agl, c.hd, c.gb, Camera.viewMax(agl)), C = f.corners;
      if (!fr) {
        const o = { interactive: false };
        fr = {
          poly: L.polygon(C, { ...o, color: '#4fd3ff', weight: 1, fillOpacity: .18 }).addTo(G.sim),
          top: L.polyline([C[0], C[1]], { ...o, color: '#ff2a2a', weight: 1.4 }).addTo(G.sim),
          rays: C.map(q => L.polyline([c, q], { ...o, color: '#4fd3ff', weight: 0.7, opacity: .85 }).addTo(G.sim)),
          ctr: L.circleMarker(f.center, { ...o, radius: 3, color: '#4fd3ff', weight: 1, fill: false }).addTo(G.sim),
          lbl: L.marker(f.center, { ...o, icon: L.divIcon({ className: '', iconSize: [0, 0], html: '' }) }).addTo(G.sim),
        };
      }
      fr.poly.setLatLngs(C); fr.top.setLatLngs([C[0], C[1]]); fr.rays.forEach((r, k) => r.setLatLngs([c, C[k]]));
      fr.ctr.setLatLng(f.center); fr.lbl.setLatLng(f.center);
      const le = fr.lbl.getElement(); if (le) le.innerHTML = ''; // frame data is in the right panel; the drone bubble carries the live values (same as 3D)
      if (mk) mk.setZIndexOffset(3000);
    }
    // the bottom controls drive the 3D flight when the 3D view is open, otherwise the 2D one
    $('#simPlay').onclick = () => { if (View3D.isOpen) return View3D.toggle(); playing ? pause() : play(S.sel.size === 1 && t === 0 ? Core.wpIndex([...S.sel][0]) : null); };
    $('#simSlider').oninput = e => { if (View3D.isOpen) return View3D.seek(e.target.value / 1000); if (!tl) tl = build(); if (!tl) return; t = tl.T * e.target.value / 1000; show(); };
    $('#simSpeed').onchange = e => View3D.setSpeed(+e.target.value);
    Core.on('sim3d', st => { if (!View3D.isOpen) return; $('#simPlay').textContent = st.playing ? '⏸' : '▶'; $('#simSlider').value = st.T ? Math.round(st.t / st.T * 1000) : 0; });
    Core.on('change', () => { if (tl) { const was = playing; tl = build(); if (!tl) stop(); else { t = Math.min(t, tl.T); if (!was) show(); } } });
    function seekT(tt) { tl = build(); if (!tl) return; t = Math.max(0, Math.min(tl.T, tt)); show(); }
    return { play, pause, stop, seekT, toggle: () => playing ? pause() : play(), cur: null, get playing() { return playing; } };
  })();

  // =================== DIALOGS ===================
  function modal(html, big) { $('#modalBody').innerHTML = html; $('#modal .box').classList.toggle('big', !!big); $('#modal .box').classList.remove('rc'); $('#modal').hidden = false; }
  function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }
  $('#modal').onclick = e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); };

  function settingsDlg() {
    const k = Maps.key();
    modal(`<h2>Настройки</h2>
      <h3>Ключ Google Maps API</h3>
      <div class="row"><input id="gkey" value="${escH(k)}" placeholder="AIza…" style="flex:1;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px"><button class="btn primary" id="gsave">Сохранить и перезапустить</button></div>
      <p class="note">Статус: ${Maps.googleReady ? '<b style="color:var(--ok)">Google Maps подключены</b>' : k ? `<b style="color:var(--err)">${escH(Maps.googleError || 'не загружены')}</b>` : 'ключ не задан — используются свободные карты Esri/OSM'}</p>
      <ol class="note" style="font-size:12.5px">
        <li>Откройте <a href="https://console.cloud.google.com/google/maps-apis/start" target="_blank" style="color:var(--acc)">Google Cloud Console → Maps Platform</a> и войдите своим Google-аккаунтом.</li>
        <li>Создайте проект и подключите платёжный аккаунт (карта нужна для верификации; личное использование обычно укладывается в бесплатный лимит Google — 10 000 загрузок карты в месяц для каждого API).</li>
        <li>Включите API: <b>Maps JavaScript API</b>, <b>Elevation API</b>, <b>Geocoding API</b> (опц. <b>Places API</b>, <b>Map Tiles API</b> для 3D).</li>
        <li>«Учётные данные» → «Создать ключ». Ограничьте его HTTP-источником <code>http://localhost:8765/*</code>. Сейчас программа работает по адресу <code>${location.origin}</code>.</li>
        <li>Вставьте ключ сюда.</li></ol>
      <h3>Ключ Cesium ion — 3D как в Litchi</h3>
      <div class="row"><input id="ionkey" value="${escH(Core.store.get('ws.ionkey', '') || '')}" placeholder="eyJhbGciOi…" style="flex:1;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px"><button class="btn primary" id="ionsave">Сохранить</button></div>
      <p class="note">Статус: ${(() => { const st = Core.store.get('ws.ionStatus', ''); const k = Core.store.get('ws.ionkey', ''); return !k ? 'ключ не задан — в 3D спутник Esri' : st === 'ok:google' ? '<b style="color:var(--ok)">работает: фотореалистичная 3D-модель Google</b>' : st === 'ok:bing' ? '<b style="color:var(--warn)">работает: снимки Bing и рельеф Cesium (модель Google для этого ключа недоступна)</b>' : st.startsWith('err:') ? `<b style="color:var(--err)">ключ не принят: ${escH(st.slice(4))}</b>` : 'проверится при открытии 3D'; })()}</p>
      <ol class="note" style="font-size:12.5px">
        <li>Зарегистрируйтесь бесплатно на <a href="https://ion.cesium.com/signup" target="_blank" style="color:var(--acc)">ion.cesium.com</a> (вход через Google тоже подходит).</li>
        <li>Откройте <a href="https://ion.cesium.com/tokens" target="_blank" style="color:var(--acc)">Access Tokens</a> и скопируйте «Default Token» (или создайте новый).</li>
        <li>В разделе <a href="https://ion.cesium.com/assetdepot" target="_blank" style="color:var(--acc)">Asset Depot</a> добавьте в «My Assets» ресурс <b>Google Photorealistic 3D Tiles</b>.</li>
        <li>Вставьте ключ сюда и откройте 3D.</li></ol>
      <h3>Спутниковые снимки Airbus / CNES и Vantor (Maxar)</h3>
      <p class="note">Свободные слои уже показывают эти снимки: «Спутник» Esri — в основном Vantor (Maxar) Vivid, Google — Airbus, CNES/Airbus и Maxar. Здесь можно подключить их напрямую по своему коммерческому ключу. CNES — это снимки спутников Pléiades и SPOT, их распространяет Airbus (OneAtlas).</p>
      <div class="f wide"><label>Ключ Airbus OneAtlas (API key) — <a href="https://account.foundation.oneatlas.airbus.com/" target="_blank" style="color:var(--acc)">получить</a></label><input id="airbusKey" type="password" value="${escH((Core.store.get('ws.img', {}) || {}).airbus || '')}" placeholder="88 символов" style="background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px"></div>
      <div class="f wide"><label>Ключ Vantor / Maxar (MGP, maxar-api-key) — <a href="https://developers.maxar.com/docs/streaming-basemap/quickstart-basemaps" target="_blank" style="color:var(--acc)">как получить</a></label><input id="maxarKey" type="password" value="${escH((Core.store.get('ws.img', {}) || {}).maxar || '')}" placeholder="ключ Maxar API" style="background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px"></div>
      <div class="row"><button class="btn primary" id="imgSave">Сохранить и проверить</button><span class="note" id="imgStatus"></span></div>
      <h3>Формат даты и времени</h3>
      <div class="row" style="gap:12px;flex-wrap:wrap"><label>Дата <select id="setFmtD">${FMT_D.map(([v, t]) => `<option value="${v}" ${Core.fmtCfg().d === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Время <select id="setFmtT"><option value="24" ${Core.fmtCfg().t === '24' ? 'selected' : ''}>24 часа (17:30)</option><option value="12" ${Core.fmtCfg().t === '12' ? 'selected' : ''}>12 часов (5:30 PM)</option></select></label></div>
      <p class="note">Действует во всей программе: окно «Солнце и свет», библиотека маршрутов, архивы пульта, телеметрия полёта.</p>
      <h3>Данные</h3>
      <div class="row"><button class="btn sm" id="clrElev">Очистить кэш рельефа</button><button class="btn sm" id="expAll">Резервная копия всего</button><button class="btn sm" id="impAll">Восстановить из копии…</button></div>`);
    $('#imgSave').onclick = async () => {
      const img = { airbus: $('#airbusKey').value.trim(), maxar: $('#maxarKey').value.trim() }; Core.store.set('ws.img', img);
      const st = $('#imgStatus'); st.textContent = 'Проверяю…';
      let r = {}; try { r = await fetch('/tp/config', { method: 'POST', headers: { 'X-WS-Token': window.WS_RC_TOKEN || '', 'Content-Type': 'application/json' }, body: JSON.stringify(img) }).then(x => x.json()); } catch (e) { r = { error: e.message }; }
      const msg = [];
      if (img.airbus) msg.push(r.airbus === 'ok' ? '✓ Airbus: ключ принят' : '✗ Airbus: ' + (r.airbus || r.error || 'нет ответа'));
      if (img.maxar) { try { const t = await fetch('https://api.maxar.com/basemaps/v1/ogc/wms?service=WMS&request=GetMap&version=1.3.0&layers=Maxar:Imagery&styles=&crs=EPSG:3857&bbox=12150000,1370000,12151000,1371000&width=64&height=64&format=image/jpeg&maxar_api_key=' + encodeURIComponent(img.maxar)); msg.push(t.ok && /image/.test(t.headers.get('content-type') || '') ? '✓ Maxar: ключ принят' : '✗ Maxar: ответ ' + t.status); } catch (e) { msg.push('✗ Maxar: нет связи или ключ не принят'); } }
      st.innerHTML = msg.join(' · ') || 'Ключи удалены'; renderLayList(); fillLayerSel();
    };
    $('#setFmtD').onchange = e => Core.setFmt({ d: e.target.value }); $('#setFmtT').onchange = e => Core.setFmt({ t: e.target.value });
    $('#ionsave').onclick = () => { Core.store.set('ws.ionkey', $('#ionkey').value.trim()); Core.store.set('ws.ionStatus', ''); toast('Ключ Cesium ion сохранён — перезапуск', 'ok'); setTimeout(() => location.reload(), 600); };
    $('#gsave').onclick = () => { Core.store.set('ws.gkey', $('#gkey').value.trim()); location.reload(); };
    $('#clrElev').onclick = () => { localStorage.removeItem('ws.elev'); toast('Кэш очищен — перезапуск'); setTimeout(() => location.reload(), 600); };
    $('#expAll').onclick = () => IO.download('waypoint-studio-full-backup.json', JSON.stringify({ library: Core.library(), current: S.m, gen: GP }, null, 1), 'application/json');
    $('#impAll').onclick = () => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.json'; i.onchange = async () => { try { const j = JSON.parse(await i.files[0].text()); const lib = Object.assign(Core.library(), j.library || j); Core.store.set('ws.library', lib); toast('Восстановлено маршрутов: ' + Object.keys(j.library || j).length, 'ok'); renderLibrary(); } catch (e) { toast('Ошибка: ' + e.message, 'err'); } }; i.click(); };
  }
  function helpDlg() {
    modal(`<h2>Справка Waypoint Studio</h2>
      <h3>Клавиши</h3><table class="note">
      <tr><td><kbd>W</kbd> <kbd>P</kbd> <kbd>H</kbd> <kbd>A</kbd> <kbd>L</kbd></td><td>режимы: точки, POI, взлёт, зона, линия</td></tr>
      <tr><td><kbd>Esc</kbd></td><td>режим просмотра, снять выделение</td></tr>
      <tr><td><kbd>Del</kbd> / <kbd>⌫</kbd></td><td>удалить выбранные точки</td></tr>
      <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>предыдущая / следующая точка</td></tr>
      <tr><td><kbd>←↑→↓</kbd> (+Shift)</td><td>сдвинуть выбранные на 1 м (10 м)</td></tr>
      <tr><td><kbd>PgUp</kbd> <kbd>PgDn</kbd></td><td>высота выбранных ±5 м</td></tr>
      <tr><td><kbd>⌘A</kbd> <kbd>⌘Z</kbd> <kbd>⇧⌘Z</kbd> <kbd>⌘S</kbd> <kbd>⌘O</kbd></td><td>выделить все, отмена, повтор, сохранить, открыть</td></tr>
      <tr><td><kbd>Пробел</kbd></td><td>симуляция полёта</td></tr></table>
      <h3>Как загрузить маршрут в DJI Fly (Mini 4 Pro, Air 3, Mini 5 Pro, Mavic 4 Pro…)</h3>
      <ol class="note"><li>В DJI Fly создайте любую миссию путевых точек (2 точки) и сохраните — она получит папку с ID.</li>
      <li>Экспорт → <b>DJI Fly (.kmz)</b>.</li>
      <li>Подключите пульт DJI RC / RC 2 (или телефон) к Mac кабелем. Для просмотра Android-файлов на Mac используйте <b>OpenMTP</b> или <b>Android File Transfer</b>.</li>
      <li>Откройте <code>Android/data/dji.go.v5/files/waypoint/&lt;ID&gt;/</code> и замените файл <code>&lt;ID&gt;.kmz</code> своим, сохранив имя.</li>
      <li>Перезапустите DJI Fly, откройте миссию и проверьте её на карте до взлёта.</li></ol>
      <h3>Android-версия (телефон, планшет, пульт DJI RC / RC 2)</h3>
      <ol class="note"><li>Экспортированные файлы сохраняются в <code>Загрузки/WaypointStudio</code>. «Экспорт → Отправить последний файл» — поделиться в Telegram, почту и т.п.</li>
      <li>На пульте DJI RC / RC 2 скопируйте KMZ файловым менеджером в <code>Android/data/dji.go.v5/files/waypoint/&lt;ID&gt;/</code> поверх файла существующей миссии (имя сохранить).</li>
      <li>KMZ, KML, CSV, GPX можно открыть в программе из файлового менеджера или через «Поделиться».</li>
      <li>☰ — панель миссии и инструментов, ⓘ — свойства выбранной точки, ◎ — моё местоположение, кнопка справа сверху — тип карты. Долгое нажатие на карте — меню.</li></ol>
      <h3>Litchi</h3><p class="note">Экспорт → <b>Litchi CSV</b>, затем в Litchi Mission Hub: Missions → Import. Скорость 0 = крейсерская. Курс и настройки миссии задаются в Litchi.</p>
      <h3>Google Earth</h3><p class="note">Экспорт → <b>KML</b> открывается в Google Earth Pro: 3D-траектория по абсолютным высотам и тур «▶ Виртуальный полёт» с видом из камеры.</p>
      <h3>Высоты и рельеф</h3><p class="note">Рельеф берётся из Google Elevation (если подключён ключ) или Open-Meteo (Copernicus DEM, ~90 м). Он не учитывает здания и деревья. Режим «над рельефом» пересчитывает высоты относительно точки взлёта при экспорте в DJI.</p>
      <p class="note">⚠ Ответственность за полёт несёт пилот. Соблюдайте местные правила: в Вьетнаме полёты требуют разрешения, лимиты высоты и зоны запретов строго соблюдаются.</p>`);
  }
  function view3D() {
    if (View3D.isOpen) { View3D.close(); $('#simPlay').textContent = '▶'; $('#simSlider').value = 0; return; }
    Sim.stop();
    if (!S.m.waypoints.length) toast('Маршрут пуст — правый клик по земле в 3D → «Точку маршрута»');
    View3D.open();
  }

  // =================== COMMANDS ===================
  function closeMenus() { $$('.menu.open').forEach(m => m.classList.remove('open')); }
  $$('.menu > .btn').forEach(b => b.onclick = e => { e.stopPropagation(); const m = b.parentElement, o = m.classList.contains('open'); closeMenus(); if (!o) m.classList.add('open'); });
  document.addEventListener('click', e => { if (!e.target.closest('.menu')) closeMenus(); });
  async function cmd(c) {
    closeMenus();
    switch (c) {
      case 'new': if (S.m.waypoints.length && !confirm('Создать новый маршрут? Текущий останется в библиотеке.')) return; if (S.m.waypoints.length) Core.saveToLibrary(); Core.loadMission(Core.newMission()); break;
      case 'save': Core.saveToLibrary(); toast('Сохранено в библиотеку: ' + S.m.name, 'ok'); break;
      case 'saveFile': IO.exportAs('json'); break;
      case 'import': $('#fileIn').click(); break;
      case 'undo': Core.undo(); break; case 'redo': Core.redo(); break;
      case 'shareLast': if (IO.lastSaved && window.AndroidBridge) AndroidBridge.share(IO.lastSaved.uri, IO.lastSaved.mime); else toast('Сначала экспортируйте файл'); break;
      case 'clearWp': if (S.m.waypoints.length && confirm(`Удалить все ${S.m.waypoints.length} точек маршрута?`)) clearAll('wp'); break;
      case 'clearAll': if (confirm('Очистить всё: точки, POI, взлёт, зоны?')) clearAll('all'); break;
      case 'sendRC': RCBridge.open(); break;
      case 'settings': settingsDlg(); break; case 'help': helpDlg(); break; case 'view3d': view3D(); break;
    }
  }
  $$('[data-cmd]').forEach(b => b.addEventListener('click', () => cmd(b.dataset.cmd)));
  $$('[data-exp]').forEach(b => b.addEventListener('click', async () => {
    closeMenus();
    const v = Core.validate().filter(x => x.lvl === 'err');
    if (v.length && !confirm('Есть критичные замечания:\n• ' + v.map(x => x.msg).slice(0, 5).join('\n• ') + '\n\nВсё равно экспортировать?')) { switchTab('check'); return; }
    try { await IO.exportAs(b.dataset.exp); if (!window.AndroidBridge && !window.WS_DESKTOP) toast('Файл сохранён в «Загрузки»', 'ok'); } catch (e) { toast('Ошибка экспорта: ' + e.message, 'err', 6000); }
  }));
  $('#fileIn').onchange = async e => {
    for (const f of e.target.files) {
      try {
        const m = await IO.importFile(f);
        if (S.m.waypoints.length) Core.saveToLibrary();
        Core.loadMission(m); toast(`Импортировано: ${f.name} — ${m.waypoints.length} точек`, 'ok');
        if (m.area && m.area.length && !m.waypoints.length) { openTool('grid'); toast('Импортирована зона — настройте картирование'); }
      } catch (err) { toast(`${f.name}: ${err.message}`, 'err', 7000); }
    }
    e.target.value = '';
  };
  // drag & drop files on the window
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) { const dt = new DataTransfer(); [...e.dataTransfer.files].forEach(f => dt.items.add(f)); $('#fileIn').files = dt.files; $('#fileIn').onchange({ target: $('#fileIn') }); } });

  $('#mName').onchange = e => { S.m.name = e.target.value || 'Без названия'; Core.changed(); };

  // search
  let sT;
  $('#search').oninput = e => { clearTimeout(sT); const q = e.target.value; if (q.length < 3) { $('#searchRes').style.display = 'none'; return; } sT = setTimeout(async () => {
    try { const r = await Maps.search(q); $('#searchRes').innerHTML = r.length ? r.map((x, k) => `<div data-k="${k}">${escH(x.name)}</div>`).join('') : '<div>Ничего не найдено</div>'; $('#searchRes').style.display = 'block';
      $('#searchRes').onclick = ev => { const d = ev.target.closest('[data-k]'); if (!d) return; const x = r[+d.dataset.k]; map.setView([x.lat, x.lng], 17); $('#searchRes').style.display = 'none'; };
    } catch (err) { toast('Поиск недоступен', 'err'); } }, 450); };
  $('#search').onkeydown = e => { if (e.key === 'Enter') { const f = $('#searchRes [data-k]'); if (f) f.click(); } if (e.key === 'Escape') $('#searchRes').style.display = 'none'; };

  // keyboard
  document.addEventListener('keydown', e => {
    const ae = document.activeElement, inField = /INPUT|SELECT|TEXTAREA/.test(ae.tagName) && !/^(checkbox|radio|button|range|file)$/.test(ae.type || '');
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { if (inField) return; e.preventDefault(); e.shiftKey ? Core.redo() : Core.undo(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); cmd('save'); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); cmd('import'); return; }
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); cmd('new'); return; }
    if (inField) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); S.m.waypoints.forEach(w => S.sel.add(w.id)); refresh(); return; }
    if (mod) return;
    const k = e.key;
    const modes = { w: 'wp', p: 'poi', h: 'home', a: 'area', l: 'line', ц: 'wp', з: 'poi', р: 'home', ф: 'area', д: 'line' };
    if (modes[k.toLowerCase()]) { setMode(modes[k.toLowerCase()]); return; }
    if (k === 'Escape') { if (moving) return endMove(false); if (simActive) { Sim.stop(); return; } if (!$('#modal').hidden) return closeModal(); if (!ctx.hidden) return hideCtx(); S.sel.clear(); S.selPoi = null; S.selHome = false; genCenter = null; if (S.mode === 'area' || S.mode === 'line') setMode('wp'); refresh(); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); if (S.sel.size) deleteSel(); else if (S.selPoi) delPoi(S.selPoi); else if (S.selHome) { Core.snap(); S.m.home = null; S.selHome = false; Core.changed(); undoToast('Точка взлёта удалена'); } return; }
    if (k === ' ') { e.preventDefault(); View3D.isOpen ? View3D.toggle() : Sim.toggle(); return; }
    if (k === '?' || k === ',') { helpDlg(); return; }
    if (k === '[' || k === ']' || k === 'х' || k === 'ъ') { const W = S.m.waypoints; if (!W.length) return; let i = S.sel.size ? Core.wpIndex([...S.sel][0]) : -1; i = Math.max(0, Math.min(W.length - 1, i + (k === '[' || k === 'х' ? -1 : 1))); selectWp(W[i].id); map.panTo(W[i]); return; }
    if (k.startsWith('Arrow') && S.sel.size) { e.preventDefault(); const st = e.shiftKey ? 10 : 1; Gen.translate(k === 'ArrowLeft' ? -st : k === 'ArrowRight' ? st : 0, k === 'ArrowUp' ? st : k === 'ArrowDown' ? -st : 0); return; }
    if ((k === 'PageUp' || k === 'PageDown') && S.sel.size) { e.preventDefault(); Gen.altOffset(k === 'PageUp' ? 5 : -5); return; }
  });

  // =================== RENDER LOOP ===================
  let rq = false, fitNext = false;
  function refresh() { if (rq) return; rq = true; requestAnimationFrame(() => { rq = false; renderAll(); }); }
  function renderAll() {
    $('#mName').value = S.m.name;
    if (!moving) $('#modeHint').textContent = hintText();
    renderMap(); syncMission(); renderSun(); renderPoints(); renderInspector(); renderStats(); renderCheck();
    if ($('#tab-tools').classList.contains('on')) syncTools();
    $('[data-cmd=undo]').disabled = !S.undo.length; $('[data-cmd=redo]').disabled = !S.redo.length;
    if (fitNext) { fitNext = false; fit(); }
    document.title = S.m.name + ' — Waypoint Studio';
    Core.emit('rendered');
  }
  function fit() {
    const pts = S.m.waypoints.concat(S.m.pois, S.m.area, S.m.home ? [S.m.home] : []);
    if (pts.length) map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lng])), { padding: [50, 50], maxZoom: 18 });
  }
  Core.on('change', o => { if (o && o.fit) { fitNext = true; inspKey = ''; buildMission(); } refresh(); });
  let eT; Core.on('elev', () => { clearTimeout(eT); eT = setTimeout(refresh, 100); });

  // =================== INTERFACE: «Упрощённый» / «Полный» ===================
  // Упрощённый — для новичков: 4 шага «Маршрут → Камера → Проверка → На пульт», один «светофор» готовности,
  // большая кнопка записи, крупные ползунки высоты и камеры с готовыми значениями, шаблоны полётов, отметки
  // действий на шкале полёта, крупный шрифт, светлая тема по желанию и короткое знакомство при первом запуске.
  // Полный — прежний интерфейс со всеми инструментами. Маршрут и все данные общие: переключение ничего не меняет в полёте.
  const UI = (() => {
    let mode = Core.store.get('ws.ui', 'simple');
    const top = $('#top');
    // mode switch (always visible)
    const sw = document.createElement('div'); sw.className = 'uiseg'; sw.id = 'uiMode';
    sw.innerHTML = `<button data-ui="simple" title="Упрощённый вид: только главное, крупные кнопки и подсказки по шагам">🙂<span> Упрощённый</span></button><button data-ui="full" title="Полный вид: все инструменты, генераторы и форматы экспорта">🛠<span> Полный</span></button>`;
    top.insertBefore(sw, $('#mName'));
    sw.onclick = e => { const b = e.target.closest('[data-ui]'); if (b) set(b.dataset.ui, true); };
    // step bar + traffic light + big «write» button (simple mode only)
    const bar = document.createElement('div'); bar.id = 'steps'; bar.className = 'steps sonly';
    bar.innerHTML = `<button data-step="1"><i>1</i><span>Маршрут</span></button><b>›</b><button data-step="2"><i>2</i><span>Камера</span></button><b>›</b><button data-step="3"><i class="light"></i><span>Проверка</span></button><b>›</b><button data-step="4" class="go"><span></span></button>`;
    top.insertBefore(bar, $('#modes'));
    const theme = document.createElement('button'); theme.className = 'btn icon sonly'; theme.id = 'themeBtn';
    theme.onclick = () => { const l = !document.body.classList.contains('light'); document.body.classList.toggle('light', l); Core.store.set('ws.light', l); theme.textContent = l ? '☾' : '☀'; theme.title = l ? 'Тёмная тема' : 'Светлая тема (для яркого солнца)'; };
    $('#top .grp.right').insertBefore(theme, $('[data-cmd=settings]'));
    if (Core.store.get('ws.light', false)) { document.body.classList.add('light'); } theme.textContent = document.body.classList.contains('light') ? '☾' : '☀';

    bar.onclick = e => {
      const b = e.target.closest('[data-step]'); if (!b) return;
      const st = +b.dataset.step;
      if (st === 1) { setMode('wp'); switchTab('points'); toast('Шаг 1 — маршрут: кликайте по карте, чтобы поставить точки по порядку облёта. Точку можно перетащить, правый клик — меню. Можно взять готовый шаблон справа.', '', 7000); }
      if (st === 2) { qcamOpen = true; renderQ(); toast(S.sel.size ? 'Шаг 2 — камера: высота, наклон и действия для выбранных точек' : 'Шаг 2 — камера: настройки применяются ко всем точкам. Чтобы настроить одну точку — кликните по ней на карте.', '', 6000); }
      if (st === 3) { switchTab('check'); if (S.m.waypoints.length >= 2) toast('Шаг 3 — проверка: прочитайте замечания слева и посмотрите полёт — кнопка ▶ внизу', '', 6000); }
      if (st === 4) { if (window.WS_DESKTOP) cmd('sendRC'); else { const b2 = $('[data-exp=fly]'); if (b2) b2.click(); } }
    };
    function lightState() {
      const v = Core.validate(), ne = v.filter(x => x.lvl === 'err').length, nw = v.filter(x => x.lvl === 'warn').length;
      return { ne, nw, cls: S.m.waypoints.length < 2 ? 'none' : ne ? 'red' : nw ? 'yellow' : 'green' };
    }
    function renderBar() {
      const n = S.m.waypoints.length, L0 = lightState(), B = k => bar.querySelector(`[data-step="${k}"]`);
      B(1).classList.toggle('done', n >= 2); B(1).querySelector('span').textContent = n ? `Маршрут · ${n} т.` : 'Маршрут';
      B(2).classList.toggle('done', n >= 2 && S.m.waypoints.some(w => w.actions.length || w.photoTime || w.photoDist));
      const l = B(3).querySelector('.light'); l.className = 'light ' + L0.cls;
      B(3).querySelector('span').textContent = L0.cls === 'none' ? 'Проверка' : L0.cls === 'green' ? 'Всё в порядке' : L0.cls === 'red' ? `Ошибок: ${L0.ne}` : `Замечаний: ${L0.nw}`;
      B(3).title = L0.cls === 'green' ? 'Маршрут прошёл проверку' : 'Нажмите, чтобы посмотреть замечания';
      B(4).querySelector('span').textContent = window.WS_DESKTOP ? '📲 Записать на пульт' : '⬇ Файл для DJI Fly';
      B(4).disabled = n < 2; B(4).title = n < 2 ? 'Сначала поставьте хотя бы 2 точки маршрута' : window.WS_DESKTOP ? 'Открыть окно пульта DJI RC 2 и записать маршрут' : 'Сохранить маршрут для DJI Fly (.kmz)';
    }

    // ---- quick camera panel: big sliders + presets + action chips ----
    let qcamOpen = Core.store.get('ws.qcam', true);
    const q = document.createElement('div'); q.id = 'qcam'; q.className = 'qcam sonly'; $('#mapWrap').appendChild(q);
    L.DomEvent.disableClickPropagation(q); L.DomEvent.disableScrollPropagation(q);
    const targets = () => { const W = S.m.waypoints, sel = W.filter(w => S.sel.has(w.id)); return sel.length ? sel : W; };
    const ACTQ = [[1, '📷 Фото'], [2, '⏺ Видео'], [3, '⏹ Стоп']];
    const hasPanoW = w => w.actions.some(a => a.g && String(a.g).startsWith('pano'));
    let qKey = '';
    function renderQ() {
      const W = S.m.waypoints, T = targets();
      if (!W.length) { q.hidden = true; return; }
      q.hidden = false;
      const who = S.sel.size === 1 ? `Точка №${Core.wpIndex([...S.sel][0]) + 1}` : S.sel.size > 1 ? `Выбрано точек: ${T.length}` : `Все точки (${W.length})`;
      const alts = T.map(w => Math.round(w.alt)), gbs = T.map(w => Math.round(w.gimbal ?? -20));
      const same = a => a.every(v => v === a[0]);
      const altV = same(alts) ? alts[0] : null, gbV = same(gbs) ? gbs[0] : null, lim = S.m.settings.legalAlt || 120;
      const actOn = t => T.every(w => w.actions.some(a => a.type === t && !a.g)), panoOn = T.every(hasPanoW);
      const key = JSON.stringify([qcamOpen, who, altV, gbV, ACTQ.map(([t]) => actOn(t)), panoOn, lim, alts.length]);
      if (key === qKey && document.activeElement && q.contains(document.activeElement) && document.activeElement.type === 'range') return;
      qKey = key;
      if (!qcamOpen) { q.className = 'qcam sonly mini'; q.innerHTML = `<button class="btn" data-q="open">📷 Высота и камера</button>`; return; }
      q.className = 'qcam sonly';
      q.innerHTML = `<div class="qh"><b>📷 ${who}</b><button class="btn icon sm" data-q="close" title="Свернуть">—</button></div>
        <div class="qrow"><label>Высота</label><output id="qAltV">${altV != null ? altV + ' м' : 'разная'}</output></div>
        <input type="range" id="qAlt" min="5" max="${Math.max(lim, 120)}" step="1" value="${altV ?? Math.round(alts.reduce((a, b) => a + b, 0) / alts.length)}">
        <div class="qchips">${[30, 50, 80, 120].filter(v => v <= Math.max(lim, 120)).map(v => `<button data-alt="${v}" class="${altV === v ? 'on' : ''}">${v} м</button>`).join('')}</div>
        <div class="qrow"><label>Наклон камеры</label><output id="qGbV">${gbV != null ? gbLabel(gbV) : 'разный'}</output></div>
        <input type="range" id="qGb" min="-90" max="0" step="1" value="${gbV ?? -20}">
        <div class="qchips">${[[-90, '⬇ Вниз'], [-45, '−45°'], [-20, '−20°'], [0, 'Горизонт']].map(([v, t]) => `<button data-gb="${v}" class="${gbV === v ? 'on' : ''}">${t}</button>`).join('')}</div>
        <div class="qrow"><label>Действия в точке${S.sel.size ? '' : 'ах'}</label></div>
        <div class="qchips acts">${ACTQ.map(([t, l]) => `<button data-act="${t}" class="${actOn(t) ? 'on' : ''}">${actOn(t) ? '✓ ' : ''}${l}</button>`).join('')}<button data-act="pano" class="${panoOn ? 'on' : ''}">${panoOn ? '✓ ' : ''}🌐 Панорама</button></div>
        <div class="qnote">${S.sel.size ? 'Изменения — для выбранных точек.' : 'Изменения — для всех точек. Клик по точке на карте — настроить только её.'}</div>`;
    }
    const gbLabel = v => v <= -85 ? `${v}° (вниз)` : v >= -2 ? `${v}° (горизонт)` : `${v}°`;
    const applyAll = fn => { Core.snap(); targets().forEach(fn); Core.changed(); };
    q.addEventListener('input', e => {
      if (e.target.id === 'qAlt') $('#qAltV').textContent = e.target.value + ' м';
      if (e.target.id === 'qGb') $('#qGbV').textContent = gbLabel(+e.target.value);
    });
    q.addEventListener('change', e => {
      if (e.target.id === 'qAlt') { const v = +e.target.value; applyAll(w => { w.alt = v; }); }
      if (e.target.id === 'qGb') { const v = +e.target.value; applyAll(w => { w.gimbal = v; }); }
    });
    q.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.q === 'close' || b.dataset.q === 'open') { qcamOpen = b.dataset.q === 'open'; Core.store.set('ws.qcam', qcamOpen); qKey = ''; renderQ(); return; }
      if (b.dataset.alt) { const v = +b.dataset.alt; applyAll(w => { w.alt = v; }); if (v > (S.m.settings.legalAlt || 120)) toast('Выше разрешённой высоты — проверьте местные правила', 'err'); return; }
      if (b.dataset.gb) { const v = +b.dataset.gb; applyAll(w => { w.gimbal = v; }); return; }
      const a = b.dataset.act; if (!a) return;
      const T = targets();
      if (a === 'pano') {
        const on = T.every(hasPanoW); Core.snap();
        T.forEach(w => { if (on) w.actions = w.actions.filter(x => !(x.g && String(x.g).startsWith('pano'))); else if (!hasPanoW(w)) addPano(Core.wpIndex(w.id)); });
        Core.changed(); return;
      }
      const t = +a, on = T.every(w => w.actions.some(x => x.type === t && !x.g));
      applyAll(w => { if (on) w.actions = w.actions.filter(x => !(x.type === t && !x.g)); else if (!w.actions.some(x => x.type === t && !x.g) && w.actions.length < 15) w.actions.push({ type: t, param: ACTIONS[t].def }); });
      if (!on && t === 2 && !S.m.waypoints.some(w => w.actions.some(x => x.type === 3))) toast('Видео начнётся в этих точках. Не забудьте «⏹ Стоп видео» в последней точке съёмки.', '', 7000);
    });

    // ---- templates gallery (empty inspector, simple mode) ----
    function gallery() {
      const ins = $('#insp'); if (mode !== 'simple' || S.sel.size || S.selPoi || S.selHome || ins.querySelector('.tgal')) return;
      const d = document.createElement('div'); d.className = 'tgal';
      d.innerHTML = `<h3>Готовые шаблоны полёта</h3>
        <button data-t="cine"><i>🎬</i><b>Кинокадры</b><span>Улёт, «ракета», раскрытие вида, пролёт мимо, наезд</span></button>
        <button data-t="orbit"><i>⟳</i><b>Облёт вокруг объекта</b><span>Круг или спираль вокруг точки — камера смотрит в центр</span></button>
        <button data-t="grid"><i>▱</i><b>Съёмка участка сверху</b><span>«Змейка» над зоной — для карты и 3D-модели</span></button>
        <button data-t="corridor"><i>╱</i><b>Вдоль дороги или реки</b><span>Полоса съёмки вдоль нарисованной линии</span></button>
        <button data-t="facade"><i>▤</i><b>Фасад здания</b><span>Проходы на разной высоте вдоль стены</span></button>
        <button data-t="free"><i>✚</i><b>Свой маршрут</b><span>Кликайте по карте — точка за точкой</span></button>`;
      d.onclick = e => { const b = e.target.closest('[data-t]'); if (!b) return; const t = b.dataset.t; if (t === 'free') { setMode('wp'); toast('Кликайте по карте, чтобы ставить точки маршрута'); return; } if (t === 'grid') { setMode('area'); toast('Обведите участок на карте кликами, затем нажмите на первую точку — откроются настройки съёмки', '', 7000); return; } if (t === 'corridor') { setMode('line'); toast('Нарисуйте линию кликами по карте, затем выберите «Коридор» в настройках', '', 7000); return; } openTool(t); };
      ins.appendChild(d);
    }

    // ---- action marks on the flight slider ----
    const marks = document.createElement('div'); marks.id = 'simMarks'; marks.className = 'sonly'; $('#simSlider').insertAdjacentElement('afterend', marks);
    let mT = 0;
    function renderMarks() {
      clearTimeout(mT); mT = setTimeout(() => {
        if (mode !== 'simple') return;
        const tl = SimCore.build(), sl = $('#simSlider'); marks.innerHTML = ''; if (!tl) return;
        const W = S.m.waypoints, r0 = sl.getBoundingClientRect(), rp = sl.parentElement.getBoundingClientRect();
        marks.style.left = (r0.left - rp.left + 7) + 'px'; marks.style.width = (r0.width - 14) + 'px';
        // red bar under the slider where the video is recording
        const RP = Core.recPlan(), tOf = (i, hold) => { const q = tl.pts.filter(p => p.wp === i); return q.length ? q[hold ? q.length - 1 : 0].t : null; };
        RP.forEach((r, i) => { if (!r.out) return; const t0 = tOf(i, true), t1 = i + 1 < W.length ? tOf(i + 1, false) : tl.T; if (t0 == null || t1 == null) return; const e = document.createElement('u'); e.style.left = (t0 / tl.T * 100) + '%'; e.style.width = Math.max(0.5, (t1 - t0) / tl.T * 100) + '%'; e.title = 'Запись видео'; marks.appendChild(e); });
        tl.pts.filter(p => p.wp != null && !p.hold && W[p.wp] && W[p.wp].actions.length).forEach(p => {
          const A = W[p.wp].actions, ic = A.some(a => a.g) ? '🌐' : A.some(a => a.type === 2) ? '⏺' : A.some(a => a.type === 3) ? '⏹' : A.some(a => a.type === 1) ? '📷' : '•';
          const m = document.createElement('i'); m.style.left = (p.t / tl.T * 100) + '%'; m.textContent = ic; m.title = `Т.${p.wp + 1}: ${Core.actGroups(A).length} действ.`; marks.appendChild(m);
        });
      }, 300);
    }

    // ---- first-run tour (5 steps) ----
    const TOUR = [
      ['#uiMode', 'Вид программы', 'Сейчас включён упрощённый вид — только главное. «Полный» открывает все инструменты. Маршрут при переключении не меняется.'],
      ['#steps [data-step="1"]', '1. Маршрут', 'Кликайте по карте — каждая точка ставится по порядку облёта. Или выберите готовый шаблон справа.'],
      ['#qcam', '2. Камера', 'Высота, наклон камеры и действия — крупными ползунками и кнопками. Без выбора точек — для всего маршрута.'],
      ['#steps [data-step="3"]', '3. Проверка', 'Светофор: зелёный — всё хорошо, жёлтый — есть замечания, красный — исправьте ошибки. Кнопка ▶ внизу покажет полёт.'],
      ['#steps [data-step="4"]', '4. На пульт', 'Подключите пульт кабелем и нажмите — маршрут запишется в DJI Fly. Перед записью делается резервная копия.'],
    ];
    function tour(k = 0) {
      let ov = $('#tour'); if (!ov) { ov = document.createElement('div'); ov.id = 'tour'; document.body.appendChild(ov); }
      if (k >= TOUR.length) { ov.remove(); Core.store.set('ws.tourDone', true); return; }
      const [sel, ttl, txt] = TOUR[k], el = $(sel), r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
      if (!r) return tour(k + 1);
      const bx = Math.min(innerWidth - 340, Math.max(10, r.left)), by = r.bottom + 14 + 170 > innerHeight ? Math.max(10, r.top - 184) : r.bottom + 14;
      ov.innerHTML = `<div class="tspot" style="left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px"></div>
        <div class="tbox" style="left:${bx}px;top:${by}px"><small>${k + 1} из ${TOUR.length}</small><b>${ttl}</b><p>${txt}</p><div><button class="btn" data-tq>Пропустить</button><button class="btn primary" data-tn>${k + 1 < TOUR.length ? 'Далее ›' : 'Начать'}</button></div></div>`;
      ov.onclick = e => { if (e.target.closest('[data-tn]')) tour(k + 1); else if (e.target.closest('[data-tq]')) tour(TOUR.length); };
    }

    function set(m, user) {
      mode = m === 'full' ? 'full' : 'simple'; Core.store.set('ws.ui', mode);
      document.body.classList.toggle('simple', mode === 'simple'); document.body.classList.toggle('full', mode === 'full');
      $$('#uiMode [data-ui]').forEach(b => b.classList.toggle('on', b.dataset.ui === mode));
      if (mode === 'simple' && ['poi', 'area', 'line'].includes(S.mode) && user) setMode('wp');
      if (mode === 'simple' && $('#tab-tools').classList.contains('on') && user) switchTab('mission');
      if (mode === 'simple' && user && Core.store.get('ws.prof.simple', null) === null) { $('#profile').classList.add('hide'); }
      if (mode === 'full') $$('#insp .tgal').forEach(e => e.remove());
      qKey = ''; update(); setTimeout(() => map.invalidateSize(), 50);
      if (user) toast(mode === 'simple' ? 'Упрощённый вид: шаги вверху, крупные настройки камеры на карте. Все данные маршрута сохранены.' : 'Полный вид: все инструменты и форматы экспорта', 'ok', 5000);
      if (mode === 'simple' && !Core.store.get('ws.tourDone', false)) setTimeout(() => tour(0), 900);
    }
    function update() { if (mode !== 'simple') return; renderBar(); renderQ(); gallery(); renderMarks(); }
    Core.on('rendered', update);
    window.addEventListener('resize', renderMarks);
    window.addEventListener('ws-desktop', () => update());
    setTimeout(() => set(mode, false), 0);
    return { get mode() { return mode; }, set, tour };
  })();

  // =================== START ===================
  const saved = Core.store.get('ws.current', null);
  buildMission(); buildTools();
  if (saved && saved.waypoints) { Core.loadMission(saved); fitNext = false; }
  else refresh();
  setMode('wp');
  window.WS = { Core, IO, Gen, Maps, map, Sim, refresh, UI };
  // Android: files opened/shared into the app
  window.wsImportBase64 = async (name, b64) => {
    try {
      const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const m = await IO.importFile(new File([u8], name));
      if (S.m.waypoints.length) Core.saveToLibrary();
      Core.loadMission(m); toast(`Открыт файл: ${name} — ${m.waypoints.length} точек`, 'ok');
    } catch (e) { toast(name + ': ' + e.message, 'err', 7000); }
  };
  const deskOn = () => $$('.desk').forEach(e => e.hidden = !window.WS_DESKTOP);
  deskOn(); window.addEventListener('ws-desktop', deskOn);
  if (window.AndroidBridge) { document.body.classList.add('android'); $$('.andr').forEach(e => e.hidden = false); }
})();
