'use strict';
// Start-screen bridge: exposed on the local start page only (main re-checks the sender).
try {
  const { contextBridge, ipcRenderer } = require('electron');
  if (location.protocol === 'file:' && location.pathname.endsWith('/ui/newtab.html')) {
    contextBridge.exposeInMainWorld('pins', {
      get: () => ipcRenderer.invoke('pins:get'),
      add: (u) => ipcRenderer.invoke('pins:add', u),
      remove: (u) => ipcRenderer.invoke('pins:remove', u),
    });
    contextBridge.exposeInMainWorld('lookApi', { get: () => ipcRenderer.invoke('look:get') });
  }
  if (location.protocol === 'file:' && location.pathname.endsWith('/ui/settings.html')) {
    contextBridge.exposeInMainWorld('settingsApi', { invoke: (ch, ...a) => ipcRenderer.invoke('settings:' + ch, ...a) });
  }
} catch { /* not available */ }

// Google and bot checks refuse browsers that do not look like Chrome. Present the same Chrome
// identity the network headers use, on every web page, so a normal visit is treated as normal.
try {
  const { webFrame } = require('electron');
  if (/^https?:$/.test(location.protocol)) {
    const V = String((process.versions.chrome || '130').split('.')[0]);
    webFrame.executeJavaScript(`(() => {
      const V = ${JSON.stringify(V)};
      const brands = [{ brand: 'Chromium', version: V }, { brand: 'Google Chrome', version: V }, { brand: 'Not-A.Brand', version: '24' }];
      try {
        const P = window.NavigatorUAData && NavigatorUAData.prototype;
        if (P) {
          Object.defineProperty(P, 'brands', { get: () => brands, configurable: true });
          const o = P.getHighEntropyValues;
          P.getHighEntropyValues = async function (h) {
            const r = await o.call(this, h);
            r.brands = brands;
            if (h && h.includes('fullVersionList')) r.fullVersionList = brands.map((b) => ({ brand: b.brand, version: V + '.0.0.0' }));
            return r;
          };
        }
      } catch (e) {}
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) window.chrome.runtime = {};
      if (!window.chrome.app) window.chrome.app = { isInstalled: false };
      if (!window.chrome.csi) window.chrome.csi = () => ({});
      if (!window.chrome.loadTimes) window.chrome.loadTimes = () => ({});
    })();`);
  }
} catch { /* not available */ }

// Fingerprint resistance: the script comes from the main process (src/fingerprint.js) and runs in
// the page's own world, in every frame (including about:blank iframes), before page scripts.
try {
  const { webFrame, ipcRenderer } = require('electron');
  if (location.protocol !== 'file:') {
    const cfg = ipcRenderer.sendSync('fp:get');
    if (cfg && cfg.script) {
      // the script returns a short self-check; the main process writes the first few to error.log
      webFrame.executeJavaScript(cfg.script + ';[navigator.hardwareConcurrency, new Date().getTimezoneOffset(), navigator.plugins.length, screen.width].join(",")')
        .then((r) => ipcRenderer.send('fp:log', 'active ' + r + ' (expect 8,0,5,...)'), (e) => ipcRenderer.send('fp:log', 'FAILED ' + String(e && e.message).slice(0, 200)));
    } else ipcRenderer.send('fp:log', 'off');
  }
} catch { /* not available */ }

// Cookie banner auto-reject. Runs in every page (isolated world). Network-level banner
// removal comes from the uBO annoyances-cookies list; this clicks "reject" on what remains.
(() => {
  const SEL = [
    '#onetrust-reject-all-handler', '#CybotCookiebotDialogBodyButtonDecline',
    '#CybotCookiebotDialogBodyLevelButtonDecline', '#didomi-notice-disagree-button',
    'button[data-testid="uc-deny-all-button"]', '.fc-cta-do-not-consent', '.qc-cmp2-summary-buttons button[mode="secondary"]',
    '#sp-cc-rejectall-link', '.osano-cm-denyAll', '.cmpboxbtnno', 'button.iubenda-cs-reject-btn',
    '.cc-deny', '.klaro .cn-decline', 'button[aria-label="Reject all"]', 'button[aria-label="Reject All"]',
  ];
  const SCOPE = '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="cmp" i],[class*="cmp" i],[id*="gdpr" i],[class*="gdpr" i],[role="dialog"],[aria-modal="true"]';
  const TEXT = /^(reject all|reject|decline all|decline|deny all|deny|refuse all|refuse|only necessary|necessary only|use necessary cookies only|only essential|essential only|continue without accepting|odmietnu[tť]( v[sš]etko)?|alles ablehnen|ablehnen|nur notwendige|nur erforderliche|tout refuser|refuser|rechazar todo|rechazar|rifiuta( tutto)?|odrzu[cć]( wszystko)?|odm[ií]tnout( v[sš]e)?)$/i;
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);

  function attempt() {
    for (const s of SEL) {
      const e = document.querySelector(s);
      if (e && visible(e)) { e.click(); return true; }
    }
    for (const scope of document.querySelectorAll(SCOPE)) {
      for (const b of scope.querySelectorAll('button,a[role="button"],[role="button"],input[type="button"],input[type="submit"]')) {
        const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
        if (t && t.length < 40 && TEXT.test(t) && visible(b)) { b.click(); return true; }
      }
    }
    return false;
  }

  function start() {
    if (attempt()) return;
    let timer = null;
    const mo = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; if (attempt()) mo.disconnect(); }, 250);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 15000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

// Saved-login picker. A small key button appears in username/password fields on sites you have a
// login for. Clicking it lists usernames only; choosing one asks the OS to verify you, then fills.
(() => {
  if (!/^https?:$/.test(location.protocol) || window.top !== window) return;
  let ipc;
  try { ipc = require('electron').ipcRenderer; } catch { return; }

  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const pwFields = () => [...document.querySelectorAll('input[type="password"]')].filter(vis);
  const isPw = (e) => !!e && e.tagName === 'INPUT' && e.type === 'password';
  const isUser = (e) => !!e && e.tagName === 'INPUT' && /^(text|email|tel|)$/i.test(e.type) && vis(e) &&
    pwFields().some((p) => (e.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) && e.form === p.form);

  let users = null, fetchedAt = 0, field = null, popOpen = false, hover = false;

  const host = document.createElement('div');
  host.style.setProperty('all', 'initial');
  host.style.setProperty('position', 'fixed');
  host.style.setProperty('top', '0');
  host.style.setProperty('left', '0');
  host.style.setProperty('z-index', '2147483647');
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .k{position:fixed;width:26px;height:26px;border-radius:7px;border:0;display:none;place-items:center;cursor:pointer;padding:0;color:#555;background:rgba(127,127,127,.16)}
    .k:hover{background:rgba(127,127,127,.3)}
    .k.on{display:grid;animation:in .15s}
    .p{position:fixed;min-width:250px;max-width:330px;display:none;padding:5px;border-radius:12px;font:13px/1.3 system-ui,"Segoe UI",sans-serif;
       background:#fff;color:#1a1a1a;border:1px solid rgba(0,0,0,.1);box-shadow:0 12px 32px rgba(0,0,0,.2)}
    .p.on{display:block;animation:in .16s cubic-bezier(.22,.8,.26,1)}
    @media (prefers-color-scheme:dark){.p{background:#202023;color:#ececee;border-color:rgba(255,255,255,.1)}.k{color:#bbb}}
    .h{padding:6px 10px 4px;font-size:11.5px;opacity:.6}
    .i{display:block;width:100%;text-align:left;padding:9px 10px;border:0;border-radius:8px;background:none;color:inherit;font:inherit;cursor:pointer}
    .i:hover{background:rgba(127,127,127,.18)}
    .m{padding:8px 10px;font-size:12px;opacity:.75}
    .e{padding:6px 10px;font-size:12px;color:#d14b3d}
    .s{margin:4px 6px;height:1px;background:rgba(127,127,127,.25)}
    @keyframes in{from{opacity:0;transform:translateY(-4px)}}
  `);
  root.adoptedStyleSheets = [sheet];

  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const NS = 'http://www.w3.org/2000/svg';
  const icon = () => {
    const s = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', width: '15', height: '15', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) s.setAttribute(k, v);
    const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', '5.5'); c.setAttribute('cy', '10.5'); c.setAttribute('r', '2.5');
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M7.5 8.5 13 3M11 5l2 2');
    s.append(c, p);
    return s;
  };

  const btn = mk('button', 'k'); btn.title = 'Saved logins'; btn.append(icon());
  const pop = mk('div', 'p');
  root.append(btn, pop);
  for (const e of [btn, pop]) { e.addEventListener('mouseenter', () => (hover = true)); e.addEventListener('mouseleave', () => (hover = false)); }
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field

  const place = () => {
    if (!field || !field.isConnected) return hideAll();
    const r = field.getBoundingClientRect();
    btn.style.setProperty('left', Math.max(0, r.right - 32) + 'px');
    btn.style.setProperty('top', r.top + (r.height - 26) / 2 + 'px');
    pop.style.setProperty('left', Math.max(8, Math.min(r.left, window.innerWidth - 340)) + 'px');
    pop.style.setProperty('top', r.bottom + 6 + 'px');
  };
  const show = () => { if (!host.isConnected) document.documentElement.append(host); btn.classList.add('on'); place(); };
  const hidePop = () => { popOpen = false; pop.classList.remove('on'); };
  const hideAll = () => { hidePop(); btn.classList.remove('on'); };

  const list = (note) => {
    pop.replaceChildren();
    pop.append(mk('div', 'h', 'Saved logins - ' + location.hostname));
    if (note) pop.append(mk('div', 'e', note));
    users.forEach((u, i) => {
      const b = mk('button', 'i', u.user || '(no username)');
      b.addEventListener('click', (e) => { if (e.isTrusted) choose(i); });
      pop.append(b);
    });
    pop.append(mk('div', 's'));
    const manage = mk('button', 'i', 'Manage passwords…');
    manage.addEventListener('click', (e) => { if (e.isTrusted) { hidePop(); ipc.invoke('autofill:manage'); } });
    pop.append(manage);
  };

  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const fill = (user, pass) => {
    const pw = isPw(field) ? field : pwFields()[0];
    let un = isUser(field) ? field : null;
    if (!un && pw) {
      const all = [...document.querySelectorAll('input')].filter(vis);
      un = all.slice(0, all.indexOf(pw)).reverse().find((x) => /^(text|email|tel|)$/i.test(x.type)) || null;
    }
    if (un && user) set(un, user);
    if (pw) { set(pw, pass); pw.focus(); }
  };

  async function choose(i) {
    pop.replaceChildren(mk('div', 'm', 'Waiting for Windows to verify it is you…'));
    let r;
    try { r = await ipc.invoke('autofill:fill', i); } catch { r = { ok: false, error: 'Something went wrong.' }; }
    if (!r || !r.ok) return list(r && r.error);
    fill(r.user, r.pass);
    r = null;
    hidePop();
  }

  btn.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    if (popOpen) return hidePop();
    popOpen = true; list(); place(); pop.classList.add('on');
  });

  document.addEventListener('focusin', async (e) => {
    const t = e.target;
    if (!(isPw(t) || isUser(t))) return;
    if (users === null || Date.now() - fetchedAt > 10000) {
      try { users = await ipc.invoke('autofill:list'); } catch { users = []; }
      fetchedAt = Date.now();
    }
    if (!users.length || document.activeElement !== t) return;
    field = t; show();
  }, true);
  document.addEventListener('focusout', () => setTimeout(() => { if (!popOpen && !hover) hideAll(); }, 160), true);
  document.addEventListener('mousedown', (e) => { if (popOpen && !e.composedPath().includes(host)) hidePop(); }, true);
  window.addEventListener('scroll', () => { if (field) place(); }, true);
  window.addEventListener('resize', () => { if (field) place(); });
})();

// Word filter: posts, comments and videos that mention a chosen word are hidden, on every site.
// Matching is on whole words, case-insensitive; the words come from Settings > Filters.
try {
  const { ipcRenderer } = require('electron');
  if (/^https?:$/.test(location.protocol) && window === window.top) {
    const words = ipcRenderer.sendSync('wf:get');
    if (Array.isArray(words) && words.length) {
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(^|[^\\p{L}\\p{N}])(' + words.map(esc).join('|') + ')(?![\\p{L}\\p{N}])', 'iu');
      // what counts as "one post" on the big sites, plus the generic article tag
      const POST = [
        'article', '[role="article"]', '[data-testid="tweet"]', '[data-testid="cellInnerDiv"]', 'shreddit-post', 'shreddit-comment',
        'div.thing', 'div.comment', 'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-grid-video-renderer', 'ytd-compact-video-renderer',
        'ytd-comment-thread-renderer', 'ytd-reel-item-renderer', 'yt-lockup-view-model', '[data-e2e="recommend-list-item-container"]',
        '[data-e2e="search-card-item"]', '[data-e2e="comment-level-1"]', '.feed-shared-update-v2', '.update-components-text', 'blockquote',
        '.tweet', '.status', '.toot', '.note-card', '.post', '.post-card',
      ].join(',');
      const done = new WeakSet();
      let queued = false, hidden = 0;
      const check = (root) => {
        const list = root.matches && root.matches(POST) ? [root] : [];
        if (root.querySelectorAll) list.push(...root.querySelectorAll(POST));
        for (const el of list) {
          if (done.has(el) || el === document.body || el === document.documentElement) continue;
          done.add(el);
          const t = el.textContent;
          if (t && t.length < 30000 && re.test(t)) { el.style.setProperty('display', 'none', 'important'); el.setAttribute('data-sq-hidden', ''); hidden++; }
        }
      };
      const run = () => { queued = false; check(document); };
      const start = () => {
        run();
        new MutationObserver(() => { if (!queued) { queued = true; setTimeout(run, 200); } })
          .observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      };
      if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
    }
  }
} catch { /* not available */ }
