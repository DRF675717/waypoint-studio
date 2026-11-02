// Mission model, undo/redo, persistence, flight calculations, elevation, validation
const ACTIONS = [
  { t: 0, name: 'Зависнуть', unit: 'мс', def: 2000, min: 0, max: 32000 },
  { t: 1, name: 'Сделать фото', unit: '', def: 0 },
  { t: 2, name: 'Начать запись', unit: '', def: 0 },
  { t: 3, name: 'Остановить запись', unit: '', def: 0 },
  { t: 4, name: 'Повернуть дрон', unit: '°', def: 0, min: -180, max: 360 },
  { t: 5, name: 'Наклон камеры', unit: '°', def: -90, min: -90, max: 60 },
];
const HEADING_MODES = { auto: 'По направлению полёта', initial: 'Как в начале (фикс.)', custom: 'Задаётся в каждой точке', poi: 'На точку интереса (POI)', manual: 'Вручную (пилот)' };
const FINISH = { none: 'Ничего (зависнуть)', rth: 'Возврат домой (RTH)', land: 'Посадка', first: 'Лететь к первой точке', reverse: 'Пролететь обратно' };
const GIMBAL_MODES = { disabled: 'Не управлять', interpolate: 'Плавно между точками', poi: 'Следить за POI' };

const Core = (() => {
  let uid = Date.now() % 100000;
  const id = () => (++uid).toString(36);
  const listeners = {};
  const on = (ev, fn) => (listeners[ev] = listeners[ev] || []).push(fn);
  const emit = (ev, d) => (listeners[ev] || []).forEach(f => f(d));

  function defaultSettings() {
    return {
      drone: 'Mini 4 Pro', target: 'fly', altMode: 'takeoff', headingMode: 'auto', finishAction: 'rth',
      pathMode: 'curved', cruise: 8, maxSpeed: 15, defAlt: 60, defCurve: 10, defGimbal: -20, gimbalMode: 'interpolate',
      rcLost: 'rth', legalAlt: 120, maxDist: 2000, minClear: 15, poiBlend: 3, poiPre: 'off',
    };
  }
  function newMission(name) {
    return { v: 1, id: id() + id(), name: name || 'Новый маршрут', created: Date.now(), updated: Date.now(), settings: defaultSettings(), home: null, waypoints: [], pois: [], area: [], line: [], notes: '' };
  }
  function newWaypoint(p, m) {
    const s = m.settings;
    return { id: id(), lat: p.lat, lng: p.lng, alt: p.alt ?? s.defAlt, speed: 0, heading: 0, curve: s.defCurve, gimbal: p.gimbal ?? s.defGimbal, poi: null, actions: [], photoTime: 0, photoDist: 0 };
  }
  const S = { m: newMission(), sel: new Set(), selPoi: null, selHome: false, mode: 'wp', undo: [], redo: [] };

  // ---------- undo / redo ----------
  function snap() { S.undo.push(JSON.stringify(S.m)); if (S.undo.length > 200) S.undo.shift(); S.redo.length = 0; }
  function undo() { if (!S.undo.length) return; S.redo.push(JSON.stringify(S.m)); S.m = JSON.parse(S.undo.pop()); prune(); changed(); }
  function redo() { if (!S.redo.length) return; S.undo.push(JSON.stringify(S.m)); S.m = JSON.parse(S.redo.pop()); prune(); changed(); }
  function prune() { const ids = new Set(S.m.waypoints.map(w => w.id)); [...S.sel].forEach(i => ids.has(i) || S.sel.delete(i)); if (S.selPoi && !S.m.pois.find(p => p.id === S.selPoi)) S.selPoi = null; if (S.selHome && !S.m.home) S.selHome = false; }
  let saveT;
  function changed(opts = {}) {
    prune(); // never keep a selection that points to a deleted object
    S.m.updated = Date.now();
    emit('change', opts);
    clearTimeout(saveT); saveT = setTimeout(() => store.set('ws.current', S.m), 400);
  }

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('storage', e); } },
  };
  function library() { return store.get('ws.library', {}); }
  function saveToLibrary() { const lib = library(); lib[S.m.id] = JSON.parse(JSON.stringify(S.m)); store.set('ws.library', lib); }
  function loadMission(m, keepUndo) {
    if (!keepUndo) { S.undo.length = 0; S.redo.length = 0; }
    const base = newMission();
    S.m = Object.assign(base, m, { settings: Object.assign(defaultSettings(), m.settings || {}) });
    S.m.waypoints = (S.m.waypoints || []).map(w => Object.assign(newWaypoint(w, S.m), w, { id: w.id || id(), actions: w.actions || [] }));
    S.m.pois = (S.m.pois || []).map(p => Object.assign({ id: id(), alt: 0, name: 'POI' }, p));
    S.sel.clear(); S.selPoi = null; S.selHome = false;
    changed({ fit: true });
  }

  const drone = () => DRONES.find(d => d.name === S.m.settings.drone) || DRONES[1];
  const wpIndex = idv => S.m.waypoints.findIndex(w => w.id === idv);
  const poiById = idv => S.m.pois.find(p => p.id === idv);
  const homePt = () => S.m.home || S.m.waypoints[0] || null;

  // ---------- elevation ----------
  const Elev = (() => {
    const cache = store.get('ws.elev', {});
    const key = p => p.lat.toFixed(4) + ',' + p.lng.toFixed(4); // ~11 m grid (DEM resolution is 30–90 m)
    const rp = p => ({ lat: +p.lat.toFixed(4), lng: +p.lng.toFixed(4) });
    let pending = new Map(), timer = null, saveTimer = null, inflight = Promise.resolve(), blockedUntil = 0;
    function cached(p) { return p ? cache[key(p)] : undefined; }
    function request(pts) {
      const need = pts.filter(p => p && cache[key(p)] === undefined);
      need.forEach(p => pending.set(key(p), rp(p)));
      if (pending.size && !timer) timer = setTimeout(() => { timer = null; flush(); }, Math.max(300, blockedUntil - Date.now()));
      return need.length === 0;
    }
    function flush() { inflight = inflight.then(doFlush, doFlush); return inflight; }
    async function doFlush() {
      const batch = [...pending.values()].filter(p => cache[key(p)] === undefined); pending = new Map();
      if (!batch.length) return;
      if (Date.now() < blockedUntil) { batch.forEach(p => pending.set(key(p), p)); return; }
      let ok = false;
      if (window.google && google.maps && google.maps.ElevationService && Maps.googleReady) {
        try {
          const svc = new google.maps.ElevationService();
          for (let i = 0; i < batch.length; i += 400) {
            const part = batch.slice(i, i + 400);
            const r = await svc.getElevationForLocations({ locations: part.map(p => ({ lat: p.lat, lng: p.lng })) });
            r.results.forEach((res, j) => cache[key(part[j])] = Math.round(res.elevation * 10) / 10);
          }
          Elev.source = 'Google Elevation API'; ok = true;
        } catch (e) { console.warn('google elevation', e); }
      }
      if (!ok) {
        try {
          for (let i = 0; i < batch.length; i += 100) {
            const part = batch.slice(i, i + 100);
            const u = 'https://api.open-meteo.com/v1/elevation?latitude=' + part.map(p => p.lat.toFixed(4)).join(',') + '&longitude=' + part.map(p => p.lng.toFixed(4)).join(',');
            const r = await fetch(u);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const j = await r.json();
            (j.elevation || []).forEach((h, k) => cache[key(part[k])] = h);
          }
          Elev.source = 'Open-Meteo (Copernicus DEM 90 м)'; Elev.error = null;
        } catch (e2) {
          console.warn('elevation failed', e2); Elev.error = String(e2.message || e2);
          blockedUntil = Date.now() + 30000; batch.forEach(p => { if (cache[key(p)] === undefined) pending.set(key(p), p); });
          if (!timer) timer = setTimeout(() => { timer = null; flush(); }, 30000);
        }
      }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { const keys = Object.keys(cache); if (keys.length > 30000) keys.slice(0, 8000).forEach(k => delete cache[k]); store.set('ws.elev', cache); }, 1000);
      emit('elev');
    }
    async function ensure(pts) {
      pts = pts.filter(Boolean); request(pts);
      if (timer) { clearTimeout(timer); timer = null; }
      await flush();
      if (pts.some(p => cache[key(p)] === undefined) && Elev.error) throw new Error('Нет данных о рельефе (' + Elev.error + '). Повторите через минуту.');
      return pts.map(cached);
    }
    return { cached, request, ensure, source: '—' };
  })();

  // ---------- altitudes ----------
  // ASL of waypoint (needs elevations); returns undefined if unknown
  function groundAt(p) { return Elev.cached(p); }
  function wpASL(w) {
    const h = homePt(); if (!h) return undefined;
    if (S.m.settings.altMode === 'agl') { const g = groundAt(w); return g === undefined ? undefined : g + w.alt; }
    const gh = groundAt(h); return gh === undefined ? undefined : gh + w.alt;
  }
  // altitude relative to takeoff point (what the drone actually uses)
  function wpRel(w) {
    if (S.m.settings.altMode !== 'agl') return w.alt;
    const h = homePt(), gh = groundAt(h), g = groundAt(w);
    return gh === undefined || g === undefined ? w.alt : Math.round((w.alt + g - gh) * 10) / 10;
  }
  function wpAGL(w) {
    if (S.m.settings.altMode === 'agl') return w.alt;
    const a = wpASL(w), g = groundAt(w); return a === undefined || g === undefined ? undefined : a - g;
  }
  function poiASL(p) { const g = groundAt(p); return g === undefined ? undefined : g + (p.alt || 0); }

  // ---------- headings / gimbal ----------
  function effHeading(i) {
    const W = S.m.waypoints, w = W[i], s = S.m.settings; if (!w) return null;
    switch (w.hm || s.headingMode) { // w.hm: per-point heading mode (DJI Fly allows it per waypoint)
      case 'auto': return W.length < 2 ? 0 : i < W.length - 1 ? Geo.bearing(w, W[i + 1]) : Geo.bearing(W[i - 1], w);
      case 'initial': return W.length < 2 ? 0 : Geo.bearing(W[0], W[1]);
      case 'custom': return Geo.norm360(w.heading);
      case 'poi': { const p = poiById(w.poi) || S.m.pois[0]; return p ? Geo.bearing(w, p) : (W.length > 1 && i < W.length - 1 ? Geo.bearing(w, W[i + 1]) : 0); }
      default: return null;
    }
  }
  function effGimbal(i) {
    const w = S.m.waypoints[i], s = S.m.settings; if (!w) return null;
    if (s.gimbalMode === 'poi') {
      const p = poiById(w.poi) || S.m.pois[0];
      if (p) {
        const a = wpASL(w), b = poiASL(p), d = Geo.dist(w, p);
        const dz = a !== undefined && b !== undefined ? a - b : w.alt - (p.alt || 0);
        return Math.max(-90, -Geo.deg(Math.atan2(dz, Math.max(d, 0.1))));
      }
    }
    if (s.gimbalMode === 'disabled') return null;
    if (w.gkeep) { for (let k = i - 1; k >= 0; k--) { const q = S.m.waypoints[k]; if (!q.gkeep) return q.gimbal; } return null; } // camera not changed at this point
    return w.gimbal;
  }

  // ---------- path geometry ----------
  // returns {pts:[{lat,lng,alt(rel),i(seg index)}]} display path incl. curves
  function pathGeometry() {
    const W = S.m.waypoints, s = S.m.settings, out = [];
    if (!W.length) return out;
    const curved = s.pathMode === 'curved';
    const rel = W.map(wpRel);
    for (let i = 0; i < W.length; i++) {
      const w = W[i];
      if (!curved || i === 0 || i === W.length - 1 || !(w.curve > 0)) { out.push({ lat: w.lat, lng: w.lng, alt: rel[i], i, wp: true }); continue; }
      const dPrev = Geo.dist(W[i - 1], w), dNext = Geo.dist(w, W[i + 1]);
      const c = Math.min(curveMeters(i), dPrev * 0.5, dNext * 0.5);
      if (c < 0.5) { out.push({ lat: w.lat, lng: w.lng, alt: rel[i], i, wp: true }); continue; }
      const a = Geo.interp(w, W[i - 1], c / dPrev), b = Geo.interp(w, W[i + 1], c / dNext);
      const za = rel[i] + (rel[i - 1] - rel[i]) * c / dPrev, zb = rel[i] + (rel[i + 1] - rel[i]) * c / dNext;
      const N = 10;
      for (let k = 0; k <= N; k++) {
        const t = k / N, u = 1 - t;
        out.push({ lat: u * u * a.lat + 2 * u * t * w.lat + t * t * b.lat, lng: u * u * a.lng + 2 * u * t * w.lng + t * t * b.lng, alt: u * u * za + 2 * u * t * rel[i] + t * t * zb, i: t < 0.5 ? i - 1 : i, wp: k === N / 2 });
      }
    }
    return out;
  }
  // Curve size in metres (as in Litchi CSV), clamped to half of the shorter adjacent segment
  function curveMeters(i) {
    const W = S.m.waypoints, w = W[i];
    if (!(w.curve > 0) || i === 0 || i === W.length - 1) return 0;
    return Math.min(w.curve, 0.5 * Math.min(Geo.dist(W[i - 1], w), Geo.dist(w, W[i + 1])));
  }

  // ---------- flight statistics ----------
  const ACC = 2.5, VUP = 5, VDOWN = 3.5;
  function segTime(d, dz, v, stopA, stopB) {
    let t;
    const dacc = v * v / (2 * ACC);
    const need = (stopA ? dacc : 0) + (stopB ? dacc : 0);
    if (d >= need) t = d / v + (stopA ? v / (2 * ACC) : 0) + (stopB ? v / (2 * ACC) : 0);
    else t = 2 * Math.sqrt(Math.max(d, 0) / ACC);
    const tv = dz > 0 ? dz / VUP : -dz / VDOWN;
    return Math.max(t, tv);
  }
  function actionTime(a, prevHeading) {
    switch (a.type) {
      case 0: return (a.param || 0) / 1000;
      case 1: return 1.5;
      case 2: case 3: return 1;
      case 4: return Math.abs(Geo.norm180((a.param || 0) - (prevHeading || 0))) / 45 + 0.5;
      case 5: return 1;
      default: return 0;
    }
  }
  function stats() {
    const W = S.m.waypoints, s = S.m.settings, d = drone();
    const res = { n: W.length, dist: 0, dist3d: 0, time: 0, transit: 0, transitTime: 0, photos: 0, maxAGL: -Infinity, minAGL: Infinity, maxRel: -Infinity, maxHomeDist: 0, segs: [] };
    if (!W.length) return res;
    const curved = s.pathMode === 'curved';
    const rel = W.map(wpRel);
    // length actually flown on each segment (curves cut the corners): the same path the map, the profile and the simulation use
    const plen = new Array(W.length).fill(0); { const g = pathGeometry(); for (let k = 1; k < g.length; k++) plen[Math.min(W.length - 1, g[k - 1].i)] += Geo.dist(g[k - 1], g[k]); }
    for (let i = 0; i < W.length; i++) {
      const w = W[i];
      res.maxRel = Math.max(res.maxRel, rel[i]);
      const agl = wpAGL(w); if (agl !== undefined) { res.maxAGL = Math.max(res.maxAGL, agl); res.minAGL = Math.min(res.minAGL, agl); }
      const hp = homePt(); if (hp) res.maxHomeDist = Math.max(res.maxHomeDist, Geo.dist(hp, w));
      let h = effHeading(i) ?? 0;
      w.actions.forEach(a => { res.time += actionTime(a, h); if (a.type === 1) res.photos++; if (a.type === 4) h = a.param; });
      if (i < W.length - 1) {
        const n = W[i + 1], dh = curved && plen[i] > 0 ? plen[i] : Geo.dist(w, n), dz = rel[i + 1] - rel[i];
        const v = Math.min(w.speed > 0 ? w.speed : s.cruise, s.maxSpeed, d.maxSpeed);
        const stopA = i === 0 || !curved || w.actions.length > 0 || !(w.curve > 0);
        const stopB = i + 1 === W.length - 1 || !curved || n.actions.length > 0 || !(n.curve > 0);
        const t = segTime(dh, dz, v, stopA, stopB);
        res.dist += dh; res.dist3d += Math.hypot(dh, dz); res.time += t;
        if (w.photoDist > 0) res.photos += Math.floor(dh / w.photoDist) + 1;
        else if (w.photoTime > 0) res.photos += Math.floor(t / w.photoTime) + 1;
        res.segs.push({ i, d: dh, dz, v, t });
      }
    }
    const h = S.m.home;
    if (h) {
      const first = W[0], last = W[W.length - 1];
      const tIn = segTime(Geo.dist(h, first), 0, s.cruise, true, true) + rel[0] / VUP;
      res.transit += Geo.dist(h, first); res.transitTime += tIn;
      if (s.finishAction === 'rth') { const dd = Geo.dist(last, h); res.transit += dd; res.transitTime += segTime(dd, 0, 10, true, true) + rel[rel.length - 1] / VDOWN; }
    }
    if (s.finishAction === 'reverse') { res.time *= 2; res.dist *= 2; }
    if (s.finishAction === 'first' && W.length > 1) { const dd = Geo.dist(W[W.length - 1], W[0]); res.dist += dd; res.time += segTime(dd, rel[0] - rel[rel.length - 1], s.cruise, true, true); }
    const total = res.time + res.transitTime + 60; // + takeoff/landing
    res.battery = total / (d.flight * 60 * 0.85) * 100;
    res.total = total;
    if (res.maxAGL === -Infinity) { res.maxAGL = undefined; res.minAGL = undefined; }
    return res;
  }

  // ---------- terrain profile ----------
  function profile() {
    const g = pathGeometry(); if (g.length < 2) return null;
    const samples = []; let total = 0;
    for (let i = 1; i < g.length; i++) total += Geo.dist(g[i - 1], g[i]);
    const step = Math.max(10, total / 160);
    let acc = 0, carry = 0;
    samples.push({ d: 0, p: g[0], alt: g[0].alt, wp: 0 });
    let wpCount = 1;
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1], b = g[i], L = Geo.dist(a, b);
      let t = step - carry;
      while (t < L) { const f = t / L; samples.push({ d: acc + t, p: Geo.interp(a, b, f), alt: a.alt + (b.alt - a.alt) * f }); t += step; }
      carry = L - (t - step);
      acc += L;
      if (b.wp) samples.push({ d: acc, p: b, alt: b.alt, wp: wpCount++ });
    }
    const h = homePt(); const gh = groundAt(h);
    Elev.request(samples.map(s => s.p).concat(h ? [h] : []));
    let minClear = Infinity, minAt = null;
    samples.forEach(s => {
      s.ground = groundAt(s.p);
      s.asl = gh !== undefined ? gh + s.alt : undefined;
      if (s.ground !== undefined && s.asl !== undefined) { s.clear = s.asl - s.ground; if (s.clear < minClear) { minClear = s.clear; minAt = s; } }
    });
    return { samples, total, homeGround: gh, minClear: minClear === Infinity ? undefined : minClear, minAt };
  }

  // ---------- validation ----------
  function validate() {
    const W = S.m.waypoints, s = S.m.settings, d = drone(), out = [];
    const add = (lvl, msg, i) => { if (!out.some(x => x.msg === msg)) out.push({ lvl, msg, i }); }; // the same remark once
    if (S.m.settings.poiPre === 'on' && typeof IO !== 'undefined' && IO.poiPrePlan) { const n = IO.poiPrePlan().added; if (n) add('info', `Плавные повороты в полёте: при записи на пульт и экспорте будет добавлено вспомогательных точек: ${n} (без действий), чтобы дрон поворачивал заранее, как в симуляции. На карте их нет.`); }
    if (!W.length) { add('info', 'Маршрут пуст: кликните по карте, чтобы добавить точки.'); return out; }
    if (W.length < 2) add('err', 'Нужно минимум 2 точки маршрута.');
    const limit = s.target === 'litchi' ? 99 : 200;
    if (W.length > limit) add('err', `Слишком много точек: ${W.length} (лимит ${limit} для ${targetName(s.target)}). Разбейте маршрут.`);
    if (!S.m.home) add('info', 'Точка взлёта не задана — считается, что взлёт в точке 1. Задайте её режимом «Взлёт» для точных расчётов.');
    if (s.target === 'litchi' && d.apps !== 'litchi') add('warn', `${d.name} не поддерживается приложением Litchi for DJI Drones — используйте экспорт в DJI Fly KMZ.`);
    if (s.target === 'fly' && d.apps === 'litchi') add('warn', `${d.name} не поддерживает путевые точки DJI Fly — экспортируйте Litchi CSV.`);
    const st = stats();
    if (st.battery > 85) { add('err', `Расчётный расход батареи ${Math.round(st.battery)}% — недостаточный резерв. Сократите маршрут, либо разбейте его по батареям (Экспорт → «разбить по батареям»).`); out[out.length - 1].battery = true; }
    else if (st.battery > 65) add('warn', `Расход батареи ~${Math.round(st.battery)}%. Стартуйте с полной батареей.`);
    if (st.maxHomeDist > s.maxDist) add('warn', `Удаление от точки взлёта до ${Math.round(st.maxHomeDist)} м (> ${s.maxDist} м) — риск потери связи.`);
    let inRec = false;
    W.forEach((w, i) => {
      const n = i + 1;
      const agl = wpAGL(w);
      if (agl !== undefined && agl > s.legalAlt) add('warn', `Т.${n}: ${Math.round(agl)} м над рельефом — выше законного лимита ${s.legalAlt} м.`, i);
      if (wpRel(w) > 500) add('err', `Т.${n}: высота относительно взлёта > 500 м — DJI не примет.`, i);
      if (wpRel(w) < -200) add('err', `Т.${n}: высота ниже −200 м относительно взлёта.`, i);
      if (agl !== undefined && agl < 5) add('err', `Т.${n}: всего ${agl.toFixed(1)} м над землёй — риск столкновения.`, i);
      if (w.speed > Math.min(s.maxSpeed, d.maxSpeed)) add('warn', `Т.${n}: скорость ${w.speed} м/с выше максимальной ${Math.min(s.maxSpeed, d.maxSpeed)}.`, i);
      if (w.gimbal < d.gMin || w.gimbal > d.gMax) add('warn', `Т.${n}: наклон камеры ${w.gimbal}° вне диапазона ${d.gMin}…${d.gMax}° для ${d.name}.`, i);
      if (w.actions.length > 15) add('err', `Т.${n}: более 15 действий.`, i);
      w.actions.forEach(a => { if (a.type === 2) inRec = true; if (a.type === 3) inRec = false; if (a.type === 1 && inRec) add('warn', `Т.${n}: фото во время записи видео — камера его пропустит.`, i); });
      if ((w.photoTime > 0 || w.photoDist > 0) && inRec) add('warn', `Т.${n}: съёмка фото по интервалу во время записи видео — камера её пропустит.`, i);
      if (w.photoTime > 0 && w.photoTime < d.minInt) add('warn', `Т.${n}: интервал фото ${w.photoTime} с меньше минимального ${d.minInt} с.`, i);
      if (i < W.length - 1) {
        const dd = Geo.dist(w, W[i + 1]);
        if (dd < 0.6) add('err', `Т.${n}–${n + 1}: точки ближе 0.6 м — DJI отклонит миссию.`, i);
        if (dd > 2000 && s.target === 'litchi') add('warn', `Т.${n}–${n + 1}: отрезок ${Math.round(dd)} м > 2 км (ограничение старых DJI SDK).`, i);
        if (w.photoDist > 0) { const v = w.speed > 0 ? w.speed : s.cruise; if (w.photoDist / v < d.minInt) add('warn', `Т.${n}: при скорости ${v} м/с фото каждые ${w.photoDist} м чаще, чем ${d.minInt} с — снизьте скорость до ${(w.photoDist / d.minInt).toFixed(1)} м/с.`, i); }
      }
      if (s.pathMode === 'curved' && i > 0 && i < W.length - 1 && w.curve > 0) {
        const lim = 0.5 * Math.min(Geo.dist(W[i - 1], w), Geo.dist(w, W[i + 1]));
        if (w.curve > lim) add('warn', `Т.${n}: радиус кривой ${w.curve} м больше половины соседнего отрезка (${lim.toFixed(1)} м) — будет урезан.`, i);
      }
      if (((w.hm || s.headingMode) === 'poi' || s.gimbalMode === 'poi') && !w.poi && !S.m.pois.length) add('warn', `Т.${n}: режим «на POI», но POI не задан.`, i);
    });
    const pr = profile();
    if (pr && pr.minClear !== undefined && pr.minClear < s.minClear) add(pr.minClear < 3 ? 'err' : 'warn', `Минимальный зазор над рельефом ${pr.minClear.toFixed(1)} м (на ${Math.round(pr.minAt.d)} м пути) — меньше безопасных ${s.minClear} м. Препятствия (деревья, здания) рельеф не учитывает!`);
    if (!out.some(o => o.lvl !== 'info')) add('ok', 'Критичных проблем не найдено. Перед полётом проверьте зоны ограничений DJI и погоду.');
    if (typeof Zones !== 'undefined') Zones.checks().forEach(x => out.push(x)); // Vietnam no-fly / restricted zones
    if (typeof LOS !== 'undefined') LOS.checks().forEach(x => out.push(x)); // radio line of sight to the remote
    return out;
  }
  const targetName = t => ({ litchi: 'Litchi', fly: 'DJI Fly', pilot: 'DJI Pilot 2' })[t] || t;

  // Logical actions of a waypoint: a panorama (many turn + photo commands) counts as ONE action.
  // Tagged panoramas carry a.g = 'pano…'; older ones are recognised by their shape (≥3 «turn, photo» pairs, optionally with camera tilts).
  function actGroups(A) {
    const out = []; let k = 0;
    while (k < A.length) {
      const g = A[k].g;
      if (g) { let e = k; while (e + 1 < A.length && A[e + 1].g === g) e++; out.push({ kind: 'pano', from: k, to: e, shots: A.slice(k, e + 1).filter(a => a.type === 1).length }); k = e + 1; continue; }
      // untagged panorama: [tilt] (turn, photo)×≥3 ([tilt] (turn, photo)…)*
      let e = k, pairs = 0;
      while (e < A.length && !A[e].g) {
        if (A[e].type === 5 && e + 2 < A.length && A[e + 1].type === 4 && A[e + 2].type === 1) { e += 1; continue; }
        if (A[e].type === 4 && e + 1 < A.length && A[e + 1].type === 1) { pairs++; e += 2; continue; }
        break;
      }
      if (pairs >= 3) { out.push({ kind: 'pano', from: k, to: e - 1, shots: pairs }); k = e; continue; }
      out.push({ kind: 'act', from: k, to: k, a: A[k] }); k++;
    }
    return out;
  }

  // video recording along the route: a «Начать запись» keeps the camera recording at ALL following points
  // until a «Остановить запись». in = recording when arriving at the point, out = when leaving it
  function recPlan() {
    let r = false; return S.m.waypoints.map(w => { const inR = r; w.actions.forEach(a => { if (a.type === 2) r = true; if (a.type === 3) r = false; }); return { in: inR, out: r }; });
  }
  // one date / time format for the whole program: «21 Nov 2026», 24-hour clock «14:05»
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = n => String(n).padStart(2, '0');
  // user-selectable formats (Settings and the Sun card): date d = text | dmy | ymd | mdy, time t = 24 | 12
  const FMT_DEF = { d: 'text', t: '24' };
  const fmtCfg = () => Object.assign({}, FMT_DEF, store.get('ws.fmt', {}) || {});
  function setFmt(o) { store.set('ws.fmt', Object.assign(fmtCfg(), o)); emit('fmt'); }
  function fmtTime(t) { const d = t instanceof Date ? t : new Date(t); if (isNaN(d)) return '—'; return hm(d.getHours(), d.getMinutes()); }
  // hours / minutes → text in the chosen clock: «17:05» or «5:05 PM»
  function hm(h, m) { if (fmtCfg().t === '12') { const ap = h < 12 ? 'AM' : 'PM', h12 = h % 12 || 12; return `${h12}:${p2(m)} ${ap}`; } return `${p2(h)}:${p2(m)}`; }
  function fmtDate(t, withTime = true) {
    const d = t instanceof Date ? t : new Date(t); if (isNaN(d)) return '—';
    const D = d.getDate(), M = d.getMonth() + 1, Y = d.getFullYear(), f = fmtCfg().d;
    const ds = f === 'dmy' ? `${p2(D)}.${p2(M)}.${Y}` : f === 'ymd' ? `${Y}-${p2(M)}-${p2(D)}` : f === 'mdy' ? `${p2(M)}/${p2(D)}/${Y}` : `${D} ${MON[M - 1]} ${Y}`;
    return ds + (withTime ? `, ${fmtTime(d)}` : '');
  }
  // typed time → [h, m] (24-hour); accepts «1730», «17:30», «17.30», «9:05», «5:30 pm», «5 PM», «5:30 ПП»
  function parseTime(str) {
    const m = /^\s*(\d{1,2})\s*[:.\-, ]?\s*(\d{2})?\s*(am|pm|a\.m\.|p\.m\.|дп|пп)?\s*$/i.exec(String(str || '')); if (!m) return null;
    let h = +m[1]; const mi = +(m[2] || 0), ap = (m[3] || '').toLowerCase().replace(/\./g, '');
    if (ap) { if (h < 1 || h > 12) return null; if (ap === 'pm' || ap === 'пп') h = h % 12 + 12; else h = h % 12; }
    return h < 24 && mi < 60 ? [h, mi] : null;
  }
  return { fmtDate, fmtTime, hm, parseTime, fmtCfg, setFmt, recPlan, actGroups, S, id, on, emit, snap, undo, redo, changed, store, library, saveToLibrary, loadMission, newMission, newWaypoint, defaultSettings, drone, wpIndex, poiById, homePt, Elev, groundAt, wpASL, wpRel, wpAGL, poiASL, effHeading, effGimbal, pathGeometry, curveMeters, stats, profile, validate, targetName, actionTime, segTime };
})();
