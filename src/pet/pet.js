'use strict';

/* TokenBuddy 桌面宠物渲染进程
 * - 显示自定义形象(图片 / GIF / WebM 视频),静态图自动加待机动画
 * - 逐像素命中检测:把窗口内容合成到离屏 canvas,降采样成 alpha 网格送主进程
 *   主进程据此决定鼠标事件穿透(透明处穿透,只有形象/气泡可点)
 * - 拖动、单击、右键菜单、余额气泡
 */
const $ = (id) => document.getElementById(id);
const img = $('media');
const video = $('mediaVideo');
const fallback = $('fallback');
const bubble = $('bubble');
const bubbleName = $('bubbleName');
const bubbleText = $('bubbleText');
const petEl = $('pet');

img.addEventListener('load', () => computeAlpha());
img.addEventListener('error', onMascotError);
fallback.addEventListener('load', () => computeAlpha());
video.addEventListener('loadeddata', () => computeAlpha());

// 内置默认吉祥物(SVG data URL,可被 drawImage,不会污染 canvas)
const DEFAULT_MASCOT = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 140">' +
  '<defs>' +
  '<radialGradient id="body" cx="38%" cy="30%" r="78%">' +
  '<stop offset="0%" stop-color="#c4b5fd"/><stop offset="52%" stop-color="#818cf8"/><stop offset="100%" stop-color="#4f46e5"/>' +
  '</radialGradient>' +
  '<radialGradient id="gloss" cx="50%" cy="50%" r="50%">' +
  '<stop offset="0%" stop-color="#ffffff" stop-opacity=".55"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>' +
  '</radialGradient>' +
  '<linearGradient id="tip" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0%" stop-color="#fde68a"/><stop offset="100%" stop-color="#fbbf24"/>' +
  '</linearGradient>' +
  '</defs>' +
  // 地面投影
  '<ellipse cx="70" cy="124" rx="40" ry="9" fill="#0b1220" opacity="0.13"/>' +
  // 天线
  '<path d="M70 26 q0 -13 11 -16" stroke="#a5b4fc" stroke-width="4.5" fill="none" stroke-linecap="round"/>' +
  '<circle cx="83" cy="11" r="7.5" fill="url(#tip)"/>' +
  '<circle cx="81" cy="9" r="2.4" fill="#fff" opacity="0.9"/>' +
  // 耳朵
  '<path d="M33 45 L26 25 L48 34 Z" fill="#6366f1"/>' +
  '<path d="M107 45 L114 25 L92 34 Z" fill="#6366f1"/>' +
  // 身体
  '<circle cx="70" cy="74" r="46" fill="url(#body)"/>' +
  '<circle cx="70" cy="74" r="46" fill="none" stroke="#3730a3" stroke-width="2.5" opacity="0.55"/>' +
  // 高光
  '<ellipse cx="56" cy="52" rx="22" ry="16" fill="url(#gloss)" transform="rotate(-22 56 52)"/>' +
  // 腮红
  '<ellipse cx="40" cy="86" rx="10" ry="6.5" fill="#fda4af" opacity="0.5"/>' +
  '<ellipse cx="100" cy="86" rx="10" ry="6.5" fill="#fda4af" opacity="0.5"/>' +
  // 眼睛
  '<ellipse cx="55" cy="72" rx="9" ry="10.5" fill="#0b1220"/>' +
  '<ellipse cx="85" cy="72" rx="9" ry="10.5" fill="#0b1220"/>' +
  '<circle cx="58.5" cy="68" r="3.4" fill="#fff"/>' +
  '<circle cx="88.5" cy="68" r="3.4" fill="#fff"/>' +
  '<circle cx="52.5" cy="76" r="1.8" fill="#fff" opacity="0.75"/>' +
  '<circle cx="82.5" cy="76" r="1.8" fill="#fff" opacity="0.75"/>' +
  // 嘴
  '<path d="M62 92 Q70 99.5 78 92" stroke="#0b1220" stroke-width="3.4" fill="none" stroke-linecap="round"/>' +
  '</svg>'
);

/* 默认形象:黑白猫吉祥物素材(assets/pet/01..09.png)
 * 素材来源与生成方式见 scripts/build-pet-assets.py。
 * 内置 SVG 吉祥物只在这 9 张都加载失败时兜底。
 * 状态取自真实数据,不为了好看伪造:余额档位、无限额度、刷新中、失败、
 * 读不到余额,以及单击、拖动这两种交互状态。
 */
const MASCOT_STATES = {
  balance:    { file: '01.png', note: '欢呼 — 余额正常' },
  empty:      { file: '02.png', note: '伤心 — 余额为 0' },
  low:        { file: '03.png', note: '捧着硬币 — 余额偏低(0 < 余额 ≤ 1)' },
  clicked:    { file: '04.png', note: '蹦跳 — 单击反应' },
  refreshing: { file: '05.png', note: '盯着沙漏 — 正在刷新' },
  error:      { file: '06.png', note: '转圈圈 — 读取失败' },
  dragging:   { file: '07.png', note: '被拎起来 — 拖动中' },
  unknown:    { file: '08.png', note: '摊手疑问 — 余额读不到' },
  unlimited:  { file: '09.png', note: '比个心 — 无限额度' },
};
const MASCOT_FALLBACK_MOOD = 'balance';

let state = { size: 200, opacity: 1, flip: false, showBalance: true, mediaType: 'image', asset: null };
let currentMedia = null; // 当前用于显示的 media 元素(img / video / fallback)
let mascotMood = null;   // 当前形象对应的 MASCOT_STATES 键
let mascotBroken = false; // 默认素材加载失败后退回内置 SVG
const mascotFailedFiles = new Set();
let interaction = null;   // 'clicked' / 'dragging',优先于余额表情
let clickedTimer = null;
let latestSnapshot = null;

/* 余额表情:只用真实数据判断,不做兜底美化 */
function moodFromSnapshot(snap) {
  const r = snap && snap.active;
  const usable = !!r && !r.error && !r.unlimited && typeof r.balance === 'number' && isFinite(r.balance);
  // 已有可用余额时,后台定时刷新不再改表情,避免每轮刷新都闪一下
  if (snap && snap.refreshing && !usable) return 'refreshing';
  if (!r) return 'refreshing';
  if (r.error) return 'error';
  if (r.unlimited) return 'unlimited';
  if (typeof r.balance !== 'number' || !isFinite(r.balance)) return 'unknown';
  if (r.balance <= 0) return 'empty';
  if (r.balance <= 1) return 'low';
  return 'balance';
}

function mascotUrl(mood) {
  const entry = MASCOT_STATES[mood] || MASCOT_STATES[MASCOT_FALLBACK_MOOD];
  return '../../assets/pet/' + entry.file;
}

/* 切换默认形象;自定义素材时不动 */
function syncMascot() {
  if (state.asset || mascotBroken) return;
  const mood = interaction || moodFromSnapshot(latestSnapshot);
  if (mood === mascotMood) return;
  mascotMood = mood;
  img.src = mascotUrl(mood);
  img.classList.remove('hidden');
  fallback.classList.add('hidden');
  currentMedia = img;
}

/* 默认素材加载失败:退回内置 SVG,并留下明确日志,不再静默 */
function onMascotError() {
  if (state.asset) return;
  const failedFile = Object.values(MASCOT_STATES).find((entry) => img.src.endsWith('/' + entry.file));
  if (failedFile) mascotFailedFiles.add(failedFile.file);
  const allFailed = mascotFailedFiles.size === Object.keys(MASCOT_STATES).length;
  mascotBroken = allFailed;
  console.error('pet: 默认形象素材加载失败', failedFile ? failedFile.file : '(未知素材)',
    allFailed ? '，9 张素材均失败，退回内置 SVG 吉祥物' : '，当前状态暂用内置 SVG 吉祥物');
  img.classList.add('hidden');
  fallback.src = DEFAULT_MASCOT;
  fallback.classList.remove('hidden');
  currentMedia = fallback;
  computeAlpha();
}

/* ---------------- 命中网格 ---------------- */
const off = document.createElement('canvas');
const octx = off.getContext('2d', { willReadFrequently: true });
let alphaTimer = null;

function activeMedia() {
  if (state.asset && state.mediaType === 'video' && !video.classList.contains('hidden')) return video;
  if (!img.classList.contains('hidden')) return img;
  return fallback;
}
function computeAlpha() {
  const W = window.innerWidth, H = window.innerHeight;
  if (!W || !H) return;
  off.width = W; off.height = H;
  octx.clearRect(0, 0, W, H);
  if (bubble && !bubble.classList.contains('hidden')) {
    const r = bubble.getBoundingClientRect();
    octx.fillStyle = '#000';
    octx.fillRect(r.left, r.top, r.width, r.height);
  }
  const m = activeMedia();
  try {
    if (m) {
      const r = m.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) octx.drawImage(m, r.left, r.top, r.width, r.height);
    }
  } catch (e) {}
  const cols = 48;
  const rows = Math.max(1, Math.round(cols * H / W));
  const data = new Uint8Array(cols * rows);
  let px;
  try { px = octx.getImageData(0, 0, W, H).data; } catch (e) { px = null; }
  if (px) {
    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) {
        const sx = Math.min(W - 1, Math.floor((rx + 0.5) * W / cols));
        const sy = Math.min(H - 1, Math.floor((ry + 0.5) * H / rows));
        const a = px[(sy * W + sx) * 4 + 3];
        data[ry * cols + rx] = a > 20 ? 1 : 0;
      }
    }
  }
  window.tb.pet.sendAlpha({ cols, rows, data });
}
function startAlphaLoop() {
  if (alphaTimer) clearInterval(alphaTimer);
  computeAlpha();
  alphaTimer = setInterval(computeAlpha, 1200);
}

/* ---------------- 应用状态 ---------------- */
function layout() {
  const s = Math.max(64, Number(state.size) || 200);
  petEl.style.width = s + 'px';
  petEl.style.height = s + 'px';
  petEl.classList.toggle('flip', !!state.flip);
  document.documentElement.style.opacity = String(state.opacity == null ? 1 : state.opacity);
}
function applyMedia() {
  img.classList.add('hidden'); video.classList.add('hidden'); fallback.classList.add('hidden');
  img.removeAttribute('src'); video.removeAttribute('src');
  video.pause();
  if (state.asset) {
    if (state.mediaType === 'video') {
      video.src = state.asset;
      video.classList.remove('hidden');
      currentMedia = video;
      video.play().catch(() => {});
    } else {
      img.src = state.asset;
      img.classList.remove('hidden');
      currentMedia = img;
    }
  } else if (mascotBroken) {
    fallback.src = DEFAULT_MASCOT;
    fallback.classList.remove('hidden');
    currentMedia = fallback;
  } else {
    mascotMood = null; // 强制按当前状态重新取图
    syncMascot();
  }
  petEl.classList.remove('hop');
  petEl.classList.add('idle');
  setTimeout(computeAlpha, 120);
}
function applyState(s) {
  state = Object.assign({}, state, s || {});
  layout();
  applyMedia();
  bubble.classList.toggle('hidden', !state.showBalance);
  startAlphaLoop();
}

/* ---------------- 余额气泡 ---------------- */
function money(v, unit) {
  // 站点没声明币种时印裸数字,不编造 "$"
  const sym = unit == null || unit === '' ? '' : (unit === 'CNY' ? '¥' : (unit === 'TOKENS' ? '' : '$'));
  if (typeof v !== 'number' || !isFinite(v)) return sym + '—';
  if (v !== 0 && Math.abs(v) < 1) return sym + v.toFixed(4);
  return sym + v.toFixed(2);
}
function updateSnapshot(snap) {
  const r = snap && snap.active;
  latestSnapshot = snap || null;
  // 站名取配置里的名字;只看余额不知道是哪个站点
  const site = snap && snap.sites ? snap.sites.find((s) => s.id === snap.activeSiteId) : null;
  const siteName = (site && site.name) || (r && r.name) || '';
  bubbleName.textContent = siteName;
  bubble.classList.toggle('no-site', !siteName);

  if (!r || r.error) {
    bubbleText.textContent = snap && snap.refreshing ? '刷新中…' : (r && r.error ? '读取失败' : '—');
    bubble.classList.remove('low');
    syncMascot();
    return;
  }
  if (r.unlimited) {
    bubbleText.textContent = '无限额度';
    bubble.classList.remove('low');
    if (state.showBalance && bubble.classList.contains('hidden')) bubble.classList.remove('hidden');
    syncMascot();
    return;
  }
  bubbleText.textContent = r.balance == null ? '—' : money(r.balance, r.unit);
  const low = typeof r.balance === 'number' && r.balance <= 1;
  bubble.classList.toggle('low', low);
  if (state.showBalance && bubble.classList.contains('hidden')) bubble.classList.remove('hidden');
  syncMascot();
}

/* ---------------- 交互 ---------------- */
let press = null;

/* 交互表情:单击、拖动优先于余额表情,交互结束后恢复 */
function setInteraction(value) {
  if (interaction === value) return;
  interaction = value;
  syncMascot();
}

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  window.tb.pet.press();
  press = { sx: e.screenX, sy: e.screenY, cursor: { x: e.screenX, y: e.screenY }, moved: false };
});
document.addEventListener('mousemove', (e) => {
  if (!press) return;
  const dx = Math.abs(e.screenX - press.sx), dy = Math.abs(e.screenY - press.sy);
  if (!press.moved && dx + dy < 4) return;
  if (!press.moved) { press.moved = true; window.tb.pet.dragStart(press.cursor); setInteraction('dragging'); }
  window.tb.pet.drag({ x: e.screenX, y: e.screenY });
});
document.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !press) return;
  window.tb.pet.release();
  const moved = press.moved;
  press = null;
  if (moved) { window.tb.pet.dragEnd(); setInteraction(null); return; }
  // 单击:蹦一下 + 打开余额面板
  petEl.classList.remove('hop');
  void petEl.offsetWidth;
  petEl.classList.add('hop');
  setTimeout(() => petEl.classList.remove('hop'), 480);
  setInteraction('clicked');
  if (clickedTimer) clearTimeout(clickedTimer);
  clickedTimer = setTimeout(() => { clickedTimer = null; setInteraction(null); }, 1800);
  window.tb.pet.panel();
});
document.addEventListener('contextmenu', (e) => { e.preventDefault(); window.tb.pet.menu(); });
// 阻止拖拽图片默认行为
document.addEventListener('dragstart', (e) => e.preventDefault());

/* ---------------- 启动 ---------------- */
(async function init() {
  const st = await window.tb.pet.get();
  applyState({
    size: st.size, opacity: st.opacity, flip: st.flip, showBalance: st.showBalance,
    mediaType: st.mediaType, asset: st.asset ? st.asset.url : null,
  });
  if (st.snapshot) updateSnapshot(st.snapshot);
  window.tb.onUpdate((snap) => updateSnapshot(snap));
  window.tb.pet.onReload((payload) => {
    applyState({
      size: payload.size, opacity: payload.opacity, flip: payload.flip,
      showBalance: payload.showBalance, mediaType: payload.mediaType, asset: payload.asset ? payload.asset.url : null,
    });
  });
  window.addEventListener('resize', () => { layout(); computeAlpha(); });
})();
