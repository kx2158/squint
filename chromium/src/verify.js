'use strict';
const { execFile } = require('node:child_process');
const path = require('node:path');
const { systemPreferences } = require('electron');

// Asks the OS to confirm it is really you: Windows Hello (PIN / fingerprint / face) on Windows,
// Touch ID on macOS. A successful check is remembered for two minutes so you are not nagged.

const WIN_MSG = {
  Canceled: 'Verification cancelled.',
  RetriesExhausted: 'Too many failed attempts.',
  DeviceBusy: 'Windows Hello is busy. Try again.',
  DisabledByPolicy: 'Windows Hello is disabled by policy on this PC.',
  DeviceNotPresent: 'Windows Hello is not set up. Add a PIN in Windows Settings > Accounts > Sign-in options, or turn off verification in settings.',
  NotConfiguredForUser: 'Windows Hello is not set up. Add a PIN in Windows Settings > Accounts > Sign-in options, or turn off verification in settings.',
};

exports.check = async (reason) => {
  if (process.platform === 'darwin') {
    try { await systemPreferences.promptTouchID(reason); return { ok: true }; }
    catch { return { ok: false, error: 'Verification cancelled.' }; }
  }
  if (process.platform !== 'win32') return { ok: false, error: 'Device verification is not available here. Turn it off in settings to continue.' };
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'scripts', 'verify.ps1'), '-Message', reason],
      { windowsHide: true, timeout: 90000 }, (err, out) => {
        const status = String(out || '').trim().split(/\r?\n/).pop();
        if (status === 'Verified') return resolve({ ok: true });
        resolve({ ok: false, error: WIN_MSG[status] || ('Windows Hello did not respond' + (status ? ': ' + status : err ? ': ' + err.message : '')) });
      });
  });
};
