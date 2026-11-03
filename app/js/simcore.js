// Shared flight-simulation model for the 2D map and the 3D view: one timeline, one interpolation, one camera-state rule,
// one OSD line and one flight bubble — so both views always show exactly the same numbers.
const SimCore = (() => {
  const { S } = Core;
  const fmtT = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const rumb = h => ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'][Math.round(Geo.norm360(h) / 45) % 8];

  // timeline along the flight path: t (s), d (m along the path), position; "hold" points while actions run at a waypoint
  function build(extra) {
    const W = S.m.waypoints, s = S.m.settings; if (W.length < 2) return null;
    // timing is taken from the route statistics (with acceleration / braking), so the simulation lasts exactly
    // as long as «Время миссии» and covers exactly «Маршрут»
    const g = Core.pathGeometry(), st = Core.stats(), pts = []; let T = 0, D = 0;
    // the time of a leg is shared between its pieces by the effort each piece needs — horizontally at the leg speed,
    // vertically at the climb / descent speed — so a piece that mostly climbs is not crossed in a split second
    const vOf = i => (W[i] && W[i].speed > 0 ? W[i].speed : s.cruise) || 5;
    // … and on a curve the drone also has to turn: a piece that bends the path gets at least the time to yaw through
    // that bend (~90°/s), so a tight curve is flown slower instead of being spun through in a split second
    const bend = k => { if (k < 2) return 0; const a = g[k - 2], b = g[k - 1], c = g[k];
      if (Geo.dist(a, b) < 0.01 || Geo.dist(b, c) < 0.01 || b.wp) return 0; return Math.abs(Geo.norm180(Geo.bearing(b, c) - Geo.bearing(a, b))); };
    const cost = (a, b, k) => Math.max(Geo.dist(a, b) / vOf(a.i), b.alt > a.alt ? (b.alt - a.alt) / 5 : (a.alt - b.alt) / 3.5, bend(k) / 90);
    const pcost = []; for (let k = 1; k < g.length; k++) { const i = g[k - 1].i; pcost[i] = (pcost[i] || 0) + cost(g[k - 1], g[k], k); }
    for (let k = 0; k < g.length; k++) {
      const p = g[k];
      if (k) { const a = g[k - 1], d = Geo.dist(a, p), seg = st.segs[Math.min(a.i, st.segs.length - 1)], C = pcost[a.i] || 0;
        T += seg ? (C > 1e-6 ? seg.t * cost(a, p, k) / C : 0) : Math.hypot(d, p.alt - a.alt) / s.cruise; D += d; }
      const wi = p.wp ? p.i : null, x = extra ? extra(p) : {};
      pts.push(Object.assign({ t: T, d: D, lat: p.lat, lng: p.lng, alt: p.alt, i: p.i, wp: wi }, x));
      if (wi != null && W[wi].actions.length) {
        let dur = 0, h = Core.effHeading(wi) || 0;
        W[wi].actions.forEach(a => { dur += Core.actionTime(a, h); if (a.type === 4) h = a.param; });
        T += dur; pts.push(Object.assign({ t: T, d: D, lat: p.lat, lng: p.lng, alt: p.alt, i: p.i, wp: wi, hold: true }, x));
      }
    }
    return { pts, T, D };
  }

  // per-timeline index: for every waypoint the timeline entry of its arrival and the last entry (end of hovering)
  function idx(tl) {
    if (tl._ix) return tl._ix;
    const P = tl.pts, first = new Map(), firstAny = new Map(), last = new Map();
    P.forEach((q, i) => { if (q.wp == null) return; if (!firstAny.has(q.wp)) firstAny.set(q.wp, i); if (!q.hold && !first.has(q.wp)) first.set(q.wp, i); last.set(q.wp, i); });
    return (tl._ix = { first, firstAny, last });
  }
  const arrOf = (tl, k) => { const i = idx(tl).first.get(k); return i == null ? null : tl.pts[i].t; };
  const depOf = (tl, k) => { const i = idx(tl).last.get(k); return i == null ? null : tl.pts[i].t; };
  // first timeline entry with t >= tt (binary search; the timeline is sorted by time)
  function seek(P, tt) { let lo = 0, hi = P.length - 1; if (P[hi].t < tt) return -1; while (lo < hi) { const m = (lo + hi) >> 1; if (P[m].t >= tt) hi = m; else lo = m + 1; } return lo; }
  // drone state at time tt
  // GENERAL RULE: the camera (= drone heading) never jumps. Wherever the raw heading changes abruptly at a waypoint —
  // a point with its own fixed course after a stretch «по курсу», a mode change, the end of a hover with rotations —
  // the jump is spread over «Плавный доворот камеры» seconds (≤ 45 % of the adjacent stretch):
  //  • on ARRIVAL — the turn happens BEFORE the point, so at the point the camera already has the course set for it;
  //  • on DEPARTURE after hovering — the turn happens just AFTER leaving the point.
  // The turn always goes through the drone's front (never across its back), measured from the direction of travel.
  // AXIOM (turning from a POI back to the route): the drone turns through the sector of the circle, bounded by the
  // route line through the point, in which the POI lies — never across the line along which it arrived.
  function jumps(tl) {
    if (tl._jumps) return tl._jumps;
    const P = tl.pts, W = S.m.waypoints, tau0 = Math.max(1, S.m.settings.poiBlend ?? 3), e = 1e-3, out = [];
    tl._jumps = out;
    const arr = k => arrOf(tl, k), dep = k => depOf(tl, k);
    const rel = (h, tr) => Geo.norm180(h - tr);
    // signed turn from a to b: a small change goes the short way; a real turn goes through the drone's front, never
    // across its back (measured from the direction of travel). Without the first rule a 3° change of a camera that
    // looks backwards would turn into a 357° spin.
    const turn = (a, b, tr) => { const d = Geo.norm180(b - a); return Math.abs(d) < 30 ? d : rel(b, tr) - rel(a, tr); };
    const tAn0 = k => { const t = dep(k), n = arr(k + 1); return n != null ? n : t != null && t > arr(k) ? t : null; };
    for (let k = 1; k < W.length; k++) {
      const tA = arr(k), tD = dep(k), tDp = dep(k - 1); if (tA == null) continue;
      const h0 = rawAt(tl, tA - e).hd, h1 = rawAt(tl, tA + e).hd, tr = trackInto(P, k);
      const J = turn(h0, h1, tr), tau = tDp != null ? Math.min(tau0, 0.45 * (tA - tDp)) : 0;
      if (Math.abs(J) > 0.5 && tau > 0) out.push({ t0: tA - tau, t1: tA, J, before: true });
      // camera tilt («Камера (подвес)» = по точкам): a step at the point is played as a quick smooth tilt right after it
      const G = rawAt(tl, tA + e).gb - rawAt(tl, tA - e).gb, tN = tAn0(k), taug = tN != null ? Math.min(1.5, 0.45 * (tN - tA)) : 0;
      if (Math.abs(G) > 0.5 && taug > 0) out.push({ t0: tA, t1: tA + taug, G, gimbal: true });
      const tAn = arr(k + 1);
      if (tD != null && tD - tA > 2 * e && tAn != null) {
        const g0 = rawAt(tl, tD - e).hd, g1 = rawAt(tl, tD + e).hd;
        // AXIOM: turning away from a POI towards the route goes through the sector of the circle — bounded by the route
        // line through the point — in which the POI lies, i.e. never across the line the drone ARRIVED along; so a
        // departure that starts on a POI is measured from the arrival direction. Any other departure turn is measured
        // from the direction the path leaves the point (two samples «2 s apart» could both land on the next point → 0°).
        const aP = aimOf(k - 1), fromPoi = aP && Math.abs(Geo.norm180(g0 - Geo.bearing(W[k], aP))) < 3;
        const tro = fromPoi ? trackInto(P, k) : outDir(P, k);
        const Jd = turn(g0, g1, tro), taud = Math.min(tau0, 0.45 * (tAn - tD));
        if (Math.abs(Jd) > 0.5 && taud > 0) out.push({ t0: tD, t1: tD + taud, J: Jd, before: false });
        const Gd = rawAt(tl, tD + e).gb - rawAt(tl, tD - e).gb, taugd = Math.min(1.5, 0.45 * (tAn - tD));
        if (Math.abs(Gd) > 0.5 && taugd > 0) out.push({ t0: tD, t1: tD + taugd, G: Gd, gimbal: true });
      }
    }
    return out;
  }
  // Safety net for «the camera never jumps»: the course is followed with a limited yaw rate. The planned turns are
  // slower than this limit, so they are not touched; it only catches the rare combinations (a tiny curve on a U-turn,
  // several turn rules meeting at one point) that would otherwise spin the camera in a split second.
  const YAW_DT = 0.1;
  function yawTrack(tl) {
    if (tl._yaw) return tl._yaw;
    const s = S.m.settings, R = Math.max(200, 1.6 * 360 / Math.max(1, s.poiBlend ?? 3)) * YAW_DT;
    const n = Math.min(200000, Math.ceil(tl.T / YAW_DT) + 2), out = new Float64Array(n);
    let prev = null;
    for (let i = 0; i < n; i++) { let h = atPlanned(tl, Math.min(tl.T, i * YAW_DT)).hd;
      if (prev != null) { h = prev + Geo.norm180(h - prev); const d = h - prev; if (d > R) h = prev + R; else if (d < -R) h = prev - R; }
      out[i] = prev = h; }
    return (tl._yaw = out);
  }
  function at(tl, tt) {
    const c = atPlanned(tl, tt), y = yawTrack(tl), x = Math.max(0, Math.min(y.length - 1.000001, tt / YAW_DT)), i = Math.floor(x), f = x - i;
    const h = y[i] + (y[Math.min(y.length - 1, i + 1)] - y[i]) * f;
    if (Math.abs(Geo.norm180(h - c.hd)) > 0.3) c.hd = Geo.norm360(h);
    return c;
  }
  function atPlanned(tl, tt) {
    const c = rawAt(tl, tt); let hd = c.hd;
    for (const j of jumps(tl)) {
      if (tt <= j.t0 || tt >= j.t1) continue;
      const f = smooth((tt - j.t0) / (j.t1 - j.t0));
      if (j.gimbal) { c.gb -= j.G * (1 - f); continue; }
      // before the point: start from the old course and reach the new one exactly at the point;
      // after it: start from the old (hover-end) course and blend into the new one
      hd += j.before ? j.J * f : -j.J * (1 - f);
    }
    if (hd !== c.hd) c.hd = Geo.norm360(hd);
    return c;
  }
  function rawAt(tl, tt, noBlend) {
    const P = tl.pts, W = S.m.waypoints, s = S.m.settings;
    let k = seek(P, tt); if (k <= 0) k = k === -1 ? P.length - 1 : 1;
    const a = P[k - 1], b = P[k], f = b.t > a.t ? Math.min(1, Math.max(0, (tt - a.t) / (b.t - a.t))) : 1;
    const wi = Math.min(W.length - 1, a.i), wn = Math.min(W.length - 1, wi + 1);
    const ix = idx(tl), ia = ix.firstAny.get(wi), ib = ix.first.get(wn), ta = ia == null ? null : P[ia], tb = ib == null ? null : P[ib];
    const sf = ta && tb && tb.t > ta.t ? Math.min(1, Math.max(0, (tt - ta.t) / (tb.t - ta.t))) : 0;
    const lat = Geo.lerp(a.lat, b.lat, f), lng = Geo.lerp(a.lng, b.lng, f), alt = Geo.lerp(a.alt, b.alt, f);
    // heading on the segment wi → wn follows the heading mode OF POINT wi (a point may override the mission's mode):
    // along the path / at the POI the whole way / turning smoothly from the heading of point wi to that of point wn
    let hd; const hm = W[wi].hm || s.headingMode;
    if (hm === 'auto' || hm === 'manual') hd = Geo.dist(a, b) > 0.05 ? Geo.norm360(vdir(P, k - 1, 1) + Geo.norm180(vdir(P, k, -1) - vdir(P, k - 1, 1)) * f) : (nearDir(P, k) ?? Core.effHeading(wi) ?? 0);
    else if (hm === 'poi' && (Core.poiById(W[wi].poi) || S.m.pois[0])) hd = Geo.bearing({ lat, lng }, Core.poiById(W[wi].poi) || S.m.pois[0]);
    else {
      // the target course at the next point: if that point flies «по курсу», aim for the REAL direction the path leaves
      // it in (on a curve it differs from the straight line to the point after) — so there is nothing to correct there
      const hmN = W[wn].hm || s.headingMode, h1 = Core.effHeading(wi) ?? 0;
      const h2 = (hmN === 'auto' || hmN === 'manual') && wn < W.length - 1 ? outDir(P, wn) : (Core.effHeading(wn) ?? h1);
      hd = Geo.norm360(h1 + Geo.norm180(h2 - h1) * sf);
    }
    if (!noBlend) hd = blendPoi(tl, tt, wi, { lat, lng }, hd);
    const g1 = Core.effGimbal(wi) ?? W[wi].gimbal ?? -20, g2 = Core.effGimbal(wn) ?? g1;
    const gb = s.gimbalMode === 'interpolate' ? Geo.lerp(g1, g2, sf) : g1;
    let gbOut = gb, hdOut = hd, act = null;
    const hold = !!(b.hold && a.wp === b.wp);
    // while hovering at a waypoint its actions run one after another: rotations turn the drone, «Наклон камеры» tilts the gimbal
    if (hold) { act = actionsAt(wi, tt - a.t, hd, gb); hdOut = act.hd; gbOut = act.gb; }
    const v = b.t > a.t ? Geo.dist(a, b) / (b.t - a.t) : 0, vz = b.t > a.t ? (b.alt - a.alt) / (b.t - a.t) : 0;
    // direction of travel along the planned path (the drone icon is turned this way); while hovering — the heading
    const trk = !hold && Geo.dist(a, b) > 0.05 ? Geo.bearing(a, b) : !hold ? (nearDir(P, k) ?? hdOut) : hdOut;
    return { lat, lng, alt, trk, hd: hdOut, gb: gbOut, v: hold ? 0 : v, vz: hold ? 0 : vz, wi, wn, sf, d: Geo.lerp(a.d || 0, b.d || 0, f), hold, act };
  }

  // Smooth turns to / away from a POI (camera never snaps at a waypoint):
  //  • the next point starts looking at a POI → the drone begins turning towards it shortly BEFORE reaching that point;
  //  • the point it just left looked at a POI (and this one looks elsewhere / at another POI) → it keeps the old POI
  //    in view and turns away smoothly shortly AFTER passing the point.
  // Window = «Плавный доворот на POI» seconds (mission setting, default 3 s), at most 45 % of the segment.
  const aimOf = i => { const w = S.m.waypoints[i]; if (!w) return null; if ((w.hm || S.m.settings.headingMode) !== 'poi') return null; return Core.poiById(w.poi) || S.m.pois[0] || null; };
  const smooth = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
  // direction of the path at polyline vertex k as seen from the chord on side `side` (+1 = chord k→k+1, -1 = k-1→k).
  // Inside a curve the course is interpolated between the vertex tangents (average of both chords), so «по курсу» turns
  // smoothly instead of in small steps; at a waypoint vertex the chord itself is used (a real corner stays a corner and
  // is smoothed by the general no-jump rule).
  function chord(P, i, j) { return Geo.dist(P[i], P[j]) > 0.05 ? Geo.bearing(P[i], P[j]) : null; }
  function vdir(P, k, side) {
    const own = side > 0 ? (k + 1 < P.length ? chord(P, k, k + 1) : null) : (k > 0 ? chord(P, k - 1, k) : null);
    const oth = side > 0 ? (k > 0 && P[k].wp == null && !P[k].hold ? chord(P, k - 1, k) : null) : (k + 1 < P.length && P[k].wp == null && !P[k].hold ? chord(P, k, k + 1) : null);
    if (own == null) return oth ?? 0; if (oth == null) return own;
    return Geo.norm360(own + Geo.norm180(oth - own) / 2);
  }
  // a zero-length piece of the path (curve joints, hovering) has no direction of its own: take the nearest real piece
  function nearDir(P, k) {
    for (let j = k; j + 1 < P.length; j++) if (Geo.dist(P[j], P[j + 1]) > 0.05) return Geo.bearing(P[j], P[j + 1]);
    for (let j = k - 1; j > 0; j--) if (Geo.dist(P[j - 1], P[j]) > 0.05) return Geo.bearing(P[j - 1], P[j]);
    return null;
  }
  // direction in which the path leaves waypoint k
  const dirMemo = new WeakMap(); // P → { o: {k: outDir}, i: {k: trackInto} }
  const memo = (P, kind, k, f) => { let m = dirMemo.get(P); if (!m) dirMemo.set(P, m = { o: {}, i: {} }); return m[kind][k] !== undefined ? m[kind][k] : (m[kind][k] = f()); };
  function outDir(P, k) { return memo(P, 'o', k, () => outDir0(P, k)); }
  function trackInto(P, k) { return memo(P, 'i', k, () => trackInto0(P, k)); }
  function outDir0(P, k) {
    let j = -1; P.forEach((q, i) => { if (q.wp === k) j = i; }); if (j < 0) return 0;
    for (let i = j + 1; i < P.length; i++) if (Geo.dist(P[j], P[i]) > 1) return Geo.bearing(P[j], P[i]);
    return 0;
  }
  // direction of travel when arriving at waypoint k (tangent of the planned path just before the point)
  function trackInto0(P, k) {
    const j = P.findIndex(q => q.wp === k && !q.hold); if (j <= 0) return 0;
    for (let i = j - 1; i >= 0; i--) if (Geo.dist(P[i], P[j]) > 1) return Geo.bearing(P[i], P[j]);
    return Geo.bearing(P[0], P[j]);
  }
  function blendPoi(tl, tt, wi, pos, hd) {
    const P = tl.pts, W = S.m.waypoints, tau0 = S.m.settings.poiBlend ?? 3; if (!(tau0 > 0)) return hd;
    const arr = k => arrOf(tl, k), dep = k => depOf(tl, k);
    // entering: segment wi → wi+1, point wi+1 aims at a POI that differs from what wi aims at
    const nx = wi + 1, aN = aimOf(nx), aC = aimOf(wi);
    if (nx < W.length && aN && (!aC || aC.id !== aN.id)) {
      const tA = arr(nx), tD = dep(wi);
      if (tA != null && tD != null) { const tau = Math.min(tau0, 0.45 * (tA - tD)); if (tau > 0 && tt > tA - tau && tt <= tA) {
        // turn towards the POI through the FRONT of the drone (never across its back), measured from the direction of travel
        // the side is decided once, at the point itself (the POI may sit almost behind and cross ±180° on the way)
        const tr = trackInto(P, nx), rA = Geo.norm180(Geo.bearing(W[nx], aN) - tr);
        const r1 = rA + Geo.norm180(Geo.bearing(pos, aN) - tr - rA);
        // the course without this turn, also unwrapped around its value at the point (a sweeping course could cross ±180°)
        const c = tl._r0A || (tl._r0A = {}); if (c[nx] === undefined) c[nx] = Geo.norm180(rawAt(tl, tA - 1e-3, true).hd - tr);
        const r0 = c[nx] + Geo.norm180(hd - tr - c[nx]);
        hd = Geo.norm360(hd + (r1 - r0) * smooth((tt - (tA - tau)) / tau));
      } }
    }
    // leaving: the previous point aimed at a POI that this segment does not look at
    const aP = aimOf(wi - 1);
    if (wi > 0 && aP && (!aC || aC.id !== aP.id)) {
      const tD = dep(wi), tA = arr(wi + 1), tH = arr(wi);
      // while hovering at the point (actions) the drone still looks at the old POI — it turns away only after leaving
      if (tH != null && tD != null && tt >= tH && tt < tD) return Geo.bearing(pos, aP);
      // a «turn the drone» action at the point has already turned it away from the POI: the departure is smoothed from
      // where that turn ended (general no-jump rule), not swung from the POI again
      const rotated = W[wi].actions.some(a => a.type === 4);
      if (!rotated && tD != null && tA != null) { const tau = Math.min(tau0, 0.45 * (tA - tD)); if (tau > 0 && tt >= tD && tt < tD + tau) {
        // the camera swings from the POI to the new direction THROUGH THE HALF OF THE CIRCLE WHERE THE POI IS —
        // the side of the line along which the drone ARRIVED at the point — and then through the front, never across
        // the drone's back; measured from the arrival direction, so the swing can't flip mid-turn and goes the same
        // way as the turn of the path
        const trk = trackInto(P, wi), b0 = Geo.bearing(W[wi], aP);
        const d0 = Geo.norm180(hd - trk) - Geo.norm180(b0 - trk);
        const b = Geo.bearing(pos, aP), d = d0 + Geo.norm180(hd - b - d0);
        hd = Geo.norm360(b + d * smooth((tt - tD) / tau));
      } }
    }
    return hd;
  }
  // progress through the actions of waypoint wi, `el` seconds after arriving there
  function actionsAt(wi, el, hd0, gb0) {
    const A = S.m.waypoints[wi].actions; let tAcc = 0, h = hd0 || 0, g = gb0, cur = -1, frac = 0;
    for (let k = 0; k < A.length; k++) {
      const a = A[k], dur = Core.actionTime(a, h);
      if (el < tAcc + dur) { cur = k; frac = dur > 0 ? (el - tAcc) / dur : 1;
        if (a.type === 4) h = Geo.norm360(h + Geo.norm180((a.param || 0) - h) * frac);
        if (a.type === 5) g = g + ((a.param ?? g) - g) * frac;
        break; }
      if (a.type === 4) h = Geo.norm360(a.param || 0);
      if (a.type === 5) g = a.param ?? g;
      tAcc += dur;
    }
    return { cur: cur < 0 ? A.length : cur, frac, hd: h, gb: g, wi };
  }

  // camera at time tt: video recording (between «Начать запись» and «Остановить запись»), a photo being taken, or idle.
  // speed = playback speed: the photo flash lasts long enough to be seen at any speed
  function camState(tl, c, tt, speed) {
    const W = S.m.waypoints, P = tl.pts, arr = i => P.find(q => q.wp === i && !q.hold) || null;
    const win = Math.max(0.8, 0.5 * (speed || 1));
    // a photo while video is recording is NOT taken by the drone (the camera skips it) — exactly as the route check says
    let rec = false, photo = false, skip = false, every = '', recAtWp = false;
    for (let i = 0; i < W.length; i++) {
      const a = arr(i); if (!a || a.t > tt + 1e-6) break;
      if (c.act && c.act.wi === i) recAtWp = rec;
      const upto = c.act && c.act.wi === i ? c.act.cur + 1 : W[i].actions.length; // at the current waypoint: only started actions
      W[i].actions.slice(0, upto).forEach((x, k) => {
        if (x.type === 2) rec = true; if (x.type === 3) rec = false;
        if (x.type === 1 && (c.act && c.act.wi === i ? k === c.act.cur : tt - a.t <= win)) { if (rec) skip = true; else photo = true; }
      });
    }
    const w = W[c.wi], a = arr(c.wi), b = arr(c.wi + 1);
    if (w && a && b && tt >= a.t && tt <= b.t && !c.hold) {
      let hit = false;
      if (w.photoTime > 0 && ((tt - a.t) % w.photoTime) < win) { hit = true; every = `каждые ${w.photoTime} с`; }
      if (w.photoDist > 0 && (((c.d || 0) - (a.d || 0)) % w.photoDist) < Math.max(1, (c.v || 1) * win)) { hit = true; every = `каждые ${w.photoDist} м`; }
      if (hit) { if (rec) skip = true; else photo = true; }
    }
    return { rec, photo, skip, every, recAtWp };
  }

  // one-line status shown under both views
  const osd = (c, t, T) => `T ${fmtT(t)} / ${fmtT(T)} · Т.${c.wi + 1}/${S.m.waypoints.length}${c.hold ? ' (действия)' : ''} · H ${Math.round(c.alt)} м · ${c.v.toFixed(1)} м/с · курс ${Math.round(Geo.norm360(c.hd || 0))}° · подвес ${Math.round(c.gb)}°`;

  // flight bubble (same in 2D and 3D): height / tilt / azimuth, then the camera — every action at the waypoint on its own line
  const ACT_TXT = a => ({ 0: `⏸ Зависание ${((a.param || 0) / 1000).toFixed(a.param % 1000 ? 1 : 0)} с`, 1: '📷 Фото', 2: '● Начать запись', 3: '■ Остановить запись', 4: `⟳ Поворот дрона ${Math.round(a.param || 0)}°`, 5: `↕ Наклон камеры ${Math.round(a.param ?? 0)}°` })[a.type] || '•';
  const ACT_CLS = a => ({ 1: 'photo', 2: 'recon', 3: 'recoff' })[a.type] || '';
  // the bubble can be collapsed to a small pill (one setting for 2D and 3D, remembered)
  let mini = !!Core.store.get('ws.bubMini', false);
  function bubble(el, c, cs) {
    if (!el._b) {
      el.innerHTML = `<button class="bmin" title="Свернуть / развернуть пузырь">–</button><div class="bmini"></div><div class="bv"><span>высота<b data-b="h"></b></span><span>наклон<b data-b="g"></b></span><span>азимут<b data-b="a"></b></span></div><div class="ba"></div><div class="bc"></div>`;
      const stop = e => e.stopPropagation();
      ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel'].forEach(t => el.querySelector('.bmin').addEventListener(t, stop));
      el.querySelector('.bmin').addEventListener('click', () => { mini = !mini; Core.store.set('ws.bubMini', mini); document.querySelectorAll('.v3bub').forEach(b => { if (b._args) bubble(b, ...b._args); else b.classList.toggle('mini', mini); }); });
      el._b = { mini: el.querySelector('.bmini'), h: el.querySelector('[data-b=h]'), g: el.querySelector('[data-b=g]'), a: el.querySelector('[data-b=a]'), acts: el.querySelector('.ba'), cam: el.querySelector('.bc') };
    }
    const B = el._b, txt = (n, v) => { if (n.textContent !== v) n.textContent = v; }, set = (n, h) => { if (n._h !== h) { n.innerHTML = h; n._h = h; } };
    txt(B.h, Math.round(c.alt) + ' м'); txt(B.g, Math.round(c.gb) + '°'); txt(B.a, Math.round(Geo.norm360(c.hd || 0)) + '° ' + rumb(c.hd || 0));
    // actions of the waypoint being executed: done ✓ / current ▶ / pending
    const A = c.act ? S.m.waypoints[c.act.wi].actions : [], G = A.length ? Core.actGroups(A) : [];
    const recBefore = []; { let r = !!cs.recAtWp; A.forEach((x, k) => { recBefore[k] = r; if (x.type === 2) r = true; if (x.type === 3) r = false; }); }
    set(B.acts, G.length ? `<div class="bt">Действия в точке ${c.act.wi + 1}</div>` + G.map(g => {
      const st = c.act.cur > g.to ? 'done' : c.act.cur >= g.from ? 'now' : 'next';
      if (g.kind === 'pano') { // a panorama is ONE action: show how many of its frames are taken
        const shot = A.slice(g.from, Math.min(g.to, c.act.cur - (st === 'now' && A[c.act.cur].type === 1 ? 0 : 1)) + 1).filter(a => a.type === 1).length;
        return `<div class="al ${st}${st === 'now' && A[c.act.cur].type === 1 ? ' photo' : ''}"><i></i>🌐 Панорама 360°${st === 'now' ? ` · кадр ${Math.max(1, shot)}/${g.shots}` : st === 'done' ? ` · ${g.shots} кадров` : ''}</div>`;
      }
      // photo while recording: the camera skips it
      const lost = g.a.type === 1 && recBefore[g.from];
      return `<div class="al ${st === 'now' ? 'now ' + (lost ? 'skip' : ACT_CLS(g.a)) : st}"><i></i>${ACT_TXT(g.a)}${lost ? ' — пропущено (идёт запись)' : ''}</div>`;
    }).join('') : '');
    // camera status line(s)
    const lines = [];
    if (cs.rec) lines.push('<span class="cam rec"><i></i>ЗАПИСЬ ВИДЕО</span>');
    if (cs.photo && !c.act) lines.push(`<span class="cam photo"><i></i>ФОТО${cs.every ? ' · ' + cs.every : ''}</span>`);
    if (cs.skip && !cs.photo && !c.act) lines.push('<span class="cam skip">фото пропущено — идёт запись видео</span>');
    if (!lines.length) lines.push('<span class="cam off">камера выкл.</span>');
    set(B.cam, lines.join(''));
    el._args = [c, cs];
    el.classList.toggle('flash', cs.photo);
    el.classList.toggle('mini', mini); const k = el.querySelector('.bmin'); if (k.textContent !== (mini ? '+' : '–')) k.textContent = mini ? '+' : '–';
    if (mini) set(B.mini, `<b>${Math.round(c.alt)} м</b><span>${Math.round(c.gb)}°</span>${cs.rec ? '<i class="r"></i>' : cs.photo ? '<i class="p"></i>' : ''}`);
  }

  // height above the ground under the drone — taken from the elevation profile (the same numbers as the profile chart),
  // identical in 2D and 3D
  let prof = null, profAt = 0;
  Core.on('change', () => { prof = null; });
  function getProf() {
    const now = performance.now();
    if (!prof || (now - profAt > 1500 && (prof.homeGround === undefined || prof.samples.some(x => x.ground === undefined)))) { prof = Core.profile(); profAt = now; }
    return prof;
  }
  function agl(c) {
    const pr = getProf(); if (!pr || pr.homeGround === undefined) return c.alt;
    const sm = pr.samples, d = c.d || 0; let k = sm.findIndex(x => x.d >= d); if (k < 0) k = sm.length - 1;
    const a = sm[Math.max(0, k - 1)], b = sm[k];
    if (a.ground === undefined || b.ground === undefined) { const one = a.ground !== undefined ? a : b.ground !== undefined ? b : null; return one ? c.alt - (one.ground - pr.homeGround) : c.alt; }
    const f = b.d > a.d ? Math.max(0, Math.min(1, (d - a.d) / (b.d - a.d))) : 0;
    return c.alt - (a.ground + (b.ground - a.ground) * f - pr.homeGround);
  }

  // the POI the camera is aimed at right now (heading «на точку интереса» for the current point), or null
  function lookPoi(c) {
    const W = S.m.waypoints, w = c && W[c.wi]; if (!w) return null;
    const mode = w.hm || S.m.settings.headingMode; if (mode !== 'poi') return null;
    return Core.poiById(w.poi) || S.m.pois[0] || null;
  }
  return { _raw: rawAt, _jumps: jumps, build, at, camState, osd, bubble, agl, fmtT, rumb, lookPoi };
})();
