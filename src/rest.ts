// REST v3 handlers for gitforge.
//
// NOTE: src/git-core.ts does not exist in this checkout yet (it is being
// written in parallel), so the git object helpers this surface needs are
// implemented locally in this file, exactly as DESIGN.md specifies them
// (SHA-1 object ids, tree/commit encode/decode, recursive tree read/write,
// ancestor walk, merge-base, tree diff, line diff). If git-core.ts lands,
// these locals can be swapped for imports without changing behaviour.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import type { GitObject, Issue, ObjType, Pull, Repo } from './types.ts';
import { bearerToken, nextRequestId, pathOf, queryOf, readJsonBody, segmentsOf, sendError, sendJson } from './http-util.ts';

// ---------------------------------------------------------------------------------------------
// Local git object helpers (see header note)
// ---------------------------------------------------------------------------------------------

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function hashObject(type: ObjType, data: Buffer): string {
  return sha1Hex(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}

interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  let message = split === -1 ? '' : text.slice(split + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  const out: CommitParts = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

function buildCommit(o: CommitParts): Buffer {
  let text = `tree ${o.tree}\n`;
  for (const parent of o.parents) text += `parent ${parent}\n`;
  text += `author ${o.author}\ncommitter ${o.committer}\n\n${o.message}`;
  return Buffer.from(text, 'utf8');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface TagParts {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

function parseTag(data: Buffer): TagParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  let message = split === -1 ? '' : text.slice(split + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  const out: TagParts = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4);
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

function buildTag(o: TagParts): Buffer {
  return Buffer.from(`object ${o.object}\ntype ${o.type}\ntag ${o.tag}\ntagger ${o.tagger}\n\n${o.message}`, 'utf8');
}

function readTreeRecursive(objects: Map<string, GitObject>, oid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const obj = objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(oid, '');
  return out;
}

/** Find the tree oid of a directory inside a tree, or null. */
function findTreeOid(objects: Map<string, GitObject>, rootOid: string, dirPath: string): string | null {
  if (dirPath === '') return rootOid;
  let current = rootOid;
  for (const segment of dirPath.split('/')) {
    const obj = objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segment && e.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

function writeTreeRecursive(
  objects: Map<string, GitObject>,
  baseOid: string | null,
  changes: Map<string, Buffer | null>,
): string {
  const flat = baseOid === null ? new Map<string, { oid: string; mode: string }>() : readTreeRecursive(objects, baseOid);
  for (const [path, bytes] of changes) {
    if (bytes === null) {
      flat.delete(path);
    } else {
      const oid = hashObject('blob', bytes);
      objects.set(oid, { type: 'blob', data: bytes });
      const existing = flat.get(path);
      flat.set(path, { oid, mode: existing?.mode ?? '100644' });
    }
  }
  const buildDir = (prefix: string): string => {
    const groups = new Map<string, { leaf: { oid: string; mode: string } | null; sub: string[] }>();
    for (const [path, entry] of flat) {
      if (prefix !== '' && !path.startsWith(prefix)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        groups.set(rest, { leaf: entry, sub: [] });
      } else {
        const dir = rest.slice(0, slash);
        const existing = groups.get(dir);
        if (existing === undefined) groups.set(dir, { leaf: null, sub: [rest] });
        else existing.sub.push(rest);
      }
    }
    const entries: TreeEntry[] = [];
    for (const [name, group] of groups) {
      if (group.leaf !== null) {
        entries.push({ mode: group.leaf.mode, name, oid: group.leaf.oid });
      } else {
        entries.push({ mode: '40000', name, oid: buildDir(`${prefix}${name}/`) });
      }
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return buildDir('');
}

function commitObject(objects: Map<string, GitObject>, o: CommitParts): string {
  const data = buildCommit(o);
  const oid = hashObject('commit', data);
  objects.set(oid, { type: 'commit', data });
  return oid;
}

function commitParents(objects: Map<string, GitObject>, oid: string): string[] {
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return [];
  return parseCommit(obj.data).parents;
}

function isAncestor(objects: Map<string, GitObject>, ancestorOid: string, oid: string): boolean {
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === ancestorOid) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of commitParents(objects, current)) stack.push(parent);
  }
  return false;
}

function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const current = stackA.pop() as string;
    if (ancestorsA.has(current)) continue;
    ancestorsA.add(current);
    for (const parent of commitParents(objects, current)) stackA.push(parent);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (ancestorsA.has(current)) return current;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of commitParents(objects, current)) queue.push(parent);
  }
  return null;
}

interface TreeDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oldOid: string | null;
  newOid: string | null;
}

function diffTrees(objects: Map<string, GitObject>, baseOid: string | null, headOid: string | null): TreeDiff[] {
  const base = baseOid === null ? new Map() : readTreeRecursive(objects, baseOid);
  const head = headOid === null ? new Map() : readTreeRecursive(objects, headOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: TreeDiff[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      out.push({ path, status: 'deleted', oldOid: oldEntry.oid, newOid: null });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return out;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  // LCS over lines (files in the suite are small).
  const dp: number[][] = [];
  for (let i = 0; i <= oldLines.length; i += 1) dp.push(new Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function asStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStrArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).name === 'string') {
      out.push((item as Record<string, unknown>).name as string);
    }
  }
  return out;
}

const SHA40 = /^[0-9a-f]{40}$/i;

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function authorLine(store: Store): string {
  return `${store.viewerLogin} <${store.viewerEmail}> ${store.nowSec()} +0000`;
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const now = store.nowIso();
  return {
    id: repo.id,
    node_id: store.globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.viewerId, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    created_at: now,
    updated_at: now,
    pushed_at: now,
  };
}

function issueCommentsCount(repo: Repo, number: number): number {
  let count = 0;
  for (const comment of repo.comments.values()) {
    if (comment.issueNumber === number) count += 1;
  }
  return count;
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const now = store.nowIso();
  return {
    id: issue.id,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: store.viewerLogin, id: store.viewerId, type: 'User' },
    created_at: now,
    updated_at: now,
    comments: issueCommentsCount(repo, issue.number),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** Resolve a ref-ish (branch name, full ref, tag, or oid) to a commit oid, or null. */
function resolveToCommit(repo: Repo, ref: string): string | null {
  let oid: string | undefined;
  if (repo.refs.has(ref)) oid = repo.refs.get(ref);
  else if (repo.refs.has(`refs/heads/${ref}`)) oid = repo.refs.get(`refs/heads/${ref}`);
  else if (repo.refs.has(`refs/tags/${ref}`)) oid = repo.refs.get(`refs/tags/${ref}`);
  else if (SHA40.test(ref) && repo.objects.has(ref)) oid = ref;
  else if (ref === 'HEAD') oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (oid === undefined) return null;
  const obj = repo.objects.get(oid);
  if (obj === undefined) return null;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') return parseTag(obj.data).object;
  return null;
}

function tipOf(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function commitTreeOid(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function walkCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(current);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const parts = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const date = store.nowIso();
  const author = parts !== null && parts.author !== '' ? parts.author : authorLine(store);
  const nameEmail = /^([^<]*)<([^>]*)>/.exec(author);
  const authorName = (nameEmail?.[1] ?? store.viewerLogin).trim();
  const authorEmail = nameEmail?.[2] ?? store.viewerEmail;
  return {
    sha: oid,
    commit: {
      message: parts?.message ?? '',
      author: { name: authorName, email: authorEmail, date },
      committer: { name: authorName, email: authorEmail, date },
      tree: { sha: parts?.tree ?? '' },
    },
    author: { login: store.viewerLogin },
    committer: { login: store.viewerLogin },
    parents: (parts?.parents ?? []).map((sha) => ({ sha })),
    tree: { sha: parts?.tree ?? '' },
  };
}

interface SquashPlan {
  conflict: boolean;
  changes: Map<string, Buffer | null>;
  baseTreeOid: string | null;
  mergeBaseOid: string | null;
}

function squashPlan(repo: Repo, headTip: string, baseTip: string): SquashPlan {
  const mb = mergeBase(repo.objects, headTip, baseTip);
  const mbTree = mb === null ? null : commitTreeOid(repo, mb);
  const headTree = commitTreeOid(repo, headTip);
  const baseTree = commitTreeOid(repo, baseTip);
  const headDiff = diffTrees(repo.objects, mbTree, headTree);
  const baseDiff = diffTrees(repo.objects, mbTree, baseTree);
  const baseByPath = new Map(baseDiff.map((d) => [d.path, d]));
  let conflict = false;
  const changes = new Map<string, Buffer | null>();
  for (const entry of headDiff) {
    const other = baseByPath.get(entry.path);
    if (other !== undefined && other.newOid !== entry.newOid) conflict = true;
    if (entry.newOid === null) {
      changes.set(entry.path, null);
    } else {
      const blob = repo.objects.get(entry.newOid);
      changes.set(entry.path, blob !== undefined && blob.type === 'blob' ? blob.data : Buffer.alloc(0));
    }
  }
  return { conflict, changes, baseTreeOid: baseTree, mergeBaseOid: mb };
}

function pullMergeable(store: Store, repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headTip = tipOf(repo, pull.headRef) ?? (pull.headSha !== '' ? pull.headSha : null);
  const baseTip = tipOf(repo, pull.baseRef) ?? (pull.baseSha !== '' ? pull.baseSha : null);
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  if (!repo.objects.has(headTip) || !repo.objects.has(baseTip)) return 'UNKNOWN';
  return squashPlan(repo, headTip, baseTip).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const now = store.nowIso();
  return {
    id: pull.id,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pullMergeable(store, repo, pull),
    head: { ref: pull.headRef, sha: pull.headSha, label: `${store.viewerLogin}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${store.viewerLogin}:${pull.baseRef}` },
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: now,
    updated_at: now,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function parsePage(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

/** The absolute origin of this request (http://host), for Link headers: the
 * suite refuses a relative next URL as leaving the entry's origin. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return typeof host === 'string' && host.length > 0 ? `http://${host}` : '';
}

function pageLinkHeader(origin: string, path: string, query: URLSearchParams, perPage: number, page: number, total: number): Record<string, string> {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page >= totalPages) return {};
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `${origin}${path}?${q.toString()}`;
  };
  return { link: `<${build(page + 1)}>; rel="next", <${build(totalPages)}>; rel="last"` };
}

function paginate<T>(items: T[], query: URLSearchParams): { pageItems: T[]; linkHeaders: Record<string, string> } {
  const { perPage, page } = parsePage(query);
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), linkHeaders: {} };
}

// ---------------------------------------------------------------------------------------------
// handleRest
// ---------------------------------------------------------------------------------------------

export async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const query = queryOf(req);
  const segments = segmentsOf(path);
  // segments[0]='api', segments[1]='v3'; the rest is the route.
  const rest = segments.slice(2);

  // Public roots: no auth required.
  if (method === 'GET' && rest.length === 0) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // Auth for everything else under /api/v3.
  const token = bearerToken(req);
  if (store.token === null || token !== store.token) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }

  // Read + validate a JSON body for write methods.
  let body: unknown = null;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendError(res, 400, parsed.error ?? 'malformed JSON body');
      return true;
    }
    body = parsed.value;
  }
  const b = asRecord(body);

  // ---- GET /user ---------------------------------------------------------------
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, {
      login: store.viewerLogin,
      id: store.viewerId,
      node_id: store.globalId('User', store.viewerId),
      type: 'User',
      email: store.viewerEmail,
      name: store.viewerLogin,
      html_url: `https://github.com/${store.viewerLogin}`,
    });
    return true;
  }

  // ---- POST /user/repos, GET /user/repos ---------------------------------------
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = asStr(b.name);
      if (name === undefined || name === '') {
        sendError(res, 422, 'name is required');
        return true;
      }
      if (store.getRepo(store.viewerLogin, name) !== undefined) {
        sendError(res, 422, 'Repository already exists');
        return true;
      }
      const repo = store.createRepo(store.viewerLogin, name, {
        description: asStr(b.description) ?? '',
        private: asBool(b.private) ?? false,
      });
      sendJson(res, 201, repoJson(store, repo));
      return true;
    }
    if (method === 'GET') {
      const all = store.viewerRepos();
      const { perPage, page } = parsePage(query);
      const start = (page - 1) * perPage;
      const pageItems = all.slice(start, start + perPage);
      sendJson(res, 200, pageItems.map((repo) => repoJson(store, repo)), pageLinkHeader(originOf(req), path, query, perPage, page, all.length));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // ---- search -------------------------------------------------------------------
  if (rest.length === 2 && rest[0] === 'search' && (rest[1] === 'issues' || rest[1] === 'repositories') && method === 'GET') {
    const q = query.get('q');
    if (q === null || q.trim() === '') {
      sendError(res, 422, 'q is required');
      return true;
    }
    const needle = q.toLowerCase();
    if (rest[1] === 'repositories') {
      const items = store.viewerRepos().filter((repo) => repo.name.toLowerCase().includes(needle) || repo.description.toLowerCase().includes(needle));
      const { pageItems } = paginate(items, query);
      sendJson(res, 200, { total_count: items.length, incomplete_results: false, items: pageItems.map((repo) => repoJson(store, repo)) });
      return true;
    }
    const items: Record<string, unknown>[] = [];
    for (const repo of store.viewerRepos()) {
      for (const issue of [...repo.issues.values()].sort((x, y) => x.createdSeq - y.createdSeq)) {
        if (issue.title.toLowerCase().includes(needle) || issue.body.toLowerCase().includes(needle)) {
          items.push({ ...issueJson(store, repo, issue), repository_url: `/api/v3/repos/${repo.owner}/${repo.name}` });
        }
      }
    }
    const { pageItems } = paginate(items, query);
    sendJson(res, 200, { total_count: items.length, incomplete_results: false, items: pageItems });
    return true;
  }

  // ---- /repos/{owner}/{repo}/... ------------------------------------------------
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const repoName = rest[2] as string;
    // A repo under any other owner is 404, never 403.
    if (owner !== store.viewerLogin) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    const tail = rest.slice(3);

    // Repo itself: GET / PATCH / DELETE.
    if (tail.length === 0) {
      if (method === 'GET') {
        if (repo === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, repoJson(store, repo));
        return true;
      }
      if (method === 'PATCH') {
        if (repo === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.private = b.private;
        if (typeof b.default_branch === 'string' && b.default_branch !== '') repo.defaultBranch = b.default_branch;
        sendJson(res, 200, repoJson(store, repo));
        return true;
      }
      if (method === 'DELETE') {
        if (repo === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        store.deleteRepo(owner, repoName);
        sendNoContent(res);
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- branches ---------------------------------------------------------------
    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      const out: Record<string, unknown>[] = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      sendJson(res, 200, out);
      return true;
    }

    // ---- commits ----------------------------------------------------------------
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const shaParam = query.get('sha');
      let tip: string | null = null;
      if (shaParam !== null && shaParam !== '') tip = resolveToCommit(repo, shaParam);
      else tip = store.headOid(repo);
      if (shaParam !== null && shaParam !== '' && tip === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (tip === null) {
        sendJson(res, 200, []);
        return true;
      }
      sendJson(res, 200, walkCommits(repo, tip).map((oid) => commitJson(store, repo, oid)));
      return true;
    }

    // ---- contents ---------------------------------------------------------------
    if (tail.length >= 1 && tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      const branch = asStr(b.branch) ?? query.get('branch') ?? repo.defaultBranch;
      if (method === 'PUT') {
        const message = asStr(b.message) ?? '';
        const contentB64 = asStr(b.content);
        if (contentB64 === undefined) {
          sendError(res, 422, 'content is required');
          return true;
        }
        let contentBytes: Buffer;
        try {
          contentBytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        } catch {
          sendError(res, 422, 'content is not valid base64');
          return true;
        }
        const explicitBranch = asStr(b.branch) !== undefined;
        let tip = tipOf(repo, branch);
        if (tip === null && explicitBranch && repo.refs.size > 0) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const baseTree = tip === null ? null : commitTreeOid(repo, tip);
        const flat = baseTree === null ? new Map() : readTreeRecursive(repo.objects, baseTree);
        const existing = flat.get(filePath);
        const givenSha = asStr(b.sha);
        if (existing !== undefined && givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
          sendError(res, 409, 'sha does not match the current file');
          return true;
        }
        const isNew = existing === undefined;
        const changes = new Map<string, Buffer | null>([[filePath, contentBytes]]);
        const newTree = writeTreeRecursive(repo.objects, baseTree, changes);
        const blobSha = hashObject('blob', contentBytes);
        const parents = tip === null ? [] : [tip];
        const commitSha = commitObject(repo.objects, {
          tree: newTree,
          parents,
          author: authorLine(store),
          committer: authorLine(store),
          message,
        });
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        sendJson(res, isNew ? 201 : 200, {
          content: {
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            sha: blobSha,
            size: contentBytes.length,
            encoding: 'base64',
            content: contentBytes.toString('base64'),
            type: 'file',
          },
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'GET') {
        const refParam = query.get('ref');
        const tip = refParam !== null && refParam !== '' ? resolveToCommit(repo, refParam) : store.headOid(repo);
        if (tip === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const treeOid = commitTreeOid(repo, tip);
        if (treeOid === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const flat = readTreeRecursive(repo.objects, treeOid);
        if (filePath === '') {
          const entries = dirListing(repo, treeOid, flat, '');
          sendJson(res, 200, entries);
          return true;
        }
        const fileEntry = flat.get(filePath);
        if (fileEntry !== undefined) {
          const blob = repo.objects.get(fileEntry.oid);
          const bytes = blob !== undefined ? blob.data : Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: bytes.toString('base64'),
            sha: fileEntry.oid,
            size: bytes.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
          });
          return true;
        }
        // Directory?
        const prefix = `${filePath}/`;
        const isDir = [...flat.keys()].some((p) => p.startsWith(prefix));
        if (isDir) {
          sendJson(res, 200, dirListing(repo, treeOid, flat, filePath));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method === 'DELETE') {
        const message = asStr(b.message) ?? '';
        const tip = tipOf(repo, branch);
        if (tip === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const baseTree = commitTreeOid(repo, tip);
        if (baseTree === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const flat = readTreeRecursive(repo.objects, baseTree);
        const existing = flat.get(filePath);
        if (existing === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const givenSha = asStr(b.sha);
        if (givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
          sendError(res, 409, 'sha does not match the current file');
          return true;
        }
        const changes = new Map<string, Buffer | null>([[filePath, null]]);
        const newTree = writeTreeRecursive(repo.objects, baseTree, changes);
        const commitSha = commitObject(repo.objects, {
          tree: newTree,
          parents: [tip],
          author: authorLine(store),
          committer: authorLine(store),
          message,
        });
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- git: refs ---------------------------------------------------------------
    if (tail.length >= 2 && tail[0] === 'git' && (tail[1] === 'refs' || tail[1] === 'ref')) {
      if (tail.length === 2 && method === 'POST') {
        const ref = asStr(b.ref);
        const sha = asStr(b.sha);
        if (ref === undefined || ref === '' || sha === undefined || !SHA40.test(sha)) {
          sendError(res, 422, 'ref and a 40-hex sha are required');
          return true;
        }
        if (!repo.objects.has(sha.toLowerCase())) {
          sendError(res, 422, 'sha does not exist in this repository');
          return true;
        }
        const refName = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
        if (repo.refs.has(refName)) {
          sendError(res, 422, 'ref already exists');
          return true;
        }
        repo.refs.set(refName, sha.toLowerCase());
        const obj = repo.objects.get(sha.toLowerCase());
        sendJson(res, 201, { ref: refName, object: { sha: sha.toLowerCase(), type: obj?.type ?? 'commit' } });
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const out: Record<string, unknown>[] = [];
        for (const [ref, sha] of repo.refs) {
          const obj = repo.objects.get(sha);
          out.push({ ref, object: { sha, type: obj?.type ?? 'commit' } });
        }
        sendJson(res, 200, out);
        return true;
      }
      if (tail.length > 2 && method === 'GET') {
        const refParts = tail.slice(2);
        const joined = refParts.join('/');
        const candidates = joined.startsWith('refs/') ? [joined] : [`refs/${joined}`, `refs/heads/${joined}`, `refs/tags/${joined}`];
        let found: string | undefined;
        for (const candidate of candidates) {
          if (repo.refs.has(candidate)) {
            found = candidate;
            break;
          }
        }
        if (found === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const sha = repo.refs.get(found) as string;
        const obj = repo.objects.get(sha);
        sendJson(res, 200, { ref: found, object: { sha, type: obj?.type ?? 'commit' } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- git: tags ----------------------------------------------------------------
    if (tail.length >= 2 && tail[0] === 'git' && tail[1] === 'tags') {
      if (tail.length === 2 && method === 'POST') {
        const tagName = asStr(b.tag);
        const message = asStr(b.message) ?? '';
        const objectSha = asStr(b.object);
        const objectType = asStr(b.type) ?? 'commit';
        if (tagName === undefined || tagName === '' || objectSha === undefined || !SHA40.test(objectSha)) {
          sendError(res, 422, 'tag and a 40-hex object sha are required');
          return true;
        }
        const target = repo.objects.get(objectSha.toLowerCase());
        if (target === undefined) {
          sendError(res, 422, 'object does not exist in this repository');
          return true;
        }
        const tagData = buildTag({
          object: objectSha.toLowerCase(),
          type: target.type,
          tag: tagName,
          tagger: authorLine(store),
          message,
        });
        const sha = hashObject('tag', tagData);
        repo.objects.set(sha, { type: 'tag', data: tagData });
        sendJson(res, 201, {
          sha,
          tag: tagName,
          message,
          object: { sha: objectSha.toLowerCase(), type: objectType },
          tagger: { name: store.viewerLogin, email: store.viewerEmail, date: store.nowIso() },
          type: objectType,
        });
        return true;
      }
      if (tail.length === 3 && method === 'GET') {
        const sha = tail[2] as string;
        const obj = repo.objects.get(sha);
        if (obj === undefined || obj.type !== 'tag') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const parts = parseTag(obj.data);
        sendJson(res, 200, {
          sha,
          tag: parts.tag,
          message: parts.message,
          object: { sha: parts.object, type: parts.type },
          tagger: { name: store.viewerLogin, email: store.viewerEmail, date: store.nowIso() },
        });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- git: commits --------------------------------------------------------------
    if (tail.length === 3 && tail[0] === 'git' && tail[1] === 'commits' && method === 'GET') {
      const sha = tail[2] as string;
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, commitJson(store, repo, sha));
      return true;
    }

    // ---- tags (lightweight list) ---------------------------------------------------
    if (tail.length === 1 && tail[0] === 'tags' && method === 'GET') {
      const out: Record<string, unknown>[] = [];
      for (const [ref, sha] of repo.refs) {
        if (!ref.startsWith('refs/tags/')) continue;
        const name = ref.slice('refs/tags/'.length);
        let commitSha = sha;
        const obj = repo.objects.get(sha);
        if (obj !== undefined && obj.type === 'tag') commitSha = parseTag(obj.data).object;
        out.push({
          name,
          commit: { sha: commitSha },
          zipball_url: `https://github.com/${repo.owner}/${repo.name}/zipball/${name}`,
          tarball_url: `https://github.com/${repo.owner}/${repo.name}/tarball/${name}`,
        });
      }
      sendJson(res, 200, out);
      return true;
    }

    // ---- labels --------------------------------------------------------------------
    if (tail.length === 1 && tail[0] === 'labels') {
      if (method === 'POST') {
        const name = asStr(b.name);
        if (name === undefined || name === '') {
          sendError(res, 422, 'name is required');
          return true;
        }
        const color = asStr(b.color) ?? 'ededed';
        const label = store.newLabel(name, color);
        repo.labels.set(name, label);
        sendJson(res, 201, { name: label.name, color: label.color });
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- issues --------------------------------------------------------------------
    if (tail.length >= 1 && tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = asStr(b.title);
          if (title === undefined || title === '') {
            sendError(res, 422, 'title is required');
            return true;
          }
          const labels = asStrArray(b.labels) ?? [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendError(res, 422, `unknown label: ${label}`);
              return true;
            }
          }
          const issue = store.nextIssueId(repo);
          issue.title = title;
          issue.body = asStr(b.body) ?? '';
          issue.labels = labels;
          repo.issues.set(issue.number, issue);
          sendJson(res, 201, issueJson(store, repo, issue));
          return true;
        }
        if (method === 'GET') {
          let list = [...repo.issues.values()].sort((x, y) => x.createdSeq - y.createdSeq);
          const state = query.get('state') ?? 'open';
          if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') {
            list.sort((x, y) => (direction === 'asc' ? x.createdSeq - y.createdSeq : y.createdSeq - x.createdSeq));
          }
          const { perPage, page } = parsePage(query);
          const start = (page - 1) * perPage;
          const pageItems = list.slice(start, start + perPage);
          sendJson(res, 200, pageItems.map((issue) => issueJson(store, repo, issue)), pageLinkHeader(originOf(req), path, query, perPage, page, list.length));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      const issueNumber = Number(tail[1]);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const issue = repo.issues.get(issueNumber);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (issue === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, issueJson(store, repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (issue === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          const state = asStr(b.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.labels !== undefined) {
            const labels = asStrArray(b.labels) ?? [];
            for (const label of labels) {
              if (!repo.labels.has(label)) {
                sendError(res, 422, `unknown label: ${label}`);
                return true;
              }
            }
            issue.labels = labels;
          }
          sendJson(res, 200, issueJson(store, repo, issue));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'POST') {
          const commentBody = asStr(b.body);
          if (commentBody === undefined) {
            sendError(res, 422, 'body is required');
            return true;
          }
          const comment = store.nextCommentId(repo, issueNumber, commentBody);
          repo.comments.set(comment.id, comment);
          sendJson(res, 201, {
            id: comment.id,
            body: comment.body,
            user: { login: store.viewerLogin, id: store.viewerId, type: 'User' },
            created_at: store.nowIso(),
            updated_at: store.nowIso(),
          });
          return true;
        }
        if (method === 'GET') {
          const list = [...repo.comments.values()]
            .filter((c) => c.issueNumber === issueNumber)
            .sort((x, y) => x.createdSeq - y.createdSeq)
            .map((c) => ({
              id: c.id,
              body: c.body,
              user: { login: store.viewerLogin, id: store.viewerId, type: 'User' },
              created_at: store.nowIso(),
              updated_at: store.nowIso(),
            }));
          sendJson(res, 200, list);
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (tail.length === 3 && tail[2] === 'timeline' && method === 'GET') {
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const events = [...repo.comments.values()]
          .filter((c) => c.issueNumber === issueNumber)
          .sort((x, y) => x.createdSeq - y.createdSeq)
          .map((c) => ({ event: 'commented', id: c.id, body: c.body, actor: { login: store.viewerLogin }, created_at: store.nowIso() }));
        sendJson(res, 200, events);
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- milestones ------------------------------------------------------------------
    if (tail.length >= 1 && tail[0] === 'milestones') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = asStr(b.title);
          if (title === undefined || title === '') {
            sendError(res, 422, 'title is required');
            return true;
          }
          const milestone = store.nextMilestoneId(repo, title);
          const state = asStr(b.state);
          if (state === 'open' || state === 'closed') milestone.state = state;
          repo.milestones.set(milestone.number, milestone);
          sendJson(res, 201, {
            id: milestone.id,
            number: milestone.number,
            title: milestone.title,
            state: milestone.state,
            description: asStr(b.description) ?? '',
            due_on: asStr(b.due_on) ?? null,
            created_at: store.nowIso(),
            updated_at: store.nowIso(),
          });
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state');
          let list = [...repo.milestones.values()].sort((x, y) => x.number - y.number);
          if (state === 'open' || state === 'closed') list = list.filter((m) => m.state === state);
          sendJson(res, 200, list.map((m) => ({
            id: m.id,
            number: m.number,
            title: m.title,
            state: m.state,
            created_at: store.nowIso(),
            updated_at: store.nowIso(),
          })));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      const milestoneNumber = Number(tail[1]);
      const milestone = Number.isInteger(milestoneNumber) ? repo.milestones.get(milestoneNumber) : undefined;
      if (tail.length === 2) {
        if (method === 'GET') {
          if (milestone === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, { id: milestone.id, number: milestone.number, title: milestone.title, state: milestone.state });
          return true;
        }
        if (method === 'PATCH') {
          if (milestone === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          if (typeof b.title === 'string') milestone.title = b.title;
          const state = asStr(b.state);
          if (state === 'open' || state === 'closed') milestone.state = state;
          sendJson(res, 200, { id: milestone.id, number: milestone.number, title: milestone.title, state: milestone.state });
          return true;
        }
        if (method === 'DELETE') {
          if (milestone === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          repo.milestones.delete(milestoneNumber);
          sendNoContent(res);
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- pulls -----------------------------------------------------------------------
    if (tail.length >= 1 && tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = asStr(b.title);
          const headRaw = asStr(b.head);
          const baseRaw = asStr(b.base);
          if (title === undefined || title === '' || headRaw === undefined || baseRaw === undefined) {
            sendError(res, 422, 'title, head and base are required');
            return true;
          }
          const headRef = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
          const baseRef = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
          const headTip = tipOf(repo, headRef);
          const baseTip = tipOf(repo, baseRef);
          if (headTip === null || baseTip === null) {
            sendError(res, 422, 'head or base branch does not exist');
            return true;
          }
          const pull = store.nextPullId(repo);
          pull.title = title;
          pull.body = asStr(b.body) ?? '';
          pull.headRef = headRef;
          pull.baseRef = baseRef;
          pull.headSha = headTip;
          pull.baseSha = baseTip;
          repo.pulls.set(pull.number, pull);
          sendJson(res, 201, pullJson(store, repo, pull));
          return true;
        }
        if (method === 'GET') {
          let list = [...repo.pulls.values()].sort((x, y) => x.createdSeq - y.createdSeq);
          const state = query.get('state') ?? 'open';
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          const { perPage, page } = parsePage(query);
          const start = (page - 1) * perPage;
          const pageItems = list.slice(start, start + perPage);
          sendJson(res, 200, pageItems.map((p) => pullJson(store, repo, p)), pageLinkHeader(originOf(req), path, query, perPage, page, list.length));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      const pullNumber = Number(tail[1]);
      if (!Number.isInteger(pullNumber) || pullNumber < 1) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const pull = repo.pulls.get(pullNumber);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (pull === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, pullJson(store, repo, pull));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const headTip = tipOf(repo, pull.headRef) ?? pull.headSha;
        const baseTip = tipOf(repo, pull.baseRef) ?? pull.baseSha;
        if (headTip === null || headTip === '' || baseTip === null || baseTip === '') {
          sendJson(res, 200, []);
          return true;
        }
        const mb = mergeBase(repo.objects, headTip, baseTip);
        const mbTree = mb === null ? null : commitTreeOid(repo, mb);
        const headTree = commitTreeOid(repo, headTip);
        const diff = diffTrees(repo.objects, mbTree, headTree);
        const mbFlat = mbTree === null ? new Map() : readTreeRecursive(repo.objects, mbTree);
        const headFlat = headTree === null ? new Map() : readTreeRecursive(repo.objects, headTree);
        const files = diff.map((entry) => {
          const oldBytes = entry.oldOid !== null ? repo.objects.get(entry.oldOid)?.data : undefined;
          const newBytes = entry.newOid !== null ? repo.objects.get(entry.newOid)?.data : undefined;
          const counts = lineDiff(
            oldBytes !== undefined ? oldBytes.toString('utf8') : '',
            newBytes !== undefined ? newBytes.toString('utf8') : '',
          );
          void mbFlat;
          void headFlat;
          return {
            filename: entry.path,
            status: entry.status,
            additions: counts.additions,
            deletions: counts.deletions,
            changes: counts.additions + counts.deletions,
            sha: entry.newOid ?? entry.oldOid,
          };
        });
        sendJson(res, 200, files);
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const mergeMethod = asStr(b.merge_method);
        if (mergeMethod !== undefined && mergeMethod !== 'squash') {
          sendError(res, 400, 'only merge_method squash is supported');
          return true;
        }
        if (pull.merged) {
          sendError(res, 405, 'pull request is already merged');
          return true;
        }
        if (pull.state === 'closed') {
          sendError(res, 405, 'pull request is closed');
          return true;
        }
        const headTip = tipOf(repo, pull.headRef) ?? (pull.headSha !== '' ? pull.headSha : null);
        const baseTip = tipOf(repo, pull.baseRef) ?? (pull.baseSha !== '' ? pull.baseSha : null);
        if (headTip === null || baseTip === null) {
          sendError(res, 405, 'head or base branch tip is missing');
          return true;
        }
        const plan = squashPlan(repo, headTip, baseTip);
        if (plan.conflict) {
          sendError(res, 405, 'merge conflict');
          return true;
        }
        const newTree = writeTreeRecursive(repo.objects, plan.baseTreeOid, plan.changes);
        const mergeSha = commitObject(repo.objects, {
          tree: newTree,
          parents: [baseTip],
          author: authorLine(store),
          committer: authorLine(store),
          message: pull.title,
        });
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = store.nowIso();
        pull.mergeCommitSha = mergeSha;
        sendJson(res, 200, { merged: true, sha: mergeSha, message: pull.title });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    sendError(res, 404, 'Not Found');
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

/** Immediate children of a directory in a flat tree map. */
function dirListing(
  repo: Repo,
  treeOid: string,
  flat: Map<string, { oid: string; mode: string }>,
  dirPath: string,
): Record<string, unknown>[] {
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const seen = new Map<string, Record<string, unknown>>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { type: 'file', name: rest, path, sha: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
    } else {
      const dirName = rest.slice(0, slash);
      if (!seen.has(dirName)) {
        const subPath = prefix + dirName;
        const subTreeOid = findTreeOid(repo.objects, treeOid, subPath);
        seen.set(dirName, { type: 'dir', name: dirName, path: subPath, sha: subTreeOid ?? '' });
      }
    }
  }
  return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
