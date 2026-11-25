'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function root() {
  const h = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(h, 'AppData', 'Local'), 'BraveSoftware', 'Brave-Browser', 'User Data');
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser');
  return path.join(h, '.config', 'BraveSoftware', 'Brave-Browser');
}

exports.profiles = () => {
  const r = root();
  if (!fs.existsSync(r)) return [];
  const names = {};
  try {
    const ls = JSON.parse(fs.readFileSync(path.join(r, 'Local State'), 'utf8'));
    for (const [k, v] of Object.entries(ls.profile?.info_cache || {})) names[k] = v.name || k;
  } catch { /* names optional */ }
  return fs.readdirSync(r)
    .filter((d) => d === 'Default' || /^Profile \d+$/.test(d))
    .map((d) => ({ dir: d, name: names[d] || d }));
};

async function openDb(file) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: (f) => require.resolve('sql.js/dist/' + f) });
  const tmp = path.join(os.tmpdir(), 'plain-' + crypto.randomBytes(6).toString('hex'));
  try { fs.copyFileSync(file, tmp); } catch (e) { throw new Error('Cannot read ' + path.basename(file) + '. Close Brave completely and retry.'); }
  const buf = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return new SQL.Database(buf);
}

exports.bookmarks = (profile) => {
  const file = path.join(root(), profile, 'Bookmarks');
  const out = [];
  if (!fs.existsSync(file)) return out;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const walk = (n, folder) => {
    if (n.type === 'url' && /^https?:/i.test(n.url)) out.push({ title: n.name || n.url, url: n.url, folder });
    else for (const c of n.children || []) walk(c, n.name || folder);
  };
  for (const r of Object.values(j.roots || {})) if (r && typeof r === 'object') walk(r, '');
  return out;
};

exports.history = async (profile) => {
  const db = await openDb(path.join(root(), profile, 'History'));
  try {
    const res = db.exec('SELECT url, title, visit_count, last_visit_time FROM urls');
    if (!res[0]) return [];
    return res[0].values
      .filter(([u]) => /^https?:/i.test(u))
      .map(([url, title, v, t]) => ({ url, title: title || '', v: v || 1, l: Math.round(t / 1000 - 11644473600000) }));
  } finally { db.close(); }
};

function masterKey() {
  if (process.platform !== 'win32') throw new Error('Password import is implemented for Windows only.');
  const ls = JSON.parse(fs.readFileSync(path.join(root(), 'Local State'), 'utf8'));
  const b64 = ls.os_crypt?.encrypted_key;
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error('No encryption key found in Local State.');
  const wrapped = Buffer.from(b64, 'base64').subarray(5).toString('base64'); // strip "DPAPI"
  const ps = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${wrapped}'); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))`;
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim();
  return Buffer.from(out, 'base64');
}

exports.passwords = async (profile) => {
  const key = masterKey();
  const db = await openDb(path.join(root(), profile, 'Login Data'));
  const out = [];
  try {
    const res = db.exec('SELECT origin_url, username_value, password_value FROM logins');
    for (const [origin, user, blob] of res[0]?.values || []) {
      const b = Buffer.from(blob);
      if (b.subarray(0, 3).toString() !== 'v10') continue; // v20 app-bound entries are not readable here
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(3, 15));
        d.setAuthTag(b.subarray(b.length - 16));
        const pass = Buffer.concat([d.update(b.subarray(15, b.length - 16)), d.final()]).toString('utf8');
        out.push({ origin, user, pass });
      } catch { /* skip undecryptable */ }
    }
  } finally { db.close(); }
  return out;
};

// Brave/Chrome "Export passwords" CSV: name,url,username,password,note
exports.parseCsv = (text) => {
  const rows = [];
  let row = [], cell = '', q = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x)) rows.push(row); row = []; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (rows.length < 2) throw new Error('That file has no passwords in it.');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const iu = col('url', 'origin', 'origin_url'), iw = col('username', 'login', 'user'), ip = col('password', 'pass');
  if (iu < 0 || ip < 0) throw new Error('This does not look like a password export (needs url and password columns).');
  return rows.slice(1).map((r) => ({ origin: r[iu] || '', user: iw >= 0 ? r[iw] || '' : '', pass: r[ip] || '' })).filter((x) => /^https?:/i.test(x.origin));
};
