// Tests for src/graphql.ts. Run:
//   ~/.local/node22/bin/node --experimental-strip-types tests/test-graphql.ts
// Spins up a real node:http server wrapping only handleGraphql with a fresh
// Store. Git objects for branches are built by hand here (node:crypto SHA-1)
// because src/git-core.ts does not exist yet.

process.env.MAKEFUN_SHOP_TOKEN = 'test-token';

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const { Store } = await import('../src/store.ts');
const { handleGraphql } = await import('../src/graphql.ts');

type AnyRec = Record<string, any>;

let failures = 0;
let passes = 0;
function check(cond: boolean, label: string, detail = ''): void {
  if (cond) { passes += 1; console.log(`ok - ${label}`); }
  else { failures += 1; console.log(`FAIL - ${label}${detail ? ` :: ${detail}` : ''}`); }
}
function eq(a: unknown, b: unknown, label: string): void {
  check(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
}

// --- minimal git object helpers (hand-built, SHA-1) ---
function sha1(type: string, data: Buffer): string {
  return createHash('sha1').update(Buffer.from(`${type} ${data.length}\0`)).update(data).digest('hex');
}
function putObj(repo: AnyRec, type: string, data: Buffer): string {
  const oid = sha1(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function makeTree(repo: AnyRec, entries: Array<{ mode: string; name: string; oid: string }>): string {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1));
  const parts: Buffer[] = [];
  for (const e of sorted) { parts.push(Buffer.from(`${e.mode} ${e.name}\0`)); parts.push(Buffer.from(e.oid, 'hex')); }
  return putObj(repo, 'tree', Buffer.concat(parts));
}
function makeCommit(repo: AnyRec, tree: string, parents: string[], message: string): string {
  const who = `adaiversen <adaiversen@example.invalid> 1700000000 +0000`;
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${who}`, `committer ${who}`, '', message];
  return putObj(repo, 'commit', Buffer.from(lines.join('\n')));
}
function blob(repo: AnyRec, text: string): string { return putObj(repo, 'blob', Buffer.from(text)); }

// --- store + server ---
const store = new Store();
const server = createServer(async (req, res) => {
  const handled = await handleGraphql(store, req, res);
  if (!handled) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'Not Found' })); }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

async function gql(query: string, variables: AnyRec = {}, token: string | null = 'test-token'): Promise<{ status: number; body: AnyRec }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${base}/api/graphql`, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  return { status: r.status, body: await r.json() as AnyRec };
}
async function gqlRaw(body: unknown, token: string | null = 'test-token'): Promise<{ status: number; body: AnyRec }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${base}/api/graphql`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as AnyRec };
}

// --- seed: one repo + 3 issues (2 open, 1 closed) + branches/PR ---
const repo = store.createRepo(store.viewerLogin, 'demo');
const baseBlob = blob(repo, 'hello\n');
const baseTree = makeTree(repo, [{ mode: '100644', name: 'README.md', oid: baseBlob }]);
const baseCommit = makeCommit(repo, baseTree, [], 'first commit');
repo.refs.set('refs/heads/main', baseCommit);
const featBlob = blob(repo, 'feature\n');
const featTree = makeTree(repo, [
  { mode: '100644', name: 'README.md', oid: baseBlob },
  { mode: '100644', name: 'feature.txt', oid: featBlob },
]);
const featCommit = makeCommit(repo, featTree, [baseCommit], 'add feature');
repo.refs.set('refs/heads/feature', featCommit);

function seedIssue(title: string, state: 'open' | 'closed'): AnyRec {
  const issue = store.nextIssueId(repo);
  issue.title = title; issue.body = `body of ${title}`;
  issue.state = state;
  repo.issues.set(issue.number, issue);
  return issue;
}
const i1 = seedIssue('first issue', 'open');
const i2 = seedIssue('second issue', 'open');
const i3 = seedIssue('third issue', 'closed');
const pr = store.nextPullId(repo);
pr.title = 'add feature'; pr.body = 'pr body'; pr.headRef = 'feature'; pr.baseRef = 'main';
pr.headSha = featCommit; pr.baseSha = baseCommit;
repo.pulls.set(pr.number, pr);

try {
  // 401 no token / wrong token
  let r = await gql(`{ viewer { login } }`, {}, null);
  eq(r.status, 401, 'no token -> 401');
  r = await gql(`{ viewer { login } }`, {}, 'wrong');
  eq(r.status, 401, 'wrong token -> 401');

  // non-graphql path returns false (404 from wrapper)
  const notFound = await fetch(`${base}/other`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
  eq(notFound.status, 404, 'non-graphql path not handled');

  // viewer
  r = await gql(`query ViewerLogin { viewer { login } }`);
  eq(r.status, 200, 'viewer status 200');
  eq(r.body.data.viewer.login, 'adaiversen', 'viewer login');

  // repository fields
  r = await gql(`query RepositoryFields($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id databaseId name nameWithOwner
      owner { login }
      defaultBranchRef { name }
      viewerPermission hasIssuesEnabled
    } }`, { owner: 'adaiversen', name: 'demo' });
  const repoData = r.body.data.repository;
  check(typeof repoData.id === 'string' && repoData.id !== String(repoData.databaseId), 'repo id opaque and != databaseId', JSON.stringify(repoData));
  eq(repoData.databaseId, repo.id, 'repo databaseId');
  eq(repoData.name, 'demo', 'repo name');
  eq(repoData.nameWithOwner, 'adaiversen/demo', 'repo nameWithOwner');
  eq(repoData.owner.login, 'adaiversen', 'repo owner.login');
  eq(repoData.defaultBranchRef.name, 'main', 'repo defaultBranchRef.name');
  eq(repoData.viewerPermission, 'ADMIN', 'repo viewerPermission');
  eq(repoData.hasIssuesEnabled, true, 'repo hasIssuesEnabled');
  const repoId = repoData.id as string;

  // issues orderBy CREATED_AT DESC, states [OPEN]
  r = await gql(`query OpenIssues($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
        nodes { number title state id } } } }`, { owner: 'adaiversen', name: 'demo', first: 10 });
  const nums = r.body.data.repository.issues.nodes.map((n: AnyRec) => n.number);
  eq(nums, [i2.number, i1.number], 'issues DESC omits closed, numbers descending');
  check(r.body.data.repository.issues.nodes.every((n: AnyRec) => n.state === 'OPEN'), 'issues all OPEN');

  // issue(number) round-trip
  r = await gql(`query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { issue(number: $number) { number title state id body } } }`,
    { owner: 'adaiversen', name: 'demo', number: i1.number });
  eq(r.body.data.repository.issue.number, i1.number, 'issue(number) number');
  eq(r.body.data.repository.issue.title, 'first issue', 'issue(number) title');
  eq(r.body.data.repository.issue.state, 'OPEN', 'issue(number) state');
  eq(r.body.data.repository.issue.body, 'body of first issue', 'issue(number) body');
  const issue1Id = r.body.data.repository.issue.id as string;

  // unknown repo -> null, no errors
  r = await gql(`query RepositoryFields($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { id name } }`, { owner: 'adaiversen', name: 'nope' });
  eq(r.body.data.repository, null, 'unknown repo -> null');
  check(!r.body.errors, 'unknown repo -> no errors');

  // unknown field -> 200 with errors naming the field
  r = await gql(`query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }`);
  eq(r.status, 200, 'unknown field status 200');
  check(Array.isArray(r.body.errors) && r.body.errors.some((e: AnyRec) => String(e.message).includes('noSuchFieldOnViewer')), 'unknown field errors name field', JSON.stringify(r.body.errors));

  // node(id:) with inline fragment
  r = await gql(`query NodeRepository($id: ID!) { node(id: $id) { id ... on Repository { name nameWithOwner } } }`, { id: repoId });
  eq(r.body.data.node.name, 'demo', 'node repository name');
  eq(r.body.data.node.nameWithOwner, 'adaiversen/demo', 'node repository nameWithOwner');
  eq(r.body.data.node.id, repoId, 'node repository id stable');

  // batch of 2 in order
  const batch = await gqlRaw([
    { query: `query ViewerLogin { viewer { login } }`, variables: {} },
    { query: `query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }`, variables: {} },
  ]);
  eq(batch.status, 200, 'batch status 200');
  check(Array.isArray(batch.body) && batch.body.length === 2, 'batch returns 2 results');
  eq(batch.body[0].data.viewer.login, 'adaiversen', 'batch[0] viewer');
  check(batch.body[1].data.Issue.fields.some((f: AnyRec) => f.name === 'title'), 'batch[1] introspection');

  // pagination: separate repo with exactly 7 issues
  const pageRepo = store.createRepo(store.viewerLogin, 'pages');
  for (let k = 1; k <= 7; k += 1) {
    const iss = store.nextIssueId(pageRepo);
    iss.title = `page ${k}`; iss.body = 'b';
    pageRepo.issues.set(iss.number, iss);
  }
  const pageQ = `query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) { issues(first: $first, after: $after) {
      nodes { number } pageInfo { hasNextPage endCursor } } } }`;
  r = await gql(pageQ, { owner: 'adaiversen', name: 'pages', first: 5, after: null });
  eq(r.body.data.repository.issues.nodes.map((n: AnyRec) => n.number), [1, 2, 3, 4, 5], 'pagination page1 numbers');
  eq(r.body.data.repository.issues.pageInfo.hasNextPage, true, 'pagination page1 hasNextPage');
  const cursor = r.body.data.repository.issues.pageInfo.endCursor as string;
  check(typeof cursor === 'string' && cursor.length > 0, 'pagination page1 endCursor non-empty');
  r = await gql(pageQ, { owner: 'adaiversen', name: 'pages', first: 5, after: cursor });
  eq(r.body.data.repository.issues.nodes.map((n: AnyRec) => n.number), [6, 7], 'pagination page2 numbers');
  eq(r.body.data.repository.issues.pageInfo.hasNextPage, false, 'pagination page2 hasNextPage false');

  // PR list + files
  r = await gql(`query PullRequests($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) { pullRequests(first: $first) {
      nodes { number headRefName baseRefName mergeable state } } } }`, { owner: 'adaiversen', name: 'demo', first: 5 });
  const prNode = r.body.data.repository.pullRequests.nodes[0];
  eq(prNode.number, pr.number, 'PR list number');
  eq(prNode.headRefName, 'feature', 'PR list headRefName');
  eq(prNode.baseRefName, 'main', 'PR list baseRefName');
  eq(prNode.state, 'OPEN', 'PR list state');
  eq(prNode.mergeable, 'MERGEABLE', 'PR list mergeable');
  r = await gql(`query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      number files(first: 10) { nodes { path } } } } }`, { owner: 'adaiversen', name: 'demo', number: pr.number });
  eq(r.body.data.repository.pullRequest.files.nodes.map((n: AnyRec) => n.path), ['feature.txt'], 'PR files paths');

  // createIssue mutation, then store check
  r = await gql(`mutation IssueCreate($input: CreateIssueInput!) {
    createIssue(input: $input) { issue { number id } } }`,
    { input: { repositoryId: repoId, title: 'graphql created', body: 'created body' } });
  const createdNum = r.body.data.createIssue.issue.number as number;
  check(typeof createdNum === 'number' && createdNum > 0, 'createIssue returns number');
  const createdIssue = repo.issues.get(createdNum);
  check(!!createdIssue && createdIssue.state === 'open' && createdIssue.title === 'graphql created', 'createIssue in store, open');

  // closeIssue mutation
  r = await gql(`mutation IssueClose($input: CloseIssueInput!) {
    closeIssue(input: $input) { issue { number id state } } }`, { input: { issueId: issue1Id } });
  eq(r.body.data.closeIssue.issue.state, 'CLOSED', 'closeIssue returns CLOSED');
  eq(repo.issues.get(i1.number)?.state, 'closed', 'closeIssue in store closed');

  // addComment mutation
  r = await gql(`mutation AddComment($input: AddCommentInput!) {
    addComment(input: $input) { commentEdge { node { id body } } } }`,
    { input: { subjectId: issue1Id, body: 'hello comment' } });
  eq(r.body.data.addComment.commentEdge.node.body, 'hello comment', 'addComment echoes body');
  check([...repo.comments.values()].some((c: AnyRec) => c.body === 'hello comment' && c.issueNumber === i1.number), 'addComment in store');

  // createPullRequest + mergePullRequest (new branch off main)
  const feat2Blob = blob(repo, 'second\n');
  const feat2Tree = makeTree(repo, [
    { mode: '100644', name: 'README.md', oid: baseBlob },
    { mode: '100644', name: 'second.txt', oid: feat2Blob },
  ]);
  const feat2Commit = makeCommit(repo, feat2Tree, [baseCommit], 'add second');
  repo.refs.set('refs/heads/feature2', feat2Commit);
  r = await gql(`mutation PullRequestCreate($input: CreatePullRequestInput!) {
    createPullRequest(input: $input) { pullRequest { number id state headRefName baseRefName } } }`,
    { input: { repositoryId: repoId, baseRefName: 'main', headRefName: 'feature2', title: 'second pr' } });
  const pr2Num = r.body.data.createPullRequest.pullRequest.number as number;
  eq(r.body.data.createPullRequest.pullRequest.state, 'OPEN', 'createPullRequest OPEN');
  eq(r.body.data.createPullRequest.pullRequest.headRefName, 'feature2', 'createPullRequest head');
  const pr2 = repo.pulls.get(pr2Num);
  check(!!pr2 && pr2.headSha === feat2Commit && pr2.baseSha === baseCommit, 'createPullRequest in store with shas');
  const pr2Id = r.body.data.createPullRequest.pullRequest.id as string;
  r = await gql(`mutation MergePullRequest($input: MergePullRequestInput!) {
    mergePullRequest(input: $input) { pullRequest { number merged state } } }`,
    { input: { pullRequestId: pr2Id, mergeMethod: 'SQUASH' } });
  eq(r.body.data.mergePullRequest.pullRequest.merged, true, 'mergePullRequest merged true');
  eq(r.body.data.mergePullRequest.pullRequest.state, 'CLOSED', 'mergePullRequest state CLOSED');
  check(pr2?.merged === true && pr2?.state === 'closed', 'mergePullRequest in store merged+closed');
  check(!!pr2?.mergeCommitSha, 'mergePullRequest merge commit sha set');
  check(repo.refs.get('refs/heads/main') === pr2?.mergeCommitSha, 'merge moves base ref to merge commit');

  // introspection: Issue / PullRequest / Repository / SearchType
  r = await gql(`query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }`);
  const issueFields = r.body.data.Issue.fields.map((f: AnyRec) => f.name);
  for (const want of ['id', 'number', 'title', 'state', 'body']) check(issueFields.includes(want), `Issue introspection has ${want}`);
  r = await gql(`query PullRequestAndRepositoryFields {
    PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } }
    Repository: __type(name: "Repository") { fields(includeDeprecated: true) { name } } }`);
  const prFields = r.body.data.PullRequest.fields.map((f: AnyRec) => f.name);
  for (const want of ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files']) check(prFields.includes(want), `PullRequest introspection has ${want}`);
  const repoFields = r.body.data.Repository.fields.map((f: AnyRec) => f.name);
  for (const want of ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']) check(repoFields.includes(want), `Repository introspection has ${want}`);
  r = await gql(`query SearchType_enumValues { SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } } }`);
  check(r.body.data.SearchType.enumValues.map((f: AnyRec) => f.name).includes('ISSUE'), 'SearchType enumValues includes ISSUE');
  r = await gql(`query UnknownType { Nope: __type(name: "NoSuchType") { name } }`);
  eq(r.body.data.Nope, null, 'unknown __type -> null');
  check(!r.body.errors, 'unknown __type -> no errors');
} finally {
  server.close();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
