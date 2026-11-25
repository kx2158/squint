'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

let proc = null, ownDir = null;

const up = (port) => new Promise((res) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
});

const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const exe = process.platform === 'win32' ? 'tor.exe' : 'tor';

// Where a tor binary may live: ./tor (Expert Bundle), or the Tor Browser that the Squint Tor skin installed
// next to this folder (squint-tor\TorBrowser), or a normal Tor Browser install.
function findTor(root) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const here = [
    path.join(root, 'tor', exe), path.join(root, 'tor', 'tor', exe),
    path.join(root, 'squint-tor', 'TorBrowser', 'Browser', 'TorBrowser', 'Tor', exe),
    path.join(root, '..', 'squint-tor', 'TorBrowser', 'Browser', 'TorBrowser', 'Tor', exe),
    path.join(root, '..', 'TorBrowser', 'Browser', 'TorBrowser', 'Tor', exe),
    path.join(home, 'Desktop', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', exe),
    path.join(home, 'Downloads', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', exe),
  ];
  return here.find(isFile) || null;
}

function geoArgs(bin) {
  const d = path.dirname(bin);
  for (const base of [path.join(d, 'data'), path.join(d, '..', 'data'), path.join(d, '..', 'Data', 'Tor'), path.join(d, '..', '..', 'Data', 'Tor')]) {
    if (isFile(path.join(base, 'geoip'))) {
      const a = ['--GeoIPFile', path.join(base, 'geoip')];
      if (isFile(path.join(base, 'geoip6'))) a.push('--GeoIPv6File', path.join(base, 'geoip6'));
      return a;
    }
  }
  return [];
}

// Uses a Tor SOCKS port that is already listening, else starts a Tor of its own (with a control port, so circuits work).
exports.ensure = async (root, dataDir, port) => {
  if (await up(port)) return { ok: true, own: !!proc };
  const bin = findTor(root);
  if (!bin) return { ok: false, error: `No Tor on port ${port}. Run scripts\\get-tor.ps1 (or setup the Tor skin) so Squint can start its own.` };
  if (!proc) {
    ownDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    proc = spawn(bin, ['--SocksPort', String(port), '--ControlPort', String(port + 1), '--HTTPTunnelPort', '127.0.0.1:' + (port + 2), '--CookieAuthentication', '1',
      '--DataDirectory', dataDir, '--ClientOnly', '1', ...geoArgs(bin)],
      { stdio: 'ignore', windowsHide: true, cwd: path.dirname(bin) });
    proc.on('exit', () => { proc = null; });
    proc.on('error', () => { proc = null; });
  }
  for (let i = 0; i < 80; i++) {
    if (await up(port)) return { ok: true, own: true };
    if (!proc) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, error: 'Tor did not start in time' };
};

exports.stop = () => { if (proc) { proc.kill(); proc = null; } };
exports.isOwn = () => !!proc;

// ---- control port: one short-lived connection per call ----
function cookieHex(port) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const files = [
    ownDir && path.join(ownDir, 'control_auth_cookie'),
    path.join(__dirname, '..', 'squint-tor', 'TorBrowser', 'Browser', 'TorBrowser', 'Data', 'Tor', 'control_auth_cookie'),
    path.join(__dirname, '..', '..', 'squint-tor', 'TorBrowser', 'Browser', 'TorBrowser', 'Data', 'Tor', 'control_auth_cookie'),
    path.join(home, 'Desktop', 'Tor Browser', 'Browser', 'TorBrowser', 'Data', 'Tor', 'control_auth_cookie'),
  ].filter(Boolean);
  for (const f of files) { try { return fs.readFileSync(f).toString('hex'); } catch { /* next */ } }
  return null;
}

// Sends commands in order; resolves with one reply (array of lines) per command.
function control(socksPort, cmds, ms = 8000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(socksPort + 1, '127.0.0.1');
    const replies = [];
    let buf = '', cur = [], idx = -1;
    const all = ['AUTHENTICATE' + (cookieHex(socksPort) ? ' ' + cookieHex(socksPort) : ''), ...cmds];
    const done = (err) => { clearTimeout(t); s.destroy(); err ? reject(err) : resolve(replies); };
    const t = setTimeout(() => done(new Error('Tor control port did not answer')), ms);
    const next = () => { idx++; if (idx < all.length) s.write(all[idx] + '\r\n'); else done(); };
    s.on('connect', next);
    s.on('error', () => done(new Error('No Tor control port on ' + (socksPort + 1) + '. Only the Tor that Squint starts itself has one.')));
    s.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        cur.push(line);
        if (/^\d{3} /.test(line)) {
          if (idx === 0 && !line.startsWith('250')) return done(new Error('Tor refused the control login: ' + line));
          if (idx > 0) replies.push(cur);
          cur = [];
          next();
        }
      }
    });
  });
}

exports.newnym = async (port) => { await control(port, ['SIGNAL NEWNYM']); return { ok: true }; };

const CC = (c) => (c && c.length === 2 && c !== '??') ? c.toUpperCase() : '';

// Built circuits as [{ id, hops: [{ fp, name, ip, cc }] }], newest first.
exports.circuits = async (port) => {
  const [cs] = await control(port, ['GETINFO circuit-status']);
  const circs = [];
  for (const l of cs) {
    const m = /^(\d+) BUILT (\S+) (.*)$/.exec(l);
    if (!m || !/PURPOSE=GENERAL/.test(m[3])) continue;
    const created = /TIME_CREATED=(\S+)/.exec(m[3]);
    const hops = m[2].split(',').map((h) => { const x = /\$([0-9A-Fa-f]{40})(?:[~=](.*))?/.exec(h); return x && { fp: x[1].toUpperCase(), name: x[2] || '', ip: '', cc: '' }; }).filter(Boolean);
    if (hops.length) circs.push({ id: m[1], created: created ? created[1] : '', hops });
  }
  circs.sort((a, b) => b.created.localeCompare(a.created));
  const top = circs.slice(0, 3);
  const fps = [...new Set(top.flatMap((c) => c.hops.map((h) => h.fp)))];
  if (fps.length) {
    const ns = await control(port, fps.map((f) => 'GETINFO ns/id/' + f));
    const ips = {};
    ns.forEach((r, i) => { const m = /^r \S+ \S+ \S+ \S+ \S+ (\S+) /m.exec(r.join('\n')); if (m) ips[fps[i]] = m[1]; });
    const uniq = [...new Set(Object.values(ips))];
    const geo = uniq.length ? await control(port, uniq.map((ip) => 'GETINFO ip-to-country/' + ip)) : [];
    const cc = {};
    geo.forEach((r, i) => { const m = /=(\w\w)\b/.exec(r[0] || ''); cc[uniq[i]] = m ? m[1] : ''; });
    for (const c of top) for (const h of c.hops) { h.ip = ips[h.fp] || ''; h.cc = CC(cc[h.ip]); }
  }
  return top;
};
