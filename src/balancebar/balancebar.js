'use strict';

const siteEl = document.getElementById('site');
const amountEl = document.getElementById('amount');
const barEl = document.getElementById('bar');

const WARN = 5, DANGER = 1;
let style = {};      // balanceBar 配置:scale/bgColor/fgColor/abbrev/radius
let lastBalance = null;
let lastFailed = false;

function colorClass(v) {
  if (typeof v !== 'number' || !isFinite(v)) return 'fail';
  if (v <= DANGER) return 'danger';
  if (v <= WARN) return 'warn';
  return '';
}

function trimZero(s) { return s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, ''); }
function shortBalance(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '-';
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1e9) return s + trimZero((a / 1e9).toFixed(1)) + 'B';
  if (a >= 1e6) return s + trimZero((a / 1e6).toFixed(1)) + 'M';
  if (a >= 1e3) {
    const k = a / 1e3;
    if (k < 10) return s + trimZero(k.toFixed(1)) + 'K';
    const kr = Math.round(k);
    if (kr < 1000) return s + kr + 'K';
    return s + trimZero((a / 1e6).toFixed(1)) + 'M';
  }
  if (a >= 100) return s + String(Math.round(a));
  return s + trimZero(a.toFixed(2));
}

function currencySymbol(unit) {
  // 站点没声明币种时印裸数字,不编造 "$"
  if (unit == null || unit === '') return '';
  const u = String(unit).toUpperCase();
  if (u === 'CNY') return '¥';
  if (u === 'TOKENS') return '';
  return '$';
}

function siteAbbrev(name) {
  // 用户自定义缩写优先;非空时原样显示(限 6 字符,过大牌子会太宽)
  const custom = String(style.abbrev || '').trim();
  if (custom) return custom.slice(0, 6);
  const base = String(name || '').split('(')[0].trim();
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/[_\-\s]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  let ab;
  if (words.length >= 2) ab = words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
  else {
    const one = words[0] || base;
    ab = (one.length <= 3 ? one : one.slice(0, 3)).toUpperCase();
  }
  return ab.replace(/[^A-Z0-9$.\-+]/g, '');
}

function applyStyle() {
  const scale = Math.max(0.6, Math.min(2.5, Number(style.scale) || 1));
  document.documentElement.style.setProperty('--bar-scale', scale);
  barEl.style.setProperty('--bar-scale', scale);
  barEl.style.fontSize = '';
  // 颜色:留空保持默认(数字随余额状态变色);填了自定义色则覆盖
  barEl.style.background = style.bgColor || '';
  barEl.style.borderColor = style.bgColor ? 'transparent' : '';
  amountEl.style.color = style.fgColor || '';
  siteEl.style.color = style.fgColor ? 'inherit' : '';
  const radius = Number(style.radius);
  barEl.style.borderRadius = (radius == null || isNaN(radius)) ? '' : Math.max(0, Math.min(60, radius)) + 'px';
}

function render(payload) {
  if (!payload) return;
  const site = (payload.sites || []).find((s) => s.id === payload.activeSiteId)
    || (payload.sites || [])[0] || null;
  const r = site ? payload.results[site.id] : null;
  const failed = !!(r && r.error);
  const balance = r && !failed ? r.balance : null;
  lastBalance = balance;
  lastFailed = failed;
  const failedCls = failed ? ' fail' : '';
  siteEl.textContent = site ? (siteAbbrev(site.name) || '--') : '--';
  siteEl.className = 'site' + failedCls;
  if (r && r.unlimited) {
    amountEl.textContent = '∞ 无限额度';
    amountEl.className = 'amount';
  } else {
    const v = balance;
    amountEl.textContent = v == null
      ? (failed ? '读取失败' : '…')
      : currencySymbol(r && r.unit) + shortBalance(v);
    amountEl.className = 'amount' + (v == null ? failedCls : ' ' + colorClass(v));
  }
  applyStyle();
  requestAnimationFrame(reportSize);
}

function reportSize() {
  const b = barEl.getBoundingClientRect();
  window.tb.bar.resize({ w: Math.ceil(b.width) + 8, h: Math.ceil(b.height) + 8 });
}

/* 主进程轮询用:返回牌子在窗口内的 CSS 像素矩形(挡住的部分只是四周透明余量) */
window.__barHit = () => {
  const b = barEl.getBoundingClientRect();
  return { x: b.left, y: b.top, w: b.width, h: b.height };
};

/* 启动:先拿样式再渲染快照 */
(async function init() {
  style = await window.tb.bar.get() || {};
  const snap = await window.tb.getSnapshot();
  render(snap);
  window.tb.onUpdate(render);
  window.tb.bar.onReload((s) => { style = s || {}; });
})();

barEl.addEventListener('click', () => { if (!dragMoved) window.tb.bar.openPanel(); });

/* 拖动:按下后移动超过阈值才算拖动,避免吃掉点击 */
let dragStart = null;
let dragMoved = false;
barEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragStart = { x: e.screenX, y: e.screenY };
  dragMoved = false;
  barEl.classList.add('dragging');
});
window.addEventListener('mousemove', (e) => {
  if (!dragStart) return;
  if (!dragMoved && Math.abs(e.screenX - dragStart.x) + Math.abs(e.screenY - dragStart.y) > 4) dragMoved = true;
  if (dragMoved) window.tb.bar.drag({ x: e.screenX, y: e.screenY });
});
window.addEventListener('mouseup', () => {
  if (!dragStart) return;
  barEl.classList.remove('dragging');
  window.tb.bar.dragEnd();
  dragStart = null;
});
