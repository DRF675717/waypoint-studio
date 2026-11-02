// Radio line of sight between the remote (pilot at the take-off point) and the drone along the whole flight.
// Terrain: AWS Terrarium elevation tiles (SRTM-based, ≈ 20–30 m). Earth curvature with standard refraction (k = 4/3).
// Where a hill (or the ground itself) lies between the pilot and the drone, the control link and video may drop:
// those parts are reported in the route check, drawn on the map and marked on the height profile.
const LOS = (() => {
  const { S } = Core;
  const Z = 13, ANT = 1.5, KR = 6371000 * 4 / 3; // remote held ~1.5 m above the ground
  const tiles = new Map();
  function tile(x, y) {
    const k = x + '/' + y;
    if (!tiles.has(k)) tiles.set(k, fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${k}.png`).then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(b => createImageBitmap(b)).then(bm => { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bm, 0, 0); return g.getImageData(0, 0, 256, 256).data; })
      .catch(() => { tiles.delete(k); return null; }));
    return tiles.get(k);
  }
  const merc = (lat, lng) => { const n = 2 ** Z, r = lat * Math.PI / 180; return { x: (lng + 180) / 360 * n, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n }; };
  const px = (d, x, y) => { const i = (Math.min(255, Math.max(0, y)) * 256 + Math.min(255, Math.max(0, x))) * 4; return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768; };
  // bilinear terrain height; needs the tile to be loaded (see load())
  const T = new Map();
  function h(lat, lng) {
    const m = merc(lat, lng), tx = Math.floor(m.x), ty = Math.floor(m.y), d = T.get(tx + '/' + ty); if (!d) return null;
    const fx = (m.x - tx) * 256 - 0.5, fy = (m.y - ty) * 256 - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    return px(d, x0, y0) * (1 - ax) * (1 - ay) + px(d, x0 + 1, y0) * ax * (1 - ay) + px(d, x0, y0 + 1) * (1 - ax) * ay + px(d, x0 + 1, y0 + 1) * ax * ay;
  }
  async function load(points) {
    const need = new Set(); points.forEach(p => { const m = merc(p.lat, p.lng); need.add(Math.floor(m.x) + '/' + Math.floor(m.y)); });
    if (need.size > 160) return false;
    let ok = true;
    await Promise.all([...need].map(async k => { if (T.has(k)) return; const [x, y] = k.split('/').map(Number); const d = await tile(x, y); if (d) T.set(k, d); else ok = false; }));
    return ok;
  }

  let res = { key: '', state: 'idle', blocked: [], worst: null }, seq = 0, timer = null;
  const key = () => JSON.stringify([S.m.waypoints.map(w => [w.lat.toFixed(6), w.lng.toFixed(6), w.alt]), S.m.home && [S.m.home.lat.toFixed(6), S.m.home.lng.toFixed(6)], S.m.settings.altMode, S.m.settings.curve, S.m.settings.pathMode, S.m.settings.finishAction]);
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 600); }
  async function run() {
    const W = S.m.waypoints, k = key(); if (W.length < 1 || k === res.key && res.state === 'done') { if (W.length < 1) res = { key: k, state: 'idle', blocked: [], worst: null }; return; }
    const my = ++seq; res = { key: k, state: 'busy', blocked: res.blocked, worst: res.worst };
    const home = Core.homePt(); if (!home) return;
    // flight samples (every ~25 m): approach, the path (d = distance from point 1, as on the profile), return
    const g = Core.pathGeometry(), smp = [];
    const seg = (a, b, part, d0, wi) => { const L = Geo.dist(a, b), n = Math.max(1, Math.ceil(L / 25)); for (let i = 1; i <= n; i++) { const f = i / n, p = Geo.interp(a, b, f); smp.push({ lat: p.lat, lng: p.lng, rel: a.alt + (b.alt - a.alt) * f, part, d: d0 == null ? null : d0 + L * f, wi }); } return L; };
    const r0 = { ...home, alt: 0 };
    if (W.length) seg(r0, g[0] || { ...W[0], alt: Core.wpRel(W[0]) }, 'подлёт', null, -1);
    let D = 0; if (g.length) smp.push({ lat: g[0].lat, lng: g[0].lng, rel: g[0].alt, part: 'маршрут', d: 0, wi: 0 });
    for (let i = 1; i < g.length; i++) D += seg(g[i - 1], g[i], 'маршрут', D, g[i - 1].i);
    if (S.m.home && S.m.settings.finishAction === 'rth' && g.length) seg(g[g.length - 1], { ...r0, alt: g[g.length - 1].alt }, 'возврат', null, -1);
    // terrain along every pilot→drone line
    const lines = smp.map(s => { const L = Geo.dist(home, s), n = Math.min(120, Math.max(4, Math.ceil(L / 30))); return { s, L, n }; });
    const pts = [home]; lines.forEach(({ s, L, n }) => { for (let i = 0; i <= n; i++) pts.push(Geo.interp(home, s, i / n)); });
    const ok = await load(pts);
    if (my !== seq) return;
    if (!ok) { res = { key: k, state: 'offline', blocked: [], worst: null }; Core.emit('los'); return; }
    const g0 = h(home.lat, home.lng); if (g0 == null) { res = { key: k, state: 'offline', blocked: [], worst: null }; Core.emit('los'); return; }
    const A0 = g0 + ANT;
    let worst = null;
    smp.forEach((s, j) => {
      const { L, n } = lines[j], A1 = g0 + s.rel; s.block = null;
      if (s.rel < 10 || L < 50) return; // take-off / landing right next to the pilot
      for (let i = 1; i < n; i++) {
        const f = i / n, p = Geo.interp(home, s, f), d1 = L * f, d2 = L - d1;
        const ground = h(p.lat, p.lng); if (ground == null) continue;
        const ray = A0 + (A1 - A0) * f, bulge = d1 * d2 / (2 * KR), over = ground + bulge - ray;
        if (over > 0.5 && (!s.block || over > s.block.over)) s.block = { over, at: p, ground, dist: d1 };
      }
      if (s.block && (!worst || s.block.over > worst.over)) worst = { ...s.block, s };
    });
    // group consecutive blocked samples into stretches
    const blocked = []; let cur = null;
    smp.forEach(s => { if (s.block) { if (!cur || cur.part !== s.part) { cur = { part: s.part, from: s, to: s, wi0: s.wi, wi1: s.wi, len: 0, d0: s.d, d1: s.d, pts: [s] }; blocked.push(cur); } else { cur.len += Geo.dist(cur.to, s); cur.to = s; cur.wi1 = s.wi; cur.d1 = s.d; cur.pts.push(s); } } else cur = null; });
    res = { key: k, state: 'done', blocked: blocked.filter(b => b.pts.length >= 2 || b.part !== 'маршрут'), worst };
    Core.emit('los');
  }
  function checks() {
    const out = [];
    if (res.state === 'offline') out.push({ lvl: 'info', msg: 'Связь с пультом: рельеф для проверки прямой видимости не загрузился (нет интернета) — проверка пропущена.' });
    res.blocked.forEach(b => {
      const where = b.part === 'маршрут' ? (b.wi0 === b.wi1 ? `отрезок Т.${b.wi0 + 1}→${b.wi0 + 2}` : `от отрезка Т.${b.wi0 + 1}→${b.wi0 + 2} до Т.${b.wi1 + 1}→${b.wi1 + 2}`) : b.part;
      const w = b.pts.reduce((m, s) => s.block.over > m.block.over ? s : m, b.pts[0]).block;
      out.push({ lvl: 'warn', los: true, i: b.wi0 >= 0 ? b.wi0 : undefined, msg: `Связь с пультом может пропадать: ${where}${b.len > 30 ? ` (≈${Math.round(b.len)} м пути)` : ''} — между пультом и дроном рельеф (выше линии связи на ${Math.round(w.over)} м, в ${w.dist >= 1000 ? (w.dist / 1000).toFixed(1) + ' км' : Math.round(w.dist) + ' м'} от взлёта). Поднимите высоту или взлетайте с более открытого места.` });
    });
    return out;
  }
  Core.on('change', schedule);
  setTimeout(schedule, 1500);
  return { checks, run, get result() { return res; }, height: h, load };
})();
