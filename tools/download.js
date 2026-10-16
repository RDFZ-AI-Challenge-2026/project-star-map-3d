// tools/download.js — download a URL to a file with redirect following.
// Usage: node tools/download.js <url> <outFile>
const fs = require('fs');
const path = require('path');
const https = require('https');

const url = process.argv[2];
const out = process.argv[3];
if (!url || !out) {
  console.error('usage: node download.js <url> <outFile>');
  process.exit(2);
}

fs.mkdirSync(path.dirname(out), { recursive: true });

function get(u, depth) {
  if (depth > 8) {
    console.error('too many redirects');
    process.exit(1);
  }
  https
    .get(u, { timeout: 60000, headers: { 'user-agent': 'node-downloader' } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        const next = new URL(headers.location, u).toString();
        console.log(`redirect ${statusCode} -> ${next}`);
        res.resume();
        return get(next, depth + 1);
      }
      if (statusCode !== 200) {
        console.error(`HTTP ${statusCode} for ${u}`);
        res.resume();
        process.exit(1);
      }
      const total = Number(headers['content-length'] || 0);
      let got = 0;
      let lastTick = 0;
      const ws = fs.createWriteStream(out);
      res.on('data', (c) => {
        got += c.length;
        const now = Date.now();
        if (now - lastTick > 1500) {
          lastTick = now;
          if (total) {
            console.log(`  ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB (${((got / total) * 100).toFixed(0)}%)`);
          } else {
            console.log(`  ${(got / 1048576).toFixed(1)} MB`);
          }
        }
      });
      res.pipe(ws);
      ws.on('finish', () => {
        console.log(`saved ${out} (${(got / 1048576).toFixed(2)} MB)`);
        process.exit(0);
      });
      ws.on('error', (e) => {
        console.error('write error', e.message);
        process.exit(1);
      });
    })
    .on('timeout', function () {
      this.destroy(new Error('timeout'));
    })
    .on('error', (e) => {
      console.error('ERR', e.code || e.message, u);
      process.exit(1);
    });
}

get(url, 0);
