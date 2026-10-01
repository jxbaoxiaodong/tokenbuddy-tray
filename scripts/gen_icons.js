'use strict';
/* 生成应用图标 assets/icon.png(512)与托盘兜底 assets/tray.png(64)。纯 stdlib。 */
const fs = require('fs');
const path = require('path');
const { encodePNG } = require('../src/lib/icon');

const FONT = { '$': ['111', '110', '111', '011', '111'], 'B': ['110', '101', '110', '101', '110'] };

function hex(h) { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

function make(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const c1 = hex('#6366f1'), c2 = hex('#22d3ee');
  const r = Math.round(size * 0.24);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 圆角
      const cx = x < r ? r : x > size - 1 - r ? size - 1 - r : x;
      const cy = y < r ? r : y > size - 1 - r ? size - 1 - r : y;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > r * r) continue;
      const t = (x + y) / (2 * size);
      const i = (y * size + x) * 4;
      px[i] = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      px[i + 1] = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      px[i + 2] = Math.round(c1[2] + (c2[2] - c1[2]) * t);
      px[i + 3] = 255;
    }
  }
  // 居中白色 "$"
  const glyph = FONT.$;
  const scale = Math.max(1, Math.floor(size * 0.5 / 5));
  const tw = 3 * scale, th = 5 * scale;
  const ox = Math.floor((size - tw) / 2), oy = Math.floor((size - th) / 2) - Math.round(size * 0.01);
  for (let rr = 0; rr < 5; rr++) for (let cc = 0; cc < 3; cc++) {
    if (glyph[rr][cc] !== '1') continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const X = ox + cc * scale + dx, Y = oy + rr * scale + dy;
      const i = (Y * size + X) * 4;
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255;
    }
  }
  return encodePNG(size, size, px);
}

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), make(512));
fs.writeFileSync(path.join(dir, 'tray.png'), make(64));
console.log('icons written to', dir);
