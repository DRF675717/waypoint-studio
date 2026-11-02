// Drone & camera database. Camera numbers: image px, focal mm, sensor mm, diagonal FOV.
// flight: rated hover/flight time (min). apps: litchi = Litchi CSV (Litchi for DJI Drones), fly = DJI Fly waypoints (WPML KMZ), pilot = DJI Pilot 2 (WPML KMZ).
const DRONES = [
  // [name, wPx, hPx, focal, sW, sH, fovDiag, flightMin, maxSpeed, gimbalMin, gimbalMax, apps, minPhotoInterval]
  ['Mini 5 Pro', 4096, 3072, 8.67, 12.89, 9.66, 84, 36, 15, -90, 60, 'fly', 2],
  ['Mini 4 Pro', 4032, 3024, 6.72, 9, 6.75, 82.1, 34, 15, -90, 60, 'fly', 2],
  ['Mini 3 Pro', 4032, 3024, 6.72, 9.65, 7.24, 82.1, 34, 15, -90, 60, 'litchi', 2],
  ['Mini 3', 4000, 3000, 6.72, 9.29, 6.96, 82.1, 38, 15, -90, 35, 'litchi', 2],
  ['Air 3S', 4096, 3072, 8.67, 12.87, 9.65, 84, 45, 15, -90, 60, 'fly', 2],
  ['Air 3', 4032, 3024, 6.72, 9.12, 6.84, 82, 46, 15, -90, 60, 'fly', 2],
  ['Mavic 4 Pro', 6144, 4096, 14.45, 17.82, 11.88, 72, 51, 15, -90, 70, 'fly', 2],
  ['Mavic 3 Pro', 5280, 3956, 12.29, 17.42, 13.06, 84, 43, 15, -90, 35, 'fly', 2],
  ['Mavic 3 / Classic', 5280, 3956, 12.29, 17.42, 13.06, 84, 46, 15, -90, 35, 'litchi', 2],
  ['Mavic 3E / 3M', 5280, 3956, 12.29, 17.42, 13.06, 84, 45, 15, -90, 35, 'pilot', 0.7],
  ['Matrice 4E', 5280, 3956, 12.29, 17.42, 13.06, 84, 49, 15, -90, 35, 'pilot', 0.5],
  ['Mini 2 / SE / Mini 4K', 4000, 3000, 4.49, 6.17, 4.55, 83, 31, 15, -90, 0, 'litchi', 2],
  ['Air 2S', 5472, 3648, 8.38, 13.2, 8.8, 88, 31, 15, -90, 0, 'litchi', 2],
  ['Mavic Air 2', 4000, 3000, 4.49, 6.4, 4.8, 84, 34, 15, -90, 0, 'litchi', 2],
  ['Mavic 2 Pro', 5472, 3648, 10.26, 13.2, 8.8, 77, 31, 15, -90, 30, 'litchi', 2],
  ['Mavic 2 Zoom', 4000, 3000, 4.49, 6.17, 4.55, 83, 31, 15, -90, 30, 'litchi', 2],
  ['Mavic Pro', 4000, 3000, 4.73, 6.17, 4.55, 78.8, 27, 15, -90, 30, 'litchi', 2],
  ['Phantom 4 Pro / V2', 5472, 3648, 8.8, 13.2, 8.8, 84, 30, 15, -90, 30, 'litchi', 2],
  ['Phantom 4', 4000, 3000, 3.61, 6.17, 4.55, 94, 28, 15, -90, 30, 'litchi', 2],
  ['Spark', 3968, 2976, 4.5, 6.17, 4.55, 81.9, 16, 15, -85, 0, 'litchi', 2],
].map(([name, wPx, hPx, focal, sW, sH, fov, flight, maxSpeed, gMin, gMax, apps, minInt]) =>
  ({ name, wPx, hPx, focal, sW, sH, fov, flight, maxSpeed, gMin, gMax, apps, minInt }));

const Camera = {
  // Ground footprint (m) at altitude h for nadir shot. Returns {w (across, image width), h (along, image height), gsd cm/px}
  footprint(d, alt) {
    let kw, kh;
    if (d.focal && d.sW) { kw = d.sW / d.focal; kh = d.sH / d.focal; }
    else {
      const diag = 2 * Math.tan(Geo.rad(d.fov / 2));
      const r = Math.hypot(d.wPx, d.hPx); kw = diag * d.wPx / r; kh = diag * d.hPx / r;
    }
    const w = alt * kw, h = alt * kh;
    return { w, h, gsd: w / d.wPx * 100, hfov: Geo.deg(2 * Math.atan(kw / 2)), vfov: Geo.deg(2 * Math.atan(kh / 2)) };
  },
  // 3D camera frame: where the 4 image corners hit the ground.
  // pos {lat,lng}, h = camera height above ground (m), heading (deg), pitch (deg, negative = down).
  // Returns corners [TL,TR,BR,BL] with z (m above ground; >0 when clipped at maxDist), center, sizes, GSD.
  // how far the camera view is DRAWN on the map / in 3D: compact, gives the idea of the shot without covering the screen
  // (the real frame size is still computed with the full distance for the numbers in the panels)
  viewMax(h) { return Math.max(35, Math.min(160, 2.2 * Math.max(1, h))); },
  frame(d, pos, h, heading, pitch, maxDist = 1500) {
    const fp = Camera.footprint(d, 1);
    const tx = Math.tan(Geo.rad(fp.hfov / 2)), ty = Math.tan(Geo.rad(fp.vfov / 2));
    const H = Geo.rad(heading), P = Geo.rad(Math.max(-90, Math.min(60, pitch)));
    const f = { x: Math.sin(H) * Math.cos(P), y: Math.cos(H) * Math.cos(P), z: Math.sin(P) };
    const r = { x: Math.cos(H), y: -Math.sin(H), z: 0 };
    const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
    h = Math.max(0.5, h);
    let clipped = false;
    const hit = (sx, sy) => {
      const dx = f.x + sx * tx * r.x + sy * ty * u.x, dy = f.y + sx * tx * r.y + sy * ty * u.y, dz = f.z + sx * tx * r.z + sy * ty * u.z;
      const L = Math.hypot(dx, dy, dz), horiz = Math.hypot(dx, dy) || 1e-9;
      let t = dz < -1e-4 ? h / -dz : Infinity;
      let range = t * L;
      if (!isFinite(t) || range > maxDist) { t = maxDist / L; clipped = true; }
      const g = Geo.dest(pos, Geo.deg(Math.atan2(dx, dy)), t * horiz);
      return { lat: g.lat, lng: g.lng, z: Math.max(0, h + t * dz), range: t * L };
    };
    const corners = [hit(-1, 1), hit(1, 1), hit(1, -1), hit(-1, -1)];
    const c = hit(0, 0);
    const dist = (a, b) => Math.hypot(Geo.dist(a, b), a.z - b.z);
    const width = (dist(corners[0], corners[1]) + dist(corners[3], corners[2])) / 2;
    const depth = (dist(corners[0], corners[3]) + dist(corners[1], corners[2])) / 2;
    const gsd = c.range * (2 * tx) / d.wPx * 100; // cm/px at frame centre
    return { corners, center: c, clipped, width, near: dist(corners[3], corners[2]), far: dist(corners[0], corners[1]), depth, centerDist: c.range, gsd };
  },
};