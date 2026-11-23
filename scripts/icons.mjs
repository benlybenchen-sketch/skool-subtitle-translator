// Generates simple PNG icons (no image libraries): blue rounded square with two subtitle bars.
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

function png(size) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.2;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const fx = x + 0.5, fy = y + 0.5;
      let c = [0, 0, 0, 0];
      if (inRounded(fx, fy)) {
        c = [31, 111, 235, 255];
        const bar = (top, h, l, rr, col) => fy >= size * top && fy < size * (top + h) && fx >= size * l && fx < size * rr && (c = col);
        bar(0.56, 0.11, 0.18, 0.82, [255, 255, 255, 255]);
        bar(0.73, 0.1, 0.3, 0.7, [255, 214, 10, 255]);
        // "play" triangle
        const tx = (fx - size * 0.38) / (size * 0.26), ty = (fy - size * 0.16) / (size * 0.3);
        if (tx >= 0 && tx <= 1 && ty >= 0 && ty <= 1 && Math.abs(ty - 0.5) <= (1 - tx) * 0.5) c = [255, 255, 255, 255];
      }
      px.set(c, o);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
}

const out = process.argv[2] ?? 'public/icons';
mkdirSync(out, { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`${out}/icon${s}.png`, png(s));
console.log('icons written to', out);
