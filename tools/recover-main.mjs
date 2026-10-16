// tools/recover-main.mjs — rebuild web/main.js by replaying the write/edit tool
// calls recorded in a DSH session log. Used after an encoding accident corrupted
// the file: the log is the authoritative history of every change.
//
// Usage: node tools/recover-main.mjs <session.v4.jsonl.zstd> <outFile> [targetBasename]

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const [, , logPath, outFile, target = 'main.js'] = process.argv;
if (!logPath || !outFile) {
  console.error('usage: node recover-main.mjs <session.v4.jsonl.zstd> <outFile> [basename]');
  process.exit(2);
}

// ---- read every zstd frame in the log -------------------------------------
const buf = fs.readFileSync(logPath);
const offsets = [];
for (let i = 0; i < buf.length - 3; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i);
}
let all = '';
for (let k = 0; k < offsets.length; k++) {
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
  try { all += zlib.zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8'); } catch { /* skip */ }
}

// ---- collect tool calls in order ------------------------------------------
const events = [];
for (const line of all.split('\n')) {
  if (!line) continue;
  let j;
  try { j = JSON.parse(line); } catch { continue; }
  if (j.type === 'tool/call' && j.data?.name) events.push({ seq: j.seq, ...j.data });
}
events.sort((a, b) => a.seq - b.seq);

const base = (p) => String(p || '').split(/[\\/]/).pop();
let content = null;
let applied = 0;
const problems = [];

for (const ev of events) {
  let args;
  try { args = JSON.parse(ev.arguments); } catch { continue; }
  if (base(args.file_path) !== target) continue;

  if (ev.name === 'write') {
    content = args.content;
    applied++;
    console.log(`seq ${ev.seq}: write (${content.length} chars)`);
  } else if (ev.name === 'edit') {
    if (content === null) { problems.push(`seq ${ev.seq}: edit before any write`); continue; }
    const { old_string: o, new_string: n, replace_all: ra } = args;
    const hits = content.split(o).length - 1;
    if (hits === 0) { problems.push(`seq ${ev.seq}: old_string not found`); continue; }
    if (hits > 1 && !ra) { problems.push(`seq ${ev.seq}: old_string matched ${hits}x`); continue; }
    content = ra ? content.split(o).join(n) : content.replace(o, n);
    applied++;
  }
}

if (content === null) {
  console.error('no write call found for', target);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, content, 'utf8');
console.log(`\nreplayed ${applied} operations -> ${outFile} (${content.length} chars)`);
if (problems.length) {
  console.log(`\n${problems.length} problems encountered:`);
  for (const p of problems) console.log('  -', p);
  process.exit(3);
}
console.log('every edit applied cleanly.');
