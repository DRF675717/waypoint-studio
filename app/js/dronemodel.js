// A small 3D quadcopter model (glTF 2.0, built in code — no external files) for the 3D view, and a matching top-view
// icon for the 2D map. Like Litchi: red body, 4 arms with grey propeller discs, the camera and a white stripe mark the
// FRONT, so the drone's heading is obvious at a glance. Model axes: +X = front, +Y = up (glTF), size ≈ 0.35 m.
const DroneModel = (() => {
  // simple solid modelling: every part is turned into triangles with normals, grouped by material
  // glTF axes: +X = front (nose, camera), +Y = up, +Z = right
  const MATS = {
    red: [0.86, 0.1, 0.13, 1], dark: [0.12, 0.13, 0.15, 1], white: [1, 1, 1, 1], black: [0.03, 0.03, 0.035, 1],
    lens: [0.2, 0.45, 0.85, 1], disc: [0.85, 0.88, 0.92, 0.35], grey: [0.45, 0.47, 0.5, 1],
  };
  const G = {}; Object.keys(MATS).forEach(k => { G[k] = { pos: [], nor: [], idx: [] }; });
  const vtx = (m, p, n) => { const g = G[m]; g.pos.push(...p); g.nor.push(...n); return g.pos.length / 3 - 1; };
  const tri = (m, a, b, c) => G[m].idx.push(a, b, c);
  const quad = (m, a, b, c, d) => { tri(m, a, b, c); tri(m, a, c, d); };
  // vertical cylinder / tube: centre [x,y,z], outer radius r, inner radius ri (0 = solid), height h
  function tube(m, [cx, cy, cz], r, ri, h, seg = 28) {
    const y0 = cy - h / 2, y1 = cy + h / 2;
    for (let k = 0; k < seg; k++) {
      const a0 = k / seg * 2 * Math.PI, a1 = (k + 1) / seg * 2 * Math.PI, c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      // outer wall
      quad(m, vtx(m, [cx + r * c0, y0, cz + r * s0], [c0, 0, s0]), vtx(m, [cx + r * c1, y0, cz + r * s1], [c1, 0, s1]), vtx(m, [cx + r * c1, y1, cz + r * s1], [c1, 0, s1]), vtx(m, [cx + r * c0, y1, cz + r * s0], [c0, 0, s0]));
      if (ri > 0) {
        quad(m, vtx(m, [cx + ri * c0, y1, cz + ri * s0], [-c0, 0, -s0]), vtx(m, [cx + ri * c1, y1, cz + ri * s1], [-c1, 0, -s1]), vtx(m, [cx + ri * c1, y0, cz + ri * s1], [-c1, 0, -s1]), vtx(m, [cx + ri * c0, y0, cz + ri * s0], [-c0, 0, -s0]));
        quad(m, vtx(m, [cx + ri * c0, y1, cz + ri * s0], [0, 1, 0]), vtx(m, [cx + r * c0, y1, cz + r * s0], [0, 1, 0]), vtx(m, [cx + r * c1, y1, cz + r * s1], [0, 1, 0]), vtx(m, [cx + ri * c1, y1, cz + ri * s1], [0, 1, 0]));
        quad(m, vtx(m, [cx + ri * c1, y0, cz + ri * s1], [0, -1, 0]), vtx(m, [cx + r * c1, y0, cz + r * s1], [0, -1, 0]), vtx(m, [cx + r * c0, y0, cz + r * s0], [0, -1, 0]), vtx(m, [cx + ri * c0, y0, cz + ri * s0], [0, -1, 0]));
      } else {
        tri(m, vtx(m, [cx, y1, cz], [0, 1, 0]), vtx(m, [cx + r * c1, y1, cz + r * s1], [0, 1, 0]), vtx(m, [cx + r * c0, y1, cz + r * s0], [0, 1, 0]));
        tri(m, vtx(m, [cx, y0, cz], [0, -1, 0]), vtx(m, [cx + r * c0, y0, cz + r * s0], [0, -1, 0]), vtx(m, [cx + r * c1, y0, cz + r * s1], [0, -1, 0]));
      }
    }
  }
  // box: centre, size [x,y,z], rotation about the vertical axis
  function box(m, [cx, cy, cz], [sx, sy, sz], rot = 0) {
    const cs = Math.cos(rot), sn = Math.sin(rot), R = (x, z) => [x * cs - z * sn, x * sn + z * cs];
    const F = [[[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]], [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
      [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]], [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
      [[0, 0, 1], [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]]], [[0, 0, -1], [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]]]];
    F.forEach(([n, vs]) => { const [nx, nz] = R(n[0], n[2]); const ids = vs.map(v => { const [x, z] = R(v[0] * sx / 2, v[2] * sz / 2); return vtx(m, [cx + x, cy + v[1] * sy / 2, cz + z], [nx, n[1], nz]); }); quad(m, ...ids); });
  }
  // flat shape on top of the body (white arrow pointing forward), given as a polygon in the x/z plane, extruded by h
  function prism(m, pts, y, h) {
    const top = pts.map(([x, z]) => vtx(m, [x, y + h, z], [0, 1, 0])); for (let k = 1; k < top.length - 1; k++) tri(m, top[0], top[k + 1], top[k]);
    pts.forEach(([x, z], k) => { const [x2, z2] = pts[(k + 1) % pts.length], nx = z2 - z, nz = -(x2 - x), l = Math.hypot(nx, nz) || 1; quad(m, vtx(m, [x, y, z], [nx / l, 0, nz / l]), vtx(m, [x2, y, z2], [nx / l, 0, nz / l]), vtx(m, [x2, y + h, z2], [nx / l, 0, nz / l]), vtx(m, [x, y + h, z], [nx / l, 0, nz / l])); });
  }
  // ---- the drone (span ≈ 0.6 m): the same look as the 2D icon ----
  const A = 0.2; // arm reach along x and z
  [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([fx, fz]) => {
    box('dark', [fx * A / 2, 0.012, fz * A / 2], [Math.hypot(A, A), 0.022, 0.026], Math.atan2(fz, fx));   // arm
    tube('dark', [fx * A, 0.03, fz * A], 0.022, 0, 0.04, 18);                                             // motor
    tube('white', [fx * A, 0.045, fz * A], 0.118, 0.096, 0.026);                                          // propeller guard ring
    tube('disc', [fx * A, 0.052, fz * A], 0.096, 0, 0.004);                                               // spinning propeller (translucent)
    tube('black', [fx * A, 0.056, fz * A], 0.012, 0, 0.012, 12);                                         // hub
  });
  box('red', [0, 0.02, 0], [0.24, 0.07, 0.13]);                       // body
  tube('red', [0.12, 0.02, 0], 0.065, 0, 0.07, 20); tube('red', [-0.12, 0.02, 0], 0.065, 0, 0.07, 20); // rounded nose / tail
  prism('white', [[0.15, 0], [0.07, 0.055], [0.07, 0.02], [-0.1, 0.02], [-0.1, -0.02], [0.07, -0.02], [0.07, -0.055]], 0.055, 0.006); // arrow → front
  tube('black', [0.2, 0.0, 0], 0.035, 0, 0.06, 18);                   // camera gimbal
  box('lens', [0.235, 0.0, 0], [0.012, 0.03, 0.03]);                  // lens
  tube('grey', [0, -0.025, 0.07], 0.012, 0, 0.04, 8); tube('grey', [0, -0.025, -0.07], 0.012, 0, 0.04, 8); // legs

  function build() {
    const names = Object.keys(G).filter(k => G[k].idx.length);
    const pos = [], nor = [], idx = [], prims = [];
    names.forEach(k => { const g = G[k], base = pos.length / 3, start = idx.length; pos.push(...g.pos); nor.push(...g.nor); g.idx.forEach(i => idx.push(base + i)); prims.push({ m: names.indexOf(k), start, count: idx.length - start }); });
    const P = new Float32Array(pos), N = new Float32Array(nor), I = new Uint16Array(idx);
    const buf = new Uint8Array(P.byteLength + N.byteLength + I.byteLength + 4);
    buf.set(new Uint8Array(P.buffer), 0); buf.set(new Uint8Array(N.buffer), P.byteLength); buf.set(new Uint8Array(I.buffer), P.byteLength + N.byteLength);
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    const mn = [0, 1, 2].map(k => Math.min(...pos.filter((_, i) => i % 3 === k))), mx = [0, 1, 2].map(k => Math.max(...pos.filter((_, i) => i % 3 === k)));
    const accessors = [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: mn, max: mx }, { bufferView: 1, componentType: 5126, count: nor.length / 3, type: 'VEC3' }];
    prims.forEach(p => accessors.push({ bufferView: 2, byteOffset: p.start * 2, componentType: 5123, count: p.count, type: 'SCALAR' }));
    const gltf = {
      asset: { version: '2.0', generator: 'Waypoint Studio' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: prims.map((p, k) => ({ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 + k, material: p.m })) }],
      materials: names.map(k => { const c = MATS[k]; return Object.assign({ pbrMetallicRoughness: { baseColorFactor: c, metallicFactor: 0.05, roughnessFactor: 0.5 }, emissiveFactor: c.slice(0, 3).map(v => v * 0.35), doubleSided: true }, c[3] < 1 ? { alphaMode: 'BLEND' } : {}); }),
      buffers: [{ byteLength: buf.length, uri: 'data:application/octet-stream;base64,' + btoa(bin) }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: P.byteLength, target: 34962 }, { buffer: 0, byteOffset: P.byteLength, byteLength: N.byteLength, target: 34962 }, { buffer: 0, byteOffset: P.byteLength + N.byteLength, byteLength: I.byteLength, target: 34963 }],
      accessors,
    };
    return 'data:model/gltf+json;base64,' + btoa(JSON.stringify(gltf));
  }
  let uri = null;
  const gltfUri = () => uri || (uri = build());

  // top view for the 2D map (points up = front; rotated by the heading on the map)
  // schematic top view (front = up): X-frame, 4 propeller rings, red body with a white arrow pointing forward
  const svg = (size = 44) => `<svg width="${size}" height="${size}" viewBox="-32 -32 64 64" xmlns="http://www.w3.org/2000/svg">
    <g stroke-linecap="round">
      <line x1="-15" y1="-15" x2="15" y2="15" stroke="#111" stroke-width="6"/><line x1="15" y1="-15" x2="-15" y2="15" stroke="#111" stroke-width="6"/>
      <line x1="-15" y1="-15" x2="15" y2="15" stroke="#4a4d52" stroke-width="3"/><line x1="15" y1="-15" x2="-15" y2="15" stroke="#4a4d52" stroke-width="3"/>
      <g fill="#ffffff" fill-opacity=".22" stroke-width="2.4">
        <circle cx="-15" cy="-15" r="10.5" stroke="#fff"/><circle cx="15" cy="-15" r="10.5" stroke="#fff"/>
        <circle cx="-15" cy="15" r="10.5" stroke="#9aa0a8"/><circle cx="15" cy="15" r="10.5" stroke="#9aa0a8"/>
      </g>
      <g fill="none" stroke="#111" stroke-width=".9" stroke-opacity=".7"><circle cx="-15" cy="-15" r="12"/><circle cx="15" cy="-15" r="12"/><circle cx="-15" cy="15" r="12"/><circle cx="15" cy="15" r="12"/></g>
      <g fill="#111"><circle cx="-15" cy="-15" r="2.6"/><circle cx="15" cy="-15" r="2.6"/><circle cx="-15" cy="15" r="2.6"/><circle cx="15" cy="15" r="2.6"/></g>
      <rect x="-7.5" y="-12" width="15" height="25" rx="6" fill="#e3262f" stroke="#fff" stroke-width="1.8"/>
      <path d="M0 -8.5 L5 -1.5 L1.8 -1.5 L1.8 6 L-1.8 6 L-1.8 -1.5 L-5 -1.5 Z" fill="#fff"/>
      <circle cx="0" cy="-15.5" r="3.4" fill="#111" stroke="#fff" stroke-width="1.2"/>
    </g></svg>`;
  return { gltfUri, svg };
})();
