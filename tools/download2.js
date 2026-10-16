// tools/download2.js — resumable downloader with stall detection.
// Usage: node tools/download2.js <url> <outFile> [maxAttempts]
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const url = process.argv[2];
const out = process.argv[3];
const maxAttempts = Number(process.argv[4] || 30);
if (!url || !out) {
  console.error('usage: node download2.js <url> <outFile> [maxAttempts]');
  process.exit(2);
}
fs.mkdirSync(path.dirname(out), { recursive: true });

const STALL_MS = 25000;

function attempt(n) {
  const have = fs.existsSync(out) ? fs.statSync(out).size : 0;
  const headers = { 'user-agent': 'Mozilla/5.0 (node-downloader)' };
  if (have > 0) headers.range = `bytes=${have}-`;

  const req = https.get(url, { headers, timeout: 60000 }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      const next = new URL(res.headers.location, url).toString();
      console.log(`[${n}] redirect -> ${next.slice(0, 90)}`);
      url = next;
      return attempt(n);
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      console.error(`[${n}] HTTP ${res.statusCode}`);
      res.resume();
      return retry(n, `HTTP ${res.statusCode}`);
    }
    const appending = res.statusCode === 206 && have > 0;
    if (have > 0 && !appending) console.log(`[${n}] server ignores Range, restarting from 0`);
    const total = appending ? have + Number(res.headers['content-length'] || 0) : Number(res.headers['content-length'] || 0);
    let got = appending ? have : 0;
    const ws = fs.createWriteStream(out, appending ? { flags: 'a' } : {});
    let lastData = Date.now();
    const stall = setInterval(() => {
      if (Date.now() - lastData > STALL_MS) {
        clearInterval(stall);
        console.log(`[${n}] stalled at ${(got / 1048576).toFixed(2)} MB, reconnecting...`);
        res.destroy();
      }
    }, 3000);

    res.on('data', (c) => {
      got += c.length;
      lastData = Date.now();
    });
    res.pipe(ws);
    ws.on('finish', () => {
      clearInterval(stall);
      const size = fs.statSync(out).size;
      if (total && size < total) return retry(n, `incomplete ${size}/${total}`);
      console.log(`DONE ${out} (${(size / 1048576).toFixed(2)} MB)`);
      process.exit(0);
    });
    ws.on('error', (e) => {
      clearInterval(stall);
      retry(n, 'write ' + e.message);
    });
    res.on('error', () => {
      clearInterval(stall);
      try { ws.end(); } catch (_) {}
      retry(n, 'stream error');
    });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (e) => retry(n, e.code || e.message));
}

function retry(n, why) {
  if (n >= maxAttempts) {
    console.error(`giving up after ${n} attempts (${why})`);
    process.exit(1);
  }
  console.log(`[${n}] ${why} -> retry ${n + 1}`);
  setTimeout(() => attempt(n + 1), 1500);
}

attempt(1);
