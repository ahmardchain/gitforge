// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
//
// Speaks both protocol eras the suite accepts: the modern 2026-07-28
// `server/discover` probe and the legacy `initialize` handshake. Every
// response is a single JSON body (no SSE). All tools act on the same
// Store as REST (same objects, same ids).
//
// NOTE: src/git-core.ts does not exist yet in this checkout, so the
// squash merge used by merge_pull_request is implemented here with small
// local helpers (SHA-1, commit/tree encode/decode, ancestor walk,
// merge-base, tree diff, tree rebuild). They use exactly the object
// format DESIGN.md specifies, so commits/trees written here are identical
// to ones git-core/REST would write and are readable by them.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerToken, pathOf, readBody, sendJson } from './http-util.ts';
import type { Store } from './store.ts';
import type { GitObject, ObjType, Pull, Repo } from './types.ts';

// ---------------------------------------------------------------- tools/list

interface ToolSchemaProperty {
  type: string;
  description?: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolSchemaProperty>;
    required: string[];
  };
}

function strProp(description: string): ToolSchemaProperty {
  return { type: 'string', description };
}

// The canonical six tools first, then the cheap extras. Built once at
// module load and returned by reference every time, so two tools/list
// calls are byte-identical.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner. Defaults to the viewer when omitted.'),
        name: strProp('Name of the repository to create.'),
        description: strProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        title: strProp('Title of the issue.'),
        body: strProp('Body of the issue.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        state: strProp('Issue state to list: open, closed, or all. Defaults to open.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        title: strProp('Title of the pull request.'),
        head: strProp('Name of the head branch.'),
        base: strProp('Name of the base branch.'),
        body: strProp('Body of the pull request.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        pull_number: { type: 'number', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by a user. Defaults to the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the user whose repositories to list. Defaults to the viewer.'),
      },
      required: [],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        issue_number: { type: 'number', description: 'Number of the issue.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        issue_number: { type: 'number', description: 'Number of the issue to close.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
];

const TOOLS_LIST_RESULT: { tools: ToolDef[] } = { tools: TOOLS };

// ---------------------------------------------------------------- JSON-RPC plumbing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(res: ServerResponse, id: string | number | null, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, id: string | number | null, code: number, message: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
}

/** Extract a JSON-RPC id from raw text that failed to parse (the suite
 * sends a truncated body whose id is still readable). */
function extractId(raw: string): string | number | null {
  const num = /"id"\s*:\s*(-?\d+)/.exec(raw);
  if (num !== null && num[1] !== undefined) return Number(num[1]);
  const str = /"id"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (str !== null && str[1] !== undefined) return str[1];
  return null;
}

// ---------------------------------------------------------------- argument helpers

function strArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function numArg(args: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function boolArg(args: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
  }
  return fallback;
}

/** Owner + repo out of the arguments, accepting the documented aliases
 * and a `full_name` of the form "owner/repo" when owner/repo are absent. */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string | undefined; repo: string | undefined } {
  let owner = strArg(args, ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']);
  let repo = strArg(args, ['repo', 'repository', 'repository_name', 'repo_name', 'project', 'project_name']);
  const fullName = strArg(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  if ((owner === undefined || repo === undefined) && fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      if (owner === undefined) owner = fullName.slice(0, slash);
      if (repo === undefined) repo = fullName.slice(slash + 1);
    }
  }
  if (repo !== undefined && repo.includes('/')) {
    const parts = repo.split('/', 2);
    if (owner === undefined) owner = parts[0];
    repo = parts[1];
  }
  return { owner, repo };
}

function missingNames(pairs: Array<[string, unknown]>): string[] {
  const out: string[] = [];
  for (const [name, value] of pairs) {
    if (value === undefined || value === '') out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------- tool outcomes

type ToolOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

function missingError(missing: string[]): ToolOutcome {
  return { ok: false, error: `Missing required argument: ${missing.join(', ')}` };
}

function notFoundError(what: string): ToolOutcome {
  return { ok: false, error: `${what} not found` };
}

function toolResult(result: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  const result = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: true };
}

// ---------------------------------------------------------------- git object helpers (local; see file header)

function sha1Hex(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = sha1Hex(type, data);
  repo.objects.set(oid, { type, data });
  return oid;
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(c: { tree: string; parents: string[]; author: string; committer: string; message: string }): Buffer {
  let out = `tree ${c.tree}\n`;
  for (const parent of c.parents) out += `parent ${parent}\n`;
  out += `author ${c.author}\ncommitter ${c.committer}\n\n${c.message}`;
  return Buffer.from(out, 'utf8');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const mode = data.subarray(i, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(treeSortKey(a), 'utf8'), Buffer.from(treeSortKey(b), 'utf8')));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flat path -> blob entry map for a tree oid (recursive). */
function readTreeRecursive(objects: Map<string, GitObject>, oid: string, prefix = '', out: Map<string, { oid: string; mode: string }> = new Map()): Map<string, { oid: string; mode: string }> {
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix + entry.name;
    if (entry.mode === '40000') readTreeRecursive(objects, entry.oid, `${path}/`, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Rebuild every tree for a flat path map, writing the new tree objects. */
function buildTreeFromFlat(objects: Map<string, GitObject>, flat: Map<string, { oid: string; mode: string }>): string {
  function build(prefix: string): string {
    const entries: TreeEntry[] = [];
    const subdirs = new Set<string>();
    for (const [path, entry] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
      else subdirs.add(rest.slice(0, slash));
    }
    for (const dir of subdirs) entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
    const data = buildTree(entries);
    const oid = sha1Hex('tree', data);
    objects.set(oid, { type: 'tree', data });
    return oid;
  }
  return build('');
}

function ancestorsOf(objects: Map<string, GitObject>, start: string): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const aSet = ancestorsOf(objects, a);
  const seen = new Set<string>();
  const queue: string[] = [b];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head] as string;
    head += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (aSet.has(oid)) return oid;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oldOid: string | null;
  newOid: string | null;
}

function diffTrees(objects: Map<string, GitObject>, baseTreeOid: string, headTreeOid: string): FileChange[] {
  const baseFlat = readTreeRecursive(objects, baseTreeOid);
  const headFlat = readTreeRecursive(objects, headTreeOid);
  const out: FileChange[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    if (base === undefined && head !== undefined) out.push({ path, status: 'added', oldOid: null, newOid: head.oid });
    else if (base !== undefined && head === undefined) out.push({ path, status: 'deleted', oldOid: base.oid, newOid: null });
    else if (base !== undefined && head !== undefined && base.oid !== head.oid) out.push({ path, status: 'modified', oldOid: base.oid, newOid: head.oid });
  }
  return out;
}

function commitOf(objects: Map<string, GitObject>, oid: string): ParsedCommit | null {
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

/** True when the squash merge of this PR would conflict: a path changed
 * on both sides of the merge-base with different results. */
function mergeWouldConflict(repo: Repo, pull: Pull): boolean {
  const base = commitOf(repo.objects, pull.baseSha);
  const head = commitOf(repo.objects, pull.headSha);
  if (base === null || head === null) return false;
  const baseOid = mergeBase(repo.objects, pull.baseSha, pull.headSha);
  if (baseOid === null) return true;
  const mergeBaseCommit = commitOf(repo.objects, baseOid);
  if (mergeBaseCommit === null) return true;
  const headChanges = diffTrees(repo.objects, mergeBaseCommit.tree, head.tree);
  const baseChanges = diffTrees(repo.objects, mergeBaseCommit.tree, base.tree);
  const baseNew = new Map<string, string | null>(baseChanges.map((c) => [c.path, c.newOid]));
  for (const change of headChanges) {
    if (baseNew.has(change.path) && baseNew.get(change.path) !== change.newOid) return true;
  }
  return false;
}

/** Squash-merge a PR: apply the head-vs-merge-base diff onto the base
 * tree, write a merge commit on the base branch, return its sha — or
 * null when the merge conflicts / the history is unusable. */
function doSquashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  if (mergeWouldConflict(repo, pull)) return null;
  const base = commitOf(repo.objects, pull.baseSha);
  const head = commitOf(repo.objects, pull.headSha);
  if (base === null || head === null) return null;
  const baseOid = mergeBase(repo.objects, pull.baseSha, pull.headSha);
  if (baseOid === null) return null;
  const mergeBaseCommit = commitOf(repo.objects, baseOid);
  if (mergeBaseCommit === null) return null;
  const headChanges = diffTrees(repo.objects, mergeBaseCommit.tree, head.tree);
  const headFlat = readTreeRecursive(repo.objects, head.tree);
  const flat = readTreeRecursive(repo.objects, base.tree);
  for (const change of headChanges) {
    if (change.newOid === null) {
      flat.delete(change.path);
    } else {
      const entry = headFlat.get(change.path);
      flat.set(change.path, { oid: change.newOid, mode: entry !== undefined ? entry.mode : '100644' });
    }
  }
  const newTree = buildTreeFromFlat(repo.objects, flat);
  const epoch = store.nowSec();
  const ident = `${store.viewerLogin} <${store.viewerEmail}> ${epoch} +0000`;
  const message = `Squash merge pull request #${pull.number}: ${pull.title}\n`;
  const commitData = buildCommit({ tree: newTree, parents: [pull.baseSha], author: ident, committer: ident, message });
  const sha = storeObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  return sha;
}

// ---------------------------------------------------------------- tool handlers

type ToolHandler = (store: Store, args: Record<string, unknown>) => ToolOutcome;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  create_repo(store, args) {
    const name = strArg(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
    if (name === undefined) return missingError(['name']);
    const owner = strArg(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']) ?? store.viewerLogin;
    const description = strArg(args, ['description', 'about', 'summary', 'body']) ?? '';
    const isPrivate = boolArg(args, ['private', 'is_private'], false);
    if (store.getRepo(owner, name) !== undefined) return { ok: false, error: `Repository ${owner}/${name} already exists` };
    const repo = store.createRepo(owner, name, { description, private: isPrivate });
    return { ok: true, result: { name: repo.name, full_name: `${owner}/${repo.name}`, owner, private: repo.private, description: repo.description } };
  },

  get_repo(store, args) {
    const { owner, repo: repoName } = resolveOwnerRepo(args);
    const missing = missingNames([['owner', owner], ['repo', repoName]]);
    if (missing.length > 0) return missingError(missing);
    const repo = store.getRepo(owner as string, repoName as string);
    if (repo === undefined) return notFoundError(`Repository ${owner as string}/${repoName as string}`);
    return { ok: true, result: { name: repo.name, full_name: `${owner as string}/${repoName as string}`, owner: owner as string, private: repo.private, description: repo.description, default_branch: repo.defaultBranch } };
  },

  create_issue(store, args) {
    const { owner, repo: repoName } = resolveOwnerRepo(args);
    const title = strArg(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
    const body = strArg(args, ['body', 'issue_body', 'description', 'content', 'text']) ?? '';
    const missing = missingNames([['owner', owner], ['repo', repoName], ['title', title]]);
    if (missing.length > 0) return missingError(missing);
    const repo = store.getRepo(owner as string, repoName as string);
    if (repo === undefined) return notFoundError(`Repository ${owner as string}/${repoName as string}`);
    const issue = store.nextIssueId(repo);
    issue.title = title as string;
    issue.body = body;
    repo.issues.set(issue.number, issue);
    return { ok: true, result: { number: issue.number, title: issue.title, body: issue.body, state: 'open', full_name: `${owner as string}/${repoName as string}` } };
  },

  list_issues(store, args) {
    const { owner, repo: repoName } = resolveOwnerRepo(args);
    const missing = missingNames([['owner', owner], ['repo', repoName]]);
    if (missing.length > 0) return missingError(missing);
    const repo = store.getRepo(owner as string, repoName as string);
    if (repo === undefined) return notFoundError(`Repository ${owner as string}/${repoName as string}`);
    const state = strArg(args, ['state', 'status']) ?? 'open';
    const issues = [...repo.issues.values()]
      .sort((a, b) => a.createdSeq - b.createdSeq)
      .filter((issue) => state === 'all' || issue.state === state)
      .map((issue) => ({ number: issue.number, title: issue.title, state: issue.state }));
    return { ok: true, result: { issues, full_name: `${owner as string}/${repoName as string}` } };
  },

  create_pull_request(store, args) {
    const { owner, repo: repoName } = resolveOwnerRepo(args);
    const title = strArg(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
    const head = strArg(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
    const base = strArg(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
    const body = strArg(args, ['body', 'issue_body', 'description', 'content', 'text']) ?? '';
    const missing = missingNames([['owner', owner], ['repo', repoName], ['title', title], ['head', head], ['base', base]]);
    if (missing.length > 0) return missingError(missing);
    const repo = store.getRepo(owner as string, repoName as string);
    if (repo === undefined) return notFoundError(`Repository ${owner as string}/${repoName as string}`);
    const headSha = repo.refs.get(`refs/heads/${head as string}`);
    if (headSha === undefined) return { ok: false, error: `Head branch ${head as string} does not exist in ${owner as string}/${repoName as string}` };
    const baseSha = repo.refs.get(`refs/heads/${base as string}`);
    if (baseSha === undefined) return { ok: false, error: `Base branch ${base as string} does not exist in ${owner as string}/${repoName as string}` };
    const pull = store.nextPullId(repo);
    pull.title = title as string;
    pull.body = body;
    pull.headRef = head as string;
    pull.baseRef = base as string;
    pull.headSha = headSha;
    pull.baseSha = baseSha;
    pull.mergeable = mergeWouldConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    repo.pulls.set(pull.number, pull);
    return { ok: true, result: { number: pull.number, title: pull.title, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha }, state: 'open', full_name: `${owner as string}/${repoName as string}` } };
  },

  merge_pull_request(store, args) {
    const { owner, repo: repoName } = resolveOwnerRepo(args);
    const pullNumber = numArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
    const missing = missingNames([['owner', owner], ['repo', repoName], ['pull_number', pullNumber]]);
    if (missing.length > 0) return missingError(missing);
    const repo = store.getRepo(owner as string, repoName as string);
    if (repo === undefined) return notFoundError(`Repository ${owner as string}/${repoName as string}`);
    const pull = repo.pulls.get(pullNumber as number);
    if (pull === undefined) return notFoundError(`Pull request #${pullNumber as number} in ${owner as string}/${repoName as string}`);
    if (pull.merged) return { ok: false, error: `Pull request #${pullNumber as number} is already merged` };
    if (pull.state === 'closed') return { ok: false, error: `Pull request #${pullNumber as number} is already closed` };
    const sha = doSquashMerge(store, repo, pull);
    if (sha === null) return { ok: false, error: `Pull request #${pullNumber as number} cannot be merged: merge conflict` };
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = store.nowIso();
    pull.mergeCommitSha = sha;
    return { ok: true, result: { number: pull.number, merged: true, state: 'closed', sha, full_name: `${owner as string}/${repoName as string}` } };
  },

  list_repos(store, args) {
    const owner = strArg(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']) ?? store.viewerLogin;
    const repos = [...store.repos.values()]
      .filter((repo) => repo.owner === owner)
      .sort((a, b) => a.createdSeq - b.createdSeq)
      .map((repo) => ({ name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: repo.owner, private: repo.private, description: repo.description, default_branch: repo.defaultBranch }));
    return { ok: true, result: { repos } };
  },

  get_issue(store, args) {
    const { owner, repo: repoName } = resolveOwnerRepo(args);
    const issueNumber = numArg(args, ['issue_number', 'number', 'index']);
    const missing = missingNames([['owner', owner], ['repo', repoName], ['issue_number', issueNumber]]);
    if (missing.length > 0) return missingError(missing);
    const repo = store.getRepo(owner as string, repoName as string);
    if (repo === undefined) return notFoundError(`Repository ${owner as string}/${repoName as string}`);
    const issue = repo.issues.get(issueNumber as number);
    if (issue === undefined) return notFoundError(`Issue #${issueNumber as number} in ${owner as string}/${repoName as string}`);
    return { ok: true, result: { number: issue.number, title: issue.title, body: issue.body, state: issue.state, full_name: `${owner as string}/${repoName as string}` } };
  },

  close_issue(store, args) {
    const { owner, repo: repoName } = resolveOwnerRepo(args);
    const issueNumber = numArg(args, ['issue_number', 'number', 'index']);
    const missing = missingNames([['owner', owner], ['repo', repoName], ['issue_number', issueNumber]]);
    if (missing.length > 0) return missingError(missing);
    const repo = store.getRepo(owner as string, repoName as string);
    if (repo === undefined) return notFoundError(`Repository ${owner as string}/${repoName as string}`);
    const issue = repo.issues.get(issueNumber as number);
    if (issue === undefined) return notFoundError(`Issue #${issueNumber as number} in ${owner as string}/${repoName as string}`);
    issue.state = 'closed';
    return { ok: true, result: { number: issue.number, title: issue.title, body: issue.body, state: 'closed', full_name: `${owner as string}/${repoName as string}` } };
  },
};

// ---------------------------------------------------------------- entry point

export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;
  const method = req.method ?? 'GET';

  // A legacy session DELETE ends the session: 202 with an empty body.
  if (method === 'DELETE') {
    res.writeHead(202);
    res.end();
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // Auth applies to every JSON-RPC method, including server/discover,
  // initialize, tools/list and tools/call.
  const token = bearerToken(req);
  if (token === null || token !== store.token) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }

  let raw: string;
  try {
    raw = (await readBody(req)).toString('utf8');
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: extractId(raw), error: { code: -32700, message: 'Parse error' } });
    return true;
  }

  if (!isRecord(parsed)) {
    sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }

  const hasId = 'id' in parsed;
  const rawId: unknown = hasId ? parsed.id : undefined;
  const rpcId: string | number | null = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  const methodName = typeof parsed.method === 'string' ? parsed.method : '';

  // Notifications (no id) get no JSON-RPC reply: HTTP 202, empty body.
  if (!hasId) {
    res.writeHead(202);
    res.end();
    return true;
  }
  if (methodName === '') {
    rpcError(res, rpcId, -32600, 'Invalid Request: missing method');
    return true;
  }

  const params = isRecord(parsed.params) ? parsed.params : {};
  const serverInfo = { name: 'gitforge', version: '0.1.0' };

  switch (methodName) {
    case 'server/discover':
      rpcResult(res, rpcId, {
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        capabilities: { tools: {} },
        serverInfo,
      });
      return true;
    case 'initialize':
      rpcResult(res, rpcId, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo,
      });
      return true;
    case 'notifications/initialized':
      res.writeHead(202);
      res.end();
      return true;
    case 'tools/list':
      rpcResult(res, rpcId, TOOLS_LIST_RESULT);
      return true;
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const handler = TOOL_HANDLERS[name];
      if (handler === undefined) {
        rpcError(res, rpcId, -32601, `Unknown tool: ${name}`);
        return true;
      }
      let outcome: ToolOutcome;
      try {
        outcome = handler(store, args);
      } catch (err) {
        outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      rpcResult(res, rpcId, outcome.ok ? toolResult(outcome.result) : toolError(outcome.error));
      return true;
    }
    default:
      rpcError(res, rpcId, -32601, `Method not found: ${methodName}`);
      return true;
  }
}
