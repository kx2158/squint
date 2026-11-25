'use strict';
const { app, BaseWindow, BrowserWindow, WebContentsView, nativeImage, systemPreferences, ipcMain, session, shell, nativeTheme, Menu, dialog, screen, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Never fail silently: show the error and write it next to the app as error.log
function log(msg) {
  try { fs.appendFileSync(path.join(__dirname, 'error.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}
function fatal(e) {
  const msg = (e && e.stack) || String(e);
  log(msg);
  try { dialog.showErrorBox('Browser hit an error', msg.slice(0, 1500)); } catch { /* ignore */ }
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
const { pathToFileURL } = require('node:url');
const privacy = require('./src/privacy');
privacy.applySwitches(app);

const BRAND = require('./brand.json').name;
app.setName(BRAND);
{ // keep data from earlier installs (they used the old name for the data folder)
  const old = path.join(app.getPath('appData'), 'Plain');
  if (fs.existsSync(old)) app.setPath('userData', old);
}

const storeLib = require('./src/store');
const vault = require('./src/vault');
const brave = require('./src/brave-import');
const { loadBlocker, domainsOnly, selfTest } = require('./src/blocker');
const tor = require('./src/tor');
const sysproxy = require('./src/sysproxy');
const verify = require('./src/verify');
const crypto = require('node:crypto');
const themesLib = require('./src/themes');
const adultLib = require('./src/adult');
const fpLib = require('./src/fingerprint');

const CHROME_H = 82;
const UI_DIR = path.join(__dirname, 'ui');
const UI_FILE_URL = pathToFileURL(UI_DIR).href;
const NEWTAB = pathToFileURL(path.join(UI_DIR, 'newtab.html')).href;
const SETTINGS = pathToFileURL(path.join(UI_DIR, 'settings.html')).href;
const PART = 'persist:web';

let S, win, ui, blocker, blockerInfo = { engine: false, domains: 0, resources: false, lists: 0 }, overlay = false, activeId = null, nextId = 1, fsView = false;
const tabs = new Map();
const order = [];
const blocked = new Map();   // webContents id -> count
let restoring = false;
const closed = [];           // recently closed tab urls (Ctrl+Shift+T)
const fillIdx = new Map();   // host -> index

const isInternal = (u) => u.startsWith(UI_FILE_URL);
const active = () => tabs.get(activeId);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const u = argv.find((a) => /^https?:\/\//i.test(a));
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    if (u) newTab(u);
  });
  app.whenReady().then(init).catch((e) => { fatal(e); app.quit(); });
}

app.on('window-all-closed', () => app.quit());
let cleaned = false;
app.on('before-quit', async (e) => {
  if (!S) return;
  S.flush();
  tor.stop();
  try { if (S.settings.data.sysProxyPrev !== undefined && S.settings.data.systemTor) sysproxy.disable(S.settings.data.sysProxyPrev); } catch { /* best effort */ }
  if (S.settings.data.clearOnExit && !cleaned) {
    e.preventDefault();
    cleaned = true;
    const ses = session.fromPartition(PART);
    await ses.clearStorageData();
    await ses.clearCache();
    app.quit();
  }
});

// Traffic route. Anything that cannot be satisfied fails closed (dead proxy), never direct.
async function applyRoute() {
  const s = S.settings.data;
  const ses = session.fromPartition(PART);
  let proxy = '', result = { ok: true };
  if (s.route === 'tor') {
    proxy = `socks5://127.0.0.1:${s.torPort}`;
    result = await tor.ensure(__dirname, path.join(app.getPath('userData'), 'tor'), s.torPort);
  } else {
    tor.stop();
    if (s.route === 'proxy') {
      proxy = s.proxy.trim();
      if (!proxy) { proxy = 'socks5://127.0.0.1:1'; result = { ok: false, error: 'Enter a proxy address.' }; }
    }
  }
  try { await privacy.applyProxy(ses, proxy); } catch (e) { await privacy.applyProxy(ses, 'socks5://127.0.0.1:1'); result = { ok: false, error: e.message }; }
  push();
  return result;
}

async function init() {
  S = storeLib.init();
  vault.migrate(S.vault);
  applyThemeSource();
  if (S.settings.data.adultBlock) privacy.loadAdult(path.join(__dirname, 'lists', 'adult.dat'));
  if (!S.settings.data.googleDefault) { S.settings.data.googleDefault = true; S.settings.data.search = storeLib.SEARCH.Google; S.settings.save(); }
  privacy.applyDns(app, S.settings.data.dns);

  // The browser UI itself may never touch the network.
  session.fromPartition('ui').webRequest.onBeforeRequest((d, cb) =>
    cb({ cancel: !(d.url.startsWith('file://') || d.url.startsWith('devtools://')) }));

  const ses = session.fromPartition(PART);
  const listDir = path.join(__dirname, 'lists');
  const count = (req) => { blocked.set(req.tabId ?? req.webContentsId, (blocked.get(req.tabId ?? req.webContentsId) || 0) + 1); pushSoon(); };
  const bootBlocker = () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = loadBlocker(listDir, app.getPath('userData'));
        if (!r.files) console.warn('No filter lists found. Run: npm run lists');
        r.blocker.on('request-blocked', count);
        return r;
      } catch (e) {
        log('blocker load failed (try ' + (attempt + 1) + '): ' + e.message);
        for (const f of ['engine.bin', 'engine.key', 'domains.txt']) { try { fs.unlinkSync(path.join(app.getPath('userData'), f)); } catch { /* none */ } }
      }
    }
    return null;
  };
  const boot = bootBlocker();
  blocker = boot ? boot.blocker : null;
  blockerInfo = { engine: !!blocker, domains: boot ? boot.domains.size : 0, resources: !!(boot && boot.resources), lists: boot ? boot.files : 0 };
  const domains = boot ? boot.domains : domainsOnly(listDir);
  if (!blocker) { blockerInfo.domains = domains.size; setTimeout(() => toast('Ad blocker engine did not load. Basic domain blocking is on.'), 2500); }
  const hard = privacy.harden(ses, { blocker, domains, settings: () => S.settings.data, onBlocked: (d) => count({ tabId: d.webContentsId }) });
  // watchdog: prove the engine still blocks a known ad request, rebuild it if not
  setInterval(() => {
    if (blocker && selfTest(blocker)) return;
    log('blocker self-test failed, rebuilding');
    for (const f of ['engine.bin', 'engine.key', 'domains.txt']) { try { fs.unlinkSync(path.join(app.getPath('userData'), f)); } catch { /* none */ } }
    const nb = bootBlocker();
    if (nb) { blocker = nb.blocker; hard.setBlocker(blocker); blockerInfo.engine = true; }
  }, 180000).unref();
  ses.on('will-download', (_e, item) => {
    item.once('done', (_ev, st) => toast(st === 'completed' ? `Downloaded ${item.getFilename()}` : 'Download did not finish'));
  });
  // Hide what you visit from the local network: new installs and this update start on Tor once.
  // Turn it off in Settings > Privacy & network.
  if (!S.settings.data.hideDefault) {
    S.settings.data.hideDefault = true;
    if (S.settings.data.route === 'direct') { S.settings.data.prevRoute = 'direct'; S.settings.data.route = 'tor'; }
    S.settings.save();
  }
  // fingerprint script for every frame; the noise seed is new each launch
  const fpSeen = new Set();
  ipcMain.on('fp:log', (_e, m) => { if (fpSeen.size < 8 && !fpSeen.has(m)) { fpSeen.add(m); log('fingerprint script: ' + m); } });
  const fpSeed = crypto.randomBytes(8).toString('hex');
  // words the page script hides posts for (preload/page.js)
  ipcMain.on('wf:get', (e) => { const s = S.settings.data; e.returnValue = s.wordFilter && Array.isArray(s.filterWords) ? s.filterWords : []; });
  ipcMain.on('fp:get', (e) => {
    const s = S.settings.data;
    e.returnValue = s.fingerprint === false ? {} : { script: fpLib.build({ seed: fpSeed, chrome: privacy.CHROME_V, noRtc: s.noRtc !== false, strict: s.canvasMode !== 'noise', letterbox: s.letterbox !== false }) };
  });
  const routed = await applyRoute(); // route is in place before any page can load
  if (S.settings.data.systemTor) {
    try { if (S.settings.data.route === 'tor' && tor.isOwn()) S.settings.data.sysProxyPrev = sysproxy.enable(S.settings.data.torPort + 2, S.settings.data.sysProxyPrev || null); else { sysproxy.disable(S.settings.data.sysProxyPrev || null); S.settings.data.systemTor = false; delete S.settings.data.sysProxyPrev; } S.settings.save(); } catch { /* leaves Windows as it was */ }
  }
  if (!routed.ok) setTimeout(() => toast((routed.error || 'The route is down') + ' - nothing loads until it works. Settings > Privacy & network.'), 2500);

  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  else Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
  ]));

  createWindow();
  registerIpc();
  // tabs come back after a restart or update, and Ctrl+Shift+T still has what you closed last time
  if (!S.settings.data.restoreDefault) { S.settings.data.restoreDefault = true; S.settings.data.startup = 'restore'; S.settings.save(); }
  if (Array.isArray(S.settings.data.closedTabs)) closed.push(...S.settings.data.closedTabs.filter((u) => /^https?:/i.test(u)).slice(-20));
  const arg = process.argv.find((a) => /^https?:\/\//i.test(a));
  const saved = S.settings.data.startup === 'restore' && Array.isArray(S.settings.data.lastTabs) ? S.settings.data.lastTabs.filter((u) => /^https?:/i.test(u)).slice(0, 30) : [];
  if (saved.length) { restoring = true; saved.forEach((u) => newTab(u)); restoring = false; if (arg) newTab(arg); else selectTab(order[Math.min(S.settings.data.lastActive || 0, order.length - 1)]); }
  else newTab(arg || NEWTAB);
}

function sysAccent() {
  try { const a = String(systemPreferences.getAccentColor() || ''); return /^[0-9a-f]{6}/i.test(a) ? '#' + a.slice(0, 6) : ''; } catch { return ''; }
}
const ICON = path.join(__dirname, 'assets', 'icon.png');
function look() { const l = themesLib.resolve(S ? S.settings.data : {}, nativeTheme.shouldUseDarkColors, sysAccent()); l.calm = !!(S && S.settings.data.calm); return l; }
function themeColors() { const l = look(); return { bg: l.bg, fg: l.fg, title: l.titleBg }; }
function applyThemeSource() {
  const t = (themesLib.LIST.find((x) => x.id === (S.settings.data.theme || 'dusk')) || {}).dark;
  nativeTheme.themeSource = t === null || t === undefined ? 'system' : t ? 'dark' : 'light';
}
function applyLook() {
  applyThemeSource();
  const c = themeColors();
  if (win) {
    win.setBackgroundColor(c.bg);
    if (process.platform === 'win32') { try { win.setAccentColor(false); } catch { /* old Windows */ } }
    if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: c.title, symbolColor: c.fg, height: 38 });
  }
  for (const t of tabs.values()) {
    t.view.setBackgroundColor(c.bg);
    if (t.url === NEWTAB && !t.errUrl) t.view.webContents.reload();
  }
  push();
}

function createWindow() {
  const c = themeColors();
  win = new BaseWindow({
    width: 1360, height: 860, minWidth: 560, minHeight: 400, backgroundColor: c.bg, title: BRAND,
    titleBarStyle: 'hidden', icon: ICON,
    accentColor: false,      // no coloured/grey outline Windows draws around the window
    roundedCorners: false,   // sharp outer window corners (Windows 11)
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 12 } }
      : { titleBarOverlay: { color: c.title, symbolColor: c.fg, height: 38 } }),
  });
  nativeTheme.on('updated', () => { if (win) applyLook(); });
  try { systemPreferences.on('accent-color-changed', () => { if (win) applyLook(); }); } catch { /* not on this OS */ }

  ui = new WebContentsView({
    webPreferences: {
      partition: 'ui', preload: path.join(__dirname, 'preload', 'ui.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false,
    },
  });
  ui.setBackgroundColor('#00000000');
  win.contentView.addChildView(ui);
  ui.webContents.loadFile(path.join(UI_DIR, 'index.html'));
  // Anything the browser UI complains about (blocked scripts, JS errors) goes to error.log
  ui.webContents.on('console-message', (...a) => {
    const d = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2], sourceId: a[4], lineNumber: a[3] };
    if (/error|warn/i.test(String(d.level)) || d.level >= 2) log(`ui console: ${d.message} (${d.sourceId}:${d.lineNumber})`);
  });
  hook(ui.webContents);
  win.on('resize', layout);
  win.on('closed', () => app.quit());
  layout();
}

function layout() {
  if (!win) return;
  const { width: w, height: h } = win.getContentBounds();
  ui.setBounds({ x: 0, y: 0, width: w, height: overlay ? h : CHROME_H });
  const t = active();
  if (!t) return;
  if (fsView) return t.view.setBounds({ x: 0, y: 0, width: w, height: h });
  let b = { x: 0, y: CHROME_H, width: w, height: h - CHROME_H };
  // Letterboxing: web pages get a viewport rounded down to 200 x 100 steps, centred, so the exact
  // window size cannot be used to tell you apart. Scripts see this size as the screen size too.
  if (S && S.settings.data.letterbox !== false && /^https?:/i.test(t.url)) {
    const lw = Math.max(200, Math.floor(b.width / 200) * 200), lh = Math.max(100, Math.floor(b.height / 100) * 100);
    b = { x: Math.floor((b.width - lw) / 2), y: CHROME_H, width: lw, height: lh };
  }
  t.view.setBounds(b);
}

function setOverlay(on) { overlay = !!on; layout(); }

// ---------- tabs ----------
function newTab(url, activate = true) {
  const id = nextId++;
  const view = new WebContentsView({
    webPreferences: {
      partition: PART, preload: path.join(__dirname, 'preload', 'page.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false,
      webSecurity: true, allowRunningInsecureContent: false, nodeIntegrationInSubFrames: true,
    },
  });
  view.setBackgroundColor(themeColors().bg);
  const wc = view.webContents;
  const t = { id, view, title: '', url: url || NEWTAB, loading: false, errUrl: null };
  tabs.set(id, t);
  order.push(id);
  hook(wc);

  wc.setWindowOpenHandler(({ url: u }) => { if (/^https?:/i.test(u)) newTab(u); return { action: 'deny' }; });
  wc.on('will-navigate', (e, u) => { if (!/^(https?|file):/i.test(u)) e.preventDefault(); });
  wc.on('page-title-updated', (_e, title) => { t.title = title; if (/^https?:/.test(t.url)) recordVisit(t.url, title); push(); });
  wc.on('found-in-page', (_e, r) => { if (activeId === id && ui && !ui.webContents.isDestroyed()) ui.webContents.send('found', { active: r.activeMatchOrdinal, total: r.matches }); });
  wc.on('did-start-loading', () => { t.loading = true; push(); });
  wc.on('did-stop-loading', () => { t.loading = false; push(); });
  wc.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) blocked.set(wc.id, 0); });
  wc.on('did-navigate', (_e, u) => {
    t.url = u;
    if (activeId === id) layout();
    if (!isInternal(u)) { t.errUrl = null; recordVisit(u, ''); }
    settleTab(t);
    push();
  });
  wc.on('did-navigate-in-page', (_e, u, isMain) => { if (isMain) { t.url = u; push(); } });
  wc.on('did-fail-load', (_e, code, desc, u, isMain) => {
    if (!isMain || code === -3 || isInternal(u)) return;
    t.errUrl = u;
    wc.loadFile(path.join(UI_DIR, 'error.html'), { query: { code: String(code), desc, url: u, filter: S.settings.data.adultBlock && code === -20 ? '1' : '' } });
  });
  wc.on('enter-html-full-screen', () => { fsView = true; ui.setVisible(false); win.setFullScreen(true); layout(); });
  wc.on('leave-html-full-screen', () => { fsView = false; ui.setVisible(true); win.setFullScreen(false); layout(); });
  wc.on('destroyed', () => blocked.delete(wc.id));
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL) items.push({ label: 'Open link in new tab', click: () => newTab(p.linkURL) }, { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
    if (p.mediaType === 'image' && p.srcURL) items.push({ label: 'Open image in new tab', click: () => newTab(p.srcURL) }, { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) }, { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) }, { type: 'separator' });
    if (p.selectionText) {
      const q = p.selectionText.trim().slice(0, 80);
      items.push({ role: 'copy' }, { label: `Search for "${q.length > 24 ? q.slice(0, 24) + '...' : q}"`, click: () => newTab(searchUrl(p.selectionText.trim())) });
    }
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'paste' }, { role: 'selectAll' });
    items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() }, { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() }, { label: 'Reload', click: () => wc.reload() }, { type: 'separator' }, { label: 'Print...', click: () => wc.print() }, { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  load(wc, t.url);
  if (activate) selectTab(id);
  return id;
}

function load(wc, url) { wc.loadURL(url).catch(() => { /* aborted / failed loads are handled by did-fail-load */ }); }

function selectTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  const prev = active();
  activeId = id;
  if (!prev || prev.id !== id) {
    // The new page goes in underneath (index 0) with its final size, the UI stays on top untouched,
    // and the old page is removed a frame later, so switching never shows an empty frame.
    win.contentView.addChildView(t.view, 0);
    layout();
    if (prev) setTimeout(() => { if (activeId !== prev.id) { try { win.contentView.removeChildView(prev.view); } catch { /* gone */ } } }, 24);
  } else layout();
  if (isInternal(t.url) && !t.errUrl) { ui.webContents.focus(); focusUrl(); } else t.view.webContents.focus();
  push();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  const i = order.indexOf(id);
  order.splice(i, 1);
  tabs.delete(id);
  if (/^https?:/i.test(t.url)) {
    closed.push(t.url); if (closed.length > 20) closed.shift();
    if (S) { S.settings.data.closedTabs = closed.slice(); S.settings.save(); }
  }
  try { win.contentView.removeChildView(t.view); } catch { /* already removed */ }
  t.view.webContents.close();
  if (!order.length) return app.quit();
  if (activeId === id) selectTab(order[Math.min(i, order.length - 1)]);
  else push();
}

function cycle(d) {
  const i = order.indexOf(activeId);
  selectTab(order[(i + d + order.length) % order.length]);
}

// ---------- tab kinds (used to keep similar tabs together) ----------
const KINDS = [
  { id: 'start', name: 'Start', color: '', test: () => false },
  { id: 'search', name: 'Search', color: '#5b7cfa', re: /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|startpage\.com|search\.brave\.com|ecosia\.org)$/ },
  { id: 'work', name: 'Work', color: '#38bdf8', re: /(^|\.)(gmail\.com|mail\.google\.com|docs\.google\.com|drive\.google\.com|calendar\.google\.com|outlook\.[a-z.]+|office\.com|live\.com|notion\.so|slack\.com|figma\.com|proton\.me|zoom\.us|trello\.com|atlassian\.net)$/ },
  { id: 'code', name: 'Code', color: '#34d399', re: /(^|\.)(github\.com|gitlab\.com|stackoverflow\.com|stackexchange\.com|npmjs\.com|developer\.mozilla\.org|codepen\.io|replit\.com|huggingface\.co|pypi\.org|crates\.io)$/ },
  { id: 'read', name: 'Reading', color: '#a78bfa', re: /(^|\.)(wikipedia\.org|medium\.com|substack\.com|nytimes\.com|bbc\.[a-z.]+|theguardian\.com|news\.ycombinator\.com|arxiv\.org)$/ },
  { id: 'social', name: 'Social', color: '#f472b6', re: /(^|\.)(x\.com|twitter\.com|instagram\.com|facebook\.com|reddit\.com|tiktok\.com|discord\.com|bsky\.app|linkedin\.com|pinterest\.com|tumblr\.com|threads\.net|whatsapp\.com|telegram\.org)$/ },
  { id: 'video', name: 'Watch & listen', color: '#f87171', re: /(^|\.)(youtube\.com|youtu\.be|twitch\.tv|netflix\.com|vimeo\.com|spotify\.com|soundcloud\.com|disneyplus\.com|primevideo\.com|bandcamp\.com|music\.apple\.com)$/ },
  { id: 'shop', name: 'Shopping', color: '#fbbf24', re: /(^|\.)(amazon\.[a-z.]+|ebay\.[a-z.]+|etsy\.com|aliexpress\.com|temu\.com|zalando\.[a-z.]+|shopify\.com)$/ },
  { id: 'other', name: 'Other', color: '#9ca3af', re: null },
];
function kindOf(url) {
  if (!/^https?:/i.test(url)) return KINDS[0];
  let h = ''; try { h = new URL(url).hostname.toLowerCase(); } catch { return KINDS[KINDS.length - 1]; }
  return KINDS.find((k) => k.re && k.re.test(h)) || KINDS[KINDS.length - 1];
}
const kindRank = (id) => (id === 'start' ? 100 : KINDS.findIndex((k) => k.id === id));
function regroupAll() {
  const tabsIn = order.map((id) => ({ id, r: kindRank(kindOf(tabs.get(id).url).id) }));
  tabsIn.sort((a, b) => a.r - b.r); // Array.sort is stable: order inside a kind is kept
  order.splice(0, order.length, ...tabsIn.map((x) => x.id));
}
function settleTab(t) {
  if (!S.settings.data.groupTabs) return;
  const k = kindOf(t.url).id;
  if (t.kind === k) return;
  t.kind = k;
  if (k === 'start') return;
  const mine = kindRank(k);
  order.splice(order.indexOf(t.id), 1);
  let at = order.length;
  for (let i = order.length - 1; i >= 0; i--) { if (kindRank(kindOf(tabs.get(order[i]).url).id) <= mine) { at = i + 1; break; } if (i === 0) at = 0; }
  order.splice(at, 0, t.id);
}

// ---------- navigation ----------
function searchUrl(q) {
  let tpl = S.settings.data.search;
  if (S.settings.data.adultBlock) {
    if (/google\./.test(tpl)) tpl += '&safe=active';
    else if (/duckduckgo/.test(tpl)) tpl += '&kp=1';
    else if (/bing\./.test(tpl)) tpl += '&adlt=strict';
    else if (/search\.brave/.test(tpl)) tpl += '&safesearch=strict';
  }
  return tpl.replace('%s', encodeURIComponent(q));
}
function resolve(input) {
  input = input.trim();
  if (!input) return NEWTAB;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return /^(https?|file):/i.test(input) ? input : searchUrl(input);
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?([/?#]|$)/i.test(input)) return 'http://' + input;
  if (!/\s/.test(input) && /^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(input)) return 'https://' + input;
  return searchUrl(input);
}

function navigate(input) {
  const t = active();
  if (!t) return newTab(resolve(input));
  load(t.view.webContents, resolve(input));
  t.view.webContents.focus();
}

// ---------- shortcuts ----------
function hook(wc) {
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const c = i.control || i.meta;
    const k = i.key.toLowerCase();
    const t = active();
    const awc = t && t.view.webContents;
    let handled = true;
    if (c && i.shift && k === 'l') fillPassword();
    else if (c && i.shift && k === 't') { const u = closed.pop(); if (u) newTab(u); }
    else if (c && k === 't') newTab(NEWTAB);
    else if (c && k === 'w') closeTab(activeId);
    else if ((c && k === 'l') || (i.alt && k === 'd')) focusUrl();
    else if (c && k === ',') openSettings();
    else if (c && k === 'f') { ui.webContents.focus(); ui.webContents.send('openFind'); }
    else if (k === 'f11') win.setFullScreen(!win.isFullScreen());
    else if (c && k === 'p') awc && awc.print();
    else if (k === 'f5' || (c && k === 'r')) awc && awc.reload();
    else if (i.alt && k === 'arrowleft') awc && awc.navigationHistory.goBack();
    else if (i.alt && k === 'arrowright') awc && awc.navigationHistory.goForward();
    else if (c && k === 'd') toggleBookmark();
    else if (c && k === 'tab') cycle(i.shift ? -1 : 1);
    else if (c && k === 'pagedown') cycle(1);
    else if (c && k === 'pageup') cycle(-1);
    else if (c && /^[1-9]$/.test(k)) selectTab(order[k === '9' ? order.length - 1 : Math.min(+k - 1, order.length - 1)]);
    else if (c && (k === '=' || k === '+')) awc && awc.setZoomLevel(awc.getZoomLevel() + 0.5);
    else if (c && k === '-') awc && awc.setZoomLevel(awc.getZoomLevel() - 0.5);
    else if (c && k === '0') awc && awc.setZoomLevel(0);
    else if (k === 'f12' || (c && i.shift && k === 'i')) awc && awc.toggleDevTools();
    else handled = false;
    if (handled) e.preventDefault();
  });
}

function focusUrl() { ui.webContents.focus(); ui.webContents.send('focusUrl'); }
function toast(msg) { ui.webContents.send('toast', msg); }

// ---------- data ----------
function recordVisit(url, title) {
  if (!/^https?:/i.test(url)) return;
  const h = S.history.data;
  const e = h[url] || (h[url] = { t: '', v: 0, l: 0 });
  e.v++; e.l = Date.now();
  if (title) e.t = title;
  S.history.save();
}

function addPin(url) {
  let u;
  try { u = new URL(url); } catch { return; }
  if (!/^https?:$/.test(u.protocol) || S.pins.data.some((p) => p.url === u.href)) return;
  S.pins.data.push({ title: u.hostname.replace(/^www\./, ''), url: u.href });
  S.pins.save();
}

function toggleBookmark() {
  const t = active();
  if (!t || !/^https?:/i.test(t.url)) return;
  const b = S.bookmarks.data;
  if (b[t.url]) delete b[t.url]; else b[t.url] = { title: t.title || t.url, folder: '', added: Date.now() };
  S.bookmarks.save();
  push();
}

function suggest(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const res = [];
  const test = (url, title) => { const s = (url + ' ' + title).toLowerCase(); return words.every((w) => s.includes(w)); };
  for (const [url, b] of Object.entries(S.bookmarks.data)) if (test(url, b.title)) res.push({ url, title: b.title, s: 1e6 });
  for (const [url, e] of Object.entries(S.history.data)) {
    if (!test(url, e.t)) continue;
    const bm = S.bookmarks.data[url];
    if (bm) continue;
    res.push({ url, title: e.t, s: e.v * 5 + e.l / 1e10 });
  }
  return res.sort((a, b) => b.s - a.s).slice(0, 7).map(({ url, title }) => ({ url, title }));
}

// ---- unlock: Windows Hello / Touch ID, or your own passcode, remembered for two minutes ----
let unlockUntil = 0, unlockWin = null;
const UNLOCK_TTL = 120000;
const isUnlocked = () => S.settings.data.verify === false || Date.now() < unlockUntil;
const hashPass = (p, salt) => crypto.scryptSync(String(p), Buffer.from(salt, 'hex'), 32).toString('hex');
const passOk = (p) => {
  const x = S.settings.data.pass;
  if (!x) return false;
  try { return crypto.timingSafeEqual(Buffer.from(hashPass(p, x.salt), 'hex'), Buffer.from(x.hash, 'hex')); } catch { return false; }
};
function askUnlock(reason, mode = 'unlock') {
  if (mode === 'unlock' && isUnlocked()) return Promise.resolve({ ok: true });
  if (unlockWin) { unlockWin.focus(); return Promise.resolve({ ok: false, error: 'Unlock window is already open.' }); }
  return new Promise((resolve) => {
    let done = false, fails = 0, wait = 0;
    const finish = (r) => { if (done) return; done = true; if (r.ok) unlockUntil = Date.now() + UNLOCK_TTL; resolve(r); try { w.close(); } catch { /* closed */ } };
    const c = themeColors();
    const w = new BrowserWindow({
      parent: win, modal: true, width: 400, height: 330, resizable: false, minimizable: false, maximizable: false,
      show: false, autoHideMenuBar: true, title: BRAND, icon: ICON, backgroundColor: c.bg,
      webPreferences: { partition: 'ui', preload: path.join(__dirname, 'preload', 'unlock.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    unlockWin = w;
    w.removeMenu();
    const mine = (e) => e.sender === w.webContents;
    const h = (name, fn) => ipcMain.handle('unlock:' + name, (e, ...a) => { if (!mine(e)) throw new Error('forbidden'); return fn(...a); });
    const names = ['init', 'pass', 'hello', 'set', 'cancel'];
    for (const n of names) ipcMain.removeHandler('unlock:' + n);
    h('init', () => ({ reason, mode, hasPass: !!S.settings.data.pass, platform: process.platform }));
    h('pass', (p) => {
      if (Date.now() < wait) return { ok: false, error: 'Wait a moment before trying again.' };
      if (passOk(p)) { finish({ ok: true }); return { ok: true }; }
      if (++fails >= 3) { wait = Date.now() + Math.min(30000, 2000 * fails); }
      return { ok: false, error: 'Wrong passcode.' };
    });
    h('hello', async () => {
      const r = await verify.check(reason);
      if (r.ok) finish({ ok: true });
      return r;
    });
    h('set', (p) => {
      p = String(p || '');
      if (p.length < 4) return { ok: false, error: 'Use at least 4 characters.' };
      const salt = crypto.randomBytes(16).toString('hex');
      S.settings.data.pass = { salt, hash: hashPass(p, salt) };
      S.settings.save();
      finish({ ok: true });
      return { ok: true };
    });
    h('cancel', () => { finish({ ok: false, error: 'Cancelled.' }); return true; });
    w.on('closed', () => { unlockWin = null; for (const n of names) ipcMain.removeHandler('unlock:' + n); finish({ ok: false, error: 'Cancelled.' }); });
    w.once('ready-to-show', () => w.show());
    w.loadFile(path.join(UI_DIR, 'unlock.html'));
  });
}
const gate = (reason) => askUnlock(reason);
const fillable = (u) => /^https:/i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(u);

function openSettings(section) {
  for (const id of order) {
    const t = tabs.get(id);
    if (t.url.startsWith(SETTINGS)) { selectTab(id); if (section) load(t.view.webContents, SETTINGS + '#' + section); return; }
  }
  newTab(SETTINGS + (section ? '#' + section : ''));
}

async function fillPassword() {
  const t = active();
  if (!t || !fillable(t.url)) return;
  const list = vault.find(S.vault, t.url);
  if (!list.length) return toast('No saved login for this site');
  const v = await gate('Fill saved login');
  if (!v.ok) return toast(v.error);
  const host = vault.hostKey(t.url);
  const i = ((fillIdx.get(host) ?? -1) + 1) % list.length;
  fillIdx.set(host, i);
  const c = list[i];
  const js = `(()=>{const u=${JSON.stringify(c.user)},p=${JSON.stringify(c.pass)};
    const vis=e=>!!(e.offsetWidth||e.offsetHeight);
    const pw=[...document.querySelectorAll('input[type=password]')].find(vis);
    if(!pw)return false;
    const all=[...document.querySelectorAll('input')].filter(vis);
    const un=all.slice(0,all.indexOf(pw)).reverse().find(x=>/^(text|email|tel|)$/i.test(x.type));
    const set=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
      el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
    if(un)set(un,u);set(pw,p);return true;})()`;
  t.view.webContents.executeJavaScript(js).then((ok) =>
    toast(ok ? `Filled ${c.user || 'login'}${list.length > 1 ? ` (${i + 1} of ${list.length})` : ''}` : 'No password field found'));
}

// ---------- state push ----------
let pending = false;
function pushSoon() { if (pending) return; pending = true; setTimeout(() => { pending = false; push(); }, 120); }

function push() {
  if (!ui || ui.webContents.isDestroyed()) return;
  if (S && S.settings.data.startup === 'restore' && !restoring) {
    S.settings.data.lastTabs = order.map((id) => tabs.get(id).url).filter((u) => /^https?:/i.test(u));
    S.settings.data.lastActive = Math.max(0, order.indexOf(activeId));
    S.settings.save();
  }
  const t = active();
  const wc = t && t.view.webContents;
  ui.webContents.send('state', {
    active: activeId,
    theme: look(),
    groups: !!S.settings.data.groupTabs,
    tabs: order.map((id) => {
      const x = tabs.get(id);
      const internal = isInternal(x.url) && !x.errUrl;
      const kd = kindOf(x.url);
      return { id, kind: kd.id, kindName: kd.name, color: kd.color, loading: x.loading, title: x.errUrl ? 'Cannot reach site' : internal ? (x.title || 'New tab') : (x.title || x.url) };
    }),
    nav: t && {
      url: t.errUrl || (isInternal(t.url) ? '' : t.url),
      canBack: wc.navigationHistory.canGoBack(),
      canFwd: wc.navigationHistory.canGoForward(),
      loading: t.loading,
      blocked: blocked.get(wc.id) || 0,
      route: S.settings.data.route,
      bookmarked: !!S.bookmarks.data[t.url],
      secure: t.url.startsWith('https:'),
    },
  });
}

// ---------- IPC ----------
function registerIpc() {
  const on = (name, fn) => ipcMain.handle('ui:' + name, (e, ...a) => {
    if (e.sender !== ui.webContents) throw new Error('forbidden');
    return fn(...a);
  });
  on('ready', () => push());
  on('newTab', () => newTab(NEWTAB));
  on('closeTab', (id) => closeTab(id));
  on('find', (text, fwd, next) => { const t = active(); if (t && text) t.view.webContents.findInPage(String(text), { forward: !!fwd, findNext: !!next }); });
  on('findStop', () => { const t = active(); if (t) t.view.webContents.stopFindInPage('clearSelection'); });
  on('urlMenu', () => {
    Menu.buildFromTemplate([
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { label: 'Paste and go', enabled: !!clipboard.readText().trim(), click: () => navigate(clipboard.readText().trim().split(/\r?\n/)[0]) },
      { type: 'separator' }, { role: 'selectAll' },
    ]).popup({ window: win });
  });
  on('tabMenu', (id) => {
    const t = tabs.get(id);
    const i = order.indexOf(id);
    const web = t && /^https?:/i.test(t.url);
    const items = [{ label: 'New tab', click: () => newTab(NEWTAB) }];
    if (t) {
      items.push(
        { type: 'separator' },
        { label: 'Reload', click: () => t.view.webContents.reload() },
        { label: 'Duplicate', click: () => { const nid = newTab(t.url, true); const k = order.indexOf(nid); order.splice(k, 1); order.splice(order.indexOf(id) + 1, 0, nid); push(); } },
        { label: 'Pin to start page', enabled: !!web, click: () => { addPin(t.url); toast('Pinned'); } },
        { label: 'Copy address', enabled: !!web, click: () => clipboard.writeText(t.url) },
        { type: 'separator' },
        { label: 'Close', click: () => closeTab(id) },
        { label: 'Close other tabs', enabled: order.length > 1, click: () => order.filter((x) => x !== id).forEach(closeTab) },
        { label: 'Close tabs to the right', enabled: i < order.length - 1, click: () => order.slice(i + 1).forEach(closeTab) },
      );
    }
    items.push({ type: 'separator' }, { label: 'Reopen closed tab', enabled: closed.length > 0, click: () => { const u = closed.pop(); if (u) newTab(u); } });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  // Tor circuits (control port). Needs the Tor that Squint starts itself; an external Tor has no control port here.
  const torErr = (e) => ({ error: e.message || String(e) });
  on('torCircuits', async () => {
    const s = S.settings.data;
    if (s.route !== 'tor') return { error: 'Tor is off. Turn Tor on first.' };
    try { return { ok: true, circuits: await tor.circuits(s.torPort) }; } catch (e) { return torErr(e); }
  });
  on('torNewCircuit', async () => {
    const s = S.settings.data;
    if (s.route !== 'tor') return { error: 'Tor is off.' };
    try {
      await tor.newnym(s.torPort);
      await session.fromPartition(PART).closeAllConnections();
      const t = active(); if (t) t.view.webContents.reload();
      return { ok: true };
    } catch (e) { return torErr(e); }
  });
  on('torNewIdentity', async () => {
    const s = S.settings.data;
    if (s.route !== 'tor') return { error: 'Tor is off.' };
    try {
      await tor.newnym(s.torPort);
      const ses = session.fromPartition(PART);
      await ses.clearStorageData();
      await ses.clearCache();
      await ses.closeAllConnections();
      for (const t of tabs.values()) { try { t.view.webContents.reload(); } catch { /* gone */ } }
      return { ok: true };
    } catch (e) { return torErr(e); }
  });
  on('toggleTor', async () => {
    const s = S.settings.data;
    if (s.route === 'tor') s.route = s.prevRoute && s.prevRoute !== 'tor' ? s.prevRoute : 'direct';
    else { s.prevRoute = s.route; s.route = 'tor'; }
    S.settings.save();
    const r = await applyRoute();
    if (!r.ok) { s.route = s.prevRoute || 'direct'; S.settings.save(); await applyRoute(); return { error: r.error || 'Tor did not start. Tor stays off.' }; }
    return { ok: true };
  });
  on('reorder', (id, to) => {
    const i = order.indexOf(id);
    if (i < 0) return;
    order.splice(i, 1);
    order.splice(Math.max(0, Math.min(Number(to) || 0, order.length)), 0, id);
    push();
  });
  on('selectTab', (id) => selectTab(id));
  on('nav', (input) => navigate(String(input)));
  on('back', () => active()?.view.webContents.navigationHistory.goBack());
  on('forward', () => active()?.view.webContents.navigationHistory.goForward());
  on('reload', () => { const t = active(); if (t) t.loading ? t.view.webContents.stop() : t.view.webContents.reload(); });
  on('overlay', (v) => setOverlay(v));
  on('suggest', (q) => suggest(String(q)));
  on('bookmarkToggle', () => toggleBookmark());
  on('fill', () => fillPassword());
  on('list', (kind, q) => {
    q = String(q || '').toLowerCase();
    const src = kind === 'bookmarks' ? S.bookmarks.data : S.history.data;
    const rows = Object.entries(src).map(([url, v]) => ({ url, title: v.title || v.t || '', at: v.added || v.l || 0 }));
    return rows.filter((r) => !q || (r.url + ' ' + r.title).toLowerCase().includes(q)).sort((a, b) => b.at - a.at).slice(0, 200);
  });
  on('remove', (kind, url) => { delete (kind === 'bookmarks' ? S.bookmarks : S.history).data[url]; S[kind].save(); push(); });
  const clearAll = async () => {
    const ses = session.fromPartition(PART);
    await ses.clearStorageData();
    await ses.clearCache();
    S.history.set({});
    return true;
  };
  on('clearData', clearAll);
  on('settingsGet', () => ({ ...S.settings.data, engines: storeLib.SEARCH }));
  const applySettings = async (patch) => {
    const allowed = ['search', 'dns', 'httpsOnly', 'clearOnExit', 'proxy', 'route', 'torPort', 'verify', 'theme', 'accent', 'frost', 'groupTabs', 'adultBlock', 'startup', 'calm', 'fingerprint', 'noRtc', 'canvasMode', 'letterbox', 'softGpu', 'wordFilter', 'filterWords', 'blockDomains', 'systemTor'];
    for (const k of allowed) if (k in patch) S.settings.data[k] = patch[k];
    const clean = (v, n) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map((x) => String(x).trim().toLowerCase()).filter((x) => x && x.length <= n))].slice(0, 300);
    if ('filterWords' in patch) S.settings.data.filterWords = clean(patch.filterWords, 64);
    if ('blockDomains' in patch) S.settings.data.blockDomains = clean(patch.blockDomains, 120).map((d) => d.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''));
    if ('wordFilter' in patch || 'filterWords' in patch || 'blockDomains' in patch) for (const t of tabs.values()) if (/^https?:/i.test(t.url) && !t.errUrl) t.view.webContents.reload();
    if (!['direct', 'proxy', 'tor'].includes(S.settings.data.route)) S.settings.data.route = 'direct';
    S.settings.data.torPort = Number(S.settings.data.torPort) || 9050;
    S.settings.save();
    privacy.applyDns(app, S.settings.data.dns);
    if ('adultBlock' in patch) {
      if (S.settings.data.adultBlock) privacy.loadAdult(path.join(__dirname, 'lists', 'adult.dat'));
      for (const t of tabs.values()) if (/^https?:/i.test(t.url) && !t.errUrl) t.view.webContents.reload();
    }
    if ('groupTabs' in patch && S.settings.data.groupTabs) { regroupAll(); for (const t of tabs.values()) t.kind = kindOf(t.url).id; }
    if ('letterbox' in patch) layout();
    if ('theme' in patch || 'accent' in patch || 'frost' in patch || 'calm' in patch) applyLook();
    const routed = await applyRoute();
    if ('systemTor' in patch || ('route' in patch && S.settings.data.systemTor)) {
      const sd = S.settings.data;
      try {
        if (sd.systemTor) {
          if (sd.route !== 'tor') throw new Error('Whole-PC mode needs the Tor route turned on first.');
          if (!tor.isOwn()) throw new Error('Whole-PC mode needs the Tor that Squint starts itself. Close Tor Browser or other Tor programs and restart Squint.');
          sd.sysProxyPrev = sysproxy.enable(sd.torPort + 2, sd.sysProxyPrev || null);
        } else { sysproxy.disable(sd.sysProxyPrev || null); delete sd.sysProxyPrev; }
        S.settings.save();
      } catch (e) {
        sd.systemTor = false; S.settings.save();
        try { sysproxy.disable(sd.sysProxyPrev || null); delete sd.sysProxyPrev; } catch { /* nothing to undo */ }
        return { ok: false, error: e.message };
      }
    }
    return routed;
  };
  on('settingsSet', applySettings);
  on('openSettings', (s) => openSettings(s));
  // Window drag, done by hand: draggable CSS regions are unreliable in embedded views.
  let dragTimer = null, dragLogged = 0;
  const stopDrag = () => { clearInterval(dragTimer); dragTimer = null; };
  on('dragStart', () => {
    if (!win || win.isFullScreen()) return;
    stopDrag();
    const p0 = screen.getCursorScreenPoint();
    let off = null;                       // set once the window actually starts moving
    const wasMax = win.isMaximized();
    const maxB = win.getBounds();
    if (dragLogged++ < 6) log(`dragStart maximized=${wasMax} bounds=${JSON.stringify(maxB)} cursor=${JSON.stringify(p0)}`);
    const begin = (c) => {
      if (wasMax) {
        // restore the window and keep it under the cursor at the same relative spot, like Windows does
        const nb = win.getNormalBounds();
        const frac = maxB.width ? (p0.x - maxB.x) / maxB.width : 0.5;
        win.unmaximize();
        const nx = Math.round(c.x - frac * nb.width), ny = Math.round(c.y - (p0.y - maxB.y));
        const nbnds = { x: nx, y: ny, width: nb.width, height: nb.height };
        win.setBounds(nbnds);
        setTimeout(() => { if (win && !win.isMaximized()) win.setBounds(nbnds); }, 30);  // Windows sometimes applies the restore late
        off = { x: c.x - nx, y: c.y - ny };
        if (dragLogged < 7) log(`restored from maximized, maximized now=${win.isMaximized()} bounds=${JSON.stringify(win.getBounds())}`);
      } else {
        const [wx, wy] = win.getPosition();
        off = { x: p0.x - wx, y: p0.y - wy };
      }
    };
    dragTimer = setInterval(() => {
      const c = screen.getCursorScreenPoint();
      if (!off) { if (Math.abs(c.x - p0.x) + Math.abs(c.y - p0.y) < 4) return; begin(c); }
      win.setPosition(c.x - off.x, c.y - off.y);
    }, 8);
    setTimeout(stopDrag, 20000);
  });
  on('dragEnd', () => {
    const had = !!dragTimer;
    stopDrag();
    if (!had || !win || win.isMaximized()) return;
    const c = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(c).workArea;
    if (c.y <= wa.y + 2) win.maximize();
  });
  on('toggleMax', () => { win.isMaximized() ? win.unmaximize() : win.maximize(); });

  const importCsvFlow = async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose the exported passwords CSV', properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const file = r.filePaths[0];
    let n;
    try { n = vault.add(S.vault, brave.parseCsv(fs.readFileSync(file, 'utf8'))); } catch (e) { return { error: e.message }; }
    const ask = await dialog.showMessageBox(win, { type: 'question', buttons: ['Delete the CSV permanently', 'Keep it'], defaultId: 0, cancelId: 1,
      message: `Imported ${n} passwords.`, detail: 'The exported CSV holds your passwords in plain text. Delete it now?' });
    if (ask.response === 0) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
    return { passwords: n, deleted: ask.response === 0 };
  };
  on('importCsv', importCsvFlow);
  on('pin', () => {
    const t = active();
    if (!t || !/^https?:/i.test(t.url)) return;
    addPin(t.url);
    toast('Pinned');
  });

  // start-screen pins: only the local start page may call these
  const fromNewtab = (e) => { if (e.senderFrame?.url !== NEWTAB) throw new Error('forbidden'); };
  ipcMain.handle('pins:get', (e) => { fromNewtab(e); return S.pins.data; });
  ipcMain.handle('pins:add', (e, input) => { fromNewtab(e); let u = String(input).trim(); if (!/^https?:\/\//i.test(u)) u = 'https://' + u; addPin(u); return S.pins.data; });
  ipcMain.handle('look:get', (e) => {
    fromNewtab(e);
    let image = null;
    if (S.settings.data.bgImage) { try { image = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(app.getPath('userData'), S.settings.data.bgImage)).toString('base64'); } catch { image = null; } }
    return { look: look(), image };
  });
  ipcMain.handle('pins:remove', (e, url) => { fromNewtab(e); S.pins.set(S.pins.data.filter((p) => p.url !== url)); return S.pins.data; });
  on('braveProfiles', () => brave.profiles());
  const braveImportFlow = async ({ profile, bookmarks, history, passwords }) => {
    const out = {};
    try {
      if (bookmarks) {
        const rows = brave.bookmarks(profile);
        for (const b of rows) if (!S.bookmarks.data[b.url]) S.bookmarks.data[b.url] = { title: b.title, folder: b.folder, added: Date.now() };
        S.bookmarks.save(); out.bookmarks = rows.length;
      }
      if (history) {
        const rows = await brave.history(profile);
        const h = S.history.data;
        for (const r of rows) {
          const e = h[r.url];
          if (!e) h[r.url] = { t: r.title, v: r.v, l: r.l };
          else { e.v = Math.max(e.v, r.v); e.l = Math.max(e.l, r.l); if (!e.t) e.t = r.title; }
        }
        S.history.save(); out.history = rows.length;
      }
      if (passwords) out.passwords = vault.add(S.vault, await brave.passwords(profile));
    } catch (e) { out.error = e.message; }
    push();
    return out;
  };
  on('braveImport', braveImportFlow);

  // ---- settings page (a local page; only it may call these) ----
  const fromSettings = (e) => {
    if (!(e.senderFrame?.url || '').startsWith(SETTINGS) || e.senderFrame !== e.sender.mainFrame) throw new Error('forbidden');
  };
  const st = (name, fn) => ipcMain.handle('settings:' + name, (e, ...a) => { fromSettings(e); return fn(...a); });
  st('get', () => ({
    settings: (({ pass, lastTabs, closedTabs, ...rest }) => rest)(S.settings.data), hasPass: !!S.settings.data.pass, unlocked: isUnlocked(), themes: themesLib.LIST, look: look(), hasBg: !!S.settings.data.bgImage, blocker: { ...blockerInfo, test: blocker ? selfTest(blocker) : false },
    adult: { have: fs.existsSync(path.join(__dirname, 'lists', 'adult.dat')), count: privacy.adultCount() }, engines: storeLib.SEARCH, brand: BRAND, platform: process.platform,
    counts: { logins: S.vault.data.length, bookmarks: Object.keys(S.bookmarks.data).length, history: Object.keys(S.history.data).length, pins: S.pins.data.length },
    lists: (() => { try { return fs.readdirSync(path.join(__dirname, 'lists')).filter((f) => f.endsWith('.txt')).length; } catch { return 0; } })(),
    versions: { chrome: process.versions.chrome, electron: process.versions.electron },
  }));
  st('set', (patch) => applySettings(patch));
  st('logins', async (prompt) => {
    if (!isUnlocked() && !prompt) return { ok: false, locked: true };
    const v = await gate('Show saved logins');
    return v.ok ? { ok: true, list: vault.list(S.vault) } : { ...v, locked: true };
  });
  st('setPasscode', async () => {
    if (S.settings.data.pass) { const v = await askUnlock('Change passcode'); if (!v.ok) return v; }
    return askUnlock('Set a passcode', 'set');
  });
  st('removePasscode', async () => {
    const v = await askUnlock('Remove passcode');
    if (!v.ok) return v;
    delete S.settings.data.pass; S.settings.save();
    return { ok: true };
  });
  st('pickBg', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a background picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    try {
      let img = nativeImage.createFromPath(r.filePaths[0]);
      if (img.isEmpty()) return { ok: false, error: 'That picture could not be read.' };
      const sz = img.getSize();
      if (sz.width > 2560) img = img.resize({ width: 2560, quality: 'good' });
      fs.writeFileSync(path.join(app.getPath('userData'), 'bg.jpg'), img.toJPEG(86));
      S.settings.data.bgImage = 'bg.jpg'; S.settings.save();
      applyLook();
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  st('setBgUrl', async (url) => {
    let u;
    try { u = new URL(String(url).trim()); } catch { return { ok: false, error: 'That is not a valid link.' }; }
    if (u.protocol !== 'https:') return { ok: false, error: 'Use a link that starts with https://' };
    try {
      const r = await session.fromPartition(PART).fetch(u.href, { signal: AbortSignal.timeout(30000), headers: { Accept: 'image/*' } });
      if (!r.ok) return { ok: false, error: 'The server answered ' + r.status + '.' };
      const type = (r.headers.get('content-type') || '').toLowerCase();
      if (!type.startsWith('image/') || type.includes('svg')) return { ok: false, error: 'That link is not a picture (jpg, png or webp).' };
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 25 * 1024 * 1024) return { ok: false, error: 'That picture is too big (over 25 MB).' };
      let img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return { ok: false, error: 'That picture could not be read.' };
      if (img.getSize().width > 2560) img = img.resize({ width: 2560, quality: 'good' });
      fs.writeFileSync(path.join(app.getPath('userData'), 'bg.jpg'), img.toJPEG(86));
      S.settings.data.bgImage = 'bg.jpg'; S.settings.save();
      applyLook();
      return { ok: true };
    } catch (e) { return { ok: false, error: 'Could not download it: ' + e.message }; }
  });
  st('clearBg', () => { try { fs.unlinkSync(path.join(app.getPath('userData'), 'bg.jpg')); } catch { /* none */ } S.settings.data.bgImage = ''; S.settings.save(); applyLook(); return { ok: true }; });
  st('updateAdult', async () => {
    const all = new Set();
    const ses = session.fromPartition(PART);
    let tried = 0;
    for (const u of adultLib.SOURCES) {
      try {
        const r = await ses.fetch(u, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        for (const d of adultLib.parse(await r.text())) all.add(d);
        tried++;
      } catch (e) { log('adult list ' + u + ': ' + e.message); }
    }
    if (all.size < 1000) return { ok: false, error: 'Could not download the lists. Check your connection or route.' };
    fs.mkdirSync(path.join(__dirname, 'lists'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'lists', 'adult.dat'), [...all].join('\n'));
    const n = privacy.loadAdult(path.join(__dirname, 'lists', 'adult.dat'));
    return { ok: true, count: n, sources: tried };
  });
  st('lock', () => { unlockUntil = 0; return { ok: true }; });
  st('checkRoute', async () => {
    try {
      const r = await session.fromPartition(PART).fetch('https://check.torproject.org/api/ip', { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      return { ok: true, ip: j.IP, tor: !!j.IsTor, route: S.settings.data.route };
    } catch (e) { return { ok: false, error: 'No answer through the current route: ' + e.message }; }
  });
  st('reveal', async (idx, h) => {
    const v = await gate('Show saved password');
    if (!v.ok) return v;
    const p = vault.reveal(S.vault, idx, h);
    return p == null ? { ok: false, error: 'Could not read that password.' } : { ok: true, pass: p };
  });
  st('copy', async (idx, h) => {
    const v = await gate('Copy saved password');
    if (!v.ok) return v;
    const p = vault.reveal(S.vault, idx, h);
    if (p == null) return { ok: false, error: 'Could not read that password.' };
    clipboard.writeText(p);
    setTimeout(() => { try { if (clipboard.readText() === p) clipboard.clear(); } catch { /* ignore */ } }, 30000);
    return { ok: true };
  });
  st('remove', (idx, h) => ({ ok: vault.remove(S.vault, idx, h) }));
  st('add', ({ origin, user, pass }) => {
    try {
      let o = String(origin || '').trim();
      if (!/^https?:\/\//i.test(o)) o = 'https://' + o;
      return { ok: true, added: vault.add(S.vault, [{ origin: o, user: String(user || ''), pass: String(pass || '') }]) };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  st('importCsv', importCsvFlow);
  // Moving to Tor Browser: bookmarks as an HTML file (Tor Browser: Bookmarks > Manage > Import and Backup > Import from HTML)
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  st('exportBookmarks', async () => {
    const items = Object.entries(S.bookmarks.data).filter(([u]) => /^https?:/i.test(u));
    if (!items.length) return { error: 'No bookmarks to export.' };
    const r = await dialog.showSaveDialog(win, { title: 'Save bookmarks for Tor Browser', defaultPath: 'bookmarks-for-tor.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
    if (r.canceled || !r.filePath) return { canceled: true };
    const groups = new Map();
    for (const [u, b] of items) { const f = (b && b.folder) || ''; if (!groups.has(f)) groups.set(f, []); groups.get(f).push([u, b || {}]); }
    const line = ([u, b]) => `    <DT><A HREF="${esc(u)}" ADD_DATE="${Math.floor((Number(b.added) || Date.now()) / (Number(b.added) > 1e12 ? 1000 : 1))}">${esc(b.title || u)}</A>`;
    let html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
    for (const [f, list] of groups) {
      if (f) html += `  <DT><H3>${esc(f)}</H3>\n  <DL><p>\n${list.map(line).join('\n')}\n  </DL><p>\n`;
      else html += list.map(line).join('\n') + '\n';
    }
    html += '</DL><p>\n';
    try { fs.writeFileSync(r.filePath, html, 'utf8'); } catch (e) { return { error: e.message }; }
    return { ok: true, count: items.length, file: r.filePath };
  });
  // Passwords as CSV for a password manager (Tor Browser itself does not keep logins). Asks to unlock first.
  st('exportPasswords', async () => {
    const list = vault.list(S.vault);
    if (!list.length) return { error: 'No saved logins to export.' };
    const v = await gate('Export saved passwords');
    if (!v.ok) return v;
    const ask = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Export', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Export your passwords as plain text?', detail: 'The file is not encrypted. Import it into a password manager (Bitwarden, KeePassXC) and delete it right after.' });
    if (ask.response !== 0) return { canceled: true };
    const r = await dialog.showSaveDialog(win, { title: 'Save passwords CSV', defaultPath: 'passwords.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return { canceled: true };
    const q = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
    const rows = ['"url","username","password"'];
    for (const x of list) { const p = vault.reveal(S.vault, x.idx, x.h); if (p != null) rows.push([q(x.o), q(x.u), q(p)].join(',')); }
    try { fs.writeFileSync(r.filePath, rows.join('\r\n') + '\r\n', 'utf8'); } catch (e) { return { error: e.message }; }
    return { ok: true, count: rows.length - 1, file: r.filePath };
  });
  st('braveProfiles', () => brave.profiles());
  st('braveImport', braveImportFlow);
  st('clearData', clearAll);

  // ---- login picker inside web pages: usernames only until you pick one and verify ----
  const siteUrl = (e) => (e.senderFrame === e.sender.mainFrame ? e.senderFrame.url : '');
  ipcMain.handle('autofill:list', (e) => { const u = siteUrl(e); return fillable(u) ? vault.users(S.vault, u) : []; });
  ipcMain.handle('autofill:fill', async (e, i) => {
    const u = siteUrl(e);
    if (!fillable(u)) return { ok: false, error: 'Not filling on a page that is not https.' };
    if (!vault.get(S.vault, u, Number(i))) return { ok: false, error: 'Login not found.' };
    const v = await gate('Fill saved login');
    if (!v.ok) return v;
    const c = vault.get(S.vault, u, Number(i));
    return c ? { ok: true, user: c.user, pass: c.pass } : { ok: false, error: 'Login not found.' };
  });
  ipcMain.handle('autofill:manage', (e) => { if (siteUrl(e)) openSettings('passwords'); });
}
