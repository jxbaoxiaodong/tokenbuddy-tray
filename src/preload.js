'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tb', {
  getConfig: () => ipcRenderer.invoke('tb:getConfig'),
  getSnapshot: () => ipcRenderer.invoke('tb:getSnapshot'),
  saveConfig: (cfg) => ipcRenderer.invoke('tb:saveConfig', cfg),
  refresh: () => ipcRenderer.invoke('tb:refresh'),
  setActive: (id) => ipcRenderer.invoke('tb:setActive', id),
  openSettings: () => ipcRenderer.send('tb:openSettings'),
  hidePopup: () => ipcRenderer.send('tb:hidePopup'),
  quit: () => ipcRenderer.send('tb:quit'),
  openExternal: (url) => ipcRenderer.send('tb:openExternal', url),
  onUpdate: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('tb:update', h);
    return () => ipcRenderer.removeListener('tb:update', h);
  },
});
