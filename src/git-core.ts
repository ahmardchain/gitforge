// Pure git object core: SHA-1, object encode/decode, trees, commits, tags,
// reachability, ancestor walks, merge-base, tree diffs and line diffs.
//
// Operates only on a repo's `objects` map (oid -> {type, data}); never
// imports the store. No wall clock, no randomness.

import { createHash } from 'node:crypto';
import type { GitObject, ObjType } from './types.ts';

export type { GitObject, ObjType } from './types.ts';

const HEX40 = /^[0-9a-f]{40}$/;
const OCTAL = /^[0-7]+$/;

/** SHA-1 hex of `<type> <size>\0<content>`, exactly as git computes it. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object in the map (idempotent) and return its oid. */
export function storeObject(objects: Map<string, GitObject>, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Any other header lines, in order, as raw `key value` lines. */
  extra: string[];
}

/**
 * Parse a commit object. author/committer are the raw header values
 * (e.g. "Name <email> 1700000000 +0000"). Continuation lines (starting
 * with a space, e.g. gpgsig) are kept as their own raw lines in `extra`,
 * so a parse -> build round-trip is byte-for-byte.
 */
export function parseCommit(data: Buffer): ParsedCommit {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: string[] = [];
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push(line);
  }
  if (!HEX40.test(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) {
    if (!HEX40.test(parent)) throw new Error('commit has a bad parent id');
  }
  return { tree, parents, author, committer, message, extra };
}

export interface BuildCommitInput {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  extra?: string[];
}

/** Build a commit object's bytes. `author`/`committer` are raw header values. */
export function buildCommit(o: BuildCommitInput): Buffer {
  if (!HEX40.test(o.tree)) throw new Error('buildCommit needs a valid tree id');
  for (const parent of o.parents) {
    if (!HEX40.test(parent)) throw new Error('buildCommit needs valid parent ids');
  }
  const lines: string[] = [`tree ${o.tree}`];
  for (const parent of o.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${o.author}`, `committer ${o.committer}`);
  for (const line of o.extra ?? []) lines.push(line);
  return Buffer.from(`${lines.join('\n')}\n\n${o.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (!OCTAL.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** True for a tree (directory) entry mode. */
function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** git's tree-entry sort: byte order of the name, a directory compared as `name/`. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(isDirMode(a.mode) ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(isDirMode(b.mode) ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes; entries are sorted in git order. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!OCTAL.test(entry.mode)) throw new Error(`tree entry mode ${JSON.stringify(entry.mode)} is not octal`);
    if (!HEX40.test(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): ParsedTag {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!HEX40.test(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export interface BuildTagInput {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Build an annotated tag object's bytes. `tagger` is the raw header value. */
export function buildTag(o: BuildTagInput): Buffer {
  if (!HEX40.test(o.object)) throw new Error('buildTag needs a valid object id');
  return Buffer.from(
    `object ${o.object}\ntype ${o.type}\ntag ${o.tag}\ntagger ${o.tagger}\n\n${o.message}`,
    'utf8',
  );
}

/**
 * Flatten a tree into full path -> entry. Gitlink (160000) entries are
 * skipped entirely. A missing tree oid yields an empty map; a cyclic
 * tree is walked once per tree oid.
 */
export function readTreeRecursive(
  objects: Map<string, GitObject>,
  treeOid: string,
): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const seenTrees = new Set<string>();
  const walk = (oid: string, prefix: string): void => {
    if (seenTrees.has(oid)) return;
    seenTrees.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined) return;
    if (obj.type !== 'tree') throw new Error(`object ${oid} is a ${obj.type}, not a tree`);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '160000') continue;
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isDirMode(entry.mode)) walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

interface LevelChange {
  direct: Map<string, Buffer | null>;
  sub: Map<string, Map<string, Buffer | null>>;
}

function splitChanges(changes: Map<string, Buffer | null>): LevelChange {
  const direct = new Map<string, Buffer | null>();
  const sub = new Map<string, Map<string, Buffer | null>>();
  for (const [path, value] of changes) {
    if (path === '') throw new Error('empty path in tree changes');
    const segments = path.split('/');
    for (const segment of segments) {
      if (segment === '' || segment === '.' || segment === '..') {
        throw new Error(`invalid path in tree changes: ${JSON.stringify(path)}`);
      }
    }
    if (segments.length === 1) {
      direct.set(segments[0], value);
    } else {
      const head = segments[0];
      const rest = segments.slice(1).join('/');
      let child = sub.get(head);
      if (child === undefined) {
        child = new Map<string, Buffer | null>();
        sub.set(head, child);
      }
      child.set(rest, value);
    }
  }
  return { direct, sub };
}

/**
 * Apply file changes (Buffer = new blob content, null = delete) onto the
 * tree at `baseTreeOid` (null = empty tree); write new blob/tree objects
 * into the map; return the new tree oid. Creates/removes intermediate
 * trees as needed and prunes trees that become empty.
 */
export function writeTreeRecursive(
  objects: Map<string, GitObject>,
  baseTreeOid: string | null,
  changes: Map<string, Buffer | null>,
): string {
  // Build one level; returns null when the level ends up empty (pruned).
  const buildLevel = (baseOid: string | null, levelChanges: Map<string, Buffer | null>): string | null => {
    const { direct, sub } = splitChanges(levelChanges);
    const baseEntries: TreeEntry[] = baseOid === null ? [] : parseTree(objects.get(baseOid)?.data ?? Buffer.alloc(0));
    const baseByName = new Map<string, TreeEntry>();
    for (const entry of baseEntries) baseByName.set(entry.name, entry);
    const result: TreeEntry[] = [];
    const handled = new Set<string>();

    for (const entry of baseEntries) {
      const name = entry.name;
      if (direct.has(name)) {
        handled.add(name);
        const value = direct.get(name);
        if (value === undefined || value === null) continue; // delete (file, dir or gitlink)
        // A file replaces whatever was here (file, dir or gitlink).
        result.push({ mode: '100644', name, oid: storeObject(objects, 'blob', value) });
        continue;
      }
      if (sub.has(name)) {
        handled.add(name);
        const childBase = isDirMode(entry.mode) ? entry.oid : null;
        const childOid = buildLevel(childBase, sub.get(name)!);
        if (childOid !== null) result.push({ mode: '40000', name, oid: childOid });
        // null = the subtree became empty: pruned (a file that was here is replaced by nothing).
        continue;
      }
      result.push(entry);
    }

    for (const [name, value] of direct) {
      if (handled.has(name) || baseByName.has(name)) continue;
      if (value === null) continue; // deleting a file that is not there
      result.push({ mode: '100644', name, oid: storeObject(objects, 'blob', value) });
    }
    for (const [name, childChanges] of sub) {
      if (handled.has(name) || baseByName.has(name)) continue;
      const childOid = buildLevel(null, childChanges);
      if (childOid !== null) result.push({ mode: '40000', name, oid: childOid });
    }

    if (result.length === 0) return null;
    return storeObject(objects, 'tree', buildTree(result));
  };

  // A missing base tree oid is treated as an empty tree.
  const base = baseTreeOid !== null && objects.has(baseTreeOid) ? baseTreeOid : null;
  const oid = buildLevel(base, changes);
  if (oid !== null) return oid;
  return storeObject(objects, 'tree', buildTree([]));
}

export interface CommitInput {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Build + store a commit object, returning its oid. */
export function commitObject(objects: Map<string, GitObject>, o: CommitInput): string {
  return storeObject(objects, 'commit', buildCommit(o));
}

/**
 * Every object reachable from `tips`: commit -> tree + parents,
 * tag -> target, tree -> entries (gitlinks skipped). Missing objects are
 * skipped, never thrown; cycles are walked once.
 */
export function collectReachable(objects: Map<string, GitObject>, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (HEX40.test(tip)) queue.push(tip);
  }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    try {
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode === '160000') continue;
          queue.push(entry.oid);
        }
      }
    } catch {
      // A malformed object contributes nothing further; it is still reachable.
      continue;
    }
  }
  return seen;
}

/** Parents of a commit oid (empty when missing / not a commit / malformed). */
function commitParents(objects: Map<string, GitObject>, oid: string): string[] {
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return [];
  try {
    return parseCommit(obj.data).parents;
  } catch {
    return [];
  }
}

/** All ancestors of `oid` including `oid` itself. */
function ancestorSet(objects: Map<string, GitObject>, oid: string): Set<string> {
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of commitParents(objects, current)) queue.push(parent);
  }
  return seen;
}

/** True when `ancestorOid` == `oid` or is reachable from `oid` via parents. */
export function isAncestor(objects: Map<string, GitObject>, ancestorOid: string, oid: string): boolean {
  if (ancestorOid === oid) return true;
  return ancestorSet(objects, oid).has(ancestorOid);
}

/**
 * Generation of a commit: 0 for a root (or a commit whose parents are all
 * missing), otherwise 1 + the greatest generation of its parents. This is
 * git's commit-graph generation number: deeper (newer) commits have
 * greater generations, so the best common ancestor is the common ancestor
 * with the greatest generation.
 */
function generation(
  objects: Map<string, GitObject>,
  oid: string,
  memo: Map<string, number>,
  inProgress: Set<string>,
): number {
  const cached = memo.get(oid);
  if (cached !== undefined) return cached;
  if (inProgress.has(oid)) return 0; // cycle guard
  inProgress.add(oid);
  let gen = 0;
  const parents = commitParents(objects, oid);
  for (const parent of parents) {
    const parentGen = generation(objects, parent, memo, inProgress);
    if (parentGen + 1 > gen) gen = parentGen + 1;
  }
  inProgress.delete(oid);
  memo.set(oid, gen);
  return gen;
}

/**
 * Best common ancestor of `a` and `b`: the common ancestor with the
 * greatest generation (see `generation`). Returns null when there is none.
 */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = ancestorSet(objects, a);
  const ancestorsB = ancestorSet(objects, b);
  const memo = new Map<string, number>();
  let best: string | null = null;
  let bestGen = -1;
  for (const oid of ancestorsA) {
    if (!ancestorsB.has(oid)) continue;
    const gen = generation(objects, oid, memo, new Set<string>());
    if (gen > bestGen || (gen === bestGen && best !== null && oid < best)) {
      best = oid;
      bestGen = gen;
    }
  }
  return best;
}

export interface TreeDiffEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oldOid: string | null;
  newOid: string | null;
}

/** Diff two trees (null = empty tree), sorted by path. */
export function diffTrees(
  objects: Map<string, GitObject>,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): TreeDiffEntry[] {
  const base = baseTreeOid === null ? new Map() : readTreeRecursive(objects, baseTreeOid);
  const head = headTreeOid === null ? new Map() : readTreeRecursive(objects, headTreeOid);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: TreeDiffEntry[] = [];
  for (const path of paths) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      out.push({ path, status: 'deleted', oldOid: oldEntry.oid, newOid: null });
    } else if (oldEntry !== undefined && newEntry !== undefined) {
      if (oldEntry.oid !== newEntry.oid || oldEntry.mode !== newEntry.mode) {
        out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
      }
    }
  }
  out.sort((x, y) => Buffer.compare(Buffer.from(x.path, 'utf8'), Buffer.from(y.path, 'utf8')));
  return out;
}

/**
 * LCS-based line diff on "\n"-split lines. Files are small; O(n*m) is fine.
 * Returns the number of added and deleted lines.
 */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  // LCS length via two rows of DP.
  let prev = new Uint32Array(newLines.length + 1);
  let curr = new Uint32Array(newLines.length + 1);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const lcs = prev[newLines.length];
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}
