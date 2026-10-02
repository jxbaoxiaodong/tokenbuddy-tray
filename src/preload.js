'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tb', {
  // 通用
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
  onGoto: (cb) => {
    const h = (_e, section) => cb(section);
    ipcRenderer.on('tb:goto', h);
    return () => ipcRenderer.removeListener('tb:goto', h);
  },

  // 桌面宠物
  pet: {
    get: () => ipcRenderer.invoke('pet:get'),
    choose: () => ipcRenderer.invoke('pet:choose'),
    set: (patch) => ipcRenderer.invoke('pet:set', patch),
    toggle: () => ipcRenderer.invoke('pet:toggle'),
    autostart: (v) => ipcRenderer.invoke('pet:autostart', v),
    sendAlpha: (grid) => ipcRenderer.send('pet:alpha', grid),
    dragStart: (cursor) => ipcRenderer.send('pet:dragstart', cursor),
    drag: (cursor) => ipcRenderer.send('pet:drag', cursor),
    dragEnd: () => ipcRenderer.send('pet:dragend'),
    menu: () => ipcRenderer.send('pet:menu'),
    panel: () => ipcRenderer.send('pet:panel'),
    onReload: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('pet:reload', h);
      return () => ipcRenderer.removeListener('pet:reload', h);
    },
  },
});
