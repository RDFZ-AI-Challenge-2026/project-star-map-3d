// tools/ghblob.js — download one file from a GitHub repo via the git trees + blobs API.
// Avoids raw.githubusercontent.com (blocked here) and the contents API path quirks.
// Usage: node tools/ghblob.js <owner/repo> <branch> <nameSubstring> <outFile>
const fs = require('fs');
const path = require('path');
const https = require('https');

const [repo, branch, needle, out] = process.argv.slice(2);
if (!repo || !branch || !needle || !out) {
  console.error('usage: node ghblob.js <owner/repo> <branch> <nameSubstring> <outFile>');
  process.exit(2);
}

function api(url, accept, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          timeout: 180000,
          headers: { 'user-agent': 'node', accept, 'X-GitHub-Api-Version': '2022-11-28' },
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirects > 6) return reject(new Error('too many redirects'));
            const next = new URL(res.headers.location, url).toString();
            return resolve(api(next, accept, redirects + 1));
          }
          resolve(res);
        }
      )
      .on('error', reject)
      .on('timeout', function () {
        this.destroy(new Error('timeout'));
      });
  });
}

function text(res) {
  return new Promise((resolve, reject) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => resolve(b));
    res.on('error', reject);
  });
}

(async () => {
  const treeRes = await api(
    `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
    'application/vnd.github+json'
  );
  const tree = JSON.parse(await text(treeRes));
  if (!tree.tree) {
    console.error('no tree', JSON.stringify(tree).slice(0, 300));
    process.exit(1);
  }
  const hits = tree.tree.filter((e) => e.path.includes(needle));
  console.log(`tree entries: ${tree.tree.length}, truncated: ${tree.truncated}, matches for "${needle}":`);
  for (const h of hits) console.log(`  ${h.type}\t${((h.size || 0) / 1048576).toFixed(2)} MB\t${h.path}\t${h.sha}`);
  if (!hits.length) process.exit(1);

  const target = hits[hits.length - 1];
  console.log('downloading blob', target.sha, target.path, `(${((target.size || 0) / 1048576).toFixed(2)} MB)`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const blobRes = await api(
    `https://api.github.com/repos/${repo}/git/blobs/${target.sha}`,
    'application/vnd.github.raw'
  );
  if (blobRes.statusCode !== 200) {
    console.error('blob HTTP', blobRes.statusCode, (await text(blobRes)).slice(0, 300));
    process.exit(1);
  }
  const total = Number(blobRes.headers['content-length'] || 0);
  let got = 0;
  let last = 0;
  const ws = fs.createWriteStream(out);
  blobRes.on('data', (c) => {
    got += c.length;
    if (Date.now() - last > 2000) {
      last = Date.now();
      console.log(`  ${(got / 1048576).toFixed(1)}${total ? ' / ' + (total / 1048576).toFixed(1) : ''} MB`);
    }
  });
  blobRes.pipe(ws);
  ws.on('finish', () => console.log(`saved ${out} (${(got / 1048576).toFixed(2)} MB)`));
  ws.on('error', (e) => {
    console.error('write error', e.message);
    process.exit(1);
  });
})();
