'use strict';
// Colour themes. Each one is three soft colours; the toolbar, start page and settings all draw from them.
const THEMES = [
  { id: 'system', name: 'System', dark: null, c: null, accent: '#5b7cfa' },
  { id: 'dusk', name: 'Dusk', dark: true, c: ['#1b1a2e', '#2a2140', '#3a2a4a'], accent: '#a78bfa' },
  { id: 'midnight', name: 'Midnight', dark: true, c: ['#0f1724', '#14263a', '#17353f'], accent: '#5eead4' },
  { id: 'ember', name: 'Ember', dark: true, c: ['#1c1517', '#2a1a1d', '#3a2326'], accent: '#fb923c' },
  { id: 'moss', name: 'Moss', dark: true, c: ['#111a16', '#192a24', '#22332f'], accent: '#86efac' },
  { id: 'graphite', name: 'Graphite', dark: true, c: ['#141416', '#1c1c21', '#26262d'], accent: '#8ba2ff' },
  { id: 'haze', name: 'Haze', dark: false, c: ['#f1ecfb', '#fbecf3', '#fdf0e6'], accent: '#7c6cf0' },
  { id: 'sand', name: 'Sand', dark: false, c: ['#f6f1e9', '#f2ebe0', '#ece4d8'], accent: '#c2762f' },
  { id: 'sky', name: 'Sky', dark: false, c: ['#eaf2fb', '#e6f0f8', '#ecf6f3'], accent: '#3b82f6' },
];
exports.LIST = THEMES.map(({ id, name, dark, c, accent }) => ({ id, name, dark, c, accent }));

// Returns everything a page needs to paint itself: css variables, gradients, title bar colours.
exports.resolve = (settings, systemDark, systemAccent) => {
  const t = THEMES.find((x) => x.id === settings.theme) || THEMES[0];
  const dark = t.dark === null ? !!systemDark : t.dark;
  const hex = (v) => /^#[0-9a-f]{6}$/i.test(v || '');
  // your own pick wins, otherwise the Windows/macOS accent colour, otherwise the theme's
  const accent = hex(settings.accent) ? settings.accent : hex(systemAccent) ? systemAccent : t.accent;
  const vars = dark
    ? { '--field': 'rgba(255,255,255,.08)', '--hover': 'rgba(255,255,255,.07)', '--press': 'rgba(255,255,255,.13)', '--line': 'rgba(255,255,255,.1)',
        '--text': '#ececee', '--muted': '#a0a0ad', '--panel': '#1f1f27' }
    : { '--field': 'rgba(0,0,0,.06)', '--hover': 'rgba(0,0,0,.055)', '--press': 'rgba(0,0,0,.1)', '--line': 'rgba(0,0,0,.09)',
        '--text': '#1a1a1a', '--muted': '#6f6f78', '--panel': '#ffffff' };
  vars['--accent'] = accent;
  let grad = null, chrome = null, bg, titleBg;
  if (t.c) {
    grad = `linear-gradient(135deg, ${t.c[0]} 0%, ${t.c[1]} 55%, ${t.c[2]} 100%)`;
    chrome = `linear-gradient(90deg, ${t.c[0]}, ${t.c[1]} 55%, ${t.c[2]})`;
    bg = t.c[1]; titleBg = t.c[2];
    vars['--bg'] = t.c[1];
  } else {
    bg = dark ? '#19191b' : '#f6f6f5'; titleBg = bg;
    vars['--bg'] = bg;
    vars['--field'] = dark ? '#252528' : '#ebebea'; vars['--panel'] = dark ? '#202023' : '#ffffff';
    vars['--muted'] = dark ? '#8e8e93' : '#77777a';
    vars['--accent'] = accent;
  }
  return { id: t.id, dark, vars, grad, chrome, bg, titleBg, fg: dark ? '#ececee' : '#1a1a1a', accent: vars['--accent'], frost: Number(settings.frost) >= 0 ? Number(settings.frost) : 18 };
};
