// Waypoint Studio — random routes through the whole program: simulation, statistics, check, every export and the
// import of what was exported. Run: node tests/fuzz.js [count] [seed]
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'app'), PORT = 8793;
const N = +(process.argv[2] || 200), SEED = +(process.argv[3] || 1);
const srv = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } const t = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }[path.extname(f)]; r.writeHead(200, t ? { 'Content-Type': t } : {}); fs.createReadStream(f).pipe(r); });
srv.listen(PORT, async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route(u => !u.href.startsWith('http://localhost:' + PORT), r => r.fulfill({ status: 200, body: '' }));
  await p.addInitScript(() => { localStorage.setItem('ws.tourDone', 'true'); });
  await p.goto(`http://localhost:${PORT}/index.html`); await p.waitForFunction(() => window.WS && WS.Core);
  // offline terrain: flat ground at 5 m so «above terrain» works without network
  await p.evaluate(() => { const E = WS.Core.Elev; E.ensure = async pts => { pts.forEach(q => { if (q) q.g = 5; }); }; if (E.get) E.get = () => 5; });
  const res = await p.evaluate(async ([N, SEED]) => {
    const C = WS.Core, S = C.S, IO = WS.IO;
    let seed = SEED >>> 0; const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; // mulberry32
    const pick = a => a[Math.floor(rnd() * a.length)], fails = [], dumps = {}, stats = { routes: 0, exports: 0, imports: 0, simSamples: 0 };
    const bad = v => typeof v !== 'number' || !isFinite(v);
    const HM = ['auto', 'initial', 'custom', 'poi', 'manual'], GM = ['interpolate', 'disabled', 'poi'], FIN = ['none', 'rth', 'land', 'first', 'reverse'];
    const drones = DRONES.map(d => d.name || d[0]);
    for (let n = 0; n < N; n++) {
      const tag = `#${n}`;
      try {
        const lat0 = -50 + rnd() * 110, lng0 = -170 + rnd() * 340, k = 2 + Math.floor(rnd() * (rnd() < 0.15 ? 60 : 10));
        const m = C.newMission ? C.newMission() : JSON.parse(JSON.stringify(S.m)); S.m = m;
        const s = m.settings; s.drone = pick(drones); s.target = pick(['fly', 'fly', 'pilot', 'litchi']); s.headingMode = pick(HM); s.gimbalMode = pick(GM);
        s.finishAction = pick(FIN); s.pathMode = pick(['curved', 'straight']); s.altMode = pick(['takeoff', 'takeoff', 'agl']); s.poiPre = pick(['off', 'on']); s.poiBlend = pick([0, 1, 3, 6]);
        s.cruise = 2 + rnd() * 12;
        m.home = rnd() < 0.8 ? { lat: lat0 - 0.001, lng: lng0 - 0.001 } : null;
        m.pois = []; const np = Math.floor(rnd() * 3); for (let i = 0; i < np; i++) m.pois.push({ id: 'p' + i, name: 'POI ' + (i + 1), lat: lat0 + (rnd() - 0.5) * 0.01, lng: lng0 + (rnd() - 0.5) * 0.01, alt: Math.round(rnd() * 30) });
        m.waypoints = [];
        let la = lat0, ln = lng0;
        for (let i = 0; i < k; i++) {
          if (i) { const d = rnd() < 0.1 ? rnd() * 3 : 10 + rnd() * 600, a = rnd() * 360; const q = Geo.dest({ lat: la, lng: ln }, a, d); la = q.lat; ln = q.lng; }
          const w = C.newWaypoint({ lat: la, lng: ln, alt: Math.round(5 + rnd() * 200) }, m);
          if (rnd() < 0.4) w.hm = pick(HM); w.heading = Math.round(rnd() * 360); w.gimbal = -Math.round(rnd() * 90); w.speed = rnd() < 0.3 ? Math.round(rnd() * 15) : 0; w.curve = Math.round(rnd() * 40);
          if (m.pois.length && rnd() < 0.5) C.lookAt(w, pick(m.pois).id);
          if (rnd() < 0.3) w.gkeep = true; if (rnd() < 0.2) w.zoom = 1 + Math.round(rnd() * 3);
          if (rnd() < 0.15) w.photoDist = Math.round(10 + rnd() * 50); else if (rnd() < 0.1) w.photoTime = Math.round(2 + rnd() * 5);
          const na = rnd() < 0.5 ? 0 : 1 + Math.floor(rnd() * 4); w.actions = [];
          for (let j = 0; j < na; j++) { const t = pick([0, 1, 2, 3, 4, 5]); w.actions.push({ type: t, param: t === 0 ? 1000 + Math.round(rnd() * 4000) : t === 4 ? Math.round(rnd() * 360 - 180) : t === 5 ? -Math.round(rnd() * 90) : 0 }); }
          m.waypoints.push(w);
        }
        C.changed({}); stats.routes++;
        // statistics and check
        const st = C.stats(); for (const key of ['dist', 'time', 'battery']) if (bad(st[key])) fails.push(`${tag} stats.${key}=${st[key]}`);
        const v = C.validate(); if (!Array.isArray(v)) fails.push(`${tag} validate not array`);
        // simulation: no NaN, the camera never jumps faster than the drone can turn
        const tl = SimCore.build(q => ({ g: 5 }));
        if (!tl) { fails.push(`${tag} no timeline`); continue; }
        let prev = null, worst = 0, wt = 0, wi = 0, wpv = null;
        const dt = Math.max(0.05, tl.T / 4000);
        for (let t = 0; t <= tl.T + 1e-9; t += dt) {
          const c = SimCore.at(tl, t); stats.simSamples++;
          for (const key of ['lat', 'lng', 'alt', 'hd', 'gb']) if (bad(c[key])) { fails.push(`${tag} sim ${key}=${c[key]} at t=${t.toFixed(2)}`); t = 1e12; break; }
          if (prev && !c.hold && !prev.hold) { const rate = Math.abs(Geo.norm180(c.hd - prev.hd)) / dt; if (rate > worst) { worst = rate; wt = t; wi = c.wi; wpv = [prev.hd, c.hd].map(Math.round); } }
          prev = c;
        }
        const W = S.m.waypoints;
        // DJI drones turn up to ~ 120-150°/s; above 400°/s outside hovering is a snap
        // allowed: a turn of up to 360° (through the front) spread over the «smooth turn» time; very short legs (< 5 m) shrink
        // that time to 45 % of the leg and are not counted
        const legShort = W[wi + 1] && Geo.dist(W[wi], W[wi + 1]) < 5 || wi > 0 && Geo.dist(W[wi - 1], W[wi]) < 5;
        if (s.poiBlend > 0 && !legShort && worst > 1.1 * Math.max(200, 1.6 * 360 / Math.max(1, s.poiBlend))) { const P = tl.pts, ta = (P.find(q => q.wp === wi && !q.hold) || {}).t, tb = (P.find(q => q.wp === wi + 1 && !q.hold) || {}).t;
          dumps[n] = { m: JSON.parse(JSON.stringify(S.m)), t: wt };
          fails.push(`${tag} heading snap ${Math.round(worst)}°/s at t=${wt.toFixed(1)} (${s.headingMode}, blend ${s.poiBlend}, path ${s.pathMode}) P${wi + 1}(${W[wi].hm || '-'})→P${wi + 2}(${(W[wi + 1] || {}).hm || '-'}) leg ${W[wi + 1] ? Geo.dist(W[wi], W[wi + 1]).toFixed(1) : '-'} m, ${ta != null && tb != null ? (tb - ta).toFixed(2) : '?'} s, hd ${wpv}`); }
        // exports + import back
        const nExp = IO.exportList().length;
        if (s.finishAction === 'reverse' && nExp < 2 * W.length - 1) fails.push(`${tag} reverse not in export list (${nExp} for ${W.length})`);
        const kinds = [{ litchi: 'csv', fly: 'fly', pilot: 'pilot' }[s.target]];
        for (const kd of kinds.concat(['kml', 'gpx', 'geojson'])) {
          let out;
          try {
            if (kd === 'fly') out = await IO.djiFlyKMZ(); else if (kd === 'pilot') out = await IO.wpmlKMZ('pilot');
            else if (kd === 'csv') out = IO.litchiCSV(); else if (kd === 'kml') out = await IO.kml(); else if (kd === 'gpx') out = await IO.gpx(); else out = IO.geojson();
            stats.exports++;
          } catch (e) {
            // a refused export is fine only if the «Check» tab already shows an error (the user is warned before exporting)
            if (!v.some(x => x.lvl === 'err')) fails.push(`${tag} export ${kd} refused but the check shows no error: ${e.message}`);
            continue; }
          if (kd === 'fly' || kd === 'pilot' || kd === 'csv') {
            try {
              const blob = out instanceof Blob ? out : new Blob([out]);
              const f = new File([blob], 'x.' + (kd === 'csv' ? 'csv' : 'kmz'));
              const back = await IO.importFile(f); stats.imports++;
              const BW = back.waypoints, EW = IO.exportList();
              if (kd !== 'csv' && BW.length !== EW.length) fails.push(`${tag} ${kd} round trip: ${BW.length} points back, ${EW.length} written`);
              if (kd === 'csv' && BW.length !== W.length) fails.push(`${tag} csv round trip: ${BW.length} of ${W.length}`);
              const ref = kd === 'csv' ? W : EW;
              for (let i = 0; i < Math.min(BW.length, ref.length); i++) {
                const a = ref[i], q = BW[i];
                if (Geo.dist(a, q) > 0.5) { fails.push(`${tag} ${kd} point ${i + 1} moved ${Geo.dist(a, q).toFixed(2)} m`); break; }
                if (s.altMode !== 'agl' && Math.abs((q.alt) - a.alt) > 0.2) { fails.push(`${tag} ${kd} point ${i + 1} height ${a.alt} → ${q.alt}`); break; }
                if (kd !== 'csv' && i === 0 && s.gimbalMode !== 'disabled' && Math.abs((C.effGimbal(0) ?? a.gimbal) - q.gimbal) > 0.6 && Math.abs(q.gimbal) < 90) { fails.push(`${tag} ${kd} point 1 camera tilt ${C.effGimbal(0)} → ${q.gimbal}`); break; }
                if (kd !== 'csv' && a.actions.length && q.actions.length < Math.min(a.actions.length, 15) - a.actions.filter(x => x.type === 4).length) { dumps['a' + n] = { m: JSON.parse(JSON.stringify(S.m)), kd, i }; fails.push(`${tag} ${kd} point ${i + 1} actions ${a.actions.length} → ${q.actions.length} [${a.actions.map(x => x.type).join(',')}]→[${q.actions.map(x => x.type).join(',')}] gm=${s.gimbalMode}`); break; }
              }
            } catch (e) { fails.push(`${tag} import ${kd}: ${e.message}`); }
          }
        }
      } catch (e) { fails.push(`${tag} ${e.message} ${(e.stack || '').split('\n')[1] || ''}`); }
    }
    return { fails, stats, dumps };
  }, [N, SEED]);
  console.log(JSON.stringify(res.stats)); if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(res.dumps));
  const groups = {}; res.fails.forEach(f => { const k = f.replace(/^#\d+ /, '').replace(/[\d.]+/g, 'N').slice(0, 70); (groups[k] = groups[k] || []).push(f); });
  for (const [k, v] of Object.entries(groups)) console.log(`${v.length}× ${v[0].slice(0, 220)}`);
  if (errs.length) console.log('page errors:', errs.slice(0, 5));
  console.log(res.fails.length ? `FAIL ${res.fails.length}` : 'OK');
  await b.close(); srv.close(); process.exit(res.fails.length ? 1 : 0);
});
