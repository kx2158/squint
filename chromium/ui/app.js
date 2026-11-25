'use strict';
// NOTE: not named "api" - contextBridge already owns that global in this page.
const bridge = window.api;
let urlDirty = false, shownTab = null;
const milestones = new Set();
const $ = (s) => document.querySelector(s);
document.body.dataset.p = bridge.platform;

const svg = (d, fill) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  back: svg('<path d="M10 3.5 5.5 8l4.5 4.5"/>'),
  fwd: svg('<path d="M6 3.5 10.5 8 6 12.5"/>'),
  reload: svg('<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/>'),
  stop: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
  x: svg('<path d="M5 5l6 6M11 5l-6 6"/>'),
  star: svg('<path d="M8 2.3l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11l-3.4 1.8.7-3.8L2.5 6.3l3.8-.5z"/>'),
  menu: svg('<circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/>', true),
  open: svg('<rect x="3.5" y="7" width="9" height="6" rx="1.5"/><path d="M5.5 7V5.5a2.5 2.5 0 0 1 4.6-1.3"/>'),
};

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const host = (u) => { try { return new URL(u).host; } catch { return u; } };

$('#back').innerHTML = ICON.back;
$('#fwd').innerHTML = ICON.fwd;
$('#newtab').innerHTML = ICON.plus;
$('#star').innerHTML = ICON.star;
$('#menu').innerHTML = ICON.menu;

// ---------- window drag (done by hand, see main.js) ----------
const dragZone = (e) => e.target === $('#tabs') || e.target === $('#spacer');
let dragging = false;
const endDrag = () => { if (dragging) { dragging = false; bridge.invoke('dragEnd'); } };
document.addEventListener('mousedown', (e) => { if (e.button === 0 && dragZone(e)) { dragging = true; bridge.invoke('dragStart'); } });
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);
document.addEventListener('dblclick', (e) => { if (dragZone(e)) bridge.invoke('toggleMax'); });

// ---------- state ----------
let state = null;
function applyTheme(th) {
  if (!th) return;
  const key = JSON.stringify([th.vars, th.chrome, th.calm]);
  if (key === applyTheme.k) return;
  applyTheme.k = key;
  const r = document.documentElement.style;
  // system theme sets no colours of its own, so the stylesheet defaults (and OS dark mode) apply
  for (const [k, v] of Object.entries(th.vars)) r.setProperty(k, v);
  if (th.chrome) r.setProperty('--chrome', th.chrome); else r.removeProperty('--chrome');
  document.documentElement.dataset.dark = th.dark ? '1' : '0';
  document.documentElement.dataset.calm = th.calm ? '1' : '0';
}
bridge.on('state', (s) => { state = s; applyTheme(s.theme); render(); });
bridge.on('focusUrl', () => { $('#url').focus(); $('#url').select(); });
const showToast = (m) => { const t = $('#toast'); t.hidden = true; void t.offsetWidth; t.textContent = m; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), 2200); };
bridge.on('toast', showToast);
bridge.invoke('ready');

// tabs are kept as keyed elements so they can animate in, out and slide the indicator
const tabEls = new Map();
const list = $('#tablist');

function makeTab(t) {
  const x = el('button', { class: 'x', title: 'Close', onmousedown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); bridge.invoke('closeTab', t.id); } });
  x.innerHTML = ICON.x;
  const tab = el('div', { class: 'tab enter', onanimationend: (e) => { if (e.animationName === 'tin') tab.classList.remove('enter'); }, onmousedown: (e) => {
    if (e.button === 1) { e.preventDefault(); bridge.invoke('closeTab', t.id); }
    else if (e.button === 0) { bridge.invoke('selectTab', t.id); startTabDrag(e, t.id, tab); }
  } }, el('span', { class: 'title' }), x);
  return tab;
}

// drag a tab sideways to reorder; the dragged tab follows the pointer, the others make room
let tabDrag = false;
function startTabDrag(e0, id, tab) {
  const startX = e0.clientX;
  let active = false, grab = 0;
  const slots = () => [...list.children].filter((c) => !c.classList.contains('leaving'));
  const move = (e) => {
    if (!active) {
      if (Math.abs(e.clientX - startX) < 5) return;
      active = true; tabDrag = true;
      grab = startX - tab.getBoundingClientRect().left;
      tab.classList.add('drag'); $('#ind').style.opacity = '0';
    }
    const others = slots().filter((c) => c !== tab);
    const before = others.find((c) => { const r = c.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
    if (before) { if (tab.nextElementSibling !== before) list.insertBefore(tab, before); }
    else if (list.lastElementChild !== tab) list.append(tab);
    tab.style.transform = '';
    const natural = tab.getBoundingClientRect().left;
    const lr = list.getBoundingClientRect();
    const want = Math.max(lr.left, Math.min(e.clientX - grab, lr.right - tab.offsetWidth));
    tab.style.transform = `translateX(${want - natural}px)`;
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    if (!active) return;
    tab.style.transition = 'transform .18s cubic-bezier(.22,.8,.26,1)';
    tab.style.transform = '';
    setTimeout(() => { tab.classList.remove('drag'); tab.style.transition = ''; tabDrag = false; trackInd(); }, 190);
    bridge.invoke('reorder', id, slots().indexOf(tab));
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function moveInd() {
  const a = list.querySelector('.tab.active:not(.leaving)');
  const ind = $('#ind');
  if (!a) { ind.style.opacity = '0'; return; }
  ind.style.opacity = '1';
  ind.style.width = a.offsetWidth + 'px';
  ind.style.transform = `translateX(${a.offsetLeft}px)`;
}
function trackInd(ms = 360) { const end = performance.now() + ms; const f = () => { moveInd(); if (performance.now() < end) requestAnimationFrame(f); }; f(); }
window.addEventListener('resize', () => trackInd(60));

function render() {
  const ids = new Set(state.tabs.map((t) => t.id));
  for (const [id, e] of tabEls) {
    if (!ids.has(id)) {
      tabEls.delete(id);
      e.classList.add('leaving');
      e.addEventListener('animationend', () => e.remove(), { once: true });
      setTimeout(() => e.remove(), 400);
    }
  }
  for (const t of state.tabs) {
    let e = tabEls.get(t.id);
    if (!e) { e = makeTab(t); tabEls.set(t.id, e); list.append(e); }
    e.querySelector('.title').textContent = t.title;
    e.title = state.groups && t.kindName && t.kind !== 'start' ? t.kindName : '';
    e.style.setProperty('--cat', state.groups && t.color ? t.color : 'transparent');
    e.classList.toggle('gdot', !!(state.groups && t.color));
    e.classList.toggle('active', t.id === state.active);
    e.classList.toggle('loading', !!t.loading);
  }
  state.tabs.forEach((t, i) => {
    const e = tabEls.get(t.id);
    e.classList.toggle('gstart', !!(state.groups && i > 0 && state.tabs[i - 1].kind !== t.kind));
  });
  if (!tabDrag) {
    const want = state.tabs.map((t) => tabEls.get(t.id));
    const have = [...list.children].filter((c) => !c.classList.contains('leaving'));
    if (want.some((e, i) => e !== have[i])) want.forEach((e) => list.append(e));
  }
  trackInd();

  const n = state.nav;
  if (!n) return;
  $('#back').disabled = !n.canBack;
  $('#fwd').disabled = !n.canFwd;
  $('#reload').innerHTML = n.loading ? ICON.stop : ICON.reload;
  $('#bar').classList.toggle('busy', !!n.loading);
  if (state.active !== shownTab) { shownTab = state.active; urlDirty = false; if (document.activeElement === $('#url')) $('#url').blur(); }
  if (!urlDirty) $('#url').value = n.url;
  $('#lock').innerHTML = n.url && !n.secure ? ICON.open : ''; // only warn, never decorate
  $('#route').textContent = n.route === 'tor' ? 'tor' : n.route === 'proxy' ? 'vpn' : '';
  $('#shield b').textContent = n.blocked;
  if (n.blocked >= 100 && !milestones.has(state.active + ':100')) { milestones.add(state.active + ':100'); showToast('100 blocked on this page  (ง •̀_•́)ง'); }
  $('#shield').className = n.blocked ? '' : 'zero';
  $('#star').className = 'icon small' + (n.bookmarked ? ' on' : '');
}

$('#back').onclick = () => bridge.invoke('back');
$('#fwd').onclick = () => bridge.invoke('forward');
$('#reload').onclick = () => bridge.invoke('reload');
$('#newtab').onclick = () => bridge.invoke('newTab');
$('#star').onclick = () => bridge.invoke('bookmarkToggle');
// right-click menus (built natively by the main process)
$('#url').addEventListener('contextmenu', (e) => { e.preventDefault(); bridge.invoke('urlMenu'); });
$('#tablist').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const t = e.target.closest('.tab');
  const id = t && [...tabEls].find(([, el2]) => el2 === t)?.[0];
  bridge.invoke('tabMenu', id == null ? null : id);
});

// find in page
const fq = $('#fq');
const openFind = () => { $('#find').hidden = false; fq.focus(); fq.select(); };
const closeFind = () => { $('#find').hidden = true; $('#fc').textContent = ''; bridge.invoke('findStop'); };
const doFind = (fwd = true, next = false) => { if (fq.value) bridge.invoke('find', fq.value, fwd, next); else { $('#fc').textContent = ''; bridge.invoke('findStop'); } };
fq.addEventListener('input', () => doFind(true, false));
fq.addEventListener('keydown', (e) => { if (e.key === 'Enter') doFind(!e.shiftKey, true); else if (e.key === 'Escape') closeFind(); });
$('#fnext').onclick = () => doFind(true, true);
$('#fprev').onclick = () => doFind(false, true);
$('#fclose').onclick = closeFind;
bridge.on('openFind', openFind);
bridge.on('found', (r) => { $('#fc').textContent = r.total ? `${r.active}/${r.total}` : 'none'; });

$('#route').onclick = () => { if (state?.nav?.route === 'tor') openPanel('circuit'); };
$('#menu').onclick = () => (panelName ? closeAll() : openPanel('menu'));
$('#scrim').onclick = () => closeAll();

// ---------- omnibox ----------
let items = [], sel = -1, overlayOn = false;
const setOverlay = (v) => { if (v !== overlayOn) { overlayOn = v; bridge.invoke('overlay', v); } };

function closeSuggest() { items = []; sel = -1; $('#suggest').hidden = true; if (!panelName) { $('#scrim').hidden = true; setOverlay(false); } }
function closeAll() { panelName = null; $('#panel').hidden = true; closeSuggest(); $('#scrim').hidden = true; setOverlay(false); }

async function onType() {
  const q = $('#url').value;
  items = await bridge.invoke('suggest', q);
  sel = -1;
  if (!items.length) return closeSuggest();
  setOverlay(true);
  $('#scrim').hidden = false;
  drawSuggest();
}
function drawSuggest() {
  const box = $('#suggest');
  box.hidden = false;
  box.replaceChildren(...items.map((it, i) => el('div', { class: 'sg' + (i === sel ? ' sel' : ''), onmousedown: (e) => { e.preventDefault(); go(it.url); } },
    el('span', { class: 't' }, it.title || host(it.url)), el('span', { class: 'u' }, it.url))));
}
function go(v) { bridge.invoke('nav', v); $('#url').blur(); closeAll(); }

$('#url').addEventListener('input', () => { urlDirty = true; onType(); });
$('#url').addEventListener('focus', () => $('#url').select());
$('#url').addEventListener('blur', () => { urlDirty = false; if (state?.nav) $('#url').value = state.nav.url; });
$('#url').addEventListener('blur', () => setTimeout(() => { if (!panelName) closeSuggest(); }, 120));
$('#url').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!items.length) return;
    e.preventDefault();
    sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length + 1) % (items.length + 1);
    if (sel === items.length) sel = -1;
    drawSuggest();
  } else if (e.key === 'Enter') go(sel >= 0 ? items[sel].url : $('#url').value);
  else if (e.key === 'Escape') { $('#url').value = state?.nav?.url || ''; $('#url').blur(); closeAll(); }
});

// ---------- panels ----------
let panelName = null;
function openPanel(name) {
  closeSuggest();
  panelName = name;
  setOverlay(true);
  $('#scrim').hidden = false;
  const p = $('#panel');
  p.hidden = false;
  ({ menu: drawMenu, bookmarks: () => drawList('bookmarks'), history: () => drawList('history'), settings: drawSettings, import: drawImport, circuit: drawCircuit })[name]();
}
const title = (t) => el('div', { class: 'pt' }, el('button', { class: 'back', onclick: () => openPanel('menu') }, '←'), t);
const item = (label, hint, fn) => el('button', { class: 'mi', onclick: fn }, el('span', {}, label), hint ? el('kbd', {}, hint) : null);

function drawMenu() {
  const mod = bridge.platform === 'darwin' ? '⌘' : 'Ctrl+';
  $('#panel').replaceChildren(
    item('New tab', mod + 'T', () => { closeAll(); bridge.invoke('newTab'); }),
    el('div', { class: 'sep' }),
    item('Find in page', mod + 'F', () => { closeAll(); openFind(); }),
    item('Pin this page', '', () => { closeAll(); bridge.invoke('pin'); }),
    item('Bookmarks', '', () => openPanel('bookmarks')),
    item('History', '', () => openPanel('history')),
    item(state?.nav?.route === 'tor' ? 'Turn Tor off' : 'Turn Tor on', state?.nav?.route === 'tor' ? 'on' : 'off', async () => {
      const going = state?.nav?.route !== 'tor';
      closeAll(); showToast(going ? 'Starting Tor...' : 'Tor off, direct connection');
      const r = await bridge.invoke('toggleTor');
      if (r && r.error) showToast(r.error);
      else if (going) showToast('Tor is on');
    }),
    ...(state?.nav?.route === 'tor' ? [item('Tor circuit', '', () => openPanel('circuit'))] : []),
    item(state?.groups ? 'Ungroup tabs' : 'Group tabs by type', state?.groups ? 'on' : 'off', () => { closeAll(); bridge.invoke('settingsSet', { groupTabs: !state?.groups }); }),
    item('Fill saved login', mod + 'Shift+L', () => { closeAll(); bridge.invoke('fill'); }),
    el('div', { class: 'sep' }),
    item('Import passwords from CSV', '', async () => {
      const r = await bridge.invoke('importCsv');
      if (r.canceled) return;
      closeAll();
      showToast(r.error ? r.error : `Imported ${r.passwords} passwords`);
    }),
    item('Import from Brave', '', () => openPanel('import')),
    item('Settings', mod + ',', () => { closeAll(); bridge.invoke('openSettings'); }),
    item('Clear browsing data', '', async (e) => {
      const b = e.currentTarget;
      if (b.dataset.sure) { await bridge.invoke('clearData'); closeAll(); return; }
      b.dataset.sure = '1'; b.firstChild.textContent = 'Click again: clears cookies, cache, history';
    }));
}

async function drawList(kind) {
  const input = el('input', { class: 'field', placeholder: 'Search ' + kind, spellcheck: 'false' });
  const box = el('div');
  const fill = async () => {
    const rows = await bridge.invoke('list', kind, input.value);
    box.replaceChildren(...(rows.length ? rows.map((r) => el('div', { class: 'row' },
      el('div', { class: 'grow', onclick: () => { closeAll(); bridge.invoke('nav', r.url); } }, el('div', { class: 't' }, r.title || host(r.url)), el('div', { class: 'u' }, r.url)),
      el('button', { class: 'icon small', title: 'Remove', onclick: async () => { await bridge.invoke('remove', kind, r.url); fill(); } }))) : [el('div', { class: 'empty' }, 'Nothing here')]));
    box.querySelectorAll('.icon').forEach((b) => (b.innerHTML = ICON.x));
  };
  input.oninput = fill;
  $('#panel').replaceChildren(title(kind === 'bookmarks' ? 'Bookmarks' : 'History'), input, box);
  fill();
  input.focus();
}

async function drawSettings() {
  const s = await bridge.invoke('settingsGet');
  const pick = (opts, cur, key) => { const e = el('select', { class: 'field' }, ...opts.map(([v, l]) => el('option', { value: v }, l))); e.value = cur; e.onchange = () => bridge.invoke('settingsSet', { [key]: e.value }); return e; };
  const chk = (label, cur, key) => { const c = el('input', { type: 'checkbox' }); c.checked = cur; c.onchange = () => bridge.invoke('settingsSet', { [key]: c.checked }); return el('label', { class: 'row' }, c, label); };
  $('#panel').replaceChildren(
    title('Settings'),
    el('div', { class: 'ph' }, 'Search engine'), pick(Object.entries(s.engines).map(([n, u]) => [u, n]), s.search, 'search'),
    el('div', { class: 'ph' }, 'Encrypted DNS'), pick([['quad9', 'Quad9 (DNS over HTTPS)'], ['cloudflare', 'Cloudflare (DNS over HTTPS)'], ['off', 'System resolver']], s.dns, 'dns'),
    el('div', { class: 'ph' }, 'Route'),
    (() => {
      const hint = { direct: 'Direct connection.', proxy: 'Through your VPN / proxy. Blocks traffic if it is down.', tor: 'Through Tor. Slow, and blocks traffic if Tor is down.' };
      const msg = el('div', { class: 'note' }, hint[s.route]);
      const r = el('select', { class: 'field' }, ...[['direct', 'Direct'], ['proxy', 'VPN / proxy'], ['tor', 'Tor']].map(([v, l]) => el('option', { value: v }, l)));
      r.value = s.route;
      const p = el('input', { class: 'field', value: s.proxy || '', placeholder: 'socks5://10.64.0.1:1080', spellcheck: 'false' });
      const apply = async (patch) => { msg.textContent = 'Applying…'; const res = await bridge.invoke('settingsSet', patch); msg.textContent = res.ok ? hint[r.value] : res.error; };
      r.onchange = () => apply({ route: r.value });
      p.onchange = () => apply({ proxy: p.value.trim() });
      return el('div', {}, r, p, msg);
    })(),
    chk('HTTPS only', s.httpsOnly, 'httpsOnly'),
    chk('Clear cookies and cache on exit', s.clearOnExit, 'clearOnExit'));
}

async function drawImport() {
  const profiles = await bridge.invoke('braveProfiles');
  const p = $('#panel');
  const out = el('div', { class: 'note' }, 'Close Brave completely before importing.');
  const csvBtn = el('button', { class: 'btn plain', onclick: async () => {
    const r = await bridge.invoke('importCsv');
    if (r.canceled) return;
    out.textContent = r.error ? r.error : `Imported ${r.passwords} passwords${r.deleted ? ' and deleted the CSV' : ''}.`;
  } }, 'Import passwords from CSV…');
  const csvHelp = el('div', { class: 'note' }, 'In Brave: Settings → Autofill → Passwords → ⋮ → Export passwords. Then pick that file here.');
  if (!profiles.length) return p.replaceChildren(title('Import from Brave'), el('div', { class: 'note' }, 'No Brave profile found on this machine.'), el('div', { class: 'sep' }), csvBtn, csvHelp, out);
  let chosen = profiles[0].dir;
  const opts = { bookmarks: true, history: true, passwords: true };
  const radios = profiles.map((pr) => { const r = el('input', { type: 'radio', name: 'prof' }); r.checked = pr.dir === chosen; r.onchange = () => (chosen = pr.dir); return el('label', { class: 'row' }, r, pr.name + ' (' + pr.dir + ')'); });
  const chk = (label, key) => { const c = el('input', { type: 'checkbox' }); c.checked = opts[key]; c.onchange = () => (opts[key] = c.checked); return el('label', { class: 'row' }, c, label); };
  const btn = el('button', { class: 'btn', onclick: async () => {
    btn.disabled = true; out.textContent = 'Importing…';
    const r = await bridge.invoke('braveImport', { profile: chosen, ...opts });
    const parts = ['bookmarks', 'history', 'passwords'].filter((k) => k in r).map((k) => `${r[k]} ${k}`);
    out.textContent = (parts.length ? 'Imported ' + parts.join(', ') + '. ' : '') + (r.error || '') + (r.passwords === 0 ? ' No passwords could be read directly: use the CSV export below.' : '');
    btn.disabled = false;
  } }, 'Import');
  p.replaceChildren(title('Import from Brave'), ...radios, el('div', { class: 'sep' }), chk('Bookmarks', 'bookmarks'), chk('History', 'history'), chk('Saved passwords (Windows)', 'passwords'), btn,
    el('div', { class: 'sep' }), csvBtn, csvHelp, out);
}

// Tor circuit panel: the relays this browser is going through, new circuit, new identity.
const flag = (cc) => cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))) : '';
async function drawCircuit() {
  const body = el('div', { class: 'circ' }, el('div', { class: 'muted' }, 'Reading circuits...'));
  const act = async (ch, ok) => { const r = await bridge.invoke(ch); if (r && r.error) showToast(r.error); else { showToast(ok); if (panelName === 'circuit') setTimeout(drawCircuit, 1800); } };
  $('#panel').replaceChildren(title('Tor circuit'), body, el('div', { class: 'sep' }),
    item('New circuit', 'this session', () => act('torNewCircuit', 'New circuit')),
    item('New identity', 'wipes data', () => act('torNewIdentity', 'New identity: cookies and cache cleared')));
  const r = await bridge.invoke('torCircuits');
  if (panelName !== 'circuit') return;
  if (r.error) { body.replaceChildren(el('div', { class: 'muted' }, r.error)); return; }
  if (!r.circuits.length) { body.replaceChildren(el('div', { class: 'muted' }, 'No circuit built yet. Load a page and look again.')); return; }
  const names = ['Guard', 'Middle', 'Exit'];
  body.replaceChildren(...r.circuits.map((c, i) => el('div', { class: 'cg' },
    el('div', { class: 'cl' }, 'Circuit ' + (i + 1)),
    ...c.hops.map((h, j) => el('div', { class: 'hop' },
      el('span', { class: 'hn' }, j === c.hops.length - 1 ? 'Exit' : j === 0 ? 'Guard' : names[1]),
      el('span', { class: 'hv' }, (flag(h.cc) ? flag(h.cc) + ' ' : '') + (h.name || h.fp.slice(0, 8)) + (h.ip ? '  ' + h.ip : '')))))));
}
