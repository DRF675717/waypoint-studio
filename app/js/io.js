// Import / export: Litchi CSV, DJI WPML KMZ (DJI Fly / Pilot 2), KML (Google Earth), GPX, GeoJSON, JSON
const IO = (() => {
  const { S } = Core;
  const f = (n, d = 6) => (Math.round(n * 10 ** d) / 10 ** d).toString();
  const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  // file names are transliterated to Latin: Chromium/Electron drop non-ASCII download names ("download" without extension),
  // and DJI remotes / Android file managers handle ASCII names more reliably
  const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  const translit = t => t.replace(/[а-яё]/gi, c => { const l = TR[c.toLowerCase()] ?? ''; return c === c.toLowerCase() ? l : l.charAt(0).toUpperCase() + l.slice(1); });
  const safeFile = n => translit(n || 'mission').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'mission';
  const safeName = () => translit(S.m.name || 'mission').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'mission';

  function download(name, data, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'text/plain' });
    if (window.AndroidBridge) { // Android APK: save through native bridge into Download/WaypointStudio
      const r = new FileReader();
      r.onload = () => {
        const b64 = String(r.result).split(',')[1] || '';
        const res = AndroidBridge.saveFile(name, b64, blob.type || mime || 'application/octet-stream');
        if (res && res.startsWith('ERR')) toast('Ошибка сохранения: ' + res, 'err', 6000);
        else { IO.lastSaved = { uri: res, mime: blob.type || mime || 'application/octet-stream', name }; toast('Сохранено: Загрузки/WaypointStudio/' + name + ' · «Экспорт → Отправить файл» — поделиться', 'ok', 6000); }
      };
      r.readAsDataURL(blob);
      return;
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  // ---------------- Litchi CSV ----------------
  const LITCHI_HEADER = ['latitude', 'longitude', 'altitude(m)', 'heading(deg)', 'curvesize(m)', 'rotationdir', 'gimbalmode', 'gimbalpitchangle'];
  for (let i = 1; i <= 15; i++) LITCHI_HEADER.push('actiontype' + i, 'actionparam' + i);
  LITCHI_HEADER.push('altitudemode', 'speed(m/s)', 'poi_latitude', 'poi_longitude', 'poi_altitude(m)', 'poi_altitudemode', 'photo_timeinterval', 'photo_distinterval');

  function litchiCSV() {
    const W = S.m.waypoints, s = S.m.settings;
    const gm = { disabled: 0, poi: 1, interpolate: 2 }[s.gimbalMode] ?? 2;
    const rows = [LITCHI_HEADER.join(',')];
    W.forEach((w, i) => {
      const h = Core.effHeading(i) ?? w.heading;
      const poi = Core.poiById(w.poi) || ((s.headingMode === 'poi' || s.gimbalMode === 'poi') ? S.m.pois[0] : null);
      const r = [f(w.lat, 8), f(w.lng, 8), f(w.alt, 1), f(Geo.norm360(s.headingMode === 'custom' ? w.heading : h), 1), f(i === 0 || i === W.length - 1 || s.pathMode !== 'curved' ? 0.2 : Core.curveMeters(i) || 0.2, 1), 0,
        poi && gm === 1 ? 1 : gm, f(w.gimbal, 1)];
      for (let k = 0; k < 15; k++) { const a = w.actions[k]; r.push(a ? a.type : -1, a ? Math.round(a.param || 0) : 0); }
      r.push(s.altMode === 'agl' ? 1 : 0, f(w.speed || 0, 1), poi ? f(poi.lat, 8) : 0, poi ? f(poi.lng, 8) : 0, poi ? f(poi.alt || 0, 1) : 0, 0,
        w.photoTime > 0 ? f(w.photoTime, 1) : -1, w.photoDist > 0 ? f(w.photoDist, 1) : -1);
      rows.push(r.join(','));
    });
    return rows.join('\n');
  }
  function parseCSV(text) {
    const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
    const head = lines[0].split(/[,;]/).map(h => h.trim().toLowerCase());
    const col = n => head.indexOf(n);
    if (col('latitude') < 0 || col('longitude') < 0) throw new Error('В CSV нет колонок latitude/longitude');
    const m = Core.newMission(); m.waypoints = []; m.pois = [];
    const poiKey = {};
    let altMode = 0;
    lines.slice(1).forEach(l => {
      const c = l.split(/[,;]/).map(x => x.trim());
      const g = (n, d = 0) => { const i = col(n); const v = i >= 0 ? parseFloat(c[i]) : NaN; return isNaN(v) ? d : v; };
      const w = Core.newWaypoint({ lat: g('latitude'), lng: g('longitude'), alt: g('altitude(m)', 30) }, m);
      w.heading = g('heading(deg)'); w.curve = g('curvesize(m)'); w.gimbal = g('gimbalpitchangle'); w.speed = g('speed(m/s)');
      const pt = g('photo_timeinterval', -1), pd = g('photo_distinterval', -1);
      w.photoTime = pt > 0 ? pt : 0; w.photoDist = pd > 0 ? pd : 0;
      for (let k = 1; k <= 15; k++) { const t = g('actiontype' + k, -1); if (t >= 0 && t <= 5) w.actions.push({ type: t, param: g('actionparam' + k) }); }
      altMode = g('altitudemode', altMode);
      const plat = g('poi_latitude'), plng = g('poi_longitude');
      if (plat || plng) {
        const k = plat.toFixed(6) + ',' + plng.toFixed(6);
        if (!poiKey[k]) { const p = { id: Core.id(), lat: plat, lng: plng, alt: g('poi_altitude(m)'), name: 'POI ' + (m.pois.length + 1) }; m.pois.push(p); poiKey[k] = p.id; }
        w.poi = poiKey[k];
      }
      m.waypoints.push(w);
    });
    m.settings.altMode = altMode === 1 ? 'agl' : 'takeoff';
    m.settings.headingMode = 'custom';
    const gms = lines.slice(1).map(l => parseFloat(l.split(',')[col('gimbalmode')]));
    m.settings.gimbalMode = gms.includes(1) ? 'poi' : gms.includes(2) ? 'interpolate' : 'disabled';
    return m;
  }

  // ---------------- DJI WPML (KMZ) ----------------
  // ======== DJI Fly dialect ========
  // Reverse-engineered from missions created by DJI Fly itself on a DJI RC 2 (28 missions, Mini-series drone):
  // namespace uav.com/wpmz/1.0.2, template.kml = missionConfig only, per-point heading/turn/gimbal params,
  // camera pitch = gimbalRotate at point 1 + gimbalEvenlyRotate on every segment, first/last points stop.
  const FLY_NS = 'http://www.uav.com/wpmz/1.0.2';
  // every element path DJI Fly itself writes (validator rejects anything else)
  const FLY_PATHS = new Set(['kml', 'kml/Document', 'kml/Document/author', 'kml/Document/createTime', 'kml/Document/updateTime', 'kml/Document/missionConfig',
    ...['flyToWaylineMode', 'finishAction', 'exitOnRCLost', 'executeRCLostAction', 'globalTransitionalSpeed', 'droneInfo', 'droneInfo/droneEnumValue', 'droneInfo/droneSubEnumValue'].map(x => 'kml/Document/missionConfig/' + x),
    'kml/Document/Folder', ...['templateId', 'executeHeightMode', 'waylineId', 'distance', 'duration', 'autoFlightSpeed', 'Placemark'].map(x => 'kml/Document/Folder/' + x),
    ...['Point', 'Point/coordinates', 'index', 'executeHeight', 'waypointSpeed', 'waypointHeadingParam', 'waypointHeadingParam/waypointHeadingMode', 'waypointHeadingParam/waypointHeadingAngle',
      'waypointHeadingParam/waypointPoiPoint', 'waypointHeadingParam/waypointHeadingAngleEnable', 'waypointHeadingParam/waypointHeadingPathMode', 'waypointHeadingParam/waypointHeadingPoiIndex',
      'waypointTurnParam', 'waypointTurnParam/waypointTurnMode', 'waypointTurnParam/waypointTurnDampingDist', 'useStraightLine', 'actionGroup', 'actionGroup/actionGroupId', 'actionGroup/actionGroupStartIndex',
      'actionGroup/actionGroupEndIndex', 'actionGroup/actionGroupMode', 'actionGroup/actionTrigger', 'actionGroup/actionTrigger/actionTriggerType', 'actionGroup/action', 'actionGroup/action/actionId',
      'actionGroup/action/actionActuatorFunc', 'actionGroup/action/actionActuatorFuncParam',
      ...['gimbalHeadingYawBase', 'gimbalRotateMode', 'gimbalPitchRotateEnable', 'gimbalPitchRotateAngle', 'gimbalRollRotateEnable', 'gimbalRollRotateAngle', 'gimbalYawRotateEnable', 'gimbalYawRotateAngle',
        'gimbalRotateTimeEnable', 'gimbalRotateTime', 'payloadPositionIndex', 'focalLength', 'isUseFocalFactor', 'focalFactor', 'useGlobalPayloadLensIndex', 'hoverTime'].map(x => 'actionGroup/action/actionActuatorFuncParam/' + x),
      'waypointGimbalHeadingParam', 'waypointGimbalHeadingParam/waypointGimbalPitchAngle', 'waypointGimbalHeadingParam/waypointGimbalYawAngle'].map(x => 'kml/Document/Folder/Placemark/' + x)]);
  const FLY_ENUMS = {
    flyToWaylineMode: ['safely'], finishAction: ['goHome', 'noAction', 'autoLand', 'gotoFirstWaypoint'], exitOnRCLost: ['executeLostAction', 'goContinue'], executeRCLostAction: ['goBack', 'hover', 'landing'],
    executeHeightMode: ['relativeToStartPoint'], waypointHeadingMode: ['smoothTransition', 'towardPOI', 'followWayline', 'manually'], waypointHeadingPathMode: ['followBadArc'],
    waypointTurnMode: ['toPointAndPassWithContinuityCurvature', 'toPointAndStopWithContinuityCurvature'], actionGroupMode: ['parallel'], actionTriggerType: ['reachPoint', 'betweenAdjacentPoints'],
    actionActuatorFunc: ['gimbalEvenlyRotate', 'zoom', 'startRecord', 'hover', 'gimbalRotate', 'stopRecord', 'takePhoto'], gimbalHeadingYawBase: ['aircraft'], gimbalRotateMode: ['absoluteAngle'],
  };
  // problems that make a route impossible to fly in DJI Fly exactly as planned (shown before sending)
  function djiFlyIssues(cap) {
    const W = S.m.waypoints, s = S.m.settings, err = [], warn = [];
    if (W.length < 2) err.push('нужно минимум 2 точки');
    { const nOut = poiPreDepth ? W.length : exportList().length; if (nOut > 200) err.push(`DJI Fly принимает не больше 200 точек, записывается ${nOut}`); }
    W.forEach((w, i) => {
      w.actions.forEach(a => { if (a.type === 4) err.push(`точка ${i + 1}: действие «поворот дрона» DJI Fly не поддерживает — уберите его или задайте курс точки`); });

      if (w.actions.length > 10) warn.push(`точка ${i + 1}: ${w.actions.length} действий — DJI Fly может показать не все`);
    });
    const iv = W.map((w, i) => w.photoDist || w.photoTime ? i + 1 : 0).filter(Boolean);
    if (iv.length) err.push(`съёмка по интервалу (точки ${iv.slice(0, 5).join(', ')}${iv.length > 5 ? '…' : ''}) в DJI Fly не поддерживается — для картирования выберите «Съёмка: фото в каждой точке» в генераторе или используйте видео`);
    if ((s.headingMode === 'poi' || W.some(w => w.hm === 'poi')) && !S.m.pois.length) err.push('курс «на POI», но точка интереса не поставлена');
    const sp = cap && cap.speed; const vmax = sp ? sp.max : 15, vmin = sp ? sp.min : 0.1;
    if (s.cruise > vmax || s.cruise < vmin) err.push(`крейсерская скорость ${s.cruise} м/с вне допустимого для дрона (${vmin.toFixed(1)}…${vmax} м/с)`);
    W.forEach((w, i) => { if (w.speed && (w.speed > vmax || w.speed < vmin)) err.push(`точка ${i + 1}: скорость ${w.speed} м/с вне допустимого (${vmin.toFixed(1)}…${vmax})`); });
    const gp = cap && cap.pitch, gmin = gp ? gp.min : -90, gmax = gp ? gp.max : 35;
    if (s.gimbalMode !== 'disabled') W.forEach((w, i) => { if (w.gkeep && i > 0) return; const g = Core.effGimbal(i) ?? w.gimbal; if (g < gmin || g > gmax) err.push(`точка ${i + 1}: наклон камеры ${Math.round(g)}° вне диапазона подвеса (${gmin}…${gmax}°)`); });
    if (s.pathMode !== 'curved') warn.push('«Прямые с остановками» будут записаны как остановка в каждой точке (DJI Fly сам строит путь плавными кривыми)');
    if (s.finishAction !== 'rth') warn.push('DJI Fly создаёт задания с «Возврат домой» по завершении; другое действие может не отображаться в DJI Fly');
    if (s.headingMode === 'initial') warn.push('курс «как в начале» записан как постоянный курс в каждой точке');
    return { err, warn };
  }
  async function djiFlyXML(opt = {}) {
    const W = S.m.waypoints, s = S.m.settings, n = W.length;
    const warnings = [];
    if (s.altMode === 'agl') await Core.Elev.ensure(W.concat(Core.homePt() ? [Core.homePt()] : [])); // heights depend on terrain: must not guess
    else if (s.headingMode === 'poi' || W.some(w => w.hm === 'poi')) {
      try { await Core.Elev.ensure(S.m.pois.concat(Core.homePt() ? [Core.homePt()] : [])); }
      catch (e) { warnings.push('рельеф недоступен: высота POI взята без поправки на рельеф (влияет только на наклон камеры к POI)'); }
    }
    const ns = opt.ns || FLY_NS, de = opt.droneEnum ?? '68', ds = opt.droneSub ?? '0';
    const num = v => String(Math.round(v * 10) / 10);
    const now = Date.now();
    const finish = { rth: 'goHome', none: 'noAction', land: 'autoLand', first: 'gotoFirstWaypoint', reverse: 'goHome' }[s.finishAction] || 'goHome';
    const cruise = num(s.cruise);
    const mc = `
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>${finish}</wpml:finishAction>
      <wpml:exitOnRCLost>${s.rcLost === 'continue' ? 'goContinue' : 'executeLostAction'}</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:globalTransitionalSpeed>${cruise}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${de}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${ds}</wpml:droneSubEnumValue>
      </wpml:droneInfo>
    </wpml:missionConfig>`;
    const template = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${ns}">
  <Document>
    <wpml:author>fly</wpml:author>
    <wpml:createTime>${now}</wpml:createTime>
    <wpml:updateTime>${now}</wpml:updateTime>${mc}
  </Document>
</kml>
`;
    const gh = Core.groundAt(Core.homePt());
    const poiStr = w => {
      const p = Core.poiById(w.poi) || S.m.pois[0];
      if (modeOf(w) !== 'poi' || !p) return '0.000000,0.000000,0.000000';
      const g = Core.groundAt(p), rel = p.altRel ? (p.alt || 0) : (g !== undefined && gh !== undefined ? g - gh : 0) + (p.alt || 0);
      return `${p.lat.toFixed(6)},${p.lng.toFixed(6)},${rel.toFixed(6)}`;
    };
    const HM = { auto: 'followWayline', poi: 'towardPOI', custom: 'smoothTransition', initial: 'smoothTransition', manual: 'manually' };
    const modeOf = w => w.hm || s.headingMode;
    const h0 = Core.effHeading(0) ?? 0;
    const gimbalOn = s.gimbalMode !== 'disabled';
    const pitch = i => Math.max(-90, Math.min(55, Core.effGimbal(i) ?? W[i].gimbal ?? 0));
    let aid = 1;
    const A = (func, params) => `
          <wpml:action>
            <wpml:actionId>${aid++}</wpml:actionId>
            <wpml:actionActuatorFunc>${func}</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>${params}
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
    const P = (k, v) => `\n              <wpml:${k}>${v}</wpml:${k}>`;
    const gimbalRotate = g => A('gimbalRotate', P('gimbalHeadingYawBase', 'aircraft') + P('gimbalRotateMode', 'absoluteAngle') + P('gimbalPitchRotateEnable', 1) + P('gimbalPitchRotateAngle', num(g))
      + P('gimbalRollRotateEnable', 1) + P('gimbalRollRotateAngle', 0) + P('gimbalYawRotateEnable', 0) + P('gimbalYawRotateAngle', 0) + P('gimbalRotateTimeEnable', 0) + P('gimbalRotateTime', 0) + P('payloadPositionIndex', 0));
    const userAction = a => {
      switch (a.type) {
        case 1: return A('takePhoto', P('payloadPositionIndex', 0) + P('useGlobalPayloadLensIndex', 0));
        case 2: return A('startRecord', P('payloadPositionIndex', 0) + P('useGlobalPayloadLensIndex', 0));
        case 3: return A('stopRecord', P('payloadPositionIndex', 0));
        case 0: return A('hover', P('hoverTime', num(Math.max(1, (a.param || 0) / 1000))));
        case 5: return gimbalRotate(Math.max(-90, Math.min(55, a.param || 0)));
        default: throw new Error('действие не поддерживается DJI Fly');
      }
    };
    const group = (id, a, b, trig, body) => `
        <wpml:actionGroup>
          <wpml:actionGroupId>${id}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${a}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${b}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>parallel</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>${trig}</wpml:actionTriggerType>
          </wpml:actionTrigger>${body}
        </wpml:actionGroup>`;
    const marks = W.map((w, i) => {
      const rel = Core.wpRel(w);
      if (rel === undefined || !isFinite(rel)) throw new Error(`точка ${i + 1}: не удалось вычислить высоту относительно взлёта (нет данных рельефа)`);
      const edge = i === 0 || i === n - 1;
      const md = modeOf(w), hmode = HM[md] || 'followWayline';
      const ang = Geo.norm180(hmode === 'smoothTransition' ? (md === 'initial' ? h0 : w.hm === 'custom' ? (w.heading || 0) : (Core.effHeading(i) ?? 0)) : (Core.effHeading(i) ?? 0));
      const turn = s.pathMode === 'curved' && !edge ? 'toPointAndPassWithContinuityCurvature' : 'toPointAndStopWithContinuityCurvature';
      let reach = (gimbalOn && i === 0 ? gimbalRotate(pitch(0)) : '') + w.actions.map(userAction).join('');
      let groups = reach ? group(1, i, i, 'reachPoint', reach) : '';
      const zoomA = (f) => A('zoom', P('focalLength', 0) + P('isUseFocalFactor', 1) + P('focalFactor', num(f)) + P('payloadPositionIndex', 0));
      if (i === 0 && w.zoom) groups += group(4, 0, 0, 'reachPoint', zoomA(w.zoom));
      if (i < n - 1 && W[i + 1].zoom) groups += group(3, i, i + 1, 'betweenAdjacentPoints', zoomA(W[i + 1].zoom));
      if (gimbalOn && i < n - 1 && !W[i + 1].gkeep) groups += group(2, i, i + 1, 'reachPoint', A('gimbalEvenlyRotate', P('gimbalPitchRotateAngle', num(pitch(i + 1))) + P('gimbalRollRotateAngle', 0) + P('payloadPositionIndex', 0)));
      return `
      <Placemark>
        <Point>
          <coordinates>
            ${w.lng.toFixed(12)},${w.lat.toFixed(12)}
          </coordinates>
        </Point>
        <wpml:index>${i}</wpml:index>
        <wpml:executeHeight>${num(rel)}</wpml:executeHeight>
        <wpml:waypointSpeed>${num(w.speed > 0 ? w.speed : s.cruise)}</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>${hmode}</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>${num(ang)}</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>${poiStr(w)}</wpml:waypointPoiPoint>
          <wpml:waypointHeadingAngleEnable>${edge ? 1 : 0}</wpml:waypointHeadingAngleEnable>
          <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
          <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
        </wpml:waypointHeadingParam>
        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>${turn}</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>
        <wpml:useStraightLine>0</wpml:useStraightLine>${groups}
        <wpml:waypointGimbalHeadingParam>
          <wpml:waypointGimbalPitchAngle>0</wpml:waypointGimbalPitchAngle>
          <wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle>
        </wpml:waypointGimbalHeadingParam>
      </Placemark>`;
    }).join('');
    const waylines = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${ns}">
  <Document>${mc}
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:distance>0</wpml:distance>
      <wpml:duration>0</wpml:duration>
      <wpml:autoFlightSpeed>${cruise}</wpml:autoFlightSpeed>${marks}
    </Folder>
  </Document>
</kml>
`;
    return { template, waylines, warnings };
  }
  // structural check against the dialect DJI Fly itself writes
  function validateDjiFly(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return ['XML повреждён'];
    const bad = new Set();
    const walk = (e, p) => {
      const q = p ? p + '/' + e.localName : e.localName;
      if (!FLY_PATHS.has(q)) bad.add('лишний элемент ' + q);
      if (!e.children.length) { const allowed = FLY_ENUMS[e.localName]; const v = e.textContent.trim(); if (allowed && !allowed.includes(v)) bad.add(`недопустимое значение ${e.localName}=${v}`); if (/^-?\d/.test(v) === false && /(Angle|Height|Speed|Time|Index|Id)$/.test(e.localName) && !/Mode|Base|PoiPoint/.test(e.localName)) bad.add(`не число: ${e.localName}=${v}`); }
      [...e.children].forEach(c => walk(c, q));
    };
    walk(doc.documentElement, '');
    return [...bad];
  }
  async function djiFlyKMZ(opt = {}) {
    const iss = djiFlyIssues(opt.cap); if (iss.err.length) throw new Error(iss.err.join('; '));
    const { template, waylines, warnings } = await djiFlyXML(opt); if (warnings.length && window.toast) toast('DJI Fly: ' + warnings.join('; '), '', 9000);
    const v = validateDjiFly(template).concat(validateDjiFly(waylines));
    if (v.length) throw new Error('Файл не соответствует формату DJI Fly: ' + v.slice(0, 4).join('; '));
    const z = new JSZip();
    z.file('wpmz/template.kml', template, { createFolders: false });
    z.file('wpmz/waylines.wpml', waylines, { createFolders: false });
    return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }

  async function wpmlKMZ(target) {
    const W = S.m.waypoints, s = S.m.settings, d = Core.drone();
    if (W.length < 2) throw new Error('Нужно минимум 2 точки');
    if (s.altMode === 'agl') await Core.Elev.ensure(W.concat([Core.homePt()]));
    const ns = 'http://www.dji.com/wpmz/1.0.6';
    const finish = { none: 'noAction', rth: 'goHome', land: 'autoLand', first: 'gotoFirstWaypoint', reverse: 'noAction' }[s.finishAction];
    const droneInfo = target === 'fly' ? [68, 0] : d.name.startsWith('Matrice 4') ? [99, 0] : [77, 0];
    const payload = target === 'pilot' ? (d.name.startsWith('Matrice 4') ? 88 : 66) : null;
    const headingModeOf = (m = s.headingMode) => ({ auto: 'followWayline', initial: 'fixed', custom: 'smoothTransition', poi: 'towardPOI', manual: 'manually' })[m];
    let actionId = 0, groupId = 0;
    const act = (func, params) => `
          <wpml:action>
            <wpml:actionId>${actionId++}</wpml:actionId>
            <wpml:actionActuatorFunc>${func}</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>${params}
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
    const P0 = '\n              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>';
    const gimbalRotate = pitch => act('gimbalRotate', `
              <wpml:gimbalHeadingYawBase>north</wpml:gimbalHeadingYawBase>
              <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
              <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
              <wpml:gimbalPitchRotateAngle>${f(Math.max(d.gMin, Math.min(d.gMax, pitch)), 1)}</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>
              <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
              <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>
              <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>
              <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
              <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>${P0}`);
    const actionXML = (a, heading) => {
      switch (a.type) {
        case 0: return act('hover', `\n              <wpml:hoverTime>${f((a.param || 0) / 1000, 1)}</wpml:hoverTime>`);
        case 1: return act('takePhoto', P0 + '\n              <wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>');
        case 2: return act('startRecord', P0 + '\n              <wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>');
        case 3: return act('stopRecord', P0);
        case 4: { const tgt = Geo.norm180(a.param || 0); const dir = Geo.norm180(tgt - (heading || 0)) >= 0 ? 'clockwise' : 'counterClockwise';
          return act('rotateYaw', `\n              <wpml:aircraftHeading>${f(tgt, 1)}</wpml:aircraftHeading>\n              <wpml:aircraftPathMode>${dir}</wpml:aircraftPathMode>`); }
        case 5: return gimbalRotate(a.param || 0);
      }
      return '';
    };
    const group = (start, end, trigger, triggerParam, body) => `
        <wpml:actionGroup>
          <wpml:actionGroupId>${groupId++}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${start}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${end}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>${trigger}</wpml:actionTriggerType>${triggerParam != null ? `\n            <wpml:actionTriggerParam>${triggerParam}</wpml:actionTriggerParam>` : ''}
          </wpml:actionTrigger>${body}
        </wpml:actionGroup>`;

    const st = Core.stats();
    let placemarks = '';
    W.forEach((w, i) => {
      const h = Core.effHeading(i);
      const poi = Core.poiById(w.poi) || S.m.pois[0];
      const hmI = w.hm || s.headingMode; // a point may override the mission heading mode
      const towardPoi = hmI === 'poi' && poi;
      const turnMode = (i === 0 || i === W.length - 1 || s.pathMode !== 'curved' || w.actions.length || !(w.curve > 0))
        ? 'toPointAndStopWithDiscontinuityCurvature' : 'coordinateTurn';
      const damp = turnMode === 'coordinateTurn' ? Math.max(0.2, Core.curveMeters(i)) : 0;
      const v = Math.min(w.speed > 0 ? w.speed : s.cruise, 15);
      let groups = '';
      // gimbal & actions on arrival
      let body = '';
      const gp = Core.effGimbal(i);
      if (gp != null && (s.gimbalMode === 'poi' || i === 0 || s.gimbalMode === 'interpolate')) {
        if (!(s.gimbalMode === 'interpolate' && i > 0)) body += gimbalRotate(gp);
      }
      w.actions.forEach(a => { body += actionXML(a, h); });
      if (body) groups += group(i, i, 'reachPoint', null, body);
      // smooth gimbal transition to next waypoint
      if (i < W.length - 1 && s.gimbalMode !== 'disabled') {
        const ng = Core.effGimbal(i + 1);
        if (ng != null && (gp == null || Math.abs(ng - gp) > 0.5)) groups += group(i, i + 1, 'betweenAdjacentPoints', null, act('gimbalEvenlyRotate', `\n              <wpml:gimbalPitchRotateAngle>${f(Math.max(d.gMin, Math.min(d.gMax, ng)), 1)}</wpml:gimbalPitchRotateAngle>${P0}`));
      }
      // interval photos on the following segment
      if (i < W.length - 1 && (w.photoDist > 0 || w.photoTime > 0)) {
        groups += group(i, i + 1, w.photoDist > 0 ? 'multipleDistance' : 'multipleTiming', f(w.photoDist > 0 ? w.photoDist : w.photoTime, 1),
          act('takePhoto', P0 + '\n              <wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>'));
      }
      const height = f(Core.wpRel(w), 1);
      placemarks += `
      <Placemark>
        <Point>
          <coordinates>${f(w.lng, 8)},${f(w.lat, 8)}</coordinates>
        </Point>
        <wpml:index>${i}</wpml:index>
        <wpml:executeHeight>${height}</wpml:executeHeight>
        <wpml:waypointSpeed>${f(v, 1)}</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>${towardPoi ? 'towardPOI' : headingModeOf(hmI)}</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>${f(Geo.norm180(h ?? 0), 1)}</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>${towardPoi ? `${f(poi.lat, 8)},${f(poi.lng, 8)},${f(poi.alt || 0, 1)}` : '0.000000,0.000000,0.000000'}</wpml:waypointPoiPoint>
          <wpml:waypointHeadingAngleEnable>${hmI === 'custom' || hmI === 'initial' ? 1 : 0}</wpml:waypointHeadingAngleEnable>
          <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
          <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
        </wpml:waypointHeadingParam>
        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>${turnMode}</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>${f(damp, 1)}</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>
        <wpml:useStraightLine>1</wpml:useStraightLine>${groups}
        <wpml:waypointGimbalHeadingParam>
          <wpml:waypointGimbalPitchAngle>0</wpml:waypointGimbalPitchAngle>
          <wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle>
        </wpml:waypointGimbalHeadingParam>
      </Placemark>`;
    });
    const home = Core.homePt();
    const now = Date.now();
    const missionConfig = `
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>${finish}</wpml:finishAction>
      <wpml:exitOnRCLost>${s.rcLost === 'continue' ? 'goContinue' : 'executeLostAction'}</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>20</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${f(Math.min(s.cruise, 15), 1)}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${droneInfo[0]}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${droneInfo[1]}</wpml:droneSubEnumValue>
      </wpml:droneInfo>${payload ? `
      <wpml:payloadInfo>
        <wpml:payloadEnumValue>${payload}</wpml:payloadEnumValue>
        <wpml:payloadSubEnumValue>0</wpml:payloadSubEnumValue>
        <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
      </wpml:payloadInfo>` : ''}
    </wpml:missionConfig>`;
    const template = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${ns}">
  <Document>
    <wpml:author>Waypoint Studio</wpml:author>
    <wpml:createTime>${now}</wpml:createTime>
    <wpml:updateTime>${now}</wpml:updateTime>${missionConfig}
    <Folder>
      <wpml:templateType>waypoint</wpml:templateType>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineCoordinateSysParam>
        <wpml:coordinateMode>WGS84</wpml:coordinateMode>
        <wpml:heightMode>relativeToStartPoint</wpml:heightMode>
      </wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>${f(Math.min(s.cruise, 15), 1)}</wpml:autoFlightSpeed>
      <wpml:globalHeight>${f(Core.wpRel(W[0]), 1)}</wpml:globalHeight>
      <wpml:caliFlightEnable>0</wpml:caliFlightEnable>
      <wpml:gimbalPitchMode>${s.gimbalMode === 'interpolate' ? 'usePointSetting' : 'manual'}</wpml:gimbalPitchMode>
      <wpml:globalWaypointHeadingParam>
        <wpml:waypointHeadingMode>${headingModeOf()}</wpml:waypointHeadingMode>
        <wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle>
        <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
        <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
        <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
      </wpml:globalWaypointHeadingParam>
      <wpml:globalWaypointTurnMode>${s.pathMode === 'curved' ? 'coordinateTurn' : 'toPointAndStopWithDiscontinuityCurvature'}</wpml:globalWaypointTurnMode>
      <wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>${placemarks.replace(/<wpml:executeHeight>([^<]*)<\/wpml:executeHeight>/g, '<wpml:height>$1</wpml:height>\n        <wpml:ellipsoidHeight>$1</wpml:ellipsoidHeight>\n        <wpml:useGlobalHeight>0</wpml:useGlobalHeight>\n        <wpml:useGlobalSpeed>0</wpml:useGlobalSpeed>\n        <wpml:useGlobalHeadingParam>0</wpml:useGlobalHeadingParam>\n        <wpml:useGlobalTurnParam>0</wpml:useGlobalTurnParam>')}
    </Folder>
  </Document>
</kml>`;
    const waylines = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${ns}">
  <Document>${missionConfig}
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:distance>${Math.round(st.dist)}</wpml:distance>
      <wpml:duration>${Math.round(st.time)}</wpml:duration>
      <wpml:autoFlightSpeed>${f(Math.min(s.cruise, 15), 1)}</wpml:autoFlightSpeed>${placemarks}
    </Folder>
  </Document>
</kml>`;
    const zip = new JSZip();
    zip.folder('wpmz').file('template.kml', template);
    zip.folder('wpmz').file('waylines.wpml', waylines);
    if (home && S.m.home) zip.folder('wpmz').folder('res');
    return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.google-earth.kmz' });
  }

  function parseWPML(xml, tplXml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const tdoc = tplXml ? new DOMParser().parseFromString(tplXml, 'application/xml') : null; // template.kml (mission-wide settings)
    const m = Core.newMission(); m.waypoints = [];
    const kids = (el, n) => [...el.children].filter(c => c.localName === n);
    const tag = (el, n) => { const x = el.getElementsByTagName('wpml:' + n)[0] || el.getElementsByTagNameNS('*', n)[0]; return x ? x.textContent.trim() : null; };
    const num = (el, n) => { const v = tag(el, n); return v == null ? NaN : parseFloat(v); };
    const marks = [...doc.getElementsByTagName('Placemark')].filter(pm => pm.getElementsByTagName('coordinates')[0]);
    const cruise = num(doc, 'autoFlightSpeed'); if (cruise > 0) m.settings.cruise = cruise;
    const evenly = {}, zoomSeg = {}, zoomAt = {}; let anyGimbal = false, firstHeadingMode = null, poiKey = {};
    marks.forEach((pm, i) => {
      const [lng, lat] = pm.getElementsByTagName('coordinates')[0].textContent.trim().split(',').map(Number);
      const h = parseFloat(tag(pm, 'executeHeight') ?? tag(pm, 'height') ?? '50');
      const w = Core.newWaypoint({ lat, lng, alt: h }, m);
      const sp = num(pm, 'waypointSpeed'); if (sp > 0 && !(cruise > 0 && Math.abs(sp - cruise) < 1e-6)) w.speed = sp;
      const hp = pm.getElementsByTagNameNS('*', 'waypointHeadingParam')[0];
      if (hp) {
        const mode = tag(hp, 'waypointHeadingMode'); if (i === 0) firstHeadingMode = mode; w._hm = mode;
        const ang = num(hp, 'waypointHeadingAngle'); if (!isNaN(ang)) w.heading = Geo.norm360(ang);
        const pp = (tag(hp, 'waypointPoiPoint') || '').split(',').map(Number);
        if (mode === 'towardPOI' && pp.length >= 2 && (pp[0] || pp[1])) {
          const k = pp[0].toFixed(6) + ',' + pp[1].toFixed(6);
          if (!poiKey[k]) { const p = { id: Core.id(), lat: pp[0], lng: pp[1], alt: pp[2] || 0, altRel: true, name: 'POI ' + (m.pois.length + 1) }; m.pois.push(p); poiKey[k] = p.id; } // altRel: height relative to take-off, as DJI Fly stores it
          w.poi = poiKey[k];
        }
      } else { const hd = num(pm, 'waypointHeadingAngle'); if (!isNaN(hd)) w.heading = hd; }
      const tm = tag(pm, 'waypointTurnMode'); w._stop = !!(tm && tm.includes('Stop'));
      [...pm.getElementsByTagNameNS('*', 'actionGroup')].forEach(g => {
        const start = parseInt(tag(g, 'actionGroupStartIndex')), end = parseInt(tag(g, 'actionGroupEndIndex'));
        const reach = tag(g, 'actionTriggerType') === 'reachPoint';
        [...g.getElementsByTagNameNS('*', 'action')].forEach((a, ai) => {
          const fn = tag(a, 'actionActuatorFunc');
          if (fn === 'takePhoto') w.actions.push({ type: 1, param: 0 });
          else if (fn === 'startRecord') w.actions.push({ type: 2, param: 0 });
          else if (fn === 'stopRecord') w.actions.push({ type: 3, param: 0 });
          else if (fn === 'hover') w.actions.push({ type: 0, param: parseFloat(tag(a, 'hoverTime')) * 1000 });
          else if (fn === 'rotateYaw') w.actions.push({ type: 4, param: parseFloat(tag(a, 'aircraftHeading')) });
          else if (fn === 'gimbalEvenlyRotate') { anyGimbal = true; evenly[(isNaN(end) ? i + 1 : end)] = parseFloat(tag(a, 'gimbalPitchRotateAngle')); }
          else if (fn === 'gimbalRotate') {
            // the FIRST camera turn on arrival may be the point's own camera tilt (written first by step / POI modes and
            // at point 1); any further ones are «Наклон камеры» actions. Decided below, when the whole file is known.
            anyGimbal = true; const g2 = parseFloat(tag(a, 'gimbalPitchRotateAngle'));
            if (reach && ai === 0 && w._lead === undefined) { w._lead = g2; w._leadAt = w.actions.length; } else w.actions.push({ type: 5, param: g2 });
          }
          else if (fn === 'zoom') { const zf = parseFloat(tag(a, 'focalFactor')) || 1; if (tag(g, 'actionTriggerType') === 'betweenAdjacentPoints') zoomSeg[isNaN(end) ? i + 1 : end] = zf; else zoomAt[i] = zf; }
        });
      });
      m.waypoints.push(w);
    });
    // «smooth» files (usePointSetting) turn the camera at point 1 only; «follow POI» files turn it first thing at every
    // point; anything else at a point is a «Наклон камеры» action
    const pointPitch = (tag(doc, 'gimbalPitchMode') || (tdoc && tag(tdoc, 'gimbalPitchMode'))) === 'usePointSetting' || Object.keys(evenly).length > 0;
    // DJI Fly files (uav.com namespace) turn the camera only at point 1; a turn at any other point is an action
    const flyFile = /uav\.com\/wpmz/.test(xml.slice(0, 600));
    const leadAll = !flyFile && m.waypoints.length > 1 && m.waypoints.every(w => w._lead !== undefined);
    m.waypoints.forEach((w, i) => { if (w._lead === undefined) return;
      if (pointPitch || flyFile ? i === 0 : leadAll) w.gimbal = w._lead; else w.actions.splice(w._leadAt, 0, { type: 5, param: w._lead });
      delete w._lead; delete w._leadAt; });
    let rot0 = false; marks.length && [...marks[0].getElementsByTagNameNS('*', 'action')].forEach(a => { if (tag(a, 'actionActuatorFunc') === 'gimbalRotate') rot0 = true; });
    m.waypoints.forEach((w, i) => {
      if (evenly[i] !== undefined) w.gimbal = evenly[i];
      else if (anyGimbal && (i > 0 || !rot0)) { w.gkeep = true; w.gimbal = i > 0 ? m.waypoints[i - 1].gimbal : (evenly[1] ?? w.gimbal); } // DJI Fly: camera not changed at this point
    });
    const W = m.waypoints;
    const middle = W.slice(1, -1);
    m.settings.pathMode = middle.length && middle.every(w => w._stop) ? 'straight' : (W.length === 2 && W.every(w => w._stop) ? 'curved' : 'curved');
    W.forEach(w => delete w._stop);
    const ms = tag(doc, 'globalWaypointTurnMode'); if (ms) m.settings.pathMode = ms.includes('Stop') ? 'straight' : 'curved';
    if (Object.keys(zoomSeg).length || Object.keys(zoomAt).length) W.forEach((w, i) => { const z = i === 0 ? zoomAt[0] : zoomSeg[i]; if (z) w.zoom = z; }); // DJI Fly camera zoom (focal factor)
    const HMR = { followWayline: 'auto', towardPOI: 'poi', smoothTransition: 'custom', manually: 'manual', fixed: 'initial' };
    m.settings.headingMode = HMR[firstHeadingMode] || 'custom';
    if (m.settings.headingMode === 'poi' && !m.pois.length) m.settings.headingMode = 'custom';
    W.forEach(w => { const md = HMR[w._hm]; if (md && md !== m.settings.headingMode) w.hm = md; delete w._hm; }); // per-point heading mode
    m.settings.gimbalMode = anyGimbal ? 'interpolate' : (marks.length && doc.getElementsByTagNameNS('*', 'waypointHeadingParam').length ? 'disabled' : m.settings.gimbalMode);
    const fin = tag(doc, 'finishAction'); if (fin) m.settings.finishAction = { goHome: 'rth', noAction: 'none', autoLand: 'land', gotoFirstWaypoint: 'first' }[fin] || m.settings.finishAction;
    const lost = tag(doc, 'exitOnRCLost'); if (lost) m.settings.rcLost = lost === 'goContinue' ? 'continue' : 'rth';
    m.settings.altMode = 'takeoff';
    return m;
  }

  // ---------------- KML for Google Earth ----------------
  async function kml() {
    const W = S.m.waypoints, h = Core.homePt();
    let am = 'absolute';
    try { await Core.Elev.ensure(W.concat(h ? [h] : [], S.m.pois)); } catch (e) { am = 'relativeToGround'; toast('Рельеф недоступен — высоты в KML заданы над землёй'); }
    const g = Core.pathGeometry();
    const gh = am === 'absolute' ? (Core.groundAt(h) ?? 0) : 0;
    const coords = g.map(p => `${f(p.lng, 7)},${f(p.lat, 7)},${f(gh + p.alt, 1)}`).join(' ');
    const wps = W.map((w, i) => `
    <Placemark><name>${i + 1}</name><description>Высота ${f(w.alt, 1)} м (${S.m.settings.altMode === 'agl' ? 'над рельефом' : 'от взлёта'})</description><styleUrl>#wp</styleUrl>
      <Point><extrude>1</extrude><altitudeMode>${am}</altitudeMode><coordinates>${f(w.lng, 7)},${f(w.lat, 7)},${f(am === 'absolute' ? (Core.wpASL(w) ?? w.alt) : (Core.wpAGL(w) ?? w.alt), 1)}</coordinates></Point></Placemark>`).join('');
    const pois = S.m.pois.map(p => `
    <Placemark><name>${esc(p.name)}</name><styleUrl>#poi</styleUrl><Point><altitudeMode>relativeToGround</altitudeMode><coordinates>${f(p.lng, 7)},${f(p.lat, 7)},${f(p.alt || 0, 1)}</coordinates></Point></Placemark>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <name>${esc(S.m.name)}</name>
  <Style id="path"><LineStyle><color>ff00d4ff</color><width>4</width></LineStyle><PolyStyle><color>4000d4ff</color></PolyStyle></Style>
  <Style id="wp"><IconStyle><scale>0.8</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon></IconStyle></Style>
  <Style id="poi"><IconStyle><color>ff0080ff</color><Icon><href>http://maps.google.com/mapfiles/kml/shapes/target.png</href></Icon></IconStyle></Style>
  <ExtendedData><Data name="wsmission"><value><![CDATA[${JSON.stringify(S.m).replace(/]]>/g, "]]]]><![CDATA[>")}]]></value></Data></ExtendedData>
  <Placemark><name>Траектория</name><styleUrl>#path</styleUrl>
    <LineString><extrude>1</extrude><tessellate>0</tessellate><altitudeMode>${am}</altitudeMode><coordinates>${coords}</coordinates></LineString></Placemark>
  ${h ? `<Placemark><name>Взлёт</name><Point><altitudeMode>clampToGround</altitudeMode><coordinates>${f(h.lng, 7)},${f(h.lat, 7)},0</coordinates></Point></Placemark>` : ''}
  <Folder><name>Точки</name>${wps}</Folder>
  <Folder><name>POI</name>${pois}</Folder>
  ${tourKML(g, gh, am)}
</Document></kml>`;
  }
  // gx:Tour – virtual flight preview in Google Earth Pro
  function tourKML(g, gh, am) {
    if (g.length < 2) return '';
    const s = S.m.settings; let out = '';
    const step = Math.max(1, Math.floor(g.length / 400));
    for (let k = 0; k < g.length; k += step) {
      const p = g[k], n = g[Math.min(g.length - 1, k + step)];
      const dt = Math.max(0.2, Geo.dist(p, n) / s.cruise);
      const head = Geo.dist(p, n) > 0.5 ? Geo.bearing(p, n) : 0;
      const wi = Math.min(S.m.waypoints.length - 1, p.i);
      const hd = s.headingMode === 'auto' || s.headingMode === 'manual' ? head : (Core.effHeading(wi) ?? head);
      const tilt = 90 + (Core.effGimbal(wi) ?? -20);
      out += `<gx:FlyTo><gx:duration>${f(dt, 2)}</gx:duration><gx:flyToMode>smooth</gx:flyToMode><Camera><longitude>${f(p.lng, 7)}</longitude><latitude>${f(p.lat, 7)}</latitude><altitude>${f(gh + p.alt, 1)}</altitude><heading>${f(hd, 1)}</heading><tilt>${f(Math.max(0, Math.min(90, tilt)), 1)}</tilt><altitudeMode>${am}</altitudeMode></Camera></gx:FlyTo>`;
    }
    return `<gx:Tour><name>▶ Виртуальный полёт</name><gx:Playlist>${out}</gx:Playlist></gx:Tour>`;
  }

  // ---------------- GPX / GeoJSON ----------------
  async function gpx() {
    const W = S.m.waypoints; try { await Core.Elev.ensure(W.concat(Core.homePt() ? [Core.homePt()] : [])); } catch (e) { /* ele falls back to flight altitude */ }
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Waypoint Studio" xmlns="http://www.topografix.com/GPX/1/1">
  <rte><name>${esc(S.m.name)}</name>${W.map((w, i) => `
    <rtept lat="${f(w.lat, 8)}" lon="${f(w.lng, 8)}"><ele>${f(Core.wpASL(w) ?? w.alt, 1)}</ele><name>WP${i + 1}</name></rtept>`).join('')}
  </rte>${S.m.pois.map(p => `
  <wpt lat="${f(p.lat, 8)}" lon="${f(p.lng, 8)}"><name>${esc(p.name)}</name></wpt>`).join('')}
</gpx>`;
  }
  function geojson() {
    const W = S.m.waypoints;
    const fc = { type: 'FeatureCollection', features: [] };
    if (W.length > 1) fc.features.push({ type: 'Feature', properties: { name: S.m.name, kind: 'path' }, geometry: { type: 'LineString', coordinates: W.map(w => [w.lng, w.lat, w.alt]) } });
    W.forEach((w, i) => fc.features.push({ type: 'Feature', properties: { kind: 'waypoint', index: i + 1, alt: w.alt, speed: w.speed, gimbal: w.gimbal, actions: w.actions }, geometry: { type: 'Point', coordinates: [w.lng, w.lat, w.alt] } }));
    S.m.pois.forEach(p => fc.features.push({ type: 'Feature', properties: { kind: 'poi', name: p.name, alt: p.alt }, geometry: { type: 'Point', coordinates: [p.lng, p.lat, p.alt] } }));
    if (S.m.area.length > 2) fc.features.push({ type: 'Feature', properties: { kind: 'area' }, geometry: { type: 'Polygon', coordinates: [S.m.area.concat([S.m.area[0]]).map(p => [p.lng, p.lat])] } });
    return JSON.stringify(fc, null, 1);
  }

  // ---------------- generic geometry import (KML / GeoJSON / GPX) ----------------
  function simplify(pts, maxN) {
    if (pts.length <= maxN) return pts;
    const o = pts[0], xy = pts.map(p => Geo.toXY(o, p));
    let tol = 0.5, keep;
    const dp = (a, b, out) => {
      let md = 0, mi = -1; const A = xy[a], B = xy[b], L = Math.hypot(B.x - A.x, B.y - A.y) || 1e-9;
      for (let i = a + 1; i < b; i++) { const d = Math.abs((B.x - A.x) * (A.y - xy[i].y) - (A.x - xy[i].x) * (B.y - A.y)) / L; if (d > md) { md = d; mi = i; } }
      if (md > tol) { dp(a, mi, out); out.push(mi); dp(mi, b, out); }
    };
    do { keep = [0]; dp(0, pts.length - 1, keep); keep.push(pts.length - 1); tol *= 1.6; } while (keep.length > maxN && tol < 1e5);
    return keep.sort((a, b) => a - b).map(i => pts[i]);
  }
  function fromGeometry(lines, polys, points, name) {
    const m = Core.newMission(name || 'Импорт');
    m.waypoints = []; m.pois = [];
    const line = lines.sort((a, b) => b.length - a.length)[0];
    if (line) {
      simplify(line, 99).forEach(p => m.waypoints.push(Core.newWaypoint({ lat: p.lat, lng: p.lng, alt: p.alt > 0 && p.alt < 500 ? p.alt : undefined }, m)));
      points.forEach((p, i) => m.pois.push({ id: Core.id(), lat: p.lat, lng: p.lng, alt: 0, name: p.name || 'POI ' + (i + 1) }));
    } else if (points.length) points.forEach(p => m.waypoints.push(Core.newWaypoint({ lat: p.lat, lng: p.lng }, m)));
    if (polys.length) m.area = polys[0].slice(0, 200);
    return m;
  }
  function parseKML(text, name) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagNameNS('*', 'missionConfig').length) return parseWPML(text);
    // KML exported by Waypoint Studio carries the full mission → exact round trip
    const own = [...doc.getElementsByTagName('Data')].find(d => d.getAttribute('name') === 'wsmission');
    if (own) { try { const m = JSON.parse(own.textContent.trim()); if (m && m.waypoints) return m; } catch (e) { /* fall back to geometry */ } }
    const coords = el => el.textContent.trim().split(/\s+/).map(c => { const [lng, lat, alt] = c.split(',').map(Number); return { lat, lng, alt }; }).filter(p => !isNaN(p.lat));
    const lines = [...doc.getElementsByTagName('LineString')].map(l => coords(l.getElementsByTagName('coordinates')[0]));
    [...doc.getElementsByTagNameNS('*', 'Track')].forEach(t => lines.push([...t.getElementsByTagNameNS('*', 'coord')].map(c => { const [lng, lat, alt] = c.textContent.trim().split(/\s+/).map(Number); return { lat, lng, alt }; })));
    const polys = [...doc.getElementsByTagName('Polygon')].map(p => { const r = coords(p.getElementsByTagName('coordinates')[0]); if (r.length > 1 && r[0].lat === r[r.length - 1].lat && r[0].lng === r[r.length - 1].lng) r.pop(); return r; });
    const points = [...doc.getElementsByTagName('Placemark')].filter(pm => pm.getElementsByTagName('Point').length).map(pm => { const p = coords(pm.getElementsByTagName('coordinates')[0])[0]; p.name = (pm.getElementsByTagName('name')[0] || {}).textContent; return p; });
    return fromGeometry(lines, polys, points, name);
  }
  function parseGeoJSON(text, name) {
    const j = JSON.parse(text);
    if (j.v && j.waypoints) return j; // our own format
    const lines = [], polys = [], points = [];
    const visit = g => {
      if (!g) return;
      const P = c => ({ lng: c[0], lat: c[1], alt: c[2] });
      if (g.type === 'FeatureCollection') g.features.forEach(visit);
      else if (g.type === 'Feature') { const gm = g.geometry; if (gm && gm.type === 'Point') points.push(Object.assign(P(gm.coordinates), { name: (g.properties || {}).name })); else visit(gm); }
      else if (g.type === 'LineString') lines.push(g.coordinates.map(P));
      else if (g.type === 'MultiLineString') g.coordinates.forEach(c => lines.push(c.map(P)));
      else if (g.type === 'Polygon') { const r = g.coordinates[0].map(P); r.pop(); polys.push(r); }
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(c => { const r = c[0].map(P); r.pop(); polys.push(r); });
      else if (g.type === 'Point') points.push(P(g.coordinates));
      else if (g.type === 'GeometryCollection') g.geometries.forEach(visit);
    };
    visit(j);
    return fromGeometry(lines, polys, points, name);
  }
  function parseGPX(text, name) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const pt = el => ({ lat: +el.getAttribute('lat'), lng: +el.getAttribute('lon'), alt: el.getElementsByTagName('ele')[0] ? +el.getElementsByTagName('ele')[0].textContent : undefined, name: (el.getElementsByTagName('name')[0] || {}).textContent });
    const lines = [...doc.getElementsByTagName('rte')].map(r => [...r.getElementsByTagName('rtept')].map(pt));
    [...doc.getElementsByTagName('trkseg')].forEach(s => lines.push([...s.getElementsByTagName('trkpt')].map(pt)));
    const points = [...doc.getElementsByTagName('wpt')].map(pt);
    // GPX elevations are ASL – drop them; user sets flight altitude
    lines.forEach(l => l.forEach(p => p.alt = undefined));
    return fromGeometry(lines.filter(l => l.length), [], points, name);
  }

  async function importFile(file) {
    const name = file.name.replace(/\.[^.]+$/, '');
    const ext = file.name.split('.').pop().toLowerCase();
    let m;
    if (ext === 'kmz') {
      const zip = await JSZip.loadAsync(file);
      const wpml = Object.keys(zip.files).find(k => k.endsWith('waylines.wpml')) || Object.keys(zip.files).find(k => k.endsWith('template.kml'));
      const kmlF = wpml || Object.keys(zip.files).find(k => k.toLowerCase().endsWith('.kml'));
      if (!kmlF) throw new Error('В KMZ нет KML');
      const t = await zip.file(kmlF).async('string');
      const tplF = Object.keys(zip.files).find(k => k.endsWith('template.kml'));
      m = wpml ? parseWPML(t, tplF && tplF !== kmlF ? await zip.file(tplF).async('string') : null) : parseKML(t, name);
    } else {
      const text = await file.text();
      if (ext === 'csv') m = parseCSV(text);
      else if (ext === 'kml') m = parseKML(text, name);
      else if (ext === 'wpml') m = parseWPML(text);
      else if (ext === 'gpx') m = parseGPX(text, name);
      else if (ext === 'json' || ext === 'geojson') m = parseGeoJSON(text, name);
      else throw new Error('Неизвестный формат: .' + ext);
    }
    if (!m.name || m.name === 'Новый маршрут' || m.name === 'New route' || m.name === 'Импорт') m.name = name;
    return m;
  }

  // Split mission into parts that each fit one battery (≈75 % of rated flight time incl. transit from/to home)
  function splitByBattery() {
    const W = S.m.waypoints, s = S.m.settings, d = Core.drone(), h = Core.homePt();
    const budget = d.flight * 60 * 0.75 - 60;
    const st = Core.stats();
    const transit = w => h ? 2 * Core.segTime(Geo.dist(h, w), 0, Math.min(12, d.maxSpeed), true, true) + Core.wpRel(w) / 5 + Core.wpRel(w) / 3.5 : 0;
    const parts = []; let start = 0, t = 0;
    const act = i => W[i].actions.reduce((a, x) => a + Core.actionTime(x, 0), 0);
    for (let i = 0; i < W.length - 1; i++) {
      const seg = st.segs[i] ? st.segs[i].t : 0;
      const need = t + seg + act(i + 1) + Math.max(transit(W[start]), transit(W[i + 1]));
      if (need > budget && i > start) { parts.push([start, i]); start = i; t = act(i); }
      t += seg + act(i + 1);
    }
    parts.push([start, W.length - 1]);
    return parts;
  }
  // a battery part ends with «Return home» (the battery is changed at the take-off point); the last part keeps the
  // mission's own finish action, except «fly back», which makes no sense for one part of the route
  async function withPartFinish(k, N, fn) {
    const st = S.m.settings, keep = st.finishAction;
    st.finishAction = k < N - 1 || keep === 'reverse' ? 'rth' : keep;
    try { return await fn(); } finally { st.finishAction = keep; }
  }
  async function exportSplit(target) {
    const parts = splitByBattery();
    if (parts.length === 1) { toast('Маршрут помещается в одну батарею — разбивать не нужно'); return download(safeName() + '.kmz', target === 'fly' ? new Blob([await djiFlyKMZ()]) : await wpmlKMZ(target)); }
    const all = S.m.waypoints;
    try {
      for (let k = 0; k < parts.length; k++) {
        const [a, b] = parts[k];
        S.m.waypoints = all.slice(a, b + 1);
        const blob = await withPartFinish(k, parts.length, async () => target === 'fly' ? new Blob([await djiFlyKMZ()]) : await wpmlKMZ(target));
        download(`${safeName()}_Part${k + 1}of${parts.length}.kmz`, blob);
        await new Promise(r => setTimeout(r, 600));
      }
    } finally { S.m.waypoints = all; }
    toast(`Маршрут разбит на ${parts.length} частей (по одной на батарею)`, 'ok', 6000);
  }

  async function exportAs(kind) {
    const n = safeName();
    switch (kind) {
      case 'fly-split': return exportSplit('fly');
      case 'csv': return download(n + '.csv', litchiCSV(), 'text/csv');
      case 'fly': { const iss = djiFlyIssues(); if (iss.warn.length) toast('DJI Fly: ' + iss.warn.join('; '), '', 9000); return download(n + '.kmz', new Blob([await djiFlyKMZ()], { type: 'application/vnd.google-earth.kmz' })); }
      case 'pilot': return download(n + '_pilot2.kmz', await wpmlKMZ('pilot'));
      case 'kml': return download(n + '.kml', await kml(), 'application/vnd.google-earth.kml+xml');
      case 'gpx': return download(n + '.gpx', await gpx(), 'application/gpx+xml');
      case 'geojson': return download(n + '.geojson', geojson(), 'application/geo+json');
      case 'json': return download(n + '.wsmission.json', JSON.stringify(S.m, null, 1), 'application/json');
    }
  }
  // ---- optional: the early / late turn to a POI also in the REAL flight (setting «Доворот на POI в полёте») ----
  // DJI turns the drone at a waypoint. To start turning before a «look at POI» point (and to keep the POI a bit after
  // leaving it) helper waypoints are added in the exported mission: one ~«Плавный доворот» seconds before such a point
  // already aimed at the POI, and one shortly after the last «POI» point that still keeps the old POI.
  // «Плавные повороты в полёте»: DJI turns the drone right AT a waypoint. To make the real flight turn the way the
  // simulation does (start BEFORE a point with a new course, swing away from a POI AFTER the point), helper points
  // are added to the exported list. A smooth turn in DJI = a stretch from a point with «smoothTransition» (angle A)
  // to the next point (angle B), so every turn becomes such a short stretch:
  //  • arrival at a point with another course (its own course, a POI, «как в начале»…) after a stretch «по курсу» /
  //    «как в начале»: helper BEFORE the point with the old course → the drone turns over the last seconds;
  //  • leaving a POI: the point itself gets «smoothTransition» with the angle at the POI (no jump on arrival) and a
  //    helper AFTER it carries the point's own mode → the drone swings away over the first seconds.
  // After a «smoothTransition» point the course already changes smoothly — nothing is added there.
  function poiPrePlan() {
    const s = S.m.settings, W = S.m.waypoints, tau = Math.max(1, s.poiBlend ?? 3);
    const modeOf = w => w.hm || s.headingMode;
    const aim = w => modeOf(w) === 'poi' ? (Core.poiById(w.poi) || S.m.pois[0] || null) : null;
    const out = [], added = [];
    const mk = (a, b, d, from) => { const L = Geo.dist(a, b), f = d / L, p = Geo.interp(a, b, f); return Object.assign(JSON.parse(JSON.stringify(from)), { id: Core.id() + Core.id(), lat: p.lat, lng: p.lng, alt: Math.round((a.alt + (b.alt - a.alt) * f) * 10) / 10, gimbal: Math.round(((a.gimbal ?? -20) + ((b.gimbal ?? -20) - (a.gimbal ?? -20)) * f) * 10) / 10, actions: [], photoTime: 0, photoDist: 0, curve: 0, ws_helper: true }); };
    const vOf = w => w.speed > 0 ? w.speed : s.cruise;
    const r1 = x => Math.round(Geo.norm360(x) * 10) / 10;
    // signed turn from course a to course b the way the simulation does it: through the drone's front, never across
    // its back, measured from the direction of travel trk
    const turnBy = (a, b, trk) => Geo.norm180(b - trk) - Geo.norm180(a - trk);
    // course the drone has at the START of point i's own stretch (what it must reach on arrival)
    const startCourse = i => { const w = W[i], m = modeOf(w), a = aim(w);
      if (m === 'poi' && a) return Geo.bearing(w, a); if (m === 'auto') return i < W.length - 1 ? Geo.bearing(w, W[i + 1]) : null; return Core.effHeading(i); };
    W.forEach((w0, i) => {
      const w = JSON.parse(JSON.stringify(w0)), prev = W[i - 1], next = W[i + 1], mP = prev && modeOf(prev), aP = prev && aim(prev), aC = aim(w0);
      // leaving a POI (to another course or another POI): turn over the first seconds AFTER this point
      if (aP && next && (!aC || aC.id !== aP.id)) { const L = Geo.dist(w0, next), d = Math.min(vOf(w0) * tau, 0.45 * L);
        if (d >= 2 && L - d >= 2) {
          const h = mk(w0, next, d, w0); // the helper continues with this point's own mode
          if (modeOf(w0) === 'custom') { const h1 = Core.effHeading(i) ?? 0, h2 = Core.effHeading(i + 1) ?? h1; h.hm = 'custom'; h.heading = r1(h1 + Geo.norm180(h2 - h1) * d / L); }
          else if (modeOf(w0) === 'initial') { h.hm = 'custom'; h.heading = r1(Core.effHeading(i) ?? 0); }
          w.hm = 'custom'; w.heading = r1(Geo.bearing(w0, aP)); out.push(w);
          // DJI always turns the short way: a turn of more than 150° gets a middle point so it goes the same way as
          // in the simulation (through the side where the POI is, then through the drone's front)
          const hT = h.hm === 'custom' ? h.heading : modeOf(h) === 'poi' && aim(h) ? Geo.bearing(h, aim(h)) : Geo.bearing(h, next), dd = turnBy(w.heading, hT, Geo.bearing(prev, w0));
          // (AXIOM: through the sector bounded by the route line in which the POI lies); every step ≤ 120° so DJI can't
          // pick the other way round
          const nS = Math.ceil(Math.abs(dd) / 120);
          for (let q = 1; q < nS; q++) { const m = mk(w0, next, d * q / nS, w0); m.hm = 'custom'; m.heading = r1(w.heading + dd * q / nS); out.push(m); added.push(m); }
          out.push(h); added.push(h); return;
        } }
      // arriving with a new course after a stretch whose course does not change by itself («по курсу» / «как в начале»)
      if (prev && (mP === 'auto' || mP === 'initial') && !aP && !(mP === 'auto' && modeOf(w0) === 'auto')) {
        const L = Geo.dist(prev, w0), d = Math.min(vOf(prev) * tau, 0.45 * L), hc = startCourse(i);
        if (d >= 2 && L - d >= 2 && hc != null) {
          const h = mk(w0, prev, d, prev), old = mP === 'auto' ? Geo.bearing(h, w0) : (Core.effHeading(i - 1) ?? 0);
          if (Math.abs(Geo.norm180(hc - old)) > 2) { h.hm = 'custom'; h.heading = r1(old); out.push(h); added.push(h);
            const dd = turnBy(old, hc, Geo.bearing(prev, w0));
            const nS = Math.ceil(Math.abs(dd) / 120);
            for (let q = nS - 1; q >= 1; q--) { const m = mk(w0, prev, d * q / nS, prev); m.hm = 'custom'; m.heading = r1(old + dd * (nS - q) / nS); out.push(m); added.push(m); } }
        }
      }
      out.push(w);
    });
    return { list: out, added: added.length };
  }
  // «По завершении → Пролететь обратно»: DJI waylines have no such finish action, so the way back is written as
  // points — the route in reverse order (without actions) — and the drone hovers at the first point at the end.
  function reversePlan(W) {
    const back = W.slice(0, -1).reverse().map(w => Object.assign(JSON.parse(JSON.stringify(w)), { id: Core.id() + Core.id(), actions: [], photoTime: 0, photoDist: 0, ws_back: true }));
    return W.concat(back);
  }
  // the exact list of points written to a file / to the remote (way back + helper points for smooth turns)
  function exportList() {
    const s = S.m.settings, keepW = S.m.waypoints;
    try { if (s.finishAction === 'reverse' && keepW.length > 1) S.m.waypoints = reversePlan(keepW); return s.poiPre === 'on' ? poiPrePlan().list : S.m.waypoints.slice(); }
    finally { S.m.waypoints = keepW; }
  }
  let poiPreDepth = 0;
  async function withPoiPre(fn) {
    if (poiPreDepth) return fn();
    const s = S.m.settings, rev = s.finishAction === 'reverse' && S.m.waypoints.length > 1;
    if (s.poiPre !== 'on' && !rev) return fn();
    const keep = S.m.waypoints; poiPreDepth++;
    try { S.m.waypoints = exportList(); if (rev) s.finishAction = 'none'; return await fn(); }
    finally { S.m.waypoints = keep; if (rev) s.finishAction = 'reverse'; poiPreDepth--; }
  }
  const _djiFlyXML = djiFlyXML, _djiFlyKMZ = djiFlyKMZ, _wpmlKMZ = wpmlKMZ;
  djiFlyXML = opt => withPoiPre(() => _djiFlyXML(opt));
  djiFlyKMZ = opt => withPoiPre(() => _djiFlyKMZ(opt));
  wpmlKMZ = target => withPoiPre(() => _wpmlKMZ(target));
  return { withPartFinish, poiPrePlan, exportList, safeFile, djiFlyKMZ, djiFlyXML, djiFlyIssues, validateDjiFly, FLY_NS, splitByBattery, litchiCSV, parseCSV, wpmlKMZ, parseWPML, kml, gpx, geojson, parseKML, parseGeoJSON, parseGPX, importFile, exportAs, download, simplify };
})();
