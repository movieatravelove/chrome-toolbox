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
function inRoundRect(x, y, rx, ry, rw, rh, r) {
  const cx = Math.min(Math.max(x, rx), rx + rw);
  const cy = Math.min(Math.max(y, ry), ry + rh);
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

const C_SEAM = [190, 206, 238]; // 箱盖/箱体接缝浅灰蓝

// 返回该点颜色（不透明形状覆盖），底板外返回 null
function sampleAt(x, y, showDots, showSeam) {
  if (!inRoundRect(x, y, 0, 0, 128, 128, 28)) return null;

  // 对角渐变底板
  const t = (x + y) / 256;
  let color = [
  Math.round(lerp(C_TOP[0], C_BLUE[0], t)),
  Math.round(lerp(C_TOP[1], C_BLUE[1], t)),
  Math.round(lerp(C_TOP[2], C_BLUE[2], t)),
  ];

  if (inHandle(x, y)) color = C_WHITE;
  if (inRoundRect(x, y, 26, 54, 76, 14, 7)) color = C_WHITE; // 箱盖
  if (inRoundRect(x, y, 30, 66, 68, 40, 9)) {
    color = C_WHITE; // 箱体
    if (showSeam && y >= 66 && y <= 68.4 &&
        ((x >= 32 && x <= 57) || (x >= 71 && x <= 96))) {
      color = C_SEAM; // 箱盖接缝
    }
    if (showDots) {
      if (inCircle(x, y, 48, 88, 5)) color = C_RED;
      else if (inCircle(x, y, 64, 88, 5)) color = C_YELLOW;
      else if (inCircle(x, y, 80, 88, 5)) color = C_GREEN;
    }
  }
  if (inRoundRect(x, y, 58, 62, 12, 14, 3)) color = C_BLUE; // 锁扣
  return color;
}

// 16px 专用加粗造型（直接在 16 单位坐标系设计，小尺寸下保证可辨）
function sample16(x, y) {
  if (!inRoundRect(x, y, 0, 0, 16, 16, 3.5)) return null;
  const t = (x + y) / 32;
  let color = [
    Math.round(lerp(C_TOP[0], C_BLUE[0], t)),
    Math.round(lerp(C_TOP[1], C_BLUE[1], t)),
    Math.round(lerp(C_TOP[2], C_BLUE[2], t)),
  ];

  // 提手：R 2.3，管粗 1.1
  if (y <= 7) {
    const d = Math.sqrt((x - 8) * (x - 8) + (y - 7) * (y - 7));
    if (Math.abs(d - 2.3) <= 0.55) color = C_WHITE;
  }
  if (y >= 7 && y <= 7.9 &&
      ((x >= 5.15 && x <= 6.25) || (x >= 9.75 && x <= 10.85))) color = C_WHITE;
  if (inRoundRect(x, y, 3, 7, 10, 2.3, 1.15)) color = C_WHITE; // 箱盖
  if (inRoundRect(x, y, 3.7, 9, 8.6, 4.6, 1.2)) color = C_WHITE; // 箱体
  if (inRoundRect(x, y, 7.2, 7.9, 1.6, 2, 0.45)) color = C_BLUE; // 锁扣
  return color;
}

// ---------- 超采样光栅化 ----------
function render(size) {
  const native16 = size === 16;
  const SS = native16 ? 8 : 4;
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
          const c = native16
            ? sample16(dx, dy)
            : sampleAt(dx * scale, dy * scale, showDots, showSeam);
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

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  // 每行前置 filter 0
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 输出 ----------
const outDir = path.join(__dirname, 'icons');
for (const size of [16, 48, 128]) {
  const png = encodePNG(render(size), size);
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`icons/icon${size}.png  ${png.length} bytes`);
}
