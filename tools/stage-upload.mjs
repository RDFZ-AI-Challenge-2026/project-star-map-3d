// tools/stage-upload.mjs — copy exactly the files that belong in the repository
// into a clean folder, for uploading through the GitHub web UI.
//
// Why this exists: the project folder also holds things that must NOT be
// committed — star-map-site/ and star-map-site.zip are copies of web/, and
// data/raw/ holds re-downloadable archives. Dragging the whole project folder
// into github.com/.../upload would publish all of it. The file list comes from
// collect-files.mjs, the same module the API publisher uses, so the two routes
// can never disagree about what belongs in the repo.
//
// Usage: node tools/stage-upload.mjs [outDir]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFiles } from './collect-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '..', 'github-upload-fresh'));

const { files } = collectFiles(ROOT);
if (!files.length) {
  console.error('no files found — is .gitignore excluding everything?');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
let bytes = 0;
for (const f of files) {
  const dst = path.join(OUT, f.rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(f.abs, dst);
  bytes += f.size;
}

// The how-to sits NEXT TO the folder, not inside it: inside, it would be picked
// up by Ctrl+A and uploaded as a stray file in the repository root.
fs.writeFileSync(OUT + '-HOWTO.txt',
  `GitHub web upload — how to use ${path.basename(OUT)}\r\n` +
  '='.repeat(52) + '\r\n\r\n' +
  '1. Open the repository upload page and make sure you are at the ROOT\r\n' +
  '   (it should say you are adding files to project-star-map-3d,\r\n' +
  '    NOT inside a subfolder).\r\n' +
  '2. Open the folder, then select EVERYTHING in it — including the hidden\r\n' +
  '   .github and .gitignore. In Explorer: View tab -> tick "Hidden items",\r\n' +
  '   then Ctrl+A. There is nothing in there that must not be uploaded.\r\n' +
  '3. Drag the selection onto the page.\r\n' +
  '4. Do NOT drag the folder itself — that would nest everything one level\r\n' +
  '   too deep and the site would end up at /project-star-map-3d/web/...\r\n' +
  '5. Commit. GitHub Actions then publishes web/ to GitHub Pages.\r\n\r\n' +
  'Regenerate after any change to the project:\r\n' +
  '    node tools/stage-upload.mjs\r\n',
  'utf8');

const top = [...new Set(files.map((f) => f.rel.split('/')[0]))];
console.log(`${files.length} files  (${(bytes / 1048576).toFixed(2)} MB)  ->  ${OUT}`);
console.log(`top level: ${top.join('  ')}`);
