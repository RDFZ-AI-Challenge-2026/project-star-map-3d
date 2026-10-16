// tools/ghtree.js — dump a repo's full recursive tree (path, size, sha)
const https = require('https');
const repo = process.argv[2];
const branch = process.argv[3] || 'main';

https
  .get(
    `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
    { headers: { 'user-agent': 'node', accept: 'application/vnd.github+json' }, timeout: 60000 },
    (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => {
        const j = JSON.parse(b);
        if (!j.tree) return console.log('HTTP', r.statusCode, b.slice(0, 300));
        console.log(`entries: ${j.tree.length} truncated: ${j.truncated}`);
        for (const e of j.tree) {
          console.log(`${e.type}\t${e.size != null ? (e.size / 1048576).toFixed(2) + ' MB' : '-'}\t${e.path}\t${e.sha}`);
        }
      });
    }
  )
  .on('error', (e) => console.log('ERR', e.code || e.message));
