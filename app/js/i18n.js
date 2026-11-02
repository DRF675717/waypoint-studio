// Interface language: Русский / English.
// The program is written in Russian; in English mode every text that appears on screen (HTML, tooltips, messages,
// dialogs, chart labels) is translated on the fly with the phrase dictionary in i18n-en.js (longest phrase first,
// whole words only). The route data itself (names, notes) is never translated.
const I18N = (() => {
  const read = () => { try { return JSON.parse(localStorage.getItem('ws.lang')) || 'ru'; } catch (e) { return 'ru'; } };
  const lang = read(), on = lang === 'en';
  const CYR = /[А-Яа-яЁё]/;
  let RE = null, D = null;
  function build() {
    D = window.WS_EN || {};
    const keys = Object.keys(D).sort((a, b) => b.length - a.length).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    RE = new RegExp('(?<![А-Яа-яЁё])(?:' + keys.join('|') + ')(?![А-Яа-яЁё])', 'g');
  }
  // «одна» phrase table for counts that the dictionary cannot know
  function tr(s) {
    if (!on || !s || !CYR.test(s)) return s;
    if (!RE) build();
    return s.replace(RE, m => D[m] ?? m);
  }

  // ---------- live translation of the page ----------
  const SKIP = 'script,style,textarea,input,.mname,#mName,.libname,.nolang,.leaflet-control-attribution';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip', 'alt'];
  const done = new WeakMap(); // text node → the text we wrote (so our own writes are not translated again)
  function textNode(n) {
    const v = n.nodeValue; if (!v || !CYR.test(v) || done.get(n) === v) return;
    const p = n.parentElement; if (p && p.closest(SKIP)) return;
    const t = tr(v); if (t !== v) { done.set(n, t); n.nodeValue = t; }
  }
  function attrs(el) {
    if (el.closest && el.closest('script,style')) return;
    for (const a of ATTRS) { const v = el.getAttribute && el.getAttribute(a); if (v && CYR.test(v)) { const t = tr(v); if (t !== v) el.setAttribute(a, t); } }
    if (el.tagName === 'OPTION' && CYR.test(el.label || '')) { /* option text is a text node */ }
    if ((el.tagName === 'INPUT' && /^(button|submit)$/.test(el.type)) && CYR.test(el.value)) el.value = tr(el.value);
  }
  function walk(root) {
    if (root.nodeType === 3) return textNode(root);
    if (root.nodeType !== 1) return;
    attrs(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT); let n;
    while ((n = w.nextNode())) n.nodeType === 3 ? textNode(n) : attrs(n);
  }
  function start() {
    document.documentElement.lang = 'en';
    document.title = tr(document.title);
    walk(document.body);
    new MutationObserver(ms => { for (const m of ms) {
      if (m.type === 'characterData') textNode(m.target);
      else if (m.type === 'attributes') attrs(m.target);
      else m.addedNodes.forEach(walk);
    } }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    // dialogs, canvas labels (height profile, 3D labels)
    const c = window.confirm, a = window.alert, pr = window.prompt;
    window.confirm = m => c.call(window, tr(String(m))); window.alert = m => a.call(window, tr(String(m))); window.prompt = (m, d) => pr.call(window, tr(String(m)), d);
    const ft = CanvasRenderingContext2D.prototype.fillText, st = CanvasRenderingContext2D.prototype.strokeText, mt = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.fillText = function (t, ...r) { return ft.call(this, tr(String(t)), ...r); };
    CanvasRenderingContext2D.prototype.strokeText = function (t, ...r) { return st.call(this, tr(String(t)), ...r); };
    CanvasRenderingContext2D.prototype.measureText = function (t) { return mt.call(this, tr(String(t))); };
  }
  if (on) { if (document.body) start(); else document.addEventListener('DOMContentLoaded', start); }

  function set(l) {
    l = l === 'en' ? 'en' : 'ru'; if (l === lang) return;
    try { localStorage.setItem('ws.lang', JSON.stringify(l)); } catch (e) { /* ignore */ }
    try { if (window.WS && WS.Core) WS.Core.store.set('ws.current', WS.Core.S.m); } catch (e) { /* ignore */ }
    // tell the desktop shell (menus) and reload: the whole interface is rebuilt in the new language
    try { if (window.WS_DESKTOP) fetch('/ui/lang?l=' + l, { method: 'POST', headers: { 'X-WS-Token': window.WS_RC_TOKEN || '' } }).catch(() => {}); } catch (e) { /* ignore */ }
    setTimeout(() => location.reload(), 120);
  }
  return { tr, set, get lang() { return lang; } };
})();
