// tools/zip-site.mjs — package web/ into a deployable zip.
//
// Why not Compress-Archive: on Windows PowerShell it writes entry names with
// backslashes ("data\nearby50.json"). A zip is supposed to use forward slashes,
// and extractors on Linux (and Netlify / Vercel / Cloudflare) then either fail
// or produce files literally named "data\nearby50.json". So we write the zip
// ourselves — it is a small, well-specified format.
//
// Usage: node tools/zip-site.mjs <out.zip> [--list]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'web');

const outArg = process.argv[2] || path.join(ROOT, '..', 'star-map-site.zip');
const OUT = path.resolve(outArg);
const LIST_ONLY = process.argv.includes('--list');

// ---- collect files, paths always in posix form -----------------------------
function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${e.name}` : e.name;      // forward slash, always
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, rel));
    else if (e.isFile()) out.push({ rel, abs, size: fs.statSync(abs).size });
  }
  return out;
}

const files = walk(SRC);

// ---- crc32 ------------------------------------------------------------------
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
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---- write the archive ------------------------------------------------------
const locals = [];
const central = [];
let offset = 0;

for (const f of files) {
  const raw = fs.readFileSync(f.abs);
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  // 压缩后反而更大就用 stored（method 0），否则 deflate（method 8）
  const useDeflate = deflated.length < raw.length;
  const data = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const nameBuf = Buffer.from(f.rel, 'utf8');
  const crc = crc32(raw);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);      // local file header signature
  lh.writeUInt16LE(20, 4);              // version needed
  lh.writeUInt16LE(0x0800, 6);          // flags: UTF-8 names
  lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(0, 10);              // mod time
  lh.writeUInt16LE(0x2821, 12);         // mod date (2000-01-01)
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(data.length, 18);
  lh.writeUInt32LE(raw.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);              // extra length
  locals.push(lh, nameBuf, data);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);      // central directory signature
  ch.writeUInt16LE(20, 4);              // version made by
  ch.writeUInt16LE(20, 6);              // version needed
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(method, 10);
  ch.writeUInt16LE(0, 12);
  ch.writeUInt16LE(0x2821, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(data.length, 20);
  ch.writeUInt32LE(raw.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30);              // extra
  ch.writeUInt16LE(0, 32);              // comment
  ch.writeUInt16LE(0, 34);              // disk number
  ch.writeUInt32LE(0, 36);              // internal attrs
  // 33188 = 0o100644，左移 16 位表示"普通文件"。
  // 注意不能用 0o100644 << 16：JS 的位运算是 32 位有符号的，结果会变成负数。
  ch.writeUInt32LE(33188 * 65536, 38);  // external attrs: regular file
  ch.writeUInt32LE(offset, 42);
  central.push(ch, nameBuf);

  offset += lh.length + nameBuf.length + data.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

if (LIST_ONLY) {
  console.log('entries (all posix paths):');
  for (const f of files) console.log(`  ${String(f.size).padStart(9)}  ${f.rel}`);
  process.exit(0);
}

fs.writeFileSync(OUT, Buffer.concat([...locals, centralBuf, end]));
const total = fs.statSync(OUT).size;
console.log(`${files.length} files -> ${OUT}`);
console.log(`${(total / 1048576).toFixed(2)} MB (from ${(files.reduce((a, f) => a + f.size, 0) / 1048576).toFixed(2)} MB raw)`);
