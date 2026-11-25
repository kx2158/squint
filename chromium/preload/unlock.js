'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('unlockApi', {
  init: () => ipcRenderer.invoke('unlock:init'),
  pass: (p) => ipcRenderer.invoke('unlock:pass', p),
  hello: () => ipcRenderer.invoke('unlock:hello'),
  set: (p) => ipcRenderer.invoke('unlock:set', p),
  cancel: () => ipcRenderer.invoke('unlock:cancel'),
});
