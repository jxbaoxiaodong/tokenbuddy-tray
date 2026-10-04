'use strict';

const zlib = require('zlib');

/* ---------------- 极简 PNG 编码(纯 stdlib,无依赖) ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- 5x7 点阵字体 ----------------
 * 之前用的是 3x5:每个字形只有 3 列宽,缩到托盘尺寸后笔画粘连糊成一团。
 * 换成 5x7(每列独立可分辨),在托盘高度下每个点阵像素接近 1 个逻辑像素,数字才认得出。
 */
const G = {
  '0': '01110,10001,10011,10101,11001,10001,01110',
  '1': '00100,01100,00100,00100,00100,00100,01110',
  '2': '01110,10001,00001,00010,00100,01000,11111',
  '3': '11111,00010,00100,00010,00001,10001,01110',
  '4': '00010,00110,01010,10010,11111,00010,00010',
  '5': '11111,10000,11110,00001,00001,10001,01110',
  '6': '00110,01000,10000,11110,10001,10001,01110',
  '7': '11111,00001,00010,00100,01000,01000,01000',
  '8': '01110,10001,10001,01110,10001,10001,01110',
  '9': '01110,10001,10001,01111,00001,00010,01100',
  A: '01110,10001,10001,11111,10001,10001,10001',
  B: '11110,10001,10001,11110,10001,10001,11110',
  C: '01110,10001,10000,10000,10000,10001,01110',
  D: '11100,10010,10001,10001,10001,10010,11100',
  E: '11111,10000,10000,11110,10000,10000,11111',
  F: '11111,10000,10000,11110,10000,10000,10000',
  G: '01110,10001,10000,10111,10001,10001,01111',
  H: '10001,10001,10001,11111,10001,10001,10001',
  I: '01110,00100,00100,00100,00100,00100,01110',
  J: '00111,00010,00010,00010,00010,10010,01100',
  K: '10001,10010,10100,11000,10100,10010,10001',
  L: '10000,10000,10000,10000,10000,10000,11111',
  M: '10001,11011,10101,10101,10001,10001,10001',
  N: '10001,11001,10101,10011,10001,10001,10001',
  O: '01110,10001,10001,10001,10001,10001,01110',
  P: '11110,10001,10001,11110,10000,10000,10000',
  Q: '01110,10001,10001,10001,10101,10010,01101',
  R: '11110,10001,10001,11110,10100,10010,10001',
  S: '01111,10000,10000,01110,00001,00001,11110',
  T: '11111,00100,00100,00100,00100,00100,00100',
  U: '10001,10001,10001,10001,10001,10001,01110',
  V: '10001,10001,10001,10001,10001,01010,00100',
  W: '10001,10001,10001,10101,10101,11011,10001',
  X: '10001,10001,01010,00100,01010,10001,10001',
  Y: '10001,10001,01010,00100,00100,00100,00100',
  Z: '11111,00001,00010,00100,01000,10000,11111',
  '.': '00000,00000,00000,00000,00000,01100,01100',
  ',': '00000,00000,00000,00000,01100,01100,01000',
  '-': '00000,00000,00000,11111,00000,00000,00000',
  '+': '00000,00100,00100,11111,00100,00100,00000',
  '/': '00001,00010,00010,00100,01000,01000,10000',
  '$': '00100,01111,10100,01110,00101,11110,00100',
  '%': '11001,11010,00010,00100,01000,01011,10011',
  '¥': '10001,01010,00100,11111,00100,00100,00100',
  ' ': '00000,00000,00000,00000,00000,00000,00000',
};
const GLYPHS = {};
for (const k in G) GLYPHS[k] = G[k].split(',');

function glyphOf(ch) {
  return GLYPHS[ch] || GLYPHS[ch.toUpperCase()] || GLYPHS['-'];
}

/* 站名缩写:TokenBuddy -> TB,CC Switch -> CS,MyAPIGateway -> MAG
 * 驼峰、连字符、下划线、数字边界都算词边界;只有一个词时直接截前 3 个字母 */
function abbrevName(name, max) {
  const cap = max || 3;
  const raw = String(name || '').trim();
  if (!raw) return '';
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/[_\-\s]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  if (words.length >= 2) return words.slice(0, cap).map((w) => w[0]).join('').toUpperCase();
  const one = words[0] || raw;
  return (one.length <= cap ? one : one.slice(0, cap)).toUpperCase();
}
/* 站名里可能有中文,点阵字库画不了;能画的部分留下,画不了就当作"没有可用站名" */
function renderableName(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9$.\-+]/g, '');
}

/* ---------------- 工具 ---------------- */
// 图标最大宽高比。GNOME 顶栏按"高度"归一化缩放托盘图标,图标越宽,每个字形被缩得越小,
// 所以宁可截断站名也要把宽度锁住,保证金额那一行落在接近 1 逻辑像素/点阵像素的可读区间。
const ICON_MAX_ASPECT = 1.9;
// 两行之外,站名画不了(中文等)时金额独占一行并放大
const ICON_MAX_ASPECT_SINGLE = 1.2;

function hexToRgb(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* 把余额格式化成图标里放得下的短字符串 */
function trimZero(s) { return s.replace(/\.0$/, ''); }
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
    return s + trimZero((a / 1e6).toFixed(1)) + 'M';   // 四舍五入到 1000K 就该升级成 M
  }
  if (a >= 100) return s + String(Math.round(a));
  return s + a.toFixed(2);
}

/* 币种符号:New API 的 quota_display_type 可能是 USD / CNY / TOKENS,
 * 一律按站点自己的口径显示,不再一律印 "$" */
function currencySymbol(unit) {
  const u = String(unit || 'USD').toUpperCase();
  if (u === 'CNY') return '¥';
  if (u === 'TOKENS') return '';
  return '$';
}
function money(v, unit) {
  const sym = currencySymbol(unit);
  if (typeof v !== 'number' || !isFinite(v)) return sym + '—';
  if (v !== 0 && Math.abs(v) < 1) return sym + v.toFixed(4);
  return sym + v.toFixed(2);
}

/* ---------------- 绘制 ---------------- */
function fillRoundedRect(px, w, h, radius, rgb, alpha) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let inside = true;
      const near = (cx, cy) => x < radius && y < radius ? [0, 0] : x > w - 1 - radius && y < radius ? [w - 1, 0]
        : x < radius && y > h - 1 - radius ? [0, h - 1] : x > w - 1 - radius && y > h - 1 - radius ? [w - 1, h - 1] : null;
      const c = near();
      if (c) {
        const dx = x - c[0], dy = y - c[1];
        if (dx * dx + dy * dy > radius * radius) inside = false;
      }
      if (!inside) continue;
      const i = (y * w + x) * 4;
      px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = alpha;
    }
  }
}

function textWidth(text, scale) {
  return text.length * 6 * scale - scale; // 每字形 5 列 + 1 列间距
}

/* 在 (ox,oy) 处画一行 5x7 文本 */
function drawText(px, w, h, text, scale, rgb, ox, oy) {
  let cursor = 0;
  for (const ch of text) {
    const glyph = glyphOf(ch);
    for (let r = 0; r < 7; r++) {
      const row = glyph[r];
      for (let c = 0; c < 5; c++) {
        if (row[c] !== '1') continue;
        const bx = ox + (cursor + c) * scale;
        const by = oy + r * scale;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const X = bx + dx, Y = by + dy;
            if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
            const i = (Y * w + X) * 4;
            px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = 255;
          }
        }
      }
    }
    cursor += 6;
  }
}

/**
 * 生成托盘图标:上行站点名(缩写)+ 下行金额。
 * 站名优先用完整可渲染名,放不下退到首字母缩写(TokenBuddy -> TB),再不行就只留金额并放大。
 * @param {object} opts { name, amount, size, bg, color, nameColor, alpha }
 * @returns {{png:Buffer,width:number,height:number}}
 */
function renderBalanceIcon(opts = {}) {
  const size = Number(opts.size) || 64;
  const H = size;
  const amountStr = String(opts.amount == null || opts.amount === '' ? '-' : opts.amount);
  const bg = hexToRgb(opts.bg || '#0f172a');
  const color = hexToRgb(opts.color || '#34d399');
  const alpha = opts.alpha == null ? 245 : opts.alpha;
  const padX = 1;
  let scale = Math.max(1, Math.floor(H / 7));
  if (7 * scale > H - 1) scale = scale - 1;
  if (scale < 1) scale = 1;
  while (scale + 1 <= Math.floor(H / 7)) {
    const s2 = scale + 1;
    const w2 = textWidth(amountStr, s2) + padX * 2;
    if (w2 > Math.round(H * ICON_MAX_ASPECT_SINGLE)) break;
    scale = s2;
  }
  const amtW = textWidth(amountStr, scale);
  const glyphH = 7 * scale;
  const top = Math.round((H - glyphH) / 2);
  const W = amtW + padX * 2;
  const px = Buffer.alloc(W * H * 4, 0);
  fillRoundedRect(px, W, H, Math.round(H * 0.22), bg, alpha);
  drawText(px, W, H, amountStr, scale, color, padX, top);
  return { png: encodePNG(W, H, px), width: W, height: H };
}

/* 按余额大小给颜色:充裕=绿,偏低=琥珀,接近 0=红 */
function colorForBalance(v, warn = 5, danger = 1) {
  if (typeof v !== 'number' || !isFinite(v)) return '#94a3b8';
  if (v <= danger) return '#f87171';
  if (v <= warn) return '#fbbf24';
  return '#34d399';
}

module.exports = {
  encodePNG, renderBalanceIcon, shortBalance, colorForBalance, hexToRgb,
  currencySymbol, money, abbrevName, renderableName,
  ICON_MAX_ASPECT, ICON_MAX_ASPECT_SINGLE,
};