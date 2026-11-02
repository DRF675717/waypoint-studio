// Geodesy & geometry helpers (WGS84 sphere approximation, good for < 50 km missions)
const Geo = (() => {
  const R = 6371008.8;
  const rad = d => d * Math.PI / 180;
  const deg = r => r * 180 / Math.PI;

  function dist(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function dest(p, brg, d) {
    const δ = d / R, θ = rad(brg), φ1 = rad(p.lat), λ1 = rad(p.lng);
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
    return { lat: deg(φ2), lng: ((deg(λ2) + 540) % 360) - 180 };
  }
  // Local tangent plane (east/north metres) around an origin
  function toXY(o, p) {
    return { x: rad(p.lng - o.lng) * R * Math.cos(rad(o.lat)), y: rad(p.lat - o.lat) * R };
  }
  function fromXY(o, q) {
    return { lat: o.lat + deg(q.y / R), lng: o.lng + deg(q.x / (R * Math.cos(rad(o.lat)))) };
  }
  const norm360 = a => ((a % 360) + 360) % 360;
  const norm180 = a => { a = norm360(a); return a > 180 ? a - 360 : a; };
  const lerp = (a, b, t) => a + (b - a) * t;
  function interp(a, b, t) { return { lat: lerp(a.lat, b.lat, t), lng: lerp(a.lng, b.lng, t) }; }
  function centroid(pts) {
    const n = pts.length || 1;
    return { lat: pts.reduce((s, p) => s + p.lat, 0) / n, lng: pts.reduce((s, p) => s + p.lng, 0) / n };
  }
  function rotXY(q, angDeg) {
    const a = rad(angDeg), c = Math.cos(a), s = Math.sin(a);
    return { x: q.x * c - q.y * s, y: q.x * s + q.y * c };
  }
  function polygonArea(pts) { // m², pts lat/lng
    if (pts.length < 3) return 0;
    const o = pts[0]; const xy = pts.map(p => toXY(o, p));
    let s = 0; for (let i = 0; i < xy.length; i++) { const a = xy[i], b = xy[(i + 1) % xy.length]; s += a.x * b.y - b.x * a.y; }
    return Math.abs(s / 2);
  }
  function pointInPoly(q, poly) { // xy
    let ins = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > q.y) !== (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x) ins = !ins;
    }
    return ins;
  }
  // Angle (deg, math convention in local XY) of longest polygon edge – good default sweep direction
  function longestEdgeAngle(xy) {
    let best = 0, ang = 0;
    for (let i = 0; i < xy.length; i++) {
      const a = xy[i], b = xy[(i + 1) % xy.length];
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (l > best) { best = l; ang = deg(Math.atan2(b.y - a.y, b.x - a.x)); }
    }
    return ang;
  }
  // Buffer polygon outward by m metres (simple vertex offset along bisector; ok for convex-ish shapes)
  function offsetPolyXY(xy, m) {
    if (!m) return xy;
    const n = xy.length;
    let area = 0; for (let i = 0; i < n; i++) { const a = xy[i], b = xy[(i + 1) % n]; area += a.x * b.y - b.x * a.y; }
    const sign = area > 0 ? -1 : 1; // outward normal sign
    return xy.map((p, i) => {
      const a = xy[(i - 1 + n) % n], b = xy[(i + 1) % n];
      const n1 = normal(a, p), n2 = normal(p, b);
      let nx = n1.x + n2.x, ny = n1.y + n2.y; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      const cos = Math.max(0.3, nx * n1.x + ny * n1.y);
      return { x: p.x + sign * nx * m / cos, y: p.y + sign * ny * m / cos };
    });
    function normal(a, b) { const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; return { x: dy / l, y: -dx / l }; }
  }
  // Offset polyline (xy) sideways by d (left positive)
  function offsetLineXY(xy, d) {
    const n = xy.length; if (n < 2) return xy;
    return xy.map((p, i) => {
      const a = xy[Math.max(0, i - 1)], b = xy[Math.min(n - 1, i + 1)];
      let nx = 0, ny = 0;
      const add = (u, v) => { const dx = v.x - u.x, dy = v.y - u.y, l = Math.hypot(dx, dy) || 1; nx += -dy / l; ny += dx / l; };
      if (i > 0) add(a, p); if (i < n - 1) add(p, b);
      const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      let cos = 1;
      if (i > 0 && i < n - 1) { const dx = p.x - a.x, dy = p.y - a.y, ll = Math.hypot(dx, dy) || 1; cos = Math.max(0.35, nx * (-dy / ll) + ny * (dx / ll)); }
      return { x: p.x + nx * d / cos, y: p.y + ny * d / cos };
    });
  }
  // Lawn-mower sweep lines across polygon (xy), spacing s, direction angle a (deg). Returns array of [p,q] segments in sweep order.
  function sweepLines(xy, spacing, angle) {
    const r = xy.map(p => rotXY(p, -angle));
    const ys = r.map(p => p.y); const ymin = Math.min(...ys), ymax = Math.max(...ys);
    const out = [];
    const h = ymax - ymin; const nLines = Math.max(1, Math.ceil(h / spacing));
    const start = ymin + (h - (nLines - 1) * spacing) / 2; // centred lines
    for (let k = 0; k < nLines; k++) {
      const y = nLines === 1 ? (ymin + ymax) / 2 : start + k * spacing;
      const xs = [];
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
      }
      xs.sort((u, v) => u - v);
      if (xs.length >= 2) out.push([{ x: xs[0], y }, { x: xs[xs.length - 1], y }]);
    }
    return out.map(([p, q]) => [rotXY(p, angle), rotXY(q, angle)]);
  }
  return { R, rad, deg, dist, bearing, dest, toXY, fromXY, norm360, norm180, lerp, interp, centroid, rotXY, polygonArea, pointInPoly, longestEdgeAngle, offsetPolyXY, offsetLineXY, sweepLines };
})();

// Sun position (accurate to ~0.5°, enough for planning light and shadows) and the day's light events.
const Sun = {
  pos(ms, lat, lng) {
    const rad = Math.PI / 180, d = ms / 86400000 - 10957.5;
    const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad, e = (23.439 - 0.00000036 * d) * rad;
    const RA = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24, H = (gmst * 15 + lng) * rad - RA, la = lat * rad;
    const alt = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(la) - Math.tan(dec) * Math.cos(la));
    return { alt: alt / rad, az: ((az / rad) + 180 + 360) % 360 };
  },
  // events of the day that starts at local midnight `day0` (ms): crossings of the sun altitude thresholds
  day(day0, lat, lng) {
    const ev = { rise: null, set: null, gmEnd: null, geStart: null, bmStart: null, beEnd: null, noon: null }; let prev = null, best = -99;
    for (let m = 0; m <= 1440; m += 2) {
      const t = day0 + m * 60000, a = this.pos(t, lat, lng).alt;
      if (a > best) { best = a; ev.noon = t; }
      if (prev != null) {
        const up = (th) => prev < th && a >= th, dn = (th) => prev >= th && a < th;
        if (up(-0.833) && !ev.rise) ev.rise = t; if (dn(-0.833)) ev.set = t;
        if (up(6) && !ev.gmEnd) ev.gmEnd = t; if (dn(6)) ev.geStart = t;
        if (up(-6) && !ev.bmStart) ev.bmStart = t; if (dn(-6)) ev.beEnd = t;
      }
      prev = a;
    }
    ev.maxAlt = best; return ev;
  },
};
