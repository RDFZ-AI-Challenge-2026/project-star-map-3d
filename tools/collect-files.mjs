// tools/collect-files.mjs — decide which files belong in the repository.
//
// Shared by push-to-github.mjs (API upload) and stage-upload.mjs (web-UI
// preparation) so the two routes can never disagree about what belongs in the
// repo, and so neither has to shell out to the other (the sandbox forbids
// capturing a child process's piped output).

import fs from 'node:fs';
import path from 'node:path';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Only the pattern kinds this project's .gitignore actually uses.
function buildIgnoreMatcher(root) {
  const file = path.join(root, '.gitignore');
  const rules = [];
  if (fs.existsSync(file)) {
    for (let line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const re = line.includes('*')
        ? new RegExp('^' + line.split('*').map(escapeRe).join('[^/]*') + '$')
        : new RegExp('^' + escapeRe(line) + '$');
      rules.push({ re, dirOnly, raw: line });
    }
  }
  return (relPosix, isDir) => {
    for (const r of rules) {
      if (r.dirOnly && !isDir && !relPosix.startsWith(r.raw + '/')) continue;
      if (r.re.test(relPosix)) return true;
      if (r.dirOnly && relPosix.startsWith(r.raw + '/')) return true;
      if (!r.dirOnly && relPosix.startsWith(r.raw + '/')) return true;
    }
    return false;
  };
}

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
const MAX_FILE = 45 * 1024 * 1024;

export function collectFiles(root) {
  const ignored = buildIgnoreMatcher(root);
  const out = [];
  const skipped = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (ALWAYS_SKIP.has(entry.name)) { skipped.push(rel + ' (always skipped)'); continue; }
      if (ignored(rel, entry.isDirectory())) { skipped.push(rel + ' (.gitignore)'); continue; }
      if (entry.isDirectory()) { walk(abs); continue; }
      const st = fs.statSync(abs);
      if (st.size > MAX_FILE) {
        skipped.push(`${rel} (${(st.size / 1048576).toFixed(1)} MB, too large)`);
        continue;
      }
      out.push({ rel, abs, size: st.size });
    }
  })(root);
  return { files: out.sort((a, b) => a.rel.localeCompare(b.rel)), skipped };
}
