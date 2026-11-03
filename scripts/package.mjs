// Zips dist/ into release/skool-vi-subtitles-v<version>.zip (uses the system `zip`, falls back to a minimal writer).
import { readFileSync, mkdirSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, relative, join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
mkdirSync(resolve(root, 'release'), { recursive: true });
const zipPath = resolve(root, 'release', `skool-vi-subtitles-v${version}.zip`);
rmSync(zipPath, { force: true });

const files = [];
(function walk(d) {
  for (const f of readdirSync(d).sort()) {
    const p = join(d, f);
    statSync(p).isDirectory() ? walk(p) : files.push(p);
  }
})(dist);

try {
  execFileSync('zip', ['-q', '-X', '-r', zipPath, '.'], { cwd: dist });
} catch {
  const local = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(relative(dist, f).split('\\').join('/'));
    const data = readFileSync(f);
    const comp = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
    local.push(h, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(zipPath, Buffer.concat([...local, cd, end]));
}
console.log(`✓ ${files.length} files → ${relative(root, zipPath)}`);
