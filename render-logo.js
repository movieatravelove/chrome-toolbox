/**
 * ChromeToolbox logo 渲染器（零依赖）
 * 将 logo-master.svg 的同构设计直接光栅化为 16/48/128 PNG。
 * 4x4 超采样抗锯齿，PNG 用内置 zlib 编码。
 * 运行：node render-logo.js
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

// ---------- 形状（均在 128 单位坐标系） ----------
// 圆角矩形：夹到内缩 r 的矩形后比距离，圆心位于内缩角（正确切除外角）
function inRoundRect(x, y, rx, ry, rw, rh, r) {
  r = Math.min(r, rw / 2, rh / 2);
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inCircle(x, y, ccx, ccy, r) {
  const dx = x - ccx, dy = y - ccy;
  return dx * dx + dy * dy <= r * r;
}

// 提手：上半圆环（中心 (64,47)，半径14，管粗7）+ 两腿
function inHandle(x, y) {
  if (y <= 47) {
    const d = Math.sqrt((x - 64) * (x - 64) + (y - 47) * (y - 47));
    if (Math.abs(d - 14) <= 3.5) return true;
  }
  if (y >= 47 && y <= 58) {
    if ((x >= 46.5 && x <= 53.5) || (x >= 74.5 && x <= 81.5)) return true;
  }
  return false;
}

const C_WHITE = [255, 255, 255];
const C_BLUE = [43, 87, 201]; // #2B57C9
const C_TOP = [91, 141, 239]; // #5B8DEF
const C_RED = [234, 67, 53];
const C_YELLOW = [251, 188, 5];
const C_GREEN = [52, 168, 83];

function lerp(a, b, t) { return a + (b - a) * t; }

const C_SEAM = [190, 206, 238]; // 底板版接缝浅灰蓝

// 对角渐变色（glyph 版工具箱本体）
function gradAt(x, y) {
  const t = (x + y) / 256;
  return [
    Math.round(lerp(C_TOP[0], C_BLUE[0], t)),
    Math.round(lerp(C_TOP[1], C_BLUE[1], t)),
    Math.round(lerp(C_TOP[2], C_BLUE[2], t)),
  ];
}
function blend(c1, c2, t) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

// variant: 'plate' 圆角蓝底白工具箱 | 'glyph' 透明底蓝色工具箱
// 返回该点颜色（不透明形状覆盖），形状外返回 null
function sampleAt(x, y, variant, showDots, showSeam) {
  let color = null;

  if (variant === 'plate') {
    if (!inRoundRect(x, y, 0, 0, 128, 128, 28)) return null;
    color = gradAt(x, y);
  }

  if (inHandle(x, y)) color = variant === 'plate' ? C_WHITE : gradAt(x, y);
  if (inRoundRect(x, y, 26, 54, 76, 14, 7)) {
    color = variant === 'plate' ? C_WHITE : gradAt(x, y); // 箱盖
  }
  if (inRoundRect(x, y, 30, 66, 68, 40, 9)) {
    color = variant === 'plate' ? C_WHITE : gradAt(x, y); // 箱体
    if (showSeam && y >= 66 && y <= 68.4 &&
        ((x >= 32 && x <= 57) || (x >= 71 && x <= 96))) {
      // glyph 版接缝用半透明白叠在蓝体上
      color = variant === 'plate' ? C_SEAM : blend(color, C_WHITE, 0.35);
    }
    if (showDots) {
      if (inCircle(x, y, 48, 88, 5)) color = C_RED;
      else if (inCircle(x, y, 64, 88, 5)) color = C_YELLOW;
      else if (inCircle(x, y, 80, 88, 5)) color = C_GREEN;
    }
  }
  // 锁扣：底板版蓝、透明版白
  if (inRoundRect(x, y, 58, 62, 12, 14, 3)) {
    color = variant === 'plate' ? C_BLUE : C_WHITE;
  }
  return color;
}

// 16px 专用加粗造型（直接在 16 单位坐标系设计，小尺寸下保证可辨）
function sample16(x, y, variant) {
  let color = null;
  if (variant === 'plate') {
    if (!inRoundRect(x, y, 0, 0, 16, 16, 3.5)) return null;
    const t = (x + y) / 32;
    color = [
      Math.round(lerp(C_TOP[0], C_BLUE[0], t)),
      Math.round(lerp(C_TOP[1], C_BLUE[1], t)),
      Math.round(lerp(C_TOP[2], C_BLUE[2], t)),
    ];
  }
  const bodyColor = variant === 'plate' ? C_WHITE : [
    Math.round(lerp(C_TOP[0], C_BLUE[0], (x + y) / 32)),
    Math.round(lerp(C_TOP[1], C_BLUE[1], (x + y) / 32)),
    Math.round(lerp(C_TOP[2], C_BLUE[2], (x + y) / 32)),
  ];

  // 提手：R 2.3，管粗 1.1
  if (y <= 7) {
    const d = Math.sqrt((x - 8) * (x - 8) + (y - 7) * (y - 7));
    if (Math.abs(d - 2.3) <= 0.55) color = bodyColor;
  }
  if (y >= 7 && y <= 7.9 &&
      ((x >= 5.15 && x <= 6.25) || (x >= 9.75 && x <= 10.85))) color = bodyColor;
  if (inRoundRect(x, y, 3, 7, 10, 2.3, 1.15)) color = bodyColor; // 箱盖
  if (inRoundRect(x, y, 3.7, 9, 8.6, 4.6, 1.2)) color = bodyColor; // 箱体
  if (inRoundRect(x, y, 7.2, 7.9, 1.6, 2, 0.45)) {
    color = variant === 'plate' ? C_BLUE : C_WHITE; // 锁扣
  }
  return color;
}

// ---------- 超采样光栅化 ----------
// glyph 版放大系数：原造型只占约 60% 幅面，放大到 ~80%（标准透明图标比例）。
// 设计中心：128 版 (64, 67.75)、16 版 (8, 8.875)，放大后对准各自画布中心。
const GLYPH_K = 1.22;
const GLYPH_K16 = 1.2;

function render(size, variant) {
  const native16 = size === 16;
  const SS = size >= 128 ? 4 : 8; // 小尺寸细接缝多，加倍超采样避免杂点
  const showDots = size >= 32;
  const showSeam = size >= 48;
  const scale = 128 / size;
  const px = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = pxx + (sx + 0.5) / SS;
          const dy = py + (sy + 0.5) / SS;
          let c;
          if (variant === 'glyph') {
            // 画布坐标 → 放大前的设计坐标（逆变换），同时完成居中
            if (native16) {
              c = sample16(8 + (dx - 8) / GLYPH_K16,
                           8.875 + (dy - 8) / GLYPH_K16, variant);
            } else {
              c = sampleAt(64 + (dx * scale - 64) / GLYPH_K,
                           67.75 + (dy * scale - 64) / GLYPH_K,
                           variant, showDots, showSeam);
            }
          } else {
            c = native16
              ? sample16(dx, dy, variant)
              : sampleAt(dx * scale, dy * scale, variant, showDots, showSeam);
          }
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (py * size + pxx) * 4;
      // 用透明度合成到透明背景，保持 RGB 为未自左乘色
      px[i] = a ? Math.round(r / a * 255) : 0;
      px[i + 1] = a ? Math.round(g / a * 255) : 0;
      px[i + 2] = a ? Math.round(b / a * 255) : 0;
      px[i + 3] = Math.round(a / n);
    }
  }
  return px;
}

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
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
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, w, h) {
  h = h || w;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  // 每行前置 filter 0
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 方案对比预览（浅色/深色工具栏背景上实际效果） ----------
function makePreview() {
  const W = 560, H = 360;
  const canvas = Buffer.alloc(W * H * 4);
  function fill(r, g, b, y0, y1) {
    for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      canvas[i] = r; canvas[i + 1] = g; canvas[i + 2] = b; canvas[i + 3] = 255;
    }
  }
  fill(241, 243, 244, 0, H / 2);   // Chrome 浅色工具栏
  fill(53, 54, 58, H / 2, H);     // Chrome 深色工具栏

  function blit(rgba, s, x0, y0) {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const si = (y * s + x) * 4;
      const sa = rgba[si + 3] / 255;
      if (!sa) continue;
      const di = ((y0 + y) * W + (x0 + x)) * 4;
      const da = canvas[di + 3] / 255;
      const outA = sa + da * (1 - sa);
      for (let k = 0; k < 3; k++) {
        canvas[di + k] = Math.round((rgba[si + k] * sa + canvas[di + k] * da * (1 - sa)) / outA);
      }
      canvas[di + 3] = Math.round(outA * 255);
    }
  }

  const rows = [16, H / 2 + 16];
  rows.forEach((y0) => {
    blit(render(128, 'glyph'), 128, 16, y0);          // 透明版大图
    blit(render(48, 'glyph'), 48, 164, y0);
    blit(render(32, 'glyph'), 32, 164, y0 + 56);
    blit(render(16, 'glyph'), 16, 172, y0 + 112);
    blit(render(128, 'plate'), 128, 296, y0);         // 底板版大图
    blit(render(48, 'plate'), 48, 444, y0);
    blit(render(32, 'plate'), 32, 444, y0 + 56);
    blit(render(16, 'plate'), 16, 452, y0 + 112);
  });
  return encodePNG(canvas, W, H);
}

// ---------- 输出 ----------
const outDir = path.join(__dirname, 'icons');
const VARIANT = process.env.LOGO_VARIANT || 'plate'; // plate | glyph
for (const size of [16, 48, 128]) {
  const png = encodePNG(render(size, VARIANT), size);
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`icons/icon${size}.png [${VARIANT}]  ${png.length} bytes`);
}
