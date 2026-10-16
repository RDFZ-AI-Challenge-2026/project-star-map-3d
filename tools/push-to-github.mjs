#!/usr/bin/env node
/**
 * push-to-github.mjs — publish this project to GitHub **without git installed**.
 *
 * It talks to the GitHub REST API directly and creates ONE commit containing
 * every file (blobs -> tree -> commit -> ref), instead of one commit per file.
 *
 * Usage (PowerShell):
 *   $env:GITHUB_TOKEN = "ghp_xxx"                  # a token with the "repo" scope
 *   node tools/push-to-github.mjs --repo project-star-map-3d --public
 *
 * Optional flags:
 *   --repo <name>      repository name                (default: project-star-map-3d)
 *   --owner <login>    user or org to own the repo    (default: whoever the token belongs to)
 *   --branch <name>    branch to write                (default: main)
 *   --message <text>   commit message
 *   --public           create a public repo           (default: private)
 *   --delete <path>    delete a path in this commit   (repeatable)
 *   --enable-pages     turn on GitHub Pages (source = GitHub Actions)
 *   --dry-run          list what would be uploaded, upload nothing
 *
 * Never commit the token, and prefer a fine-grained token limited to this repo.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFiles as collect } from './collect-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const has = (name) => argv.includes(name);

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const REPO = flag('--repo', 'project-star-map-3d');
const OWNER = flag('--owner', null);
const BRANCH = flag('--branch', 'main');
const PUBLIC = has('--public');
const DRY = has('--dry-run');
// --delete <path>（可重复）：在同一个 commit 里删掉仓库里的文件。
// 用于清理误提交的东西，例如网页上传时丢了开头那个点、变成不起作用的 "gitignore"。
const DELETES = argv.reduce((acc, a, i) => (a === '--delete' && argv[i + 1] ? acc.concat(argv[i + 1]) : acc), []);
const MESSAGE =
  flag('--message') ||
  'Real 3D star map: HYG distances, glowing stars calibrated by apparent magnitude';

if (!TOKEN && !DRY) {
  console.error('Missing GITHUB_TOKEN.\n' +
    '  PowerShell:  $env:GITHUB_TOKEN = "ghp_..."\n' +
    '  Create one at https://github.com/settings/tokens (scope: repo), or a fine-grained\n' +
    '  token with "Contents: read and write" + "Administration: read and write" on the repo.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// which files belong in the repo — shared with stage-upload.mjs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GitHub API helper
// ---------------------------------------------------------------------------
async function api(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'star-map-publisher',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const { files, skipped } = collect(ROOT);
const totalMB = files.reduce((a, f) => a + f.size, 0) / 1048576;

console.log(`project root : ${ROOT}`);
console.log(`files to send: ${files.length}  (${totalMB.toFixed(2)} MB)`);
if (skipped.length) {
  console.log(`skipped      : ${skipped.length}`);
  for (const s of skipped.slice(0, 20)) console.log(`   - ${s}`);
  if (skipped.length > 20) console.log(`   ... and ${skipped.length - 20} more`);
}
if (DRY) {
  console.log('\n--dry-run: nothing uploaded. Files that WOULD be sent:');
  for (const f of files) console.log(`   ${(f.size / 1024).toFixed(1).padStart(8)} KB  ${f.rel}`);
  process.exit(0);
}

const who = await api('GET', '/user');
if (!who.ok) {
  console.error(`token check failed: HTTP ${who.status} ${who.text.slice(0, 200)}`);
  process.exit(1);
}
const owner = OWNER || who.json.login;
console.log(`\nauthenticated as ${who.json.login}, target repo ${owner}/${REPO}`);

// 1. 目标仓库：存在就用它，不存在才创建。
//    注意不能无脑 POST /user/repos —— 那是"建到我自己的账号下"，
//    往组织仓库推的时候会凭空多出一个同名个人仓库。
let baseTree = null;
const existing = await api('GET', `/repos/${owner}/${REPO}`);
if (existing.ok) {
  console.log(`repo exists: ${existing.json.full_name} (${existing.json.private ? 'private' : 'public'}, default ${existing.json.default_branch})`);
} else if (existing.status === 404) {
  const endpoint = (OWNER && OWNER !== who.json.login) ? `/orgs/${OWNER}/repos` : '/user/repos';
  const create = await api('POST', endpoint, {
    name: REPO,
    description: 'Interactive 3D star map: nearby stars at their real distances (HYG catalogue)',
    private: !PUBLIC,
    has_issues: true,
    auto_init: false,
  });
  if (create.ok) {
    console.log(`created ${create.json.private ? 'private' : 'public'} repo ${create.json.full_name}`);
  } else {
    console.error(`could not create repo at ${endpoint}: HTTP ${create.status} ${create.text.slice(0, 300)}`);
    process.exit(1);
  }
} else {
  console.error(`could not read repo ${owner}/${REPO}: HTTP ${existing.status} ${existing.text.slice(0, 200)}`);
  process.exit(1);
}

// 2. current branch tip, if any
let parentSha = null;
const ref = await api('GET', `/repos/${owner}/${REPO}/git/ref/heads/${BRANCH}`);
if (ref.ok) {
  parentSha = ref.json.object.sha;
  const commit = await api('GET', `/repos/${owner}/${REPO}/git/commits/${parentSha}`);
  baseTree = commit.json?.tree?.sha ?? null;
  console.log(`existing ${BRANCH} tip ${parentSha.slice(0, 7)} (incremental update)`);
} else {
  console.log(`no ${BRANCH} branch yet — this will be the first commit`);
}

// 3. blobs
const tree = [];
let done = 0;
for (const f of files) {
  const content = fs.readFileSync(f.abs).toString('base64');
  const blob = await api('POST', `/repos/${owner}/${REPO}/git/blobs`, { content, encoding: 'base64' });
  if (!blob.ok) {
    console.error(`blob failed for ${f.rel}: HTTP ${blob.status} ${blob.text.slice(0, 200)}`);
    process.exit(1);
  }
  tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.json.sha });
  done++;
  if (done % 10 === 0 || done === files.length) console.log(`  uploaded ${done}/${files.length}`);
}

// 4. tree + commit
// sha: null 是 GitHub trees API 表示"删除这个路径"的写法
for (const p of DELETES) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
if (DELETES.length) console.log(`deleting ${DELETES.length} path(s): ${DELETES.join(', ')}`);
const treeRes = await api('POST', `/repos/${owner}/${REPO}/git/trees`, baseTree ? { base_tree: baseTree, tree } : { tree });
if (!treeRes.ok) {
  console.error(`tree failed: HTTP ${treeRes.status} ${treeRes.text.slice(0, 300)}`);
  process.exit(1);
}
const commitRes = await api('POST', `/repos/${owner}/${REPO}/git/commits`, {
  message: MESSAGE,
  tree: treeRes.json.sha,
  parents: parentSha ? [parentSha] : [],
});
if (!commitRes.ok) {
  // 往 .github/workflows/ 写文件时，GitHub 额外要求 token 带 workflow 权限。
  // 这个报错信息很隐晦，单独解释一下。
  if (/workflow/i.test(commitRes.text)) {
    console.error(`\ncommit failed: HTTP ${commitRes.status}`);
    console.error('GitHub 拒绝了这次提交，因为里面有 .github/workflows/ 下的文件。');
    console.error('token 需要额外权限：');
    console.error('  classic token    -> 同时勾选 repo 和 workflow');
    console.error('  fine-grained     -> Contents: read and write + Workflows: read and write');
    console.error('或者用 --no-workflow 跳过 .github/ 目录（Pages 就得在网页上手动开）。');
    process.exit(1);
  }
  console.error(`commit failed: HTTP ${commitRes.status} ${commitRes.text.slice(0, 300)}`);
  process.exit(1);
}

// 5. move the branch
if (parentSha) {
  const upd = await api('PATCH', `/repos/${owner}/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: commitRes.json.sha,
    force: false,
  });
  if (!upd.ok) {
    console.error(`ref update failed: HTTP ${upd.status} ${upd.text.slice(0, 300)}`);
    process.exit(1);
  }
} else {
  const mk = await api('POST', `/repos/${owner}/${REPO}/git/refs`, {
    ref: `refs/heads/${BRANCH}`,
    sha: commitRes.json.sha,
  });
  if (!mk.ok) {
    console.error(`ref create failed: HTTP ${mk.status} ${mk.text.slice(0, 300)}`);
    process.exit(1);
  }
}

console.log(`\ndone. commit ${commitRes.json.sha.slice(0, 7)} on ${BRANCH}`);
console.log(`repo    https://github.com/${owner}/${REPO}`);

// 6. 可选：启用 Pages。
//    用 API 而不是让人去点 Settings —— github.com 网页常常打不开，
//    而 api.github.com 是通的。
if (has('--enable-pages')) {
  const pg = await api('POST', `/repos/${owner}/${REPO}/pages`, { build_type: 'workflow' });
  if (pg.ok) {
    console.log(`Pages enabled, source = GitHub Actions`);
  } else if (pg.status === 409) {
    console.log(`Pages already enabled`);
  } else {
    console.log(`could not enable Pages: HTTP ${pg.status} ${pg.text.slice(0, 200)}`);
    console.log(`  -> 需要 token 带 "Pages: read and write"（fine-grained）或 repo（classic）`);
  }
}

console.log(`\nSite (after the workflow finishes): https://${owner.toLowerCase()}.github.io/${REPO}/`);
console.log(`Watch the build: https://github.com/${owner}/${REPO}/actions`);
