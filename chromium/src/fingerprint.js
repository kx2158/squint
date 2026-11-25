'use strict';
// Fingerprint resistance. `inject` is serialised and run in the page's own world, in every frame,
// before any page script. Each section is isolated so one failing API never disables the rest.
// It makes the browser look like one generic Windows Chrome: same values for everyone.
function inject(O) {
  const native = new WeakMap();
  const fts = Function.prototype.toString;
  const fakeTS = function toString() { const n = native.get(this); return n !== undefined ? n : fts.call(this); };
  native.set(fakeTS, 'function toString() { [native code] }');
  Object.defineProperty(Function.prototype, 'toString', { value: fakeTS, writable: true, configurable: true });
  const mask = (fn, name) => { try { native.set(fn, 'function ' + name + '() { [native code] }'); } catch (e) { /* ignore */ } return fn; };
  const part = (f) => { try { f(); } catch (e) { /* this section is skipped */ } };
  const proto = (n) => (typeof globalThis[n] === 'function' ? globalThis[n].prototype : null);
  const put = (obj, name, fn) => {
    if (!obj) return;
    const f = { [name](...a) { return fn.apply(this, a); } }[name];
    mask(f, name);
    Object.defineProperty(obj, name, { value: f, writable: true, configurable: true, enumerable: false });
  };
  const get = (obj, prop, val) => {
    if (!obj) return;
    const g = { [prop]() { return typeof val === 'function' ? val.call(this) : val; } }[prop];
    const gg = function () { return g.call(this); };
    mask(gg, 'get ' + prop);
    Object.defineProperty(obj, prop, { get: gg, set: undefined, enumerable: true, configurable: true });
  };
  const drop = (obj, prop) => { if (obj) { try { delete obj[prop]; } catch (e) { /* ignore */ } } };

  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = (seed) => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Same site, same session: same noise (so pages do not see it change). New session or site: new noise.
  const SEED = hash(O.seed + '|' + (location.origin || ''));

  const noisePixels = (d) => {
    if (!d || !d.length || d.length > 8000000) return;
    const r = rng(SEED ^ d.length);
    const n = Math.max(4, d.length >> 7);
    const px = d.length >> 2;
    for (let k = 0; k < n; k++) { const i = Math.floor(r() * px) * 4 + Math.floor(r() * 3); d[i] ^= 1; }
  };

  // ---- canvas ----
  part(() => {
    const C2 = proto('CanvasRenderingContext2D');
    const CV = proto('HTMLCanvasElement');
    if (!C2 || !CV) return;
    const oGet = C2.getImageData, oPut = C2.putImageData;
    // strict: reading pixels back returns an empty picture of the same size, identical for everyone
    put(C2, 'getImageData', function (...a) { const r = oGet.apply(this, a); if (O.strict) r.data.fill(0); else noisePixels(r.data); return r; });
    const noisy = (cv) => {
      const w = cv.width, h = cv.height;
      if (!w || !h || w * h > 2000000) return null;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      if (O.strict) return c;
      const x = c.getContext('2d');
      x.drawImage(cv, 0, 0);
      const id = oGet.call(x, 0, 0, w, h);
      noisePixels(id.data);
      oPut.call(x, id, 0, 0);
      return c;
    };
    const oUrl = CV.toDataURL, oBlob = CV.toBlob;
    put(CV, 'toDataURL', function (...a) { let c = null; try { c = noisy(this); } catch (e) { /* use original */ } return oUrl.apply(c || this, a); });
    put(CV, 'toBlob', function (...a) { let c = null; try { c = noisy(this); } catch (e) { /* use original */ } return oBlob.apply(c || this, a); });
    const OC = proto('OffscreenCanvas');
    if (OC && OC.convertToBlob) {
      const o = OC.convertToBlob;
      put(OC, 'convertToBlob', function (...a) {
        try {
          if (this.width && this.height && this.width * this.height <= 2000000) {
            const c = new OffscreenCanvas(this.width, this.height);
            if (O.strict) return o.apply(c, a);
            const x = c.getContext('2d');
            x.drawImage(this, 0, 0);
            const id = x.getImageData(0, 0, this.width, this.height);
            x.putImageData(id, 0, 0);
            return o.apply(c, a);
          }
        } catch (e) { /* fall through */ }
        return o.apply(this, a);
      });
    }
  });

  // ---- WebGL ----
  part(() => {
    const VENDOR = 'Google Inc. (Intel)';
    const RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    // High-end graphics cards report bigger limits and rarer extensions; clamp both to a common card.
    const CAP = { 0x0D33: 16384, 0x851C: 16384, 0x84E8: 16384, 0x8869: 16, 0x8DFB: 4095, 0x8DFC: 30, 0x8B4D: 32, 0x8B4C: 16, 0x8872: 16, 0x8DFD: 1024, 0x8073: 2048, 0x88FF: 2048 };
    const EXT = new Set(['ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float', 'EXT_color_buffer_float', 'EXT_disjoint_timer_query', 'EXT_disjoint_timer_query_webgl2', 'EXT_float_blend', 'EXT_frag_depth', 'EXT_shader_texture_lod', 'EXT_sRGB', 'EXT_texture_compression_bptc', 'EXT_texture_compression_rgtc', 'EXT_texture_filter_anisotropic', 'EXT_texture_norm16', 'KHR_parallel_shader_compile', 'OES_draw_buffers_indexed', 'OES_element_index_uint', 'OES_fbo_render_mipmap', 'OES_standard_derivatives', 'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float', 'OES_texture_half_float_linear', 'OES_vertex_array_object', 'OVR_multiview2', 'WEBGL_color_buffer_float', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb', 'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders', 'WEBGL_depth_texture', 'WEBGL_draw_buffers', 'WEBGL_lose_context', 'WEBGL_multi_draw']);
    for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const P = proto(name);
      if (!P) continue;
      const oParam = P.getParameter, oRead = P.readPixels;
      put(P, 'getParameter', function (p) {
        if (CAP[p] !== undefined) { const v = oParam.call(this, p); return typeof v === 'number' ? Math.min(v, CAP[p]) : v; }
        if (p === 0x9245) return VENDOR;
        if (p === 0x9246) return RENDERER;
        if (p === 0x1F00) return 'WebKit';
        if (p === 0x1F01) return 'WebKit WebGL';
        return oParam.call(this, p);
      });
      put(P, 'readPixels', function (...a) {
        const r = oRead.apply(this, a);
        const px = a[6];
        if (px && (px instanceof Uint8Array || px instanceof Uint8ClampedArray)) { if (O.strict) px.fill(0); else noisePixels(px); }
        return r;
      });
      const oSup = P.getSupportedExtensions, oExt = P.getExtension;
      put(P, 'getSupportedExtensions', function () { const r = oSup.call(this); return r ? r.filter((e) => EXT.has(e)) : r; });
      put(P, 'getExtension', function (n) { return EXT.has(n) ? oExt.call(this, n) : null; });
    }
  });

  // ---- audio ----
  part(() => {
    const done = new WeakSet();
    const wob = (a, seed) => {
      if (done.has(a)) return;
      done.add(a);
      const r = rng(SEED ^ seed ^ a.length);
      const n = Math.min(a.length, 600000);
      for (let i = 0; i < n; i++) a[i] *= 1 + (r() - 0.5) * 2e-7;
    };
    const AB = proto('AudioBuffer');
    if (AB) {
      const og = AB.getChannelData, oc = AB.copyFromChannel;
      put(AB, 'getChannelData', function (c) { const a = og.call(this, c); wob(a, c); return a; });
      put(AB, 'copyFromChannel', function (dst, c, off) { const r = oc.call(this, dst, c, off); wob(dst, 77 + c); return r; });
    }
    const AN = proto('AnalyserNode');
    if (AN) {
      const f = AN.getFloatFrequencyData, b = AN.getByteFrequencyData;
      put(AN, 'getFloatFrequencyData', function (a) { f.call(this, a); const r = rng(SEED ^ 5); for (let i = 0; i < a.length; i++) a[i] += (r() - 0.5) * 0.2; });
      put(AN, 'getByteFrequencyData', function (a) { b.call(this, a); const r = rng(SEED ^ 6); for (let i = 0; i < a.length; i += 7) if (a[i] > 0 && a[i] < 255) a[i] += r() < 0.5 ? 1 : -1; });
    }
  });

  // ---- navigator ----
  part(() => {
    const N = proto('Navigator');
    get(N, 'hardwareConcurrency', 8);
    get(N, 'deviceMemory', 8);
    get(N, 'platform', 'Win32');
    get(N, 'language', 'en-US');
    get(N, 'languages', () => Object.freeze(['en-US', 'en']));
    get(N, 'maxTouchPoints', 0);
    get(N, 'vendor', 'Google Inc.');
    get(N, 'connection', { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false, addEventListener() {}, removeEventListener() {} });
    for (const p of ['getBattery', 'bluetooth', 'usb', 'hid', 'serial', 'xr', 'keyboard', 'presentation', 'getInstalledRelatedApps', 'contacts', 'wakeLock', 'ink', 'managed']) drop(N, p);
    if (N && N.getGamepads) put(N, 'getGamepads', () => []);
    const MD = proto('MediaDevices');
    if (MD && MD.enumerateDevices) put(MD, 'enumerateDevices', () => Promise.resolve([]));
    const SM = proto('StorageManager');
    if (SM && SM.estimate) put(SM, 'estimate', () => Promise.resolve({ quota: 2147483648, usage: 0 }));
    const SS = proto('SpeechSynthesis');
    if (SS && SS.getVoices) put(SS, 'getVoices', () => []);
    drop(globalThis, 'queryLocalFonts');
    drop(globalThis, 'getScreenDetails');

    const UA = proto('NavigatorUAData');
    if (UA) {
      const V = String(O.chrome);
      const brands = [{ brand: 'Chromium', version: V }, { brand: 'Google Chrome', version: V }, { brand: 'Not-A.Brand', version: '24' }];
      get(UA, 'platform', 'Windows');
      get(UA, 'mobile', false);
      get(UA, 'brands', () => brands.map((b) => ({ ...b })));
      put(UA, 'getHighEntropyValues', () => Promise.resolve({
        brands: brands.map((b) => ({ ...b })), mobile: false, platform: 'Windows', architecture: 'x86', bitness: '64', model: '',
        platformVersion: '10.0.0', uaFullVersion: V + '.0.0.0', wow64: false, formFactors: ['Desktop'],
        fullVersionList: brands.map((b) => ({ brand: b.brand, version: V + '.0.0.0' })),
      }));
    }
  });

  // ---- plugins: Electron lists one PDF plugin, real Chrome lists five, which makes it stand out ----
  part(() => {
    const N = proto('Navigator');
    const mk = (base, props) => { const o = Object.create(base || Object.prototype); for (const k of Object.keys(props)) Object.defineProperty(o, k, { value: props[k], enumerable: true, configurable: true }); return o; };
    const hide = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: false, configurable: true, writable: true });
    const mimes = ['application/pdf', 'text/pdf'].map((type) => mk(proto('MimeType'), { type, suffixes: 'pdf', description: 'Portable Document Format' }));
    const plugins = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'].map((name) => {
      const p = mk(proto('Plugin'), { name, filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2, 0: mimes[0], 1: mimes[1] });
      hide(p, 'item', mask(function item(i) { return mimes[i] || null; }, 'item'));
      hide(p, 'namedItem', mask(function namedItem(n) { return mimes.find((m) => m.type === n) || null; }, 'namedItem'));
      return p;
    });
    for (const m of mimes) hide(m, 'enabledPlugin', plugins[0]);
    const arr = (base, list, key) => {
      const o = mk(base, { length: list.length });
      list.forEach((x, i) => { Object.defineProperty(o, i, { value: x, enumerable: true, configurable: true }); hide(o, x[key], x); });
      hide(o, 'item', mask(function item(i) { return list[i] || null; }, 'item'));
      hide(o, 'namedItem', mask(function namedItem(n) { return list.find((x) => x[key] === n) || null; }, 'namedItem'));
      return o;
    };
    const pa = arr(proto('PluginArray'), plugins, 'name');
    hide(pa, 'refresh', mask(function refresh() {}, 'refresh'));
    const ma = arr(proto('MimeTypeArray'), mimes, 'type');
    get(N, 'plugins', pa); get(N, 'mimeTypes', ma); get(N, 'pdfViewerEnabled', true);
    get(N, 'doNotTrack', null);
  });

  // ---- fonts: pages cannot probe which fonts are installed through scripts ----
  // Probes set a candidate family from JS and measure the text. Families that are not common Windows
  // fonts or fonts the page loaded itself are dropped from what scripts assign, so every candidate
  // looks "not installed". Fonts written in the page's own stylesheets are untouched.
  part(() => {
    const SAFE = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset', 'revert',
      'arial', 'arial black', 'arial narrow', 'calibri', 'cambria', 'cambria math', 'candara', 'comic sans ms', 'consolas', 'constantia', 'corbel', 'courier new', 'courier', 'georgia', 'impact', 'lucida console', 'lucida sans unicode',
      'microsoft sans serif', 'palatino linotype', 'segoe ui', 'segoe ui emoji', 'segoe ui symbol', 'tahoma', 'times new roman', 'times', 'trebuchet ms', 'verdana', 'helvetica', 'webdings', 'wingdings', 'ms gothic', 'sylfaen']);
    const loaded = () => { const l = new Set(); try { document.fonts.forEach((f) => l.add(String(f.family).replace(/^["']|["']$/g, '').trim().toLowerCase())); } catch (e) { /* none */ } return l; };
    const clean = (list) => {
      const parts = String(list).match(/(?:[^,"']|"[^"]*"|'[^']*')+/g);
      if (!parts) return list;
      const ld = loaded();
      const keep = parts.map((x) => x.trim()).filter((t) => t && (/^(var|env|attr)\(/i.test(t) || /!important$/i.test(t) || SAFE.has(t.replace(/^["']|["']$/g, '').trim().toLowerCase()) || ld.has(t.replace(/^["']|["']$/g, '').trim().toLowerCase())));
      return keep.length ? keep.join(', ') : 'sans-serif';
    };
    const SIZE = /^(.*?\d(?:\.\d+)?(?:px|pt|em|rem|%|ex|ch|vw|vh|cm|mm|in|pc|q)(?:\s*\/\s*[^\s]+)?)\s+(.+)$/i;
    const shorthand = (v) => { const m = SIZE.exec(String(v)); return m ? m[1] + ' ' + clean(m[2]) : v; };
    const wrapSetter = (obj, prop, fix) => {
      const d = obj && Object.getOwnPropertyDescriptor(obj, prop);
      if (!d || !d.set) return;
      const set = function (v) { d.set.call(this, fix(v)); };
      mask(set, 'set ' + prop);
      Object.defineProperty(obj, prop, { get: d.get, set, enumerable: d.enumerable, configurable: true });
    };
    const CS = proto('CSSStyleDeclaration');
    wrapSetter(CS, 'fontFamily', clean);
    wrapSetter(CS, 'font', shorthand);
    wrapSetter(proto('CanvasRenderingContext2D'), 'font', shorthand);
    wrapSetter(proto('OffscreenCanvasRenderingContext2D'), 'font', shorthand);
    if (CS && CS.setProperty) {
      const o = CS.setProperty;
      put(CS, 'setProperty', function (n, v, pr) {
        const k = String(n).toLowerCase();
        if (k === 'font-family') v = clean(v); else if (k === 'font') v = shorthand(v);
        return o.call(this, n, v, pr);
      });
    }
    const FS = proto('FontFaceSet');
    if (FS && FS.check) { const o = FS.check; put(FS, 'check', function (f, t) { return o.call(this, shorthand(f), t); }); }
  });

  // ---- screen and window ----
  part(() => {
    const S = proto('Screen');
    if (O.letterbox) {
      // the page area is already rounded to 200 x 100 steps, so report it as the screen
      get(S, 'width', () => globalThis.innerWidth); get(S, 'height', () => globalThis.innerHeight);
      get(S, 'availWidth', () => globalThis.innerWidth); get(S, 'availHeight', () => globalThis.innerHeight);
    } else {
      get(S, 'width', 1920); get(S, 'height', 1080);
      get(S, 'availWidth', 1920); get(S, 'availHeight', 1040);
    }
    get(S, 'availLeft', 0); get(S, 'availTop', 0);
    get(S, 'colorDepth', 24); get(S, 'pixelDepth', 24);
    const w = (prop, fn) => { try { const g = function () { return fn(); }; mask(g, 'get ' + prop); Object.defineProperty(globalThis, prop, { get: g, set: undefined, configurable: true, enumerable: true }); } catch (e) { /* ignore */ } };
    w('devicePixelRatio', () => 1);
    w('outerWidth', () => globalThis.innerWidth);
    w('outerHeight', () => globalThis.innerHeight);
    w('screenX', () => 0); w('screenY', () => 0); w('screenLeft', () => 0); w('screenTop', () => 0);
  });

  // ---- time zone and locale: everyone is UTC / en-US ----
  part(() => {
    const D = Date.prototype;
    for (const n of ['FullYear', 'Month', 'Date', 'Day', 'Hours', 'Minutes', 'Seconds', 'Milliseconds']) put(D, 'get' + n, D['getUTC' + n]);
    for (const n of ['FullYear', 'Month', 'Date', 'Hours', 'Minutes', 'Seconds', 'Milliseconds']) put(D, 'set' + n, D['setUTC' + n]);
    put(D, 'getTimezoneOffset', () => 0);
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const p2 = (n) => String(n).padStart(2, '0');
    const dateS = (d) => DAYS[d.getUTCDay()] + ' ' + MON[d.getUTCMonth()] + ' ' + p2(d.getUTCDate()) + ' ' + String(d.getUTCFullYear()).padStart(4, '0');
    const timeS = (d) => p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()) + ' GMT+0000 (Coordinated Universal Time)';
    const valid = (d) => !isNaN(D.getTime.call(d));
    put(D, 'toString', function () { return valid(this) ? dateS(this) + ' ' + timeS(this) : 'Invalid Date'; });
    put(D, 'toDateString', function () { return valid(this) ? dateS(this) : 'Invalid Date'; });
    put(D, 'toTimeString', function () { return valid(this) ? timeS(this) : 'Invalid Date'; });
    for (const n of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
      const o = D[n];
      put(D, n, function (l, opt) { return o.call(this, l === undefined ? 'en-US' : l, Object.assign({ timeZone: 'UTC' }, opt)); });
    }
    for (const k of ['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules', 'ListFormat', 'RelativeTimeFormat']) {
      const T = Intl[k];
      if (!T) continue;
      const fix = (a) => { const b = a.slice(); if (b[0] === undefined) b[0] = 'en-US'; if (k === 'DateTimeFormat') b[1] = Object.assign({ timeZone: 'UTC' }, b[1]); return b; };
      const P = new Proxy(T, {
        construct: (t, a, nt) => Reflect.construct(t, fix(a), nt === P ? t : nt),
        apply: (t, th, a) => t(...fix(a)),
      });
      native.set(P, 'function ' + k + '() { [native code] }');
      Object.defineProperty(Intl, k, { value: P, writable: true, configurable: true, enumerable: false });
    }
  });

  // ---- timers: 1 ms resolution ----
  part(() => {
    const P = proto('Performance');
    if (!P) return;
    const o = P.now;
    put(P, 'now', function () { return Math.floor(o.call(this)); });
  });

  // ---- extra surfaces: GPU API, display capabilities, memory numbers ----
  part(() => {
    // WebGPU reports adapter vendor, architecture and limits of the real graphics card
    drop(globalThis.Navigator && Navigator.prototype, 'gpu');
    drop(globalThis.WorkerNavigator && WorkerNavigator.prototype, 'gpu');
    const NAV = proto('Navigator');
    if (NAV) get(NAV, 'webdriver', false);
    // heap sizes differ per machine
    const PF = proto('Performance');
    if (PF) { try { delete PF.memory; } catch (e) { /* ignore */ } try { Object.defineProperty(performance, 'memory', { get: () => ({ jsHeapSizeLimit: 2330000000, totalJSHeapSize: 35000000, usedJSHeapSize: 25000000 }), configurable: true }); } catch (e) { /* ignore */ } }
    const SC = proto('Screen');
    drop(SC, 'isExtended');
    // screen.orientation: always landscape
    try { const SO = proto('ScreenOrientation'); if (SO) { get(SO, 'type', 'landscape-primary'); get(SO, 'angle', 0); } } catch (e) { /* ignore */ }
    // Media queries that reveal the display: wide colour, HDR, and accessibility settings answer like a plain monitor
    const T = '(min-width: 0px)', F = '(min-width: 2147483647px)';
    const swap = (q) => String(q)
      .replace(/\(\s*(?:video-)?dynamic-range\s*:\s*high\s*\)/gi, F)
      .replace(/\(\s*(?:video-)?dynamic-range\s*:\s*standard\s*\)/gi, T)
      .replace(/\(\s*color-gamut\s*:\s*(?:p3|rec2020)\s*\)/gi, F)
      .replace(/\(\s*color-gamut\s*:\s*srgb\s*\)/gi, T)
      .replace(/\(\s*(?:prefers-reduced-motion|prefers-reduced-transparency|prefers-reduced-data)\s*:\s*reduce\s*\)/gi, F)
      .replace(/\(\s*(?:prefers-reduced-motion|prefers-reduced-transparency|prefers-reduced-data)\s*:\s*no-preference\s*\)/gi, T)
      .replace(/\(\s*prefers-contrast\s*:\s*(?:more|less|custom)\s*\)/gi, F)
      .replace(/\(\s*prefers-contrast\s*:\s*no-preference\s*\)/gi, T)
      .replace(/\(\s*forced-colors\s*:\s*active\s*\)/gi, F)
      .replace(/\(\s*forced-colors\s*:\s*none\s*\)/gi, T)
      .replace(/\(\s*inverted-colors\s*:\s*inverted\s*\)/gi, F)
      .replace(/\(\s*inverted-colors\s*:\s*none\s*\)/gi, T);
    const mm = globalThis.matchMedia;
    if (typeof mm === 'function') put(globalThis, 'matchMedia', function (q) { return mm.call(this, swap(q)); });
  });

  // ---- WebRTC (leaks local network addresses) ----
  if (O.noRtc) {
    for (const n of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate', 'RTCDataChannel', 'RTCRtpReceiver', 'RTCRtpSender']) drop(globalThis, n);
  }
}

exports.inject = inject;
exports.build = (opts) => '(' + inject.toString() + ')(' + JSON.stringify(opts) + ');';
