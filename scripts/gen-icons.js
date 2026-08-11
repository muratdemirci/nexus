/**
 * NEXUS - Generates PWA icons (pure Node, no deps).
 * Creates public/icons/icon-192.png and icon-512.png.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePNG(width, height, pixelFn) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Nexus tile: dark rounded square + teal accent glyph area
function nexusIcon(size) {
  const bg = [10, 14, 20, 255];
  const accent = [76, 201, 240, 255];
  const x0 = size * 0.18, x1 = size * 0.82;
  const y0 = size * 0.18, y1 = size * 0.82;
  const r = size * 0.10;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2 - r, hh = (y1 - y0) / 2 - r;

  return encodePNG(size, size, (x, y) => {
    const qx = Math.abs(x + 0.5 - cx) - hw;
    const qy = Math.abs(y + 0.5 - cy) - hh;
    const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    if (dist > 0) return bg;
    // left + right thick bars of an "N"
    const bars = size * 0.18;
    const rel = (x - x0) / (x1 - x0);
    if (rel < 0.22 || rel > 0.78) return accent;
    // diagonal band: map to a sloped middle stroke
    const diagW = hw * 0.24;
    const mid = 0.5 + (y - cy) / (y1 - y0) * 0.5 - 0.25;
    const dd = Math.abs(rel - mid);
    return dd < diagW * 0.32 ? accent : bg;
  });
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, nexusIcon(size));
  console.log(`✓ ${file} (${fs.statSync(file).size} bytes)`);
}