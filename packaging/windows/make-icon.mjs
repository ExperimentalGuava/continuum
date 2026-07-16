// Generate the Continuum app icon (continuum.ico) with no external tools.
//
// The mark: a rounded-square indigo tile with a white ring — the "continuum" loop
// (capture → segment → index → distill, cycling back) — and one amber node on the
// ring, a single highlighted moment on the timeline. Drawn directly to RGBA pixels
// with 4×4 supersampling for smooth edges, PNG-encoded in-process, and packed into a
// multi-resolution .ico. Run: node packaging/windows/make-icon.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Brand palette.
const INDIGO = [79, 70, 229];
const WHITE = [255, 255, 255];
const AMBER = [245, 158, 11];

// Geometry in a centered [-1,1] space (y down). Tuned to read at 16px.
const CORNER_R = 0.42;          // rounded-square corner radius
const RING_OUT = 0.66, RING_IN = 0.42;
const NODE_ANG = -0.7,          // radians; upper-right of the ring
  NODE_R = (RING_OUT + RING_IN) / 2,
  NODE_RAD = 0.17;

// Which shape a sub-sample belongs to (topmost wins), or null for transparent.
function colorAt(x, y) {
  // rounded-square membership (signed-distance to a box with rounded corners)
  const qx = Math.max(Math.abs(x) - (1 - CORNER_R), 0);
  const qy = Math.max(Math.abs(y) - (1 - CORNER_R), 0);
  const inTile = Math.hypot(qx, qy) - CORNER_R <= 0;
  if (!inTile) return null;

  const nx = NODE_R * Math.cos(NODE_ANG), ny = NODE_R * Math.sin(NODE_ANG);
  if (Math.hypot(x - nx, y - ny) <= NODE_RAD) return AMBER;

  const rad = Math.hypot(x, y);
  if (rad >= RING_IN && rad <= RING_OUT) return WHITE;

  return INDIGO;
}

// Render one size to a raw RGBA buffer with supersampled anti-aliasing.
function renderRGBA(size) {
  const SS = 4;                                   // 4×4 samples per pixel
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, opaque = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // sub-sample center → normalized [-1,1]
          const fx = (px + (sx + 0.5) / SS) / size * 2 - 1;
          const fy = (py + (sy + 0.5) / SS) / size * 2 - 1;
          const c = colorAt(fx, fy);
          if (c) { r += c[0]; g += c[1]; b += c[2]; opaque++; }
        }
      }
      const total = SS * SS;
      const o = (py * size + px) * 4;
      if (opaque === 0) { buf[o] = buf[o + 1] = buf[o + 2] = buf[o + 3] = 0; continue; }
      buf[o] = Math.round(r / opaque);            // average over covered samples only
      buf[o + 1] = Math.round(g / opaque);        // (keeps edges crisp, not darkened)
      buf[o + 2] = Math.round(b / opaque);
      buf[o + 3] = Math.round((opaque / total) * 255);
    }
  }
  return buf;
}

// --- minimal PNG encoder (RGBA, no filtering) ---------------------------------
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (~c) >>> 0; };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));                    // one filter byte per row
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                                      // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- ICO container (PNG-encoded entries) --------------------------------------
function buildICO(sizes) {
  const pngs = sizes.map((s) => ({ s, data: encodePNG(renderRGBA(s), s) }));
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { s, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;           // 0 means 256
    e[1] = s >= 256 ? 0 : s;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); offset += data.length;
  }
  return Buffer.concat([dir, ...entries, ...pngs.map((p) => p.data)]);
}

const ico = buildICO([256, 128, 64, 48, 32, 16]);
fs.writeFileSync(path.join(HERE, 'continuum.ico'), ico);
fs.writeFileSync(path.join(HERE, 'continuum-256.png'), encodePNG(renderRGBA(256), 256));
console.log(`wrote continuum.ico (${ico.length} bytes) + continuum-256.png`);
