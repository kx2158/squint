'use strict';
// Adult-site blocklist. Built from public registries (hosts-format lists of adult sites and the
// ad networks that serve adult ads). Saved as one domain per line in lists/adult.dat.
exports.SOURCES = [
  'https://raw.githubusercontent.com/blocklistproject/Lists/master/porn.txt',
  'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts',
  'https://blocklistproject.github.io/Lists/alt-version/porn-nl.txt',
];
exports.parse = (text) => {
  const out = new Set();
  for (let line of String(text).split(/\r?\n/)) {
    line = line.replace(/#.*/, '').trim().toLowerCase();
    if (!line) continue;
    const m = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+(\S+)$/) || line.match(/^([a-z0-9][a-z0-9._-]*\.[a-z]{2,})$/);
    if (!m) continue;
    const d = m[1];
    if (d === 'localhost' || /^\d+(\.\d+){3}$/.test(d) || !d.includes('.')) continue;
    out.add(d);
  }
  return out;
};
