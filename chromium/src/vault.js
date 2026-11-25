'use strict';
const { safeStorage } = require('electron');

// A login only matches the exact site it was saved for (www. ignored), never a whole
// registrable domain: that would let any *.github.io / *.blogspot.com page ask for the others' logins.
const siteKey = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
exports.hostKey = siteKey;

const dec = (x) => { try { return safeStorage.decryptString(Buffer.from(x.p, 'base64')); } catch { return null; } };

// Passwords are encrypted with the OS keystore (DPAPI / Keychain / libsecret) via safeStorage.
exports.add = (store, entries) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable');
  const list = store.data;
  let n = 0;
  for (const e of entries) {
    const h = siteKey(e.origin);
    if (!h || !e.pass) continue;
    if (list.some((x) => x.h === h && x.u === e.user)) continue;
    list.push({ h, o: e.origin, u: e.user, p: safeStorage.encryptString(e.pass).toString('base64') });
    n++;
  }
  store.save();
  return n;
};

// earlier versions keyed logins by registrable domain; re-key from the saved origin
exports.migrate = (store) => {
  let changed = false;
  for (const x of store.data) { const k = siteKey(x.o); if (k && x.h !== k) { x.h = k; changed = true; } }
  if (changed) store.save();
};

const entries = (store, url) => {
  const h = siteKey(url);
  return h ? store.data.filter((x) => x.h === h) : [];
};
exports.users = (store, url) => entries(store, url).map((x) => ({ user: x.u }));
exports.get = (store, url, i) => { const x = entries(store, url)[i]; if (!x) return null; const p = dec(x); return p == null ? null : { user: x.u, pass: p }; };
exports.find = (store, url) => entries(store, url).map((x) => { const p = dec(x); return p == null ? null : { user: x.u, pass: p }; }).filter(Boolean);

exports.list = (store) => store.data.map((x, idx) => ({ idx, h: x.h, o: x.o, u: x.u }));
exports.reveal = (store, idx, h) => { const x = store.data[idx]; return x && x.h === h ? dec(x) : null; };
exports.remove = (store, idx, h) => { const x = store.data[idx]; if (!x || x.h !== h) return false; store.data.splice(idx, 1); store.save(); return true; };
