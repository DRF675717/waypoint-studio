// DJI RC 2 manager (desktop app): two-way sync between Waypoint Studio and DJI Fly on the DJI RC 2 over USB.
//  • reads every DJI Fly mission (+ its map preview) from the remote, shows them with user-friendly names
//  • opens any mission in the editor (lossless DJI Fly dialect import) and writes it back to the same mission
//  • writes the current route over any mission; refreshes the map preview on the remote (with the route name drawn in)
// Safety: pre-flight checks, format copied from the remote, self-verification, backup of every overwritten file,
// conflict check (mission changed on the remote since it was opened), byte-for-byte read-back (bin/wsbridge), restore.
const RCBridge = (() => {
  const { S } = Core;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const fmtD = d => d >= 1000 ? (d / 1000).toFixed(1) + ' км' : Math.round(d) + ' м';
  const tip = t => `<i class="hlp" data-tip="${esc(t)}">?</i>`;
  let scan = null, sel = null, busy = false, last = null;

  const api = async (path, opt = {}) => {
    const r = await fetch(path, Object.assign({ cache: 'no-store' }, opt, { headers: Object.assign({ 'X-WS-Token': window.WS_RC_TOKEN || '' }, opt.headers || {}) }));
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.blob();
  };
  const b64ToBytes = b => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const show = html => { const box = $('#modal .box'), y = box.scrollTop; $('#modalBody').innerHTML = html; box.classList.remove('big'); box.classList.add('rc'); $('#modal').hidden = false; box.scrollTop = y; };

  // ---- read a DJI Fly mission KMZ (from the remote) ----
  async function readMission(bytes) {
    const zip = await JSZip.loadAsync(bytes);
    const fileOf = end => Object.keys(zip.files).find(k => k.endsWith(end));
    const tk = fileOf('template.kml'), wl = fileOf('waylines.wpml');
    const tpl = tk ? await zip.file(tk).async('string') : '', way = wl ? await zip.file(wl).async('string') : '';
    const pick = (t, n) => { const m = t.match(new RegExp(`<wpml:${n}>([^<]*)</wpml:${n}>`)); return m ? m[1].trim() : null; };
    const ns = ((tpl || way).match(/xmlns:wpml="([^"]+)"/) || [])[1] || null;
    const m = way ? IO.parseWPML(way, tpl) : (tpl ? IO.parseWPML(tpl) : null);
    return {
      ns, droneEnum: pick(tpl, 'droneEnumValue') ?? pick(way, 'droneEnumValue'), droneSub: pick(tpl, 'droneSubEnumValue') ?? pick(way, 'droneSubEnumValue'),
      payload: /payloadInfo/.test(tpl), created: +pick(tpl, 'createTime') || null, author: pick(tpl, 'author'),
      points: m ? m.waypoints.length : 0, first: m && m.waypoints[0] ? { lat: m.waypoints[0].lat, lng: m.waypoints[0].lng } : null, files: Object.keys(zip.files),
    };
  }

  // ---- build our KMZ in exactly the dialect DJI Fly wrote for this remote/drone ----
  // capability/*.json written by DJI Fly on the remote = real limits of the connected drone
  function capOf(sc) {
    const c = (sc && sc.capability) || {}, J = k => { try { return c[k] ? JSON.parse(c[k]) : null; } catch (e) { return null; } };
    return { speed: J('SPEEDCapability.json'), pitch: J('GIMBAL_PITCHCapability.json'), lost: J('LOST_ACTIONCapability.json') };
  }
  async function buildKmz(ref, cap) {
    const bytes = await IO.djiFlyKMZ({ ns: ref.ns || IO.FLY_NS, droneEnum: ref.droneEnum ?? '68', droneSub: ref.droneSub ?? '0', cap });
    // self-check: the file must decode back to exactly our route, in the remote's own format
    const chk = await readMission(bytes), W = IO.exportList ? IO.exportList() : S.m.waypoints; // the exported list (with helper points if «Доворот на POI в полёте» is on)
    const z = await JSZip.loadAsync(bytes), names = Object.keys(z.files);
    const back = IO.parseWPML(await z.file('wpmz/waylines.wpml').async('string'), z.file('wpmz/template.kml') ? await z.file('wpmz/template.kml').async('string') : null).waypoints;
    const problems = [];
    if (names.length !== 2 || !names.includes('wpmz/template.kml') || !names.includes('wpmz/waylines.wpml')) problems.push('состав KMZ отличается от DJI Fly');
    if (back.length !== W.length) problems.push(`в файле ${back.length} точек вместо ${W.length}`);
    back.forEach((p, i) => { const w = W[i]; if (w && (Math.abs(p.lat - w.lat) > 1e-9 || Math.abs(p.lng - w.lng) > 1e-9)) problems.push(`точка ${i + 1}: координаты не совпадают`); });
    back.forEach((p, i) => { const r = Core.wpRel(W[i]); if (r !== undefined && Math.abs(p.alt - Math.round(r * 10) / 10) > 0.051) problems.push(`точка ${i + 1}: высота не совпадает`); });
    if (ref.ns && chk.ns !== ref.ns) problems.push('формат (namespace) не совпал с пультом');
    if (ref.droneEnum != null && chk.droneEnum !== String(ref.droneEnum)) problems.push('модель дрона в файле не совпала с пультом');
    if (problems.length) throw new Error('Самопроверка файла не прошла: ' + problems.slice(0, 3).join('; '));
    return bytes;
  }

  // ---- pre-flight checks of the route itself ----
  function routeChecks() {
    const W = S.m.waypoints, d = Core.drone(), st = Core.stats(), v = Core.validate();
    const out = [];
    const add = (lvl, msg) => out.push({ lvl, msg });
    if (W.length < 2) add('err', 'В маршруте меньше 2 точек');
    if (d.apps !== 'fly') add('err', `${d.name}: путевые точки в DJI Fly для этого дрона не поддерживаются (выберите дрон слева, вкладка «Миссия»)`);
    else add('ok', `Дрон: ${d.name} — путевые точки DJI Fly поддерживаются`);
    v.filter(x => x.lvl === 'err').forEach(x => out.push({ lvl: 'err', msg: x.msg, battery: !!x.battery }));
    const warns = v.filter(x => x.lvl === 'warn'); if (warns.length) add('warn', `Замечаний проверки: ${warns.length} (вкладка «Проверка»)`);
    const fi = IO.djiFlyIssues(capOf(scan)); fi.err.filter(m => !(W.length < 2 && /2 точк/.test(m))).forEach(m => add('err', 'DJI Fly: ' + m)); fi.warn.forEach(m => add('warn', 'DJI Fly: ' + m));
    if (scan && scan.ok && capOf(scan).speed) add('ok', `Ограничения дрона прочитаны с пульта: скорость ${capOf(scan).speed.min.toFixed(1)}…${capOf(scan).speed.max} м/с, подвес ${capOf(scan).pitch ? capOf(scan).pitch.min + '…' + capOf(scan).pitch.max + '°' : '—'}`);
    if (out.some(x => x.battery)) { /* already reported by the route check */ }
    else if (st.battery > 90) out.push({ lvl: 'err', battery: true, msg: `Маршрут требует ≈${Math.round(st.battery)}% батареи — не хватит. Запишите его по частям (блок «🔋» ниже) или сократите маршрут` });
    else if (st.battery > 70) add('warn', `Расход батареи ≈${Math.round(st.battery)}% — оставьте запас на возврат`);
    else if (W.length >= 2) add('ok', `Расход батареи ≈${Math.round(st.battery)}%`);
    if (W.length >= 2) add('ok', `${W.length} точек, ${fmtD(st.dist)}, полёт ${Math.round((st.total || st.time) / 60)} мин`);
    return out;
  }

  // ================= registry of user-friendly names (DJI Fly keeps its own names in a private database) =================
  const REG = 'ws.rc.registry';
  const reg = () => Core.store.get(REG, {});
  const regGet = (serial, uuid) => ((reg()[serial] || {})[uuid]) || null;
  const regSet = (serial, uuid, patch) => { const r = reg(); r[serial] = r[serial] || {}; r[serial][uuid] = Object.assign(r[serial][uuid] || {}, patch); Core.store.set(REG, r); };
  const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  const fmtDay = t => t ? Core.fmtDate(t * 1000) : '—';
  const serialOf = () => (scan && scan.device && scan.device.serial) || 'rc';
  const nameOf = m => (regGet(serialOf(), m.folder) || {}).name || `Задание от ${fmtDay(m.time)}`;
  const linked = () => S.m.rc && scan && scan.ok && S.m.rc.serial === serialOf() ? scan.missions.find(m => m.folder === S.m.rc.uuid) : null;
  let renaming = null; // { folder, field: 'name' | 'djiName' }
  const flyNameOf = m => (regGet(serialOf(), m.folder) || {}).djiName || '';
  const PREV_KEY = 'ws.rc.preview';
  const previewOn = () => Core.store.get(PREV_KEY, true) !== false;

  // ================= map preview for DJI Fly's mission list (route + its name drawn on top) =================
  const merc = (lat, lng, z) => { const n = 256 * 2 ** z, r = lat * Math.PI / 180; return { x: (lng + 180) / 360 * n, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n }; };
  const loadImg = src => new Promise(res => { const im = new Image(); im.crossOrigin = 'anonymous'; const t = setTimeout(() => res(null), 7000); im.onload = () => { clearTimeout(t); res(im); }; im.onerror = () => { clearTimeout(t); res(null); }; im.src = src; });
  async function renderPreview(route, name, withTiles = true) {
    const Wd = 1920, Ht = 1080, pad = 190, cv = document.createElement('canvas'); cv.width = Wd; cv.height = Ht;
    const c = cv.getContext('2d'), pts = route.points, all = pts.concat(route.pois || []);
    let z = 19; for (; z > 2; z--) { const a = all.map(p => merc(p.lat, p.lng, z)); const dx = Math.max(...a.map(p => p.x)) - Math.min(...a.map(p => p.x)), dy = Math.max(...a.map(p => p.y)) - Math.min(...a.map(p => p.y)); if (dx <= Wd - 2 * pad && dy <= Ht - pad - 260) break; }
    const A = all.map(p => merc(p.lat, p.lng, z)), cx = (Math.min(...A.map(p => p.x)) + Math.max(...A.map(p => p.x))) / 2, cy = (Math.min(...A.map(p => p.y)) + Math.max(...A.map(p => p.y))) / 2 - 60;
    const X = p => merc(p.lat, p.lng, z).x - cx + Wd / 2, Y = p => merc(p.lat, p.lng, z).y - cy + Ht / 2;
    c.fillStyle = '#ece6d9'; c.fillRect(0, 0, Wd, Ht);
    if (withTiles) {
      const x0 = Math.floor((cx - Wd / 2) / 256), x1 = Math.floor((cx + Wd / 2) / 256), y0 = Math.floor((cy - Ht / 2) / 256), y1 = Math.floor((cy + Ht / 2) / 256), jobs = [];
      for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) jobs.push(loadImg(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`).then(im => im && c.drawImage(im, tx * 256 - cx + Wd / 2, ty * 256 - cy + Ht / 2, 256, 256)));
      await Promise.all(jobs);
      c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(0, 0, Wd, Ht);
    }
    // route
    c.lineJoin = c.lineCap = 'round';
    const line = (w, col) => { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(X(p), Y(p)) : c.moveTo(X(p), Y(p))); c.stroke(); };
    line(22, 'rgba(0,30,20,.55)'); line(13, '#18d48a');
    (route.pois || []).forEach(p => { c.save(); c.translate(X(p), Y(p)); c.rotate(Math.PI / 4); c.fillStyle = '#ff7a1a'; c.strokeStyle = '#fff'; c.lineWidth = 5; c.fillRect(-22, -22, 44, 44); c.strokeRect(-22, -22, 44, 44); c.restore(); });
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const labels = [];
    pts.forEach((p, i) => {
      const x = X(p), y = Y(p);
      c.fillStyle = '#18d48a'; c.strokeStyle = '#fff'; c.lineWidth = 6; c.beginPath(); c.arc(x, y, 30, 0, 7); c.fill(); c.stroke();
      c.fillStyle = '#fff'; c.font = 'bold 30px -apple-system, Helvetica, Arial'; c.fillText(String(i + 1), x, y + 1);
      if (pts.length <= 40 && !labels.some(l => Math.abs(l.x - x) < 150 && Math.abs(l.y - y) < 60)) { labels.push({ x, y }); const t = `H ${(+p.alt).toFixed(1)}m`; c.font = '600 26px -apple-system, Helvetica, Arial'; const w = c.measureText(t).width + 22; c.fillStyle = 'rgba(70,70,70,.82)'; c.fillRect(x - w / 2, y + 40, w, 40); c.fillStyle = '#fff'; c.fillText(t, x, y + 61); }
    });
    // name banner (so the mission is recognisable in DJI Fly's list)
    c.textAlign = 'left'; c.font = 'bold 76px -apple-system, Helvetica, Arial';
    const title = name.length > 34 ? name.slice(0, 33) + '…' : name, tw = Math.min(Wd - 80, c.measureText(title).width + 70);
    c.fillStyle = 'rgba(10,14,20,.82)'; c.fillRect(40, 36, tw, 170);
    c.fillStyle = '#fff'; c.fillText(title, 75, 100);
    c.font = '500 34px -apple-system, Helvetica, Arial'; c.fillStyle = '#9fe9c9'; c.fillText(`${pts.length} точек · ${route.info || ''} · Waypoint Studio`, 75, 165);
    let blob = null;
    try { blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.86)); } catch (e) { blob = null; }
    if (!blob) return withTiles ? renderPreview(route, name, false) : null; // tiles without CORS taint the canvas → retry plain
    return new Uint8Array(await blob.arrayBuffer());
  }
  const routeOfEditor = () => { const st = Core.stats(); return { points: S.m.waypoints.map(w => ({ lat: w.lat, lng: w.lng, alt: Core.wpRel(w) ?? w.alt })), pois: S.m.pois, info: fmtD(st.dist) }; };
  const routeOfMission = mm => { const p = mm.parsed.waypoints; let d = 0; p.forEach((w, i) => { if (i) d += Geo.dist(p[i - 1], w); }); return { points: p.map(w => ({ lat: w.lat, lng: w.lng, alt: w.alt })), pois: mm.parsed.pois, info: fmtD(d) }; };
  async function putPreview(mm, route, name) {
    const jpg = await renderPreview(route, name); if (!jpg) return { ok: false, error: 'не удалось нарисовать превью' };
    return api(`/rc/replace?folder=${encodeURIComponent('map_preview/' + mm.folder)}&name=${encodeURIComponent(mm.folder + '.jpg')}`, { method: 'POST', body: jpg, headers: { 'Content-Type': 'application/octet-stream' } });
  }

  // ================= UI =================
  let view = 'main', arch = null; // arch: { title, entries:[{key,label,uuid,kmz,jpg,info,name,djiName,target,on}] }
  function card(mm, me) {
    const i = mm.info || {}, nm = nameOf(mm), fly = flyNameOf(mm), isLinked = S.m.rc && S.m.rc.serial === serialOf() && S.m.rc.uuid === mm.folder;
    const r = regGet(serialOf(), mm.folder);
    const changedOnRc = (isLinked && S.m.rc.hash && mm.hash !== S.m.rc.hash) || (r && r.hash && r.hash !== mm.hash);
    const dist = me && i.first ? Geo.dist(me, i.first) : null;
    const edit = f => renaming && renaming.folder === mm.folder && renaming.field === f;
    const inp = (f, v, ph) => `<input class="rcren" data-field="${f}" value="${esc(v)}" maxlength="60" placeholder="${esc(ph)}"><button class="btn sm" data-a="renok">OK</button>`;
    return `<div class="rccard${isLinked ? ' on' : ''}" data-f="${esc(mm.folder)}">
      <div class="rcimg">${mm.previewUrl ? `<img src="${mm.previewUrl}" alt="">` : '<div class="noimg">нет превью</div>'}${isLinked ? '<span class="badge lk">✎ открыто в программе</span>' : ''}${changedOnRc ? '<span class="badge ch">⚠ изменено на пульте</span>' : ''}</div>
      <div class="rcname">${edit('name') ? inp('name', nm, 'Название в программе') : `<b title="${esc(nm)}">${esc(nm)}</b><button class="lnk" data-a="ren" data-field="name" title="Переименовать (название в программе)">✎</button>`}</div>
      <div class="rcfly">${edit('djiName') ? inp('djiName', fly, 'как в списке DJI Fly') : `<span>в DJI Fly: ${fly ? `<b>«${esc(fly)}»</b>` : '<i>имя не указано</i>'}</span><button class="lnk" data-a="ren" data-field="djiName" title="Укажите, как это задание называется в списке DJI Fly на пульте — так его легко найти">✎</button>`}</div>
      <div class="rcmeta">${i.points ?? '?'} точек · ${fmtDay(mm.time)}${dist != null ? ` · ${dist < 3000 ? 'рядом' : fmtD(dist)}` : ''}${mm.kmzCount > 1 ? ' · <span class="bad">несколько KMZ</span>' : ''}</div>
      <div class="row"><button class="btn sm" data-a="open" title="Загрузить это задание в редактор">✎ Открыть</button><button class="btn sm${isLinked ? ' primary' : ''}" data-a="write" title="${isLinked ? 'Записать изменения обратно в это задание' : 'Заменить это задание маршрутом из редактора'}">${isLinked ? '📲 Записать изменения' : '📲 Записать сюда'}</button><button class="btn sm" data-a="dl" title="Сохранить файл задания на Mac">⬇</button></div>
    </div>`;
  }
  const flyLabel = mm => flyNameOf(mm) ? `«${flyNameOf(mm)}» в DJI Fly` : `«${nameOf(mm)}»`;
  // background updates must not re-open the window after the user closed it (or opened another dialog)
  const isVisible = () => !$('#modal').hidden && $('#modal .box').classList.contains('rc');
  const devName = () => { const d = (scan && scan.device) || {}, mf = d.manufacturer || '', md = d.model || ''; return md.toLowerCase().startsWith(mf.toLowerCase()) ? md : [mf, md].filter(Boolean).join(' '); };
  const missions = () => scan && scan.ok ? scan.missions.filter(m => m.kmz).sort((a, b) => (b.time || 0) - (a.time || 0)) : [];
  const optList = (sel, ex) => `<option value="">— не записывать —</option>` + missions().map(m => `<option value="${esc(m.folder)}"${m.folder === sel ? ' selected' : ''}${ex && ex.has(m.folder) && m.folder !== sel ? ' disabled' : ''}>${esc(nameOf(m))}${flyNameOf(m) ? ' · DJI Fly «' + esc(flyNameOf(m)) + '»' : ''} · ${(m.info || {}).points ?? '?'} т.</option>`).join('');
  // ---- battery split: parts of the current route, each written into its own mission ----
  let partsSel = {};
  function partsInfo() {
    if (S.m.waypoints.length < 3) return null;
    let parts; try { parts = IO.splitByBattery(); } catch (e) { return null; }
    return parts.length > 1 ? parts : null;
  }
  function partsHtml(parts, blockedOther) {
    const used = new Set(Object.values(partsSel).filter(Boolean));
    return `<div class="card warnc"><b>🔋 Маршрут не помещается в одну батарею — ${parts.length} части.</b> ${tip('Программа делит маршрут так, чтобы каждая часть (с подлётом и возвратом) укладывалась в ≈75% батареи. Каждая часть записывается в своё задание на пульте и подписывается «Часть k/N» на превью. Летайте части по порядку, меняя батарею между ними.')}
      <div class="note">Выберите для каждой части задание‑заготовку на пульте (оно будет заменено, копия сохранится на Mac). Не хватает заданий — создайте в DJI Fly заготовки из 2 точек и назовите их, например, «${esc((S.m.name || 'Маршрут').slice(0, 20))} 1», «… 2».</div>
      ${parts.map(([a, b], k) => `<div class="rcpart"><span><b>Часть ${k + 1}/${parts.length}</b> · точки ${a + 1}–${b + 1} (${b - a + 1})</span><select data-part="${k}">${optList(partsSel[k], used)}</select></div>`).join('')}
      <div class="row"><button class="btn primary" id="rcParts" ${blockedOther || busy || parts.some((_, k) => !partsSel[k]) ? 'disabled' : ''}>📲 Записать все ${parts.length} части</button>${blockedOther ? '<span class="note bad">сначала исправьте ошибки маршрута</span>' : parts.some((_, k) => !partsSel[k]) ? '<span class="note">выберите задание для каждой части</span>' : ''}</div></div>`;
  }
  function render(force) {
    if (!force && !isVisible()) return;
    if (view === 'arch') return renderArch();
    const checks = routeChecks(), blocked = checks.some(c => c.lvl === 'err');
    const parts = partsInfo(), blockedOther = checks.some(c => c.lvl === 'err' && !c.battery);
    const ic = { ok: '✅', warn: '⚠️', err: '⛔' }, me = S.m.waypoints[0];
    const ms = missions();
    const lk = linked();
    const nErr = checks.filter(c => c.lvl === 'err').length, nWarn = checks.filter(c => c.lvl === 'warn').length;
    show(`<h2>📲 Пульт DJI RC 2 ${tip('Двусторонняя работа с заданиями DJI Fly на пульте: открыть любое задание в программе, исправить и записать обратно; записать новый маршрут поверх задания; обновить превью. Перед каждой записью сохраняется копия, после записи файл сверяется побайтно.')}</h2>
      <div class="row"><button class="btn primary" id="rcScan" ${busy ? 'disabled' : ''}>${scan ? '⟳ Обновить' : '🔌 Подключиться к пульту'}</button>
        ${scan && scan.ok ? `<span class="note">✅ ${esc(devName())} · заданий: ${ms.length}${capOf(scan).speed ? ` · скорость ${capOf(scan).speed.min.toFixed(1)}…${capOf(scan).speed.max} м/с, подвес ${capOf(scan).pitch ? capOf(scan).pitch.min + '…' + capOf(scan).pitch.max + '°' : ''}` : ''}</span>` : ''}
        ${busy ? `<span class="note">⏳ ${esc(busy)}… не отключайте кабель</span>` : ''}</div>
      ${!scan ? `<ol class="note steps"><li>Подключите пульт к Mac кабелем USB‑C, пульт включён и разблокирован (режим USB — «Передача файлов»).</li><li>В DJI Fly на пульте выйдите из режима путевых точек.</li><li>Нажмите «Подключиться к пульту» (при подключении кабеля программа подключится сама).</li></ol>` : ''}
      ${scan && !scan.ok ? `<div class="w err"><span>⛔</span><span>${esc(errText(scan))}</span></div>` : ''}
      ${last ? resultHtml(last) : ''}
      <details class="card" ${nErr ? 'open' : ''}><summary>Маршрут в редакторе: «${esc(S.m.name)}» — ${nErr ? `<span class="bad">⛔ ошибок: ${nErr}</span>` : nWarn ? `<span class="mid">⚠ замечаний: ${nWarn}</span>` : '<span class="okc">✓ готов к записи</span>'}${lk ? ` · связан с заданием «${esc(nameOf(lk))}»` : ''}</summary>
        ${checks.map(c => `<div class="w ${c.lvl}"><span>${ic[c.lvl]}</span><span>${esc(c.msg)}</span></div>`).join('')}</details>
      ${lk ? `<div class="card on"><b>✎ В редакторе открыто задание с пульта «${esc(nameOf(lk))}»${flyNameOf(lk) ? ` (в DJI Fly — «${esc(flyNameOf(lk))}»)` : ''}.</b> <span class="note">После правок нажмите — изменения запишутся в это же задание:</span>
        <div class="row"><button class="btn primary" id="rcWriteLinked" ${blocked || busy ? 'disabled' : ''}>📲 Записать изменения на пульт</button></div></div>` : ''}
      ${parts && scan && scan.ok ? partsHtml(parts, blockedOther) : ''}
      ${ms.length ? `<h3>Задания на пульте ${tip('Имена заданий в DJI Fly хранятся в его закрытой базе — программа не может их изменить. Поэтому у каждого задания два имени: название в программе (ваше) и «имя в DJI Fly» — как оно подписано в списке на пульте, чтобы его легко найти. Укажите его кнопкой ✎.')}</h3>
        <div class="rcgrid">${ms.map(m => card(m, me)).join('')}</div>` : scan && scan.ok ? '<div class="note bad">На пульте нет заданий DJI Fly.</div>' : ''}
      ${scan && scan.ok ? `<div class="card tipc">➕ <b>Нужно новое задание на пульте?</b> DJI Fly не позволяет создавать их извне. В DJI Fly: путевые точки → поставьте 2 любые точки → сохраните и <b>сразу дайте понятное имя</b> (например, «${esc((S.m.name || 'Маршрут').slice(0, 24))}») — это имя будет видно в списке DJI Fly. Затем здесь «⟳ Обновить» → у новой заготовки «✎» в строке «в DJI Fly» впишите то же имя → «📲 Записать сюда».</div>` : ''}
      <label class="chk"><input type="checkbox" id="rcPrevOpt" ${previewOn() ? 'checked' : ''}> Обновлять картинку‑превью задания на пульте (карта маршрута с названием) ${tip('DJI Fly показывает в списке заданий картинку маршрута. Программа рисует на ней ваш маршрут и название, чтобы задание было легко узнать. Если превью в вашей версии DJI Fly не видно или не нужно — снимите галочку: будет записываться только сам маршрут.')}</label>
      <div class="row" style="margin-top:10px">${ms.length ? '<button class="btn sm" id="rcAll">⬇ Все задания с пульта — в архив на Mac</button>' : ''}<button class="btn sm" id="rcArch" ${busy ? 'disabled' : ''}>♻ Восстановить из архива…</button><button class="btn sm" id="rcBk">📁 Папка копий</button></div>`);
    $('#rcScan').onclick = () => doScan();
    $('#rcBk').onclick = () => api('/rc/openBackups');
    $('#rcArch').onclick = () => { view = 'arch'; arch = null; render(); loadArchList(); };
    $('#rcPrevOpt').onchange = e => Core.store.set(PREV_KEY, e.target.checked);
    const all = $('#rcAll'); if (all) all.onclick = () => backupAll(false);
    const wl = $('#rcWriteLinked'); if (wl) wl.onclick = () => doWrite(lk, true);
    document.querySelectorAll('select[data-part]').forEach(el => el.onchange = () => { partsSel[+el.dataset.part] = el.value || undefined; render(); });
    const pb = $('#rcParts'); if (pb) pb.onclick = () => doWriteParts(parts);
    document.querySelectorAll('.rccard').forEach(el => el.onclick = e => {
      const b = e.target.closest('[data-a]'); if (!b) return; const mm = scan.missions.find(m => m.folder === el.dataset.f); const a = b.dataset.a;
      if (a === 'open') doOpen(mm);
      if (a === 'write') { const isL = S.m.rc && S.m.rc.uuid === mm.folder && S.m.rc.serial === serialOf(); if (blocked) return toast(parts && !blockedOther ? 'Маршрут не помещается в одну батарею — запишите его по частям (блок «🔋» выше)' : 'Сначала исправьте ошибки маршрута (раздел «Маршрут в редакторе»)', 'err', 7000); doWrite(mm, isL); }
      if (a === 'dl') IO.download(`${IO.safeFile(nameOf(mm))}__${mm.folder.slice(0, 8)}.kmz`, new Blob([mm.bytes]));
      if (a === 'ren') {
        renaming = { folder: mm.folder, field: b.dataset.field }; render();
        const inp = $('.rcren'); inp.focus(); inp.select();
        inp.onkeydown = ev => { if (ev.key === 'Enter') doRename(mm, inp.dataset.field, inp.value); if (ev.key === 'Escape') { ev.stopPropagation(); renaming = null; render(); } };
      }
      if (a === 'renok') { const inp = $('.rcren'); doRename(mm, inp.dataset.field, inp.value); }
    });
    const rb = $('#rcRestore'); if (rb) rb.onclick = () => doRestore();
  }
  function errText(j) {
    const hints = {
      NO_DEVICE: 'Пульт не найден. Проверьте: кабель USB‑C поддерживает передачу данных (не только зарядку), пульт включён и разблокирован, на пульте выбран режим «Передача файлов».',
      OPEN_FAILED: 'Пульт найден, но занят другой программой.' + (j.busy && j.busy.length ? ' Закройте: ' + j.busy.join(', ') + '.' : ' Закройте Android File Transfer / OpenMTP / Захват изображений и отключите‑подключите кабель.'),
      NO_STORAGE: 'Пульт не открывает память. Разблокируйте экран пульта, выберите «Передача файлов», отключите и подключите кабель.',
      NO_WAYPOINT_FOLDER: 'На пульте не найдена папка заданий DJI Fly. Создайте в DJI Fly хотя бы одно задание путевых точек и повторите.',
      NO_BRIDGE: 'Функция доступна только в программе для macOS.',
    };
    return (hints[j.code] || j.error || 'Ошибка') + (j.code && !hints[j.code] ? ` [${j.code}]` : '');
  }
  function resultHtml(r) {
    if (!r.ok) return `<div class="w err"><span>⛔</span><span>${esc(errText(r))}</span></div>`;
    if (r.multi) return `<div class="card ok"><b>✅ ${esc(r.title)}</b><ol class="note steps">${r.items.map(x => `<li>${x.ok ? '✅' : '⛔'} ${esc(x.label)} → ${esc(x.where)}${x.ok ? '' : ': ' + esc(x.err)}</li>`).join('')}</ol>
      <div class="note">Копии заменённых заданий: Загрузки/WaypointStudio/Резервные копии пульта (их можно вернуть кнопкой «♻ Восстановить из архива»).</div></div>`;
    return `<div class="card ok"><b>✅ «${esc(r.name)}» записано на пульт и проверено побайтно</b> (${Math.round(r.size / 1024)} КБ${r.preview ? ', превью обновлено' : r.previewErr ? ', превью не обновлено: ' + esc(r.previewErr) : ''}).
      <ol class="note steps"><li>На пульте: DJI Fly → путевые точки → список. ${r.djiName ? `Найдите задание <b>«${esc(r.djiName)}»</b>.` : `Задание узнаете${r.preview ? ` по превью с надписью «${esc(r.name)}»` : ' по дате изменения'} (имя в списке DJI Fly остаётся прежним — его может изменить только сам DJI Fly).`}</li>
      <li>Откройте его и <b>проверьте маршрут на карте</b>: ${r.points} точек, высоты, первая точка.</li></ol>
      <div class="note">Копия прежней версии: Загрузки/WaypointStudio/Резервные копии пульта/${esc(r.backupName || '')}</div>
      <div class="row"><button class="btn sm" id="rcRestore">↶ Вернуть прежнюю версию на пульт</button></div></div>`;
  }

  // ================= actions =================
  let scanning = null;
  async function doScan(keepLast, silent) {
    if (scanning) return scanning;
    scanning = (async () => {
      busy = 'Чтение заданий с пульта'; if (!keepLast) last = null; render(); badge();
      try {
        const j = await api('/rc/scan');
        if (j.ok) {
          for (const m of j.missions) {
            if (m.data) { try { m.bytes = b64ToBytes(m.data); m.hash = await sha(m.bytes); m.info = await readMission(m.bytes); const z = await JSZip.loadAsync(m.bytes); { const tk = Object.keys(z.files).find(k => k.endsWith('template.kml')); m.parsed = IO.parseWPML(await z.file(Object.keys(z.files).find(k => k.endsWith('waylines.wpml'))).async('string'), tk ? await z.file(tk).async('string') : null); } } catch (e) { m.info = null; } }
            if (m.previewData) m.previewUrl = 'data:image/jpeg;base64,' + m.previewData;
            delete m.data; delete m.previewData;
          }
        }
        scan = j;
      } catch (e) { scan = { ok: false, code: 'NET', error: e.message }; }
      busy = false; render(); badge();
      return scan;
    })();
    try { return await scanning; } finally { scanning = null; badge(); }
  }
  function doOpen(mm) {
    if (!mm.parsed) return toast('Это задание не удалось прочитать', 'err');
    const lk = S.m.rc && S.m.rc.uuid === mm.folder && S.m.rc.serial === serialOf();
    if (lk && !confirm('Это задание уже открыто в программе. Загрузить заново с пульта? Несохранённые правки будут заменены (текущая версия останется в архиве).')) return;
    const m = JSON.parse(JSON.stringify(mm.parsed));
    m.name = nameOf(mm); m.settings.drone = S.m.settings.drone; m.settings.target = 'fly';
    m.rc = { serial: serialOf(), uuid: mm.folder, kmz: mm.kmz, hash: mm.hash, at: Date.now() };
    if (S.m.waypoints.length) Core.saveToLibrary();
    Core.loadMission(m);
    regSet(serialOf(), mm.folder, { name: m.name, hash: mm.hash });
    $('#modal').hidden = true;
    toast(`Открыто с пульта: «${m.name}» (${m.waypoints.length} точек). После правок: «📲 Пульт» → «Записать изменения».`, 'ok', 8000);
  }
  async function doRename(mm, field, v) {
    v = (v || '').trim(); renaming = null;
    if (field === 'djiName') { regSet(serialOf(), mm.folder, { djiName: v }); return render(); }
    if (!v) return render();
    regSet(serialOf(), mm.folder, { name: v });
    if (S.m.rc && S.m.rc.uuid === mm.folder) { S.m.name = v; Core.changed(); }
    render();
    if (mm.parsed && previewOn() && confirm(`Обновить превью на пульте, чтобы задание было подписано «${v}»?`)) {
      busy = 'Запись превью'; render();
      const r = await putPreview(mm, routeOfMission(mm), v);
      busy = false; toast(r.ok ? 'Превью на пульте обновлено' : 'Превью не обновлено: ' + errText(r), r.ok ? 'ok' : 'err', 6000); await doScan();
    }
  }
  // fresh read of one mission right before writing (conflict check)
  async function freshOf(folder) {
    const fresh = await api('/rc/scan'); if (!fresh.ok) throw Object.assign(new Error(errText(fresh)), { r: fresh });
    const f = fresh.missions.find(x => x.folder === folder);
    if (!f || !f.data) throw new Error('Задание не найдено на пульте — нажмите «Обновить»');
    const fb = b64ToBytes(f.data); return { f, fb, fh: await sha(fb), fresh };
  }
  async function doWrite(mm, isLinked) {
    if (busy || !mm) return;
    const nm = nameOf(mm);
    if (!isLinked && !confirm(`Заменить задание ${flyLabel(mm)} (${(mm.info || {}).points ?? '?'} точек) на пульте маршрутом «${S.m.name}» (${S.m.waypoints.length} точек)?\n\nКопия задания сохранится на Mac, его можно будет вернуть.`)) return;
    busy = 'Проверка, что задание на пульте не изменилось'; render();
    try {
      const { f, fb, fh } = await freshOf(mm.folder);
      const base = isLinked ? S.m.rc.hash : mm.hash;
      if (base && fh !== base && !confirm(`Задание «${nm}» на пульте было изменено (в DJI Fly) после того, как вы его ${isLinked ? 'открыли' : 'просмотрели'}.\n\nЗаписать всё равно? Версия с пульта сохранится в резервные копии.`)) { busy = false; return render(); }
      busy = 'Запись маршрута'; render();
      const ref = await readMission(fb);
      const bytes = await buildKmz(ref.ns ? ref : { ns: null, droneEnum: null, droneSub: null }, capOf(scan));
      const r = await api(`/rc/replace?folder=${encodeURIComponent(mm.folder)}&name=${encodeURIComponent(f.kmz)}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
      if (!r.ok) throw Object.assign(new Error(errText(r)), { r });
      const newHash = await sha(bytes);
      regSet(serialOf(), mm.folder, { name: S.m.name, hash: newHash, at: Date.now() });
      S.m.rc = { serial: serialOf(), uuid: mm.folder, kmz: f.kmz, hash: newHash, at: Date.now() }; Core.changed();
      let pv = null;
      if (previewOn()) { busy = 'Обновление превью'; render(); try { pv = await putPreview(mm, routeOfEditor(), S.m.name); } catch (e) { pv = { ok: false, error: e.message }; } }
      last = Object.assign(r, { folder: mm.folder, kmz: f.kmz, name: S.m.name, djiName: flyNameOf(mm), points: S.m.waypoints.length, preview: pv && pv.ok, previewErr: pv && !pv.ok ? (pv.error || pv.code) : null, previewBackup: pv && pv.backupName });
      toast('Записано на пульт и проверено', 'ok', 6000);
      busy = false; await doScan(true);
    } catch (e) { busy = false; last = { ok: false, code: e.r && e.r.code, error: e.message }; render(); }
  }
  // write each battery part into its own mission
  async function doWriteParts(parts) {
    if (busy) return;
    const N = parts.length, tg = parts.map((_, k) => scan.missions.find(m => m.folder === partsSel[k]));
    if (tg.some(x => !x) || new Set(tg.map(x => x.folder)).size !== N) return toast('Для каждой части выберите своё (разное) задание', 'err');
    if (!confirm(`Записать маршрут «${S.m.name}» на пульт по частям?\n\n${parts.map(([a, b], k) => `Часть ${k + 1}/${N} (точки ${a + 1}–${b + 1}) → заменит ${flyLabel(tg[k])}`).join('\n')}\n\nКопии заменяемых заданий сохранятся на Mac.`)) return;
    const all = S.m.waypoints, items = [], baseName = S.m.name;
    busy = 'Запись частей маршрута'; render();
    try {
      for (let k = 0; k < N; k++) {
        const [a, b] = parts[k], mm = tg[k], label = `Часть ${k + 1}/${N} (точки ${a + 1}–${b + 1})`, pname = `${baseName} — часть ${k + 1}/${N}`;
        busy = `Запись: часть ${k + 1} из ${N}`; render();
        try {
          const { f, fb, fh } = await freshOf(mm.folder);
          if (mm.hash && fh !== mm.hash) throw new Error('задание изменено на пульте после чтения — нажмите «Обновить» и повторите');
          const ref = await readMission(fb);
          S.m.waypoints = all.slice(a, b + 1);
          let bytes, route;
          try { bytes = await IO.withPartFinish(k, N, () => buildKmz(ref.ns ? ref : { ns: null, droneEnum: null, droneSub: null }, capOf(scan))); route = routeOfEditor(); } finally { S.m.waypoints = all; }
          const r = await api(`/rc/replace?folder=${encodeURIComponent(mm.folder)}&name=${encodeURIComponent(f.kmz)}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
          if (!r.ok) throw new Error(errText(r));
          regSet(serialOf(), mm.folder, { name: pname, hash: await sha(bytes), at: Date.now() });
          if (previewOn()) { try { await putPreview(mm, route, pname); } catch (e) { /* preview is cosmetic */ } }
          items.push({ ok: true, label, where: flyLabel(mm) });
        } catch (e) { items.push({ ok: false, label, where: flyLabel(mm), err: e.message }); break; }
      }
    } finally { S.m.waypoints = all; }
    const nOk = items.filter(x => x.ok).length;
    last = { ok: true, multi: true, title: nOk === N ? `Все ${N} части записаны на пульт и проверены побайтно` : `Записано частей: ${nOk} из ${N} — запись остановлена`, items };
    if (nOk === N) partsSel = {};
    toast(last.title, nOk === N ? 'ok' : 'err', 8000);
    busy = false; await doScan(true);
  }
  async function doRestore() {
    if (!last || !last.ok || !last.backupName || busy) return;
    if (!confirm('Вернуть на пульт прежнюю версию задания? Записанный маршрут на пульте будет заменён обратно (он останется в программе).')) return;
    busy = 'Восстановление'; render();
    const r = await api(`/rc/restore?folder=${encodeURIComponent(last.folder)}&name=${encodeURIComponent(last.kmz)}&backup=${encodeURIComponent(last.backupName)}`, { method: 'POST' });
    if (r.ok && last.previewBackup) await api(`/rc/restore?folder=${encodeURIComponent('map_preview/' + last.folder)}&name=${encodeURIComponent(last.folder + '.jpg')}&backup=${encodeURIComponent(last.previewBackup)}`, { method: 'POST' });
    if (r.ok && S.m.rc && S.m.rc.uuid === last.folder) { delete S.m.rc; Core.changed(); }
    busy = false; last = null; toast(r.ok ? 'Прежняя версия возвращена на пульт' : 'Не удалось вернуть: ' + errText(r), r.ok ? 'ok' : 'err', 7000);
    await doScan();
  }
  // ---- archive of all missions (zip with names.json so names survive a restore) ----
  async function makeArchive() {
    const z = new JSZip(), ms = scan.missions.filter(m => m.bytes), names = {};
    ms.forEach(m => { const base = `${IO.safeFile(nameOf(m))}__${m.folder}`; z.file(base + '.kmz', m.bytes); if (m.previewUrl) z.file(base + '.jpg', m.previewUrl.split(',')[1], { base64: true }); names[m.folder] = { name: nameOf(m), djiName: flyNameOf(m), time: m.time }; });
    z.file('names.json', JSON.stringify({ serial: serialOf(), at: Date.now(), missions: names }, null, 1));
    z.file('README.txt', `Резервная копия заданий DJI Fly с пульта ${serialOf()} — ${Core.fmtDate(Date.now())}\nЗаданий: ${ms.length}. Вернуть на пульт: Waypoint Studio → 📲 Пульт → «♻ Восстановить из архива». Открыть одно задание: Файл → Открыть (.kmz).\n`);
    return { blob: await z.generateAsync({ type: 'uint8array' }), n: ms.length };
  }
  const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
  const serialSafe = () => String(serialOf()).replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'rc';
  async function backupAll(auto) {
    if (!scan || !scan.ok) return;
    const { blob, n } = await makeArchive();
    const name = `RC2_${auto ? 'auto_' : ''}${serialSafe()}_${stamp()}.zip`;
    const r = await api(`/rc/saveArchive?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!r.ok) { if (!auto) toast('Архив не сохранён: ' + (r.error || ''), 'err', 6000); return r; }
    if (!auto) toast(`Архив ${n} заданий сохранён: Загрузки/WaypointStudio/Резервные копии пульта/Архивы/${name}`, 'ok', 8000, { label: 'Открыть папку', fn: () => api('/rc/openBackups') });
    return Object.assign(r, { n, name });
  }

  // ================= restore from an archive on the Mac =================
  async function loadArchList() {
    const r = await api('/rc/archives'); arch = { list: r.ok ? r.files : [], err: r.ok ? null : (r.error || 'ошибка') }; render();
  }
  async function loadArchive(bytes, title) {
    const entries = [];
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    let z; try { z = await JSZip.loadAsync(bytes); } catch (e) { return toast('Файл не читается как архив/KMZ', 'err'); }
    const files = Object.keys(z.files);
    const add = async (kmzBytes, uuid, jpg, label, meta) => {
      let info = null; try { info = await readMission(kmzBytes); } catch (e) { info = null; }
      const ok = info && info.points >= 2 && info.files.some(f => f.endsWith('waylines.wpml'));
      const cur = uuid ? missions().find(m => m.folder === uuid) : null, same = !!(cur && cur.hash && cur.hash === await sha(kmzBytes));
      // nothing is pre-ticked: the user picks what to restore (identical copies are marked and skipped)
      entries.push({ key: entries.length, uuid, kmz: kmzBytes, jpg, info, ok, same, label, name: meta && meta.name, djiName: meta && meta.djiName, target: ok && cur ? uuid : '', on: false });
    };
    // file names are "<name>__<missionFolder>.kmz" (archives) or "<time>__<missionFolder>.kmz" (copies before a write)
    const folderOf = n => { const m = String(n).split('/').pop().replace(/\.kmz$/i, '').match(/__([A-Za-z0-9-]{4,64})$/); return m ? m[1] : null; };
    if (files.some(f => f.endsWith('waylines.wpml'))) { // a single mission KMZ
      const u = folderOf(title);
      await add(bytes, u, null, title, u ? regGet(serialOf(), u) : null);
    } else {
      let names = {}; if (z.file('names.json')) { try { names = JSON.parse(await z.file('names.json').async('string')).missions || {}; } catch (e) { names = {}; } }
      for (const f of files.filter(f => /\.kmz$/i.test(f)).sort()) {
        const u = folderOf(f), jf = f.replace(/\.kmz$/i, '.jpg');
        await add(await z.file(f).async('uint8array'), u, z.file(jf) ? await z.file(jf).async('uint8array') : null, f.split('/').pop().replace(/__[A-Za-z0-9-]{4,64}\.kmz$/i, '').replace(/\.kmz$/i, ''), names[u] || null);
      }
    }
    if (!isZip && !entries.length) return toast('В файле нет заданий DJI Fly', 'err');
    arch = Object.assign(arch || {}, { title, entries }); render();
  }
  function renderArch() {
    const A = arch || {}, E = A.entries;
    const used = new Set(E ? E.filter(e => e.on && e.target).map(e => e.target) : []);
    const fmtSz = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.round(b / 1024) + ' КБ';
    show(`<h2>♻ Восстановить задания на пульт из архива ${tip('Архивы создаются автоматически при каждом подключении пульта (если задания изменились) и кнопкой «Все задания — в архив». Кроме того, перед каждой записью программа сохраняет копию заменяемого задания. Любое из них можно вернуть на пульт: в то же задание или в другое.')}</h2>
      <div class="row"><button class="btn sm" id="arBack">← Назад к заданиям</button><button class="btn sm" id="arPick">📂 Выбрать файл (.zip / .kmz)…</button><input type="file" id="arFile" accept=".zip,.kmz" hidden>${busy ? `<span class="note">⏳ ${esc(busy)}… не отключайте кабель</span>` : ''}</div>
      ${!scan || !scan.ok ? '<div class="w warn"><span>⚠️</span><span>Пульт не прочитан — подключите его и нажмите «Назад» → «Обновить», чтобы выбрать, куда записывать.</span></div>' : ''}
      ${!E ? (A.list ? (A.list.length ? `<h3>Архивы и копии на Mac</h3><div class="arlist">${A.list.map(f => `<button class="arrow" data-n="${esc(f.name)}" data-d="${f.dir}"><b>${f.dir === 'arch' ? '🗂' : '📄'} ${esc(f.name)}</b><span>${Core.fmtDate(f.mtime)} · ${fmtSz(f.size)}${f.dir === 'arch' ? ' · архив всех заданий' : ' · копия перед записью'}</span></button>`).join('')}</div>` : '<div class="note">Архивов пока нет. Они появятся после подключения пульта.</div>') : (A.err ? `<div class="w err"><span>⛔</span><span>${esc(A.err)}</span></div>` : '<div class="note">Загрузка списка…</div>')) : `
        <h3>${esc(A.title || '')} — заданий: ${E.length}</h3>
        <div class="note">Отметьте задания, которые нужно вернуть, и проверьте, в какое задание на пульте их записать (по умолчанию — в то же самое). Заменяемое задание предварительно копируется на Mac.</div>
        ${E.some(e => e.ok && !e.same && e.target) ? `<div class="row"><button class="btn sm" id="arDiff">☑ Отметить все, что отличается от пульта (${E.filter(e => e.ok && !e.same && e.target).length})</button><button class="btn sm" id="arNone">☐ Снять все</button></div>` : '<div class="note okc">Все задания из архива совпадают с тем, что сейчас на пульте.</div>'}
        <div class="arents">${E.map(e => `<div class="arent${e.ok ? '' : ' bad'}" data-k="${e.key}">
          <label><input type="checkbox" data-k="${e.key}" ${e.on ? 'checked' : ''} ${e.ok ? '' : 'disabled'}> <b>${esc(e.name || e.label)}</b>${e.djiName ? ` <span class="note">· DJI Fly «${esc(e.djiName)}»</span>` : ''}</label>
          <span class="note">${e.ok ? `${e.info.points} точек${e.uuid ? ' · ' + (e.same ? '<span class="okc">✓ совпадает с заданием на пульте — восстанавливать не нужно</span>' : missions().some(m => m.folder === e.uuid) ? '<span class="mid">на пульте сейчас другая версия этого задания</span>' : 'этого задания на пульте нет — выберите, куда записать') : ''}` : 'файл не является заданием DJI Fly'}</span>
          ${e.ok ? `<div class="row"><select data-k="${e.key}">${optList(e.target, used)}</select><button class="btn sm" data-open="${e.key}" title="Открыть в редакторе (без записи на пульт)">✎ Открыть</button></div>` : ''}</div>`).join('')}</div>
        <div class="row"><button class="btn primary" id="arGo" ${busy || !scan || !scan.ok || !E.some(e => e.on && e.target) ? 'disabled' : ''}>📲 Записать отмеченные на пульт (${E.filter(e => e.on && e.target).length})</button><button class="btn sm" id="arOther">Другой архив…</button></div>`}`);
    $('#arBack').onclick = () => { view = 'main'; render(); };
    $('#arPick').onclick = () => $('#arFile').click();
    $('#arFile').onchange = async e => { const f = e.target.files[0]; if (f) await loadArchive(new Uint8Array(await f.arrayBuffer()), f.name); };
    document.querySelectorAll('.arrow').forEach(b => b.onclick = async () => {
      const r = await api(`/rc/archiveGet?dir=${b.dataset.d}&name=${encodeURIComponent(b.dataset.n)}`);
      if (!(r instanceof Blob)) return toast('Не удалось прочитать: ' + (r.error || ''), 'err');
      await loadArchive(new Uint8Array(await r.arrayBuffer()), b.dataset.n);
    });
    const ao = $('#arOther'); if (ao) ao.onclick = () => { arch = { list: arch.list }; if (!arch.list) loadArchList(); else render(); };
    if (E) {
      document.querySelectorAll('.arent input[type=checkbox]').forEach(c => c.onchange = () => { E[+c.dataset.k].on = c.checked; render(); });
      document.querySelectorAll('.arent select').forEach(c => c.onchange = () => { const e = E[+c.dataset.k]; e.target = c.value; if (c.value) e.on = true; render(); });
      document.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => {
        const e = E[+b.dataset.open], z = await JSZip.loadAsync(e.kmz), wl = Object.keys(z.files).find(k => k.endsWith('waylines.wpml'));
        const tk = Object.keys(z.files).find(k => k.endsWith('template.kml')); const m = IO.parseWPML(await z.file(wl).async('string'), tk ? await z.file(tk).async('string') : null); m.name = e.name || e.label; m.settings.drone = S.m.settings.drone; m.settings.target = 'fly';
        if (S.m.waypoints.length) Core.saveToLibrary(); Core.loadMission(m); $('#modal').hidden = true; toast(`Открыто из архива: «${m.name}»`, 'ok');
      });
      const ad = $('#arDiff'); if (ad) ad.onclick = () => { E.forEach(e => e.on = !!(e.ok && !e.same && e.target)); render(); };
      const an = $('#arNone'); if (an) an.onclick = () => { E.forEach(e => e.on = false); render(); };
      const go = $('#arGo'); if (go) go.onclick = () => doArchRestore(E.filter(e => e.on && e.target));
    }
  }
  async function doArchRestore(sel) {
    if (busy || !sel.length) return;
    if (new Set(sel.map(e => e.target)).size !== sel.length) return toast('Два задания из архива выбраны в одно и то же задание на пульте', 'err', 6000);
    const tg = e => scan.missions.find(m => m.folder === e.target);
    if (!confirm(`Записать на пульт из архива:\n\n${sel.map(e => `«${e.name || e.label}» (${e.info.points} т.) → заменит ${flyLabel(tg(e))}`).join('\n')}\n\nТекущие версии заменяемых заданий сохранятся на Mac.`)) return;
    const items = [];
    for (let k = 0; k < sel.length; k++) {
      const e = sel[k], mm = tg(e), label = `«${e.name || e.label}»`;
      busy = `Восстановление ${k + 1} из ${sel.length}`; render();
      try {
        if (!mm || !mm.kmz) throw new Error('задание не найдено на пульте');
        const r = await api(`/rc/replace?folder=${encodeURIComponent(mm.folder)}&name=${encodeURIComponent(mm.kmz)}`, { method: 'POST', body: e.kmz, headers: { 'Content-Type': 'application/octet-stream' } });
        if (!r.ok) throw new Error(errText(r));
        regSet(serialOf(), mm.folder, Object.assign({ hash: await sha(e.kmz), at: Date.now() }, e.name ? { name: e.name } : {}, e.djiName && mm.folder === e.uuid ? { djiName: e.djiName } : {}));
        if (e.jpg && previewOn()) { try { await api(`/rc/replace?folder=${encodeURIComponent('map_preview/' + mm.folder)}&name=${encodeURIComponent(mm.folder + '.jpg')}`, { method: 'POST', body: e.jpg, headers: { 'Content-Type': 'application/octet-stream' } }); } catch (x) { /* cosmetic */ } }
        if (S.m.rc && S.m.rc.uuid === mm.folder) { delete S.m.rc; Core.changed(); }
        items.push({ ok: true, label, where: flyLabel(mm) });
      } catch (x) { items.push({ ok: false, label, where: mm ? flyLabel(mm) : '?', err: x.message }); break; }
    }
    const nOk = items.filter(x => x.ok).length;
    last = { ok: true, multi: true, title: nOk === sel.length ? `Восстановлено заданий: ${nOk} — записаны и проверены побайтно` : `Восстановлено ${nOk} из ${sel.length} — запись остановлена`, items };
    toast(last.title, nOk === sel.length ? 'ok' : 'err', 8000);
    busy = false; view = 'main'; arch = null; await doScan(true);
  }

  // ================= auto-detect the remote on the USB cable + automatic backup =================
  let present = false, autoT = null, autoDone = false;
  function badge() {
    const b = document.getElementById('rcBtn'); if (!b) return;
    let txt = '📲 Пульт', cls = '';
    if (present) {
      if (busy || scanning) { txt = '📲 RC 2 · чтение…'; cls = 'rcbusy'; }
      else if (scan && scan.ok) { txt = '📲 RC 2 подключён'; cls = 'rcon'; }
      else if (scan && !scan.ok) { txt = '📲 RC 2: разблокируйте'; cls = 'rcwarn'; }
      else { txt = '📲 RC 2 найден'; cls = 'rcbusy'; }
    }
    b.textContent = txt; b.classList.remove('rcon', 'rcbusy', 'rcwarn'); if (cls) b.classList.add(cls);
    b.title = present ? (scan && scan.ok ? `Пульт подключён: заданий ${missions().length}. Нажмите, чтобы открыть задания / записать маршрут` : 'Пульт подключён по USB. Если задания не читаются — разблокируйте пульт и выберите «Передача файлов»') : 'Пульт DJI RC 2: открыть задания с пульта, записать маршрут на пульт (подключите пульт кабелем USB‑C)';
  }
  async function autoConnect() {
    autoT = null; if (!present || autoDone) return;
    if (busy) { autoT = setTimeout(autoConnect, 3000); return; }
    const j = await doScan(true, true);
    if (!present) return;
    if (!j || !j.ok) { autoT = setTimeout(autoConnect, 8000); return; } // locked / charging mode: retry quietly
    autoDone = true;
    const ms = missions(), key = await sha(new TextEncoder().encode(ms.map(m => m.folder + ':' + m.hash).sort().join('|')));
    const KEY = 'ws.rc.autobk.' + serialSafe(); let saved = null;
    if (ms.length && Core.store.get(KEY, '') !== key) { const r = await backupAll(true); if (r && r.ok) { Core.store.set(KEY, key); saved = r; } }
    toast(`📲 Пульт DJI RC 2 подключён: заданий ${ms.length}${saved ? ' · копия всех заданий сохранена на Mac' : ''}`, 'ok', 6000, { label: 'Открыть', fn: open });
  }
  async function pollStatus() {
    let st; try { st = await api('/rc/status'); } catch (e) { return; }
    if (!st || !st.ok) return;
    if (st.present && !present) { present = true; autoDone = false; clearTimeout(autoT); autoT = setTimeout(autoConnect, 3500); }
    else if (!st.present && present) {
      present = false; autoDone = false; clearTimeout(autoT); autoT = null;
      if (!busy) { scan = null; render(); }
      toast('Пульт отключён', '', 3000);
    }
    badge();
  }
  function startAuto() { if (!window.WS_DESKTOP || !window.WS_RC_TOKEN || startAuto.on) return; startAuto.on = true; pollStatus(); setInterval(pollStatus, 3000); }
  if (window.WS_DESKTOP) setTimeout(startAuto, 500); else window.addEventListener('ws-desktop', () => setTimeout(startAuto, 500));

  function open() {
    if (!window.WS_DESKTOP || !window.WS_RC_TOKEN) return toast('Работа с пультом доступна в программе Waypoint Studio для macOS', 'err', 6000);
    last = null; view = 'main'; render(true); if ((!scan || !scan.ok) && !scanning) doScan();
  }
  return { open, readMission, buildKmz, capOf, renderPreview, get linked() { return S.m.rc || null; }, _t: { get scan() { return scan; }, get present() { return present; }, pollStatus, autoConnect, loadArchive, get arch() { return arch; } } };
})();
