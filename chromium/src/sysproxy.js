'use strict';
// Whole-PC mode: points Windows' own proxy setting at Squint's Tor (HTTP tunnel port), so every app that
// follows the Windows proxy setting goes through Tor. The old setting is saved and put back when it is
// turned off, when Squint quits, and by scripts\restore-network.bat if Squint ever dies in between.
const { execFileSync } = require('node:child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const reg = (...a) => execFileSync('reg.exe', a, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

function read(name) {
  try {
    const m = new RegExp(name + '\\s+REG_(?:SZ|DWORD)\\s+(.*)', 'i').exec(reg('query', KEY, '/v', name));
    return m ? m[1].trim() : null;
  } catch { return null; }
}
function write(name, type, val) {
  if (val === null || val === undefined) { try { reg('delete', KEY, '/v', name, '/f'); } catch { /* not there */ } return; }
  reg('add', KEY, '/v', name, '/t', type, '/d', String(val), '/f');
}
// tells running apps to re-read the setting
function refresh() {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      "Add-Type -MemberDefinition '[DllImport(\"wininet.dll\")] public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);' -Name W -Namespace N; [void][N.W]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0); [void][N.W]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)"],
      { windowsHide: true, stdio: 'ignore', timeout: 15000 });
  } catch { /* apps pick it up on their next start */ }
}

// prev: what was there before ({ enable, server, override }) or null. Returns what to remember.
exports.enable = (httpPort, prev) => {
  if (process.platform !== 'win32') throw new Error('Whole-PC mode is Windows only.');
  const keep = prev || { enable: read('ProxyEnable'), server: read('ProxyServer'), override: read('ProxyOverride') };
  write('ProxyServer', 'REG_SZ', '127.0.0.1:' + httpPort);
  write('ProxyOverride', 'REG_SZ', 'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.2*;172.30.*;172.31.*;192.168.*;<local>');
  write('ProxyEnable', 'REG_DWORD', 1);
  refresh();
  return keep;
};

exports.disable = (prev) => {
  if (process.platform !== 'win32') return;
  if (prev) {
    write('ProxyServer', 'REG_SZ', prev.server);
    write('ProxyOverride', 'REG_SZ', prev.override);
    write('ProxyEnable', 'REG_DWORD', prev.enable === null ? 0 : (parseInt(prev.enable, 16) || parseInt(prev.enable, 10) || 0));
  } else write('ProxyEnable', 'REG_DWORD', 0);
  refresh();
};
