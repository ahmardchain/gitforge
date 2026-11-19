// Tests for src/rest.ts: spins up a real node:http server wrapping only
// handleRest with a fresh Store, then exercises it with fetch.
// Run: ~/.local/node22/bin/node --experimental-strip-types tests/test-rest.ts

process.env.MAKEFUN_SHOP_TOKEN = 'test-token';

import { createServer } from 'node:http';
import { Store } from '../src/store.ts';
import { handleRest } from '../src/rest.ts';

const store = new Store();
const server = createServer(async (req, res) => {
  const handled = await handleRest(store, req, res);
  if (!handled) {
    res.writeHead(404, { 'content-type': 'application/json', 'x-github-request-id': 'test-404' });
    res.end(JSON.stringify({ message: 'Not Found' }));
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('no address');
const base = `http://127.0.0.1:${address.port}`;
const TOKEN = 'test-token';

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail = ''): void {
  checks += 1;
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name} ${detail}`);
  }
}

interface ReqOpts {
  method?: string;
  token?: string | null;
  body?: unknown;
  rawBody?: string;
}

async function req(path: string, opts: ReqOpts = {}): Promise<{ status: number; headers: Headers; text: string; json: unknown }> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (opts.token === undefined || opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    headers['content-type'] = 'application/json';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${base}${path}`, { method: opts.method ?? 'GET', headers, body });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

function asObj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
function unb64(s: string): string {
  return Buffer.from(s.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
}

const OWNER = 'adaiversen';

// --- public roots (anon ok) ---
{
  const r = await req('/api/v3/', { token: null });
  check('root anon 200', r.status === 200, `got ${r.status} ${r.text}`);
  check('root scopes header', (r.headers.get('x-oauth-scopes') ?? '').includes('repo'));
  check('root request id', (r.headers.get('x-github-request-id') ?? '') !== '');
  const m = await req('/api/v3/meta', { token: null });
  check('meta anon 200 installed_version', m.status === 200 && asObj(m.json).installed_version === '1.0.0', `got ${m.status} ${m.text}`);
}

// --- auth ---
{
  const r = await req(`/api/v3/repos/x/y`, { token: null });
  check('unauth repo 401', r.status === 401 && typeof asObj(r.json).message === 'string', `got ${r.status} ${r.text}`);
  const w = await req(`/api/v3/repos/x/y`, { token: 'wrong' });
  check('wrong token 401', w.status === 401, `got ${w.status}`);
  const f = await req(`/api/v3/repos/someone-else/repo1`);
  check('foreign owner 404 not 403', f.status === 404, `got ${f.status}`);
}

// --- create repo / get / patch / duplicate ---
let repoSha = '';
{
  const c = await req('/api/v3/user/repos', { method: 'POST', body: { name: 'demo', private: true, description: 'first' } });
  check('create repo 201', c.status === 201 && asObj(c.json).name === 'demo', `got ${c.status} ${c.text}`);
  const dup = await req('/api/v3/user/repos', { method: 'POST', body: { name: 'demo' } });
  check('duplicate repo 422', dup.status === 422, `got ${dup.status}`);
  const g = await req(`/api/v3/repos/${OWNER}/demo`);
  check('get repo 200', g.status === 200 && asObj(g.json).default_branch === 'main', `got ${g.status} ${g.text}`);
  const p = await req(`/api/v3/repos/${OWNER}/demo`, { method: 'PATCH', body: { description: 'updated desc' } });
  check('patch repo 200 desc', p.status === 200 && asObj(p.json).description === 'updated desc', `got ${p.status} ${p.text}`);
  const g2 = await req(`/api/v3/repos/${OWNER}/demo`);
  check('patch persists', asObj(g2.json).description === 'updated desc');
  const miss = await req(`/api/v3/repos/${OWNER}/nope`);
  check('missing repo 404', miss.status === 404 && typeof asObj(miss.json).message === 'string', `got ${miss.status}`);
}

// --- pagination: 30 repos, per_page=10, 3 pages ---
{
  for (let i = 0; i < 30; i += 1) {
    const c = await req('/api/v3/user/repos', { method: 'POST', body: { name: `page-${i}`, private: true } });
    if (c.status !== 201) console.log(`  create page-${i} -> ${c.status} ${c.text}`);
  }
  const seen: string[] = [];
  let next: string | null = '/api/v3/user/repos?per_page=10';
  let pages = 0;
  while (next !== null && pages < 10) {
    pages += 1;
    const r = await req(next);
    const arr = Array.isArray(r.json) ? r.json : [];
    check(`pagination page ${pages} size<=10`, arr.length <= 10, `got ${arr.length}`);
    for (const item of arr) seen.push(String(asObj(item).name));
    const link = r.headers.get('link') ?? '';
    const m = /<([^>]*)>; rel="next"/.exec(link);
    // The Link URL is absolute (same origin); resolve it back to a path.
    next = m ? (() => { const u = new URL(m[1]!, base); return `${u.pathname}${u.search}`; })() : null;
  }
  check('pagination 4 pages (31 repos incl demo)', pages === 4, `got ${pages}`);
  check('pagination saw 30 seeded + demo', seen.filter((n) => n.startsWith('page-')).length === 30, `got ${seen.filter((n) => n.startsWith('page-')).length}`);
  check('pagination no dupes', new Set(seen).size === seen.length);
}

// --- contents: create / update / stale / get / dir / delete ---
{
  const put1 = await req(`/api/v3/repos/${OWNER}/demo/contents/docs/readme.md`, {
    method: 'PUT',
    body: { message: 'add readme', content: b64('hello world') },
  });
  check('contents PUT create 201', put1.status === 201, `got ${put1.status} ${put1.text}`);
  const putBody = asObj(put1.json);
  const contentSha = String(asObj(putBody.content).sha ?? '');
  repoSha = String(asObj(putBody.commit).sha ?? '');
  check('contents PUT sha is 40-hex', /^[0-9a-f]{40}$/.test(contentSha), contentSha);
  const get1 = await req(`/api/v3/repos/${OWNER}/demo/contents/docs/readme.md`);
  check('contents GET file 200', get1.status === 200, `got ${get1.status} ${get1.text}`);
  check('contents GET decodes exactly', unb64(String(asObj(get1.json).content ?? '')) === 'hello world', String(asObj(get1.json).content));
  check('contents GET sha matches', String(asObj(get1.json).sha) === contentSha);
  check('contents GET size', asObj(get1.json).size === 11, `got ${String(asObj(get1.json).size)}`);
  const put2 = await req(`/api/v3/repos/${OWNER}/demo/contents/docs/readme.md`, {
    method: 'PUT',
    body: { message: 'update readme', content: b64('hello v2'), sha: contentSha },
  });
  check('contents PUT update 200', put2.status === 200, `got ${put2.status} ${put2.text}`);
  const stale = await req(`/api/v3/repos/${OWNER}/demo/contents/docs/readme.md`, {
    method: 'PUT',
    body: { message: 'stale', content: b64('x'), sha: contentSha },
  });
  check('contents PUT stale sha 409', stale.status === 409, `got ${stale.status} ${stale.text}`);
  const get2 = await req(`/api/v3/repos/${OWNER}/demo/contents/docs/readme.md`);
  check('contents GET after update decodes v2', unb64(String(asObj(get2.json).content ?? '')) === 'hello v2');
  // second file in same dir for directory listing
  await req(`/api/v3/repos/${OWNER}/demo/contents/docs/other.txt`, {
    method: 'PUT',
    body: { message: 'add other', content: b64('other') },
  });
  const dir = await req(`/api/v3/repos/${OWNER}/demo/contents/docs`);
  check('contents GET dir is array', dir.status === 200 && Array.isArray(dir.json), `got ${dir.status} ${dir.text}`);
  const names = (dir.json as unknown[]).map((e) => String(asObj(e).name));
  check('contents dir lists both files', names.includes('readme.md') && names.includes('other.txt'), names.join(','));
  // root listing
  const root = await req(`/api/v3/repos/${OWNER}/demo/contents`);
  check('contents GET root lists docs dir', root.status === 200 && Array.isArray(root.json) && (root.json as unknown[]).some((e) => asObj(e).name === 'docs'), `got ${root.status} ${root.text}`);
  // delete
  const cur = await req(`/api/v3/repos/${OWNER}/demo/contents/docs/other.txt`);
  const del = await req(`/api/v3/repos/${OWNER}/demo/contents/docs/other.txt`, {
    method: 'DELETE',
    body: { message: 'remove other', sha: String(asObj(cur.json).sha) },
  });
  check('contents DELETE 200 commit sha', del.status === 200 && /^[0-9a-f]{40}$/.test(String(asObj(asObj(del.json).commit).sha ?? '')), `got ${del.status} ${del.text}`);
  const afterDel = await req(`/api/v3/repos/${OWNER}/demo/contents/docs/other.txt`);
  check('contents GET after delete 404', afterDel.status === 404, `got ${afterDel.status}`);
}

// --- branches + commits scoping ---
let featureSha = '';
{
  const br = await req(`/api/v3/repos/${OWNER}/demo/git/refs`, {
    method: 'POST',
    body: { ref: 'refs/heads/feature', sha: repoSha },
  });
  check('create branch 201', br.status === 201 && asObj(br.json).ref === 'refs/heads/feature', `got ${br.status} ${br.text}`);
  const badRef = await req(`/api/v3/repos/${OWNER}/demo/git/refs`, {
    method: 'POST',
    body: { ref: 'refs/heads/bad', sha: '0000000000000000000000000000000000000000' },
  });
  check('create branch unknown sha 422', badRef.status === 422, `got ${badRef.status}`);
  const branches = await req(`/api/v3/repos/${OWNER}/demo/branches`);
  const bnames = (branches.json as unknown[]).map((e) => String(asObj(e).name));
  check('branches lists main+feature', bnames.includes('main') && bnames.includes('feature'), bnames.join(','));
  const putF = await req(`/api/v3/repos/${OWNER}/demo/contents/feat.txt`, {
    method: 'PUT',
    body: { message: 'feature commit', content: b64('feature work'), branch: 'feature' },
  });
  check('commit on feature branch 201', putF.status === 201, `got ${putF.status} ${putF.text}`);
  featureSha = String(asObj(asObj(putF.json).commit).sha ?? '');
  const commitsF = await req(`/api/v3/repos/${OWNER}/demo/commits?sha=feature`);
  const fshas = (commitsF.json as unknown[]).map((e) => String(asObj(e).sha));
  check('commits?sha=feature lists feature commit', fshas.includes(featureSha), fshas.join(','));
  check('commits newest first', fshas[0] === featureSha, fshas.join(','));
  const commitsMain = await req(`/api/v3/repos/${OWNER}/demo/commits`);
  const mshas = (commitsMain.json as unknown[]).map((e) => String(asObj(e).sha));
  check('commits default excludes feature commit', !mshas.includes(featureSha), mshas.join(','));
  const singleRef = await req(`/api/v3/repos/${OWNER}/demo/git/refs/heads/feature`);
  check('get single ref 200', singleRef.status === 200 && asObj(asObj(singleRef.json).object).sha === featureSha, `got ${singleRef.status} ${singleRef.text}`);
  const gc = await req(`/api/v3/repos/${OWNER}/demo/git/commits/${featureSha}`);
  check('get git commit 200', gc.status === 200 && String(asObj(asObj(gc.json).commit).message) === 'feature commit', `got ${gc.status} ${gc.text}`);
}

// --- labels / issues / comments ---
let issueNum = 0;
{
  const lab = await req(`/api/v3/repos/${OWNER}/demo/labels`, { method: 'POST', body: { name: 'bug', color: 'ededed' } });
  check('label create 201', lab.status === 201 && asObj(lab.json).name === 'bug', `got ${lab.status} ${lab.text}`);
  const bad = await req(`/api/v3/repos/${OWNER}/demo/issues`, {
    method: 'POST',
    body: { title: 'bad', body: 'x', labels: ['no-such-label'] },
  });
  check('issue unknown label 422', bad.status === 422, `got ${bad.status} ${bad.text}`);
  const iss = await req(`/api/v3/repos/${OWNER}/demo/issues`, {
    method: 'POST',
    body: { title: 'first issue', body: 'body here', labels: ['bug'] },
  });
  check('issue create 201', iss.status === 201 && asObj(iss.json).number === 1, `got ${iss.status} ${iss.text}`);
  check('issue labels attached', (asObj(iss.json).labels as unknown[]).some((l) => asObj(l).name === 'bug'));
  issueNum = Number(asObj(iss.json).number);
  const iss2 = await req(`/api/v3/repos/${OWNER}/demo/issues`, { method: 'POST', body: { title: 'second', body: 'b2' } });
  check('issue numbers increment', asObj(iss2.json).number === 2, `got ${String(asObj(iss2.json).number)}`);
  const patch = await req(`/api/v3/repos/${OWNER}/demo/issues/2`, { method: 'PATCH', body: { state: 'closed' } });
  check('issue PATCH close 200', patch.status === 200 && asObj(patch.json).state === 'closed', `got ${patch.status} ${patch.text}`);
  const getClosed = await req(`/api/v3/repos/${OWNER}/demo/issues/2`);
  check('issue PATCH close persists', asObj(getClosed.json).state === 'closed');
  const openList = await req(`/api/v3/repos/${OWNER}/demo/issues?state=open&per_page=100`);
  const openNums = (openList.json as unknown[]).map((i) => Number(asObj(i).number));
  check('issues list open excludes closed', openNums.includes(1) && !openNums.includes(2), openNums.join(','));
  const asc = await req(`/api/v3/repos/${OWNER}/demo/issues?state=all&sort=created&direction=asc&per_page=100`);
  const ascNums = (asc.json as unknown[]).map((i) => Number(asObj(i).number));
  check('issues sort asc', ascNums[0] === 1 && ascNums[1] === 2, ascNums.join(','));
  const desc = await req(`/api/v3/repos/${OWNER}/demo/issues?state=all&sort=created&direction=desc&per_page=100`);
  const descNums = (desc.json as unknown[]).map((i) => Number(asObj(i).number));
  check('issues sort desc', descNums[0] === 2 && descNums[1] === 1, descNums.join(','));
  const c = await req(`/api/v3/repos/${OWNER}/demo/issues/${issueNum}/comments`, { method: 'POST', body: { body: 'hello comment' } });
  check('comment create 201', c.status === 201 && asObj(c.json).body === 'hello comment', `got ${c.status} ${c.text}`);
  const clist = await req(`/api/v3/repos/${OWNER}/demo/issues/${issueNum}/comments`);
  check('comment list contains it', Array.isArray(clist.json) && (clist.json as unknown[]).some((x) => asObj(x).body === 'hello comment'), clist.text);
  const getIss = await req(`/api/v3/repos/${OWNER}/demo/issues/${issueNum}`);
  check('issue comments count is 1', asObj(getIss.json).comments === 1, `got ${String(asObj(getIss.json).comments)}`);
  const missIss = await req(`/api/v3/repos/${OWNER}/demo/issues/999`);
  check('missing issue 404', missIss.status === 404, `got ${missIss.status}`);
}

// --- pulls: create / files / merge / conflict ---
{
  const pr = await req(`/api/v3/repos/${OWNER}/demo/pulls`, {
    method: 'POST',
    body: { head: 'feature', base: 'main', title: 'add feat', body: 'pr body' },
  });
  check('pull create 201', pr.status === 201 && asObj(pr.json).number === 1, `got ${pr.status} ${pr.text}`);
  check('pull head sha is feature tip', String(asObj(asObj(pr.json).head).sha) === featureSha, `got ${String(asObj(asObj(pr.json).head).sha)} vs ${featureSha}`);
  check('pull mergeable MERGEABLE', asObj(pr.json).mergeable === 'MERGEABLE', `got ${String(asObj(pr.json).mergeable)}`);
  const files = await req(`/api/v3/repos/${OWNER}/demo/pulls/1/files`);
  check('pull files lists feat.txt added', Array.isArray(files.json) && (files.json as unknown[]).some((f) => asObj(f).filename === 'feat.txt' && asObj(f).status === 'added' && Number(asObj(f).additions) >= 1), files.text);
  const listOpen = await req(`/api/v3/repos/${OWNER}/demo/pulls`);
  check('pulls list default open includes 1', Array.isArray(listOpen.json) && (listOpen.json as unknown[]).some((p) => asObj(p).number === 1));
  const merge = await req(`/api/v3/repos/${OWNER}/demo/pulls/1/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  check('pull merge 200 merged', merge.status === 200 && asObj(merge.json).merged === true, `got ${merge.status} ${merge.text}`);
  const mergeSha = String(asObj(merge.json).sha ?? '');
  const after = await req(`/api/v3/repos/${OWNER}/demo/pulls/1`);
  check('pull closed+merged after merge', asObj(after.json).state === 'closed' && asObj(after.json).merged === true, after.text);
  check('pull merged_at set', typeof asObj(after.json).merged_at === 'string' && (asObj(after.json).merged_at as string) !== '');
  check('pull merge_commit_sha matches', asObj(after.json).merge_commit_sha === mergeSha, `got ${String(asObj(after.json).merge_commit_sha)} vs ${mergeSha}`);
  const landed = await req(`/api/v3/repos/${OWNER}/demo/contents/feat.txt?ref=main`);
  check('squash content lands on base', landed.status === 200 && unb64(String(asObj(landed.json).content ?? '')) === 'feature work', landed.text);
  const commitsMain = await req(`/api/v3/repos/${OWNER}/demo/commits?sha=main`);
  check('merge commit on default branch', (commitsMain.json as unknown[]).some((c) => String(asObj(c).sha) === mergeSha));
  const listAll = await req(`/api/v3/repos/${OWNER}/demo/pulls?state=all`);
  check('pulls state=all includes merged', Array.isArray(listAll.json) && (listAll.json as unknown[]).some((p) => asObj(p).number === 1));
  const listOpen2 = await req(`/api/v3/repos/${OWNER}/demo/pulls`);
  check('pulls default open excludes merged', Array.isArray(listOpen2.json) && !(listOpen2.json as unknown[]).some((p) => asObj(p).number === 1));
  const unknownMerge = await req(`/api/v3/repos/${OWNER}/demo/pulls/999/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  check('merge unknown PR 404', unknownMerge.status === 404, `got ${unknownMerge.status}`);
  const unknownPr = await req(`/api/v3/repos/${OWNER}/demo/pulls/999`);
  check('get unknown PR 404', unknownPr.status === 404, `got ${unknownPr.status}`);

  // Conflict: two branches change docs/readme.md differently vs merge base.
  const mkBranch = async (name: string): Promise<void> => {
    const tip = await req(`/api/v3/repos/${OWNER}/demo/commits?sha=main`);
    const head = String(asObj((tip.json as unknown[])[0]).sha);
    await req(`/api/v3/repos/${OWNER}/demo/git/refs`, { method: 'POST', body: { ref: `refs/heads/${name}`, sha: head } });
  };
  await mkBranch('conf-a');
  await mkBranch('conf-b');
  const cur = await req(`/api/v3/repos/${OWNER}/demo/contents/docs/readme.md`);
  await req(`/api/v3/repos/${OWNER}/demo/contents/docs/readme.md`, {
    method: 'PUT',
    body: { message: 'a change', content: b64('readme A'), branch: 'conf-a', sha: String(asObj(cur.json).sha) },
  });
  await req(`/api/v3/repos/${OWNER}/demo/contents/docs/readme.md`, {
    method: 'PUT',
    body: { message: 'b change', content: b64('readme B'), branch: 'conf-b', sha: String(asObj(cur.json).sha) },
  });
  const pra = await req(`/api/v3/repos/${OWNER}/demo/pulls`, { method: 'POST', body: { head: 'conf-a', base: 'main', title: 'A', body: '' } });
  const prb = await req(`/api/v3/repos/${OWNER}/demo/pulls`, { method: 'POST', body: { head: 'conf-b', base: 'main', title: 'B', body: '' } });
  const numA = Number(asObj(pra.json).number);
  const numB = Number(asObj(prb.json).number);
  const mA = await req(`/api/v3/repos/${OWNER}/demo/pulls/${numA}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  check('first conflict-side merge 200', mA.status === 200, `got ${mA.status} ${mA.text}`);
  const prbAfter = await req(`/api/v3/repos/${OWNER}/demo/pulls/${numB}`);
  check('conflicting PR mergeable CONFLICTING after base moves', asObj(prbAfter.json).mergeable === 'CONFLICTING', `got ${String(asObj(prbAfter.json).mergeable)}`);
  const mB = await req(`/api/v3/repos/${OWNER}/demo/pulls/${numB}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  check('conflicted second merge 405', mB.status === 405, `got ${mB.status} ${mB.text}`);
  const stillOpen = await req(`/api/v3/repos/${OWNER}/demo/pulls/${numB}`);
  check('conflicted PR stays open', asObj(stillOpen.json).state === 'open', stillOpen.text);
}

// --- extras: user, search, tags, milestones, git tags ---
{
  const u = await req('/api/v3/user');
  check('GET /user 200 viewer', u.status === 200 && asObj(u.json).login === OWNER, `got ${u.status} ${u.text}`);
  const s = await req('/api/v3/search/issues?q=first%20issue');
  check('search issues finds it', s.status === 200 && Number(asObj(s.json).total_count) >= 1, `got ${s.status} ${s.text}`);
  const sr = await req('/api/v3/search/repositories?q=demo');
  check('search repos finds demo', sr.status === 200 && Number(asObj(sr.json).total_count) >= 1, `got ${sr.status} ${sr.text}`);
  const tags0 = await req(`/api/v3/repos/${OWNER}/demo/tags`);
  check('tags empty list', tags0.status === 200 && Array.isArray(tags0.json), `got ${tags0.status}`);
  const tip = await req(`/api/v3/repos/${OWNER}/demo/commits?sha=main`);
  const headSha = String(asObj((tip.json as unknown[])[0]).sha);
  const tag = await req(`/api/v3/repos/${OWNER}/demo/git/tags`, {
    method: 'POST',
    body: { tag: 'v1.0.0', message: 'release', object: headSha, type: 'commit' },
  });
  check('annotated tag create 201', tag.status === 201 && /^[0-9a-f]{40}$/.test(String(asObj(tag.json).sha ?? '')), `got ${tag.status} ${tag.text}`);
  await req(`/api/v3/repos/${OWNER}/demo/git/refs`, { method: 'POST', body: { ref: 'refs/tags/v1.0.0', sha: String(asObj(tag.json).sha) } });
  const tags1 = await req(`/api/v3/repos/${OWNER}/demo/tags`);
  check('tags lists v1.0.0', Array.isArray(tags1.json) && (tags1.json as unknown[]).some((t) => asObj(t).name === 'v1.0.0'), tags1.text);
  const ms = await req(`/api/v3/repos/${OWNER}/demo/milestones`, { method: 'POST', body: { title: 'v1' } });
  check('milestone create 201', ms.status === 201 && asObj(ms.json).number === 1, `got ${ms.status} ${ms.text}`);
  const msList = await req(`/api/v3/repos/${OWNER}/demo/milestones`);
  check('milestone list', Array.isArray(msList.json) && (msList.json as unknown[]).length === 1);
  const msPatch = await req(`/api/v3/repos/${OWNER}/demo/milestones/1`, { method: 'PATCH', body: { state: 'closed' } });
  check('milestone patch close', msPatch.status === 200 && asObj(msPatch.json).state === 'closed', `got ${msPatch.status} ${msPatch.text}`);
}

// --- protocol: unknown route, malformed JSON, delete repo ---
{
  const unk = await req('/api/v3/no-such-route');
  check('unknown route 404 JSON', unk.status === 404 && typeof asObj(unk.json).message === 'string', `got ${unk.status} ${unk.text}`);
  const bad = await req('/api/v3/user/repos', { method: 'POST', rawBody: '{"name":' });
  check('malformed JSON 400', bad.status === 400 && typeof asObj(bad.json).message === 'string', `got ${bad.status} ${bad.text}`);
  const del = await req(`/api/v3/repos/${OWNER}/demo`, { method: 'DELETE' });
  check('delete repo 204', del.status === 204, `got ${del.status} ${del.text}`);
  const gone = await req(`/api/v3/repos/${OWNER}/demo`);
  check('deleted repo GET 404', gone.status === 404, `got ${gone.status}`);
  // non-/api/v3 path falls through (handleRest returns false)
  const outside = await fetch(`${base}/healthz`);
  check('non-api path falls through (404 from harness)', outside.status === 404);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
server.close();
process.exit(failures === 0 ? 0 : 1);
