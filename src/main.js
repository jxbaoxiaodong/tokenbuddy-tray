'use strict';

const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, screen, safeStorage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { fetchBalance, detectFramework, customBalanceQuery } = require('./lib/adapters');
const { money } = require('./lib/icon');

// 配置凭据使用 Electron safeStorage;固定应用名,保证开发版/打包版解密上下文一致。
app.setName('TokenBuddy');
// 透明窗口(余额条/宠物/托盘弹窗)在部分 Windows 显卡/远程桌面下会白底,
// 统一禁硬件加速:托盘小图标和这几块 UI 用不上 GPU。
if (process.platform !== 'darwin') app.disableHardwareAcceleration();

// 默认站点只提供一个示例入口,用户需要替换为自己的 API Base URL 和凭据。
// 只保留名字/地址/类型,不带任何凭据。
const DEFAULT_SITE = {
  name: '示例站点',
  type: '',
  baseUrl: 'https://example.com',
};

const DEFAULT_CONFIG = {
  refreshSeconds: 120,
  activeSiteId: null,
  sites: [],
  balanceBar: {
    enabled: true,
    scale: 1,        // 整体缩放,0.6~2.5
    bgColor: '',     // 牌子背景色,留空=默认深色
    fgColor: '',     // 数字颜色,留空=随余额状态变色
    abbrev: '',      // 自定义站名缩写,留空=自动缩写
    radius: 22,      // 圆角半径,0=直角
  },
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
const SECRET_FIELDS = ['password', 'accessToken', 'refreshCookie', 'apiKey'];
const SESSION_FIELDS = ['accessToken', 'refreshCookie', 'authSessionId', 'accessExpiresAt'];
const DEBUG = process.argv.includes('--dev') || !!process.env.TB_DEBUG;
const PET_MARGIN = 16;
// 单行金额牌与小箭头所需的逻辑像素高度,避免窗口为两行气泡预留过多透明区域。
const BUBBLE_H = 38;

let tray = null;
let barWin = null;       // 顶栏余额条窗口
let barSize = { w: 180, h: 44 };
let popup = null;
let settingsWin = null;
let petWin = null;
let config = null;
let configRevision = 0;
let results = {};
let refreshing = false;
let refreshPromise = null;
let queuedManualRefresh = null;
let pollTimer = null;
let petAlpha = null;   // { cols, rows, data:Uint8Array }
let petIgnoring = null;
let petPollTimer = null;
let petDrag = null;
let petPress = false;

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
    config.balanceBar = Object.assign({}, DEFAULT_CONFIG.balanceBar, raw.balanceBar || {});
    config.sites = (config.sites || []).map((s) => ({ ...s }));
  } catch (e) { config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
  // 首次使用(或站点列表为空)时预置示例站点,凭据留给用户自己填
  if (!config.sites.length) {
    const site = { id: crypto.randomUUID(), ...DEFAULT_SITE };
    config.sites = [site];
    config.activeSiteId = site.id;
  }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}
function plainSite(site) { const s = { ...site }; for (const f of SECRET_FIELDS) s[f] = decSecret(site[f]); return s; }
function rendererConfig() {
  return {
    refreshSeconds: config.refreshSeconds, activeSiteId: config.activeSiteId,
    // 登录会话只留在主进程，不交给渲染层，避免设置窗口暴露或覆盖。
    sites: config.sites.map((s) => {
      const o = { ...s };
      o.password = decSecret(s.password);
      o.apiKey = decSecret(s.apiKey);
      for (const f of SESSION_FIELDS) delete o[f];
      return o;
    }),
    pet: { ...config.pet },
    balanceBar: { ...config.balanceBar },
  };
}

/* ----------------------------- 余额刷新 ----------------------------- */
function activeSite() { if (!config.sites.length) return null; return config.sites.find((s) => s.id === config.activeSiteId) || config.sites[0]; }
function persistSession(current, requestSite, session) {
  if (!current || !session) return false;
  let changed = false;
  const next = {
    accessToken: session.token || '',
    refreshCookie: session.cookie || '',
    authSessionId: session.sessionId || '',
    accessExpiresAt: Number(session.expiresAt) || 0,
  };
  for (const field of SESSION_FIELDS) {
    const oldValue = field === 'accessToken' || field === 'refreshCookie'
      ? (requestSite[field] || '') : (current[field] || '');
    const newValue = next[field];
    if (String(oldValue) === String(newValue)) continue;
    current[field] = field === 'accessToken' || field === 'refreshCookie'
      ? encSecret(newValue) : newValue;
    changed = true;
  }
  if (session.userId && String(current.userId || '') !== String(session.userId)) {
    current.userId = String(session.userId);
    changed = true;
  }
  return changed;
}
function clearSession(current) {
  if (!current) return false;
  let changed = false;
  for (const field of SESSION_FIELDS) {
    if (current[field]) changed = true;
    current[field] = field === 'accessExpiresAt' ? 0 : '';
  }
  return changed;
}
async function runRefresh(manual) {
  const revision = configRevision;
  refreshing = true;
  broadcast({ refreshing: true });
  let configChanged = false;
  try {
    await Promise.all(config.sites.slice().map(async (s) => {
      const requestSite = plainSite(s);
      try {
        const r = await fetchBalance(requestSite, { allowLogin: manual });
        if (revision !== configRevision) return;
        const current = config.sites.find((item) => item.id === s.id);
        if (r._session && persistSession(current, requestSite, r._session)) configChanged = true;
        if (current && r.framework && current.type !== r.framework) {
          current.type = r.framework;
          configChanged = true;
        }
        // 能力探测命中的协议写回站点配置,后续刷新直接走它,不重复试探
        if (current && r.probeProtocol && current.probeProtocol !== r.probeProtocol) {
          current.probeProtocol = r.probeProtocol;
          configChanged = true;
        }
        results[s.id] = { ...r, error: null, at: Date.now() };
        if (DEBUG) console.log('[tb]', s.name, 'ok', JSON.stringify(results[s.id]));
      } catch (e) {
        if (revision !== configRevision) return;
        const current = config.sites.find((item) => item.id === s.id);
        if (requestSite._clearSession && clearSession(current)) configChanged = true;
        results[s.id] = { error: e.message || String(e), at: Date.now() };
        if (DEBUG) console.log('[tb]', s.name, 'err', e.message);
      }
    }));
    if (configChanged && revision === configRevision) saveConfig();
  } finally {
    refreshing = false;
    refreshTray();
    broadcast({ refreshing: false });
  }
  return snapshot();
}
function refreshAll(manual = false) {
  if (!refreshPromise) {
    refreshPromise = runRefresh(manual).finally(() => {
      refreshPromise = null;
      if (queuedManualRefresh) {
        const queued = queuedManualRefresh;
        queuedManualRefresh = null;
        refreshAll(true).then(queued.resolve, queued.reject);
      }
    });
    return refreshPromise;
  }
  if (!manual) return refreshPromise;
  // 启动刷新进行中时，设置保存/手动刷新只排队一次，且调用方会等待它完成。
  if (!queuedManualRefresh) {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    queuedManualRefresh = { promise, resolve, reject };
  }
  return queuedManualRefresh.promise;
}

function refreshTray() {
  if (!tray) return;
  const site = activeSite();
  const r = site ? results[site.id] : null;
  const failed = !!(r && r.error);
  const balance = r && !failed ? r.balance : null;
  const unit = r ? r.unit : null; // 站点没声明币种时为 null,显示层印裸数字
  // 托盘只保留普通应用图标:面板会把宽图标压小字高,大号余额改由顶栏余额条窗口显示
  tray.setImage(nativeImage.createFromPath(path.join(__dirname, '..', 'assets',
    process.platform === 'linux' ? 'icon.png' : 'icon-256.png')));
  const balText = failed ? '读取失败' : (r && r.unlimited ? '无限额度' : (balance == null ? '—' : money(balance, unit)));
  const hint = r && r.unlimitedHint ? '\n' + r.unlimitedHint : '';
  tray.setToolTip(`${site ? site.name : 'TokenBuddy'} · ${balText}${hint}`);
  tray.setContextMenu(buildMenu());
}

function wireTray(t) {
  t.on('click', togglePopup);
  t.on('right-click', () => t.popUpContextMenu(buildMenu()));
}

/* ===================================================================== */
/*                            顶栏余额条窗口                              */
/* ===================================================================== */
/* GNOME 面板把托盘图标强制 contain 进正方形,托盘里永远无法同时满足
 * "字高顶满 + 不横向压缩"。托盘只保留普通图标;大号余额用无边框窗口
 * 贴在顶栏下方显示,数字任意大且完全不变形。 */
function createBalanceBar() {
  if (barWin && !barWin.isDestroyed()) return barWin;
  // 多屏时默认贴光标所在屏的顶栏右侧,而不是固定主屏
  const disp = (config.balanceBar && config.balanceBar.position) ? null
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const primary = disp || screen.getPrimaryDisplay();
  const pos = (config.balanceBar && config.balanceBar.position) || {
    x: primary.workArea.x + primary.workArea.width - barSize.w - 12,
    y: primary.workArea.y + 8,
  };
  barWin = new BrowserWindow({
    width: barSize.w, height: barSize.h, show: false,
    x: pos.x, y: pos.y,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    skipTaskbar: true,
    // Windows 面板不会把无边框窗口当干扰项,允许聚焦以便点击;macOS
    // 非激活面板同样可以点击。Linux GNOME 下 focusable:false 避免抢焦点。
    focusable: process.platform !== 'linux',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  barWin.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    // macOS 的 visibleOnFullScreen 在某些全屏空间会把窗口吞掉,只 pin 工作区
    barWin.setVisibleOnAllWorkspaces(true);
    barWin.setWindowButtonVisibility(false);
  } else {
    barWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  barWin.loadFile(path.join(__dirname, 'balancebar', 'balancebar.html'));
  barWin.once('ready-to-show', () => { if (config.balanceBar && config.balanceBar.enabled) barWin.showInactive(); });
  barWin.on('closed', () => { barWin = null; stopBarPolling(); });
  return barWin;
}
function destroyBalanceBar() { if (barWin && !barWin.isDestroyed()) barWin.destroy(); barWin = null; stopBarPolling(); }
/* 余额条牌子本身就是要交互的东西,不默认穿透;只有牌子四周的透明
 * 余量会挡住下面的东西。轮询把窗口矩形收窄到牌子实际占用的区域。 */
let barPollTimer = null;
function startBarPolling() {
  stopBarPolling();
  barPollTimer = setInterval(() => {
    if (!barWin || barWin.isDestroyed() || !barWin.isVisible()) return;
    barWin.webContents.executeJavaScript('window.__barHit && window.__barHit() || null', false)
      .then((rect) => {
        if (!barWin || barWin.isDestroyed() || !barWin.isVisible()) return;
        if (!rect) { try { barWin.setIgnoreMouseEvents(false); } catch (e) {} return; }
        const b = barWin.getBounds();
        // 渲染层返回 CSS 像素矩形;把屏幕光标换算到窗口内判定
        const p = screen.getCursorScreenPoint();
        const inside = p.x >= b.x + rect.x && p.x < b.x + rect.x + rect.w
          && p.y >= b.y + rect.y && p.y < b.y + rect.y + rect.h;
        try { barWin.setIgnoreMouseEvents(!inside); } catch (e) {}
      })
      .catch(() => {});
  }, 80);
}
function stopBarPolling() { if (barPollTimer) clearInterval(barPollTimer); barPollTimer = null; }
/* 重新按屏幕工作区右对齐贴顶栏;窗口宽度变化时由渲染层上报后调用。
 * 用户拖动过的位置(balanceBar.position)优先,不强制贴顶。 */
function placeBalanceBar() {
  if (!barWin || barWin.isDestroyed()) return;
  if (config.balanceBar && config.balanceBar.position) return;
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = disp.workArea;
  const b = barWin.getBounds();
  // 光标所在屏可能不是当前窗口所在屏,先夹紧到该屏工作区
  const x = Math.max(wa.x + 4, Math.min(wa.x + wa.width - b.width - 12, wa.x + wa.width - b.width - 12));
  const y = wa.y + 8;
  if (b.x !== x || b.y !== y) barWin.setBounds({ x, y, width: b.width, height: b.height });
}
function applyBalanceBarConfig() {
  const enabled = !!(config.balanceBar && config.balanceBar.enabled);
  if (enabled) {
    if (!barWin || barWin.isDestroyed()) createBalanceBar();
    else if (!barWin.isVisible()) barWin.showInactive();
    placeBalanceBar();
  } else destroyBalanceBar();
}
function toggleBalanceBar() {
  config.balanceBar = Object.assign({ enabled: true }, config.balanceBar, { enabled: !(config.balanceBar && config.balanceBar.enabled) });
  saveConfig();
  applyBalanceBarConfig();
  broadcast({});
}
function showPopupNearBar() {
  if (!popup) return;
  if (barWin && !barWin.isDestroyed()) placePopupNear(barWin.getBounds());
  popup.show(); popup.focus();
  popup.webContents.send('tb:update', { ...snapshot(), showSettings: false });
}

function buildMenu() {
  const items = [];
  for (const s of config.sites) {
    const r = results[s.id];
    // 余额读不到时别印 $0,那和"真的是 0"看起来没区别
    const suffix = !r ? '  …' : r.error ? '  ⚠ '
      : r.unlimited ? '  ∞ 无限'
        : r.balance == null ? '  —'
        : '  ' + money(r.balance, r.unit);
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
    { label: '刷新', click: () => refreshAll(true) },
    { label: (config.balanceBar && config.balanceBar.enabled ? '隐藏顶栏余额条' : '显示顶栏余额条'), click: () => toggleBalanceBar() },
    { label: (config.pet && config.pet.enabled ? '隐藏桌面宠物' : '显示桌面宠物'), click: () => togglePet() },
    { label: '开机启动', type: 'checkbox', checked: getAutostart(), click: (i) => { setAutostart(i.checked); refreshTray(); } },
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
  showPopup();
}
function showPopup() {
  if (!popup) return;
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
    // 有 alpha 网格按像素判定;没有(内置 SVG 等矢量形象)时退回吉祥物
    // 矩形(气泡以下的整块)。Linux 无事件转发,判定只能放主进程。
    // 迟滞:透明窗口里的形象是自主动画,同一格会随动画在实心/透明间
    // 跳变,交互中(未激活)只按 alpha 命中进入;一旦激活就保持整个
    // 窗口矩形可交互,直到光标彻底离开窗口,避免动画把拖动打断。
    const inWindow = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    let inside;
    if (petPress || petDrag) inside = inWindow;
    else if (!inWindow) inside = false;
    else if (petAlpha && petAlpha.cols > 0) {
      const cy = Math.floor(((p.y - b.y) / b.height) * petAlpha.rows);
      const cx = Math.floor(((p.x - b.x) / b.width) * petAlpha.cols);
      inside = cy >= 0 && cy < petAlpha.rows && cx >= 0 && cx < petAlpha.cols
        && petAlpha.data[cy * petAlpha.cols + cx] === 1;
    } else {
      inside = p.y >= b.y + BUBBLE_H && p.y < b.y + b.height;
    }
    const shouldIgnore = !inside;
    if (DEBUG) {
      const now = Date.now();
      if (!startPetPolling._hb || now - startPetPolling._hb > 5000) {
        startPetPolling._hb = now;
        console.log('[tb] pet poll hb cursor', p.x + ',' + p.y, 'bounds', Math.round(b.x) + ',' + Math.round(b.y) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height), 'inside', inside, 'ignoring', petIgnoring, 'alpha', petAlpha ? petAlpha.cols + 'x' + petAlpha.rows : 'null');
      }
    }
    if (shouldIgnore !== petIgnoring) {
      petIgnoring = shouldIgnore;
      if (DEBUG) console.log('[tb] pet ignore→', shouldIgnore, 'cursor', p.x + ',' + p.y, 'bounds', Math.round(b.x) + ',' + Math.round(b.y) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height), 'alpha', petAlpha ? petAlpha.cols + 'x' + petAlpha.rows : 'null');
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
      const quotedExec = '"' + String(exec).replace(/([\\"`$])/g, '\\$1') + '"';
      // AppImage 在部分 Linux 安装环境中无法设置 Chromium sandbox helper 的
      // setuid 权限; 保证从系统启动项启动时与手动启动行为一致。
      const sandboxArgs = process.env.TB_ENABLE_SANDBOX === '1' ? '' : ' --no-sandbox';
      fs.writeFileSync(f, '[Desktop Entry]\nType=Application\nName=TokenBuddy\nComment=TokenBuddy 余额托盘与桌面宠物\nExec=' + quotedExec + sandboxArgs + '\nX-GNOME-Autostart-enabled=true\n');
    } else { try { fs.unlinkSync(f); } catch (e) {} }
  } else {
    try { app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true }); } catch (e) {}
  }
  return enabled;
}

/* ----------------------------- IPC ----------------------------- */
ipcMain.handle('tb:getConfig', () => rendererConfig());
ipcMain.handle('tb:getSnapshot', () => snapshot());
ipcMain.handle('tb:saveConfig', async (_e, cfg) => {
  const sites = (cfg.sites || []).map((s) => {
    const id = s.id || crypto.randomUUID();
    const previous = config.sites.find((item) => item.id === id);
    const sameLogin = previous
      && previous.baseUrl === (s.baseUrl || '')
      && previous.username === (s.username || '')
      && decSecret(previous.password) === (s.password || '');
    return {
      id, name: s.name || '站点', type: s.type || '', baseUrl: s.baseUrl || '',
      email: s.email || '', username: s.username || '', userId: s.userId || '', quotaPerUnit: s.quotaPerUnit || undefined,
      // 自定义余额接口和能力探测状态属于站点路由配置,必须和凭据一起持久化。
      balancePath: s.balancePath || '', balanceField: s.balanceField || '',
      balanceAuth: s.balanceAuth || '', balanceUnit: s.balanceUnit || '',
      probeProtocol: s.probeProtocol || '',
      password: encSecret(s.password),
      // 登录身份未变化时保留完整后台会话；改地址/账号/密码则全部失效。
      accessToken: sameLogin ? previous.accessToken : '',
      refreshCookie: sameLogin ? previous.refreshCookie : '',
      authSessionId: sameLogin ? previous.authSessionId : '',
      accessExpiresAt: sameLogin ? previous.accessExpiresAt : 0,
      apiKey: encSecret(s.apiKey),
    };
  });
  config.refreshSeconds = Math.max(15, Number(cfg.refreshSeconds) || 120);
  config.activeSiteId = cfg.activeSiteId || (sites[0] && sites[0].id) || null;
  config.sites = sites;
  if (cfg.balanceBar) {
    config.balanceBar = Object.assign({}, config.balanceBar, cfg.balanceBar);
    applyBalanceBarConfig();
    if (barWin && !barWin.isDestroyed()) barWin.webContents.send('bar:reload', { ...config.balanceBar });
  }
  configRevision++;
  saveConfig(); refreshTray(); startPolling();
  await refreshAll(true);
  return rendererConfig();
});
ipcMain.handle('tb:refresh', () => refreshAll(true));
// 协议识别:只凭 API Base URL 做未鉴权探测,供界面决定"要不要显示账号密码"
ipcMain.handle('tb:detect', async (_e, baseUrl) => {
  const u = String(baseUrl || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(u)) return null;
  try {
    const d = await detectFramework(u);
    return { framework: d.framework, quotaPerUnit: d.quotaPerUnit, displayType: d.displayType, tried: d.tried };
  } catch (e) { return null; }
});
// 手填余额接口即时试查:设置界面的「测试自定义接口」按钮用,不做识别、不做探测
ipcMain.handle('tb:testEndpoint', async (_e, site) => {
  const s = { ...(site || {}) };
  s.baseUrl = String(s.baseUrl || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(s.baseUrl)) throw new Error('API Key 的 BASE URL 格式不对,需要以 http(s):// 开头');
  if (!String(s.balancePath || '').trim()) throw new Error('还没填余额接口路径');
  const r = await customBalanceQuery(s);
  const sym = r.unit === 'CNY' ? '¥' : (r.unit === 'TOKENS' ? '' : (r.unit ? r.unit + ' ' : ''));
  return {
    framework: r.framework, customField: r.customField, unit: r.unit || null,
    balance: r.balance,
    summary: '余额 ' + sym + r.balance + '(取自字段 ' + r.customField + ')' + (r.unit ? ',币种 ' + r.unit : ',站点未给币种'),
  };
});
ipcMain.handle('tb:setActive', (_e, id) => { config.activeSiteId = id; saveConfig(); refreshTray(); broadcast({}); return true; });
ipcMain.on('tb:openSettings', () => openSettings());
ipcMain.on('tb:hidePopup', () => { if (popup) popup.hide(); });
ipcMain.on('tb:quit', () => { app.isQuitting = true; app.quit(); });
ipcMain.on('tb:openExternal', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

/* 余额条 IPC:渲染层量好内容尺寸后上报;点击打开主面板 */
ipcMain.handle('bar:get', () => ({ ...config.balanceBar }));
ipcMain.on('bar:resize', (_e, size) => {
  const w = Math.max(80, Math.min(600, Math.round(Number(size && size.w) || barSize.w)));
  const h = Math.max(28, Math.min(120, Math.round(Number(size && size.h) || barSize.h)));
  if (w === barSize.w && h === barSize.h) return;
  barSize = { w, h };
  if (barWin && !barWin.isDestroyed()) barWin.setBounds({ width: w, height: h });
  placeBalanceBar();
});
ipcMain.on('bar:panel', () => showPopupNearBar());

/* 余额条拖动:与宠物窗口相同的按住拖移方式 */
let barDrag = null;
ipcMain.on('bar:drag', (_e, cursor) => {
  if (!barWin || barWin.isDestroyed() || !cursor) return;
  // 渲染层移动超过阈值才发首条 drag;此时才记下拖动起点
  if (!barDrag) barDrag = { cursor, bounds: barWin.getBounds() };
  barWin.setPosition(Math.round(barDrag.bounds.x + (cursor.x - barDrag.cursor.x)), Math.round(barDrag.bounds.y + (cursor.y - barDrag.cursor.y)), false);
});
ipcMain.on('bar:dragstart', (_e, cursor) => {
  if (barWin && !barWin.isDestroyed() && cursor) barDrag = { cursor, bounds: barWin.getBounds() };
});
ipcMain.on('bar:dragend', () => {
  barDrag = null;
  if (barWin && !barWin.isDestroyed()) {
    const b = barWin.getBounds();
    config.balanceBar = Object.assign({ enabled: true }, config.balanceBar, { position: { x: b.x, y: b.y } });
    saveConfig();
  }
});

/* 宠物 IPC */
ipcMain.handle('pet:get', () => ({ ...config.pet, asset: assetDataUrl(), snapshot: snapshot() }));
ipcMain.handle('pet:choose', () => choosePetAsset());
ipcMain.handle('pet:set', (_e, patch) => {
  config.pet = Object.assign({}, config.pet, patch || {});
  saveConfig(); refreshTray(); applyPetConfig();
  return { ...config.pet, asset: assetDataUrl() };
});
ipcMain.handle('pet:toggle', () => { togglePet(); return config.pet.enabled; });
ipcMain.on('pet:alpha', (_e, grid) => {
  if (grid && grid.data && grid.cols > 0) {
    petAlpha = grid;
    if (DEBUG) { let n = 0; for (const v of grid.data) if (v) n++; console.log('[tb] pet alpha', grid.cols + 'x' + grid.rows, 'opaque=', n); }
  }
});
ipcMain.on('pet:press', () => { petPress = true; });
ipcMain.on('pet:release', () => { petPress = false; });
ipcMain.on('pet:dragstart', (_e, cursor) => {
  if (DEBUG) console.log('[tb] pet dragstart', cursor && (cursor.x + ',' + cursor.y));
  if (petWin && !petWin.isDestroyed() && cursor) petDrag = { cursor, bounds: petWin.getBounds() };
});
ipcMain.on('pet:drag', (_e, cursor) => {
  if (DEBUG) console.log('[tb] pet drag', cursor && (cursor.x + ',' + cursor.y));
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
  app.on('second-instance', () => { if (popup) showPopup(); });
  app.whenReady().then(() => {
    loadConfig();
    // Windows 托盘 16px、macOS 菜单栏 22px;512 大图交给系统缩放会糊,
    // 256 中图在两边都只缩一档,保持清晰。
    const trayIconFile = process.platform === 'linux' ? 'icon.png' : 'icon-256.png';
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', trayIconFile)));
    wireTray(tray);
    refreshTray();
    createPopup();
    applyBalanceBarConfig();
    if (config.pet.enabled) createPetWindow();
    startPolling();
    if (config.sites.length) {
      refreshAll(false);
      // 预置的本站还没填 Key 时,自动弹一次设置引导用户填写
      const preset = config.sites[0];
      if (preset && preset.baseUrl === DEFAULT_SITE.baseUrl && !preset.apiKey && !preset.password) openSettings();
    } else openSettings();
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
  });
  app.on('window-all-closed', () => {});
}
