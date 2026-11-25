'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

function make(name, def) {
  const file = path.join(app.getPath('userData'), name + '.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = structuredClone(def); }
  if (!Array.isArray(def)) data = { ...structuredClone(def), ...data };
  let t;
  const flush = () => {
    clearTimeout(t);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(data));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { console.error('store', name, e.message); }
  };
  return { get data() { return data; }, set(v) { data = v; this.save(); }, save() { clearTimeout(t); t = setTimeout(flush, 500); }, flush };
}

exports.init = () => {
  const s = {
    settings: make('settings', {
      search: 'https://www.google.com/search?q=%s',
      dns: 'quad9',
      httpsOnly: true,
      verify: true,                   // ask Windows Hello / Touch ID before filling or showing a password
      route: 'direct',                // 'direct' | 'proxy' | 'tor'
      proxy: '',                      // e.g. socks5://10.64.0.1:1080 (Mullvad), used when route is 'proxy'
      torPort: 9050,                  // 9150 if you use Tor Browser's daemon
      clearOnExit: false,
      theme: 'dusk',                  // see src/themes.js
      accent: '',                     // '' = the theme's own accent
      frost: 18,                      // blur strength of the glass tiles, px
      groupTabs: true,                // keep tabs of the same kind together
      adultBlock: false,              // block adult sites and adult ads
      fingerprint: true,              // look identical to every other user (canvas, webgl, audio, time zone ...)
      systemTor: false,               // send the whole PC through Tor (Windows proxy setting); off until you turn it on
      wordFilter: false,              // hide posts that mention filterWords, on every site
      filterWords: [],
      blockDomains: [],               // sites that never load
      softGpu: true,                  // draw WebGL and canvas on the CPU so the graphics card cannot leak (restart)
      noRtc: true,                    // remove WebRTC so local addresses cannot leak
      bgImage: '',                    // start-page picture (file name in userData)
      permissions: ['fullscreen', 'clipboard-sanitized-write', 'pointerLock'],
    }),
    bookmarks: make('bookmarks', {}),   // url -> { title, folder, added }
    history: make('history', {}),       // url -> { t, v, l }
    vault: make('vault', []),           // [{ h, o, u, p(base64 safeStorage) }]
    pins: make('pins', []),             // [{ title, url }] shown on the start screen
  };
  s.flush = () => { for (const k of ['settings', 'bookmarks', 'history', 'vault', 'pins']) s[k].flush(); };
  return s;
};

exports.SEARCH = {
  'Google': 'https://www.google.com/search?q=%s',
  'DuckDuckGo': 'https://duckduckgo.com/?q=%s',
  'Brave Search': 'https://search.brave.com/search?q=%s',
  'Startpage': 'https://www.startpage.com/do/search?q=%s',
};
