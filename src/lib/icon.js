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

/* ---------------- 3x5 位图字体 ---------------- */
const FONT = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '.': ['000', '000', '000', '000', '010'],
  '-': ['000', '000', '111', '000', '000'],
  '+': ['010', '010', '111', '010', '010'],
  'K': ['101', '101', '110', '101', '101'],
  'M': ['101', '111', '111', '101', '101'],
  'B': ['110', '101', '110', '101', '110'],
  '$': ['111', '110', '111', '011', '111'],
  ' ': ['000', '000', '000', '000', '000'],
};

function hexToRgb(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* 把余额格式化成图标里能放下的短字符串(最多 4 个字符) */
function shortBalance(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '-';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return Math.round(v / 1e3) + 'K';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (a >= 100) return String(Math.round(v));
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function fillRoundedRect(px, w, h, radius, rgb, alpha) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let inside = true;
      // 圆角判定
      const corners = [
        [radius, radius], [w - 1 - radius, radius],
        [radius, h - 1 - radius], [w - 1 - radius, h - 1 - radius],
      ];
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

function drawText(px, w, h, text, scale, rgb) {
  const tw = text.length * 4 - 1;
  const th = 5;
  const ox = Math.floor((w - tw * scale) / 2);
  const oy = Math.floor((h - th * scale) / 2);
  let cursor = 0;
  for (const ch of text) {
    const glyph = FONT[ch] || FONT[ch.toUpperCase()] || FONT['-'];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (glyph[r][c] !== '1') continue;
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
    cursor += 4; // 3px 字形 + 1px 间距
  }
}

/**
 * 生成"余额数字"托盘图标。
 * @param {string} text  短字符串(建议 <=4 字符)
 * @param {object} opts  { size, bg, color, alpha }
 * @returns {{png:Buffer,width:number,height:number}}
 */
function renderTextIcon(text, opts = {}) {
  const size = opts.size || 64;
  const bg = hexToRgb(opts.bg || '#0f172a');
  const color = hexToRgb(opts.color || '#34d399');
  const px = Buffer.alloc(size * size * 4, 0);
  fillRoundedRect(px, size, size, Math.round(size * 0.22), bg, opts.alpha == null ? 235 : opts.alpha);
  const t = String(text || '-');
  const tw = t.length * 4 - 1;
  let scale = Math.min(Math.floor((size - 4) / Math.max(tw, 1)), Math.floor((size - 4) / 5), 5);
  if (scale < 1) scale = 1;
  drawText(px, size, size, t, scale, color);
  return { png: encodePNG(size, size, px), width: size, height: size };
}

/* 按余额大小给颜色:充裕=绿,偏低=琥珀,接近 0=红 */
function colorForBalance(v, warn = 5, danger = 1) {
  if (typeof v !== 'number' || !isFinite(v)) return '#94a3b8';
  if (v <= danger) return '#f87171';
  if (v <= warn) return '#fbbf24';
  return '#34d399';
}

module.exports = { encodePNG, renderTextIcon, shortBalance, colorForBalance, hexToRgb };
