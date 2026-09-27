/**
 * Draw the application icon.
 *
 * A script rather than a binary somebody once exported, so the icon can be regenerated,
 * reviewed as a diff, and changed without opening a graphics program. It writes a plain
 * PNG with no dependencies: Node can deflate, and the rest of the format is a header, a
 * pixel block and four checksums.
 *
 *   node apps/desktop/scripts/make-icon.mjs
 *
 * electron-builder turns this into the .ico Windows wants at packaging time, so this is
 * the only source of the icon.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
/** The application's own background and accent, from the renderer stylesheet. */
const BACKGROUND = [0x1b, 0x1b, 0x1f];
const ACCENT = [0x6c, 0x8c, 0xff];
const RADIUS = 96;

/** Distance from a point to a line segment, for drawing a stroke of real thickness. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** How far inside the rounded square a point is, in pixels. Negative is outside. */
function insideRoundedSquare(x, y) {
  const qx = Math.abs(x - SIZE / 2) - (SIZE / 2 - RADIUS);
  const qy = Math.abs(y - SIZE / 2) - (SIZE / 2 - RADIUS);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return RADIUS - (outside + Math.min(Math.max(qx, qy), 0));
}

/** A K: one upright, two diagonals meeting it. */
function glyphCoverage(x, y) {
  const stroke = 30;
  const top = 150;
  const bottom = SIZE - 150;
  const middle = SIZE / 2;
  const left = 176;
  const right = 352;
  const distance = Math.min(
    distanceToSegment(x, y, left, top, left, bottom),
    distanceToSegment(x, y, left + stroke / 2, middle, right, top),
    distanceToSegment(x, y, left + stroke / 2, middle, right, bottom),
  );
  // One pixel of feathering, so the edges are not jagged at small sizes.
  return Math.max(0, Math.min(1, stroke / 2 - distance + 0.5));
}

const pixels = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let at = 0;
for (let y = 0; y < SIZE; y++) {
  pixels[at++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const cx = x + 0.5;
    const cy = y + 0.5;
    const alpha = Math.max(0, Math.min(1, insideRoundedSquare(cx, cy) + 0.5));
    const ink = glyphCoverage(cx, cy);
    for (let channel = 0; channel < 3; channel++) {
      pixels[at++] = Math.round(BACKGROUND[channel] * (1 - ink) + ACCENT[channel] * ink);
    }
    pixels[at++] = Math.round(alpha * 255);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // colour type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(pixels, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'icon.png'), png);
console.log(`wrote ${join(out, 'icon.png')} (${String(png.length)} bytes, ${String(SIZE)}px)`);
