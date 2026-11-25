'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

// Loads every lists/*.txt (uBO + EasyList) into one engine. The compiled engine is cached
// in userData and rebuilt only when the list files change.
// Plain "||domain^" rules and hosts lines, as a Set. This is a second, independent net under the
// engine: even if the engine misbehaves on some request, a known ad domain is still cut.
function buildDomains(text) {
  const block = new Set(), allow = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '!' || line[0] === '#' || line[0] === '[') continue;
    let m;
    if ((m = line.match(/^@@\|\|([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\^?(\$.*)?$/i))) { allow.add(m[1].toLowerCase()); continue; }
    if ((m = line.match(/^\|\|([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\^$/i))) block.add(m[1].toLowerCase());
    else if ((m = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9][a-z0-9.-]*\.[a-z]{2,})$/i))) block.add(m[1].toLowerCase());
  }
  for (const d of allow) block.delete(d);
  return block;
}
exports.buildDomains = buildDomains;

exports.loadBlocker = (listDir, cacheDir) => {
  const files = fs.existsSync(listDir) ? fs.readdirSync(listDir).filter((f) => f.endsWith('.txt')).sort() : [];
  const resPath = path.join(listDir, 'resources.dat');
  let res = '';
  try { res = fs.readFileSync(resPath, 'utf8'); } catch { /* optional */ }
  const key = (res ? 'res:' + res.length + '|' : '') + files.map((f) => f + ':' + fs.statSync(path.join(listDir, f)).size).join('|');
  const bin = path.join(cacheDir, 'engine.bin');
  const domFile = path.join(cacheDir, 'domains.txt');
  const keyFile = path.join(cacheDir, 'engine.key');
  try {
    if (fs.readFileSync(keyFile, 'utf8') === key) {
      return { blocker: ElectronBlocker.deserialize(fs.readFileSync(bin)), files: files.length, domains: new Set(fs.readFileSync(domFile, 'utf8').split('\n').filter(Boolean)), resources: !!res };
    }
  } catch { /* rebuild */ }
  const text = files.map((f) => fs.readFileSync(path.join(listDir, f), 'utf8')).join('\n');
  const blocker = ElectronBlocker.parse(text);
  const domains = buildDomains(text);
  if (res) { try { blocker.updateResources(res, String(res.length)); } catch (e) { console.warn('resources failed:', e.message); } }
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(domFile, [...domains].join('\n'));
    fs.writeFileSync(bin, blocker.serialize());
    fs.writeFileSync(keyFile, key);
  } catch { /* cache is optional */ }
  return { blocker, files: files.length, domains, resources: !!res };
};

exports.domainsOnly = (listDir) => {
  try {
    const files = fs.readdirSync(listDir).filter((f) => f.endsWith('.txt'));
    return buildDomains(files.map((f) => fs.readFileSync(path.join(listDir, f), 'utf8')).join('\n'));
  } catch { return new Set(); }
};
exports.selfTest = (blocker) => {
  try {
    const { Request } = require('@ghostery/adblocker');
    const r = blocker.match(Request.fromRawDetails({ url: 'https://securepubads.g.doubleclick.net/gampad/ads?x=1', type: 'script', sourceUrl: 'https://example.com/' }));
    return !!r.match;
  } catch { return false; }
};
