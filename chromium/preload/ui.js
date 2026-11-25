'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, ...a) => ipcRenderer.invoke('ui:' + ch, ...a),
  on: (ch, cb) => ipcRenderer.on(ch, (_e, ...a) => cb(...a)),
  platform: process.platform,
});
