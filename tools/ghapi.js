// tools/ghapi.js — list a GitHub repo path via the REST API (github.com works here).
// Usage: node tools/ghapi.js <owner/repo> [path]
const https = require('https');

const repo = process.argv[2];
const p = process.argv[3] || '';
const url = `https://api.github.com/repos/${repo}/contents/${p}`;

https
  .get(url, { headers: { 'user-agent': 'node', accept: 'application/vnd.github+json' }, timeout: 30000 }, (r) => {
    let b = '';
    r.on('data', (c) => (b += c));
    r.on('end', () => {
      if (r.statusCode !== 200) {
        console.log('HTTP', r.statusCode, b.slice(0, 300));
        return;
      }
      const j = JSON.parse(b);
      const arr = Array.isArray(j) ? j : [j];
      for (const e of arr) {
        console.log(`${e.type}\t${((e.size || 0) / 1048576).toFixed(2)} MB\t${e.path}\t${e.download_url || ''}`);
      }
    });
  })
  .on('error', (e) => console.log('ERR', e.code || e.message))
  .on('timeout', function () {
    this.destroy();
    console.log('TIMEOUT');
  });
