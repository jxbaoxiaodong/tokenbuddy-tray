'use strict';

const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, screen, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { fetchBalance } = require('./lib/adapters');
const { renderTextIcon, shortBalance, colorForBalance } = require('./lib/icon');

const DEFAULT_CONFIG = { refreshSeconds: 120, activeSiteId: null, sites: [] };
const SECRET_FIELDS = ['password', 'accessToken'];
const DEBUG = process.argv.includes('--dev') || !!process.env.TB_DEBUG;

let tray = null;
let popup = null;
let settingsWin = null;
let config = null;
let results = {};        // siteId -> { balance, todayCost, totalCost, name, error, at }
let refreshing = false;
let pollTimer = null;

/* ----------------------------- 配置存储 ----------------------------- */
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }

function encSecret(v) {
  if (!v) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(String(v)).toString('base64');
    }
  } catch (e) {}
  return String(v);
}
function decSecret(v) {
  if (!v) return '';
  if (String(v).startsWith('enc:')) {
    try { return safeStorage.decryptString(Buffer.from(String(v).slice(4), 'base64')); } catch (e) { return ''; }
  }
  return String(v);
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    config = Object.assign({}, DEFAULT_CONFIG, raw);
    config.sites = (config.sites || []).map((s) => ({ ...s }));
  } catch (e) {
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

/* 给适配器用的"明文站点" */
function plainSite(site) {
  const s = { ...site };
  for (const f of SECRET_FIELDS) s[f] = decSecret(site[f]);
  return s;
}
/* 给渲染进程用的配置(密钥回填明文,便于编辑;仅本机) */
function rendererConfig() {
  return {
    refreshSeconds: config.refreshSeconds,
    activeSiteId: config.activeSiteId,
    sites: config.sites.map((s) => {
      const o = { ...s };
      for (const f of SECRET_FIELDS) o[f] = decSecret(s[f]);
      return o;
    }),
  };
}

/* ----------------------------- 余额刷新 ----------------------------- */
function activeSite() {
  if (!config.sites.length) return null;
  return config.sites.find((s) => s.id === config.activeSiteId) || config.sites[0];
}

async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  broadcast({ refreshing: true });
  const sites = config.sites.slice();
  await Promise.all(sites.map(async (s) => {
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
  const { png } = renderTextIcon(text, { size: 64, color });
  tray.setImage(nativeImage.createFromBuffer(png));
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
      label: s.name + suffix,
      type: 'radio',
      checked: activeSite() && activeSite().id === s.id,
      click: () => { config.activeSiteId = s.id; saveConfig(); refreshTray(); broadcast({}); },
    });
  }
  if (!items.length) items.push({ label: '未配置站点', enabled: false });
  return Menu.buildFromTemplate([
    ...items,
    { type: 'separator' },
    { label: '刷新', click: () => refreshAll() },
    { label: '设置…', click: () => openSettings() },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

/* ----------------------------- 窗口 ----------------------------- */
function snapshot() {
  const out = { results: {}, refreshing, activeSiteId: config.activeSiteId, sites: config.sites.map((s) => ({ id: s.id, name: s.name, type: s.type, baseUrl: s.baseUrl })) };
  for (const s of config.sites) out.results[s.id] = results[s.id] || null;
  return out;
}
function broadcast(extra) {
  const payload = { ...snapshot(), ...extra };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('tb:update', payload);
  }
}

function createPopup() {
  popup = new BrowserWindow({
    width: 320, height: 340, show: false, frame: false, resizable: false,
    transparent: true, skipTaskbar: true, alwaysOnTop: true, hasShadow: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  popup.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { view: 'popup' } });
  popup.on('blur', () => { if (popup && !popup.webContents.isDevToolsOpened()) popup.hide(); });
}

function placePopup() {
  if (!popup || !tray) return;
  const b = tray.getBounds();
  const wb = popup.getBounds();
  const disp = screen.getDisplayNearestPoint({ x: Math.round(b.x), y: Math.round(b.y) });
  const wa = disp.workArea;
  let x = Math.round(b.x + b.width / 2 - wb.width / 2);
  let y = Math.round(b.y - wb.height - 8);
  if (y < wa.y + 4) y = Math.round(b.y + b.height + 8); // 托盘在顶部时放到下方
  x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - wb.width - 4));
  y = Math.max(wa.y + 4, Math.min(y, wa.y + wa.height - wb.height - 4));
  popup.setPosition(x, y, false);
}

function togglePopup() {
  if (!popup) return;
  if (popup.isVisible()) { popup.hide(); return; }
  placePopup();
  popup.show();
  popup.focus();
  popup.webContents.send('tb:update', { ...snapshot(), showSettings: false });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 760, height: 600, minWidth: 640, minHeight: 480, title: 'TokenBuddy 设置',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { view: 'settings' } });
  settingsWin.on('closed', () => { settingsWin = null; });
}

/* ----------------------------- IPC ----------------------------- */
ipcMain.handle('tb:getConfig', () => rendererConfig());
ipcMain.handle('tb:getSnapshot', () => snapshot());
ipcMain.handle('tb:saveConfig', (_e, cfg) => {
  const sites = (cfg.sites || []).map((s) => {
    const id = s.id || crypto.randomUUID();
    const out = {
      id, name: s.name || '站点', type: s.type || 'sub2api', baseUrl: s.baseUrl || '',
      email: s.email || '', username: s.username || '', userId: s.userId || '', quotaPerUnit: s.quotaPerUnit || undefined,
      password: encSecret(s.password), accessToken: encSecret(s.accessToken),
    };
    return out;
  });
  config = { refreshSeconds: Math.max(15, Number(cfg.refreshSeconds) || 120), activeSiteId: cfg.activeSiteId || (sites[0] && sites[0].id) || null, sites };
  saveConfig();
  refreshTray();
  startPolling();
  refreshAll();
  return rendererConfig();
});
ipcMain.handle('tb:refresh', () => { refreshAll(); return true; });
ipcMain.handle('tb:setActive', (_e, id) => { config.activeSiteId = id; saveConfig(); refreshTray(); return true; });
ipcMain.on('tb:openSettings', () => openSettings());
ipcMain.on('tb:hidePopup', () => { if (popup) popup.hide(); });
ipcMain.on('tb:quit', () => { app.isQuitting = true; app.quit(); });
ipcMain.on('tb:openExternal', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

/* ----------------------------- 轮询 ----------------------------- */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const ms = Math.max(15, config.refreshSeconds || 120) * 1000;
  pollTimer = setInterval(refreshAll, ms);
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
    refreshTray();
    startPolling();
    refreshAll();
    if (process.platform === 'darwin') app.dock && app.dock.hide();
  });
  // 全部窗口关闭不退出:常驻托盘;只有显式"退出"才结束(app.quit())
  app.on('window-all-closed', () => {});
}
