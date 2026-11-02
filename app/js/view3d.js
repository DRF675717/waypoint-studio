// 3D route view (Litchi-style): CesiumJS + Google Photorealistic 3D Tiles (Map Tiles API), fallback to Esri imagery.
// Shows the whole flight path in 3D, waypoint stems, POIs, camera direction, and plays the flight (overview / chase / FPV camera).
const View3D = (() => {
  const { S } = Core;
  let viewer = null, root = null, tileset = null, src = '', H0 = 0, hNote = '', useTerr = false, GR = new Map();
  let curtainOn = Core.store.get('ws.curtain3d', false) === true;
  let routeEnts = [], drone = null, frustum = null, dynFrame = null, groundRel = () => 0, frameMode = Core.store.get('ws.frame3dOn', true) === false ? 'off' : 'sel', tl = null, t = 0, playing = false, last = 0, mode = 'orbit', redrawT = null, isOpen = false;
  const $ = s => root.querySelector(s);
  const fmtT = s => { s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  function loadCesium() {
    if (window.Cesium) return Promise.resolve();
    window.CESIUM_BASE_URL = 'vendor/cesium/';
    return new Promise((res, rej) => {
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/cesium/Widgets/widgets.css'; document.head.appendChild(css);
      const s = document.createElement('script'); s.src = 'vendor/cesium/Cesium.js'; s.onload = res; s.onerror = () => rej(new Error('Не удалось загрузить CesiumJS')); document.head.appendChild(s);
    });
  }

  // ---- free terrain: AWS/Mapzen Terrarium elevation tiles (no key) ----
  const TT = new Map();
  function terrTile(z, x, y) {
    const k = z + '/' + x + '/' + y;
    if (!TT.has(k)) TT.set(k, fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${k}.png`).then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(b => createImageBitmap(b)).then(bm => { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bm, 0, 0); return g.getImageData(0, 0, 256, 256).data; })
      .catch(() => null));
    return TT.get(k);
  }
  function merc(lat, lng, z) { const n = 2 ** z, r = lat * Math.PI / 180; return { x: (lng + 180) / 360 * n, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n }; }
  const pix = (d, px, py) => { if (!d) return 0; const i = (Math.min(255, Math.max(0, py)) * 256 + Math.min(255, Math.max(0, px))) * 4; return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768; };
  async function terrH(lat, lng, z = 14) { const m = merc(lat, lng, z), tx = Math.floor(m.x), ty = Math.floor(m.y); const d = await terrTile(z, tx, ty); return pix(d, Math.floor((m.x - tx) * 256), Math.floor((m.y - ty) * 256)); }
  function terrainProvider(C) {
    const ts = new C.GeographicTilingScheme(), N = 33;
    return new C.CustomHeightmapTerrainProvider({ width: N, height: N, tilingScheme: ts, credit: 'Terrain: Mapzen/AWS Terrarium',
      callback: async (x, y, level) => {
        const r = ts.tileXYToRectangle(x, y, level), z = Math.min(14, Math.max(1, level + 1));
        const W = C.Math.toDegrees(r.west), E = C.Math.toDegrees(r.east), No = C.Math.toDegrees(r.north), So = C.Math.toDegrees(r.south);
        const pts = [], need = new Map();
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          const lat = Math.max(-85, Math.min(85, No - (No - So) * j / (N - 1))), lng = W + (E - W) * i / (N - 1);
          const m = merc(lat, lng, z), tx = Math.floor(m.x) % (2 ** z), ty = Math.min(2 ** z - 1, Math.floor(m.y));
          const k = tx + '/' + ty; if (!need.has(k)) need.set(k, terrTile(z, tx, ty));
          pts.push([k, Math.floor((m.x - Math.floor(m.x)) * 256), Math.floor((m.y - Math.floor(m.y)) * 256)]);
        }
        const tiles = {}; await Promise.all([...need].map(async ([k, p]) => { tiles[k] = await p; }));
        const out = new Float32Array(N * N);
        pts.forEach((q, n) => { out[n] = Math.max(-500, pix(tiles[q[0]], q[1], q[2])); });
        return out;
      } });
  }

  function buildDOM() {
    root = document.createElement('div'); root.id = 'v3d';
    root.innerHTML = `<div id="v3dMap"></div>
      <div class="v3bar top">
        <b>3D</b><i class="hlp" data-tip="Объёмный вид маршрута над рельефом.
• Левая кнопка мыши — вращать, колесо — приблизить
• Shift (или Ctrl) + перетаскивание, кнопки ▲ ▼ ⊤ — наклон вида
• Клик по точке — выбрать (параметры справа)
• Правый клик — то же меню, что на карте: добавить точку/POI/взлёт, переместить, высота, камера, удалить
• Жёлтая пирамида — кадр камеры: что попадёт в снимок с этой высоты и наклона
• ▶ внизу — проиграть полёт; «Сзади» и «Камера дрона» — вид во время полёта">?</i><span id="v3src" class="v3src"></span>
        <div class="v3grp"><button data-m="orbit" class="on" title="Свободный обзор">Обзор</button><button data-m="chase" title="Камера летит за дроном по маршруту и смотрит вдоль линии полёта">Сзади</button><button data-m="fpv" title="Вид из камеры дрона">Камера дрона</button></div>
        <button class="v3b" id="v3frame" title="Рамка кадра камеры: что попадёт в снимок — у выбранной точки, а во время полёта — у дрона">▣ Кадр</button>
        <div class="v3grp" style="margin-left:0" title="Наклон вида (также: Shift или Ctrl + перетаскивание, колёсико мыши с нажатой средней кнопкой)"><button id="v3up" style="color:#fff" title="Смотреть более сверху">▲</button><button id="v3dn" style="color:#fff" title="Смотреть более сбоку">▼</button><button id="v3top" style="color:#fff" title="Вид строго сверху">⊤</button></div>
        <button class="v3b" id="v3cur" title="Шторка: полупрозрачная стена от земли до линии полёта — помогает видеть высоту над землёй">▥ Шторка</button>
        <button class="v3b" id="v3bld" title="Здания OpenStreetMap в 3D (объёмы домов; высота из карты или оценка по этажам)">🏢 Здания</button>
        <button class="v3b" id="v3pipBtn" title="Окно «Вид камеры»: что увидит камера дрона в выбранной точке или во время полёта">📷 Камера</button>
        <button class="v3b" id="v3fit" title="Показать и отцентровать весь маршрут, не меняя направления и наклона вида"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="vertical-align:-3px"><path d="M4 15 L6 5 L14 4 L16 13 Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="4" cy="15" r="2.2" fill="#22c7ff"/><circle cx="6" cy="5" r="2.2" fill="#22c7ff"/><circle cx="14" cy="4" r="2.2" fill="#22c7ff"/><circle cx="16" cy="13" r="2.2" fill="#22c7ff"/></svg> Весь маршрут</button>
        <button class="v3b" id="v3full" title="Во весь экран: только 3D и управление полётом (Esc — выйти)">⛶</button>
        <button class="v3b b2d" id="v3close" title="Вернуться к 2D-карте (Esc)">2D</button>
      </div>
      <div class="v3bar bottom">
        <button class="v3b" id="v3play">▶</button>
        <input type="range" id="v3slider" min="0" max="1000" value="0">
        <select id="v3speed"><option value="1">1×</option><option value="3">3×</option><option value="5" selected>5×</option><option value="20">20×</option><option value="60">60×</option></select>
        <span id="v3osd" class="v3osd"></span>
      </div>
      <div id="v3hint" class="v3hint">Левая кнопка — вращать · <b>Shift + перетаскивание</b> или ▲▼ — наклон · колесо — масштаб · <b>правый клик</b> — меню (добавить / переместить / удалить точку) · клик по точке — выбрать</div>
      <div id="v3bub" class="v3bub" hidden></div>
      <div id="v3pip" class="v3pip" hidden><div class="piphead" title="Перетащите окно за заголовок · двойной клик — вернуть на место"><b>📷 Вид камеры</b><span id="pipWhat"></span><button id="pipBig" title="Смотреть во весь экран (режим «Камера дрона»)">⤢</button><button id="pipX" title="Скрыть окно (вернуть — кнопка 📷 вверху)">✕</button></div>
        <div id="pipMap"></div><div class="pipgrid"></div><div class="pipcross"></div><div class="piphud" id="pipHud"></div><div class="pipwait" id="pipWait" hidden>загрузка снимков…</div></div>
      <div id="v3load" class="v3load">Загрузка 3D…</div>`;
    document.getElementById('mapWrap').appendChild(root);
    root.querySelector('.v3grp').onclick = e => { const b = e.target.closest('[data-m]'); if (!b) return; setMode(b.dataset.m); };
    $('#v3full').onclick = () => window.WSFull && WSFull.toggle();
    $('#v3fit').onclick = () => { if (mode !== 'orbit') setMode('orbit'); fit(true); };
    $('#v3up').onclick = () => tiltBy(-15); $('#v3dn').onclick = () => tiltBy(15); $('#v3top').onclick = () => tiltBy(0, -89.5);
    $('#v3close').onclick = close;
    $('#v3pipBtn').onclick = () => { pipOn = !pipOn; Core.store.set('ws.pip3d', pipOn); pipUpdate(true); };
    $('#pipX').onclick = () => { pipOn = false; Core.store.set('ws.pip3d', false); pipUpdate(true); };
    $('#pipBig').onclick = () => setMode('fpv');
    const cb0 = $('#v3cur'); cb0.classList.toggle('on', curtainOn); cb0.onclick = () => { curtainOn = !curtainOn; Core.store.set('ws.curtain3d', curtainOn); cb0.classList.toggle('on', curtainOn); draw(false).then(showDrone); };
    const bb = $('#v3bld'); bb.classList.toggle('on', bldOn);
    bb.onclick = () => { bldOn = !bldOn; Core.store.set('ws.bld3d', bldOn); bb.classList.toggle('on', bldOn); if (!bldOn) bldData = []; else bldKey = ''; draw(false); toast(bldOn ? 'Здания OpenStreetMap показаны (там, где нет фотореалистичного 3D Google)' : 'Здания скрыты', '', 4000); };
    (() => { // drag the camera window by its title bar
      const box = $('#v3pip'), head = box.querySelector('.piphead'); let d = null;
      const apply = p => { if (!p) return; const r = root.getBoundingClientRect(), w = box.offsetWidth || 300, h = box.offsetHeight || 260;
        box.style.left = Math.max(4, Math.min(r.width - w - 4, p.x)) + 'px'; box.style.top = Math.max(44, Math.min(r.height - h - 4, p.y)) + 'px'; box.style.right = 'auto'; box.style.bottom = 'auto'; };
      head.style.cursor = 'move';
      head.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; const b = box.getBoundingClientRect(), r = root.getBoundingClientRect(); d = { dx: e.clientX - b.left, dy: e.clientY - b.top, r }; head.setPointerCapture(e.pointerId); });
      head.addEventListener('pointermove', e => { if (!d) return; apply({ x: e.clientX - d.r.left - d.dx, y: e.clientY - d.r.top - d.dy }); });
      head.addEventListener('pointerup', () => { if (!d) return; d = null; Core.store.set('ws.pipPos', { x: parseFloat(box.style.left), y: parseFloat(box.style.top) }); });
      head.addEventListener('dblclick', () => { Core.store.set('ws.pipPos', null); box.style.left = box.style.top = ''; box.style.right = ''; box.style.bottom = ''; });
      const saved = Core.store.get('ws.pipPos', null); if (saved) setTimeout(() => apply(saved), 0);
    })();
    const fb = $('#v3frame'); fb.classList.toggle('on', frameMode !== 'off');
    fb.onclick = () => { frameMode = frameMode === 'off' ? 'sel' : 'off'; Core.store.set('ws.frame3dOn', frameMode !== 'off'); fb.classList.toggle('on', frameMode !== 'off'); draw(false).then(showDrone); };
    if ($('#v3ge')) $('#v3ge').onclick = async () => { try { await IO.exportAs('kml'); toast('KML сохранён. В Google Earth: «Проекты → Открыть → Импортировать KML-файл» (или откройте файл в Google Earth Pro)', 'ok', 9000); window.open('https://earth.google.com/web/', '_blank'); } catch (e) { toast(e.message, 'err'); } };
    $('#v3play').onclick = () => playing ? pause() : play();
    $('#v3speed').onchange = e => { const m = document.getElementById('simSpeed'); if (m) m.value = e.target.value; };
    $('#v3slider').oninput = e => { if (!tl) return; t = tl.T * e.target.value / 1000; showDrone(); };
  }

  async function initViewer() {
    await loadCesium();
    const C = Cesium;
    C.Ion.defaultAccessToken = undefined;
    viewer = new C.Viewer('v3dMap', {
      baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
      animation: false, timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false, scene3DOnly: true,
      terrainProvider: new C.EllipsoidTerrainProvider(), requestRenderMode: false,
      // sharp picture on Retina screens (render at the real pixel density) + smooth, anti-aliased lines
      useBrowserRecommendedResolution: false, msaaSamples: 4,
    });
    try { viewer.scene.postProcessStages.fxaa.enabled = true; } catch (e) { /* older Cesium */ }
    viewer.scene.globe.baseColor = C.Color.fromCssColorString('#1b2733');
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
    const key = Maps.key(), ion = (Core.store.get('ws.ionkey', '') || '').trim();
    src = '';
    // Cesium ion (user's own free token): Google Photorealistic 3D Tiles streamed through Cesium's licence — the same
    // picture as Litchi / Google Earth. If that is refused, ion's Bing aerial imagery + Cesium World Terrain.
    if (ion) {
      C.Ion.defaultAccessToken = ion;
      try {
        tileset = await C.createGooglePhotorealistic3DTileset(undefined, { showCreditsOnScreen: true, maximumScreenSpaceError: 8 });
        viewer.scene.primitives.add(tileset); viewer.scene.globe.show = false;
        src = 'Google Photorealistic 3D (через Cesium ion)'; Core.store.set('ws.ionStatus', 'ok:google');
      } catch (e) {
        console.warn('ion google 3D', e);
        try {
          viewer.imageryLayers.addImageryProvider(await C.IonImageryProvider.fromAssetId(2));
          viewer.terrainProvider = await C.createWorldTerrainAsync();
          viewer.scene.globe.depthTestAgainstTerrain = true; viewer.scene.globe.maximumScreenSpaceError = 1.5; useTerr = true;
          src = 'Cesium ion: снимки Bing + рельеф Cesium World Terrain (3D-модель Google недоступна: ' + (e.message || e) + ')'; Core.store.set('ws.ionStatus', 'ok:bing');
        } catch (e2) { console.warn('ion imagery', e2); Core.store.set('ws.ionStatus', 'err:' + (e2.message || e2)); hNote = 'ключ Cesium ion не принят'; }
      }
    }
    if (key && !src) {
      try {
        tileset = await C.Cesium3DTileset.fromUrl(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(key)}`, { showCreditsOnScreen: true, maximumScreenSpaceError: 8 });
        viewer.scene.primitives.add(tileset);
        viewer.scene.globe.show = false;
        src = 'Google Photorealistic 3D';
      } catch (e) { console.warn('Google 3D tiles', e); src = ''; hNote = 'фотореалистичные 3D‑тайлы Google недоступны для этого ключа (Google Maps Platform не выдаёт их аккаунтам из Вьетнама) — показаны здания OpenStreetMap'; }
    }
    if (!src) {
      viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({ url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maximumLevel: 18, credit: 'Imagery © Esri, Maxar' }));
      viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({ url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', maximumLevel: 19 }));
      viewer.terrainProvider = terrainProvider(C);
      viewer.scene.globe.depthTestAgainstTerrain = true;
      viewer.scene.globe.maximumScreenSpaceError = 1.5;
      useTerr = true;
      src = 'Спутник Esri + 3D-рельеф' + (hNote ? ' · ' + hNote : '');
    }
    try { initPip(C); } catch (e) { console.warn('pip', e); pipV = null; }
    // interactions: left click = select (or drop a point being moved), right click = context menu, mouse move = live move preview
    const h = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
    const info = pos => {
      const p = viewer.scene.pick(pos), id = p && p.id;
      const g = groundAt(pos);
      const r = viewer.scene.canvas.getBoundingClientRect();
      return { lat: g && g.lat, lng: g && g.lng, wp: id && id.wsWp, poi: id && id.wsPoi, home: id && id.wsHome, clientX: r.left + pos.x, clientY: r.top + pos.y };
    };
    h.setInputAction(ev => Core.emit('click3d', info(ev.position)), C.ScreenSpaceEventType.LEFT_CLICK);
    h.setInputAction(ev => Core.emit('ctx3d', info(ev.position)), C.ScreenSpaceEventType.RIGHT_CLICK);
    h.setInputAction(ev => { if (!moveHook) return; const g = groundAt(ev.endPosition); if (g) moveHook(g); }, C.ScreenSpaceEventType.MOUSE_MOVE);
    viewer.scene.preRender.addEventListener(tick);
    viewer.scene.preRender.addEventListener(guardCamera);
    viewer.scene.postRender.addEventListener(retireTick);
    viewer.scene.postRender.addEventListener(placeBubble);
    // tilt also with Shift/Ctrl + left drag (Mac trackpads have no middle button)
    const ssc = viewer.scene.screenSpaceCameraController, ET = C.CameraEventType, KM = C.KeyboardEventModifier;
    ssc.tiltEventTypes = [ET.MIDDLE_DRAG, ET.PINCH, { eventType: ET.LEFT_DRAG, modifier: KM.CTRL }, { eventType: ET.LEFT_DRAG, modifier: KM.SHIFT }, { eventType: ET.RIGHT_DRAG, modifier: KM.CTRL }];
    ssc.minimumZoomDistance = 15;
  }

  // The free view must never end up lying on the ground looking at the horizon: from there Cesium cannot tilt back up
  // (the pivot point is lost). Keep the camera ≥ 25 m above the surface and looking ≥ 4° down.
  const MIN_PITCH = -4 * Math.PI / 180, MIN_AGL = 25;
  function guardCamera() {
    if (!viewer || !isOpen || mode !== 'orbit' || moveHook) return;
    const C = Cesium, cam = viewer.camera, cg = cam.positionCartographic;
    let gh = 0; if (useTerr) { const h = viewer.scene.globe.getHeight(cg); if (h !== undefined && isFinite(h)) gh = h; } else gh = H0;
    const lowH = cg.height < gh + MIN_AGL, flat = cam.pitch > MIN_PITCH;
    if (!lowH && !flat) return;
    const dest = lowH ? C.Cartesian3.fromRadians(cg.longitude, cg.latitude, gh + MIN_AGL) : cam.positionWC.clone();
    cam.setView({ destination: dest, orientation: { heading: cam.heading, pitch: Math.min(cam.pitch, MIN_PITCH), roll: 0 } });
  }
  // tilt buttons: rotate the view around the point in the centre of the screen
  function centerPivot() {
    const C = Cesium, sc = viewer.scene, cv = sc.canvas;
    const pos = new C.Cartesian2(cv.clientWidth / 2, cv.clientHeight / 2);
    let p = null; const ray = viewer.camera.getPickRay(pos);
    if (ray) p = useTerr ? sc.globe.pick(ray, sc) : sc.camera.pickEllipsoid(pos);
    if (!p) { // looking above the horizon: pivot on the route
      const W = S.m.waypoints; if (W.length) { const c = W.reduce((a, w) => ({ lat: a.lat + w.lat / W.length, lng: a.lng + w.lng / W.length }), { lat: 0, lng: 0 }); p = C.Cartesian3.fromDegrees(c.lng, c.lat, H0); }
    }
    return p;
  }
  function tiltBy(deg, abs) {
    if (!viewer) return; if (mode !== 'orbit') setMode('orbit');
    const C = Cesium, cam = viewer.camera, p = centerPivot(); if (!p) return;
    const range = Math.max(80, C.Cartesian3.distance(cam.positionWC, p));
    let pitch = abs != null ? abs : cam.pitch * 180 / Math.PI + deg;
    pitch = Math.max(-89.5, Math.min(-5, pitch));
    cam.lookAt(p, new C.HeadingPitchRange(cam.heading, C.Math.toRadians(pitch), range));
    cam.lookAtTransform(C.Matrix4.IDENTITY);
  }

  // screen position -> {lat,lng} on terrain / 3D tiles / ellipsoid
  function groundAt(pos) {
    const C = Cesium, sc = viewer.scene;
    let cart = null;
    if (useTerr) { const ray = viewer.camera.getPickRay(pos); if (ray) cart = sc.globe.pick(ray, sc); }
    else if (sc.pickPositionSupported) { try { cart = sc.pickPosition(pos); } catch (e) {} }
    if (!cart) cart = viewer.camera.pickEllipsoid(pos);
    if (!cart) return null;
    const c = C.Cartographic.fromCartesian(cart);
    return { lat: C.Math.toDegrees(c.latitude), lng: C.Math.toDegrees(c.longitude) };
  }
  // live "move with mouse": a ghost marker + stem follows the cursor until the user clicks
  let moveHook = null, ghost = null;
  function startMove(rel, onMove) {
    const C = Cesium;
    if (!ghost) ghost = {
      pt: viewer.entities.add({ position: C.Cartesian3.ZERO, point: { pixelSize: 18, color: C.Color.fromCssColorString('#ffe14d').withAlpha(.9), outlineColor: C.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY }, label: { text: 'кликните, чтобы поставить · Esc — отмена', font: '600 12px -apple-system, sans-serif', fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -22), disableDepthTestDistance: Number.POSITIVE_INFINITY } }),
      stem: viewer.entities.add({ polyline: { positions: [C.Cartesian3.ZERO, C.Cartesian3.UNIT_X], width: 2, material: C.Color.fromCssColorString('#ffe14d') } }),
    };
    ghost.pt.show = ghost.stem.show = false;
    viewer.scene.canvas.style.cursor = 'crosshair';
    moveHook = g => {
      terrRel(g).then(gRel => {
        if (!moveHook) return;
        const top = C.Cartesian3.fromDegrees(g.lng, g.lat, H0 + (rel == null ? gRel + 2 : rel));
        ghost.pt.position = top; ghost.stem.polyline.positions = [C.Cartesian3.fromDegrees(g.lng, g.lat, H0 + gRel), top];
        ghost.pt.show = ghost.stem.show = true;
      });
      onMove && onMove(g);
    };
  }
  function stopMove() { moveHook = null; if (ghost) ghost.pt.show = ghost.stem.show = false; if (viewer) viewer.scene.canvas.style.cursor = ''; }
  async function terrRel(p) { if (useTerr) return (await terrH(p.lat, p.lng)) - H0; const gh = Core.groundAt(Core.homePt()), g = Core.groundAt(p); return gh !== undefined && g !== undefined ? g - gh : 0; }

  // ground height (ellipsoidal) at the take-off point, measured on the 3D mesh so the path sits correctly on Google 3D tiles
  async function groundHeight() {
    const C = Cesium, hp = Core.homePt();
    if (!hp) return 0;
    if (useTerr) return await terrH(hp.lat, hp.lng);
    if (tileset) {
      try {
        const [c] = await viewer.scene.sampleHeightMostDetailed([C.Cartographic.fromDegrees(hp.lng, hp.lat)]);
        if (c && isFinite(c.height)) return c.height;
      } catch (e) { console.warn('sampleHeight', e); }
      // fallback: DEM height above sea level (geoid offset ignored)
      await Core.Elev.ensure([hp]).catch(() => {});
      const g = Core.groundAt(hp); hNote = 'высота земли взята из DEM';
      return g || 0;
    }
    return 0;
  }

  // Entities are rebuilt into a fresh list and swapped in one synchronous step (no flicker:
  // the old route stays on screen while terrain heights are fetched asynchronously).
  let pending = null, gen = 0;
  const add = e => { const x = viewer.entities.add(e); pending.push(x); return x; };

  async function draw(fitAfter) {
    if (!viewer) return;
    const my = ++gen;
    const C = Cesium;
    let W = S.m.waypoints;
    // ---- async part: nothing on screen changes here ----
    {
      await Core.Elev.ensure(W.concat(S.m.pois, Core.homePt() ? [Core.homePt()] : [])).catch(() => {});
      const h0 = await groundHeight();
      const geo0 = Core.pathGeometry();
      const GR2 = new Map(GR);
      if (useTerr) await Promise.all(geo0.concat(S.m.waypoints, S.m.pois, S.m.home ? [S.m.home] : []).map(async p => { const k = p.lat.toFixed(6) + ',' + p.lng.toFixed(6); if (!GR2.has(k)) GR2.set(k, await terrH(p.lat, p.lng)); }));
      // Vietnam no-fly / restricted zones around the route (when the zones layer is switched on)
      let zp = [];
      if (typeof Zones !== 'undefined' && Zones.on && Zones.available) {
        const P = geo0.concat(S.m.home ? [S.m.home] : []);
        if (P.length) { const pad = 0.012; try { zp = await Zones.around({ w: Math.min(...P.map(p => p.lng)) - pad, e: Math.max(...P.map(p => p.lng)) + pad, s: Math.min(...P.map(p => p.lat)) - pad, n: Math.max(...P.map(p => p.lat)) + pad }); } catch (e) { zp = []; } }
      }
      if (my !== gen) return; // a newer redraw superseded this one
      // OpenStreetMap buildings (when photorealistic Google tiles are not available)
      // loaded in the background (Overpass can be slow): the scene is redrawn when they arrive
      if (!tileset && bldOn && window.WS_DESKTOP) requestBuildings(geo0.concat(S.m.home ? [S.m.home] : []));
      if (my !== gen) return;
      H0 = h0; GR = GR2.size > 20000 ? new Map() : GR2; zonePolys = zp; if (!bldOn) bldData = [];
    }
    // ---- sync part: build the new scene, then remove the old one ----
    W = S.m.waypoints;
    const old = routeEnts; pending = [];
    try { buildScene(C, W); } finally { routeEnts = pending; pending = null; retireLater(old); }
    try { pipBuild(C, W); } catch (e) { console.warn('pip build', e); }
    tl = buildTimeline();
    $('#v3src').textContent = ''; root.querySelector('.v3bar.top b').title = src + (bldMsg ? ' · ' + bldMsg : '');
    if (fitAfter) fit();
    showDrone(); pipUpdate(true);
  }
  // Cesium builds polyline/wall/polygon geometry in web workers, so freshly added entities appear a few frames later.
  // Keep the previous route on screen until the new geometry is ready, then remove it — the route never blinks.
  let retiring = [], retireSince = 0;
  function retireLater(old) {
    retiring = retiring.concat(old); retireSince = performance.now();
  }
  function retireTick() {
    if (!retiring.length) return;
    const ready = viewer.dataSourceDisplay.ready !== false;
    if (ready || performance.now() - retireSince > 4000) { retiring.forEach(e => viewer.entities.remove(e)); retiring = []; }
  }
  let zonePolys = [];
  // ---- OpenStreetMap buildings, extruded over the terrain ----
  let bldOn = Core.store.get('ws.bld3d', true) !== false, bldData = [], bldKey = '', bldMsg = '';
  let bldBusy = null;
  function requestBuildings(P) {
    if (bldBusy) return;
    bldBusy = loadBuildings(P).then(b => { const changed = b !== bldData; bldData = bldOn ? b : []; bldBusy = null; if (changed && isOpen && bldOn) draw(false); })
      .catch(() => { bldBusy = null; bldMsg = 'здания OSM не загрузились'; });
  }
  async function loadBuildings(P) {
    if (!P.length) return [];
    const pad = 0.003; let s = Math.min(...P.map(p => p.lat)) - pad, n = Math.max(...P.map(p => p.lat)) + pad, w = Math.min(...P.map(p => p.lng)) - pad, e = Math.max(...P.map(p => p.lng)) + pad;
    const MAX = 0.0011; if ((n - s) * (e - w) > MAX) { const cl = (s + n) / 2, cg = (w + e) / 2, k = Math.sqrt(MAX / ((n - s) * (e - w))); s = cl - (cl - s) * k; n = cl + (n - cl) * k; w = cg - (cg - w) * k; e = cg + (e - cg) * k; }
    const r3 = v => Math.round(v * 500) / 500; s = r3(s - 0.001); w = r3(w - 0.001); n = r3(n + 0.001); e = r3(e + 0.001); // snap → reuse the disk cache
    const key = [s, w, n, e].join(','); if (key === bldKey) return bldData;
    const r = await fetch(`/cb/osm?s=${s}&w=${w}&n=${n}&e=${e}`); const j = await r.json();
    if (!j.ok) { bldMsg = 'здания OSM не загрузились'; return []; }
    bldKey = key; bldMsg = `здания OpenStreetMap: ${j.n}`; return j.b;
  }
  function addBuildings(C, addFn) {
    const col = C.Color.fromCssColorString('#d9d4c7'), colEst = C.Color.fromCssColorString('#c9c3b4');
    bldData.forEach(b => addFn({ polygon: { hierarchy: new C.PolygonHierarchy(b.p.map(([lat, lng]) => C.Cartesian3.fromDegrees(lng, lat))), height: b.min || 0, extrudedHeight: b.h,
      heightReference: C.HeightReference.RELATIVE_TO_GROUND, extrudedHeightReference: C.HeightReference.RELATIVE_TO_GROUND, material: (b.est ? colEst : col).withAlpha(0.93), shadows: C.ShadowMode.DISABLED } }));
  }
  function buildScene(C, W) {
    addBuildings(C, add);
    // zones lie on the ground (draped over the terrain), translucent, with an outline
    zonePolys.forEach(z => {
      const col = C.Color.fromCssColorString(z.color), P = r => r.map(([lat, lng]) => C.Cartesian3.fromDegrees(lng, lat));
      z.rings.forEach(r => { if (r.length >= 3) add({ polygon: { hierarchy: new C.PolygonHierarchy(P(r)), material: col.withAlpha(z.layer === 1 ? 0.33 : 0.25), classificationType: C.ClassificationType.BOTH } }); });
      (z.lines || []).forEach(l => { if (l.length >= 2) add({ polyline: { positions: P(l), width: 1, material: col, clampToGround: true } }); });
    });
    if (!W.length) setOSD('Маршрут пуст: правый клик по земле → «Точка маршрута здесь»');
    const P = (lat, lng, rel) => C.Cartesian3.fromDegrees(lng, lat, H0 + rel);
    // the real flight from a log (white line at the logged height above take-off)
    if (typeof FlightLog !== 'undefined' && FlightLog.track && FlightLog.track.hasH) { const tp = FlightLog.track.pts.filter((q, k, a) => k % Math.max(1, Math.ceil(a.length / 3000)) === 0 && q.h != null);
      if (tp.length > 1) add({ polyline: { positions: tp.map(q => P(q.lat, q.lng, q.h)), width: 1.5, material: C.Color.WHITE.withAlpha(0.95), depthFailMaterial: C.Color.WHITE.withAlpha(0.3), arcType: C.ArcType.NONE } }); }
    const geo = Core.pathGeometry();
    const pos = geo.map(p => P(p.lat, p.lng, p.alt));
    const groundOf = groundRel = w => { // ground height under a point relative to take-off (for stems & curtain)
      if (useTerr) { const g = GR.get(w.lat.toFixed(6) + ',' + w.lng.toFixed(6)); return g !== undefined ? g - H0 : 0; }
      const gh = Core.groundAt(Core.homePt()), g = Core.groundAt(w);
      return gh !== undefined && g !== undefined ? g - gh : 0;
    };
    // curtain (wall) from ground to path — makes the 3D shape readable, like Litchi
    if (geo.length > 1) {
      if (curtainOn) add({ wall: { positions: pos, minimumHeights: geo.map(p => H0 + groundOf(p)), maximumHeights: geo.map(p => H0 + p.alt), material: C.Color.fromCssColorString('#00c2ff').withAlpha(0.13), outline: false } });
      add({ polyline: { positions: pos, width: 1.6, material: C.Color.fromCssColorString('#ffe100'), depthFailMaterial: C.Color.fromCssColorString('#ffe100').withAlpha(0.35), arcType: C.ArcType.NONE } }); // thin solid yellow line, like Litchi
    }
    const home = Core.homePt();
    if (S.m.home) {
      const he = add({ position: P(home.lat, home.lng, 0.5), billboard: { image: homeImage(), width: 26, height: 26, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      he.wsHome = true;
      if (W.length) add({ polyline: { positions: [P(home.lat, home.lng, 0.5), P(W[0].lat, W[0].lng, Core.wpRel(W[0]))], width: 1, material: new C.PolylineDashMaterialProperty({ color: C.Color.fromCssColorString('#3ccf7a'), dashLength: 10 }) } });
    }
    W.forEach((w, i) => {
      const rel = Core.wpRel(w), g = groundOf(w), top = P(w.lat, w.lng, rel);
      const sel = S.sel.has(w.id);
      add({ polyline: { positions: [P(w.lat, w.lng, g), top], width: 0.8, material: C.Color.WHITE.withAlpha(0.8), depthFailMaterial: C.Color.WHITE.withAlpha(0.25) } });
      // Litchi-style pin: violet teardrop with the point number (selected — yellow), its tip at the waypoint;
      // the height is a small tag next to the pin head
      const e = add({ position: top,
        billboard: { image: pinImage(String(i + 1), sel ? 'sel' : i === 0 ? 'first' : 'wp'), width: 30, height: 40, verticalOrigin: C.VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new C.NearFarScalar(300, 1, 8000, 0.7) },
        label: { show: W.length <= 150 || sel || i % 5 === 0 || i === W.length - 1, text: `${Math.round(w.alt)} м`, font: '600 11px -apple-system, Helvetica, sans-serif', fillColor: C.Color.WHITE, showBackground: true, backgroundColor: C.Color.fromCssColorString('#0b1117').withAlpha(0.72), backgroundPadding: new C.Cartesian2(5, 3),
          horizontalOrigin: C.HorizontalOrigin.LEFT, verticalOrigin: C.VerticalOrigin.CENTER, pixelOffset: new C.Cartesian2(14, -28), disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new C.NearFarScalar(300, 1, 8000, 0.7), translucencyByDistance: new C.NearFarScalar(3000, 1, 9000, 0) } });
      e.wsWp = w.id;
      // camera direction + 3D image frame (what gets into the shot)
      const hd = Core.effHeading(i), gb = Core.effGimbal(i) ?? w.gimbal;
      if (hd != null) {
        const showF = frameMode === 'all' || (frameMode === 'sel' && (sel || (!S.sel.size && i === 0)));
        if (showF) addFrame(C, w, rel, g, hd, gb, sel || frameMode === 'sel');
        else {
          const len = 18, pitch = gb * Math.PI / 180, d = Geo.dest(w, hd, len * Math.cos(pitch));
          add({ polyline: { positions: [top, P(d.lat, d.lng, rel + len * Math.sin(pitch))], width: 1.5, material: new C.PolylineArrowMaterialProperty(C.Color.WHITE) } });
        }
      }
    });
    S.m.pois.forEach(p => {
      const rel = groundOf(p) + (p.alt || 0);
      const pe = add({ position: P(p.lat, p.lng, rel), billboard: { image: poiImage(S.selPoi === p.id), width: 14, height: 14, disableDepthTestDistance: Number.POSITIVE_INFINITY, scale: new C.CallbackProperty(() => lookId === p.id && Math.floor(performance.now() / 350) % 2 ? 1.6 : 1, false), color: new C.CallbackProperty(() => lookId === p.id && Math.floor(performance.now() / 350) % 2 ? C.Color.fromCssColorString('#fff3a0') : C.Color.WHITE, false) },
        label: { text: `${p.name || 'POI'} · ${Math.round((p.alt || 0) * 10) / 10} м`, font: '600 11px -apple-system, Helvetica, sans-serif', fillColor: C.Color.WHITE, showBackground: true, backgroundColor: C.Color.fromCssColorString('#7a3300').withAlpha(0.8), backgroundPadding: new C.Cartesian2(5, 3), horizontalOrigin: C.HorizontalOrigin.CENTER, verticalOrigin: C.VerticalOrigin.BOTTOM, pixelOffset: new C.Cartesian2(0, -11), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      pe.wsPoi = p.id;
    });
    if (!drone) {
      drone = viewer.entities.add({ position: pos[0] || C.Cartesian3.ZERO, show: false,
        model: { uri: DroneModel.gltfUri(), minimumPixelSize: 84, maximumScale: 20000, scale: 1 },
        // live flight data in a speech bubble attached to the drone: black text on a translucent white bubble (readable over the yellow frame)
        label: { text: '', font: '600 12.5px -apple-system, Helvetica, sans-serif', fillColor: C.Color.BLACK, style: C.LabelStyle.FILL, showBackground: true, backgroundColor: C.Color.WHITE.withAlpha(0.86), backgroundPadding: new C.Cartesian2(9, 6),
          horizontalOrigin: C.HorizontalOrigin.CENTER, verticalOrigin: C.VerticalOrigin.BOTTOM, pixelOffset: new C.Cartesian2(0, -44), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      droneTip = viewer.entities.add({ position: pos[0] || C.Cartesian3.ZERO, show: false,
        billboard: { image: TIP_SVG, width: 18, height: 12, verticalOrigin: C.VerticalOrigin.BOTTOM, pixelOffset: new C.Cartesian2(0, -32), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      droneStem = viewer.entities.add({ show: false, polyline: { positions: new C.CallbackProperty(() => stemPos, false), width: 0.8, material: new C.PolylineDashMaterialProperty({ color: C.Color.WHITE.withAlpha(0.8), dashLength: 6 }) } });
      trail = viewer.entities.add({ show: false, polyline: { positions: new C.CallbackProperty(() => trailPos, false), width: 7, material: new C.PolylineGlowMaterialProperty({ color: C.Color.fromCssColorString('#ffe14d'), glowPower: 0.25 }) } });
      sight = viewer.entities.add({ show: false, polyline: { positions: new C.CallbackProperty(() => sightPos, false), width: 1.2, arcType: C.ArcType.NONE, material: new C.PolylineDashMaterialProperty({ color: C.Color.fromCssColorString('#ff8a3d'), dashLength: 10 }) } });
      frustum = viewer.entities.add({ polyline: { positions: new C.CallbackProperty(() => frustumPos, false), width: 1, material: C.Color.fromCssColorString('#4fd3ff').withAlpha(0.95) }, show: false });
    }
  }

  // POI: small orange diamond with a thin white outline (same as on the 2D map)
  const poiImgs = {};
  function poiImage(sel) {
    const k = sel ? 's' : 'n'; if (poiImgs[k]) return poiImgs[k]; const Sx = 4, cv = document.createElement('canvas'); cv.width = cv.height = 14 * Sx; const g = cv.getContext('2d'); g.scale(Sx, Sx);
    g.translate(7, 7); g.rotate(Math.PI / 4); g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 2; g.fillStyle = sel ? '#ffe14d' : '#ff7a1a'; g.fillRect(-4, -4, 8, 8); g.shadowColor = 'transparent'; g.lineWidth = 1; g.strokeStyle = '#fff'; g.strokeRect(-4, -4, 8, 8);
    return (poiImgs[k] = cv);
  }
  let lookId = null, sightPos = [], sight = null;
  const DRONE_YAW = 0; // model axis correction (checked by test: heading 0 → nose to the north)
  // take-off point: the same white «H» badge with a green border as on the 2D map
  let homeImg = null;
  function homeImage() {
    if (homeImg) return homeImg; const Sx = 3, cv = document.createElement('canvas'); cv.width = cv.height = 26 * Sx; const g = cv.getContext('2d'); g.scale(Sx, Sx);
    g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 3; g.beginPath(); g.roundRect ? g.roundRect(2, 2, 22, 22, 5) : g.rect(2, 2, 22, 22); g.fillStyle = '#fff'; g.fill(); g.shadowColor = 'transparent';
    g.lineWidth = 2; g.strokeStyle = '#3ccf7a'; g.stroke(); g.fillStyle = '#000'; g.font = '800 13px -apple-system, Helvetica, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', 13, 13.5);
    return (homeImg = cv);
  }
  // crisp marker pins drawn on a canvas at 3× resolution (shown at 30×40 px)
  const pinCache = new Map();
  function pinImage(txt, kind) {
    const k = kind + '|' + txt; if (pinCache.has(k)) return pinCache.get(k);
    const Sx = 3, W = 30, H = 40, cv = document.createElement('canvas'); cv.width = W * Sx; cv.height = H * Sx;
    const g = cv.getContext('2d'); g.scale(Sx, Sx);
    const fill = { wp: ['#a970ff', '#6a1fe0'], first: ['#7af0a8', '#22b864'], sel: ['#ffe14d', '#f5b800'], poi: ['#ff8a3d', '#e86100'] }[kind] || ['#8a3ffc', '#6a1fe0'];
    // teardrop: circle head (r 12 at y 13) narrowing to the tip at the bottom
    g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 3; g.shadowOffsetY = 1;
    g.beginPath(); g.moveTo(15, 38.5); g.bezierCurveTo(12, 31, 3, 24, 3, 14); g.arc(15, 14, 12, Math.PI, 0); g.bezierCurveTo(27, 24, 18, 31, 15, 38.5); g.closePath();
    const gr = g.createLinearGradient(0, 2, 0, 38); gr.addColorStop(0, fill[0]); gr.addColorStop(1, fill[1]); g.fillStyle = gr; g.fill();
    g.shadowColor = 'transparent'; g.lineWidth = 1.6; g.strokeStyle = '#ffffff'; g.stroke();
    g.fillStyle = kind === 'sel' ? '#1a1400' : '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `700 ${txt.length > 2 ? 10 : 12.5}px -apple-system, Helvetica, Arial, sans-serif`; g.fillText(txt, 15, 14.5);
    pinCache.set(k, cv); return cv;
  }
  // ---- 3D camera frame (pyramid from the camera + footprint on the ground), like Litchi ----
  const YEL = () => Cesium.Color.fromCssColorString('#4fd3ff'); // camera frame colour (Litchi-like light blue)
  // Height of the visible 3D ground at a point (terrain tiles actually rendered), so the footprint lies ON the surface
  // instead of at the drone's ground level (which hid it under hills/terrain far from the drone).
  function surfaceH(C, lat, lng, fallback) {
    if (!useTerr || !viewer) return fallback;
    const h = viewer.scene.globe.getHeight(C.Cartographic.fromDegrees(lng, lat));
    return h === undefined || !isFinite(h) ? fallback : h;
  }
  // closed outline of the image footprint draped over the terrain (each side subdivided)
  function drapeRing(C, corners, gAbs) {
    const out = [], N = 16;
    for (let k = 0; k < 4; k++) {
      const a = corners[k], b = corners[(k + 1) % 4];
      for (let j = 0; j < N; j++) {
        const f = j / N, lat = a.lat + (b.lat - a.lat) * f, lng = a.lng + (b.lng - a.lng) * f, z = (a.z || 0) + ((b.z || 0) - (a.z || 0)) * f;
        out.push(C.Cartesian3.fromDegrees(lng, lat, (z > 0.5 ? gAbs + z : surfaceH(C, lat, lng, gAbs)) + 1.2));
      }
    }
    return out;
  }
  // one side face of the view pyramid: camera apex + the draped footprint edge k (0 = top edge of the image)
  const faceOf = (cam, ring, k) => { const n = ring.length / 4, pts = [cam]; for (let j = 0; j <= n; j++) pts.push(ring[(k * n + j) % ring.length]); return pts; };
  const FACE_A = [0.10, 0.06, 0.06, 0.06]; // the face towards the top of the image is a bit stronger
  function frameGeom(C, pos, camRel, gRel, hd, gb) {
    const fr = Camera.frame(Core.drone(), pos, camRel - gRel, hd, gb, Camera.viewMax(camRel - gRel)), gAbs = H0 + gRel;
    const cam = C.Cartesian3.fromDegrees(pos.lng, pos.lat, H0 + camRel);
    const cH = c => (c.z > 0.5 ? gAbs + c.z : surfaceH(C, c.lat, c.lng, gAbs + (c.z || 0))) + 1.2;
    const cs = fr.corners.map(c => C.Cartesian3.fromDegrees(c.lng, c.lat, cH(c)));
    const ring = drapeRing(C, fr.corners, gAbs);
    const ctr = C.Cartesian3.fromDegrees(fr.center.lng, fr.center.lat, cH(fr.center) + 0.5);
    // top edge of the image (corner 0 → 1), draped as well
    const top = ring.slice(0, 17);
    return { fr, cam, cs, ctr, ring, top };
  }
  const frameText = fr => `кадр ${Math.round(fr.width)}×${Math.round(fr.depth)} м${fr.clipped ? ' (до горизонта)' : ''} · ${fr.gsd.toFixed(1)} см/пикс · ${Math.round(fr.centerDist)} м до центра`;
  function addFrame(C, w, camRel, gRel, hd, gb, withLabel) {
    const { fr, cam, cs, ctr, ring, top } = frameGeom(C, w, camRel, gRel, hd, gb), Y = YEL();
    const n0 = pending.length;
    // translucent view pyramid (like Litchi): 4 faces from the camera to the footprint + its edges
    [0, 1, 2, 3].forEach(k => add({ polygon: { hierarchy: new C.PolygonHierarchy(faceOf(cam, ring, k)), perPositionHeight: true, material: Y.withAlpha(FACE_A[k]) } }));
    cs.forEach(c => add({ polyline: { positions: [cam, c], width: 0.7, material: Y.withAlpha(0.85), depthFailMaterial: Y.withAlpha(0.3), arcType: C.ArcType.NONE } }));
    // closed footprint on the ground: filled area + outline (visible through hills, faint)
    add({ polygon: { hierarchy: new C.PolygonHierarchy(ring), perPositionHeight: true, material: Y.withAlpha(0.22) } });
    add({ polyline: { positions: ring.concat([ring[0]]), width: 1, material: Y, depthFailMaterial: Y.withAlpha(0.5), arcType: C.ArcType.NONE } });
    // top edge of the image marked so orientation is obvious
    add({ polyline: { positions: top, width: 1.4, material: C.Color.fromCssColorString('#ff2a2a'), depthFailMaterial: C.Color.fromCssColorString('#ff2a2a').withAlpha(0.5), arcType: C.ArcType.NONE } });
    // (no text label on the ground: frame size etc. are in the point's panel and in the flight panel)
    const sim = playing || t > 0;
    pending.slice(n0).forEach(e => { e.wsStaticFrame = true; e.show = !sim; });
  }
  // The moving frame uses CallbackProperty geometry: Cesium re-evaluates it every rendered frame synchronously.
  // (Assigning new constant positions each tick makes Cesium rebuild the geometry asynchronously in workers —
  //  during playback it never finishes, so the frame only appeared when the flight was paused.)
  const DF = { cam: null, cs: null, ring: null, top: null, ctr: null, text: '', on: false };
  function ensureDynFrame(C) {
    if (dynFrame) return dynFrame;
    const Y = YEL(), Z = C.Cartesian3.ZERO;
    const cb = f => new C.CallbackProperty(f, false);
    dynFrame = {
      rays: [0, 1, 2, 3].map(k => viewer.entities.add({ polyline: { positions: cb(() => DF.cs ? [DF.cam, DF.cs[k]] : [Z, Z]), width: 0.7, material: Y.withAlpha(0.9), depthFailMaterial: Y.withAlpha(0.3), arcType: C.ArcType.NONE }, show: false })),
      edge: viewer.entities.add({ polyline: { positions: cb(() => DF.ring ? DF.ring.concat([DF.ring[0]]) : [Z, Z]), width: 1, material: Y, depthFailMaterial: Y.withAlpha(0.55), arcType: C.ArcType.NONE }, show: false }),
      top: viewer.entities.add({ polyline: { positions: cb(() => DF.top || [Z, Z]), width: 1.4, material: C.Color.fromCssColorString('#ff2a2a'), depthFailMaterial: C.Color.fromCssColorString('#ff2a2a').withAlpha(0.55), arcType: C.ArcType.NONE }, show: false }),
      fill: viewer.entities.add({ polygon: { hierarchy: cb(() => new C.PolygonHierarchy(DF.ring || [C.Cartesian3.UNIT_X, C.Cartesian3.UNIT_Y, C.Cartesian3.UNIT_Z])), perPositionHeight: true, material: Y.withAlpha(0.22) }, show: false }),
      faces: [0, 1, 2, 3].map(k => viewer.entities.add({ polygon: { hierarchy: cb(() => new C.PolygonHierarchy(DF.ring ? faceOf(DF.cam, DF.ring, k) : [C.Cartesian3.UNIT_X, C.Cartesian3.UNIT_Y, C.Cartesian3.UNIT_Z])), perPositionHeight: true, material: Y.withAlpha(FACE_A[k]) }, show: false })),
      label: viewer.entities.add({ position: cb(() => DF.ctr || Z), label: { text: cb(() => DF.text), font: '600 12px -apple-system, sans-serif', fillColor: Y, outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY }, show: false }),
    };
    return dynFrame;
  }
  function showDynFrame(C, c, visible) {
    const F = ensureDynFrame(C), all = [...F.rays, ...F.faces, F.edge, F.top, F.fill, F.label];
    if (!visible || frameMode === 'off' || !c) { all.forEach(e => e.show = false); DF.on = false; return; }
    const gR = groundAtPath(c);
    const { fr, cam, cs, ctr, ring, top } = frameGeom(C, c, c.alt, gR, c.hd, c.gb);
    DF.cam = cam; DF.cs = cs; DF.ring = ring; DF.top = top; DF.ctr = ctr; DF.text = frameText(fr); DF.on = true;
    all.forEach(e => e.show = true); F.label.show = false; // frame data is shown in the drone's bubble
    if (mode === 'fpv') F.rays.concat(F.faces).forEach(r => r.show = false);
  }
  // ground (relative to take-off) under the drone, interpolated from the path samples
  function groundAtPath(c) {
    if (!tl) return 0;
    const P = tl.pts; let k = 0, bd = Infinity;
    for (let i = 0; i < P.length; i++) { const d = Math.abs(P[i].lat - c.lat) + Math.abs(P[i].lng - c.lng); if (d < bd) { bd = d; k = i; } }
    const a = P[k], b = P[Math.min(P.length - 1, k + 1)], d0 = Geo.dist(a, c), dab = Geo.dist(a, b);
    if (a.g == null) return 0; if (b.g == null || dab < 0.01) return a.g;
    return a.g + (b.g - a.g) * Math.max(0, Math.min(1, d0 / dab));
  }

  // ================= «Вид камеры» — picture-in-picture: what the drone camera sees (like Litchi's camera preview) =================
  let pipV = null, pipOn = Core.store.get('ws.pip3d', true) !== false, pipEnts = [], pipKey = '';
  function initPip(C) {
    pipV = new C.Viewer('pipMap', {
      baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
      animation: false, timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false, scene3DOnly: true,
      terrainProvider: useTerr ? terrainProvider(C) : new C.EllipsoidTerrainProvider(), requestRenderMode: true, maximumRenderTimeChange: Infinity,
      creditContainer: document.createElement('div'), useBrowserRecommendedResolution: false, msaaSamples: 4,
    });
    pipV.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({ url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maximumLevel: 18 }));
    pipV.scene.globe.baseColor = C.Color.fromCssColorString('#1b2733');
    pipV.scene.globe.depthTestAgainstTerrain = true;
    pipV.scene.globe.maximumScreenSpaceError = 2;
    pipV.scene.skyAtmosphere.show = true;
    const cc = pipV.scene.screenSpaceCameraController; cc.enableInputs = false; // the view is driven by the drone, not the mouse
    // two viewers share Cesium's per-server request limit: raise it so the small view is not starved by the big one
    ['server.arcgisonline.com:443', 's3.amazonaws.com:443'].forEach(k => { C.RequestScheduler.requestsByServer[k] = 36; });
    let pend = 0, kick = null;
    pipV.scene.globe.tileLoadProgressEvent.addEventListener(n => {
      pend = n; const w = document.getElementById('pipWait'); if (w) w.hidden = n === 0;
      if (n > 0 && !kick) kick = setInterval(() => { if (!pend || !pipV) { clearInterval(kick); kick = null; return; } pipV.scene.requestRender(); }, 250);
    });
  }
  function pipBuild(C, W) {
    if (!pipV) return;
    pipEnts.forEach(e => pipV.entities.remove(e)); pipEnts = [];
    const P = (lat, lng, rel) => C.Cartesian3.fromDegrees(lng, lat, H0 + rel), add = o => { const e = pipV.entities.add(o); pipEnts.push(e); return e; };
    addBuildings(C, add);
    const geo = Core.pathGeometry();
    if (geo.length > 1) add({ polyline: { positions: geo.map(p => P(p.lat, p.lng, p.alt)), width: 1.4, material: C.Color.fromCssColorString('#ffe100').withAlpha(0.95), arcType: C.ArcType.NONE } });
    W.forEach((w, i) => add({ position: P(w.lat, w.lng, Core.wpRel(w)), point: { pixelSize: 9, color: C.Color.fromCssColorString(i === 0 ? '#22b864' : '#7b3ff0'), outlineColor: C.Color.WHITE, outlineWidth: 1.5 },
      label: { text: String(i + 1), font: 'bold 11px -apple-system, sans-serif', fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -12) } }));
    S.m.pois.forEach(p => add({ position: P(p.lat, p.lng, groundRel(p) + (p.alt || 0)), point: { pixelSize: 11, color: C.Color.fromCssColorString('#ff7a1a'), outlineColor: C.Color.WHITE, outlineWidth: 2 },
      label: { text: `${p.name || 'POI'} · ${Math.round((p.alt || 0) * 10) / 10} м`, font: '11px sans-serif', fillColor: C.Color.fromCssColorString('#ffd2b0'), outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -12) } }));
    pipV.scene.requestRender();
  }
  // camera pose to show: the flying drone during the simulation, otherwise the selected waypoint (or the first one)
  function pipPose() {
    const W = S.m.waypoints; if (!W.length) return null;
    if (tl && (playing || t > 0)) { const c = at(t), w = W[c.wi] || {}; return { lat: c.lat, lng: c.lng, alt: c.alt, hd: c.hd, gb: c.gb, zoom: w.zoom || 1, what: `полёт · Т.${c.wi + 1}→${Math.min(W.length, c.wi + 2)}`, g: groundAtPath(c) }; }
    const sid = S.sel.size === 1 ? [...S.sel][0] : null; let i = sid ? Core.wpIndex(sid) : 0; if (!(i >= 0)) i = 0;
    const w = W[i], hd = Core.effHeading(i);
    return { lat: w.lat, lng: w.lng, alt: Core.wpRel(w), hd: hd ?? 0, gb: Core.effGimbal(i) ?? w.gimbal ?? -30, zoom: w.zoom || 1, what: `точка ${i + 1}${sid ? '' : ' (выберите точку)'}`, g: groundRel(w) };
  }
  function pipUpdate(force) {
    const box = root && root.querySelector('#v3pip'), btn = root && root.querySelector('#v3pipBtn');
    if (btn) btn.classList.toggle('on', pipOn);
    if (!box) return;
    const pose = pipOn && pipV && mode !== 'fpv' ? pipPose() : null;
    box.hidden = !pose; if (!pose) return;
    const C = Cesium, d = Core.drone(), cv = pipV.scene.canvas;
    const k = `${pose.lat.toFixed(7)},${pose.lng.toFixed(7)},${pose.alt.toFixed(1)},${(+pose.hd).toFixed(1)},${(+pose.gb).toFixed(1)},${pose.zoom},${H0},${d.name}`;
    if (!force && k === pipKey) return; pipKey = k;
    const fp = Camera.footprint(d, 1), asp = d.wPx / d.hPx;
    box.style.setProperty('--pipAsp', String(asp));
    const fr = pipV.camera.frustum; fr.aspectRatio = cv.clientWidth / Math.max(1, cv.clientHeight);
    fr.fov = C.Math.toRadians(Math.min(120, fp.hfov / Math.max(1, pose.zoom))); // fov of the wider (horizontal) side
    pipV.camera.setView({ destination: C.Cartesian3.fromDegrees(pose.lng, pose.lat, H0 + pose.alt), orientation: { heading: C.Math.toRadians(pose.hd || 0), pitch: C.Math.toRadians(pose.gb), roll: 0 } });
    pipV.scene.requestRender();
    const agl = pose.alt - (pose.g || 0);
    let frTxt = ''; try { const f = Camera.frame(d, pose, agl, pose.hd, pose.gb, 1200); frTxt = `кадр ${Math.round(f.width / pose.zoom)}×${Math.round(f.depth / pose.zoom)} м`; } catch (e) { frTxt = ''; }
    root.querySelector('#pipWhat').textContent = ' · ' + pose.what;
    root.querySelector('#pipHud').innerHTML = `<span>H ${Math.round(pose.alt)} м${Math.abs(agl - pose.alt) > 1 ? ` (${Math.round(agl)} над землёй)` : ''}</span><span>курс ${Math.round(Geo.norm360(pose.hd || 0))}°</span><span>подвес ${Math.round(pose.gb)}°</span>${pose.zoom > 1 ? `<span>зум ×${pose.zoom}</span>` : ''}${frTxt ? `<span>${frTxt}</span>` : ''}`;
  }

  // show the whole route; keepView: keep the current direction and tilt of the view (only centre and zoom change)
  function fit(keepView) {
    const C = Cesium, W = S.m.waypoints; if (!W.length || !viewer) return;
    const pts = Core.pathGeometry().concat(W).map(w => C.Cartesian3.fromDegrees(w.lng, w.lat, H0 + (w.alt != null && w.i != null ? w.alt : Core.wpRel(w))));
    if (S.m.home) { const h = S.m.home; pts.push(C.Cartesian3.fromDegrees(h.lng, h.lat, H0)); }
    S.m.pois.forEach(p => pts.push(C.Cartesian3.fromDegrees(p.lng, p.lat, H0 + (p.alt || 0))));
    const bs = C.BoundingSphere.fromPoints(pts), cam = viewer.camera;
    if (cam.lookAtTransform && mode === 'orbit') cam.lookAtTransform(C.Matrix4.IDENTITY);
    let hd = C.Math.toRadians(20), pt = C.Math.toRadians(-35);
    if (keepView) { hd = cam.heading; pt = Math.max(C.Math.toRadians(-89), Math.min(C.Math.toRadians(-8), cam.pitch)); }
    const fov = cam.frustum.fov || C.Math.toRadians(60), aspect = viewer.canvas.clientWidth / Math.max(1, viewer.canvas.clientHeight);
    const half = Math.min(fov, fov * aspect) / 2, range = Math.max(bs.radius / Math.sin(half) * 1.12, 120);
    cam.flyToBoundingSphere(bs, { offset: new C.HeadingPitchRange(hd, pt, range), duration: 1.0 });
  }

  // ---- flight timeline (same model as the 2D simulator) ----
  function buildTimeline() { return SimCore.build(p => ({ g: groundRel(p) })); }
  const at = tt => SimCore.at(tl, tt);


  function showDrone() {
    if (!tl || !viewer) { if (drone) { drone.show = false; droneTip.show = false; bubble(null); frustum.show = false; droneStem.show = trail.show = false; if (dynFrame) showDynFrame(Cesium, null, false); } emitState(); Core.emit('simtel', null); pipUpdate(); return; }
    const C = Cesium, c = at(t);
    const pos = C.Cartesian3.fromDegrees(c.lng, c.lat, H0 + c.alt);
    drone.position = pos; drone.show = mode !== 'fpv' && (playing || t > 0);
    // 3D model turned where the camera looks (the drone's heading); model nose = +X
    drone.orientation = C.Transforms.headingPitchRollQuaternion(pos, new C.HeadingPitchRoll(C.Math.toRadians((c.hd || 0) + DRONE_YAW), 0, 0));
    droneTip.position = pos;
    const gR = groundAtPath(c);
    stemPos = [C.Cartesian3.fromDegrees(c.lng, c.lat, H0 + gR), pos];
    const done = tl.pts.filter(p => p.t <= t && !p.hold).map(p => C.Cartesian3.fromDegrees(p.lng, p.lat, H0 + p.alt)); done.push(pos);
    trailPos = done.length > 1 ? done : [pos, pos];
    { const lp = (playing || t > 0) ? SimCore.lookPoi(c) : null; lookId = lp ? lp.id : null;
      if (lp && sight) { sightPos = [pos, C.Cartesian3.fromDegrees(lp.lng, lp.lat, H0 + groundRel(lp) + (lp.alt || 0))]; sight.show = mode !== 'fpv'; } else if (sight) sight.show = false; }
    droneStem.show = drone.show; trail.show = false; // the flown path is not painted (as in Litchi)
    // camera ray to where the gimbal looks
    const pitch = c.gb * Math.PI / 180, L = 60;
    const d = Geo.dest(c, c.hd, L * Math.cos(pitch));
    frustumPos = [pos, C.Cartesian3.fromDegrees(d.lng, d.lat, H0 + c.alt + L * Math.sin(pitch))];
    frustum.show = drone.show && frameMode === 'off';
    const simOn = playing || t > 0;
    showDynFrame(C, c, simOn);
    drone.label.text = ''; droneTip.show = false;
    bubble(c, pos, drone.show);
    if (simOn !== lastSimOn) { lastSimOn = simOn; routeEnts.forEach(e => { if (e.wsStaticFrame) e.show = !simOn; }); }
    if (mode === 'fpv') {
      const fp = Camera.footprint(Core.drone(), 1);
      viewer.camera.frustum.fov = C.Math.toRadians(Math.max(fp.hfov, 30));
      viewer.camera.setView({ destination: pos, orientation: { heading: C.Math.toRadians(c.hd), pitch: C.Math.toRadians(c.gb), roll: 0 } });
    } else if (mode === 'chase') {
      // «Сзади» = behind the drone ALONG THE ROUTE (direction of travel), not behind its nose: when the camera looks
      // sideways (own course, POI) the view still looks down the flight path. Direction = from where the drone was
      // 1.5 s ago to where it will be in 1.5 s (smooth on curves); kept while hovering.
      const pa = at(Math.max(0, t - 1.5)), pb = at(Math.min(tl.T, t + 1.5));
      if (Geo.dist(pa, pb) > 2) { const want = Geo.bearing(pa, pb); chaseHd = chaseHd == null ? want : Geo.norm360(chaseHd + Geo.norm180(want - chaseHd) * 0.25); }
      else if (chaseHd == null) chaseHd = c.hd || 0;
      viewer.camera.lookAt(pos, new C.HeadingPitchRange(C.Math.toRadians(chaseHd), C.Math.toRadians(-32), 55));
    } else if (followOn() && drone.show) {
      // «Карта за дроном» in the free view: the camera moves together with the drone, keeping the user's angle and distance
      if (lastDronePos && !followJump) { const d = C.Cartesian3.subtract(pos, lastDronePos, new C.Cartesian3()); if (C.Cartesian3.magnitude(d) < 5000) viewer.camera.position = C.Cartesian3.add(viewer.camera.position, d, new C.Cartesian3()); }
      if (followJump) { followJump = false; centerOnDrone(pos); }
    }
    lastDronePos = C.Cartesian3.clone(pos, lastDronePos || new C.Cartesian3());
    $('#v3slider').value = Math.round(t / tl.T * 1000);
    emitState();
    emitTel(c, gR);
    pipUpdate();
    setOSD(SimCore.osd(c, t, tl.T));
  }
  let chaseHd = null, frustumPos = [], lastSimOn = false, droneTip = null, droneStem = null, trail = null, stemPos = [], trailPos = [], lastEmit = 0;
  // notify the main window (bottom play button + slider are shared with 3D)
  // ---- flight bubble attached to the drone (HTML overlay: rounded, readable, with a live camera-state indicator) ----
  let bubPos = null, bubOn = false;
  function bubble(c, pos, visible) {
    const el = root && root.querySelector('#v3bub'); if (!el) return;
    bubOn = !!(c && visible); el.hidden = !bubOn; if (!bubOn) { bubPos = null; return; }
    bubPos = pos;
    const cs = tl ? SimCore.camState(tl, c, t, +($('#v3speed') || {}).value || 1) : { rec: false, photo: false };
    SimCore.bubble(el, c, cs);
    placeBubble();
  }
  function placeBubble() {
    const el = root && root.querySelector('#v3bub'); if (!el || !bubOn || !bubPos || !viewer) return;
    const q = viewer.scene.cartesianToCanvasCoordinates(bubPos);
    if (!q) { el.style.visibility = 'hidden'; return; }
    el.style.visibility = ''; el.style.left = q.x + 'px'; el.style.top = q.y + 'px';
  }

  // live telemetry for the right-hand panel (throttled while flying)
  let lastTel = 0;
  function emitTel(c, gR) {
    const now = performance.now(); if (playing && now - lastTel < 90 && t < tl.T) return; lastTel = now;
    Core.emit('simtel', simOnNow() ? { src: '3D', c, agl: SimCore.agl(c), ground: gR, t, T: tl.T, pts: tl.pts, playing } : null);
  }
  const simOnNow = () => !!tl && (playing || t > 0);
  function emitState(force) { const now = performance.now(); if (!force && playing && now - lastEmit < 100) return; lastEmit = now; Core.emit('sim3d', { t, T: tl ? tl.T : 0, playing }); }
  const TIP_SVG = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="18" height="12" viewBox="0 0 18 12"><path d="M0,0 L18,0 L9,12Z" fill="#ffffff" fill-opacity="0.86"/></svg>');
  const DRONE_SVG = 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-32 -32 64 64"><g stroke="#000" stroke-width="3"><line x1="-20" y1="-20" x2="20" y2="20"/><line x1="20" y1="-20" x2="-20" y2="20"/></g><g fill="#ffffffcc" stroke="#000" stroke-width="2"><circle cx="-20" cy="-20" r="8"/><circle cx="20" cy="-20" r="8"/><circle cx="-20" cy="20" r="8"/><circle cx="20" cy="20" r="8"/></g><circle r="9" fill="#ffe14d" stroke="#000" stroke-width="2.5"/><path d="M0,-30 L9,-14 L-9,-14Z" fill="#ffe14d" stroke="#000" stroke-width="2.5"/></svg>`);
  function setOSD(txt) { const o = root && root.querySelector('#v3osd'); if (o) o.textContent = txt; }

  function tick() {
    if (!playing || !tl) return;
    const now = performance.now(), dt = (now - last) / 1000; last = now;
    t += dt * +$('#v3speed').value;
    if (t >= tl.T) { t = tl.T; pause(); }
    showDrone();
  }
  function play() { if (!tl) { tl = buildTimeline(); if (!tl) return toast('Нужно минимум 2 точки'); } if (t >= tl.T) t = 0; if (t === 0 && mode === 'orbit') fit(true); /* start: show the whole route */ playing = true; last = performance.now(); $('#v3play').textContent = '⏸'; showDrone(); emitState(true); }
  // start the 3D flight from waypoint i (context menu «Симуляция полёта с этой точки»)
  function playFrom(i) { tl = buildTimeline(); if (!tl) return toast('Нужно минимум 2 точки'); const p = tl.pts.find(x => x.wp === i); t = p ? p.t : 0; if (t === 0 && mode === 'orbit') fit(true); playing = true; last = performance.now(); if (root) $('#v3play').textContent = '⏸'; showDrone(); emitState(true); }
  function pause() { playing = false; if (root) $('#v3play').textContent = '▶'; emitState(true); }
  function seek(f) { if (!tl) tl = buildTimeline(); if (!tl) return; t = tl.T * Math.max(0, Math.min(1, f)); showDrone(); }
  function setSpeed(v) { const sel = root && $('#v3speed'); if (!sel) return; let best = sel.options[0]; [...sel.options].forEach(o => { if (Math.abs(+o.value - v) < Math.abs(+best.value - v)) best = o; }); sel.value = best.value; }
  function stopSim() { pause(); t = 0; lookId = null; if (sight) sight.show = false; showDrone(); if (drone) { drone.show = false; droneTip.show = false; bubble(null); droneStem.show = trail.show = false; } showDynFrame(Cesium, null, false); lastSimOn = true; routeEnts.forEach(e => { if (e.wsStaticFrame) e.show = true; }); lastSimOn = false; emitState(true); Core.emit('simtel', null); }
  const followOn = () => { const f = document.getElementById('simFollow'); return !!(f && f.checked) && mode === 'orbit'; };
  let lastDronePos = null, followJump = false;
  // put the drone in the middle of the view, keeping the current direction and tilt
  function centerOnDrone(pos) {
    const C = Cesium, cam = viewer.camera; cam.lookAtTransform(C.Matrix4.IDENTITY);
    const range = Math.max(120, Math.min(800, C.Cartesian3.distance(cam.position, pos)));
    cam.lookAt(pos, new C.HeadingPitchRange(cam.heading, Math.min(-0.15, cam.pitch), range)); cam.lookAtTransform(C.Matrix4.IDENTITY);
  }
  document.addEventListener('change', e => { if (e.target && e.target.id === 'simFollow' && isOpen && e.target.checked) { followJump = true; if (!playing) showDrone(); } });
  function setMode(m) {
    mode = m; lastDronePos = null; chaseHd = null; followJump = m === 'orbit' && followOn(); root.querySelectorAll('.v3grp button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
    if (m === 'orbit') { viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); viewer.camera.frustum.fov = Cesium.Math.toRadians(60); }
    if (m !== 'orbit' && !playing && (t === 0 || (tl && t >= tl.T))) play();
    showDrone(); pipUpdate(true);
  }

  async function open() {
    if (isOpen) return;
    isOpen = true;
    document.querySelectorAll('[data-cmd=view3d]').forEach(b => b.classList.add('on3d'));
    if (!root) buildDOM();
    root.hidden = false; $('#v3load').hidden = false;
    try {
      if (!viewer) await initViewer();
      await draw(true);
    } catch (e) {
      console.error(e); $('#v3load').textContent = '3D недоступно: ' + (e.message || e);
      return;
    }
    $('#v3load').hidden = true;
    setTimeout(() => { const h = $('#v3hint'); if (h) h.style.opacity = 0; }, 6000);
  }
  function close() {
    isOpen = false; pause(); Core.emit('simtel', null);
    document.querySelectorAll('[data-cmd=view3d]').forEach(b => b.classList.remove('on3d')); if (viewer) { viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); }
    if (root) root.hidden = true; mode = 'orbit'; if (root) root.querySelectorAll('.v3grp button').forEach(b => b.classList.toggle('on', b.dataset.m === 'orbit'));
    if (viewer) { viewer.camera.frustum.fov = Cesium.Math.toRadians(60); }
  }
  let selKey = '';
  Core.on('rendered', () => { const k = [...S.sel].join(','); if (isOpen && k !== selKey) { selKey = k; draw(false).then(showDrone); } });
  Core.on('zonesView', () => { if (isOpen && viewer) draw(false); });
  Core.on('change', () => { if (!isOpen) return; clearTimeout(redrawT); redrawT = setTimeout(() => { const keep = t; draw(false).then(() => { t = tl ? Math.min(keep, tl.T) : 0; showDrone(); }); }, 60); });
  document.addEventListener('keydown', e => { if (isOpen && e.key === 'Escape' && !(window.WSFull && WSFull.on) && document.activeElement.tagName !== 'INPUT' && !moveHook && document.getElementById('ctx').hidden) { e.stopImmediatePropagation(); if (playing || t > 0) stopSim(); else close(); } if (isOpen && e.key === ' ' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); e.stopImmediatePropagation(); playing ? pause() : play(); } }, true);
  return { get _df() { return DF; }, get viewer() { return viewer; }, open, close, startMove, stopMove, toggle: () => playing ? pause() : play(), playFrom, seek, setSpeed, stopSim, get playing() { return playing; }, redraw: () => isOpen && draw(false), get isOpen() { return isOpen; } };
})();
