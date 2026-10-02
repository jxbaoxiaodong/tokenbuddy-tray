'use strict';

const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, screen, safeStorage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { fetchBalance } = require('./lib/adapters');
const { renderTextIcon, shortBalance, colorForBalance } = require('./lib/icon');

const DEFAULT_CONFIG = {
  refreshSeconds: 120,
  activeSiteId: null,
  sites: [],
  pet: {
    enabled: false,
    assetPath: '',      // 已复制到 userData/pets/ 下的形象文件
    mediaType: 'image', // image | video
    size: 200,
    opacity: 1,
    alwaysOnTop: true,
    showBalance: true,
    flip: false,
    position: null,     // {x,y}
  },
};
const SECRET_FIELDS = ['password', 'accessToken', 'apiKey'];
const DEBUG = process.argv.includes('--dev') || !!process.env.TB_DEBUG;
const PET_MARGIN = 16;
const BUBBLE_H = 46;

let tray = null;
let popup = null;
let settingsWin = null;
let petWin = null;
let config = null;
let results = {};
let refreshing = false;
let pollTimer = null;
let petAlpha = null;   // { cols, rows, data:Uint8Array }
let petIgnoring = null;
let petPollTimer = null;
let petDrag = null;

/* ----------------------------- 配置存储 ----------------------------- */
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function encSecret(v) {
  if (!v) return '';
  try { if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(String(v)).toString('base64'); } catch (e) {}
  return String(v);
}
function decSecret(v) {
  if (!v) return '';
  if (String(v).startsWith('enc:')) { try { return safeStorage.decryptString(Buffer.from(String(v).slice(4), 'base64')); } catch (e) { return ''; } }
  return String(v);
}
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    config = Object.assign({}, DEFAULT_CONFIG, raw);
    config.pet = Object.assign({}, DEFAULT_CONFIG.pet, raw.pet || {});
    config.sites = (config.sites || []).map((s) => ({ ...s }));
  } catch (e) { config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}
function plainSite(site) { const s = { ...site }; for (const f of SECRET_FIELDS) s[f] = decSecret(site[f]); return s; }
function rendererConfig() {
  return {
    refreshSeconds: config.refreshSeconds, activeSiteId: config.activeSiteId,
    sites: config.sites.map((s) => { const o = { ...s }; for (const f of SECRET_FIELDS) o[f] = decSecret(s[f]); return o; }),
    pet: { ...config.pet },
  };
}

/* ----------------------------- 余额刷新 ----------------------------- */
function activeSite() { if (!config.sites.length) return null; return config.sites.find((s) => s.id === config.activeSiteId) || config.sites[0]; }
async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  broadcast({ refreshing: true });
  await Promise.all(config.sites.slice().map(async (s) => {
    try {
      const r = await fetchBalance(plainSite(s));
      results[s.id] = { ...r, error: null, at: Date.now() };
      if (DEBUG) console.log('[tb]', s.name, 'ok', JSON.stringify(r));
    } catch (e) {
      results[s.id] = { error: e.message || String(e), at: Date.now() };
      if (DEBUG) console.log('[tb]', s.name, 'err', e.message);
    }
  }));
  refreshing = false;
  refreshTray();
  broadcast({ refreshing: false });
}

function refreshTray() {
  if (!tray) return;
  const site = activeSite();
  const r = site ? results[site.id] : null;
  const balance = r && !r.error ? r.balance : null;
  const text = balance == null ? '-' : shortBalance(balance);
  const color = r && r.error ? '#94a3b8' : colorForBalance(balance);
  tray.setImage(nativeImage.createFromBuffer(renderTextIcon(text, { size: 64, color }).png));
  const label = site ? site.name : 'TokenBuddy';
  const balText = r && r.error ? '读取失败' : (balance == null ? '—' : `$${Number(balance).toFixed(2)}`);
  tray.setToolTip(`${label} · ${balText}`);
  tray.setContextMenu(buildMenu());
}

function buildMenu() {
  const items = [];
  for (const s of config.sites) {
    const r = results[s.id];
    const suffix = r ? (r.error ? '  ⚠ ' : `  $${Number(r.balance || 0).toFixed(2)}`) : '  …';
    items.push({
      label: s.name + suffix, type: 'radio',
      checked: activeSite() && activeSite().id === s.id,
      click: () => { config.activeSiteId = s.id; saveConfig(); refreshTray(); broadcast({}); },
    });
  }
  if (!items.length) items.push({ label: '未配置站点', enabled: false });
  return Menu.buildFromTemplate([
    ...items,
    { type: 'separator' },
    { label: '刷新', click: () => refreshAll() },
    { label: (config.pet && config.pet.enabled ? '隐藏桌面宠物' : '显示桌面宠物'), click: () => togglePet() },
    { label: '桌面宠物设置…', click: () => openSettings('pet') },
    { label: '设置…', click: () => openSettings() },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

/* ----------------------------- 通用快照 ----------------------------- */
function snapshot() {
  const out = {
    results: {}, refreshing, activeSiteId: config.activeSiteId,
    sites: config.sites.map((s) => ({ id: s.id, name: s.name, type: s.type, baseUrl: s.baseUrl })),
    active: null,
  };
  for (const s of config.sites) out.results[s.id] = results[s.id] || null;
  const a = activeSite();
  if (a) out.active = results[a.id] || null;
  return out;
}
function broadcast(extra) {
  const payload = { ...snapshot(), ...extra };
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('tb:update', payload);
}

/* ----------------------------- 托盘面板 ----------------------------- */
function createPopup() {
  popup = new BrowserWindow({
    width: 320, height: 340, show: false, frame: false, resizable: false,
    transparent: true, skipTaskbar: true, alwaysOnTop: true, hasShadow: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  popup.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { view: 'popup' } });
  popup.on('blur', () => { if (popup && !popup.webContents.isDevToolsOpened()) popup.hide(); });
}
function placePopupNear(anchorBounds) {
  if (!popup) return;
  const b = anchorBounds || (tray ? tray.getBounds() : null);
  if (!b) return;
  const wb = popup.getBounds();
  const disp = screen.getDisplayNearestPoint({ x: Math.round(b.x), y: Math.round(b.y) });
  const wa = disp.workArea;
  let x = Math.round(b.x + b.width / 2 - wb.width / 2);
  let y = Math.round(b.y - wb.height - 8);
  if (y < wa.y + 4) y = Math.round(b.y + b.height + 8);
  x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - wb.width - 4));
  y = Math.max(wa.y + 4, Math.min(y, wa.y + wa.height - wb.height - 4));
  popup.setPosition(x, y, false);
}
function togglePopup() {
  if (!popup) return;
  if (popup.isVisible()) { popup.hide(); return; }
  placePopupNear();
  popup.show(); popup.focus();
  popup.webContents.send('tb:update', { ...snapshot(), showSettings: false });
}
function showPopupNearPet() {
  if (!popup) return;
  if (petWin && !petWin.isDestroyed()) placePopupNear(petWin.getBounds());
  popup.show(); popup.focus();
  popup.webContents.send('tb:update', { ...snapshot(), showSettings: false });
}

/* ----------------------------- 设置窗口 ----------------------------- */
function openSettings(section) {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); if (section) settingsWin.webContents.send('tb:goto', section); return; }
  settingsWin = new BrowserWindow({
    width: 780, height: 640, minWidth: 680, minHeight: 520, title: 'TokenBuddy 设置',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { view: 'settings', section: section || '' } });
  settingsWin.on('closed', () => { settingsWin = null; });
}

/* ===================================================================== */
/*                              桌面宠物                                  */
/* ===================================================================== */
function petSize() {
  const p = config.pet || {};
  const s = Math.max(64, Math.min(600, Number(p.size) || 200));
  return { w: Math.max(s, 200), h: s + BUBBLE_H };
}
function defaultPetPos(w, h) {
  const disp = screen.getPrimaryDisplay().workArea;
  return { x: disp.x + disp.width - w - PET_MARGIN, y: disp.y + disp.height - h - PET_MARGIN };
}
function assetDataUrl() {
  const p = config.pet && config.pet.assetPath;
  if (!p || !fs.existsSync(p)) return null;
  const ext = path.extname(p).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.apng': 'image/apng', '.svg': 'image/svg+xml', '.webm': 'video/webm', '.mp4': 'video/mp4' }[ext] || 'application/octet-stream';
  try { return { url: 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64'), mediaType: (mime.startsWith('video') ? 'video' : 'image'), name: path.basename(p) }; }
  catch (e) { return null; }
}
function createPetWindow() {
  if (petWin && !petWin.isDestroyed()) return petWin;
  const { w, h } = petSize();
  const pos = config.pet.position || defaultPetPos(w, h);
  petWin = new BrowserWindow({
    width: w, height: h, x: pos.x, y: pos.y, show: false,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: !!config.pet.alwaysOnTop, focusable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  petWin.setAlwaysOnTop(!!config.pet.alwaysOnTop, 'screen-saver');
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWin.loadFile(path.join(__dirname, 'pet', 'pet.html'));
  petWin.once('ready-to-show', () => { if (config.pet.enabled) petWin.showInactive(); });
  petWin.on('moved', () => { if (petWin && !petWin.isDestroyed()) { const b = petWin.getBounds(); config.pet.position = { x: b.x, y: b.y }; saveConfig(); } });
  petWin.on('closed', () => { petWin = null; stopPetPolling(); });
  petIgnoring = true;
  petWin.setIgnoreMouseEvents(true, { forward: true });
  startPetPolling();
  if (DEBUG) console.log('[tb] pet window created', w + 'x' + h);
  return petWin;
}
function destroyPetWindow() { if (petWin && !petWin.isDestroyed()) petWin.destroy(); petWin = null; stopPetPolling(); }
function applyPetConfig() {
  if (!config.pet.enabled) { destroyPetWindow(); return; }
  if (!petWin || petWin.isDestroyed()) { createPetWindow(); return; }
  const { w, h } = petSize();
  const b = petWin.getBounds();
  petWin.setBounds({ x: b.x, y: b.y, width: w, height: h });
  petWin.setAlwaysOnTop(!!config.pet.alwaysOnTop, 'screen-saver');
  petWin.setOpacity(Number(config.pet.opacity) || 1);
  petWin.webContents.send('pet:reload', { ...config.pet, asset: assetDataUrl() });
}
function togglePet() {
  config.pet.enabled = !config.pet.enabled;
  saveConfig();
  if (config.pet.enabled) { if (petWin && !petWin.isDestroyed()) petWin.showInactive(); else createPetWindow(); }
  else destroyPetWindow();
  refreshTray();
  broadcast({});
}
function startPetPolling() {
  stopPetPolling();
  petPollTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = petWin.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    let opaque = false;
    if (inside && petAlpha && petAlpha.cols > 0) {
      const cx = Math.floor(((p.x - b.x) / b.width) * petAlpha.cols);
      const cy = Math.floor(((p.y - b.y) / b.height) * petAlpha.rows);
      if (cx >= 0 && cy >= 0 && cx < petAlpha.cols && cy < petAlpha.rows) opaque = petAlpha.data[cy * petAlpha.cols + cx] === 1;
    }
    const shouldIgnore = !opaque;
    if (shouldIgnore !== petIgnoring) {
      petIgnoring = shouldIgnore;
      try { petWin.setIgnoreMouseEvents(shouldIgnore, { forward: true }); } catch (e) {}
    }
  }, 60);
}
function stopPetPolling() { if (petPollTimer) clearInterval(petPollTimer); petPollTimer = null; }

function petMenu() {
  const p = config.pet;
  Menu.buildFromTemplate([
    { label: '更换形象…', click: () => choosePetAsset() },
    { type: 'separator' },
    { label: '显示余额气泡', type: 'checkbox', checked: !!p.showBalance, click: (i) => { p.showBalance = i.checked; saveConfig(); applyPetConfig(); } },
    { label: '始终置顶', type: 'checkbox', checked: !!p.alwaysOnTop, click: (i) => { p.alwaysOnTop = i.checked; saveConfig(); applyPetConfig(); } },
    { label: '左右翻转', type: 'checkbox', checked: !!p.flip, click: (i) => { p.flip = i.checked; saveConfig(); applyPetConfig(); } },
    { label: '开机自启', type: 'checkbox', checked: getAutostart(), click: (i) => setAutostart(i.checked) },
    { label: '大小', submenu: [100, 150, 200, 260, 320, 420].map((s) => ({ label: String(s) + ' px', type: 'radio', checked: (Number(p.size) || 200) === s, click: () => { p.size = s; saveConfig(); applyPetConfig(); } })) },
    { type: 'separator' },
    { label: '打开余额面板', click: () => showPopupNearPet() },
    { label: '桌面宠物设置…', click: () => openSettings('pet') },
    { type: 'separator' },
    { label: '隐藏宠物', click: () => togglePet() },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]).popup({ window: petWin });
}
async function choosePetAsset() {
  const res = await dialog.showOpenDialog(petWin || settingsWin || undefined, {
    title: '选择宠物形象(图片或动图/视频)',
    properties: ['openFile'],
    filters: [
      { name: '图片 / 动图 / 视频', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'apng', 'svg', 'webm', 'mp4'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const src = res.filePaths[0];
  const dir = path.join(app.getPath('userData'), 'pets');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, Date.now() + '-' + path.basename(src));
  fs.copyFileSync(src, dest);
  config.pet.assetPath = dest;
  config.pet.enabled = true;
  saveConfig();
  if (!petWin || petWin.isDestroyed()) createPetWindow(); else applyPetConfig();
  refreshTray();
  broadcast({});
  return { ...config.pet, asset: assetDataUrl() };
}

/* ----------------------------- 开机自启 ----------------------------- */
function autostartFile() { return path.join(app.getPath('home'), '.config', 'autostart', 'tokenbuddy-tray.desktop'); }
function getAutostart() {
  if (process.platform === 'linux') return fs.existsSync(autostartFile());
  try { return app.getLoginItemSettings().openAtLogin; } catch (e) { return false; }
}
function setAutostart(enabled) {
  if (process.platform === 'linux') {
    const f = autostartFile();
    if (enabled) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const exec = process.env.APPIMAGE || process.execPath;
      fs.writeFileSync(f, '[Desktop Entry]\nType=Application\nName=TokenBuddy\nComment=TokenBuddy 余额托盘与桌面宠物\nExec=' + exec + '\nX-GNOME-Autostart-enabled=true\n');
    } else { try { fs.unlinkSync(f); } catch (e) {} }
  } else {
    try { app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true }); } catch (e) {}
  }
  return enabled;
}

/* ----------------------------- IPC ----------------------------- */
ipcMain.handle('tb:getConfig', () => rendererConfig());
ipcMain.handle('tb:getSnapshot', () => snapshot());
ipcMain.handle('tb:saveConfig', (_e, cfg) => {
  const sites = (cfg.sites || []).map((s) => ({
    id: s.id || crypto.randomUUID(), name: s.name || '站点', type: s.type || 'sub2api', baseUrl: s.baseUrl || '',
    email: s.email || '', username: s.username || '', userId: s.userId || '', quotaPerUnit: s.quotaPerUnit || undefined,
    password: encSecret(s.password), accessToken: encSecret(s.accessToken), apiKey: encSecret(s.apiKey),
  }));
  config.refreshSeconds = Math.max(15, Number(cfg.refreshSeconds) || 120);
  config.activeSiteId = cfg.activeSiteId || (sites[0] && sites[0].id) || null;
  config.sites = sites;
  saveConfig(); refreshTray(); startPolling(); refreshAll();
  return rendererConfig();
});
ipcMain.handle('tb:refresh', () => { refreshAll(); return true; });
ipcMain.handle('tb:setActive', (_e, id) => { config.activeSiteId = id; saveConfig(); refreshTray(); broadcast({}); return true; });
ipcMain.on('tb:openSettings', () => openSettings());
ipcMain.on('tb:hidePopup', () => { if (popup) popup.hide(); });
ipcMain.on('tb:quit', () => { app.isQuitting = true; app.quit(); });
ipcMain.on('tb:openExternal', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

/* 宠物 IPC */
ipcMain.handle('pet:get', () => ({ ...config.pet, asset: assetDataUrl(), autostart: getAutostart(), snapshot: snapshot() }));
ipcMain.handle('pet:choose', () => choosePetAsset());
ipcMain.handle('pet:set', (_e, patch) => {
  config.pet = Object.assign({}, config.pet, patch || {});
  saveConfig(); refreshTray(); applyPetConfig();
  return { ...config.pet, asset: assetDataUrl(), autostart: getAutostart() };
});
ipcMain.handle('pet:toggle', () => { togglePet(); return config.pet.enabled; });
ipcMain.handle('pet:autostart', (_e, v) => setAutostart(!!v));
ipcMain.on('pet:alpha', (_e, grid) => {
  if (grid && grid.data && grid.cols > 0) {
    petAlpha = grid;
    if (DEBUG) { let n = 0; for (const v of grid.data) if (v) n++; console.log('[tb] pet alpha', grid.cols + 'x' + grid.rows, 'opaque=', n); }
  }
});
ipcMain.on('pet:dragstart', (_e, cursor) => { if (petWin && !petWin.isDestroyed() && cursor) petDrag = { cursor, bounds: petWin.getBounds() }; });
ipcMain.on('pet:drag', (_e, cursor) => {
  if (petWin && !petWin.isDestroyed() && petDrag && cursor) {
    petWin.setPosition(Math.round(petDrag.bounds.x + (cursor.x - petDrag.cursor.x)), Math.round(petDrag.bounds.y + (cursor.y - petDrag.cursor.y)), false);
  }
});
ipcMain.on('pet:dragend', () => { petDrag = null; });
ipcMain.on('pet:menu', () => petMenu());
ipcMain.on('pet:panel', () => showPopupNearPet());

/* ----------------------------- 轮询 ----------------------------- */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshAll, Math.max(15, config.refreshSeconds || 120) * 1000);
}

/* ----------------------------- 启动 ----------------------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (popup) togglePopup(); });
  app.whenReady().then(() => {
    loadConfig();
    tray = new Tray(nativeImage.createFromBuffer(renderTextIcon('…', { size: 64 }).png));
    tray.on('click', togglePopup);
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
    createPopup();
    if (config.pet.enabled) createPetWindow();
    refreshTray();
    startPolling();
    refreshAll();
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
  });
  app.on('window-all-closed', () => {});
}
