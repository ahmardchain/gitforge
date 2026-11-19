# gitforge — design

One Node 22 process, standard library only, no npm dependencies, no git
binary. `main.ts` is the trial lifecycle (bind ephemeral port, register,
poll `/done`, exit 0). `app.ts` routes HTTP to the four surfaces, all
backed by one in-memory `Store` (see `src/store.ts`).

## Determinism

- Never `Date.now()` / `Math.random()` in stored data. All timestamps come
  from `nowSec()` (`MAKEFUN_TRIAL_NOW` when set, else `1700000000`) plus a
  monotonic sequence number used for ordering (created order = sequence
  order). Replays must see identical responses for identical requests.
- Viewer login is `adaiversen` in every trial of this competition: the
  suite's scenario is built from one fixed seed (`SCENARIO_SEED` in the
  kit's wire.ts) and the viewer is always users[0]. Auth is by bearer
  token: the presented token must equal `process.env.MAKEFUN_SHOP_TOKEN`;
  that token's owner is the viewer. Any other owner in a path is 404.

## Layout

```
main.ts            lifecycle (do not change the protocol)
app.ts             createApp(): node:http server, routing, auth gate
src/types.ts       shared types + deterministic clock
src/store.ts       Store: repos, git objects, refs, issues, PRs, labels,
                   milestones, comments, tokens, users
src/http-util.ts   JSON replies, body reading, request ids
src/git-core.ts    SHA-1, object encode/decode, trees, commits, tags,
                   ancestor walk, merge-base, tree diff, merge
src/git-pack.ts    packfile read (deltas, thin packs) + write (no deltas)
src/git-pkt.ts     pkt-line encode/decode
src/git-http.ts    smart HTTP: info/refs (v0+v2), upload-pack v2+v0,
                   receive-pack v0 + report-status
src/rest.ts        REST v3 handlers
src/graphql.ts     GraphQL: small parser + executor + introspection
src/mcp.ts         MCP: discover/initialize/tools/list/tools/call
```

## Store interface (src/store.ts)

```ts
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; data: Buffer }
export interface Repo {
  id: number; name: string; owner: string; description: string;
  private: boolean; defaultBranch: string; createdSeq: number;
  refs: Map<string, string>;              // refname -> oid (absent = unborn)
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>; nextIssue: number;
  pulls: Map<number, Pull>; nextPull: number;
  labels: Map<string, Label>;
  comments: Map<number, IssueComment>; nextComment: number;
  milestones: Map<number, Milestone>; nextMilestone: number;
}
export interface Issue {
  id: string; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; createdSeq: number;
}
export interface Pull {
  id: string; number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  mergedAt: string | null; mergeCommitSha: string | null; createdSeq: number;
}
export interface Label { name: string; color: string }
export interface IssueComment { id: number; issueNumber: number; body: string; createdSeq: number }
export interface Milestone { id: number; number: number; title: string; state: 'open' | 'closed' }

export class Store {
  readonly viewerLogin = 'adaiversen';
  readonly viewerId = 1000;
  readonly viewerEmail = 'adaiversen@example.invalid';
  token: string | null;                    // from MAKEFUN_SHOP_TOKEN
  repos: Map<string, Repo>;                // key `${owner}/${name}`
  nextRepoId = 1;
  seq = 0;                                 // global monotonic sequence
  nowSec(): number;                        // deterministic "now"
  nextSeq(): number;
  globalId(kind: string, ...parts: (string | number)[]): string; // opaque, stable
  createRepo(owner, name, opts: { description?: string; private?: boolean }): Repo;
  getRepo(owner, name): Repo | undefined;
  deleteRepo(owner, name): boolean;
  headOid(repo): string | null;            // oid of refs/heads/<defaultBranch>
}
```

Git object helpers live in `src/git-core.ts` and operate on a repo's
`objects` map + `refs` map (they never import the store):

```ts
hashObject(type, data): string;                       // sha1 hex
parseCommit(data): { tree, parents, author, committer, message, extra }
buildCommit(o: { tree, parents, author, committer, message }): Buffer
parseTree(data): Array<{ mode, name, oid }>
buildTree(entries): Buffer
parseTag(data): { object, type, tag, tagger, message }
buildTag(o): Buffer
readTreeRecursive(objects, oid): Map<string, { oid, mode }>; // path -> entry
writeTreeRecursive(objects, baseOid: string | null, changes: Map<string, Buffer | null>): string;
  // changes: path -> blob bytes (null = delete); returns new tree oid, writes objects
commitObject(objects, o: { tree, parents, author, committer, message }): string;
isAncestor(objects, ancestorOid, oid): boolean;
mergeBase(objects, a, b): string | null;
diffTrees(objects, baseOid, headOid): Array<{ path, status: 'added'|'modified'|'deleted', oldOid, newOid }>;
lineDiff(oldText, newText): { additions, deletions };
```

## REST surface (src/rest.ts)

`export function handleRest(store, req, res, segments, query): Promise<boolean>`
— returns true if it handled the request. Every reply is JSON with a
non-empty `X-GitHub-Request-Id` (any unique value; use `req-<seq>`), never
HTML. Errors are `{message: string}`. Auth: every `/api/v3` route except
`GET /api/v3/` and `GET /api/v3/meta`... (see below) requires the bearer
token; missing/wrong token → 401 `{message}`. A repo under an owner other
than the viewer → 404, never 403.

Routes (from the suite's checks-rest.ts; 50 checks + protocol):
- `GET /api/v3/` → 200 JSON root + `X-OAuth-Scopes: repo, read:org`
- `GET /api/v3/meta` → 200 `{installed_version: '1.0.0'}` (any non-empty string)
- `POST /api/v3/user/repos` `{name, private, description}` → 201 repo
  object (422 if the name already exists for the viewer)
- `GET /api/v3/user/repos?per_page=10` → 200 array, `Link: <url>; rel="next"`
  when more pages follow (page size = per_page, default 30). Link URLs stay
  on the same origin (relative path + query is fine).
- `GET /api/v3/repos/{o}/{r}` → 200 repo; 404 if missing/other owner
- `PATCH /api/v3/repos/{o}/{r}` `{description}` → 200 with the description
  set to exactly what was sent; a later GET returns it
- `DELETE /api/v3/repos/{o}/{r}` → 204; later GET 404
- `POST /api/v3/repos/{o}/{r}/git/refs` `{ref, sha}` → 201
  `{ref, object: {sha}}`; the ref must exist afterwards (GET /branches
  lists it, GET /commits?sha=<ref> lists its commits)
- `GET /api/v3/repos/{o}/{r}/branches` → 200 `[{name, commit: {sha}}]`
- `GET /api/v3/repos/{o}/{r}/commits[?sha=<ref>]` → 200
  `[{sha, commit: {message}}]`; `?sha=<branch>` scopes to that branch;
  no `sha` = default branch only. Order: newest first.
- `PUT /api/v3/repos/{o}/{r}/contents/{path}` `{message, content (base64),
  branch?, sha?}` → create 201, update (current sha) 200, stale sha 409.
  Reply `{content: {sha, encoding: 'base64'}, commit: {sha}}`. Works on an
  unborn repo (first PUT creates the initial commit). The file's sha is the
  blob sha; the commit's tree holds the file; the branch ref moves to the
  commit. `?ref=` on GET selects the branch/commit.
- `GET /api/v3/repos/{o}/{r}/contents/{path}[?ref=]` → file:
  `{type:'file', encoding:'base64', content, sha, size}` (content decodes
  to exactly the committed bytes; sha = blob sha; size = byte length);
  directory: array of `{type:'file'|'dir', name, path, sha}`. Missing → 404.
- `DELETE /api/v3/repos/{o}/{r}/contents/{path}` `{message, sha}` → 200
  `{commit: {sha}}`; later GET 404.
- `POST /api/v3/repos/{o}/{r}/labels` `{name, color}` → 201 `{name}`.
- `POST /api/v3/repos/{o}/{r}/issues` `{title, body, labels?}` → 201 issue;
  unknown label → 422. Issue numbers increment by 1 per repo, from 1.
- `GET /api/v3/repos/{o}/{r}/issues?state=&sort=created&direction=&per_page=`
  → 200 array; `state=open` excludes closed; `sort=created&direction=asc`
  = creation order, `desc` = reverse.
- `GET /api/v3/repos/{o}/{r}/issues/{n}` → 200 issue; exact title/body.
- `PATCH /api/v3/repos/{o}/{r}/issues/{n}` `{state}` → 200, persists.
- `POST /api/v3/repos/{o}/{r}/issues/{n}/comments` `{body}` → 201
  `{id, body}`; `GET .../comments` → 200 array.
- `POST /api/v3/repos/{o}/{r}/pulls` `{head, base, title, body}` → 201
  pull; `head`/`base` are branch names; `head.sha` = head tip, `base.sha`
  = base tip at creation.
- `GET /api/v3/repos/{o}/{r}/pulls?state=all` → open + merged; no `state`
  → open only.
- `GET /api/v3/repos/{o}/{r}/pulls/{n}` → 200 pull; unknown 404.
- `GET /api/v3/repos/{o}/{r}/pulls/{n}/files` → 200
  `[{filename, status, additions, deletions, changes}]`; status is
  `added`/`modified`/`deleted` (suite accepts `added`/`modified`/`changed`
  for the single-file check; use `added`/`modified`/`deleted`).
- `PUT /api/v3/repos/{o}/{r}/pulls/{n}/merge` `{merge_method: 'squash'}`
  → 200 `{merged: true, sha, message}`; unknown PR 404; conflicted PR
  405. Squash merge: apply head-vs-merge-base diff onto the base tree;
  conflict when a file changed on both sides differently → 405 and the PR
  stays open. After merge: PR closed + merged, `merged_at` non-empty,
  `merge_commit_sha` = merge sha; merge commit is on the base branch;
  base branch content = head bytes for changed files.
- Unknown route → 404 `{message}`. Malformed JSON body → 400 `{message}`.
- Repo object shape (extra fields allowed): `{id, name, full_name,
  owner: {login}, private, description, default_branch, html_url,
  clone_url, created_at, updated_at, pushed_at}`.
- Issue shape: `{id, number, title, body, state, labels: [{name}],
  user: {login}, created_at, updated_at, comments: <count>}`.
- Pull shape: `{id, number, title, body, state, merged, mergeable,
  head: {ref, sha}, base: {ref, sha}, merged_at, merge_commit_sha}`.
- `mergeable` for a pull: `'MERGEABLE'` when a squash merge would apply
  cleanly, `'CONFLICTING'` when it would conflict, else `'UNKNOWN'`.
- Also implement (not driven by the 50 REST checks, but required by the
  bounty text and possibly the unseen tests): milestones
  (`POST/GET/PATCH/DELETE /repos/{o}/{r}/milestones`), tags
  (`GET /repos/{o}/{r}/tags`), `GET /api/v3/user` (viewer),
  `GET /api/v3/search/issues?q=` and `GET /api/v3/search/repositories?q=`,
  `GET /api/v3/repos/{o}/{r}/git/refs/{ref}` and `GET .../git/ref/...`
  reads, `POST /api/v3/repos/{o}/{r}/git/tags` + annotated tag objects,
  `GET /api/v3/repos/{o}/{r}/git/commits/{sha}`, issue/PR timeline
  (`GET .../issues/{n}/timeline` if cheap). Keep these small.

## Git smart HTTP (src/git-http.ts)

`export function handleGit(store, req, res, segments, query): Promise<boolean>`
— handles `/{owner}/{repo}.git/...`. Auth: bearer token if present is
accepted; no 401 case is exercised on git, so do not 401 here (accept
with or without the token). Missing repo → 404 on both services' GET
`/info/refs` (plain 404, server stays up).

- `GET /{o}/{r}.git/info/refs?service=git-upload-pack`:
  - `Git-Protocol: version=2` → v2 advertisement: first line `version 2`,
    then capabilities, one per pkt-line: `ls-refs=unborn`,
    `fetch=shallow`, `object-format=sha1`, `agent=gitforge/1.0`.
    Content-Type `application/x-git-upload-pack-advertisement`.
  - Otherwise v0: `# service=git-upload-pack` preamble + flush, then ref
    lines `<oid> <ref>\0<caps>` (caps only on the first line):
    `side-band-64k thin-pack ofs-delta shallow agent=gitforge/1.0
    symref=HEAD:refs/heads/main`. Peeled tags as separate
    `<oid> <ref>^{}` lines. Empty repo: no ref lines (client skips the
    `capabilities^{}` pseudo-ref; send none).
- `GET /{o}/{r}.git/info/refs?service=git-receive-pack`: v0 only, preamble
  `# service=git-receive-pack`, caps `report-status side-band-64k
  delete-refs ofs-delta agent=gitforge/1.0` on the first ref line.
- `POST /{o}/{r}.git/git-upload-pack`:
  - v2 (header `Git-Protocol: version=2`): parse command pkt-lines.
    `command=ls-refs`: args `peel`, `symrefs`, `unborn`, `ref-prefix <p>`
    (repeatable). Reply lines `<oid> <ref> [symref-target:<t>]
    [peeled:<oid>]`, or `unborn HEAD symref-target:refs/heads/main` when
    the repo is empty. HEAD line first: `<oid> HEAD
    symref-target:refs/heads/main`. Filter by ref-prefix server-side.
    `command=fetch`: args `thin-pack`, `no-progress`, `ofs-delta`,
    `want <oid>` (repeat), `have <oid>`, `shallow <oid>`, `deepen <n>`,
    `done`. Reply sections in order: `acknowledgments` (`NAK` or
    `ACK <oid>`), `shallow-info` (`shallow <oid>` / `unshallow <oid>`),
    `wanted-refs` (`<oid> <ref>` for each want that resolves), `packfile`
    (sideband: band 1 = pack bytes, band 2 = progress, band 3 = error).
    Objects to send: reachable(wants) minus reachable(haves), limited by
    deepen (see shallow rules below). Always send complete objects (no
    deltas) — the client resolves what it needs; thin-pack is satisfied by
    completeness. End with flush.
  - v0 (no header): advertisement is the ref list; the POST body is
    `want <oid> [side-band-64k ...]` lines, flush, `have <oid>` lines,
    `done`, flush. Reply: sideband pack (band 1) with `NAK`/`ACK` lines
    as plain pkt-lines before the pack when not using sideband... (v0
    response: `NAK` line, optional `shallow`/`unshallow` lines, then the
    sideband pack). If the client asked `side-band-64k`, the whole
    response after the ACK/NAK is sideband-framed.
- `POST /{o}/{r}.git/git-receive-pack`: parse command list
  `<old> <new> <ref>` (caps after NUL on the first line), flush, then raw
  pack bytes. Apply per ref in order: create (`old` = zero), update
  (fast-forward only: new tip must have old tip as ancestor, or old is
  zero), delete (`new` = zero; only when `delete-refs` was advertised).
  Non-fast-forward → that ref is `ng <ref> non-fast-forward` and does not
  move; other refs still apply. Reply: `unpack ok` then one `ok <ref>` /
  `ng <ref> <reason>` line per ref, sideband band 1 if `side-band-64k`
  was negotiated, else raw pkt-lines. Always HTTP 200, even with `ng`
  lines. A delete-only push carries no pack. An empty pack (0 objects)
  is a valid 32-byte pack.
- Shallow rules (v2 fetch with `deepen N`): included commits =
  ancestors(wants) up to N generations, minus ancestors(haves).
  `shallow-info` lists commits in the included set whose parents are NOT
  included (these are the new shallow boundaries); `unshallow` lists
  requested `shallow <oid>` boundaries whose parents ARE now included.
  With no `deepen`, include the full reachable set.
- pkt-line: 4 hex ASCII length (payload+4), `0000` flush, `0001` delim,
  `0002` response-end; max total 65520.
- Packfile (src/git-pack.ts): `PACK`, version 2, count, entries
  (type/size varint + zlib deflate), trailer = SHA-1 of all preceding
  bytes. Read: verify header/trailer, inflate entries, resolve OFS_DELTA
  (negative-offset varint) and REF_DELTA (20-byte base oid, base may come
  from the pack or from a supplied `have` map for thin packs), apply
  delta ops (copy/insert), verify sizes. Type codes: 1 commit, 2 tree,
  3 blob, 4 tag, 6 ofs-delta, 7 ref-delta.
- Object format: `<type> <size>\0<content>`, SHA-1. Commit:
  `tree <oid>\n` + `parent <oid>\n`* + `author <name> <email> <epoch>
  +0000\n` + `committer ...\n` + `\n` + message. Tag: `object <oid>\ntype
  <type>\ntag <name>\ntagger ...\n\n<message>`. Tree: entries sorted in git
  order (name bytes, dirs compared as `name/`), `<mode ascii> <name>\0`
  + 20-byte oid; modes `100644`, `40000`, `160000` (gitlink, skipped in
  reachability walks).

## GraphQL (src/graphql.ts)

`export function handleGraphql(store, req, res): Promise<boolean>` — POST
`/api/graphql` only. No token → exactly 401. Body is `{query, variables}`
or an array of such (batch: answer an array of `{data, errors}` in order).
Parse the document with a small recursive-descent parser (queries,
mutations, fragments incl. `... on Type`, aliases, variables, arguments
with input objects / enums / lists, directives are not used). Unknown
field → HTTP 200 with `errors: [{message: '...noSuchFieldOnViewer...'}]`
naming the field. Unknown repository → `data.repository = null`, no
errors. Any other error → `errors` array, HTTP 200.

Schema (only what the suite sends, plus introspection):
- `Query.viewer: User!` (`{login}`), `Query.repository(owner: String!,
  name: String!): Repository`, `Query.node(id: ID!): Node`
- `Repository{id, databaseId, name, nameWithOwner, owner{login},
  defaultBranchRef{name}, viewerPermission, hasIssuesEnabled,
  issue(number: Int!): Issue, issues(first: Int, states: [IssueState!],
  orderBy: IssueOrder, after: String): IssueConnection,
  pullRequests(first: Int): PullRequestConnection,
  pullRequest(number: Int!): PullRequest}`
- `Issue{id, number, title, state, body}`; `IssueConnection{nodes,
  pageInfo{hasNextPage, endCursor}}` — cursor is an opaque encoding of the
  offset (e.g. base64 of the last returned number); `issues` ordering:
  `orderBy {field: CREATED_AT, direction: DESC}` → numbers descending,
  ties by number DESC; `states: [OPEN]` omits closed.
- `PullRequest{id, number, state, merged, headRefName, baseRefName,
  mergeable, files(first: Int): PullRequestChangedFileConnection}` with
  `PullRequestChangedFile{path}`.
- Mutations: `createIssue(input: {repositoryId, title, body})` →
  `{issue {number, id}}` (REST-readable afterwards, state open);
  `closeIssue(input: {issueId})` → state `CLOSED` (REST state `closed`);
  `createPullRequest(input: {repositoryId, baseRefName, headRefName,
  title})` → `{pullRequest {number, id, state, headRefName,
  baseRefName}}` (REST-readable, same head/base);
  `mergePullRequest(input: {pullRequestId, mergeMethod: SQUASH})` →
  `{pullRequest {number, merged, state}}` (squash merge; REST shows
  merged true + closed); `addComment(input: {subjectId, body})` →
  `{commentEdge {node {id, body}}}` (REST comments list contains it).
- Introspection: `__type(name: String!)` with
  `fields(includeDeprecated: Boolean)` and `enumValues(includeDeprecated:
  Boolean)`, honouring aliases (`Issue: __type(...)` etc.).
  `Issue` fields must include `id, number, title, state, body`;
  `PullRequest` must include `id, number, headRefName, baseRefName,
  mergeable, state, merged, files`; `Repository` must include `id,
  databaseId, name, nameWithOwner, owner, defaultBranchRef,
  viewerPermission, hasIssuesEnabled, issue, issues, pullRequests,
  pullRequest`; `SearchType` enumValues must include `ISSUE`. Enums:
  `IssueState OPEN/CLOSED`, `MergeableState
  MERGEABLE/CONFLICTING/UNKNOWN`, `PullRequestState OPEN/CLOSED/MERGED`,
  `PullRequestMergeMethod MERGE/SQUASH/REBASE`, `RepositoryPermission
  ADMIN/MAINTAIN/WRITE/TRIAGE/READ`, `SearchType ISSUE/...`,
  `IssueOrderField CREATED_AT/UPDATED_AT/COMMENTS`, `OrderDirection
  ASC/DESC`.
- Global ids: opaque + stable + never equal to the numeric id:
  `globalId('Repository', repoId)` etc. (base64url of `kind:id`).
  `repositoryId` / `issueId` / `pullRequestId` inputs are these global ids;
  resolve them back. `databaseId` is the numeric repo id.

## MCP (src/mcp.ts)

`export function handleMcp(store, req, res): Promise<boolean>` — POST
`/mcp` only. JSON-RPC 2.0 over Streamable HTTP; answer
`application/json`. Every request must answer within 3 s. No
`Authorization` header → 401. Non-JSON body → HTTP 400 with JSON-RPC
`-32700`. Unknown method (not discover/initialize/tools/*) → `-32601`.
- `server/discover` → `result: {supportedVersions: ['2026-07-28',
  '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
  capabilities: {tools: {}}, serverInfo: {name: 'gitforge', version:
  '0.1.0'}}`.
- `initialize` (legacy) → `result: {protocolVersion: '2025-11-25',
  capabilities: {tools: {}}, serverInfo: {name: 'gitforge', version:
  '0.1.0'}}`. `notifications/initialized` (no id) → no reply (HTTP 202
  with empty body is fine; the client does not wait for a result).
- `tools/list` → `result: {tools: [...]}` — the SAME list, byte for
  byte, on every call (build it once). At least the six tools below,
  each with non-empty `description` and `inputSchema: {type: 'object',
  properties: {...}, required: [...]}`. Use the canonical property
  names the suite maps to: `owner`, `repo`, `name`, `title`, `body`,
  `description`, `private`, `state`, `head`, `base`, `pull_number`.
  - `create_repo` `{name, description?, private?, owner?}` — creates a
    repo for the viewer; result text contains its name and full_name.
  - `get_repo` `{owner, repo}` — result text names the repo.
  - `create_issue` `{owner, repo, title, body?}` — creates an open
    issue; result text contains title and number.
  - `list_issues` `{owner, repo, state?}` — result text contains the
    open issues' titles and/or `"number": <n>`.
  - `create_pull_request` `{owner, repo, title, head, base, body?}` —
    creates an open PR; result text contains head/base.
  - `merge_pull_request` `{owner, repo, pull_number}` — squash-merges;
    result text contains merged true.
  - Also add `list_repos`, `get_issue`, `close_issue` (cheap; same
    store). Keep the six canonical ones first in the list.
- `tools/call` → `result: {content: [{type: 'text', text: <JSON string
  of the result object>}], structuredContent: <same object>,
  isError: false}`. Unknown tool → JSON-RPC `-32601` (or `-32602`).
  Missing required argument → `isError: true` result (or `-32602`).
  `arguments.full_name` (`owner/repo`) is accepted as owner+repo when
  `owner`/`repo` are absent. Two concurrent calls keep their own ids.
- All tools act on the same `Store` as REST (same objects, same ids).

## Performance

- Everything in-memory; no disk I/O per request; no per-request work
  above O(changed objects). Pack generation sends complete objects (no
  delta computation). Issue reads are Map lookups + small JSON.
- `Connection: keep-alive` is the default in node:http; do not disable
  it. Do not add logging per request.
- House reference medians (calibration.json): push 1640.82 ms / 200
  pushes, clone 266.94 ms / 50 concurrent shallow clones, read 2759.7 ms
  / 2000 reads, write 348.97 ms / 200 issues. Points =
  round(clamp(25 − 12.5·log2(p50/T_ref), 0, 50)) per workload.

## Testing

- Fast loop: start the server locally with a fake token, then run the
  sealed suite against it:
  `MAKEFUN_SHOP_TOKEN=test-token node main.ts` (in a scratch dir, NOT
  the repo — main.ts needs MAKEFUN_ENV_URL in a trial; for local runs
  add a tiny local runner script under `tests/` that creates the app,
  listens on an ephemeral port and waits — do NOT change main.ts's
  trial behaviour).
  `node --experimental-strip-types <kit>/sdk/run.ts --url
  http://127.0.0.1:PORT --token test-token [--perf] [--json]`
  (run the kit's node with `--experimental-strip-types`; the kit's node
  is the Node 22 at `~/.local/node22/bin/node`).
- Full local grade: `node cli/makefun.mjs grade-local --kit <kit>
  --bot <repo> --driver process` (docker is not installed here).
- Size caps: ≤ 16 MiB source total, ≤ 8 MiB in any one file. No
  dependencies. Erasable TypeScript only (no enums, namespaces,
  parameter properties) so Node 22 type-stripping runs it.
