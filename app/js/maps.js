// Base maps: Google Maps (official JS API via GoogleMutant, needs API key) with free fallbacks
const Maps = (() => {
  const key = () => Core.store.get('ws.gkey', '') || (window.WS_CONFIG && WS_CONFIG.googleKey) || '';
  const M = { googleReady: false, googleError: null, key };

  const esri = (svc, o = {}) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`, Object.assign({ maxZoom: 21, maxNativeZoom: 19, attribution: 'Tiles © Esri' }, o));
  M.free = {
    'esri-sat': { name: 'Спутник + подписи', short: 'Гибрид', icon: '🛰', make: () => L.layerGroup([esri('World_Imagery', { attribution: 'Imagery © Esri, Maxar, Earthstar' }), esri('Reference/World_Boundaries_and_Places'), esri('Reference/World_Transportation', { opacity: .6 })]) },
    'wayback': { name: 'Архив снимков по датам (Esri Wayback)', short: 'Архив', icon: '🕰', make: () => M.waybackLayer() },
    'esri-clean': { name: 'Спутник (чистый)', short: 'Спутник', icon: '🌍', make: () => esri('World_Imagery', { attribution: 'Imagery © Esri, Maxar, Earthstar' }) },
    'osm': { name: 'OpenStreetMap', short: 'Схема', icon: '🗺', make: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap' }) },
    'esri-street': { name: 'Улицы (Esri)', short: 'Улицы', icon: '🏙', make: () => esri('World_Street_Map') },
    'esri-topo': { name: 'Топокарта (Esri)', short: 'Топо', icon: '🧭', make: () => esri('World_Topo_Map') },
    'topo': { name: 'Рельеф (OpenTopoMap)', short: 'Рельеф', icon: '⛰', make: () => L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 17, attribution: '© OpenTopoMap, OSM' }) },
    'esri-light': { name: 'Светлая (Esri)', short: 'Светлая', icon: '☀️', make: () => L.layerGroup([esri('Canvas/World_Light_Gray_Base', { maxNativeZoom: 16 }), esri('Canvas/World_Light_Gray_Reference', { maxNativeZoom: 16 })]) },
    'esri-dark': { name: 'Тёмная (Esri)', short: 'Тёмная', icon: '🌙', make: () => L.layerGroup([esri('Canvas/World_Dark_Gray_Base', { maxNativeZoom: 16 }), esri('Canvas/World_Dark_Gray_Reference', { maxNativeZoom: 16 })]) },
  };
  M.google = {
    'g-hybrid': { name: 'Google — гибрид', short: 'G гибрид', icon: 'G', type: 'hybrid' },
    'g-sat': { name: 'Google — спутник', short: 'G спутник', icon: 'G', type: 'satellite' },
    'g-road': { name: 'Google — схема', short: 'G схема', icon: 'G', type: 'roadmap' },
    'g-terrain': { name: 'Google — рельеф', short: 'G рельеф', icon: 'G', type: 'terrain' },
  };

  let gLoading = null;
  M.loadGoogle = () => gLoading || (gLoading = new Promise((resolve) => {
    const k = key();
    if (!k) return resolve(false);
    if (M.googleReady) return resolve(true);
    // Google writes the exact reason to the console («…MapError» + the address to allow): catch it to tell the user
    const EXPL = {
      RefererNotAllowedMapError: a => `адрес программы ${a || location.origin} не разрешён в ограничениях ключа. В Google Cloud Console → «Учётные данные» → ключ → «Веб-сайты» добавьте http://localhost:8765/* (и на всякий случай http://localhost:8766/* и http://localhost:8767/*)`,
      ApiNotActivatedMapError: () => 'в проекте не включён Maps JavaScript API',
      ApiTargetBlockedMapError: () => 'ключу запрещён Maps JavaScript API («Ограничения API» у ключа)',
      BillingNotEnabledMapError: () => 'в проекте не подключена оплата (платёжный аккаунт)',
      InvalidKeyMapError: () => 'ключ неверный или удалён',
      ExpiredKeyMapError: () => 'ключ устарел — создайте новый',
      OverQuotaMapError: () => 'превышена квота запросов (дневной лимит или лимит в минуту)',
      DeletedApiProjectMapError: () => 'проект Google Cloud удалён',
    };
    const origErr = console.error;
    console.error = function (...a) {
      try { const t = a.join(' '); const m = t.match(/(\w+MapError)/); if (m) { const u = (t.match(/authorized:\s*(\S+)/) || [])[1]; M.googleErrorCode = m[1]; M.googleError = 'Google отклонил ключ: ' + (EXPL[m[1]] ? EXPL[m[1]](u) : m[1]) + ` [${m[1]}]`; Core.emit('google', false); } } catch (e) { /* ignore */ }
      return origErr.apply(this, a);
    };
    window.gm_authFailure = () => { M.googleReady = false; if (!M.googleErrorCode) M.googleError = 'Google отклонил ключ API (неверный ключ, не включён Maps JavaScript API или нет биллинга).'; setTimeout(() => Core.emit('google', false), 50); };
    window.__wsGoogleInit = () => { M.googleReady = true; resolve(true); Core.emit('google', true); };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(k)}&v=beta&libraries=places,geometry&language=ru&callback=__wsGoogleInit`;
    s.async = true; s.onerror = () => { M.googleError = 'Не удалось загрузить Google Maps (нет сети?)'; resolve(false); };
    document.head.appendChild(s);
    setTimeout(() => resolve(M.googleReady), 15000);
  }));

  // ---- commercial imagery by the user's own keys: Airbus OneAtlas (Pléiades / SPOT — CNES), Vantor (Maxar) Vivid ----
  const IMG = () => Core.store.get('ws.img', {}) || {};
  M.pro = {
    'airbus': { name: 'Airbus / CNES — OneAtlas (Pléiades, SPOT)', short: 'Airbus', icon: '🛰', need: 'airbus',
      make: () => L.tileLayer('/tp/airbus/{z}/{x}/{y}', { maxZoom: 22, maxNativeZoom: 19, attribution: '© Airbus DS, © CNES — OneAtlas Basemap' }) },
    'maxar': { name: 'Vantor (Maxar) — Vivid', short: 'Maxar', icon: '🛰', need: 'maxar',
      make: () => L.tileLayer.wms('https://api.maxar.com/basemaps/v1/ogc/wms', { layers: 'Maxar:Imagery', format: 'image/jpeg', version: '1.3.0', tiled: true, maxZoom: 22, maxNativeZoom: 20, maxar_api_key: IMG().maxar || '', attribution: '© Vantor (Maxar Technologies)' }) },
  };
  M.proReady = k => !!IMG()[M.pro[k].need];

  // ---- Esri Wayback: every published version of the Esri World Imagery (Vantor/Maxar, Airbus, aerial…) since 2014 ----
  let wb = null;
  M.wayback = () => wb || (wb = fetch('https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json').then(r => r.json()).then(j =>
    Object.entries(j).map(([id, v]) => ({ id, date: (v.itemTitle.match(/\d{4}-\d{2}-\d{2}/) || [''])[0], meta: v.metadataLayerUrl })).filter(x => x.date).sort((a, b) => b.date.localeCompare(a.date))
  ).catch(e => { wb = null; throw e; }));
  M.waybackLayer = () => {
    const g = L.layerGroup(); let rel = Core.store.get('ws.wbRel', '');
    M.wayback().then(list => { const r = list.find(x => x.id === rel) || list[0]; rel = r.id;
      L.tileLayer(`https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${r.id}/{z}/{y}/{x}`, { maxZoom: 22, maxNativeZoom: 19, attribution: `Imagery © Esri Wayback ${r.date}` }).addTo(g); })
      .catch(() => esri('World_Imagery').addTo(g));
    return g;
  };
  // where an Esri satellite picture comes from: provider, satellite, capture date and resolution at a point
  M.imageryInfo = async (lat, lng, z, metaUrl) => {
    if (!metaUrl) { const l = await M.wayback(); metaUrl = l[0].meta; }
    let id = Math.max(0, Math.min(13, Math.round(23 - z)));
    for (let k = 0; k < 4 && id <= 13; k++, id++) {
      const u = `${metaUrl}/${id}/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=SRC_DATE2,NICE_DESC,NICE_NAME,SRC_DESC,SRC_RES&returnGeometry=false&f=json`;
      const j = await fetch(u).then(r => r.json()); const a = j.features && j.features[0] && j.features[0].attributes;
      if (a) return { provider: a.NICE_DESC === 'Vantor' ? 'Vantor (Maxar)' : a.NICE_DESC, product: a.NICE_NAME, sensor: a.SRC_DESC, date: a.SRC_DATE2, res: a.SRC_RES };
    }
    return null;
  };

  M.makeLayer = id => {
    if (M.pro[id]) return M.proReady(id) ? M.pro[id].make() : M.free['esri-sat'].make();
    if (M.free[id]) return M.free[id].make();
    const g = M.google[id];
    if (g && M.googleReady) return L.gridLayer.googleMutant({ type: g.type, maxZoom: 22 });
    return M.free['esri-sat'].make();
  };
  M.list = () => Object.assign({}, M.googleReady ? M.google : {}, Object.fromEntries(Object.entries(M.pro).filter(([k]) => M.proReady(k))), M.free);

  // Geocoding: Google if available, else Nominatim. Also parses "lat, lng".
  M.search = async q => {
    const m = q.trim().match(/^(-?\d+(?:\.\d+)?)[\s,;]+(-?\d+(?:\.\d+)?)$/);
    if (m) return [{ name: `Координаты ${m[1]}, ${m[2]}`, lat: +m[1], lng: +m[2] }];
    if (M.googleReady) {
      try {
        const r = await new google.maps.Geocoder().geocode({ address: q });
        return r.results.slice(0, 6).map(x => ({ name: x.formatted_address, lat: x.geometry.location.lat(), lng: x.geometry.location.lng() }));
      } catch (e) { /* fall through */ }
    }
    const j = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=ru&q=' + encodeURIComponent(q)).then(r => r.json());
    return j.map(x => ({ name: x.display_name, lat: +x.lat, lng: +x.lon }));
  };

  // Wind & weather at a point (Open-Meteo)
  M.weather = async p => {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat.toFixed(4)}&longitude=${p.lng.toFixed(4)}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,cloud_cover,visibility&hourly=wind_speed_80m,wind_speed_120m,wind_direction_120m,precipitation_probability&wind_speed_unit=ms&forecast_hours=12&timezone=auto`;
    return fetch(u).then(r => r.json());
  };
  return M;
})();
