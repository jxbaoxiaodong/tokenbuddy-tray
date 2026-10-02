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
const bubbleText = $('bubbleText');
const petEl = $('pet');

img.addEventListener('load', () => computeAlpha());
fallback.addEventListener('load', () => computeAlpha());
video.addEventListener('loadeddata', () => computeAlpha());

// 内置默认吉祥物(SVG data URL,可被 drawImage,不会污染 canvas)
const DEFAULT_MASCOT = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">' +
  '<ellipse cx="60" cy="70" rx="41" ry="37" fill="#8b9bf5"/>' +
  '<ellipse cx="60" cy="96" rx="34" ry="12" fill="#000000" opacity="0.12"/>' +
  '<circle cx="46" cy="64" r="7.5" fill="#0b1220"/><circle cx="74" cy="64" r="7.5" fill="#0b1220"/>' +
  '<circle cx="48.5" cy="61.5" r="2.6" fill="#fff"/><circle cx="76.5" cy="61.5" r="2.6" fill="#fff"/>' +
  '<path d="M50 82 Q60 91 70 82" stroke="#0b1220" stroke-width="3.2" fill="none" stroke-linecap="round"/>' +
  '<circle cx="38" cy="80" r="5.4" fill="#f9a8d4" opacity="0.85"/><circle cx="82" cy="80" r="5.4" fill="#f9a8d4" opacity="0.85"/>' +
  '<circle cx="60" cy="34" r="6" fill="#a5b4fc"/><path d="M60 28 q0 -10 -8 -12" stroke="#a5b4fc" stroke-width="3" fill="none" stroke-linecap="round"/>' +
  '</svg>'
);

let state = { size: 200, opacity: 1, flip: false, showBalance: true, mediaType: 'image', asset: null };
let currentMedia = null; // 当前用于显示的 media 元素(img / video / fallback)

/* ---------------- 命中网格 ---------------- */
const off = document.createElement('canvas');
const octx = off.getContext('2d', { willReadFrequently: true });
let alphaTimer = null;

function activeMedia() {
  if (state.asset && state.mediaType === 'video' && !video.classList.contains('hidden')) return video;
  if (state.asset && !img.classList.contains('hidden')) return img;
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
  } else {
    fallback.src = DEFAULT_MASCOT;
    fallback.classList.remove('hidden');
    currentMedia = fallback;
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
function money(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '$—';
  if (v !== 0 && Math.abs(v) < 1) return '$' + v.toFixed(4);
  return '$' + v.toFixed(2);
}
function updateSnapshot(snap) {
  const r = snap && snap.active;
  if (!r || r.error) {
    bubbleText.textContent = snap && snap.refreshing ? '刷新中…' : (r && r.error ? '读取失败' : '$—');
    bubble.classList.remove('low');
    return;
  }
  bubbleText.textContent = money(r.balance);
  const low = typeof r.balance === 'number' && r.balance <= 1;
  bubble.classList.toggle('low', low);
  if (state.showBalance && bubble.classList.contains('hidden')) bubble.classList.remove('hidden');
}

/* ---------------- 交互 ---------------- */
let press = null;
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  press = { sx: e.screenX, sy: e.screenY, cursor: { x: e.screenX, y: e.screenY }, moved: false };
});
document.addEventListener('mousemove', (e) => {
  if (!press) return;
  const dx = Math.abs(e.screenX - press.sx), dy = Math.abs(e.screenY - press.sy);
  if (!press.moved && dx + dy < 4) return;
  if (!press.moved) { press.moved = true; window.tb.pet.dragStart(press.cursor); }
  window.tb.pet.drag({ x: e.screenX, y: e.screenY });
});
document.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !press) return;
  const moved = press.moved;
  press = null;
  if (moved) { window.tb.pet.dragEnd(); return; }
  // 单击:蹦一下 + 打开余额面板
  petEl.classList.remove('hop');
  void petEl.offsetWidth;
  petEl.classList.add('hop');
  setTimeout(() => petEl.classList.remove('hop'), 480);
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
