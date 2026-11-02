// Waypoint Studio — loader (stays inside the signed app bundle; changes only with a full update).
// The program itself (core.js + www) can come from a «light» update stored in userData/live/<version>:
// it is used when it was built for this shell and is newer than the bundled copy. If a light version fails
// to start (the window never loaded), the next launch marks it bad and falls back to the bundled program.
const { app } = require('electron');
const fs = require('fs'), path = require('path');
const SHELL = 1; // bump when Electron, the USB bridge or this loader change → light updates for the old shell stop applying
const vnum = v => String(v || '0').split('.').map(x => parseInt(x, 10) || 0);
const newer = (a, b) => { const x = vnum(a), y = vnum(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
global.WS = { bundleDir: __dirname, shell: SHELL, bundleVersion: require('./package.json').version, version: require('./package.json').version, liveDir: null };
let loaded = false;
try {
  const live = path.join(app.getPath('userData'), 'live'), cur = fs.readFileSync(path.join(live, 'current'), 'utf8').trim();
  const d = path.join(live, cur), man = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8'));
  const probe = path.join(d, '.starting'), bad = path.join(d, '.failed');
  if (/^[0-9.]+$/.test(cur) && man.shell === SHELL && newer(man.version, global.WS.version) && !fs.existsSync(bad) && fs.existsSync(path.join(d, 'core.js'))) {
    if (fs.existsSync(probe)) fs.renameSync(probe, bad); // the previous start of this version never opened its window
    else {
      fs.writeFileSync(probe, String(Date.now()));
      global.WS.liveDir = d; global.WS.version = man.version;
      try { require(path.join(d, 'core.js')); loaded = true; } catch (e) { try { fs.renameSync(probe, bad); } catch (x) { /* ignore */ } global.WS.liveDir = null; global.WS.version = global.WS.bundleVersion; }
    }
  }
} catch (e) { /* no light version — use the bundled program */ }
if (!loaded) require('./core.js');
