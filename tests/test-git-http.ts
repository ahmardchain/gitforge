// Tests for src/git-http.ts, driven by the REAL git CLI over HTTP.
// Run: ~/.local/node22/bin/node --experimental-strip-types tests/test-git-http.ts
//
// Spins up a node:http server wrapping only handleGit with a fresh Store,
// seeds repos directly in the store, and drives it with `git clone`,
// `git fetch`, `git push` and `git ls-remote` against http://127.0.0.1:PORT.
//
// NOTE: git is run with async `spawn`, never spawnSync — the HTTP server
// under test lives on this process's event loop, so a synchronous wait
// would deadlock (git's requests could never be answered while git waits).

process.env.MAKEFUN_SHOP_TOKEN = 'test-token';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Store } = await import('../src/store.ts');
const { handleGit } = await import('../src/git-http.ts');

const OWNER = 'adaiversen';
const TMP = mkdtempSync(join(tmpdir(), 'gitforge-git-http-'));
const HOME = join(TMP, 'home');
mkdirSync(HOME, { recursive: true });
const GIT_ENV = {
  ...process.env,
  HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ada Lovelace',
  GIT_AUTHOR_EMAIL: 'ada@example.invalid',
  GIT_COMMITTER_NAME: 'Ada Lovelace',
  GIT_COMMITTER_EMAIL: 'ada@example.invalid',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_DATE: '1700000000 +0000',
  GIT_TERMINAL_PROMPT: '0',
};

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Run git asynchronously (see the note at the top of this file). */
function git(cwd: string, args: string[], expectOk = true): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: GIT_ENV });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args.join(' ')} timed out after 30s (stdout: ${stdout}, stderr: ${stderr})`));
    }, 30000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      const code = status ?? -1;
      if (expectOk && code !== 0) {
        reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve({ status: code, stdout, stderr });
    });
  });
}

const store = new Store();
for (const name of ['empty', 'repo', 'mixed', 'tags']) {
  store.createRepo(OWNER, name, { description: `test ${name}` });
}

const server = createServer((req, res) => {
  void handleGit(store, req, res).then((handled) => {
    if (!handled) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('did not bind a port');
const BASE = `http://127.0.0.1:${address.port}`;
const repoUrl = (name: string): string => `${BASE}/${OWNER}/${name}.git`;

async function lsRemote(name: string, extra: string[] = []): Promise<Map<string, string>> {
  const out = await git(TMP, ['ls-remote', ...extra, repoUrl(name)]);
  const map = new Map<string, string>();
  for (const line of out.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [oid, ref] = line.split('\t');
    map.set(ref, oid);
  }
  return map;
}

async function commitIn(dir: string, file: string, content: string, message: string): Promise<string> {
  writeFileSync(join(dir, file), content);
  await git(dir, ['add', file]);
  await git(dir, ['commit', '-m', message, '--quiet']);
  return (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
}

async function initSource(dir: string, remoteName: string): Promise<void> {
  await git(TMP, ['init', '--quiet', '-b', 'main', dir]);
  await git(dir, ['remote', 'add', 'origin', repoUrl(remoteName)]);
}

function objectCount(dir: string): Promise<number> {
  return git(dir, ['cat-file', '--batch-all-objects', '--batch-check']).then(
    (out) => out.stdout.split('\n').filter(Boolean).length,
  );
}

// --- 1. clone of an empty repo ------------------------------------------------
await check('clone of an empty repo works (0 objects, unborn HEAD)', async () => {
  const emptyClone = join(TMP, 'empty-clone');
  const result = await git(TMP, ['clone', '--quiet', repoUrl('empty'), emptyClone]);
  assert.equal(result.status, 0);
  assert.ok(existsSync(join(emptyClone, '.git')));
  const head = await git(emptyClone, ['rev-parse', 'HEAD'], false);
  assert.notEqual(head.status, 0, 'HEAD should be unborn');
  const count = (await git(emptyClone, ['count-objects', '-v'])).stdout;
  const inPack = Number(/in-pack: (\d+)/.exec(count)?.[1] ?? '-1');
  const loose = Number(/count: (\d+)/.exec(count)?.[1] ?? '-1');
  assert.equal(inPack + loose, 0, `expected 0 objects, got ${count}`);
});

// --- 2. push a first commit, then clone back ----------------------------------
const src = join(TMP, 'src');
await initSource(src, 'repo');
const c1 = await commitIn(src, 'hello.txt', 'hello world\n', 'first commit');
await check('push a first commit and the ref becomes the tip', async () => {
  const pushed = await git(src, ['push', '--quiet', 'origin', 'main:refs/heads/main']);
  assert.equal(pushed.status, 0);
  const refs = await lsRemote('repo');
  assert.equal(refs.get('refs/heads/main'), c1);
});

const clone = join(TMP, 'clone');
await check('clone back: objects byte-identical (fsck + cat-file)', async () => {
  await git(TMP, ['clone', '--quiet', repoUrl('repo'), clone]);
  const fsck = await git(clone, ['fsck', '--strict']);
  assert.equal(fsck.status, 0, fsck.stderr);
  assert.equal((await git(clone, ['rev-parse', 'HEAD'])).stdout.trim(), c1);
  assert.equal(readFileSync(join(clone, 'hello.txt'), 'utf8'), 'hello world\n');
  assert.equal((await git(clone, ['cat-file', '-p', 'HEAD:hello.txt'])).stdout, 'hello world\n');
});

// --- 3. incremental fetch ------------------------------------------------------
const c2 = await commitIn(src, 'second.txt', 'second file\n', 'second commit');
await check('push second commit (fast-forward)', async () => {
  await git(src, ['push', '--quiet', 'origin', 'main:refs/heads/main']);
  assert.equal((await lsRemote('repo')).get('refs/heads/main'), c2);
});

await check('fetch incremental: only new objects transfer', async () => {
  const before = await objectCount(clone);
  await git(clone, ['fetch', '--quiet', 'origin']);
  assert.equal((await git(clone, ['rev-parse', 'origin/main'])).stdout.trim(), c2);
  const after = await objectCount(clone);
  // New objects: c2 commit + its tree + second.txt blob = 3 (hello.txt blob/tree shared).
  assert.equal(after - before, 3, `expected 3 new objects, got ${after - before}`);
  assert.equal((await git(clone, ['fsck', '--strict'])).status, 0);
});

// --- 4. shallow clone --depth 1 then --deepen ----------------------------------
const c3 = await commitIn(src, 'third.txt', 'third file\n', 'third commit');
await git(src, ['push', '--quiet', 'origin', 'main:refs/heads/main']);
assert.equal((await lsRemote('repo')).get('refs/heads/main'), c3);

const shallowClone = join(TMP, 'shallow-clone');
await check('shallow clone --depth 1 lands the tip only', async () => {
  await git(TMP, ['clone', '--quiet', '--depth', '1', repoUrl('repo'), shallowClone]);
  assert.equal((await git(shallowClone, ['rev-list', '--count', 'HEAD'])).stdout.trim(), '1');
  assert.equal((await git(shallowClone, ['rev-parse', 'HEAD'])).stdout.trim(), c3);
  const shallowFile = readFileSync(join(shallowClone, '.git', 'shallow'), 'utf8').trim().split('\n');
  assert.deepEqual(shallowFile, [c3]);
});

await check('fetch --depth=2 deepens by exactly one generation', async () => {
  await git(shallowClone, ['fetch', '--quiet', '--depth=2', 'origin']);
  assert.equal((await git(shallowClone, ['rev-list', '--count', 'HEAD'])).stdout.trim(), '2');
  assert.equal((await git(shallowClone, ['rev-parse', 'HEAD~1'])).stdout.trim(), c2);
  const shallowFile = readFileSync(join(shallowClone, '.git', 'shallow'), 'utf8').trim().split('\n');
  assert.deepEqual(shallowFile, [c2]);
  assert.equal((await git(shallowClone, ['fsck', '--strict'])).status, 0);
});

// --- 5. non-fast-forward push is refused ----------------------------------------
await check('non-fast-forward push is refused and the ref does not move', async () => {
  await git(src, ['checkout', '--quiet', '-b', 'divergent', c1]);
  const bad = await commitIn(src, 'other.txt', 'divergent\n', 'divergent commit');
  assert.notEqual(bad, c2);
  const pushed = await git(src, ['push', 'origin', 'divergent:refs/heads/main'], false);
  assert.notEqual(pushed.status, 0, 'divergent push should fail');
  assert.match(pushed.stderr, /non-fast-forward/);
  assert.equal((await lsRemote('repo')).get('refs/heads/main'), c3, 'ref must not move');
  await git(src, ['checkout', '--quiet', 'main']);
  await git(src, ['branch', '-D', '--quiet', 'divergent']);
});

// --- 6. mixed push: one FF + one non-FF ------------------------------------------
const mixedSrc = join(TMP, 'mixed-src');
await initSource(mixedSrc, 'mixed');
const m1 = await commitIn(mixedSrc, 'a.txt', 'a\n', 'm1');
await git(mixedSrc, ['push', '--quiet', 'origin', 'main:refs/heads/main']);
await git(mixedSrc, ['push', '--quiet', 'origin', 'main:refs/heads/side']);
const m2 = await commitIn(mixedSrc, 'b.txt', 'b\n', 'm2');
await git(mixedSrc, ['push', '--quiet', 'origin', 'main:refs/heads/main']);
await git(mixedSrc, ['push', '--quiet', 'origin', 'main:refs/heads/side']);
await check('mixed push applies only the fast-forward ref', async () => {
  const m3 = await commitIn(mixedSrc, 'c.txt', 'c\n', 'm3');
  await git(mixedSrc, ['checkout', '--quiet', '-b', 'side-div', m1]);
  const mBad = await commitIn(mixedSrc, 'd.txt', 'd\n', 'divergent side');
  assert.notEqual(mBad, m2);
  const pushed = await git(mixedSrc, ['push', 'origin', 'main:refs/heads/main', 'side-div:refs/heads/side'], false);
  assert.notEqual(pushed.status, 0, 'mixed push should report failure overall');
  assert.match(pushed.stderr, /non-fast-forward/);
  const refs = await lsRemote('mixed');
  assert.equal(refs.get('refs/heads/main'), m3, 'FF ref must advance');
  assert.equal(refs.get('refs/heads/side'), m2, 'non-FF ref must not move');
  await git(mixedSrc, ['checkout', '--quiet', 'main']);
  await git(mixedSrc, ['branch', '-D', '--quiet', 'side-div']);
});

// --- 7. branch/tag create + delete ----------------------------------------------
const tagSrc = join(TMP, 'tag-src');
await initSource(tagSrc, 'tags');
const t1 = await commitIn(tagSrc, 'f.txt', 'f\n', 't1');
await git(tagSrc, ['push', '--quiet', 'origin', 'main:refs/heads/main']);
await git(tagSrc, ['tag', '-a', 'v1', '-m', 'version 1']);
const tagOid = (await git(tagSrc, ['rev-parse', 'v1'])).stdout.trim();
await check('branch + annotated tag create via push', async () => {
  await git(tagSrc, ['push', '--quiet', 'origin', 'main:refs/heads/feature']);
  await git(tagSrc, ['push', '--quiet', 'origin', 'v1']);
  const refs = await lsRemote('tags');
  assert.equal(refs.get('refs/heads/feature'), t1);
  assert.equal(refs.get('refs/tags/v1'), tagOid);
  assert.equal(refs.get('refs/tags/v1^{}'), t1, 'v1^{} should peel to the commit');
});

await check('annotated tag round-trips with peel in a clone', async () => {
  const tagClone = join(TMP, 'tag-clone');
  await git(TMP, ['clone', '--quiet', repoUrl('tags'), tagClone]);
  assert.equal((await git(tagClone, ['rev-parse', 'v1'])).stdout.trim(), tagOid);
  assert.equal((await git(tagClone, ['rev-parse', 'v1^{}'])).stdout.trim(), t1);
  const tagBody = (await git(tagClone, ['cat-file', '-p', 'v1'])).stdout;
  assert.match(tagBody, /object /);
  assert.match(tagBody, /type commit/);
  assert.match(tagBody, /tag v1/);
  assert.equal((await git(tagClone, ['fsck', '--strict'])).status, 0);
});

await check('branch + tag delete via push', async () => {
  await git(tagSrc, ['push', '--quiet', 'origin', ':refs/heads/feature']);
  await git(tagSrc, ['push', '--quiet', 'origin', ':refs/tags/v1']);
  const refs = await lsRemote('tags');
  assert.equal(refs.get('refs/heads/feature'), undefined);
  assert.equal(refs.get('refs/tags/v1'), undefined);
  assert.equal(refs.get('refs/heads/main'), t1, 'main must survive the deletes');
});

// --- 8. v0 protocol ---------------------------------------------------------------
await check('protocol v0 ls-remote and clone work', async () => {
  const out = await git(TMP, ['-c', 'protocol.version=0', 'ls-remote', repoUrl('repo')]);
  assert.match(out.stdout, new RegExp(`^${c3}\\trefs/heads/main`, 'm'));
  const v0Clone = join(TMP, 'v0-clone');
  await git(TMP, ['-c', 'protocol.version=0', 'clone', '--quiet', repoUrl('repo'), v0Clone]);
  assert.equal((await git(v0Clone, ['rev-parse', 'HEAD'])).stdout.trim(), c3);
  assert.equal((await git(v0Clone, ['fsck', '--strict'])).status, 0);
});

await check('ls-remote --symref reports HEAD -> refs/heads/main', async () => {
  const out = await git(TMP, ['ls-remote', '--symref', repoUrl('repo')]);
  assert.match(out.stdout, /^ref: refs\/heads\/main\tHEAD$/m);
});

// --- 9. malformed POST + missing repo ----------------------------------------------
await check('malformed POST does not kill the server; missing repo info/refs -> 404', async () => {
  const malformed = await fetch(`${repoUrl('repo')}/git-upload-pack`, {
    method: 'POST',
    body: 'zzzznot-a-pkt-line',
  });
  assert.equal(malformed.status, 400, `malformed POST should be 400, got ${malformed.status}`);
  const healthy = await fetch(`${repoUrl('repo')}/info/refs?service=git-upload-pack`);
  assert.equal(healthy.status, 200, 'info/refs should still be 200 after a malformed POST');
  const missingUpload = await fetch(`${BASE}/${OWNER}/nope.git/info/refs?service=git-upload-pack`);
  assert.equal(missingUpload.status, 404, 'missing repo upload-pack should be 404');
  const missingReceive = await fetch(`${BASE}/${OWNER}/nope.git/info/refs?service=git-receive-pack`);
  assert.equal(missingReceive.status, 404, 'missing repo receive-pack should be 404');
  const healthy2 = await fetch(`${repoUrl('repo')}/info/refs?service=git-upload-pack`);
  assert.equal(healthy2.status, 200, 'known repo should still be 200 after 404s');
});

server.close();
if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('all git-http checks passed');
}
