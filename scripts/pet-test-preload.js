// 测试用 preload:提供 src/pet/pet.js 需要的 window.tb,并把两个测试钩子挂在 window.tb 上
const { contextBridge } = require('electron');

const updateCallbacks = [];
const reloadCallbacks = [];

contextBridge.exposeInMainWorld('tb', {
  onUpdate: (cb) => { updateCallbacks.push(cb); },

  pet: {
    get: async () => ({
      size: 200, opacity: 1, flip: false, showBalance: true,
      mediaType: 'image', asset: null, snapshot: null,
    }),
    onReload: (cb) => { reloadCallbacks.push(cb); },
    sendAlpha: () => {},
    press: () => {}, release: () => {},
    dragStart: () => {}, drag: () => {}, dragEnd: () => {},
    panel: () => {}, menu: () => {},
  },

  /* 测试钩子 */
  __pushSnap: (snap) => { updateCallbacks.forEach((cb) => cb(snap)); },
  __reload: (payload) => { reloadCallbacks.forEach((cb) => cb(payload)); },
});