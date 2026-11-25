'use strict';
const { webContents } = require('electron');
const { getDomain } = require('tldts');

const LOCAL = /^(localhost|127\.|\[::1\]|.*\.local$)/i;

exports.DNS = {
  quad9: 'https://9.9.9.9/dns-query',
  cloudflare: 'https://1.1.1.1/dns-query',
};

// ---- adult-content filter (domain list, matched on the host and every parent domain) ----
const adult = { set: null };
exports.loadAdult = (file) => {
  try { adult.set = new Set(require('node:fs').readFileSync(file, 'utf8').split('\n').filter(Boolean)); } catch { adult.set = null; }
  return adult.set ? adult.set.size : 0;
};
exports.adultCount = () => (adult.set ? adult.set.size : 0);
function customHit(url, list) {
  if (!list || !list.length) return false;
  let h; try { h = new URL(url).hostname.toLowerCase(); } catch { return false; }
  const p = h.split('.');
  for (let i = 0; i < p.length; i++) if (list.includes(p.slice(i).join('.'))) return true;
  return false;
}
function adultHit(url) {
  if (!adult.set) return false;
  let h; try { h = new URL(url).hostname.toLowerCase(); } catch { return false; }
  const p = h.split('.');
  for (let i = 0; i < p.length - 1; i++) if (adult.set.has(p.slice(i).join('.'))) return true;
  return false;
}

// Must run before app.ready
exports.applySwitches = (app) => {
  const c = app.commandLine;
  // Software rendering: WebGL and canvas are drawn by SwiftShader on the CPU, so the graphics card cannot
  // leak through tiny drawing differences. Slower for WebGL pages. Setting "softGpu", needs a restart.
  let soft = true;
  try { soft = JSON.parse(require('node:fs').readFileSync(require('node:path').join(app.getPath('userData'), 'settings.json'), 'utf8')).softGpu !== false; } catch { /* first start: on */ }
  if (soft) { app.disableHardwareAcceleration(); c.appendSwitch('enable-unsafe-swiftshader'); }
  for (const s of [
    'disable-background-networking', 'disable-component-update', 'disable-sync', 'no-pings',
    'disable-breakpad', 'disable-domain-reliability', 'disable-client-side-phishing-detection',
    'disable-default-apps', 'no-default-browser-check', 'no-first-run',
  ]) c.appendSwitch(s);
  c.appendSwitch('disable-features', [
    'Translate', 'MediaRouter', 'OptimizationHints', 'AutofillServerCommunication',
    'NetworkTimeServiceQuerying', 'PrivacySandboxAdsAPIs', 'InterestFeedContentSuggestions',
    'NetworkPrediction', 'Prefetch', 'WebBluetooth', 'FontAccess', 'IdleDetection', 'ComputePressure',
  ].join(','));
  // speed: QUIC, parallel downloads, big disk cache, cached JS bytecode
  for (const s of ['enable-quic', 'enable-parallel-downloading']) c.appendSwitch(s);
  c.appendSwitch('disk-cache-size', String(1024 * 1024 * 1024));
  c.appendSwitch('v8-cache-options', 'code');
  // EncryptedClientHello hides the site name (SNI) from the network when the site supports it
  c.appendSwitch('enable-features', 'BackForwardCache,ParallelDownloading,EncryptedClientHello');
  // everyone looks the same: UI language and time zone are fixed, not read from this PC
  c.appendSwitch('lang', 'en-US');
  process.env.TZ = 'UTC';
  c.appendSwitch('disable-speech-api');
  c.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
};

const CHROME_V = (process.versions.chrome || '130').split('.')[0];
exports.CHROME_V = CHROME_V;
const BRANDS = `"Chromium";v="${CHROME_V}", "Google Chrome";v="${CHROME_V}", "Not-A.Brand";v="24"`;

exports.applyDns = (app, mode) => {
  const url = exports.DNS[mode];
  app.configureHostResolver(url
    ? { enableBuiltInResolver: true, secureDnsMode: 'secure', secureDnsServers: [url] }
    : { enableBuiltInResolver: false, secureDnsMode: 'off' });
};

// Route all browser traffic through a proxy (e.g. the SOCKS5 endpoint of a WireGuard VPN).
// Rules have no direct:// fallback, so if the proxy is down requests fail instead of leaking.
// socks5:// makes the proxy resolve hostnames, so no DNS leaves your machine either.
exports.applyProxy = async (ses, proxy) => {
  const p = (proxy || '').trim();
  if (!p) return ses.setProxy({ mode: 'direct' });
  if (!/^(socks5|http|https):\/\/[^\s,;]+$/i.test(p)) throw new Error('Proxy must look like socks5://host:port');
  await ses.setProxy({ mode: 'fixed_servers', proxyRules: p, proxyBypassRules: 'localhost,127.0.0.1,[::1]' });
};

const regDomain = (u) => {
  try { const h = new URL(u).hostname; return getDomain(h) || h; } catch { return ''; }
};

// "Verify you are human" widgets break when their third-party cookies are stripped, their
// referrer trimmed or their scripts blocked. Those hosts are left alone so the checkbox works.
const CHALLENGE_HOST = /(^|\.)(challenges\.cloudflare\.com|hcaptcha\.com|recaptcha\.net|arkoselabs\.com|funcaptcha\.com|geetest\.com|captcha-delivery\.com|perimeterx\.net|px-cdn\.net)$/i;
function isChallenge(url) {
  try {
    const u = new URL(url);
    if (CHALLENGE_HOST.test(u.hostname)) return true;
    return /(^|\.)(google\.com|gstatic\.com)$/i.test(u.hostname) && u.pathname.startsWith('/recaptcha');
  } catch { return false; }
}
exports.isChallenge = isChallenge;

function isThirdParty(d) {
  if (isChallenge(d.url)) return false;
  if (d.resourceType === 'mainFrame') return false;
  const wc = d.webContentsId ? webContents.fromId(d.webContentsId) : null;
  if (!wc || wc.isDestroyed()) return false;
  const top = regDomain(wc.getURL());
  return !!top && top !== regDomain(d.url);
}

// hints that describe the device; the three low-detail ones are rewritten above
const DROP_HDR = new Set(['device-memory', 'dpr', 'viewport-width', 'width', 'ect', 'rtt', 'downlink', 'save-data']);

function upgrade(d, s) {
  if (!s.httpsOnly || !d.url.startsWith('http://')) return null;
  let u; try { u = new URL(d.url); } catch { return null; }
  if (LOCAL.test(u.hostname)) return null;
  u.protocol = 'https:';
  return u.toString();
}

exports.harden = (ses, { blocker, domains, settings, onBlocked }) => {
  const ver = (process.versions.chrome || '130').split('.')[0];
  // one identical user agent for everyone, whatever the real system is
  const plat = 'Windows NT 10.0; Win64; x64';
  ses.setUserAgent(`Mozilla/5.0 (${plat}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.0.0 Safari/537.36`);

  ses.setSpellCheckerEnabled(false);
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(settings().permissions.includes(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => settings().permissions.includes(perm));
  ses.setDevicePermissionHandler(() => false);

  const stripSetCookie = (d) => {
    if (!isThirdParty(d) || !d.responseHeaders) return;
    for (const k of Object.keys(d.responseHeaders)) if (k.toLowerCase() === 'set-cookie') delete d.responseHeaders[k];
  };

  // Electron allows one listener per webRequest event, so we own the single listener and call the
  // blocker's from inside it. Everything is wrapped: a throw inside the engine must never let a
  // request through unchecked, and a request is answered exactly once.
  const stats = { domain: 0, errors: 0 };
  const domainHit = (d) => {
    if (!domains || d.resourceType === 'mainFrame') return false;
    let h; try { h = new URL(d.url).hostname.toLowerCase(); } catch { return false; }
    const p = h.split('.');
    for (let i = 0; i < p.length - 1; i++) if (domains.has(p.slice(i).join('.'))) return true;
    return false;
  };
  let cur = blocker;
  const reqHandler = (d, cb) => {
    let done = false;
    const once = (r) => { if (!done) { done = true; cb(r); } };
    try {
      const up = upgrade(d, settings());
      if (up) return once({ redirectURL: up });
      if (isChallenge(d.url)) return once({});
      if (settings().adultBlock && adultHit(d.url)) return once({ cancel: true });
      if (customHit(d.url, settings().blockDomains)) return once({ cancel: true });
      if (domainHit(d)) { stats.domain++; if (onBlocked) onBlocked(d); return once({ cancel: true }); }
      if (cur) cur.onBeforeRequest(d, once); else once({});
    } catch (e) { stats.errors++; once({}); }
  };
  const hdrHandler = (d, cb) => {
    let done = false;
    const once = (r) => { if (!done) { done = true; cb(r); } };
    try {
      stripSetCookie(d);
      if (d.responseHeaders) for (const k of Object.keys(d.responseHeaders)) { const l = k.toLowerCase(); if (l === 'accept-ch' || l === 'critical-ch') delete d.responseHeaders[k]; }
      if (cur) cur.onHeadersReceived(d, (r) => once({ ...(r || {}), responseHeaders: (r && r.responseHeaders) || d.responseHeaders }));
      else once({ responseHeaders: d.responseHeaders });
    } catch (e) { stats.errors++; once({ responseHeaders: d.responseHeaders }); }
  };
  const sendHandler = (d, cb) => {
    const h = d.requestHeaders;
    const third = isThirdParty(d);
    for (const k of Object.keys(h)) {
      const l = k.toLowerCase();
      if (l === 'x-client-data' || l === 'dnt' || DROP_HDR.has(l)) delete h[k];
      else if (l === 'sec-ch-ua') h[k] = BRANDS;
      else if (l === 'sec-ch-ua-mobile') h[k] = '?0';
      else if (l === 'sec-ch-ua-platform') h[k] = '"Windows"';
      else if (l.startsWith('sec-ch-')) delete h[k];   // arch, model, full version, memory, viewport ...
      else if (l === 'referer' && !isChallenge(d.url)) { try { h[k] = new URL(h[k]).origin + '/'; } catch { delete h[k]; } }
      else if (l === 'cookie' && third) delete h[k];
    }
    for (const k of Object.keys(h)) if (k.toLowerCase() === 'accept-language') h[k] = 'en-US,en;q=0.9';
    h['Sec-GPC'] = '1';
    cb({ requestHeaders: h });
  };
  if (blocker) { try { blocker.enableBlockingInSession(ses); } catch (e) { console.error('cosmetic filters:', e.message); } }
  const F = { urls: ['<all_urls>'] };
  const install = () => {
    ses.webRequest.onBeforeRequest(F, reqHandler);
    ses.webRequest.onHeadersReceived(F, hdrHandler);
    ses.webRequest.onBeforeSendHeaders(F, sendHandler);
  };
  install();
  // keep our listeners in place: anything that replaced one is undone within 30 seconds
  setInterval(install, 30000).unref();
  return { stats, install, setBlocker: (b) => { cur = b; } };
};
