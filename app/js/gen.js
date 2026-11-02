// Flight generators: orbit, spiral, area mapping (grid), corridor, facade; and mission transforms
const Gen = (() => {
  const { S } = Core;
  const mk = (p, extra) => Object.assign(Core.newWaypoint(p, S.m), extra || {});

  function addPoi(center, alt, name) {
    const ex = S.m.pois.find(p => Geo.dist(p, center) < 1);
    if (ex) return ex;
    const p = { id: Core.id(), lat: center.lat, lng: center.lng, alt: alt || 0, name: name || 'POI ' + (S.m.pois.length + 1) };
    S.m.pois.push(p); return p;
  }

  // Orbit / spiral around center. o: {center, r1, r2, alt1, alt2, n (points per rev), revs, dir(1 cw,-1 ccw), start(deg), poiAlt}
  function orbit(o) {
    const poi = addPoi(o.center, o.poiAlt, o.poiName || 'Центр орбиты');
    const total = Math.max(3, Math.round(o.n * o.revs));
    const closed = o.r1 === o.r2 && o.alt1 === o.alt2 && Math.abs(o.revs - Math.round(o.revs)) < 1e-6;
    const N = closed ? total : total + 1;
    const out = [];
    for (let k = 0; k < N; k++) {
      const t = closed ? k / N : k / (N - 1);
      const ang = o.start + o.dir * 360 * o.revs * t;
      const r = Geo.lerp(o.r1, o.r2, t), alt = Geo.lerp(o.alt1, o.alt2, t);
      const p = Geo.dest(o.center, ang, r);
      const segLen = 2 * Math.min(o.r1, o.r2, r) * Math.sin(Math.PI / o.n); // chord
      out.push(mk({ lat: p.lat, lng: p.lng, alt: Math.round(alt * 10) / 10 }, { poi: poi.id, curve: Math.floor(segLen * 0.45 * 10) / 10, gimbal: -Math.round(Geo.deg(Math.atan2(alt - (o.poiAlt || 0), r))) }));
    }
    if (o.video) { out[0].actions.push({ type: 2, param: 0 }); out[out.length - 1].actions.push({ type: 3, param: 0 }); }
    return { wps: out, settings: { headingMode: 'poi', gimbalMode: 'poi', pathMode: 'curved' } };
  }

  // Cinematic shots (as in Drone Harmony / Dronelink / DJI QuickShots), built as an ordinary waypoint route.
  // o: {kind: dronie|rocket|reveal|flyby|approach, center, az (deg: from the subject towards the start), dist, h1, h2, poiAlt, video}
  function cine(o) {
    const c = o.center, az = o.az || 0, D = Math.max(10, o.dist || 80), h1 = o.h1 ?? 5, h2 = o.h2 ?? 60, pa = o.poiAlt || 0;
    const tilt = (p, h) => -Math.round(Geo.deg(Math.atan2(h - pa, Math.max(1, Geo.dist(p, c)))));
    const out = []; let settings, poi = null;
    const add = (p, alt, x) => out.push(mk({ lat: p.lat, lng: p.lng, alt: Math.round(alt * 10) / 10 }, x));
    const N = 5;
    if (o.kind === 'dronie' || o.kind === 'approach') { // away from the subject while rising (dronie) / towards it (approach)
      poi = addPoi(c, pa, o.poiName || 'Объект съёмки');
      for (let k = 0; k < N; k++) {
        const f = k / (N - 1), t = o.kind === 'dronie' ? f : 1 - f;
        const r = Geo.lerp(Math.min(12, D * 0.15), D, t), alt = o.kind === 'dronie' ? Geo.lerp(h1, h2, t) : Geo.lerp(Math.max(h1, 15), h2, t), p = Geo.dest(c, az, r); /* the approach never ends lower than 15 m */
        add(p, alt, { poi: poi.id, gimbal: tilt(p, alt), curve: Math.round(D / N * 0.4) });
      }
      settings = { headingMode: 'poi', gimbalMode: 'poi', pathMode: 'curved' };
    } else if (o.kind === 'rocket') { // straight up above the subject, camera down
      for (let k = 0; k < N; k++) { const f = k / (N - 1), p = Geo.dest(c, az, 1 + k * 1.2); add(p, Geo.lerp(h1, h2, f), { heading: Geo.norm360(az + 180), gimbal: -90, curve: 0.5 }); }
      settings = { headingMode: 'custom', gimbalMode: 'interpolate', pathMode: 'curved' };
    } else if (o.kind === 'reveal') { // fly forward towards the subject, rising, camera lifts from the ground to the horizon
      for (let k = 0; k < N; k++) {
        const f = k / (N - 1), p = Geo.dest(c, az, Geo.lerp(D, D * 0.35, f));
        add(p, Geo.lerp(Math.max(h1, 10), h2, f), { heading: Geo.norm360(az + 180), gimbal: Math.round(Geo.lerp(-75, -5, f)), curve: Math.round(D / N * 0.4) });
      }
      settings = { headingMode: 'custom', gimbalMode: 'interpolate', pathMode: 'curved' };
    } else { // flyby: straight pass past the subject at distance D, the camera keeps it in the frame
      poi = addPoi(c, pa, o.poiName || 'Объект съёмки');
      const mid = Geo.dest(c, az, D);
      for (let k = 0; k < N; k++) { const f = k / (N - 1), p = Geo.dest(mid, az + 90, Geo.lerp(-D * 1.2, D * 1.2, f)), alt = Math.max(15, h2); /* constant height */ add(p, alt, { poi: poi.id, gimbal: tilt(p, alt), curve: Math.round(D * 0.3) }); }
      settings = { headingMode: 'poi', gimbalMode: 'poi', pathMode: 'curved' };
    }
    if (o.video) { out[0].actions.push({ type: 2, param: 0 }); out[out.length - 1].actions.push({ type: 3, param: 0 }); }
    return { wps: out, settings };
  }

  // Area mapping (lawn-mower grid). o: {poly[], alt, front, side, angle|null, margin, capture:'distance'|'waypoints'|'time', cross, oblique (gimbal), speed}
  function grid(o) {
    const d = Core.drone();
    const poly = o.poly; if (poly.length < 3) throw new Error('Нарисуйте зону (минимум 3 вершины) в режиме «Зона».');
    const fp = Camera.footprint(d, o.alt);
    // Fly with image width across the track (landscape, nose forward): across = fp.w, along = fp.h
    const spacing = fp.w * (1 - o.side / 100), photoStep = fp.h * (1 - o.front / 100);
    if (spacing < 1 || photoStep < 0.5) throw new Error('Слишком большое перекрытие или малая высота');
    const origin = Geo.centroid(poly);
    let xy = poly.map(p => Geo.toXY(origin, p));
    xy = Geo.offsetPolyXY(xy, o.margin || 0);
    const baseAng = o.angle == null || isNaN(o.angle) ? Geo.longestEdgeAngle(xy) : 90 - o.angle; // user angle: compass bearing of lines
    const passes = [Geo.sweepLines(xy, spacing, baseAng)];
    if (o.cross) passes.push(Geo.sweepLines(xy, spacing, baseAng + 90));
    const maxV = Math.min(15, d.maxSpeed, photoStep / Math.max(d.minInt, 0.5));
    const v = Math.min(o.speed || maxV, maxV);
    const wps = [];
    passes.forEach(segs => {
      segs.forEach((seg, k) => {
        let [a, b] = seg; if (k % 2) [a, b] = [b, a];
        // extend line by half photo step so the edges are covered
        const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
        const ext = photoStep * 0.5;
        a = { x: a.x - ux * ext, y: a.y - uy * ext }; b = { x: b.x + ux * ext, y: b.y + uy * ext };
        const A = Geo.fromXY(origin, a), B = Geo.fromXY(origin, b);
        const g = o.oblique != null ? o.oblique : -90;
        if (o.capture === 'waypoints') {
          const n = Math.max(1, Math.round((L + 2 * ext) / photoStep));
          for (let j = 0; j <= n; j++) { const p = Geo.interp(A, B, j / n); wps.push(mk({ lat: p.lat, lng: p.lng, alt: o.alt, gimbal: g }, { curve: 0, actions: [{ type: 1, param: 0 }] })); }
        } else {
          const w1 = mk({ lat: A.lat, lng: A.lng, alt: o.alt, gimbal: g }, { curve: 0, speed: Math.round(v * 10) / 10 });
          if (o.capture === 'time') w1.photoTime = Math.max(d.minInt, Math.round(photoStep / v * 10) / 10); else w1.photoDist = Math.round(photoStep * 10) / 10;
          wps.push(w1, mk({ lat: B.lat, lng: B.lng, alt: o.alt, gimbal: g }, { curve: 0, speed: Math.round(v * 10) / 10 }));
        }
      });
    });
    const area = Geo.polygonArea(poly);
    const info = { gsd: fp.gsd, fw: fp.w, fh: fp.h, spacing, photoStep, speed: v, area, lines: passes.reduce((s, p) => s + p.length, 0), photos: o.capture === 'waypoints' ? wps.length : wps.reduce((a, w, i) => a + (w.photoDist > 0 && wps[i + 1] ? Math.floor(Geo.dist(w, wps[i + 1]) / w.photoDist) + 1 : w.photoTime > 0 && wps[i + 1] ? Math.floor(Geo.dist(w, wps[i + 1]) / v / w.photoTime) + 1 : 0), 0), angle: Geo.norm360(90 - baseAng) };
    return { wps, info, settings: { headingMode: 'auto', gimbalMode: 'interpolate', pathMode: 'straight' } };
  }

  // Corridor: o: {line[], width, alt, side, front}
  function corridor(o) {
    const d = Core.drone();
    if (o.line.length < 2) throw new Error('Нарисуйте линию (минимум 2 точки) в режиме «Линия».');
    const fp = Camera.footprint(d, o.alt);
    const spacing = fp.w * (1 - o.side / 100), photoStep = fp.h * (1 - o.front / 100);
    const n = Math.max(1, Math.ceil(o.width / spacing));
    const origin = o.line[0], xy = o.line.map(p => Geo.toXY(origin, p));
    const wps = [];
    for (let k = 0; k < n; k++) {
      const off = n === 1 ? 0 : -o.width / 2 + spacing / 2 + k * (o.width - spacing) / (n - 1);
      let l = Geo.offsetLineXY(xy, off).map(q => Geo.fromXY(origin, q));
      if (k % 2) l = l.reverse();
      l.forEach((p, j) => {
        const w = mk({ lat: p.lat, lng: p.lng, alt: o.alt, gimbal: -90 }, { curve: 0 });
        if (j < l.length - 1) w.photoDist = Math.round(photoStep * 10) / 10;
        wps.push(w);
      });
    }
    return { wps, info: { gsd: fp.gsd, passes: n, spacing, photoStep }, settings: { headingMode: 'auto', gimbalMode: 'interpolate', pathMode: 'straight' } };
  }

  // Facade scan: wall defined by line[0..1]; drone stands `dist` m from the wall on the chosen side; vertical lawn-mower
  function facade(o) {
    const d = Core.drone();
    if (o.line.length < 2) throw new Error('Нарисуйте линию вдоль стены (2 точки) в режиме «Линия».');
    const [A, B] = o.line; const brg = Geo.bearing(A, B), L = Geo.dist(A, B);
    const fp = Camera.footprint(d, o.dist); // footprint at distance to wall
    const hStep = fp.h * (1 - o.side / 100), photoStep = fp.w * (1 - o.front / 100);
    const side = o.side2 === 'left' ? -90 : 90;
    const A2 = Geo.dest(A, brg + side, o.dist), B2 = Geo.dest(B, brg + side, o.dist);
    const face = Geo.norm360(brg - side);
    const rows = Math.max(1, Math.ceil((o.h2 - o.h1) / hStep) + 1);
    const wps = [];
    for (let r = 0; r < rows; r++) {
      const alt = rows === 1 ? o.h1 : o.h1 + (o.h2 - o.h1) * r / (rows - 1);
      const [p, q] = r % 2 ? [B2, A2] : [A2, B2];
      const w1 = mk({ lat: p.lat, lng: p.lng, alt: Math.round(alt * 10) / 10, gimbal: 0 }, { curve: 0, heading: face, photoDist: Math.round(photoStep * 10) / 10, speed: 2 });
      const w2 = mk({ lat: q.lat, lng: q.lng, alt: Math.round(alt * 10) / 10, gimbal: 0 }, { curve: 0, heading: face, speed: 2 });
      wps.push(w1, w2);
    }
    return { wps, info: { rows, length: L, photoStep, gsd: fp.gsd }, settings: { headingMode: 'custom', gimbalMode: 'interpolate', pathMode: 'straight' } };
  }

  function apply(res, replace) {
    Core.snap();
    if (replace) S.m.waypoints = res.wps; else S.m.waypoints.push(...res.wps);
    Object.assign(S.m.settings, res.settings || {});
    if (!S.m.home && res.wps.length) {
      const p = res.wps[0]; S.m.home = Geo.dest(p, 180, 15);
    }
    S.sel.clear(); res.wps.forEach(w => S.sel.add(w.id));
    Core.changed({ fit: true });
  }

  // ---------- transforms (apply to selection, or whole mission) ----------
  function targets() { const W = S.m.waypoints; return S.sel.size ? W.filter(w => S.sel.has(w.id)) : W; }
  function translate(dx, dy) { // metres east/north
    Core.snap();
    targets().forEach(w => { const q = Geo.fromXY(w, { x: dx, y: dy }); w.lat = q.lat; w.lng = q.lng; });
    Core.changed();
  }
  function rotate(deg, withHeadings) {
    const T = targets(); if (!T.length) return; Core.snap();
    const c = Geo.centroid(T);
    T.forEach(w => { const q = Geo.rotXY(Geo.toXY(c, w), -deg); const p = Geo.fromXY(c, q); w.lat = p.lat; w.lng = p.lng; if (withHeadings) w.heading = Geo.norm360(w.heading + deg); });
    Core.changed();
  }
  function scale(k) {
    const T = targets(); if (!T.length) return; Core.snap();
    const c = Geo.centroid(T);
    T.forEach(w => { const q = Geo.toXY(c, w); const p = Geo.fromXY(c, { x: q.x * k, y: q.y * k }); w.lat = p.lat; w.lng = p.lng; });
    Core.changed();
  }
  function altOffset(dz) { Core.snap(); targets().forEach(w => w.alt = Math.round((w.alt + dz) * 10) / 10); Core.changed(); }
  function reverse() { Core.snap(); S.m.waypoints.reverse(); Core.changed(); }
  // Make altitudes follow terrain: set each waypoint so that it is `agl` m above ground (in takeoff-relative mode)
  async function followTerrain(agl) {
    const W = targets(); const h = Core.homePt(); if (!h) return;
    await Core.Elev.ensure(W.concat([h]));
    const gh = Core.groundAt(h); if (gh === undefined) throw new Error('Нет данных о рельефе');
    Core.snap();
    W.forEach(w => { const g = Core.groundAt(w); if (g !== undefined) w.alt = Math.round((S.m.settings.altMode === 'agl' ? agl : g - gh + agl) * 10) / 10; });
    Core.changed();
  }
  // Densify long segments so terrain following is smooth (adds intermediate points every `step` m)
  function densify(step) {
    Core.snap();
    const W = S.m.waypoints, out = [];
    W.forEach((w, i) => {
      out.push(w);
      if (i < W.length - 1) {
        const n = W[i + 1], d = Geo.dist(w, n), k = Math.floor(d / step);
        for (let j = 1; j < k; j++) { const p = Geo.interp(w, n, j / k); out.push(Object.assign(JSON.parse(JSON.stringify(w)), { id: Core.id(), lat: p.lat, lng: p.lng, actions: [], alt: Geo.lerp(w.alt, n.alt, j / k), gimbal: Geo.lerp(w.gimbal, n.gimbal, j / k) })); }
      }
    });
    S.m.waypoints = out; Core.changed();
  }
  return { cine, orbit, grid, corridor, facade, apply, translate, rotate, scale, altOffset, reverse, followTerrain, densify, addPoi };
})();
