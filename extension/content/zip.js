/* Trình tạo file ZIP tối giản (phương thức STORE, tên file UTF-8). Không cần thư viện ngoài. */
(function (root) {
  const NS = (root.SkoolExp = root.SkoolExp || {});

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosTime(d) {
    return {
      time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
      date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
    };
  }

  class ZipWriter {
    constructor() { this.files = []; this.enc = new TextEncoder(); }

    add(path, data) {
      const bytes = typeof data === 'string' ? this.enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
      this.files.push({ path: path.replace(/^\/+/, ''), bytes });
    }

    has(path) { return this.files.some((f) => f.path === path); }

    /** @returns {Uint8Array} */
    build() {
      const now = dosTime(new Date());
      const chunks = [];
      const central = [];
      let offset = 0;
      for (const f of this.files) {
        const name = this.enc.encode(f.path);
        const crc = crc32(f.bytes);
        const size = f.bytes.length;
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true); // UTF-8
        local.setUint16(8, 0, true); // store
        local.setUint16(10, now.time, true);
        local.setUint16(12, now.date, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, size, true);
        local.setUint32(22, size, true);
        local.setUint16(26, name.length, true);
        local.setUint16(28, 0, true);
        chunks.push(new Uint8Array(local.buffer), name, f.bytes);

        const cen = new DataView(new ArrayBuffer(46));
        cen.setUint32(0, 0x02014b50, true);
        cen.setUint16(4, 20, true);
        cen.setUint16(6, 20, true);
        cen.setUint16(8, 0x0800, true);
        cen.setUint16(10, 0, true);
        cen.setUint16(12, now.time, true);
        cen.setUint16(14, now.date, true);
        cen.setUint32(16, crc, true);
        cen.setUint32(20, size, true);
        cen.setUint32(24, size, true);
        cen.setUint16(28, name.length, true);
        cen.setUint16(30, 0, true);
        cen.setUint16(32, 0, true);
        cen.setUint16(34, 0, true);
        cen.setUint16(36, 0, true);
        cen.setUint32(38, 0, true);
        cen.setUint32(42, offset, true);
        central.push(new Uint8Array(cen.buffer), name);
        offset += 30 + name.length + size;
      }
      const cenSize = central.reduce((s, c) => s + c.length, 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, this.files.length, true);
      end.setUint16(10, this.files.length, true);
      end.setUint32(12, cenSize, true);
      end.setUint32(16, offset, true);
      const all = chunks.concat(central, [new Uint8Array(end.buffer)]);
      const total = all.reduce((s, c) => s + c.length, 0);
      const out = new Uint8Array(total);
      let p = 0;
      for (const c of all) { out.set(c, p); p += c.length; }
      return out;
    }
  }

  NS.ZipWriter = ZipWriter;
  NS.crc32 = crc32;
})(typeof window !== 'undefined' ? window : globalThis);
