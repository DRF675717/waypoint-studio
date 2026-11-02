// In-app updates (desktop): the shell checks the update feed; here the user sees «⬆ Обновить до X» and installs with one click.
const WSUpdate = (() => {
  const api = (p, o = {}) => fetch(p, Object.assign({ cache: 'no-store', headers: { 'X-WS-Token': window.WS_RC_TOKEN || '' } }, o)).then(r => r.json());
  let avail = null, busy = false;
  async function check(manual, force) {
    if (!window.WS_DESKTOP || !window.WS_RC_TOKEN) return;
    let st; try { st = await api('/upd/status' + (manual || force ? '?check=1' : '')); } catch (e) { return; }
    if (!st || !st.ok) return;
    avail = st.available;
    const b = document.getElementById('updBtn');
    if (b) { b.hidden = !avail; if (avail) { b.textContent = `⬆ Обновить до ${avail.version}`; b.title = `Установлена ${st.current}. Доступна ${avail.version}${avail.notes ? ': ' + avail.notes : ''}`; } }
    if (manual) toast(avail ? `Доступна версия ${avail.version} (сейчас ${st.current})` : st.error ? 'Проверка обновлений: ' + st.error : `Установлена последняя версия (${st.current})`, avail ? 'ok' : st.error ? 'err' : '', 6000);
  }
  async function install() {
    if (!avail || busy) return;
    const notes = avail.notes ? `\n\nЧто нового:\n${avail.notes}` : '';
    if (!confirm(`Установить Waypoint Studio ${avail.version}?${notes}\n\nПрограмма закроется и откроется заново (около 10 секунд). Маршрут сохранён автоматически.`)) return;
    busy = true; toast('Загрузка и проверка обновления…', '', 15000);
    try { if (window.WS && WS.Core && WS.Core.S.m.waypoints.length) WS.Core.saveToLibrary(); } catch (e) { /* the editor keeps its autosave anyway */ }
    let r; try { r = await api('/upd/apply', { method: 'POST' }); } catch (e) { r = { ok: false, error: e.message }; }
    busy = false;
    toast(r.ok ? `Устанавливается ${r.version} — программа сейчас перезапустится` : 'Обновление не установлено: ' + r.error, r.ok ? 'ok' : 'err', 10000);
  }
  function start() { if (start.on || !window.WS_DESKTOP) return; start.on = true; const b = document.getElementById('updBtn'); if (b) b.onclick = install; setTimeout(check, 6000); setInterval(() => check(false, true), 30 * 60 * 1000); }
  if (window.WS_DESKTOP) setTimeout(start, 300); else window.addEventListener('ws-desktop', () => setTimeout(start, 300));
  return { check, install };
})();
