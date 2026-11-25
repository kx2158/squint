'use strict';
// Pulls the uBlock Origin filter lists (uAssets, open source) plus EasyList/EasyPrivacy
// to disk. The browser only ever reads them from disk, so it makes no list requests at runtime.
// Re-run `npm run lists` whenever you want fresh lists.
const fs = require('node:fs');
const path = require('node:path');

// Your fork is the source of truth: its assets/assets.json says which lists are on by default.
const FORK = 'kx2158/uBlock';
const FORK_BRANCHES = ['master', 'main'];
const U = 'https://ublockorigin.github.io/uAssets/filters/';
const LISTS = {
  'ubo-filters': U + 'filters.txt',
  'ubo-badware': U + 'badware.txt',
  'ubo-privacy': U + 'privacy.txt',
  'ubo-quick-fixes': U + 'quick-fixes.txt',
  'ubo-unbreak': U + 'unbreak.txt',
  'ubo-resource-abuse': U + 'resource-abuse.txt',
  'ubo-annoyances-cookies': U + 'annoyances-cookies.txt',
  'ubo-annoyances-others': U + 'annoyances-others.txt',
  'easylist': 'https://easylist.to/easylist/easylist.txt',
  'easyprivacy': 'https://easylist.to/easylist/easyprivacy.txt',
};

// uBO scriptlets/redirect resources (what stops YouTube-style ads). Tries uBO's own repo build
// first, then the copy Ghostery's blocker ships. Saved as lists/resources.dat.
const RES = [
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.txt',
  'https://cdn.jsdelivr.net/gh/ghostery/adblocker@master/packages/adblocker/assets/ublock-origin/resources.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resources.txt',
];

const adultMod = require('../src/adult');
async function fetchAdult(dir) {
  const all = new Set();
  for (const u of adultMod.SOURCES) {
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      for (const d of adultMod.parse(await r.text())) all.add(d);
      console.log('ok   adult', u);
    } catch (e) { console.warn('FAIL adult', u, e.message); }
  }
  if (all.size > 1000) { fs.writeFileSync(path.join(dir, 'adult.dat'), [...all].join('\n')); console.log(`adult list: ${all.size} domains`); }
}

(async () => {
  if (process.argv.includes('--adult-only')) { const d = path.join(__dirname, '..', 'lists'); fs.mkdirSync(d, { recursive: true }); return fetchAdult(d); }
  const dir0 = path.join(__dirname, '..', 'lists');
  fs.mkdirSync(dir0, { recursive: true });
  const resFile = path.join(dir0, 'resources.dat');
  if (process.argv.includes('--resources-only') && fs.existsSync(resFile)) return;
  for (const u of RES) {
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      if (t.length < 5000) throw new Error('too small');
      fs.writeFileSync(resFile, t);
      console.log('ok   resources from', u);
      break;
    } catch (e) { console.warn('FAIL resources', u, e.message); }
  }
  if (process.argv.includes('--resources-only')) return;
  const dir = path.join(__dirname, '..', 'lists');
  fs.mkdirSync(dir, { recursive: true });
  let lists = { ...LISTS }, fromFork = 0;
  for (const b of FORK_BRANCHES) {
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${FORK}/${b}/assets/assets.json`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const a = await r.json();
      const picked = {};
      for (const [k, v] of Object.entries(a)) {
        if (v.content !== 'filters' || v.off || v.off === true) continue;
        const u = [].concat(v.contentURL || []).find((x) => /^https:/.test(x));
        if (u) picked[k] = u;
      }
      if (Object.keys(picked).length >= 4) {
        // keep the extra annoyance lists on top of the fork's defaults
        lists = { ...picked, 'ubo-annoyances-cookies': LISTS['ubo-annoyances-cookies'], 'ubo-annoyances-others': LISTS['ubo-annoyances-others'], 'ubo-resource-abuse': LISTS['ubo-resource-abuse'] };
        fromFork = Object.keys(picked).length;
        console.log(`lists chosen by ${FORK}@${b}: ${fromFork} default lists`);
        break;
      }
    } catch (e) { console.warn('fork assets.json', b, e.message); }
  }
  if (!fromFork) console.warn('Could not read the fork, using the built-in uBO list set.');
  let ok = 0;
  const keep = new Set();
  for (const [name, url] of Object.entries(lists)) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      fs.writeFileSync(path.join(dir, name + '.txt'), await res.text());
      keep.add(name + '.txt');
      console.log('ok  ', name);
      ok++;
    } catch (e) {
      console.warn('FAIL', name, e.message);
    }
  }
  if (fromFork && ok >= 5) for (const x of fs.readdirSync(dir)) if (x.endsWith('.txt') && !keep.has(x)) fs.unlinkSync(path.join(dir, x));
  console.log(`${ok}/${Object.keys(lists).length} lists in ${dir}`);
})().catch((e) => { console.warn(e.message); }).finally(() => process.exit(0));
